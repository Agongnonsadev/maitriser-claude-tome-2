// Évaluer des variantes (prompts, modèles, réglages) sur un même jeu de cas (chapitre 5).
//
// Une variante est une fonction qui, pour un cas, renvoie la requête à envoyer. On pose chaque cas
// plusieurs fois, on note, et on compare : réussite, coût par réussite, régressions. Le chapitre 17 en
// fait une vraie suite d'évaluation.

import type Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { arrondir } from "./arrondi.ts";
import { type ClientMessages, texteDe } from "./client.ts";
import { cout } from "./couts.ts";
import { ecrireCsv as ecrire, lireCsv as lire } from "./csv.ts";
import { noter as noterAuJournal } from "./journal.ts";
import { type Cas, type Note, noter } from "./notation.ts";

export type Variante = (cas: Cas) => Anthropic.MessageCreateParamsNonStreaming;

/** Un essai : les colonnes de resultats/essais.csv, les mêmes que dans la version Python. */
export interface Essai {
  variante: string;
  cas: string;
  repetition: number;
  reussi: boolean;
  raisons: string;
  a_relire: string;
  reponse: string;
  latence_s: number;
  tokens_entree: number;
  tokens_sortie: number;
  cout_dollars: number;
  raison_arret: string;
}

const COLONNES: (keyof Essai)[] = [
  "variante", "cas", "repetition", "reussi", "raisons", "a_relire", "reponse",
  "latence_s", "tokens_entree", "tokens_sortie", "cout_dollars", "raison_arret",
];

/** Les critères du cas, plus une règle commune : une réponse qui ne s'arrête pas sur end_turn échoue. */
export function noterEssai(cas: Cas, texte: string, raisonArret: string | null): Note {
  const note = noter(cas, texte);
  if (raisonArret !== "end_turn") {
    note.reussi = false;
    note.raisons.push(`arrêt : ${raisonArret}`);
  }
  return note;
}

export async function essayer(
  client: ClientMessages,
  nom: string,
  requete: Anthropic.MessageCreateParamsNonStreaming,
  cas: Cas,
  repetition: number,
): Promise<Essai> {
  const debut = performance.now();
  const message = await client.messages.create(requete);
  const latence = (performance.now() - debut) / 1000;
  const texte = texteDe(message);
  const prix = cout(requete.model, message.usage);
  noterAuJournal(message._request_id, requete.model, prix, { prompt: nom });
  const note = noterEssai(cas, texte, message.stop_reason);
  return {
    variante: nom,
    cas: cas.identifiant,
    repetition,
    reussi: note.reussi,
    raisons: note.raisons.join(" ; "),
    a_relire: note.aRelire,
    reponse: texte,
    latence_s: arrondir(latence, 2),
    tokens_entree: prix.entree,
    tokens_sortie: prix.sortie,
    cout_dollars: prix.dollars,
    raison_arret: message.stop_reason ?? "",
  };
}

export async function evaluer(
  client: ClientMessages,
  cas: Cas[],
  variantes: Record<string, Variante>,
  repetitions: number,
  budgetMax: number,
): Promise<Essai[]> {
  const essais: Essai[] = [];
  let depense = 0;
  for (const [nom, construire] of Object.entries(variantes)) {
    for (const c of cas) {
      for (let r = 1; r <= repetitions; r++) {
        if (depense >= budgetMax) {
          console.log(`Budget de ${budgetMax} $ atteint : arrêt.`);
          return essais;
        }
        const essai = await essayer(client, nom, construire(c), c, r);
        depense += essai.cout_dollars;
        essais.push(essai);
      }
    }
  }
  return essais;
}

export interface Resume {
  variante: string;
  essais: number;
  reussite: number;
  coutParAppel: number;
  coutParReussite: number | null;
  latenceMedianeS: number;
}

const somme = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0);
const mediane = (valeurs: number[]): number => {
  const v = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(v.length / 2);
  return v.length % 2 ? v[milieu]! : (v[milieu - 1]! + v[milieu]!) / 2;
};

export function resumer(essais: Essai[]): Resume[] {
  return [...new Set(essais.map((e) => e.variante))].map((nom) => {
    const groupe = essais.filter((e) => e.variante === nom);
    const reussites = groupe.filter((e) => e.reussi).length;
    const total = somme(groupe.map((e) => e.cout_dollars));
    return {
      variante: nom,
      essais: groupe.length,
      reussite: reussites / groupe.length,
      coutParAppel: total / groupe.length,
      coutParReussite: reussites ? total / reussites : null,
      latenceMedianeS: mediane(groupe.map((e) => e.latence_s)),
    };
  });
}

export function tauxParCas(essais: Essai[], variante: string): Map<string, number> {
  const parCas = new Map<string, boolean[]>();
  for (const e of essais) {
    if (e.variante === variante) parCas.set(e.cas, [...(parCas.get(e.cas) ?? []), e.reussi]);
  }
  return new Map([...parCas].map(([c, v]) => [c, v.filter(Boolean).length / v.length]));
}

/** Les cas mieux réussis par l'ancienne variante que par la nouvelle. */
export function regressions(essais: Essai[], avant: string, apres: string): string[] {
  const a = tauxParCas(essais, avant);
  const b = tauxParCas(essais, apres);
  return [...a].filter(([c, taux]) => b.has(c) && b.get(c)! < taux).map(([c]) => c).sort();
}

/**
 * Applique la grille actuelle aux réponses déjà obtenues : aucun appel, aucun coût.
 *
 * À réserver à une correction de la grille décidée pour une raison écrite, et appliquée à toutes les
 * variantes à la fois ; on garde les deux résultats, avant et après.
 */
export function renoter(essais: Essai[], cas: Cas[]): Essai[] {
  const parIdentifiant = new Map(cas.map((c) => [c.identifiant, c]));
  return essais.map((e) => {
    const c = parIdentifiant.get(e.cas);
    if (!c) throw new Error(`Cas inconnu dans les résultats : « ${e.cas} »`);
    const note = noterEssai(c, e.reponse, e.raison_arret);
    return { ...e, reussi: note.reussi, raisons: note.raisons.join(" ; "), a_relire: note.aRelire };
  });
}

/** Relit un fichier de résultats, de cette version ou de la version Python : les types reviennent intacts. */
export function lireCsv(chemin: string): Essai[] {
  return lire(chemin).map((l) => ({
    variante: l.variante ?? "",
    cas: l.cas ?? "",
    repetition: Number(l.repetition),
    reussi: l.reussi === "True",
    raisons: l.raisons ?? "",
    a_relire: l.a_relire ?? "",
    reponse: l.reponse ?? "",
    latence_s: Number(l.latence_s),
    tokens_entree: Number(l.tokens_entree),
    tokens_sortie: Number(l.tokens_sortie),
    cout_dollars: Number(l.cout_dollars),
    raison_arret: l.raison_arret ?? "",
  }));
}

export function ecrireCsv(essais: Essai[], chemin: string): void {
  ecrire(essais, COLONNES, chemin, ["latence_s", "cout_dollars"]); // des float en Python
}
