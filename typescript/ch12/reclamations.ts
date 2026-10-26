// Chapitre 12 : la chaîne des réclamations, sur les six réclamations de test, avec leur trace.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch12/reclamations.ts
// Comparer deux efforts de rédaction :         npx tsx ch12/reclamations.ts --effort defaut --repetitions 2
//                                              npx tsx ch12/reclamations.ts --effort low --repetitions 2

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { fixe } from "../comptoir/arrondi.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { plusieursValeurs } from "../comptoir/lancement.ts";
import { repr } from "../comptoir/python.ts";
import { EFFORT_REDACTION, type ResultatReclamation, traiter } from "../comptoir/reclamations.ts";
import { Trace } from "../comptoir/trace.ts";
import { chargerMessages } from "./evaluer_routeur.ts";

const EFFORTS = ["defaut", "low", "medium", "high"];

const { values: args } = parseArgs({
  args: plusieursValeurs(["seulement"]),
  options: {
    seulement: { type: "string", multiple: true },
    effort: { type: "string" }, // effort de la rédaction ; sans cette option, celui du module ; « defaut » : celui du modèle
    repetitions: { type: "string", default: "1" },
  },
});
if (args.effort !== undefined && !EFFORTS.includes(args.effort)) throw new Error(`--effort : ${EFFORTS.join(", ")}.`);
const effort = args.effort === undefined ? EFFORT_REDACTION : args.effort === "defaut" ? null : (args.effort as "low" | "medium" | "high");
const seulement = (args.seulement ?? []).filter(Boolean);

const client = new Anthropic();
const boutique = new Boutique(":memory:");
const traces: Trace[] = [];
const resultats: ResultatReclamation[] = [];
const choisis = chargerMessages().filter((m) => m.attendu === "reclamation");
for (let r = 0; r < Number(args.repetitions); r++) {
  for (const m of choisis.filter((m) => !seulement.length || seulement.includes(m.id))) {
    const trace = new Trace();
    const resultat = await traiter(client, m.message, boutique, identifiantAleatoire(), { trace, effort });
    traces.push(trace);
    resultats.push(resultat);
    console.log(`\n=== ${m.id} ===\nClient   : ${m.message}\nComptoir : ${resultat.reponse}`);
    console.log(`Faits    : ${repr(resultat.faits)}`);
    console.log(
      `À demander : ${resultat.manques.length ? repr(resultat.manques) : "rien"} ; versions : ${resultat.tentatives} ; ` +
        `texte de repli : ${resultat.repli ? "oui" : "non"}`,
    );
    const refusees = Math.min(resultat.versions.length, resultat.critiques.length);
    for (let i = 0; i < refusees; i++) {
      console.log(`Version ${i + 1}, refusée : ${resultat.versions[i]}`);
      console.log(`  Critique : ${resultat.critiques[i]}`);
    }
    console.log(trace.afficher());
  }
}
const coupees = resultats.flatMap((r) => r.critiques).filter((c) => c.startsWith("réponse arrêtée")).length;
const moyenne = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
const mediane = (valeurs: number[]): number => {
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries[milieu]! : (tries[milieu - 1]! + tries[milieu]!) / 2;
};
console.log(
  `\nEffort de rédaction : ${effort || "défaut du modèle"} ; réclamations : ${resultats.length} ; ` +
    `conformes à la 1re version : ${resultats.filter((r) => r.tentatives === 1 && !r.repli).length} ; ` +
    `rédactions coupées : ${coupees} ; textes de repli : ${resultats.filter((r) => r.repli).length}`,
);
console.log(
  `Coût moyen : ${fixe(moyenne(traces.map((t) => t.cout)), 5)} $ ; durée médiane : ` +
    `${fixe(mediane(traces.map((t) => t.dureeMs)) / 1000, 1)} s ; coût total : ${fixe(traces.reduce((s, t) => s + t.cout, 0), 4)} $ ; ` +
    `demandes enregistrées pour Awa : ${boutique.demandes().length}`,
);
