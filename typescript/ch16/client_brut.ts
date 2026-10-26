// Chapitre 16 : parler MCP à la main, en HTTP, pour voir les messages que les SDK échangent.
//
// Lancement, depuis le dossier typescript/, après npx tsx ch16/se_connecter.ts (qui garde un jeton) :
//     npx tsx ch16/client_brut.ts http://localhost:8016/mcp                          # révision 2026-07-28
//     npx tsx ch16/client_brut.ts http://localhost:8016/mcp --revision 2025-11-25    # pour ce serveur-ci
//
// Trois requêtes JSON-RPC de la révision 2026-07-28, envoyées avec fetch et rien d'autre : server/discover,
// tools/list, tools/call. Sur cette révision, pas de poignée de main : chaque requête porte elle-même sa
// version, l'identité du client et ses capacités (dans _meta), et le serveur ne rend aucun identifiant de
// session. Une requête vaut pour elle seule. Le serveur Python du chapitre la parle ; le serveur TypeScript
// (SDK 1.32.1) s'arrête à la révision 2025-11-25 et refuse ces requêtes (400, version non prise en charge).
//
// --revision 2025-11-25 : la poignée de main (initialize) remplace server/discover ; le serveur sans état ne
// rend pas non plus d'identifiant de session, et répond aux requêtes suivantes sans s'en souvenir.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RACINE, estLance } from "../comptoir/lancement.ts";

export const VERSION = "2026-07-28";
export const JETONS = join(RACINE, "donnees_clients", "jetons_client.json");
const CLIENT = { name: "client-brut-de-yao", version: "0.1" };

export function message(identifiant: number, methode: string, params: Record<string, unknown> = {}, revision = VERSION): Record<string, unknown> {
  if (revision !== VERSION) return { jsonrpc: "2.0", id: identifiant, method: methode, params };
  const meta = { "io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientInfo": CLIENT, "io.modelcontextprotocol/clientCapabilities": {} };
  return { jsonrpc: "2.0", id: identifiant, method: methode, params: { ...params, _meta: meta } };
}

export function entetes(jeton: string, methode: string, nom?: string, revision = VERSION): Record<string, string> {
  const e: Record<string, string> = {
    Authorization: `Bearer ${jeton}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": revision,
  };
  if (revision !== VERSION) return e;
  e["Mcp-Method"] = methode;
  if (nom) e["Mcp-Name"] = nom; // exigé pour tools/call, resources/read et prompts/get
  return e;
}

/** Une réponse JSON, ou un flux d'événements (SSE) dont on garde le message final. */
export function lireReponse(typeDeContenu: string, texte: string): unknown {
  if (typeDeContenu.startsWith("text/event-stream")) {
    const donnees = texte.split(/\r\n|\r|\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(donnees.at(-1)!);
  }
  return JSON.parse(texte);
}

const apercu = (valeur: unknown, longueur: number): string => [...JSON.stringify(valeur)].slice(0, longueur).join("");

async function envoyer(adresse: string, jeton: string, identifiant: number, methode: string, params?: Record<string, unknown>, nom?: string, revision = VERSION): Promise<unknown> {
  const corps = message(identifiant, methode, params, revision);
  console.log(`\n→ POST ${adresse}   ` + (revision === VERSION ? `Mcp-Method: ${methode}` + (nom ? `   Mcp-Name: ${nom}` : "") : methode));
  console.log("  " + apercu(corps, 400));
  const reponse = await fetch(adresse, { method: "POST", headers: entetes(jeton, methode, nom, revision), body: JSON.stringify(corps), signal: AbortSignal.timeout(30_000) });
  const type = reponse.headers.get("content-type") ?? "";
  console.log(`← ${reponse.status} ${type || "None"}   session : ${reponse.headers.get("mcp-session-id") ?? "aucune"}`);
  const resultat = lireReponse(type, await reponse.text());
  console.log("  " + apercu(resultat, 600));
  return resultat;
}

function arreter(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { revision: { type: "string", default: VERSION } } });
  const adresse = positionals[0];
  if (positionals.length !== 1 || !adresse) arreter("Usage : npx tsx ch16/client_brut.ts <adresse>/mcp [--revision 2025-11-25]");
  if (![VERSION, "2025-11-25"].includes(args.revision)) arreter(`--revision : ${VERSION} ou 2025-11-25`);
  if (!existsSync(JETONS)) arreter("Pas de jeton : lancez d'abord npx tsx ch16/se_connecter.ts.");
  const jeton = (JSON.parse(readFileSync(JETONS, "utf8")) as { jetons: { access_token: string } }).jetons.access_token; // jamais affiché
  const r = args.revision;
  if (r === VERSION) await envoyer(adresse, jeton, 1, "server/discover");
  else await envoyer(adresse, jeton, 1, "initialize", { protocolVersion: r, capabilities: {}, clientInfo: CLIENT }, undefined, r);
  await envoyer(adresse, jeton, 2, "tools/list", undefined, undefined, r);
  await envoyer(adresse, jeton, 3, "tools/call", { name: "stock", arguments: {} }, "stock", r);
  console.log("\nSans jeton :");
  const sansJeton = Object.fromEntries(Object.entries(entetes("", "tools/list", undefined, r)).filter(([k]) => k !== "Authorization"));
  const reponse = await fetch(adresse, { method: "POST", headers: sansJeton, body: JSON.stringify(message(4, "tools/list", undefined, r)) });
  console.log(`← ${reponse.status}   WWW-Authenticate: ${reponse.headers.get("www-authenticate")}`);
}

if (estLance(import.meta.url)) await main();
