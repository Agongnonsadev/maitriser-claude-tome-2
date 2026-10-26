// Chapitre 13 : le même agent, construit avec le Claude Agent SDK, le moteur de Claude Code en bibliothèque.
//
// - les outils de l'atelier, les mêmes fonctions qu'avec le Tool Runner, deviennent un serveur MCP qui tourne
//   dans ce processus ;
// - aucun outil intégré de Claude Code, sauf Agent, qui confie une tâche à un sous-agent ;
// - un sous-agent « lecteur », sur Claude Haiku 5.5, est le seul à pouvoir lire les messages des
//   fournisseurs : un hook PreToolUse le vérifie à chaque appel, par le code ;
// - un hook PostToolUse note chaque action dans le journal ;
// - aucun réglage de l'utilisateur n'est chargé (settingSources: []), la configuration de Claude Code est
//   neuve (CLAUDE_CONFIG_DIR), et l'agent travaille dans un dossier vide.
//
// Le SDK TypeScript (@anthropic-ai/claude-agent-sdk) décrit les outils par un schéma Zod : il est tiré
// du même schéma JSON que celui du Tool Runner (z.fromJSONSchema). Son option env remplace l'environnement
// du sous-processus, quand celle du SDK Python s'y ajoute : on y recopie donc process.env, sans CLAUDECODE,
// comme le fait le SDK Python.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch13/avec_agent_sdk.ts --budget-max 0.60

import {
  type HookCallback,
  type Options,
  type SDKResultMessage,
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { CONSIGNE, Contexte, Garde, LECTEUR, type Outil, SYSTEME, creerOutils, reglages } from "../comptoir/agent_reappro.ts";
import { fixe } from "../comptoir/arrondi.ts";
import { Atelier, rendreBon } from "../comptoir/atelier.ts";
import { config } from "../comptoir/config.ts";
import { noterEvenement } from "../comptoir/journal.ts";
import { estLance } from "../comptoir/lancement.ts";
import { repr } from "../comptoir/python.ts";
import { Trace } from "../comptoir/trace.ts";
import { sansReferences } from "./avec_managed_agents.ts";
import { criteres } from "./criteres.ts";

export const SERVEUR = "atelier";
export const LECTURE = `mcp__${SERVEUR}__lire_messages_fournisseurs`;

/** Les outils du Tool Runner, enveloppés pour le SDK : même nom, même description, même schéma. */
export async function serveurDeLAtelier(ctx: Contexte) {
  const outils = (await creerOutils(ctx, reglages({ sousAgent: false }))).map((outil) => {
    // Lecture directe : c'est le sous-agent qui lit.
    const o = outil as Outil & { description: string; input_schema: Record<string, unknown> };
    const forme = (z.fromJSONSchema(sansReferences(o.input_schema)) as z.ZodObject).shape;
    return tool(o.name, o.description, forme, async (args) => {
      try {
        return { content: [{ type: "text" as const, text: String(await o.run(args)) }] };
      } catch (erreur) {
        if (!(erreur instanceof ToolError)) throw erreur;
        return { content: [{ type: "text" as const, text: String(erreur.content) }], isError: true };
      }
    });
  });
  return createSdkMcpServer({ name: SERVEUR, version: "1.0.0", tools: outils });
}

/** PreToolUse : la règle est dans le code, pas dans le prompt. Les sous-agents ont un agent_id. */
export const garder: HookCallback = async (entree) => {
  const { tool_name: nom, agent_id: agent } = entree as { tool_name: string; agent_id?: string };
  let refus: string | null = null;
  if (nom !== "Agent" && !nom.startsWith(`mcp__${SERVEUR}__`)) refus = "seuls les outils de l'atelier sont permis";
  else if (nom === LECTURE && !agent) refus = "la lecture des messages est réservée au sous-agent lecteur : confie-lui ta question";
  if (refus) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refus } };
  return {};
};

/** PostToolUse : le journal des actions, sans les données (seulement qui a fait quoi). */
export const noterAction: HookCallback = async (entree) => {
  const { tool_name: outil, agent_type: type } = entree as { tool_name: string; agent_type?: string };
  noterEvenement("action", { outil, par: type || "agent principal" });
  return {};
};

