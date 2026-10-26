// Chapitre 7 : répondre à une question sur les conditions d'un fournisseur, en citant le passage.
//
// Avec --files-api, le PDF est envoyé une fois à la Files API, désigné ensuite par son identifiant,
// puis supprimé à la fin.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch07/citer_conditions.ts "Sous quel délai dois-je signaler une casse ?"
//     npx tsx ch07/citer_conditions.ts --files-api "Quel est le minimum de commande ?" "Et le délai de paiement ?"

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { cout } from "../comptoir/couts.ts";
import { blocFichier, blocPdf } from "../comptoir/documents.ts";
import { noter } from "../comptoir/journal.ts";
import { PYTHON } from "../comptoir/lancement.ts";

const PDF = join(PYTHON, "ch07", "documents", "conditions-fournisseur.pdf");
const SYSTEME =
  "Tu réponds aux questions de Yao, de Délices d'Awa, sur les conditions de ses fournisseurs. " +
  "Tu réponds uniquement d'après le document fourni ; s'il ne contient pas la réponse, dis-le.";

async function demander(client: Anthropic, document: Anthropic.ContentBlockParam, question: string): Promise<void> {
  const requete: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODELE,
    max_tokens: 1500,
    system: SYSTEME,
    messages: [{ role: "user", content: [document, { type: "text", text: question }] }],
  };
  // Jamais de format : incompatible avec les citations.
  if (config.EFFORT) requete.output_config = { effort: config.EFFORT as NonNullable<Anthropic.OutputConfig["effort"]> };
  const message = await client.messages.create(requete);
  const prix = cout(requete.model, message.usage);
  noter(message._request_id, requete.model, prix);
  let sortie = `\n${question}\n`;
  for (const bloc of message.content) {
    if (bloc.type !== "text") continue;
    sortie += bloc.text;
    for (const citation of bloc.citations ?? []) {
      if (citation.type === "page_location") sortie += ` [p. ${citation.start_page_number} : « ${citation.cited_text.trim()} »]`;
    }
  }
  console.log(`${sortie}\n(${prix})`);
}

const { values: args, positionals: questions } = parseArgs({ allowPositionals: true, options: { "files-api": { type: "boolean", default: false } } });
if (!questions.length) throw new Error("Posez au moins une question.");
const client = new Anthropic();

if (!args["files-api"]) {
  const document = blocPdf(PDF, "Conditions de vente du fournisseur", true);
  for (const question of questions) await demander(client, document, question);
} else {
  const fichier = await client.files.upload({ file: await toFile(readFileSync(PDF), basename(PDF), { type: "application/pdf" }) });
  console.log(`Fichier envoyé : ${fichier.id}`);
  try {
    const document = blocFichier(fichier.id, "document", true);
    for (const question of questions) await demander(client, document, question);
  } finally {
    await client.files.delete(fichier.id); // un fichier envoyé reste stocké tant qu'on ne le supprime pas
    console.log("Fichier supprimé.");
  }
}
