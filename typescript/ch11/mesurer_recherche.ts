// Chapitre 11 : la recherche trouve-t-elle le bon morceau ? Rappel à 1, 3 et 5, sans appel à Claude.
//
// Pour chaque question dont la réponse est dans les documents, on regarde si l'un des morceaux attendus
// est dans les k premiers résultats. Index comparés : BM25 sur les morceaux bruts, BM25 sur les morceaux
// contextualisés (si les contextes ont été calculés), et, si VOYAGE_API_KEY est posée, les embeddings de
// Voyage AI (payants) et la recherche hybride (fusion des rangs).
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch11/mesurer_recherche.ts

import { arrondir } from "../comptoir/arrondi.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { type Classement, IndexBM25, IndexVecteurs, fusionner, plongeurVoyage, rappel } from "../comptoir/recherche.ts";
import { baseContextualisee, chargerQuestions } from "./outils_communs.ts";

type Chercheur = (question: string, k: number) => Classement | Promise<Classement>;

const cas = chargerQuestions().filter((c) => !c.absente);
const bm25 = new IndexBM25(chargerBase());
const chercheurs = new Map<string, Chercheur>([["BM25", (q, k) => bm25.chercher(q, k)]]);
const contextualisee = baseContextualisee();
if (contextualisee) {
  const index = new IndexBM25(contextualisee);
  chercheurs.set("BM25 contextuel", (q, k) => index.chercher(q, k));
}
if (process.env.VOYAGE_API_KEY) {
  const vecteurs = await IndexVecteurs.creer(contextualisee ?? chargerBase(), plongeurVoyage());
  const lexical = new IndexBM25(contextualisee ?? chargerBase());
  chercheurs.set("embeddings", (q, k) => vecteurs.chercher(q, k));
  chercheurs.set("hybride", async (q, k) => fusionner([lexical.chercher(q, 20), await vecteurs.chercher(q, 20)], { garder: k }));
}

/** 0.75 -> « 75% », comme le format .0% de Python. */
const pourcentage = (t: number): string => `${arrondir(t * 100)}%`;

console.log(`${cas.length} questions dont la réponse est dans les documents\n`);
console.log(`${"index".padEnd(18)} ${"rappel@1".padStart(9)} ${"rappel@3".padStart(9)} ${"rappel@5".padStart(9)}`);
for (const [nom, chercher] of chercheurs) {
  const taux: number[] = [];
  for (const k of [1, 3, 5]) {
    let trouves = 0;
    for (const c of cas) if (rappel(await chercher(c.question, k), c.sources)) trouves++;
    taux.push(trouves / cas.length);
  }
  console.log(`${nom.padEnd(18)} ` + taux.map((t) => pourcentage(t).padStart(9)).join(" "));
  const rates: string[] = [];
  for (const c of cas) if (!rappel(await chercher(c.question, 5), c.sources)) rates.push(c.identifiant);
  if (rates.length) console.log(`${"".padEnd(18)} hors des 5 premiers : ${rates.join(", ")}`);
}
