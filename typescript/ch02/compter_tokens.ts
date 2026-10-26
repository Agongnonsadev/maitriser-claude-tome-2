// Chapitre 2 : compter les tokens d'un même message dans plusieurs langues, avant de l'envoyer.
//
// Le comptage est gratuit (il a seulement sa propre limite de débit).
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch02/compter_tokens.ts
//     npx tsx ch02/compter_tokens.ts "La même phrase dans votre langue locale"

import Anthropic from "@anthropic-ai/sdk";

const MODELE = "claude-sonnet-5-5";

const phrases: Record<string, string> = {
  français:
    "Bonjour, je voudrais commander deux bouteilles de jus de bissap " +
    "et un sirop de gingembre, livrés demain matin à Cotonou.",
  anglais:
    "Hello, I would like to order two bottles of bissap juice " +
    "and one ginger syrup, delivered tomorrow morning in Cotonou.",
};
const autre = process.argv.slice(2).join(" ");
if (autre) phrases["autre langue"] = autre;

const client = new Anthropic();

for (const [langue, phrase] of Object.entries(phrases)) {
  const compte = await client.messages.countTokens({
    model: MODELE,
    messages: [{ role: "user", content: phrase }],
  });
  console.log(`${langue.padEnd(14)} ${String(phrase.length).padStart(4)} caractères   ${String(compte.input_tokens).padStart(4)} tokens`);
}
