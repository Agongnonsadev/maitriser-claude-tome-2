// Chapitre 11 : 20 questions, trois façons de donner les documents à Claude, une même grille.
//
// - contexte : toute la base dans la requête, lue dans le cache ;
// - rag : les 5 morceaux trouvés par BM25 ;
// - rag-reclasse : les 10 premiers de BM25, reclassés par Claude Haiku 5.5, qui en garde 3.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch11/evaluer_documentaire.ts --budget-max 0.8
//     npx tsx ch11/evaluer_documentaire.ts --modes contexte --budget-max 0.3
//     npx tsx ch11/evaluer_documentaire.ts --modes contexte --modele claude-haiku-5-5 --sortie essais-haiku.csv

import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { arrondir } from "../comptoir/arrondi.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { ecrireCsv } from "../comptoir/csv.ts";
import { MAX_TOKENS, chargerPrompt, noterDocumentaire, repondre } from "../comptoir/documentaire.ts";
import { plusieursValeurs } from "../comptoir/lancement.ts";
import { reclasser } from "../comptoir/recherche.ts";
import { RESULTATS, chargerQuestions, indexBm25 } from "./outils_communs.ts";

const MODES = ["contexte", "rag", "rag-reclasse"];

/** Une ligne de resultats/essais.csv : les mêmes colonnes que dans la version Python. */
interface Essai {
  mode: string;
  cas: string;
  reussi: boolean;
  raisons: string;
  a_relire: string;
  reponse: string;
  sources: string;
  morceaux_envoyes: number;
  tokens_entree: number;
  ecrit_cache: number;
  lu_cache: number;
  tokens_sortie: number;
  cout_dollars: number;
  cout_reclassement: number;
  latence_s: number;
}

const COLONNES: (keyof Essai)[] = [
  "mode", "cas", "reussi", "raisons", "a_relire", "reponse", "sources", "morceaux_envoyes", "tokens_entree",
  "ecrit_cache", "lu_cache", "tokens_sortie", "cout_dollars", "cout_reclassement", "latence_s",
];

const { values: args } = parseArgs({
  args: plusieursValeurs(["modes"]),
  options: {
    modes: { type: "string", multiple: true, default: MODES },
    "budget-max": { type: "string", default: "0.8" },
    modele: { type: "string" }, //                       le modèle qui répond (par défaut, celui du Comptoir)
    sortie: { type: "string", default: "essais.csv" },
    "sans-reflexion": { type: "boolean", default: false }, // Claude Haiku 5.5 : répondre sans réfléchir
    "max-tokens": { type: "string", default: String(MAX_TOKENS) },
    prompt: { type: "string", default: "v1" }, //         la version du prompt documentaire
    "sans-citations": { type: "boolean", default: false }, // sans citations : les sources ne sont pas notées
  },
});
const inconnus = args.modes.filter((m) => !MODES.includes(m));
if (inconnus.length) throw new Error(`--modes : ${inconnus.join(", ")} ? Choix : ${MODES.join(", ")}.`);
const budgetMax = Number(args["budget-max"]);

const client = new Anthropic();
const base = chargerBase();
const prompt = chargerPrompt(args.prompt);
// Mesuré (ch11/mesurer_recherche.ts) : sur cette base, le BM25 contextuel ne fait pas mieux.
const index = indexBm25(false);
const essais: Essai[] = [];
let depense = 0;
for (const mode of args.modes) {
  for (const cas of chargerQuestions()) {
    if (depense >= budgetMax) {
      console.log(`Budget de ${budgetMax} $ atteint : arrêt.`);
      break;
    }
    let coutRecherche = 0;
    let morceaux = base;
    let cache = true;
    if (mode === "rag") {
      morceaux = index.chercher(cas.question, 5).map(([m]) => m);
      cache = false;
    } else if (mode === "rag-reclasse") {
      const candidats = index.chercher(cas.question, 10).map(([m]) => m);
      [morceaux, coutRecherche] = await reclasser(client, cas.question, candidats, 3);
      cache = false;
    }
    const reponse = await repondre(client, cas.question, morceaux, {
      prompt,
      cache,
      mode,
      modele: args.modele ?? null,
      sansReflexion: args["sans-reflexion"],
      maxTokens: Number(args["max-tokens"]),
      avecCitations: !args["sans-citations"],
    });
    const raisons = noterDocumentaire(cas, reponse, !args["sans-citations"]);
    depense += reponse.cout.dollars + coutRecherche;
    essais.push({
      mode,
      cas: cas.identifiant,
      reussi: !raisons.length,
      raisons: raisons.join(" ; "),
      a_relire: cas.a_relire,
      reponse: reponse.texte,
      sources: reponse.sources.join(" "),
      morceaux_envoyes: morceaux.length,
      tokens_entree: reponse.cout.entree,
      ecrit_cache: reponse.cout.ecritureCache,
      lu_cache: reponse.cout.lectureCache,
      tokens_sortie: reponse.cout.sortie,
      cout_dollars: reponse.cout.dollars,
      cout_reclassement: arrondir(coutRecherche, 6),
      latence_s: reponse.latence,
    });
  }
}

const sortie = join(RESULTATS, args.sortie);
ecrireCsv(essais, COLONNES, sortie, ["cout_dollars", "cout_reclassement", "latence_s"]);

const moyenne = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
const mediane = (valeurs: number[]): number => {
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries[milieu]! : (tries[milieu - 1]! + tries[milieu]!) / 2;
};
console.log(
  `${"mode".padEnd(14)} ${"réussite".padStart(9)} ${"coût/réponse".padStart(13)} ${"coût total".padStart(11)} ` +
    `${"latence méd.".padStart(13)} ${"entrée moy.".padStart(12)}`,
);
for (const mode of new Set(essais.map((e) => e.mode))) {
  const g = essais.filter((e) => e.mode === mode);
  const couts = g.map((e) => e.cout_dollars + e.cout_reclassement);
  console.log(
    `${mode.padEnd(14)} ${String(g.filter((e) => e.reussi).length).padStart(5)}/${String(g.length).padEnd(3)} ` +
      `${moyenne(couts).toFixed(5).padStart(13)} ${couts.reduce((a, b) => a + b, 0).toFixed(4).padStart(11)} ` +
      `${mediane(g.map((e) => e.latence_s)).toFixed(1).padStart(12)}s ` +
      `${String(arrondir(moyenne(g.map((e) => e.tokens_entree + e.ecrit_cache + e.lu_cache)))).padStart(12)}`,
  );
}
console.log("\nÉchecs selon le code :");
for (const e of essais) if (!e.reussi) console.log(`  ${e.mode.padEnd(13)} ${e.cas.padEnd(16)} ${e.raisons}`);
console.log(`\nDépense des réponses : ${depense.toFixed(4)} $ (reclassement compris). Réponses à relire : ${sortie}`);
