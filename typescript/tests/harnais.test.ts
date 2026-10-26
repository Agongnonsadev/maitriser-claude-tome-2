// Le même agent dans deux autres harnais, le Claude Agent SDK et Managed Agents, et sa planification :
// aucun appel (python/tests/test_harnais.py), et les mêmes définitions que la version Python. Le serveur MCP
// de l'atelier est interrogé par un vrai client MCP, en mémoire, comme Claude Code le ferait.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { LECTURE, garder, noterAction, options, serveurDeLAtelier } from "../ch13/avec_agent_sdk.ts";
import { executer, outilsPersonnalises, sansReferences } from "../ch13/avec_managed_agents.ts";
import { LUNDI_7H, requete } from "../ch13/planifier_lundi.ts";
import { Contexte, Garde, creerOutils, reglages } from "../comptoir/agent_reappro.ts";
import { Atelier } from "../comptoir/atelier.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { Trace } from "../comptoir/trace.ts";
import { journalTemporaire, lignesDuJournal } from "./faux_clients.ts";

// Les outils notent leurs étapes : dans un journal temporaire, jamais dans celui du Comptoir.
let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
});

// --- Le Claude Agent SDK -------------------------------------------------------------------------

async function decision(entree: Record<string, unknown>): Promise<string | undefined> {
  const sortie = (await garder(entree as never, "toolu_1", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
  return sortie.hookSpecificOutput?.permissionDecision;
}

test("le hook réserve la lecture des messages au sous-agent", async () => {
  assert.equal(await decision({ tool_name: LECTURE }), "deny"); //                                       l'agent principal
  assert.equal(await decision({ tool_name: LECTURE, agent_id: "a1", agent_type: "lecteur" }), undefined); // le sous-agent
  assert.equal(await decision({ tool_name: "Bash" }), "deny");
  assert.equal(await decision({ tool_name: "Agent" }), undefined);
  assert.equal(await decision({ tool_name: "mcp__atelier__lire_stock" }), undefined);
});

test("le hook d'après note qui a fait quoi, sans les données", async () => {
  await noterAction({ tool_name: LECTURE, agent_type: "lecteur", tool_input: { secret: "x" } } as never, "toolu_1", { signal: new AbortController().signal });
  await noterAction({ tool_name: "Agent" } as never, "toolu_2", { signal: new AbortController().signal });
  assert.deepEqual(lignesDuJournal(journal).map((l) => [l.evenement, l.outil, l.par, "tool_input" in l]), [["action", LECTURE, "lecteur", false], ["action", "Agent", "agent principal", false]]);
});

test("les options du SDK n'ouvrent rien de plus", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "agent-sdk-"));
  const o = await options(new Contexte(null, new Atelier(), new Garde(), new Trace()), 0.6, dossier);
  assert.deepEqual(o.tools, ["Agent"]);
  assert.ok(o.permissionMode === "dontAsk" && o.settingSources!.length === 0);
  assert.deepEqual(o.agents!.lecteur!.tools, [LECTURE]);
  assert.ok(o.agents!.lecteur!.model === "claude-haiku-5-5" && o.maxBudgetUsd === 0.6);
  assert.ok(o.env!.CLAUDE_CONFIG_DIR!.startsWith(dossier));
  // Comme le SDK Python : l'environnement du processus, sans CLAUDECODE, et les variables données.
  assert.ok(!("CLAUDECODE" in o.env!) && o.env!.PATH === (process.env.PATH ?? o.env!.PATH));
});

/** Le serveur MCP de l'atelier, relié à un vrai client MCP par un transport en mémoire. */
async function clientDuServeur(): Promise<Client> {
  const serveur = await serveurDeLAtelier(new Contexte(null, new Atelier(), new Garde(), new Trace()));
  const [cote, autre] = InMemoryTransport.createLinkedPair();
  await serveur.instance.connect(cote);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(autre);
  return client;
}

