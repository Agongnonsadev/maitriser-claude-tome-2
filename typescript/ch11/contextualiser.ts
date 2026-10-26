// Chapitre 11 : écrire, pour chaque morceau de la base, la phrase qui le situe dans son document.
//
// C'est la méthode « Contextual Retrieval » d'Anthropic. Le document entier est envoyé avec un point de
// cache ; du deuxième morceau au dernier, il est lu dans le cache. Les phrases sont gardées dans
// ch11/resultats/contextes.json : on ne les recalcule que si un document change.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch11/contextualiser.ts
// Modèle : Claude Haiku 5.5. Coût : une quarantaine d'appels courts.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOSSIER, decouper } from "../comptoir/connaissances.ts";
import { cout } from "../comptoir/couts.ts";
import { MODELE_AUXILIAIRE, contextualiser } from "../comptoir/recherche.ts";
import { CONTEXTES } from "./outils_communs.ts";

const client = new Anthropic();
const tous: Record<string, string> = {};
let total = 0;
console.log(
  `${"document".padEnd(22)} ${"morceaux".padStart(8)} ${"écrit".padStart(7)} ${"lu".padStart(7)} ${"entrée".padStart(7)} ${"sortie".padStart(7)} ${"coût ($)".padStart(9)}`,
);
for (const fichier of readdirSync(DOSSIER).filter((f) => f.endsWith(".md")).sort()) {
  const nom = fichier.slice(0, -3);
  // Le document tel que le lit Python (read_text) : fins de ligne ramenées à « \n ».
  const texte = readFileSync(join(DOSSIER, fichier), "utf8").replace(/\r\n?/g, "\n");
  const morceaux = decouper(texte, nom);
  const [contextes, usages] = await contextualiser(client, texte, morceaux);
  const prix = usages.map((u) => cout(MODELE_AUXILIAIRE, u));
  const somme = (champ: (p: (typeof prix)[number]) => number): number => prix.reduce((s, p) => s + champ(p), 0);
  total += somme((p) => p.dollars);
  console.log(
    `${nom.padEnd(22)} ${String(morceaux.length).padStart(8)} ${String(somme((p) => p.ecritureCache)).padStart(7)} ` +
      `${String(somme((p) => p.lectureCache)).padStart(7)} ${String(somme((p) => p.entree)).padStart(7)} ` +
      `${String(somme((p) => p.sortie)).padStart(7)} ${somme((p) => p.dollars).toFixed(5).padStart(9)}`,
  );
  Object.assign(tous, contextes);
}
mkdirSync(dirname(CONTEXTES), { recursive: true });
writeFileSync(CONTEXTES, JSON.stringify(tous, null, 1), "utf8"); // comme json.dumps(…, indent=1)
console.log(`\n${Object.keys(tous).length} contextes écrits dans ${CONTEXTES} ; coût total : ${total.toFixed(5)} $`);
const [identifiant, phrase] = Object.entries(tous)[0]!;
console.log(`Exemple, ${identifiant} :\n  ${phrase}`);
