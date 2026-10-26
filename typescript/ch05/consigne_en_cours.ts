// Chapitre 5 : une consigne d'Awa ajoutée en cours de conversation, sans toucher au prompt.
//
// Le prompt système ne change pas (et son cache reste valable, chapitre 11) : la consigne arrive comme
// un message système placé juste après le message du client.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch05/consigne_en_cours.ts

import Anthropic from "@anthropic-ai/sdk";
import { repondre } from "../comptoir/assistant.ts";

const CONSIGNE =
  "Information d'Awa, valable aujourd'hui seulement : le jus de corossol est en rupture " +
  "jusqu'à demain matin. Ne le propose pas ; propose plutôt l'ananas ou le gingembre.";

const client = new Anthropic();
const question = "Bonjour, je voudrais 3 bouteilles de corossol pour ce soir.";

for (const consignes of [[], [CONSIGNE]]) {
  const { texte, prix } = await repondre(client, question, { consignes });
  console.log(consignes.length ? "Avec la consigne :" : "Sans consigne :");
  console.log(texte);
  console.log(`[${prix}]\n`);
}
