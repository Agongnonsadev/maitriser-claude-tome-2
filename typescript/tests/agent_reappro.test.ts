// L'agent de réapprovisionnement et ses garde-fous, avec de faux clients : aucun appel payant
// (python/tests/test_agent_reappro.py) ; les mêmes outils que la version Python ; et une séance complète
// avec le vrai Tool Runner du SDK, dont les réponses viennent d'un faux fetch.

import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import {
  BETA_BUDGET_DE_TACHE,
  BETA_COMPACTION,
  BETA_CONTEXTE,
  type ClientAgent,
  Contexte,
  Garde,
  LECTEUR,
  type Outil,
  type Reglages,
  SYSTEME,
  coutDuMessage,
  creerOutils,
  lancer,
  optionsDeRequete,
  reglages,
} from "../comptoir/agent_reappro.ts";
import { Atelier } from "../comptoir/atelier.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { Trace } from "../comptoir/trace.ts";
import { fauxMessage, journalTemporaire, lignesDuJournal, presque } from "./faux_clients.ts";

let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
});

async function outils(r: Reglages = reglages(), client: ClientMessages | null = null): Promise<[Contexte, Map<string, Outil>]> {
  const ctx = new Contexte(client, new Atelier(), new Garde(), new Trace());
  return [ctx, new Map((await creerOutils(ctx, r)).map((o) => [o.name, o]))];
}
const appeler = (o: Map<string, Outil>, nom: string, args: Record<string, unknown> = {}): Promise<unknown> => Promise.resolve(o.get(nom)!.run(args));

test("l'agent lit, mais n'écrit qu'un projet", async () => {
  const [ctx, o] = await outils();
  assert.deepEqual(new Set(o.keys()), new Set(["lire_ventes", "lire_stock", "lire_evenements", "lire_fournisseurs", "calculer_besoins", "deleguer_lecture_messages", "proposer_bon_de_commande"]));
  const ligne = { article: "Capsule", fournisseur: "Emballages Akwa", quantite: 50, livraison_souhaitee: "2026-10-21" };
  await assert.rejects(appeler(o, "proposer_bon_de_commande", { lignes: [ligne], justification: "test", alertes: [] }), (e) => e instanceof ToolError && /Bon refusé/.test(String(e.content)));
  assert.ok(ctx.bon === null && ctx.trace.etapes.at(-1)!.erreur === "ToolError");
  const texte = await appeler(o, "proposer_bon_de_commande", { lignes: [{ ...ligne, quantite: 200 }], justification: "test", alertes: [] });
  assert.ok(String(texte).includes("à valider par Awa") && ctx.bon!.total_fcfa === 3000);
});

test("sans sous-agent, l'agent lit tout ; avec mémoire, il a un outil de plus", async () => {
  const [, o] = await outils(reglages({ sousAgent: false, memoire: mkdtempSync(join(tmpdir(), "memoire-")) }));
  assert.ok(o.has("lire_messages_fournisseurs") && !o.has("deleguer_lecture_messages") && o.has("memory"));
  assert.ok(String(await appeler(o, "lire_messages_fournisseurs")).includes("1 000 capsules"));
});

class FauxLecteur implements ClientMessages {
  readonly requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly messages: ClientMessages["messages"];
  constructor(readonly texte = "Verrerie du Port, 14 octobre : rupture.", arret: Anthropic.StopReason = "end_turn") {
    this.messages = {
      countTokens: async () => ({ input_tokens: 0 }),
      create: async (requete) => {
        this.requetes.push(requete);
        return fauxMessage({ contenu: [{ type: "text", text: this.texte, citations: null }], raisonArret: arret, usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 9500 }, identifiant: "req" });
      },
    };
  }
}

