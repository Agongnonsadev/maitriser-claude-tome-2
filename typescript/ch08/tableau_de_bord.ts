// Chapitre 8 : le tableau de bord du Comptoir, tiré du journal. Aucun appel à l'API.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch08/tableau_de_bord.ts
//     npx tsx ch08/tableau_de_bord.ts --html journal/tableau.html
//     npx tsx ch08/tableau_de_bord.ts --journal ../python/journal/appels.jsonl   (le journal de la version Python)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { aReprendre, charger, enHtml, latences, modesDEchec, parJour } from "../comptoir/tableau.ts";

const { values: args } = parseArgs({
  options: {
    journal: { type: "string", default: config.JOURNAL },
    html: { type: "string" }, // écrire aussi une page HTML à ce chemin
  },
});

const lignes = charger(args.journal);
console.log("Jour        Appels   Coût ($)    FCFA   Échecs");
for (const [jour, j] of parJour(lignes)) {
  console.log(
    `${jour}  ${String(j.appels).padStart(6)}  ${j.dollars.toFixed(4).padStart(9)}  ${(j.dollars * config.TAUX_FCFA).toFixed(0).padStart(6)}   ${String(j.echecs).padStart(6)}`,
  );
}
const [mediane, p95] = latences(lignes);
if (mediane !== null) console.log(`\nLatence des appels réussis : médiane ${mediane.toFixed(0)} ms, 95e centile ${p95!.toFixed(0)} ms`);
const echecs = modesDEchec(lignes);
if (echecs.length) {
  console.log("\nModes d'échec (origine, code) :");
  for (const { origine, code, nombre } of echecs) console.log(`  ${origine.padEnd(12)} ${code.padEnd(22)} ${nombre}`);
}
const reprendre = aReprendre(lignes);
if (reprendre.length) {
  console.log("\nConversations à reprendre par Awa :");
  for (const r of reprendre) console.log(`  ${r.date}  ${r.conversation}  (${r.motif})`);
}
if (args.html) {
  mkdirSync(dirname(args.html), { recursive: true });
  writeFileSync(args.html, enHtml(lignes), "utf8");
  console.log(`\nPage écrite : ${args.html}`);
}
