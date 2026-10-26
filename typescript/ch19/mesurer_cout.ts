// Chapitre 19 : le coût par conversation du Comptoir en ligne, et chaque levier mesuré à part.
//
// Depuis le dossier typescript/ :
//     npx tsx ch19/mesurer_cout.ts --estimer                                         (gratuit)
//     npx tsx ch19/mesurer_cout.ts --variante livree --essais 3 --budget-max 0.2     (PAYANT, plafonné)
//     npx tsx ch19/mesurer_cout.ts --variante effort-low --essais 3 --budget-max 0.2
//     npx tsx ch19/mesurer_cout.ts --variante sans-cache --essais 3 --budget-max 0.3
//
// Huit conversations types (python/ch19/conversations.json, communes aux deux versions), du simple « vous
// livrez à… ? » à la commande confirmée par son code, passent par le service en ligne (comptoir/service.ts) :
// la conversation gardée en base, le budget par message, le Comptoir aiguillé. « OUI {code} » est remplacé
// par le code du dernier récapitulatif, lu dans la boutique, comme le ferait le client.
//
// Chaque essai part d'une boutique neuve à heure fixe (le banc du chapitre 17). Les conversations se
// suivent, comme dans une journée : la première écrit le cache d'une heure, les suivantes le lisent.
// Un enregistreur garde chaque appel : modèle, tokens d'entrée, de cache et de sortie, coût, durée.
// Une variante ne change qu'une chose par rapport à la version livrée.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { OptionsAiguillage } from "../comptoir/aiguillage.ts";
import { arrondir, fixe } from "../comptoir/arrondi.ts";
import type { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { jsonPython, moyenne, somme } from "../comptoir/python.ts";
import { ServiceComptoir } from "../comptoir/service.ts";
import { Enregistreur, environnement } from "../ch17/banc.ts";
import { horodatage } from "../ch17/suite.ts";

export const RESULTATS = join(RACINE, "ch19", "resultats", "couts");
export const VARIANTES: Record<string, OptionsAiguillage> = {
  livree: {}, //                                Haiku 5.5, effort par défaut (medium), cache d'une heure
  "effort-low": { effortComptoir: "low" }, //    l'effort du Comptoir à low
  "sans-cache": { cache: false }, //             sans cache, pour voir ce qu'il rapporte
};
/** Les réglages d'une variante, aux noms de la version Python (pour le fichier de résultats). */
const REGLAGES_PYTHON: Record<string, Record<string, unknown>> = { livree: {}, "effort-low": { effort_comptoir: "low" }, "sans-cache": { cache: false } };
const COUT_SUPPOSE_PAR_MESSAGE = 0.003; // $ : large
const CLES_TOKENS = ["entree", "ecriture_cache", "lecture_cache", "sortie"] as const;

/** Une conversation jouée, aux noms de champs de la version Python. */
export interface Conversation {
  variante: string;
  id: string;
  essai: number;
  messages: number;
  categories: string[];
  cout_dollars: number;
  appels: number;
  tokens: Partial<Record<(typeof CLES_TOKENS)[number], number>>;
  durees_ms: number[];
  commandes: number;
  erreurs: string[];
}

export const creerConversation = (variante: string, id: string, essai: number, champs: Partial<Conversation> = {}): Conversation => ({
  variante, id, essai, messages: 0, categories: [], cout_dollars: 0, appels: 0, tokens: {}, durees_ms: [], commandes: 0, erreurs: [], ...champs,
});

export interface Scenario {
  id: string;
  messages: string[];
}

export const chargerConversations = (): Scenario[] => JSON.parse(readFileSync(join(PYTHON, "ch19", "conversations.json"), "utf8")) as Scenario[];

export function codeEnAttente(boutique: Boutique, conversation: string): string | null {
  const attente = boutique.recapitulatifs(conversation).filter((r) => r.statut === "en_attente").map((r) => r.code);
  return attente.at(-1) ?? null;
}

export async function jouer(service: ServiceComptoir, enregistreur: Enregistreur, scenario: Scenario, variante: string, essai: number): Promise<Conversation> {
  const resultat = creerConversation(variante, scenario.id, essai);
  const avant = enregistreur.appels.length;
  const [conversation] = service.ouvrir(null);
  for (let message of scenario.messages) {
    if (message.includes("{code}")) {
      const code = codeEnAttente(service.boutique, conversation);
      if (code === null) {
        resultat.erreurs.push("aucun récapitulatif à confirmer");
        continue;
      }
      message = message.replaceAll("{code}", code);
    }
    const tour = await service.repondre(conversation, message, "mesure", "mesure");
    resultat.messages += 1;
    resultat.categories.push(tour.categorie);
    resultat.cout_dollars += tour.coutDollars;
    resultat.durees_ms.push(tour.dureeMs);
    if (tour.erreur) resultat.erreurs.push(tour.erreur);
  }
  const appels = enregistreur.appels.slice(avant);
  resultat.appels = appels.length;
  resultat.tokens = Object.fromEntries(CLES_TOKENS.map((cle) => [cle, appels.reduce((s, a) => s + a.tokens[cle], 0)]));
  resultat.commandes = service.boutique.commandes().filter((c) => c.conversation === conversation).length;
  resultat.cout_dollars = arrondir(resultat.cout_dollars, 6);
  return resultat;
}

export function resumer(conversations: Conversation[]): Record<string, unknown> {
  const couts = conversations.map((c) => c.cout_dollars);
  const messages = conversations.reduce((s, c) => s + c.messages, 0);
  const durees = conversations.flatMap((c) => c.durees_ms).sort((a, b) => a - b);
  return {
    conversations: conversations.length,
    messages,
    cout_total: arrondir(somme(couts), 4),
    cout_moyen_conversation: couts.length ? arrondir(moyenne(couts), 5) : null,
    cout_moyen_message: messages ? arrondir(somme(couts) / messages, 5) : null,
    appels_par_message: messages ? arrondir(conversations.reduce((s, c) => s + c.appels, 0) / messages, 2) : null,
    tokens: Object.fromEntries(CLES_TOKENS.map((cle) => [cle, conversations.reduce((s, c) => s + (c.tokens[cle] ?? 0), 0)])),
    latence_mediane_s: durees.length ? arrondir(durees[Math.floor(durees.length / 2)]! / 1000, 1) : null,
    latence_p90_s: durees.length ? arrondir(durees[Math.min(durees.length - 1, arrondir(0.9 * (durees.length - 1)))]! / 1000, 1) : null,
    commandes_creees: conversations.reduce((s, c) => s + c.commandes, 0),
    erreurs: conversations.flatMap((c) => c.erreurs),
  };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      variante: { type: "string", default: "livree" },
      essais: { type: "string", default: "3" },
      "budget-max": { type: "string", default: "0.2" },
      estimer: { type: "boolean", default: false },
    },
  });
  if (!(args.variante in VARIANTES)) throw new Error(`--variante : ${args.variante} ? Choix : ${Object.keys(VARIANTES).sort().join(", ")}.`);
  const essais = Number(args.essais);
  const budgetMax = Number(args["budget-max"]);
  const scenarios = chargerConversations();
  const nombre = scenarios.reduce((s, x) => s + x.messages.length, 0);
  console.log(`${scenarios.length} conversations, ${nombre} messages, ${essais} essai(s) ; estimation large : ${fixe(nombre * essais * COUT_SUPPOSE_PAR_MESSAGE, 2)} $`);
  if (args.estimer) return;

  const { creerClient } = await import("../comptoir/appel.ts");
  const { chargerBase } = await import("../comptoir/connaissances.ts");
  const client = creerClient();
  const base = chargerBase();
  const resultats: Conversation[] = [];
  let depense = 0;
  for (let essai = 1; essai <= essais; essai++) {
    const enregistreur = new Enregistreur(client);
    const service = new ServiceComptoir(enregistreur, environnement(), new Budget(":memory:"), new Conversations(), base, VARIANTES[args.variante]);
    for (const scenario of scenarios) {
      if (depense >= budgetMax) {
        console.log(`Arrêt : plafond de ${budgetMax} $ atteint.`);
        break;
      }
      const c = await jouer(service, enregistreur, scenario, args.variante, essai);
      depense += c.cout_dollars;
      resultats.push(c);
      console.log(`  ${args.variante.padEnd(10)} ${c.id.padEnd(22)} ${essai}  ${fixe(c.cout_dollars, 5)} $  ${String(c.appels).padStart(2)} appels  ${c.categories.join(" > ")}  ${c.erreurs.join("; ")}`);
    }
  }
  const resume = resumer(resultats);
  mkdirSync(RESULTATS, { recursive: true });
  const sortie = join(RESULTATS, `${horodatage()}-${args.variante}.json`);
  writeFileSync(sortie, jsonPython({ variante: args.variante, reglages: REGLAGES_PYTHON[args.variante], resume, conversations: resultats }, 1), "utf8");
  console.log(jsonPython(resume, 1));
  console.log(`→ ${sortie}`);
}

if (estLance(import.meta.url)) await main();