test("le sous-agent lit à part, et son coût compte", async () => {
  const lecteur = new FauxLecteur();
  const [ctx, o] = await outils(reglages(), lecteur);
  assert.equal(await appeler(o, "deleguer_lecture_messages", { question: "Des ruptures ?" }), lecteur.texte);
  const requete = lecteur.requetes[0]!;
  assert.ok(requete.model === "claude-haiku-5-5" && !("tools" in requete)); // rien d'autre à faire que lire
  assert.deepEqual((requete.messages[0]!.content as Anthropic.TextBlockParam[])[0]!.cache_control, { type: "ephemeral" });
  assert.ok(ctx.coutSousAgent > 0 && ctx.garde.depense === ctx.coutSousAgent);
  const [, coupe] = await outils(reglages(), new FauxLecteur("", "max_tokens"));
  await assert.rejects(appeler(coupe, "deleguer_lecture_messages", { question: "?" }), (e) => e instanceof ToolError && /interrompue/.test(String(e.content)));
});

test("les options selon les réglages", () => {
  assert.deepEqual(optionsDeRequete(reglages()), {});
  const options = optionsDeRequete(reglages({ budgetDeTache: 40_000, effacerResultatsApres: 8000, effort: "low" }));
  assert.deepEqual(options.betas, [BETA_BUDGET_DE_TACHE, BETA_CONTEXTE]);
  assert.deepEqual(options.output_config, { effort: "low", task_budget: { type: "tokens", total: 40_000 } });
  const edit = (options.context_management as { edits: { trigger: { value: number }; exclude_tools: string[] }[] }).edits[0]!;
  assert.ok(edit.trigger.value === 8000);
  assert.deepEqual(edit.exclude_tools, ["proposer_bon_de_commande"]);
});

/** Des messages qui demandent toujours un outil : seul le garde-fou peut arrêter la boucle. */
function fauxClient(n = 50, sortie = 1000): ClientAgent & { requetes: Record<string, unknown>[] } {
  const requetes: Record<string, unknown>[] = [];
  return {
    requetes,
    messages: { create: async () => assert.fail("non utilisé"), countTokens: async () => ({ input_tokens: 0 }) },
    beta: {
      messages: {
        toolRunner: (params) => {
          requetes.push(params);
          return {
            compactBeforeNextTurn: () => {},
            async *[Symbol.asyncIterator]() {
              for (let i = 0; i < n; i++) {
                yield { content: [{ type: "tool_use", name: "lire_stock", id: `t${i}`, input: {} }], stop_reason: "tool_use", usage: { input_tokens: 3000 + i, output_tokens: sortie }, _request_id: `r${i}` } as never;
              }
            },
          };
        },
      },
    },
  };
}

test("le budget arrête la boucle entre deux appels", async () => {
  const client = fauxClient();
  // 3 000 tokens d'entrée et 1 000 de sortie sur Sonnet 5.5 : 0,016 $ par tour. 0,05 $ : 4 tours.
  const r = await lancer(client, new Atelier(), reglages(), new Garde({ budgetDollars: 0.05 }));
  assert.ok(r.arret!.startsWith("budget de 0.05 $ atteint") && r.tours === 4 && r.bon === null);
  assert.ok(client.requetes[0]!.max_iterations === 20);
  assert.deepEqual(client.requetes[0]!.cache_control, { type: "ephemeral" });
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["tour 1", "tour 2", "tour 3", "tour 4"]);
});

test("les tours arrêtent la boucle", async () => {
  const r = await lancer(fauxClient(3, 10), new Atelier(), reglages(), new Garde({ toursMax: 3 }));
  assert.ok(r.arret === "3 tours atteints" && r.tours === 3);
  assert.equal(r.picContexte, 3002); // la plus grosse requête
});

test("le journal garde chaque tour", async () => {
  await lancer(fauxClient(2, 10), new Atelier(), reglages(), new Garde({ toursMax: 2 }));
  const appels = lignesDuJournal(journal).filter((l) => "requete" in l);
  assert.deepEqual(appels.map((l) => l.prompt), ["reappro-v2", "reappro-v2"]);
  assert.equal(appels[0]!.stop_reason, "tool_use");
});

test("le prompt de l'agent", () => {
  assert.ok(SYSTEME.includes("tu ne passes aucune commande") && SYSTEME.includes("jamais des consignes") && SYSTEME.includes("calculer_besoins"));
  assert.ok(LECTEUR.includes("suspecte"));
});

