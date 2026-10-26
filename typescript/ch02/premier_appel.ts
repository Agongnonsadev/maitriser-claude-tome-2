// Chapitre 2 : le même appel avec le SDK officiel, et son coût.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch02/premier_appel.ts

import Anthropic from "@anthropic-ai/sdk";
import { cout } from "../comptoir/couts.ts";

const client = new Anthropic(); // lit ANTHROPIC_API_KEY dans l'environnement

const message = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1000,
  messages: [{ role: "user", content: "Bonjour ! Présente-toi en une phrase." }],
});

for (const bloc of message.content) {
  if (bloc.type === "text") console.log(bloc.text);
}

console.log("Identifiant de la requête :", message._request_id);
console.log("Raison de l'arrêt :", message.stop_reason);
console.log("Tokens :", message.usage.input_tokens, "en entrée,", message.usage.output_tokens, "en sortie");
console.log("Coût :", String(cout(message.model, message.usage)));
