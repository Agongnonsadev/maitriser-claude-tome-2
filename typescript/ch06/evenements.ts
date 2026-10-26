// Chapitre 6 : les événements d'un flux, un par un, avec le temps de leur arrivée.
//
// Montre ce que le SDK reçoit de l'API : message_start, puis pour chaque bloc content_block_start, des
// content_block_delta et content_block_stop, puis message_delta (raison de l'arrêt, usage cumulé) et
// message_stop. Les événements ping, eux, sont absorbés par le SDK : vous ne les verrez pas ici.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch06/evenements.ts "Quels jus avez-vous ?"

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { construireRequete } from "../comptoir/assistant.ts";
import { cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { charger } from "../comptoir/prompt.ts";

const question = process.argv.slice(2).join(" ") || "Quels jus avez-vous, et à quel prix ?";
const client = new Anthropic();
const prompt = charger();
const requete = construireRequete(question, { prompt });
const depart = performance.now();
let premierTexte: number | null = null;
const ms = () => (performance.now() - depart).toFixed(0).padStart(7);

const flux = client.messages.stream(requete);
for await (const evenement of flux) {
  // Le SDK ne rend ici que les événements bruts de l'API ; ses propres événements (text…) passent par flux.on().
  if (evenement.type === "content_block_start") {
    console.log(`${ms()} ms  content_block_start  (bloc ${evenement.index} : ${evenement.content_block.type})`);
  } else if (evenement.type === "content_block_delta") {
    if (evenement.delta.type === "text_delta") {
      premierTexte ??= performance.now() - depart;
      console.log(`${ms()} ms  content_block_delta  ${JSON.stringify(evenement.delta.text)}`);
    } else {
      console.log(`${ms()} ms  content_block_delta  (${evenement.delta.type})`);
    }
  } else if (evenement.type === "message_delta") {
    console.log(`${ms()} ms  message_delta        stop_reason=${evenement.delta.stop_reason}`);
  } else {
    console.log(`${ms()} ms  ${evenement.type}`);
  }
}
const message = await flux.finalMessage();

const total = performance.now() - depart;
const prix = cout(requete.model, message.usage);
noter(flux.request_id, requete.model, prix, { prompt: prompt.identifiant });
console.log(`\nPremier texte après ${(premierTexte ?? 0).toFixed(0)} ms ; réponse complète après ${total.toFixed(0)} ms.`);
console.log(`Blocs du message final : ${JSON.stringify(message.content.map((b) => b.type))}`);
console.log(`Coût : ${prix}`);
