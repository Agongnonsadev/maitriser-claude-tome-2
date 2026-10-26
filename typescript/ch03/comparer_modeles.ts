// Chapitre 3 : comparer modèles et niveaux d'effort sur les cas du Comptoir.
//
// Pour chaque configuration (modèle, effort), chaque cas est posé plusieurs fois, parce que les
// réponses varient. On relève la réussite, le coût, la latence et la réflexion, puis on calcule le coût
// par tâche réussie.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch03/comparer_modeles.ts --estimer        # gratuit : estimation du coût avant de lancer
//     npx tsx ch03/comparer_modeles.ts --repetitions 3 --budget-max 2

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { PROMPT_SYSTEME } from "../ch02/comptoir_cli.ts";
import { arrondir } from "../comptoir/arrondi.ts";
import { type ClientMessages, texteDe } from "../comptoir/client.ts";
import { TARIFS, cout } from "../comptoir/couts.ts";
import { ecrireCsv as ecrire } from "../comptoir/csv.ts";
import { noter as noterAuJournal } from "../comptoir/journal.ts";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { type Cas, creerCas, noter } from "../comptoir/notation.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Configuration = readonly [modele: string, effort: Effort];

export const CONFIGURATIONS: Configuration[] = [
  ["claude-opus-5-5", "medium"],
  ["claude-opus-5-5", "low"],
  ["claude-sonnet-5-5", "high"],
  ["claude-sonnet-5-5", "low"],
  ["claude-haiku-5-5", "medium"],
  ["claude-haiku-5-5", "low"],
];

/** Les 15 cas du livre, ceux de la version Python (python/ch03/cas.json). */
export function chargerCas(chemin = join(PYTHON, "ch03", "cas.json")): Cas[] {
  return (JSON.parse(readFileSync(chemin, "utf8")) as Parameters<typeof creerCas>[0][]).map(creerCas);
}

/** Un essai : les colonnes de resultats/essais.csv, les mêmes que dans la version Python. */
export interface Essai {
  modele: string;
  effort: string;
  cas: string;
  repetition: number;
  reussi: boolean;
  raisons: string;
  a_relire: string;
  reponse: string;
  latence_s: number;
  tokens_entree: number;
  tokens_sortie: number;
  tokens_reflexion: number;
  cout_dollars: number;
  raison_arret: string | null;
}

export async function interroger(client: ClientMessages, modele: string, effort: Effort, cas: Cas, repetition: number): Promise<Essai> {
  const debut = performance.now();
  const message = await client.messages.create({
    model: modele,
    max_tokens: 2000,
    system: PROMPT_SYSTEME,
    output_config: { effort },
    messages: [{ role: "user", content: cas.question }],
  });
  const latence = (performance.now() - debut) / 1000;
  const texte = texteDe(message);
  const prix = cout(modele, message.usage);
  noterAuJournal(message._request_id, modele, prix);
  const note = noter(cas, texte);
  if (message.stop_reason !== "end_turn") {
    note.reussi = false;
    note.raisons.push(`arrêt : ${message.stop_reason}`);
  }
  return {
    modele,
    effort,
    cas: cas.identifiant,
    repetition,
    reussi: note.reussi,
    raisons: note.raisons.join(" ; "),
    a_relire: note.aRelire,
    reponse: texte,
    latence_s: arrondir(latence, 2),
    tokens_entree: prix.entree,
    tokens_sortie: prix.sortie,
    tokens_reflexion: prix.reflexion,
    cout_dollars: prix.dollars,
    raison_arret: message.stop_reason,
  };
}

export interface Resume {
  modele: string;
  effort: string;
  essais: number;
  reussite: number;
  coutParAppel: number;
  /** Le chiffre qui compte : ce que coûte une réponse utilisable. */
  coutParReussite: number | null;
  latenceMedianeS: number;
  reflexionMoyenne: number;
}

const mediane = (valeurs: number[]): number => {
  const v = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(v.length / 2);
  return v.length % 2 ? v[milieu]! : (v[milieu - 1]! + v[milieu]!) / 2;
};
const somme = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0);

/** Une ligne par configuration : taux de réussite, coûts, latence, réflexion. */
export function resumer(essais: Essai[]): Resume[] {
  const configurations = [...new Set(essais.map((e) => `${e.modele}\u0000${e.effort}`))];
  return configurations.map((cle) => {
    const groupe = essais.filter((e) => `${e.modele}\u0000${e.effort}` === cle);
    const reussites = groupe.filter((e) => e.reussi).length;
    const coutTotal = somme(groupe.map((e) => e.cout_dollars));
    return {
      modele: groupe[0]!.modele,
      effort: groupe[0]!.effort,
      essais: groupe.length,
      reussite: reussites / groupe.length,
      coutParAppel: coutTotal / groupe.length,
      coutParReussite: reussites ? coutTotal / reussites : null,
      latenceMedianeS: mediane(groupe.map((e) => e.latence_s)),
      reflexionMoyenne: somme(groupe.map((e) => e.tokens_reflexion)) / groupe.length,
    };
  });
}

