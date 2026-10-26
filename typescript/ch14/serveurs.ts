// Chapitre 14 : les serveurs MCP du chapitre, au même endroit, chacun à une version figée.
//
// Les deux serveurs locaux sont ceux de la version Python, installés une fois dans python/ch14/mcp/
// (npm ci), et non téléchargés par npx à chaque lancement : package-lock.json fige le paquet et tout son
// arbre de dépendances, et les signatures se vérifient avec npm audit signatures. Ils se lancent depuis le
// dossier python/, comme le fait Claude Code avec python/.mcp.json : les chemins sont relatifs à ce dossier.
//
// Le client MCP est celui du SDK officiel (@modelcontextprotocol/sdk). Il ne dit pas quelle version du
// protocole a été négociée : il la confie au transport, et connecter() la note au passage.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "../comptoir/lancement.ts";

export const RACINE = PYTHON; // le dossier d'où les serveurs se lancent
export const MODULES = join(RACINE, "ch14", "mcp", "node_modules");

// Les points d'entrée, en chemins relatifs au dossier python/ : c'est de là que Claude Code et les
// scripts lancent les serveurs.
export const DBHUB = "ch14/mcp/node_modules/@bytebase/dbhub/dist/index.js";
export const EVERYTHING = "ch14/mcp/node_modules/@modelcontextprotocol/server-everything/dist/index.js";
export const DOC_CLAUDE = "https://platform.claude.com/docs/mcp"; // serveur de la documentation d'Anthropic

// DBHub sur la copie d'exploration, en lecture seule (voir python/ch14/dbhub.toml).
export const ARGUMENTS_DBHUB = [DBHUB, "--transport", "stdio", "--config", "ch14/dbhub.toml"];

export interface ParametresStdio {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export const versionInstallee = (paquet: string): string =>
  (JSON.parse(readFileSync(join(MODULES, paquet, "package.json"), "utf8")) as { version: string }).version;

/** Le serveur des commandes d'Awa : un programme local, lancé par le client, qui parle par stdio. */
export const commandes = (): ParametresStdio => ({ command: "node", args: ARGUMENTS_DBHUB, cwd: RACINE, env: { CLAUDE_PROJECT_DIR: RACINE } });

/**
 * Le serveur de démonstration du projet MCP : des outils, des ressources et des prompts d'exemple. La
 * 2.0.0 (19 octobre 2026) demande Node 24 ; la 1.0.0 tourne sur Node 22.
 */
export const everything = (): ParametresStdio => ({ command: "node", args: [EVERYTHING, "stdio"], cwd: RACINE });

export const SERVEURS: Record<string, () => ParametresStdio | string> = { commandes, everything, doc: () => DOC_CLAUDE };

export interface Connexion {
  client: Client;
  protocole: string | null; // la version du protocole négociée
}

/**
 * Un client MCP connecté à un serveur : lancé par stdio (ses variables s'ajoutent à l'environnement par
 * défaut du SDK, comme en Python), ou joint en HTTP à son adresse. À fermer par client.close().
 */
export async function connecter(serveur: ParametresStdio | string, nom = "comptoir"): Promise<Connexion> {
  const transport: Transport =
    typeof serveur === "string" ? new StreamableHTTPClientTransport(new URL(serveur)) : new StdioClientTransport(serveur);
  const connexion: Connexion = { client: new Client({ name: nom, version: "1.0.0" }), protocole: null };
  const transmettre = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    connexion.protocole = version;
    transmettre?.(version);
  };
  await connexion.client.connect(transport);
  return connexion;
}
