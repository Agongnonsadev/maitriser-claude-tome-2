// Un appel à Claude qui encaisse les pannes et respecte le budget (chapitre 8).
//
// Dans l'ordre : compter l'entrée (gratuit), réserver le coût maximal, appeler, noter dans le journal
// ce qui s'est passé, régler le coût réel, et traduire tout échec en un diagnostic.

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import type { Budget } from "./budget.ts";
import { type ClientMessages, type MessageRecu, texteDe } from "./client.ts";
import { config } from "./config.ts";
import { type Cout, cout, coutMaximal, dureeCache } from "./couts.ts";
import { type Diagnostic, ErreurComptoir, INDISPONIBLE, diagnostiquer, diagnostiquerArret } from "./erreurs.ts";
import { noter, noterEvenement } from "./journal.ts";

type Requete = Anthropic.MessageCreateParamsNonStreaming;

/** Les paramètres de la requête que l'outil de comptage accepte aussi. */
export const CHAMPS_COMPTAGE = ["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config"] as const;

/** La requête de comptage : les seuls champs que countTokens accepte (pas max_tokens, par exemple). */
export function requeteDeComptage(requete: Requete): Anthropic.MessageCountTokensParams {
  return Object.fromEntries(
    Object.entries(requete).filter(([cle]) => (CHAMPS_COMPTAGE as readonly string[]).includes(cle)),
  ) as Anthropic.MessageCountTokensParams;
}

export class HorsBudget extends ErreurComptoir {}

/** Le client du Comptoir : délai et réessais réglés, plutôt que les défauts du SDK. */
export function creerClient(): Anthropic {
  return new Anthropic({ timeout: config.DELAI_S * 1000, maxRetries: config.REESSAIS });
}

export async function estimerMaximum(client: ClientMessages, requete: Requete): Promise<number> {
  const compte = await client.messages.countTokens(requeteDeComptage(requete));
  // Avec un point de cache, l'entrée peut être écrite dans le cache : plus chère que l'entrée (chapitre 11).
  return coutMaximal(requete.model, compte.input_tokens, requete.max_tokens, dureeCache(requete));
}

export interface Reponse {
  message: MessageRecu;
  texte: string;
  cout: Cout;
  arret: Diagnostic | null; // null : la réponse s'est arrêtée normalement
  alerte: boolean; //          le budget du jour ou du mois approche de son plafond
}

export async function appeler(
  client: ClientMessages,
  requete: Requete,
  budget: Budget,
  clientId: string,
  prompt: string | null = null,
): Promise<Reponse> {
  let maximum: number;
  try {
    maximum = await estimerMaximum(client, requete);
  } catch (erreur) { // le comptage échoue comme l'appel échouerait : même diagnostic
    const d = diagnostiquer(erreur);
    noterEvenement("comptage_impossible", { client: clientId, erreur: d.code, origine: d.origine });
    throw new ErreurComptoir(d, { cause: erreur });
  }
  const decision = budget.reserver(clientId, maximum);
  if (!decision.accepte) {
    noterEvenement("hors_budget", { motif: decision.motif, client: clientId });
    throw new HorsBudget({
      code: decision.motif!, reessayer: false, origine: "compte", pourLeClient: INDISPONIBLE,
      pourYao: `Appel refusé par le budget du Comptoir (${decision.motif}).`, attenteS: null,
    });
  }

  const debut = performance.now();
  let message: MessageRecu;
  try {
    message = await client.messages.create(requete);
  } catch (erreur) {
    const d = diagnostiquer(erreur);
    const identifiant = erreur instanceof Anthropic.APIError ? erreur.requestID : null;
    noter(identifiant, requete.model, null, {
      prompt, client: clientId, erreur: d.code, origine: d.origine, duree_ms: Math.round(performance.now() - debut),
    });
    // Une erreur renvoyée par l'API n'est pas facturée ; une coupure réseau peut l'être (la requête a pu
    // aboutir sans que la réponse arrive) : on garde alors la réserve.
    if (erreur instanceof Anthropic.APIError && erreur.status !== undefined) budget.liberer(decision.reservation!);
    throw new ErreurComptoir(d, { cause: erreur });
  }

  const prix = cout(requete.model, message.usage);
  budget.regler(decision.reservation!, prix.dollars);
  const arret = diagnostiquerArret(message);
  noter(message._request_id, requete.model, prix, {
    prompt, client: clientId, stop_reason: message.stop_reason, duree_ms: Math.round(performance.now() - debut),
    erreur: arret?.code, origine: arret?.origine,
  });
  return { message, texte: texteDe(message), cout: prix, arret, alerte: budget.enAlerte() };
}
