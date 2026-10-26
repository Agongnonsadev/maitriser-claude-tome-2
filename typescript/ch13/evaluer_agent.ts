// Chapitre 13 : plusieurs séances de l'agent par réglage, ses critères, son coût et sa durée.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch13/evaluer_agent.ts --repetitions 3 --budget-max 2
// Réglages :  sonnet (sous-agent pour les messages), sonnet-lecture-directe, haiku, opus
// Chaque séance est gardée dans ch13/resultats/seances.jsonl, pour la relecture.

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type ClientAgent, Garde, type Reglages, lancer, reglages } from "../comptoir/agent_reappro.ts";
import { arrondir, fixe } from "../comptoir/arrondi.ts";
import { Atelier } from "../comptoir/atelier.ts";
import { ecrireCsv } from "../comptoir/csv.ts";
import { RACINE, plusieursValeurs } from "../comptoir/lancement.ts";
import { Flottant, jsonPython } from "../comptoir/python.ts";
import { criteres } from "./criteres.ts";

const DOSSIER = join(RACINE, "ch13", "resultats");
const REGLAGES: Record<string, Reglages> = {
  sonnet: reglages(),
  "sonnet-lecture-directe": reglages({ sousAgent: false }),
  haiku: reglages({ modele: "claude-haiku-5-5" }),
  opus: reglages({ modele: "claude-opus-5-5" }),
};
const A_VIRGULE = ["cout_dollars", "dont_sous_agent", "duree_s"]; // des float en Python

/** Les lignes non vides du résumé (texte.splitlines() et ligne.strip()). */
const lignesDuResume = (texte: string): number => texte.split(/\r\n|\r|\n/).filter((l) => l.trim()).length;

const { values: args } = parseArgs({
  args: plusieursValeurs(["reglages"]),
  options: {
    reglages: { type: "string", multiple: true, default: ["sonnet", "sonnet-lecture-directe", "haiku"] },
    repetitions: { type: "string", default: "3" },
    "budget-max": { type: "string", default: "2.0" }, // en dollars, pour toute l'évaluation
    sortie: { type: "string", default: "agent.csv" },
  },
});
const inconnus = args.reglages.filter((r) => !(r in REGLAGES));
if (inconnus.length) throw new Error(`--reglages : ${inconnus.join(", ")} ? Choix : ${Object.keys(REGLAGES).join(", ")}.`);
const budgetMax = Number(args["budget-max"]);

const client = new Anthropic() as unknown as ClientAgent;
const lignes: Record<string, string | number | boolean>[] = [];
let depense = 0;
mkdirSync(DOSSIER, { recursive: true });
for (const nom of args.reglages) {
  for (let passage = 1; passage <= Number(args.repetitions); passage++) {
    if (depense >= budgetMax) {
      console.error(`Budget de ${budgetMax} $ atteint : arrêt.`); // SystemExit en Python : le CSV n'est pas écrit
      process.exit(1);
    }
    const r = await lancer(client, new Atelier(), REGLAGES[nom]!, new Garde({ budgetDollars: 0.6 }));
    depense += r.depense;
    const verdict = criteres(r.bon);
    const ligne = {
      reglage: nom, passage, arret: r.arret ?? "", tours: r.tours, cout_dollars: arrondir(r.depense, 5), dont_sous_agent: arrondir(r.coutSousAgent, 5),
      duree_s: arrondir(r.dureeS, 1), pic_contexte: r.picContexte, appels_outils: r.outils.length, total_fcfa: r.bon ? r.bon.total_fcfa : "",
      lignes_du_resume: lignesDuResume(r.texte), criteres_reussis: Object.values(verdict).filter(Boolean).length, ...verdict,
    };
    lignes.push(ligne);
    const enFloat = Object.fromEntries(A_VIRGULE.map((k) => [k, new Flottant(ligne[k as keyof typeof ligne] as number)]));
    appendFileSync(join(DOSSIER, "seances.jsonl"), jsonPython({ ...ligne, ...enFloat, bon: r.bon, resume: r.texte, outils: r.outils, trace: r.trace.afficher() }) + "\n", "utf8");
    console.log(
      `${nom.padEnd(24)} ${passage}  ${ligne.criteres_reussis}/${Object.keys(verdict).length}  ${String(r.tours).padStart(2)} tours  ` +
        `${fixe(r.depense, 4)} $  ${fixe(r.dureeS, 1).padStart(5)} s  ${r.arret ?? ""}`,
    );
  }
}

const champs = [...new Set(lignes.flatMap((l) => Object.keys(l)))];
ecrireCsv(lignes, champs, join(DOSSIER, args.sortie), A_VIRGULE);
const moyenne = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
const mediane = (valeurs: number[]): number => {
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries[milieu]! : (tries[milieu - 1]! + tries[milieu]!) / 2;
};
console.log(
  `\n${"réglage".padEnd(24)} ${"séances".padStart(7)} ${"critères".padStart(9)} ${"coût moyen".padStart(11)} ${"durée méd.".padStart(10)} ${"tours".padStart(6)} ${"contexte max".padStart(12)}`,
);
for (const nom of args.reglages) {
  const g = lignes.filter((l) => l.reglage === nom);
  const valeurs = (champ: string): number[] => g.map((l) => Number(l[champ]));
  console.log(
    `${nom.padEnd(24)} ${String(g.length).padStart(7)} ${String(valeurs("criteres_reussis").reduce((a, b) => a + b, 0)).padStart(4)}/${String(7 * g.length).padEnd(4)} ` +
      `${fixe(moyenne(valeurs("cout_dollars")), 4).padStart(10)}$ ${fixe(mediane(valeurs("duree_s")), 1).padStart(9)}s ` +
      `${fixe(moyenne(valeurs("tours")), 1).padStart(6)} ${String(Math.max(...valeurs("pic_contexte"))).padStart(12)}`,
  );
}
console.log(`\nDépense : ${fixe(depense, 4)} $`);