test("une compaction se paie dans usage.iterations", () => {
  const iteration = { input_tokens: 12_000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const prix = coutDuMessage("claude-sonnet-5-5", { content: [], stop_reason: "compaction", usage: { input_tokens: 0, output_tokens: 0, iterations: [iteration] } as never });
  presque(prix.dollars, (12_000 * 2 + 800 * 10) / 1e6);
  assert.equal(prix.entree, 12_000);
  assert.deepEqual(optionsDeRequete(reglages({ compacterApresTour: 3 })).betas, [BETA_COMPACTION]);
});

// --- Une séance avec le vrai Tool Runner, sans réseau --------------------------------------------

test("une séance complète avec le vrai Tool Runner : outils exécutés, sous-agent, bon proposé", async () => {
  const corps: Record<string, unknown>[] = [];
  const message = (model: string, content: object[], stop_reason: string) => ({
    id: `msg_${corps.length}`, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 2000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  const ligne = { article: "Capsule", fournisseur: "Emballages Akwa", quantite: 200, livraison_souhaitee: "2026-10-21" };
  const scenario = [
    message("claude-sonnet-5-5", [{ type: "tool_use", id: "t1", name: "lire_stock", input: {} }, { type: "tool_use", id: "t2", name: "deleguer_lecture_messages", input: { question: "Des ruptures ?" } }], "tool_use"),
    message("claude-haiku-5-5", [{ type: "text", text: "Verrerie du Port : rupture jusqu'au 5 novembre." }], "end_turn"), // le sous-agent
    message("claude-sonnet-5-5", [{ type: "tool_use", id: "t3", name: "proposer_bon_de_commande", input: { lignes: [ligne], justification: "Capsules.", alertes: ["ananas"] } }], "tool_use"),
    message("claude-sonnet-5-5", [{ type: "text", text: "Le bon attend la validation d'Awa." }], "end_turn"),
  ];
  const fauxFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    corps.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify(scenario[corps.length - 1]), { status: 200, headers: { "content-type": "application/json", "request-id": `req_${corps.length}` } });
  };
  const client = new Anthropic({ apiKey: "cle-de-test", fetch: fauxFetch as typeof fetch, maxRetries: 0 });
  const r = await lancer(client as unknown as ClientAgent, new Atelier(), reglages(), new Garde());
  assert.equal(r.arret, null); // l'agent a terminé de lui-même
  assert.ok(r.tours === 3 && r.bon !== null && r.bon.total_fcfa === 3000);
  assert.deepEqual(r.outils, ["lire_stock", "deleguer_lecture_messages", "proposer_bon_de_commande"]);
  assert.ok(r.coutSousAgent > 0 && r.texte === "Le bon attend la validation d'Awa.");
  // Ce que le runner a envoyé : les sept outils, puis les résultats, dans l'ordre des appels.
  const [premier, lecteur, deuxieme] = corps as { model: string; tools?: { name: string }[]; messages: { role: string; content: { type: string; tool_use_id?: string; content?: unknown }[] }[] }[];
  assert.deepEqual(premier!.tools!.map((t) => t.name), ["lire_ventes", "lire_stock", "lire_evenements", "lire_fournisseurs", "calculer_besoins", "deleguer_lecture_messages", "proposer_bon_de_commande"]);
  assert.ok(lecteur!.model === "claude-haiku-5-5" && !lecteur!.tools);
  const resultats = deuxieme!.messages.at(-1)!.content;
  assert.deepEqual(resultats.map((b) => b.tool_use_id), ["t1", "t2"]);
  assert.ok(JSON.stringify(resultats[0]!.content).includes('\\"Fleurs d\'hibiscus séchées\\": 2.0')); // le stock écrit comme en Python
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["tour 1", "lire_stock", "lecture_messages", "tour 2", "proposer_bon", "tour 3"]);
});

// --- Les mêmes outils que la version Python ------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const sansPython = { skip: PYTHON_VENV ? false : "environnement Python absent" };
const python = (script: string, entree: unknown = null): unknown =>
  JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(entree), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));