/** L'environnement du SDK Python : celui du processus, sans CLAUDECODE, avec les variables données. */
function environnement(ajouts: Record<string, string>): Record<string, string> {
  const herite = Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "CLAUDECODE" && e[1] !== undefined);
  return { ...Object.fromEntries(herite), ...ajouts };
}

export async function options(ctx: Contexte, budgetMax: number, dossier: string): Promise<Options> {
  const outilsAtelier = ["lire_ventes", "lire_stock", "lire_evenements", "lire_fournisseurs", "calculer_besoins", "lire_messages_fournisseurs", "proposer_bon_de_commande"].map(
    (nom) => `mcp__${SERVEUR}__${nom}`,
  );
  return {
    model: config.MODELE,
    systemPrompt: SYSTEME + "\n\nPour connaître les messages des fournisseurs, confie ta question au sous-agent « lecteur », avec l'outil Agent.",
    mcpServers: { [SERVEUR]: await serveurDeLAtelier(ctx) },
    tools: ["Agent"], //                  aucun outil intégré, sauf la délégation à un sous-agent
    allowedTools: ["Agent", ...outilsAtelier],
    permissionMode: "dontAsk", //         ce qui n'est pas permis est refusé, sans question
    agents: {
      lecteur: {
        description: "Lit les messages WhatsApp des fournisseurs et répond à une question précise, en citant les dates et les fournisseurs.",
        prompt: LECTEUR + "\n\nLis les messages avec l'outil lire_messages_fournisseurs.",
        tools: [LECTURE],
        model: config.MODELE_AUXILIAIRE,
      },
    },
    hooks: { PreToolUse: [{ hooks: [garder] }], PostToolUse: [{ hooks: [noterAction] }] },
    maxTurns: 20,
    maxBudgetUsd: budgetMax, //           une estimation côté client, qui peut être un peu dépassée
    settingSources: [], //                ni vos réglages, ni votre CLAUDE.md, ni vos Skills
    cwd: dossier,
    env: environnement({ CLAUDE_CONFIG_DIR: join(dossier, ".config") }),
  };
}

export async function lancerAvecLeSdk(budgetMax: number): Promise<[SDKResultMessage | null, Contexte, string[]]> {
  const ctx = new Contexte(null, new Atelier(), new Garde(), new Trace());
  const appels: string[] = [];
  const dossier = mkdtempSync(join(tmpdir(), "agent-sdk-"));
  try {
    let resultat: SDKResultMessage | null = null;
    for await (const message of query({ prompt: CONSIGNE, options: await options(ctx, budgetMax, dossier) })) {
      if (message.type === "assistant") appels.push(...message.message.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name));
      else if (message.type === "result") resultat = message;
    }
    return [resultat, ctx, appels];
  } finally {
    rmSync(dossier, { recursive: true, force: true }); // le dossier de travail, et la configuration neuve qu'il contient
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { "budget-max": { type: "string", default: "0.60" } } });
  const debut = performance.now();
  const [resultat, ctx, appels] = await lancerAvecLeSdk(Number(args["budget-max"]));
  console.log(`Appels d'outils de l'agent principal : ${repr(appels)}`);
  console.log(ctx.trace.afficher());
  if (resultat) {
    console.log(`\nFin : ${resultat.subtype} ; ${resultat.num_turns} tours ; ${resultat.total_cost_usd} $ (estimation du SDK) ; ${fixe(resultat.duration_ms / 1000, 1)} s`);
    console.log(`Coût par modèle : ${repr(resultat.modelUsage ?? null)}`);
    console.log("\nRésumé de l'agent :\n" + (resultat.subtype === "success" ? resultat.result : ""));
  }
  console.log(`\nDurée totale : ${fixe((performance.now() - debut) / 1000, 1)} s`);
  console.log("\n" + (ctx.bon ? rendreBon(ctx.bon) : "Aucun bon proposé."));
  console.log("\nCritères : " + Object.entries(criteres(ctx.bon)).map(([k, v]) => `${k} ${v ? "oui" : "NON"}`).join(", "));
}

if (estLance(import.meta.url)) await main();
