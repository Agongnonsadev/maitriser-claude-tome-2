// Chapitre 10 : une question d'actualité, avec la recherche web et ses sources.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch10/veille.ts "Quels sont les jours fériés au Bénin en novembre et décembre 2026 ?"
//     npx tsx ch10/veille.ts --filtrage "…"          (filtrage dynamique des résultats)
// Coût : 10 $ les 1 000 recherches (au plus --max-recherches), plus les tokens des résultats.

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { appeler, erreursOutils, rechercheWeb, sources } from "../comptoir/serveur.ts";

const SYSTEME =
  "Tu aides Yao, de Délices d'Awa, à Cotonou, à préparer son planning. Réponds en français, brièvement, " +
  "et appuie chaque information sur une source trouvée. Si les sources se contredisent ou manquent, dis-le.";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-recherches": { type: "string", default: "3" },
    filtrage: { type: "boolean", default: false }, // filtrage dynamique (web_search_20260209)
  },
});
const question = positionals[0];
if (!question) throw new Error("Indiquez la question.");

const resultat = await appeler(new Anthropic(), {
  model: config.MODELE,
  max_tokens: 3000,
  system: SYSTEME,
  tools: [rechercheWeb(Number(args["max-recherches"]), null, args.filtrage)],
  messages: [{ role: "user", content: question }],
});
console.log(resultat.texte);
console.log("\nSources :");
for (const source of sources(resultat.message)) console.log(`  - ${source.titre} — ${source.source}`);
for (const erreur of erreursOutils(resultat.message)) console.log(`  ⚠ ${erreur}`);
const usage = resultat.message.usage;
console.log(
  `\n${resultat.recherches} recherche(s), ${resultat.appels} appel(s), ${resultat.reprises} reprise(s) ; ` +
    `entrée ${usage.input_tokens} tokens, sortie ${usage.output_tokens} ; ` +
    `coût ${resultat.cout.toFixed(4)} $ (≈ ${(resultat.cout * config.TAUX_FCFA).toFixed(0)} FCFA)`,
);