export async function comparer(
  client: ClientMessages,
  cas: Cas[],
  configurations: readonly Configuration[],
  repetitions: number,
  budgetMax: number,
): Promise<Essai[]> {
  const essais: Essai[] = [];
  let depense = 0;
  for (const [modele, effort] of configurations) {
    for (const c of cas) {
      for (let r = 1; r <= repetitions; r++) {
        if (depense >= budgetMax) {
          console.log(`Budget de ${budgetMax} $ atteint : arrêt de la comparaison.`);
          return essais;
        }
        const essai = await interroger(client, modele, effort, c, r);
        depense += essai.cout_dollars;
        essais.push(essai);
      }
    }
  }
  return essais;
}

/** Estimation gratuite : tokens d'entrée comptés, tokens de sortie supposés. */
export async function estimer(
  client: ClientMessages,
  cas: Cas[],
  configurations: readonly Configuration[],
  repetitions: number,
  sortieSupposee: number,
): Promise<number> {
  let total = 0;
  for (const [modele] of configurations) {
    const tarif = TARIFS[modele];
    if (!tarif) throw new Error(`Prix inconnu pour le modèle « ${modele} » : ajoutez-le dans TARIFS.`);
    for (const c of cas) {
      const { input_tokens: entree } = await client.messages.countTokens({
        model: modele,
        system: PROMPT_SYSTEME,
        messages: [{ role: "user", content: c.question }],
      });
      total += (repetitions * (entree * tarif.entree + sortieSupposee * tarif.sortie)) / 1_000_000;
    }
  }
  return total;
}

export function ecrireCsv(essais: Essai[], chemin: string): void {
  ecrire(essais, [
    "modele", "effort", "cas", "repetition", "reussi", "raisons", "a_relire", "reponse",
    "latence_s", "tokens_entree", "tokens_sortie", "tokens_reflexion", "cout_dollars", "raison_arret",
  ], chemin, ["latence_s", "cout_dollars"]); // des float en Python
}

export function afficher(lignes: Resume[]): void {
  console.log(
    `${"Modèle".padEnd(20)}${"Effort".padEnd(8)}${"Réussite".padStart(10)}${"$/appel".padStart(11)}` +
      `${"$/réussite".padStart(12)}${"Latence".padStart(9)}${"Réflexion".padStart(11)}`,
  );
  for (const l of lignes) {
    const parReussite = l.coutParReussite ? l.coutParReussite.toFixed(5) : "—";
    console.log(
      `${l.modele.padEnd(20)}${l.effort.padEnd(8)}${`${Math.round(l.reussite * 100)}%`.padStart(9)} ` +
        `${l.coutParAppel.toFixed(5).padStart(10)}${parReussite.padStart(12)}` +
        `${l.latenceMedianeS.toFixed(1).padStart(8)}s${Math.round(l.reflexionMoyenne).toString().padStart(11)}`,
    );
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      repetitions: { type: "string", default: "3" },
      "budget-max": { type: "string", default: "2.0" }, // arrêt au-delà de ce montant, en dollars
      estimer: { type: "boolean", default: false }, //     estimer le coût sans appeler le modèle
      "sortie-supposee": { type: "string", default: "300" }, // tokens de sortie supposés par appel
    },
  });
  const repetitions = Number(args.repetitions);
  const sortieSupposee = Number(args["sortie-supposee"]);

  const client = new Anthropic();
  const cas = chargerCas();
  if (args.estimer) {
    const total = await estimer(client, cas, CONFIGURATIONS, repetitions, sortieSupposee);
    console.log(`${cas.length} cas × ${CONFIGURATIONS.length} configurations × ${repetitions} répétitions`);
    console.log(`Coût estimé : ${total.toFixed(2)} $ (avec ${sortieSupposee} tokens de sortie supposés par appel)`);
    return;
  }

  const essais = await comparer(client, cas, CONFIGURATIONS, repetitions, Number(args["budget-max"]));
  ecrireCsv(essais, join(RACINE, "ch03", "resultats", "essais.csv"));
  afficher(resumer(essais));
  const aRelire = [...new Map(essais.filter((e) => e.a_relire).map((e) => [e.cas, e.a_relire])).entries()].sort();
  if (aRelire.length) {
    console.log("\nÀ relire à la main (voir resultats/essais.csv) :");
    for (const [identifiant, consigne] of aRelire) console.log(`- ${identifiant} : ${consigne}`);
  }
}

if (estLance(import.meta.url)) await main();
