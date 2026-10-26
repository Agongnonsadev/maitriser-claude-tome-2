// Chapitre 13 : l'agent de réapprovisionnement, lancé chaque lundi à 7 h par Managed Agents (bêta).
//
// Par défaut, ce script n'appelle pas l'API : il affiche la requête qu'il enverrait. Avec --creer, il crée
// un déploiement planifié, qui lancera une session chaque lundi, avec son budget, jusqu'à ce que vous
// l'archiviez (npx tsx ch13/planifier_lundi.ts --archiver ID). Chaque session coûte.
//
// Attention : l'agent du chapitre a des outils personnalisés, exécutés par votre code. Une session planifiée
// qui appelle un tel outil se met en attente (requires_action) tant que personne ne répond. Pour une
// planification, il faut donc un programme à l'écoute des événements (webhooks), ou des outils qui tournent
// côté Anthropic : un serveur MCP (chapitres 14 à 16).
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch13/planifier_lundi.ts --agent AGENT_ID --environnement ENV_ID            (affiche seulement)
//     npx tsx ch13/planifier_lundi.ts --agent AGENT_ID --environnement ENV_ID --creer    (crée le déploiement)

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { CONSIGNE } from "../comptoir/agent_reappro.ts";
import { estLance } from "../comptoir/lancement.ts";
import { jsonPython } from "../comptoir/python.ts";

export const LUNDI_7H = { type: "cron", expression: "0 7 * * 1", timezone: "Africa/Porto-Novo" } as const;

export function requete(agent: string, environnement: string, budgetCents: number): Anthropic.Beta.DeploymentCreateParams {
  return {
    name: "Réapprovisionnement du lundi",
    agent,
    environment_id: environnement,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: CONSIGNE }] }],
    schedule: LUNDI_7H,
    // Copié sur chaque session lancée : il borne chaque lundi, pas le total.
    budget: { type: "limit", max_list_cost: { amount: String(budgetCents), currency: "USD" } },
  };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      agent: { type: "string" },
      environnement: { type: "string" },
      "budget-cents": { type: "string", default: "50" },
      creer: { type: "boolean", default: false }, // crée vraiment le déploiement (payant chaque lundi)
      archiver: { type: "string" }, //              archive un déploiement : plus aucun lancement
    },
  });
  if (args.archiver) {
    await new Anthropic().beta.deployments.archive(args.archiver);
    console.log(`Déploiement ${args.archiver} archivé : il ne lancera plus rien.`);
    return;
  }
  if (!(args.agent && args.environnement)) {
    console.error("erreur : --agent et --environnement sont nécessaires");
    process.exit(2);
  }
  const corps = requete(args.agent, args.environnement, Number.parseInt(args["budget-cents"], 10));
  if (!args.creer) {
    console.log("Requête qui serait envoyée (rien n'est créé sans --creer) :");
    console.log(jsonPython(corps, 2));
    return;
  }
  const deploiement = await new Anthropic().beta.deployments.create(corps);
  console.log(`Déploiement ${deploiement.id} créé ; prochains lancements : ${deploiement.schedule?.upcoming_runs_at}`);
  console.log(`Pour l'arrêter : npx tsx ch13/planifier_lundi.ts --archiver ${deploiement.id}`);
}

if (estLance(import.meta.url)) await main();
