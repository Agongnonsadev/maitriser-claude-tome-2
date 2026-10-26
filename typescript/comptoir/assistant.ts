// Le Comptoir, version du chapitre 5 : prompt versionné, message client balisé, consignes d'Awa en
// cours de conversation.

import type Anthropic from "@anthropic-ai/sdk";
import { type ClientMessages, type MessageRecu, texteDe } from "./client.ts";
import { config } from "./config.ts";
import { type Cout, cout } from "./couts.ts";
import { noter } from "./journal.ts";
import { type PromptSysteme, charger, messageClient } from "./prompt.ts";

export const MAX_TOKENS = 2000;

type Requete = Anthropic.MessageCreateParamsNonStreaming;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/**
 * Un message système ajouté en cours de conversation, avec l'autorité du prompt système.
 *
 * Il doit suivre immédiatement un message de l'utilisateur, et être le dernier de la liste ou suivi
 * d'une réponse de l'assistant. Il ne casse pas le cache du début.
 */
export function consigneOperateur(texte: string): Anthropic.SystemMessageParam {
  return { role: "system", content: texte };
}

/**
 * Les documents d'Awa en tête du premier message de la conversation (chapitre 11).
 *
 * Ils sont joints à chaque requête, à l'identique, et jamais enregistrés dans l'historique : le début
 * de la requête ne change pas d'un tour à l'autre, ni d'un client à l'autre, et il peut donc être lu
 * dans le cache.
 */
export function joindreConnaissances(
  messages: Anthropic.MessageParam[],
  blocs?: Anthropic.SearchResultBlockParam[] | null,
): Anthropic.MessageParam[] {
  const [premier, ...suite] = messages;
  if (!blocs?.length || !premier) return messages;
  const contenu = typeof premier.content === "string" ? [{ type: "text" as const, text: premier.content }] : premier.content;
  return [{ ...premier, content: [...blocs, ...contenu] } as Anthropic.MessageParam, ...suite];
}

export interface OptionsRequete {
  historique?: Anthropic.MessageParam[];
  consignes?: string[];
  prompt?: PromptSysteme;
  /** Chapitre 11 : cache automatique, dont le point avance avec la conversation. */
  cache?: boolean;
  /** Chapitre 11 : les blocs search_result de la base d'Awa. */
  connaissances?: Anthropic.SearchResultBlockParam[] | null;
  /**
   * Chapitre 17 : un autre modèle que celui de config, pour l'évaluer ; l'effort de config ne vaut
   * alors plus, puisqu'il a été choisi pour le modèle du Comptoir.
   */
  modele?: string | null;
  /** Chapitre 19 : l'effort de ce modèle-là, s'il a été mesuré ; null pour son défaut. */
  effort?: Effort | null;
}

export function construireRequete(question: string, options: OptionsRequete = {}): Requete {
  const prompt = options.prompt ?? charger();
  const messages: Anthropic.MessageParam[] = [...(options.historique ?? [])];
  messages.push({ role: "user", content: messageClient(question) });
  // Placées juste après le message du client, les consignes d'Awa s'appliquent à sa réponse.
  messages.push(...(options.consignes ?? []).map(consigneOperateur));
  const requete: Requete = {
    model: options.modele || config.MODELE,
    max_tokens: MAX_TOKENS,
    system: prompt.texte,
    messages: joindreConnaissances(messages, options.connaissances),
  };
  if (config.EFFORT && !options.modele) requete.output_config = { effort: config.EFFORT as Effort };
  if (options.effort) requete.output_config = { effort: options.effort };
  if (options.cache) requete.cache_control = { type: "ephemeral" };
  return requete;
}

export async function repondre(
  client: ClientMessages,
  question: string,
  options: OptionsRequete = {},
): Promise<{ texte: string; prix: Cout; message: MessageRecu }> {
  const prompt = options.prompt ?? charger();
  const requete = construireRequete(question, { ...options, prompt });
  const message = await client.messages.create(requete);
  const prix = cout(requete.model, message.usage);
  noter(message._request_id, requete.model, prix, { prompt: prompt.identifiant });
  return { texte: texteDe(message), prix, message };
}
