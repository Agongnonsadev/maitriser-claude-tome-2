// Chapitre 7 : mesurer l'exactitude de l'extracteur sur un jeu de documents dont on connaît la réponse.
//
// Les documents et les valeurs attendues sont ceux de la version Python (python/ch07/documents/,
// attendus.json). Pour votre propre jeu, écrivez-les avant le premier essai, et fixez l'objectif
// d'exactitude avant de mesurer.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch07/mesurer_exactitude.ts --repetitions 3 --budget-max 0.5
//     npx tsx ch07/mesurer_exactitude.ts --cote-max 1000 --repetitions 3 --budget-max 0.5

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ClientMessages } from "../comptoir/client.ts";
import { blocDocument } from "../comptoir/documents.ts";
import { type Ecart, comparer, resumer } from "../comptoir/exactitude.ts";
import { Facture, extraire, schemaPour } from "../comptoir/extraction.ts";
import { PYTHON, estLance } from "../comptoir/lancement.ts";

export const DOCUMENTS = join(PYTHON, "ch07", "documents");

type Attendu = Parameters<typeof comparer>[1];

export async function mesurer(
  client: ClientMessages,
  attendus: Record<string, Attendu>,
  repetitions: number,
  budgetMax: number,
  coteMax: number | null = null,
): Promise<{ ecarts: Ecart[]; depense: number; echecs: [string, string][] }> {
  const ecarts: Ecart[] = [];
  const echecs: [string, string][] = [];
  let depense = 0;
  for (let r = 0; r < repetitions; r++) {
    for (const [nom, attendu] of Object.entries(attendus)) {
      if (depense >= budgetMax) {
        console.log(`Budget atteint (${depense.toFixed(4)} $) : arrêt.`);
        return { ecarts, depense, echecs };
      }
      const schema = schemaPour(nom);
      const resultat = await extraire(client, [await blocDocument(join(DOCUMENTS, nom), coteMax)], schema);
      depense += resultat.cout.dollars;
      if (resultat.erreur) echecs.push([nom, resultat.erreur]);
      ecarts.push(...comparer(nom, attendu, resultat.donnees as Attendu | null, schema === Facture));
    }
  }
  return { ecarts, depense, echecs };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      repetitions: { type: "string", default: "1" },
      "budget-max": { type: "string", default: "0.5" }, // en dollars
      "cote-max": { type: "string" },
    },
  });
  const attendus = JSON.parse(readFileSync(join(DOCUMENTS, "attendus.json"), "utf8")) as Record<string, Attendu>;
  const coteMax = args["cote-max"] ? Number(args["cote-max"]) : null;
  const { ecarts, depense, echecs } = await mesurer(new Anthropic(), attendus, Number(args.repetitions), Number(args["budget-max"]), coteMax);
  const r = resumer(ecarts);
  console.log(`\nChamps notés : ${r.champs}  —  exactitude : ${(r.exactitude * 100).toFixed(1)}%  —  dépense : ${depense.toFixed(4)} $`);
  console.log(`justes ${r.juste}, manquées ${r.manquée}, inventées ${r.inventée}, erronées ${r.erronée}`);
  for (const e of ecarts) {
    if (e.issue !== "juste") console.log(`  ${e.issue.padEnd(9)} ${e.document} ${e.champ} : attendu ${JSON.stringify(e.attendu)}, obtenu ${JSON.stringify(e.obtenu)}`);
  }
  for (const [nom, erreur] of echecs) console.log(`  échec     ${nom} : ${erreur}`);
}

if (estLance(import.meta.url)) await main();
