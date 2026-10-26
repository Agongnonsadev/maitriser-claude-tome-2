// Chapitre 2 : le Comptoir en ligne de commande. Il répond à une question de client et affiche ce que
// la réponse a coûté.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch02/comptoir_cli.ts "Combien coûte le sirop de gingembre ?"

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { type ClientMessages, type MessageRecu, texteDe } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { type Cout, cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { estLance } from "../comptoir/lancement.ts";

// Version 0 du prompt système : le strict minimum. Le chapitre 5 le réécrit.
export const PROMPT_SYSTEME = `Tu es le Comptoir, l'assistant de Délices d'Awa, une entreprise de jus naturels et de sirops artisanaux à Cotonou (entreprise fictive).

Informations à jour :
- Jus de bissap, gingembre, ananas, corossol : 1 000 FCFA la bouteille de 50 cl.
- Sirops (bissap, gingembre) : 2 500 FCFA le flacon.
- Commandes par WhatsApp, de 8 h à 19 h.
- Livraison à Cotonou : le jour même pour toute commande passée avant 12 h, sinon le lendemain. Gratuite dès 5 bouteilles, 500 FCFA en dessous.
- Paiement : Mobile Money (MTN MoMo, Moov Money) ou espèces à la livraison.

Réponds en français, en trois phrases au plus. Si la réponse ne figure pas dans ces informations, dis-le et propose de transmettre la question à Awa.`;

/** Envoie la question au modèle et renvoie le texte, le coût et le message complet. */
export async function repondre(
  client: ClientMessages,
  question: string,
  modele: string = config.MODELE,
): Promise<{ texte: string; prix: Cout; message: MessageRecu }> {
  const message = await client.messages.create({
    model: modele,
    max_tokens: 1000,
    system: PROMPT_SYSTEME,
    messages: [{ role: "user", content: question }],
  });
  const prix = cout(modele, message.usage);
  noter(message._request_id, modele, prix);
  return { texte: texteDe(message), prix, message };
}

async function main(): Promise<void> {
  let question = process.argv.slice(2).join(" ");
  if (!question) {
    const clavier = createInterface({ input: process.stdin, output: process.stdout });
    question = await clavier.question("Question du client : ");
    clavier.close();
  }
  const { texte, prix, message } = await repondre(new Anthropic(), question);
  console.log(texte);
  console.log();
  console.log(`[${prix.entree} tokens en entrée, ${prix.sortie} en sortie dont ${prix.reflexion} de réflexion. Coût : ${prix}]`);
  if (message.stop_reason !== "end_turn") {
    console.log(`[Attention : réponse arrêtée pour la raison « ${message.stop_reason} »]`);
  }
}

if (estLance(import.meta.url)) await main();