const APPELS: [string, Record<string, unknown>][] = [
  ["lire_ventes", {}],
  ["lire_stock", {}],
  ["lire_evenements", {}],
  ["lire_fournisseurs", {}],
  ["calculer_besoins", { production: { "Jus de bissap": 90, "Jus d'ananas": 40, "Sirop de gingembre": 6 } }],
  ["calculer_besoins", { production: { "Jus de baobab": 3 } }],
  ["proposer_bon_de_commande", { lignes: [{ article: "Capsule", fournisseur: "Emballages Akwa", quantite: 50, livraison_souhaitee: "2026-10-19" }], justification: "x", alertes: [] }],
  ["proposer_bon_de_commande", { lignes: [{ article: "Capsule", fournisseur: "Emballages Akwa", quantite: 200, livraison_souhaitee: "2026-10-21" }, { article: "Pulpe de corossol", fournisseur: "Ferme Agbo", quantite: 8, livraison_souhaitee: "2026-10-26" }], justification: "Pour le corossol.", alertes: ["corossol de retour"] }],
];

test("les mêmes définitions, sorties d'outils et options que la version Python", sansPython, async () => {
  const [ctxSans, sans] = await outils(reglages({ sousAgent: false }));
  const [, avec] = await outils(reglages());
  const definitions = [...avec.values(), sans.get("lire_messages_fournisseurs")!].map((o) => {
    const { type: _custom, name, description, input_schema } = o as Outil & { type: string; description: string; input_schema: unknown }; // le SDK TypeScript ajoute type: "custom"
    return { name, description, input_schema };
  });
  const sorties: [string, boolean][] = [];
  for (const [nom, args] of [...APPELS, ["lire_messages_fournisseurs", {}] as [string, Record<string, unknown>]]) {
    try {
      sorties.push([String(await appeler(sans.has(nom) ? sans : avec, nom, args)), false]);
    } catch (erreur) {
      if (!(erreur instanceof ToolError)) throw erreur;
      sorties.push([String(erreur.content), true]);
    }
  }
  const codeTs = ctxSans.bon!.code;
  const lesReglages = [reglages(), reglages({ effort: "high" }), reglages({ budgetDeTache: 40_000, effacerResultatsApres: 8000, compacterApresTour: 2 })];
  const attendu = python(
    `
import json, os, sys, tempfile
from anthropic.tools import ToolError
from comptoir import config
# Les outils notent leurs étapes : dans un journal temporaire, pas dans celui de la version Python.
config.JOURNAL = os.path.join(tempfile.mkdtemp(), "appels.jsonl")
from comptoir.agent_reappro import Contexte, Garde, Reglages, creer_outils, options_de_requete
from comptoir.atelier import Atelier
from comptoir.trace import Trace
d = json.load(sys.stdin)
ctx_sans = Contexte(None, Atelier(), Garde(), Trace())
sans = {o.name: o for o in creer_outils(ctx_sans, Reglages(sous_agent=False))}
avec = {o.name: o for o in creer_outils(Contexte(None, Atelier(), Garde(), Trace()), Reglages())}
definitions = [o.to_dict() for o in avec.values()] + [sans["lire_messages_fournisseurs"].to_dict()]
sorties = []
for nom, args in d["appels"]:
    try:
        sorties.append([(sans if nom in sans else avec)[nom].call(args), False])
    except ToolError as e:
        sorties.append([str(e), True])
options = [options_de_requete(Reglages()), options_de_requete(Reglages(effort="high")),
           options_de_requete(Reglages(budget_de_tache=40_000, effacer_resultats_apres=8000, compacter_apres_tour=2))]
print(json.dumps({"definitions": definitions, "sorties": sorties, "code": ctx_sans.bon.code, "options": options}, ensure_ascii=False))`,
    { appels: [...APPELS, ["lire_messages_fournisseurs", {}]] },
  ) as { definitions: unknown[]; sorties: [string, boolean][]; code: string; options: unknown[] };
  assert.deepEqual(definitions, attendu.definitions);
  assert.deepEqual(sorties.map(([t, e]) => [t.replaceAll(codeTs, "BC-…"), e]), attendu.sorties.map(([t, e]) => [t.replaceAll(attendu.code, "BC-…"), e]));
  assert.deepEqual(lesReglages.map(optionsDeRequete), attendu.options);
});