test("le serveur MCP de l'atelier : les sept outils, leurs sorties et leurs erreurs", async () => {
  const client = await clientDuServeur();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["lire_ventes", "lire_stock", "lire_evenements", "lire_fournisseurs", "calculer_besoins", "lire_messages_fournisseurs", "proposer_bon_de_commande"]);
  const parNom = new Map((await creerOutils(new Contexte(null, new Atelier(), new Garde(), new Trace()), reglages({ sousAgent: false }))).map((o) => [o.name, o]));
  const stock = (await client.callTool({ name: "lire_stock", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  assert.equal(stock.content[0]!.text, await parNom.get("lire_stock")!.run({})); // le même texte qu'au Tool Runner
  const erreur = (await client.callTool({ name: "calculer_besoins", arguments: { production: { "Jus de baobab": 3 } } })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(erreur.isError && erreur.content[0]!.text.includes("produits inconnus"));
  await client.close();
});

const outils = async () => creerOutils(new Contexte(null, new Atelier(), new Garde(), new Trace()), reglages());

test("les outils personnalisés ont un schéma d'un seul bloc", async () => {
  const proposer = outilsPersonnalises(await outils()).find((o) => o.name === "proposer_bon_de_commande")!;
  assert.ok(proposer.type === "custom" && !JSON.stringify(proposer.input_schema).includes("$defs"));
  const schema = proposer.input_schema as { properties: { lignes: { items: { properties: { livraison_souhaitee: { type: string } } } } } };
  assert.equal(schema.properties.lignes.items.properties.livraison_souhaitee.type, "string");
  const simple = { type: "object", properties: { a: { type: "string" } } };
  assert.deepEqual(sansReferences(simple), simple);
});

test("une erreur d'outil revient comme une erreur", async () => {
  const parNom = new Map((await outils()).map((o) => [o.name, o]));
  let [texte, erreur] = await executer(parNom, "calculer_besoins", { production: { "Jus de baobab": 3 } });
  assert.ok(erreur && texte.includes("produits inconnus"));
  [texte, erreur] = await executer(parNom, "lire_stock", {});
  assert.ok(!erreur && texte.includes("produits_finis"));
});

test("la planification du lundi n'appelle rien par défaut", () => {
  const corps = requete("agent_x", "env_x", 50);
  assert.deepEqual(LUNDI_7H, { type: "cron", expression: "0 7 * * 1", timezone: "Africa/Porto-Novo" });
  assert.deepEqual(corps.budget!.max_list_cost, { amount: "50", currency: "USD" });
  assert.equal(corps.initial_events![0]!.type, "user.message");
});

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("les mêmes outils personnalisés et la même planification que la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, async () => {
  const script = `
import json
from ch13.avec_managed_agents import outils_personnalises
from ch13.planifier_lundi import requete
from comptoir.agent_reappro import Contexte, Garde, Reglages, creer_outils
from comptoir.atelier import Atelier
from comptoir.trace import Trace
outils = creer_outils(Contexte(None, Atelier(), Garde(), Trace()), Reglages())
print(json.dumps({"outils": outils_personnalises(outils), "planification": requete("agent_x", "env_x", 50)}, ensure_ascii=False))`;
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  assert.deepEqual({ outils: outilsPersonnalises(await outils()), planification: requete("agent_x", "env_x", 50) }, python);
});

const ENTREES = [
  { tool_name: LECTURE },
  { tool_name: LECTURE, agent_id: "a1", agent_type: "lecteur" },
  { tool_name: "Bash" },
  { tool_name: "Bash", agent_id: "a1" },
  { tool_name: "Agent" },
  { tool_name: "mcp__atelier__lire_stock" },
  { tool_name: "mcp__autre__lire_stock" },
  { tool_name: LECTURE, agent_id: "" },
];

/**
 * Un schéma tel que Zod le rend, ramené à celui de la version Python : le SDK TypeScript ajoute « $schema »,
 * des bornes aux entiers, « properties: {} » à une table et « additionalProperties: {} » (tout permis, comme
 * sans rien) à un objet, et retire le « additionalProperties: false » du haut. Le reste doit être identique.
 */
function commePython(noeud: unknown, haut = true): unknown {
  if (Array.isArray(noeud)) return noeud.map((n) => commePython(n, false));
  if (noeud === null || typeof noeud !== "object") return noeud;
  const o = { ...(noeud as Record<string, unknown>) };
  delete o.$schema;
  if (haut) delete o.additionalProperties;
  if (o.type === "integer" && o.minimum === Number.MIN_SAFE_INTEGER && o.maximum === Number.MAX_SAFE_INTEGER) {
    delete o.minimum;
    delete o.maximum;
  }
  if (typeof o.additionalProperties === "object" && o.additionalProperties !== null && !Object.keys(o.additionalProperties).length) delete o.additionalProperties;
  if (o.additionalProperties && typeof o.properties === "object" && !Object.keys(o.properties as object).length) delete o.properties;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, commePython(v, false)]));
}

test("les mêmes décisions du hook et les mêmes outils MCP que la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, async () => {
  const script = `
import asyncio, json, sys
from ch13.avec_agent_sdk import garder
from ch13.avec_managed_agents import sans_references
from comptoir.agent_reappro import Contexte, Garde, Reglages, creer_outils
from comptoir.atelier import Atelier
from comptoir.trace import Trace
entrees = json.load(sys.stdin)
outils = creer_outils(Contexte(None, Atelier(), Garde(), Trace()), Reglages(sous_agent=False))
print(json.dumps({"decisions": [asyncio.run(garder(e, "toolu_1", None)) for e in entrees],
                  "outils": [[o.name, o.description, sans_references(o.input_schema)] for o in outils]}, ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(ENTREES), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  ) as { decisions: unknown[]; outils: [string, string, Record<string, unknown>][] };
  const decisions = [];
  for (const e of ENTREES) decisions.push(await garder(e as never, "toolu_1", { signal: new AbortController().signal }));
  assert.deepEqual(decisions, python.decisions);
  const client = await clientDuServeur();
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(
    tools.map((t) => [t.name, t.description, commePython(t.inputSchema)]),
    python.outils.map(([nom, description, schema]) => [nom, description, commePython(schema)]),
  );
});
