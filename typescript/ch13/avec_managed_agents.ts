// Chapitre 13 : le même agent, hébergé par Anthropic avec Claude Managed Agents (bêta).
//
// Anthropic fait tourner la boucle d'agent ; les outils de l'atelier restent chez vous. Ce sont des outils
// personnalisés (custom) : la session émet un appel, ce script l'exécute avec les mêmes fonctions qu'au Tool
// Runner, et renvoie le résultat. Aucun outil intégré n'est activé : ni bash, ni fichiers, ni web. Un budget
// de session, en cents de dollar, plafonne la dépense ; un délai interrompt la session si elle tarde.
//
// À la fin, la session, l'agent et l'environnement sont archivés : leur historique reste lisible, et plus
// rien ne peut tourner. Rien n'est supprimé.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch13/avec_managed_agents.ts --budget-cents 100

import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { parseArgs } from "node:util";
import { CONSIGNE, Contexte, Garde, type Outil, SYSTEME, creerOutils, reglages } from "../comptoir/agent_reappro.ts";
import { fixe } from "../comptoir/arrondi.ts";
import { Atelier, rendreBon } from "../comptoir/atelier.ts";
import { config } from "../comptoir/config.ts";
import { estLance } from "../comptoir/lancement.ts";
import { repr } from "../comptoir/python.ts";
import { Trace } from "../comptoir/trace.ts";
import { criteres } from "./criteres.ts";

/** Remplace les $ref par leur définition : un schéma d'outil personnalisé tout d'un bloc. */
export function sansReferences(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions = (schema.$defs ?? {}) as Record<string, unknown>;
  const remplacer = (noeud: unknown): unknown => {
    if (Array.isArray(noeud)) return noeud.map(remplacer);
    if (noeud !== null && typeof noeud === "object") {
      const objet = noeud as Record<string, unknown>;
      if ("$ref" in objet) return remplacer(structuredClone(definitions[String(objet.$ref).split("/").at(-1)!]));
      return Object.fromEntries(Object.entries(objet).filter(([k]) => k !== "$defs").map(([k, v]) => [k, remplacer(v)]));
    }
    return noeud;
  };
  return remplacer(schema) as Record<string, unknown>;
}

/** Les outils de l'atelier en outils personnalisés (sans l'outil mémoire, qui n'a ni description ni schéma). */
export const outilsPersonnalises = (outils: Outil[]): Record<string, unknown>[] =>
  outils.map((outil) => {
    const o = outil as Outil & { description: string; input_schema: Record<string, unknown> };
    return { type: "custom", name: o.name, description: o.description, input_schema: sansReferences(o.input_schema) };
  });

/** Un appel d'outil de la session, exécuté ici : le texte du résultat, et s'il s'agit d'une erreur. */
export async function executer(outils: Map<string, Outil>, nom: string, argumentsDOutil: Record<string, unknown>): Promise<[string, boolean]> {
  const outil = outils.get(nom);
  if (!outil) throw new Error(repr(nom)); // un KeyError en Python
  try {
    return [String(await outil.run(argumentsDOutil)), false];
  } catch (erreur) {
    if (!(erreur instanceof ToolError)) throw erreur;
    return [typeof erreur.content === "string" ? erreur.content : JSON.stringify(erreur.content), true];
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      "budget-cents": { type: "string", default: "100" }, // plafond dur de la session, en cents de dollar
      delai: { type: "string", default: "600" }, //         en secondes : au-delà, la session est interrompue
    },
  });
  const delai = Number(args.delai);
  const client = new Anthropic();
  const ctx = new Contexte(client, new Atelier(), new Garde(), new Trace());
  const outils = new Map((await creerOutils(ctx, reglages({ sousAgent: true }))).map((o) => [o.name, o]));
  const environnement = await client.beta.environments.create({ name: "atelier-awa-ch13", config: { type: "cloud", networking: { type: "limited" } } });
  const agent = await client.beta.agents.create({
    name: "Réapprovisionnement Délices d'Awa (chapitre 13)",
    model: config.MODELE,
    system: SYSTEME,
    tools: outilsPersonnalises([...outils.values()]) as unknown as Anthropic.Beta.AgentCreateParams["tools"],
  });
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environnement.id,
    title: "Bon du 19 octobre 2026",
    budget: { type: "limit", max_list_cost: { amount: args["budget-cents"], currency: "USD" } },
  });
  console.log(`Environnement ${environnement.id}, agent ${agent.id} (version ${agent.version}), session ${session.id}`);

  const debut = performance.now();
  const textes: string[] = [];
  const appels: string[] = [];
  let fin: string | null = null;
  try {
    // Le flux ne livre que les événements émis après son ouverture : on l'ouvre d'abord.
    const flux = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: CONSIGNE }] }] });
    for await (const evenement of flux) {
      if ((performance.now() - debut) / 1000 > delai) {
        await client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] });
        fin = "délai dépassé : session interrompue";
        break;
      }
      if (evenement.type === "agent.custom_tool_use") {
        appels.push(evenement.name);
        const [texte, erreur] = await executer(outils, evenement.name, { ...(evenement.input as Record<string, unknown>) });
        await client.beta.sessions.events.send(session.id, {
          events: [{ type: "user.custom_tool_result", custom_tool_use_id: evenement.id, content: [{ type: "text", text: texte }], is_error: erreur }],
        });
      } else if (evenement.type === "agent.message") {
        for (const b of evenement.content) if (b.type === "text") textes.push(b.text);
      } else if (evenement.type === "session.status_idle") {
        const raison = evenement.stop_reason ? evenement.stop_reason.type : null;
        if (raison === "end_turn" || raison === "budget_reached") {
          fin = raison;
          break;
        }
        // requires_action : les résultats sont déjà partis, la session repart d'elle-même.
      }
    }
  } finally {
    const duree = (performance.now() - debut) / 1000;
    const relue = await client.beta.sessions.retrieve(session.id);
    console.log(`\nFin : ${fin ?? "None"} ; ${fixe(duree, 1)} s ; appels d'outils : ${repr(appels)}`);
    console.log(`Usage de la session : ${JSON.stringify(relue.usage)}`);
    console.log(`Dont sous-agent (appelé par notre code) : ${fixe(ctx.coutSousAgent, 4)} $`);
    const archivages: [string, () => Promise<unknown>][] = [
      ["session", () => client.beta.sessions.archive(session.id)],
      ["agent", () => client.beta.agents.archive(agent.id)],
      ["environnement", () => client.beta.environments.archive(environnement.id)],
    ];
    for (const [nom, archiver] of archivages) {
      try {
        await archiver();
        console.log(`${nom} archivé`);
      } catch (erreur) {
        if (!(erreur instanceof Anthropic.APIError)) throw erreur;
        console.log(`${nom} NON archivé : ${erreur.message}`);
      }
    }
  }

  console.log("\nRésumé de l'agent :\n" + textes.slice(-1).join("\n"));
  console.log("\n" + (ctx.bon ? rendreBon(ctx.bon) : "Aucun bon proposé."));
  console.log("\nCritères : " + Object.entries(criteres(ctx.bon)).map(([k, v]) => `${k} ${v ? "oui" : "NON"}`).join(", "));
}

if (estLance(import.meta.url)) await main();
