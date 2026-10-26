// Chapitre 15 : fabrique l'extension de bureau « Comptoir pour Awa » (.mcpb) à partir du serveur.
//
// Lancement, depuis le dossier typescript/ (gratuit) :
//     npx tsx ch15/construire_extension.ts            # prépare ch15/build/comptoir-pour-awa/
//     npx tsx ch15/construire_extension.ts --paquet   # puis le valide et l'empaquette avec mcpb
//
// Le manifeste est écrit par le code, à partir du serveur lui-même : la liste des outils et des prompts qu'il
// annonce ne peut pas diverger de ce que le serveur expose. Le paquet est de type « node » : l'application
// Claude lance le serveur avec le Node qu'elle embarque (documentation de mcpb). esbuild en fait un seul
// fichier, SDK MCP et Zod compris : rien d'autre à installer. Le serveur lit la base avec node:sqlite, qui
// demande Node 22.13 ou plus récent : le manifeste le déclare. Il faut, pour --paquet, les outils de la
// version Python, python/ch15/outils (npm ci) : le CLI mcpb y est à une version figée.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { jsonPython, separerMots } from "../comptoir/python.ts";
import { VERSION, creerServeur } from "./comptoir_pour_awa.ts";

export const NOM = "comptoir-pour-awa";
export const BUILD = join(RACINE, "ch15", "build");
export const DOSSIER = join(BUILD, NOM);
export const MCPB = join(PYTHON, "ch15", "outils", "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
export const NODE_MINIMUM = ">=22.13.0"; // node:sqlite sans option

export const REGLAGES = {
  base_boutique: {
    type: "file",
    title: "Base de la boutique",
    description:
      "Le fichier de la boutique que Yao vous a donné (boutique.sqlite3). Il reste sur votre ordinateur : l'extension le lit, et n'y change que le stock, après votre accord.",
    required: true,
  },
};

const premierePhrase = (texte: string | undefined): string => `${separerMots(texte ?? "").join(" ").split(". ")[0]!.replace(/\.+$/, "")}.`;

export interface OutilAnnonce {
  name: string;
  description: string;
}
export interface PromptAnnonce extends OutilAnnonce {
  arguments: string[];
  text: string;
}

/** Les outils et les prompts tels que le serveur les annonce, lus par un client MCP en mémoire. */
export async function inventaire(): Promise<[OutilAnnonce[], PromptAnnonce[]]> {
  const [cote, autre] = InMemoryTransport.createLinkedPair();
  await creerServeur().connect(cote);
  const client = new Client({ name: "construire-extension", version: "1.0.0" });
  await client.connect(autre);
  try {
    const outils = (await client.listTools()).tools.map((t) => ({ name: t.name, description: premierePhrase(t.description) }));
    const prompts: PromptAnnonce[] = [];
    for (const p of (await client.listPrompts()).prompts) {
      const args = (p.arguments ?? []).map((a) => a.name);
      const rendu = await client.getPrompt({ name: p.name, arguments: Object.fromEntries(args.map((a) => [a, `\${arguments.${a}}`])) });
      const contenu = rendu.messages[0]!.content as { text: string };
      prompts.push({ name: p.name, description: premierePhrase(p.description), arguments: args, text: contenu.text });
    }
    return [outils, prompts];
  } finally {
    await client.close();
  }
}

export function manifeste(outils: OutilAnnonce[], prompts: PromptAnnonce[]): Record<string, unknown> {
  return {
    manifest_version: "0.4",
    name: NOM,
    display_name: "Comptoir pour Awa",
    version: VERSION,
    description: "Vos commandes, votre stock et vos ventes de la semaine, dans Claude.",
    long_description:
      "Comptoir pour Awa relie Claude à la boutique de Délices d'Awa. Demandez vos commandes du jour, " +
      "votre stock ou vos ventes de la semaine. Après un inventaire, Claude peut corriger le stock, " +
      "mais seulement après vous avoir montré l'écart et obtenu votre accord. Aucune autre donnée n'est " +
      "modifiée. Exemple du livre « Développer avec Claude » (Botlyx Academy) : entreprise et personnes " +
      "fictives.",
    author: { name: "Botlyx Academy", url: "https://academy.botlyx.com" },
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.mjs"],
        env: { COMPTOIR_BOUTIQUE: "${user_config.base_boutique}" },
      },
    },
    tools: outils,
    prompts,
    user_config: REGLAGES,
    keywords: ["commandes", "stock", "ventes", "botlyx"],
    license: "MIT",
    compatibility: { platforms: ["darwin", "win32"], runtimes: { node: NODE_MINIMUM } },
  };
}

/** Une icône simple : un disque couleur bissap, avec un « A » blanc. 512 × 512, fond transparent. */
export async function icone(chemin: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <circle cx="256" cy="256" r="240" fill="rgb(150,20,60)"/>
  <text x="256" y="268" font-family="Arial, Helvetica, sans-serif" font-size="300" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">A</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(chemin);
}

export async function preparer(): Promise<string> {
  if (existsSync(DOSSIER)) rmSync(DOSSIER, { recursive: true, force: true });
  mkdirSync(join(DOSSIER, "server"), { recursive: true });
  // Un seul fichier, SDK MCP et Zod compris. Le require des bibliothèques CommonJS passe par createRequire.
  await build({
    entryPoints: [join(RACINE, "ch15", "comptoir_pour_awa.ts")],
    outfile: join(DOSSIER, "server", "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  copyFileSync(join(PYTHON, "comptoir", "donnees", "delices_awa.json"), join(DOSSIER, "server", "catalogue.json"));
  const [outils, prompts] = await inventaire();
  writeFileSync(join(DOSSIER, "manifest.json"), jsonPython(manifeste(outils, prompts), 2) + "\n", "utf8");
  await icone(join(DOSSIER, "icon.png"));
  return DOSSIER;
}

export function empaqueter(): string {
  if (!existsSync(MCPB)) throw new Error(`Le CLI mcpb est introuvable : ${MCPB}. Installez-le : npm ci dans python/ch15/outils.`);
  const lancer = (args: string[]): void => {
    const sortie = spawnSync(process.execPath, [MCPB, ...args], { stdio: "inherit" });
    if (sortie.status !== 0) throw new Error(`mcpb ${args[0]} a échoué (code ${sortie.status}).`);
  };
  lancer(["validate", join(DOSSIER, "manifest.json")]);
  const paquet = join(BUILD, `${NOM}-${VERSION}.mcpb`);
  lancer(["pack", DOSSIER, paquet]);
  return paquet;
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { paquet: { type: "boolean", default: false } } }); // valider et empaqueter avec mcpb
  const dossier = await preparer();
  console.log(`Extension préparée : ${relative(RACINE, dossier)}`);
  if (args.paquet) console.log(`Paquet : ${relative(RACINE, empaqueter())}`);
}

if (estLance(import.meta.url)) await main();
