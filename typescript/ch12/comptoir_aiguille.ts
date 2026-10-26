// Chapitre 12 : les 30 messages, avec et sans routeur, chacun dans une conversation neuve.
//
// - direct : tout part au Comptoir du chapitre 11 (Claude Sonnet 5.5, outils, base, cache d'une heure) ;
// - aiguille : le routeur choisit le service, chaque étape est tracée.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch12/comptoir_aiguille.ts --budget-max 1

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ComptoirAiguille } from "../comptoir/aiguillage.ts";
import { creerClient } from "../comptoir/appel.ts";
import { arrondir, fixe } from "../comptoir/arrondi.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import { ComptoirCommandes } from "../comptoir/commandes.ts";
import { config } from "../comptoir/config.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { ecrireCsv, lireCsv } from "../comptoir/csv.ts";
import { RACINE, plusieursValeurs } from "../comptoir/lancement.ts";
import { somme } from "../comptoir/python.ts";
import type { Trace } from "../comptoir/trace.ts";
import { chargerMessages } from "./evaluer_routeur.ts";

const COLONNES = ["mode", "id", "attendu", "categorie", "appels", "cout_dollars", "duree_s", "demandes_pour_awa", "reponse"] as const;
type Ligne = Record<(typeof COLONNES)[number], string | number>;

const lignesDuJournal = (): Record<string, unknown>[] =>
  existsSync(config.JOURNAL) ? readFileSync(config.JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function coutJournal(depuis: number): [number, number] {
  const appels = lignesDuJournal().slice(depuis).filter((l) => "requete" in l);
  return [somme(appels.map((l) => l.cout_dollars as number)), appels.length]; // sum() de Python
}

const { values: args } = parseArgs({
  args: plusieursValeurs(["modes", "traces"]),
  options: {
    modes: { type: "string", multiple: true, default: ["direct", "aiguille"] },
    "budget-max": { type: "string", default: "1" },
    traces: { type: "string", multiple: true, default: ["godomey", "malaise", "six-bissap"] },
  },
});
const inconnus = args.modes.filter((m) => m !== "direct" && m !== "aiguille");
if (inconnus.length) throw new Error(`--modes : ${inconnus.join(", ")} ? Choix : direct, aiguille.`);
const traces = args.traces.filter(Boolean);
const budgetMax = Number(args["budget-max"]);

const client = creerClient();
const base = chargerBase();
let lignes: Ligne[] = [];
let depense = 0;
for (const mode of args.modes) {
  for (const m of chargerMessages()) {
    if (depense >= budgetMax) {
      console.error(`Budget de ${budgetMax} $ atteint : arrêt.`); // SystemExit en Python : rien n'est écrit
      process.exit(1);
    }
    const boutique = new Boutique(":memory:");
    const conversation = identifiantAleatoire();
    const avant = lignesDuJournal().length;
    const debut = performance.now();
    let texte: string;
    let categorie: string;
    let trace: Trace | null = null;
    if (mode === "direct") {
      const comptoir = new ComptoirCommandes(client, boutique, new Budget(":memory:"), conversation, { versionPrompt: "v3", connaissances: base, cache: "1h" });
      texte = (await comptoir.repondre(m.message)).texte;
      categorie = "—";
    } else {
      // Le Comptoir de ce chapitre : Claude Sonnet 5.5 (le chapitre 17 l'a remplacé par Haiku 5.5).
      const r = await new ComptoirAiguille(client, boutique, new Budget(":memory:"), conversation, base, { modeleComptoir: config.MODELE }).repondre(m.message);
      ({ texte, categorie, trace } = r);
    }
    const duree = (performance.now() - debut) / 1000;
    const [cout, appels] = coutJournal(avant);
    depense += cout;
    lignes.push({
      mode, id: m.id, attendu: m.attendu, categorie, appels, cout_dollars: arrondir(cout, 6), duree_s: arrondir(duree, 2),
      demandes_pour_awa: boutique.demandes().length, reponse: texte,
    });
    if (trace && traces.includes(m.id)) console.log(`\n--- ${m.id} : ${m.message}\n${texte}\n${trace.afficher()}`);
  }
}

const sortie = join(RACINE, "ch12", "resultats", "comptoir.csv");
const nouvelles = lignes;
if (existsSync(sortie)) {
  // Relancer un seul mode garde les lignes de l'autre.
  lignes = [...(lireCsv(sortie) as Ligne[]).filter((l) => !args.modes.includes(String(l.mode))), ...lignes];
}
ecrireCsv(lignes, [...COLONNES], sortie, ["cout_dollars", "duree_s"]);

const moyenne = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
const mediane = (valeurs: number[]): number => {
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries[milieu]! : (tries[milieu - 1]! + tries[milieu]!) / 2;
};
console.log(
  `\n${"mode".padEnd(9)} ${"catégorie attendue".padEnd(20)} ${"messages".padStart(8)} ${"appels".padStart(7)} ${"coût moyen".padStart(11)} ${"durée méd.".padStart(11)}`,
);
for (const mode of args.modes) {
  for (const attendu of ["information", "commande", "reclamation", "autre", null]) {
    const g = nouvelles.filter((l) => l.mode === mode && (attendu === null || l.attendu === attendu));
    console.log(
      `${mode.padEnd(9)} ${(attendu ?? "TOUT").padEnd(20)} ${String(g.length).padStart(8)} ${String(g.reduce((s, l) => s + Number(l.appels), 0)).padStart(7)} ` +
        `${fixe(moyenne(g.map((l) => Number(l.cout_dollars))), 5).padStart(11)} ${fixe(mediane(g.map((l) => Number(l.duree_s))), 1).padStart(10)}s`,
    );
  }
}
console.log(`\nDépense : ${depense.toFixed(4)} $ ; réponses à relire : ${sortie}`);
