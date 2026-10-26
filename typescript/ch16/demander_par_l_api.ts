// Chapitre 16 : interroger le Comptoir en ligne depuis l'API, par le connecteur MCP, avec un jeton OAuth.
//
// Lancement, depuis le dossier typescript/ (APPEL PAYANT), après npx tsx ch16/se_connecter.ts sur la même
// adresse publique (qui garde le jeton dans donnees_clients/jetons_client.json) :
//     npx tsx ch16/demander_par_l_api.ts https://<adresse-publique>/mcp
//
// Le connecteur MCP ne joint qu'un serveur public, en https://. C'est à votre application d'obtenir le jeton
// OAuth et de le renouveler : l'API se contente de le présenter au serveur (authorization_token). Ici, une
// liste noire : tous les outils du serveur, sauf les deux qui touchent au stock. L'assistant qui en résulte ne
// peut que lire.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { trace } from "../ch14/demander_a_la_doc.ts";
import { creerClient } from "../comptoir/appel.ts";
import { fixe } from "../comptoir/arrondi.ts";
import { config } from "../comptoir/config.ts";
import { cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { RACINE, estLance } from "../comptoir/lancement.ts";

export const JETONS = join(RACINE, "donnees_clients", "jetons_client.json");
export const QUESTION =
  "Combien de commandes avons-nous eues le samedi 17 octobre 2026, pour quel total, et quels produits " +
  "sont en rupture de stock ?";

export function requete(adresse: string, jeton: string): Record<string, unknown> & { model: string } {
  return {
    model: config.MODELE_DOCUMENTS,
    max_tokens: 800,
    system: "Tu réponds à Awa, en français, en la vouvoyant, en deux phrases, avec les chiffres exacts des outils.",
    messages: [{ role: "user", content: QUESTION }],
    mcp_servers: [{ type: "url", url: adresse, name: "comptoir", authorization_token: jeton }],
    tools: [
      {
        type: "mcp_toolset",
        mcp_server_name: "comptoir",
        // Liste noire : tout est permis, sauf ce qui écrit.
        configs: { preparer_correction: { enabled: false }, appliquer_correction: { enabled: false } },
      },
    ],
    betas: ["mcp-client-2025-11-20"],
  };
}

function arreter(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const adresse = positionals[0];
  if (positionals.length !== 1 || !adresse) arreter("Usage : npx tsx ch16/demander_par_l_api.ts https://<adresse-publique>/mcp");
  if (!adresse.startsWith("https://")) arreter("Le connecteur MCP n'accepte qu'une adresse en https://.");
  if (!existsSync(JETONS)) arreter("Pas de jeton : lancez d'abord npx tsx ch16/se_connecter.ts.");
  const jeton = (JSON.parse(readFileSync(JETONS, "utf8")) as { jetons: { access_token: string } }).jetons.access_token; // jamais affiché
  const params = requete(adresse, jeton);
  const message = await creerClient().beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
  const prix = cout(params.model, message.usage);
  noter((message as { _request_id?: string | null })._request_id, params.model, prix, { client: "ch16-api", stop_reason: message.stop_reason, origine: "connecteur-mcp-oauth" });
  for (const ligne of trace(message.content)) console.log(ligne);
  const texte = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const juste = texte.includes("6 commandes") && texte.includes("50") && texte.includes("500") && texte.toLowerCase().includes("corossol");
  console.log(`\n${texte}\n\n${juste ? "Juste" : "À VÉRIFIER"} ; arrêt : ${message.stop_reason} ; ${message.usage.input_tokens} tokens d'entrée ; coût : ${fixe(prix.dollars, 4)} $`);
}

if (estLance(import.meta.url)) await main();
