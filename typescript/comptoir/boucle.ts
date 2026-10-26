// La boucle d'outils, écrite à la main (chapitre 9).
//
// Claude répond ; s'il demande des outils (stop_reason « tool_use »), le code les exécute et renvoie tous
// les résultats dans un seul message ; on recommence jusqu'à une réponse finale. Chaque appel passe par
// comptoir/appel.ts : budget, journal et diagnostics du chapitre 8.

import type Anthropic from "@anthropic-ai/sdk";
import { appeler } from "./appel.ts";
import type { Budget } from "./budget.ts";
import type { ClientMessages } from "./client.ts";
import { enBlocs } from "./conversations.ts";
import { type Diagnostic, ErreurComptoir, INDISPONIBLE } from "./erreurs.ts";
import { Execution, type Outils } from "./outils.ts";

export const TOURS_MAX = 6; // au-delà, quelque chose tourne en rond : on s'arrête plutôt que de payer

export interface Tour {
  texte: string; //                                la réponse finale de Claude, pour le client
  nouveauxMessages: Anthropic.MessageParam[]; //   à ajouter à l'historique, dans l'ordre, sans rien réécrire
  execution: Execution;
  arret: Diagnostic | null;
  cout: number; //                                 tous les appels du tour, en dollars (chapitre 12)
}

/** requete : une requête du Comptoir (comptoir/assistant.ts), dont le dernier message est celui du client. */
export async function converser(
  client: ClientMessages,
  requete: Anthropic.MessageCreateParamsNonStreaming,
  outils: Outils,
  budget: Budget,
  clientId: string,
  prompt: string | null = null,
  toursMax = TOURS_MAX,
): Promise<Tour> {
  const messages = [...requete.messages];
  const nouveaux: Anthropic.MessageParam[] = [];
  const execution = new Execution();
  let total = 0;
  for (let i = 0; i < toursMax; i++) {
    const reponse = await appeler(client, { ...requete, messages }, budget, clientId, prompt);
    total += reponse.cout.dollars;
    // Le message de l'assistant est gardé tel quel : réflexion, texte et appels d'outils. Dans un tour
    // d'outils, les blocs de réflexion doivent revenir intacts avec les résultats.
    const assistant = { role: "assistant", content: enBlocs(reponse.message.content) } as Anthropic.MessageParam;
    messages.push(assistant);
    nouveaux.push(assistant);
    if (reponse.message.stop_reason !== "tool_use") {
      return { texte: reponse.texte, nouveauxMessages: nouveaux, execution, arret: reponse.arret, cout: total };
    }
    const appels = reponse.message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // Tous les résultats dans UN message, dans l'ordre des appels, et rien avant eux.
    const resultats: Anthropic.MessageParam = { role: "user", content: appels.map((appel) => outils.executer(appel, execution)) };
    messages.push(resultats);
    nouveaux.push(resultats);
  }
  throw new ErreurComptoir({
    code: "boucle_trop_longue", reessayer: false, origine: "integration", pourLeClient: INDISPONIBLE,
    pourYao: `Plus de ${toursMax} tours d'outils pour un seul message : lire la trace.`, attenteS: null,
  });
}
