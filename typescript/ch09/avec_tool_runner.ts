// Chapitre 9 : la même boucle d'outils, confiée au Tool Runner du SDK (en bêta).
//
// betaZodTool tire le schéma de l'outil d'un schéma Zod ; le runner appelle Claude, exécute les outils,
// renvoie les résultats et recommence, jusqu'à une réponse sans appel d'outil, ou jusqu'à max_iterations.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch09/avec_tool_runner.ts

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Boutique } from "../comptoir/boutique.ts";
import { config } from "../comptoir/config.ts";
import { cout } from "../comptoir/couts.ts";
import { versJson } from "../comptoir/outils.ts";
import { charger } from "../comptoir/prompt.ts";

const boutique = new Boutique(); // en mémoire : le stock fictif du chapitre, rien n'est écrit

const stockVerifier = betaZodTool({
  name: "stock_verifier",
  description:
    "Donne la quantité disponible aujourd'hui pour des produits du catalogue de Délices d'Awa. " +
    "À utiliser quand un client demande si un produit est disponible. Les noms doivent être ceux du catalogue, " +
    "à l'identique. Ne renvoie ni prix ni délai.",
  inputSchema: z.object({ produits: z.array(z.string()).describe("Les noms exacts des produits du catalogue à vérifier.") }),
  run: ({ produits }) =>
    versJson(Object.fromEntries(produits.map((p) => [p, boutique.catalogue.has(p) ? boutique.disponible(p) : "absent du catalogue"]))),
});

const client = new Anthropic();
const runner = client.beta.messages.toolRunner({
  model: config.MODELE,
  max_tokens: 2000,
  max_iterations: 4, // une borne, comme TOURS_MAX dans la boucle écrite à la main
  system: charger("v2").texte,
  tools: [stockVerifier],
  messages: [{ role: "user", content: "Il vous reste du jus d'ananas et du jus de corossol ?" }],
});
for await (const message of runner) {
  // Un message par appel à Claude. Le coût s'affiche, mais rien ne l'enregistre : ni budget ni journal,
  // contrairement au Comptoir.
  console.log(`[${message.stop_reason}] ${JSON.stringify(message.content.map((b) => b.type))} ${cout(config.MODELE, message.usage)}`);
}
const final = await runner.done();
console.log(`\n${final.content.map((b) => (b.type === "text" ? b.text : "")).join("")}`);
