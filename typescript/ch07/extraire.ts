// Chapitre 7 : extraire les données d'un bon de commande (photo) ou d'une facture (PDF).
//
// Les documents d'exemple sont ceux de la version Python (python/ch07/documents/), fabriqués une fois
// par python/ch07/fabriquer_exemples.py.
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch07/extraire.ts ../python/ch07/documents/bon-01.jpg
//     npx tsx ch07/extraire.ts ../python/ch07/documents/bon-01.jpg --cote-max 1000
//     npx tsx ch07/extraire.ts ../python/ch07/documents/facture-01.pdf --estimer      (gratuit : compte les tokens)

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { blocDocument } from "../comptoir/documents.ts";
import { BonDeCommande, type Facture, controlerBon, controlerFacture, extraire, requeteExtraction, schemaPour } from "../comptoir/extraction.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "cote-max": { type: "string" }, // réduire l'image avant l'envoi (en pixels)
    estimer: { type: "boolean", default: false }, // compter les tokens d'entrée, sans extraire
  },
});
const document = positionals[0];
if (!document) throw new Error("Indiquez le document à lire.");

const client = new Anthropic();
const schema = schemaPour(document);
const blocs = [await blocDocument(document, args["cote-max"] ? Number(args["cote-max"]) : null)];

if (args.estimer) {
  const { model, system, messages, output_config } = requeteExtraction(blocs, schema);
  const compte = await client.messages.countTokens({ model, system, messages, output_config });
  console.log(`Tokens d'entrée : ${compte.input_tokens}`);
} else {
  const resultat = await extraire(client, blocs, schema);
  console.log(`Coût : ${resultat.cout}  (requête ${resultat.identifiant})`);
  if (resultat.erreur || !resultat.donnees) {
    console.log(`Échec : ${resultat.erreur}`);
  } else {
    console.log(JSON.stringify(resultat.donnees, null, 2));
    const controle =
      schema === BonDeCommande ? controlerBon(resultat.donnees as BonDeCommande) : controlerFacture(resultat.donnees as Facture);
    console.log(`\nMontant calculé par le code : ${controle.montantCalcule}`);
    for (const anomalie of controle.anomalies) console.log(`  ⚠ ${anomalie}`);
    console.log(controle.aRelire ? "À relire par un humain." : "Aucune anomalie : à valider par un humain.");
  }
}
