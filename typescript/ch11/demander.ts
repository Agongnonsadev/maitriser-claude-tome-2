// Chapitre 11 : poser une question aux documents d'Awa, et voir d'où vient la réponse.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch11/demander.ts "Vous livrez le dimanche ?"
//     npx tsx ch11/demander.ts --mode rag "Vous livrez à Godomey ?"

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { chargerBase } from "../comptoir/connaissances.ts";
import { repondre } from "../comptoir/documentaire.ts";
import { indexBm25 } from "./outils_communs.ts";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { mode: { type: "string", default: "contexte" } } });
const question = positionals[0];
if (!question) throw new Error("Indiquez la question.");
if (args.mode !== "contexte" && args.mode !== "rag") throw new Error("--mode : contexte ou rag.");

// contexte : toute la base, en cache ; rag : les 5 morceaux trouvés par la recherche, sans cache.
const [morceaux, cache] =
  args.mode === "contexte" ? [chargerBase(), true] : [indexBm25(false).chercher(question, 5).map(([m]) => m), false];

const reponse = await repondre(new Anthropic(), question, morceaux, { cache, mode: args.mode });
console.log(reponse.texte, "\n");
reponse.sources.forEach((source, i) => {
  const titre = reponse.citations.find((c) => c.source === source)!.titre;
  console.log(`[${i + 1}] ${titre}  (${source})`);
});
if (!reponse.sources.length) console.log("(aucune source citée)");
const c = reponse.cout;
console.log(
  `\n[${c.entree} tokens en entrée, ${c.ecritureCache} écrits en cache, ${c.lectureCache} lus dans le cache, ` +
    `${c.sortie} en sortie ; ${c} ; ${reponse.latence} s]`,
);
