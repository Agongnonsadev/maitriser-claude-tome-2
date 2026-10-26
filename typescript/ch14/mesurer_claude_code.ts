// Chapitre 14 : trois questions de Yao à Claude Code, sur la copie des commandes, par MCP.
//
// Lancement, depuis le dossier typescript/ (APPEL PAYANT : Claude Code utilise votre clé d'API) :
//     npx tsx ch14/mesurer_claude_code.ts --claude "chemin/vers/claude" --budget-max 0.40
//
// Chaque question est posée dans une séance neuve de `claude -p`, lancée depuis le dossier python/, qui
// charge le serveur MCP de python/.mcp.json (portée projet). Seuls les deux outils du serveur des commandes
// sont permis ; tout autre outil est refusé (--permission-mode dontAsk). Chaque réponse est comparée aux
// bonnes réponses calculées par le code (ch14/verites.ts), et le coût est lu dans la sortie JSON.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixe } from "../comptoir/arrondi.ts";
import { APRES, AVANT } from "../comptoir/garde.ts";
import { RACINE as RACINE_TS, estLance } from "../comptoir/lancement.ts";
import { jsonPython } from "../comptoir/python.ts";
import { RACINE } from "./serveurs.ts";
import { type Verites, calculer } from "./verites.ts";

export const OUTILS = "mcp__commandes__execute_sql,mcp__commandes__search_objects";
export const RESULTATS = join(RACINE_TS, "ch14", "resultats");
export const MODELE = "claude-sonnet-5-5"; // le modèle du Comptoir (chapitre 3)

export const QUESTIONS: [string, string][] = [
  ["schema", "Décris-moi la base des commandes branchée par MCP : quelles tables, et comment une commande est reliée à ses produits et au quartier du client ? Réponds en cinq lignes au plus."],
  ["quartiers", "Du lundi 21 septembre au dimanche 18 octobre 2026, quels sont les trois quartiers qui ont rapporté le plus, en FCFA, et combien de commandes pour chacun ? Donne les montants exacts."],
  [
    "abandons",
    "Combien de conversations ont reçu au moins un récapitulatif sans qu'aucun ne devienne une commande, sur combien de conversations au total ? À quelle heure de la journée le taux d'abandon est-il le plus élevé (parmi les heures d'au moins 20 récapitulatifs) ?",
  ],
];

// \d et \b de Python, sur tous les chiffres et toutes les lettres (\s de JavaScript comprend déjà les
// espaces insécables, U+00A0 et U+202F, que la version Python ajoute à la main).
const CHIFFRE = "\\p{Nd}";
const SEPARATEUR = new RegExp(`(?<=${CHIFFRE})[\\s.,](?=${CHIFFRE}{3}${APRES})`, "gu");

/** « 194 500 » ou « 194.500 » ou « 194 500 » : on compare les chiffres sans les séparateurs. */
export const chiffres = (texte: string): string => texte.replace(SEPARATEUR, "");

const contientLeNombre = (texte: string, n: number | string): boolean => new RegExp(`${AVANT}${n}${APRES}`, "u").test(texte);

/** Les écarts entre la réponse et ce que le code a calculé. Liste vide : réponse juste. */
export function verifier(question: string, reponse: string, verites: Pick<Verites, "quartiers" | "abandons" | "conversations" | "heure_pire_abandon">): string[] {
  const texte = chiffres(reponse);
  const ecarts: string[] = [];
  if (question === "schema") {
    for (const mot of ["recapitulatifs", "commandes", "lignes", "quartier"]) {
      if (!texte.toLowerCase().replaceAll("é", "e").includes(mot)) ecarts.push(`ne cite pas « ${mot} »`);
    }
    if (!texte.toLowerCase().includes("json")) ecarts.push("ne dit pas que les lignes sont en JSON");
  } else if (question === "quartiers") {
    for (const q of verites.quartiers) {
      if (!reponse.includes(q.quartier)) ecarts.push(`quartier manquant : ${q.quartier}`);
      if (!texte.includes(String(q.fcfa))) ecarts.push(`montant manquant pour ${q.quartier} : ${q.fcfa}`);
      if (!contientLeNombre(texte, q.commandes)) ecarts.push(`nombre de commandes manquant pour ${q.quartier} : ${q.commandes}`);
    }
  } else if (question === "abandons") {
    for (const cle of ["abandons", "conversations"] as const) {
      if (!contientLeNombre(texte, verites[cle])) ecarts.push(`${cle} : ${verites[cle]} attendu`);
    }
    const heure = verites.heure_pire_abandon;
    if (!new RegExp(`${AVANT}${heure}\\s*h|${AVANT}${heure}:00|${AVANT}${heure} heures`, "u").test(texte)) ecarts.push(`heure attendue : ${heure} h`);
  }
  return ecarts;
}

export function poser(claude: string, question: string, budget: number): Record<string, unknown> {
  const commande = ["-p", question, "--model", MODELE, "--output-format", "json", "--allowedTools", OUTILS, "--permission-mode", "dontAsk",
    "--max-budget-usd", fixe(budget, 2), "--no-session-persistence"];
  const sortie = spawnSync(claude, commande, { cwd: RACINE, encoding: "utf8", timeout: 600_000 });
  if (sortie.error) throw sortie.error;
  if (sortie.status !== 0 && !sortie.stdout.trim()) throw new Error(`claude -p a échoué : ${sortie.stderr.slice(-800)}`);
  return JSON.parse(sortie.stdout) as Record<string, unknown>;
}

/** datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"). */
const horodatage = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      claude: { type: "string", default: "claude" }, //             le programme claude (Claude Code)
      "budget-max": { type: "string", default: "0.40" }, //          plafond par question, en dollars
      seulement: { type: "string" },
    },
  });
  const noms = QUESTIONS.map(([n]) => n);
  if (args.seulement !== undefined && !noms.includes(args.seulement)) {
    console.error(`erreur : --seulement à choisir parmi ${noms.join(", ")}`);
    process.exit(2);
  }
  const verites = calculer();
  mkdirSync(RESULTATS, { recursive: true });
  let total = 0;
  for (const [nom, question] of QUESTIONS) {
    if (args.seulement && nom !== args.seulement) continue;
    const resultat = poser(args.claude, question, Number(args["budget-max"]));
    const reponse = String(resultat.result ?? "");
    const ecarts = verifier(nom, reponse, verites);
    const cout = Number(resultat.total_cost_usd ?? 0);
    total += cout;
    writeFileSync(join(RESULTATS, `${horodatage()}-${nom}.json`), jsonPython({ question, ecarts, sortie: resultat }, 2), "utf8");
    console.log(`\n=== ${nom} : ${ecarts.length ? "ÉCARTS : " + ecarts.join(" ; ") : "juste"}`);
    console.log(`${resultat.num_turns} tours, ${fixe(cout, 4)} $, arrêt : ${resultat.subtype}`);
    console.log([...reponse.trim()].slice(0, 1500).join(""));
  }
  console.log(`\nCoût total : ${fixe(total, 4)} $`);
}

if (estLance(import.meta.url)) await main();
