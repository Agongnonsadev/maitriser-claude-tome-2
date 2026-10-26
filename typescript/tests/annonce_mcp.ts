// Ce qu'un serveur MCP annonce (nom, instructions, outils, ressources, prompts), lu par un client de chaque
// SDK, sous une même forme : pour comparer les serveurs des chapitres 15 et 16 à ceux de la version Python.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execFileSync } from "node:child_process";
import { sansReferences } from "../ch13/avec_managed_agents.ts";
import { PYTHON } from "../comptoir/lancement.ts";

/**
 * Un schéma tel que le SDK TypeScript le publie, ramené à celui de pydantic : sans « $schema », sans les
 * « additionalProperties: {} » (tout permis, comme sans rien), sans les « properties: {} » qu'il ajoute à une
 * table (un objet aux clés libres), sans les bornes des entiers ni le motif que Zod ajoute aux dates ; les
 * références de pydantic, développées.
 */
export function commePython(noeud: unknown): unknown {
  if (Array.isArray(noeud)) return noeud.map(commePython);
  if (noeud === null || typeof noeud !== "object") return noeud;
  const o = { ...(noeud as Record<string, unknown>) };
  delete o.$schema;
  const vide = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length;
  if (vide(o.properties) && typeof o.additionalProperties === "object" && !vide(o.additionalProperties)) delete o.properties;
  if (vide(o.additionalProperties)) delete o.additionalProperties;
  if (o.type === "integer" && o.minimum === Number.MIN_SAFE_INTEGER && o.maximum === Number.MAX_SAFE_INTEGER) {
    delete o.minimum;
    delete o.maximum;
  }
  if (o.format === "date") delete o.pattern;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, commePython(v)]));
}

/**
 * L'annonce lue par le client TypeScript. Le SDK TypeScript annonce en plus, pour chaque outil,
 * execution.taskSupport (« forbidden ») : la version Python ne le dit pas, ce qui revient au même pour le
 * client. JSON.stringify retire les champs undefined.
 */
export async function annonceTypeScript(c: Client): Promise<unknown> {
  return JSON.parse(
    JSON.stringify({
      serveur: c.getServerVersion(),
      instructions: c.getInstructions(),
      outils: (await c.listTools()).tools.map(({ execution: _, ...t }) => ({ ...t, inputSchema: commePython(t.inputSchema), outputSchema: commePython(t.outputSchema) })),
      ressources: (await c.listResources()).resources,
      modeles: (await c.listResourceTemplates()).resourceTemplates,
      prompts: (await c.listPrompts()).prompts.map((p) => ({ ...p, arguments: p.arguments ?? [] })),
    }),
  );
}

/** L'annonce lue par le client du SDK Python, en mémoire, sur `serveur` : une expression Python, après `preambule`. */
export function annoncePython(python: string, preambule: string, serveur: string, env: NodeJS.ProcessEnv = {}): unknown {
  const script = `
import asyncio, json
from mcp import Client
${preambule}
async def main():
    async with Client(${serveur}) as c:
        d = lambda x: x.model_dump(mode="json", by_alias=True, exclude_none=True)
        print(json.dumps({"serveur": d(c.server_info), "instructions": c.instructions,
                          "outils": [d(t) for t in (await c.list_tools()).tools], "ressources": [d(r) for r in (await c.list_resources()).resources],
                          "modeles": [d(r) for r in (await c.list_resource_templates()).resource_templates],
                          "prompts": [d(p) for p in (await c.list_prompts()).prompts]}, ensure_ascii=False))
asyncio.run(main())`;
  const annonce = JSON.parse(execFileSync(python, ["-c", script], { cwd: PYTHON, encoding: "utf8", stdio: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env } }));
  annonce.outils = annonce.outils.map((t: Record<string, unknown>) => ({
    ...t,
    inputSchema: commePython(sansReferences(t.inputSchema as Record<string, unknown>)),
    outputSchema: commePython(sansReferences(t.outputSchema as Record<string, unknown>)),
  }));
  return annonce;
}
