// Ce que les scripts du chapitre 11 partagent : la base, les contextes déjà calculés, la recherche.
//
// Les 20 questions sont celles de la version Python (python/ch11/questions.json). Les phrases de contexte
// aussi, tant que ch11/contextualiser.ts n'a pas écrit les siennes dans ch11/resultats/contextes.json.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Morceau, avecContextes, chargerBase } from "../comptoir/connaissances.ts";
import { type CasDocumentaire, creerCasDocumentaire } from "../comptoir/documentaire.ts";
import { PYTHON, RACINE } from "../comptoir/lancement.ts";
import { IndexBM25 } from "../comptoir/recherche.ts";

export const RESULTATS = join(RACINE, "ch11", "resultats");
export const CONTEXTES = join(RESULTATS, "contextes.json");
const CONTEXTES_PYTHON = join(PYTHON, "ch11", "resultats", "contextes.json");

export function chargerQuestions(): CasDocumentaire[] {
  const cas = JSON.parse(readFileSync(join(PYTHON, "ch11", "questions.json"), "utf8")) as Parameters<typeof creerCasDocumentaire>[0][];
  return cas.map(creerCasDocumentaire);
}

/** La base avec ses phrases de contexte, si elles ont déjà été calculées (ici, ou par la version Python). */
export function baseContextualisee(): Morceau[] | null {
  const chemin = [CONTEXTES, CONTEXTES_PYTHON].find(existsSync);
  if (!chemin) return null;
  return avecContextes(chargerBase(), JSON.parse(readFileSync(chemin, "utf8")) as Record<string, string>);
}

export function indexBm25(contextuel = true): IndexBM25 {
  const base = contextuel ? baseContextualisee() : null;
  return new IndexBM25(base?.length ? base : chargerBase());
}
