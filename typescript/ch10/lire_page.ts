// Chapitre 10 : lire une page précise, en bornant ce qu'elle coûte.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch10/lire_page.ts https://fr.wikipedia.org/wiki/Bissap "Résume en trois phrases."
//     npx tsx ch10/lire_page.ts --max-tokens-lus 2000 https://fr.wikipedia.org/wiki/Bissap "…"
// La lecture de pages ne coûte que ses tokens ; --max-tokens-lus en fixe le plafond.

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { appeler, erreursOutils, lectureWeb, sources } from "../comptoir/serveur.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { "max-tokens-lus": { type: "string", default: "8000" } },
});
const [url, consigne] = positionals;
if (!url || !consigne) throw new Error("Indiquez l'adresse de la page, puis la consigne.");
const maxTokensLus = Number(args["max-tokens-lus"]);

const resultat = await appeler(new Anthropic(), {
  model: config.MODELE,
  max_tokens: 2000,
  tools: [lectureWeb(1, maxTokensLus)],
  // L'adresse doit figurer dans le message : Claude ne lit que des URL déjà apparues dans la
  // conversation, jamais une adresse qu'il aurait écrite lui-même.
  messages: [{ role: "user", content: `${consigne}\n\nPage à lire : ${url}` }],
});
console.log(resultat.texte);
for (const source of sources(resultat.message)) console.log(`  [source : ${source.titre}]`);
for (const erreur of erreursOutils(resultat.message)) console.log(`  ⚠ ${erreur}`);
const usage = resultat.message.usage;
console.log(
  `\nEntrée ${usage.input_tokens} tokens (plafond de lecture : ${maxTokensLus}), sortie ${usage.output_tokens} ; ` +
    `coût ${resultat.cout.toFixed(4)} $ (≈ ${(resultat.cout * config.TAUX_FCFA).toFixed(1)} FCFA)`,
);
