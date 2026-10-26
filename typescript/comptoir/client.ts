// Ce que le Comptoir utilise du client du SDK. Le vrai client (new Anthropic()) convient ; un faux
// client des tests aussi, qui répond sans appel payant.

import type Anthropic from "@anthropic-ai/sdk";

/** Un message reçu, avec l'identifiant de la requête que le SDK y ajoute (à donner au support). */
export type MessageRecu = Anthropic.Message & { _request_id?: string | null };

export interface ClientMessages {
  messages: {
    create(requete: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<MessageRecu>;
    countTokens(requete: Anthropic.MessageCountTokensParams): PromiseLike<Anthropic.MessageTokensCount>;
  };
}

/** Le texte d'une réponse : seulement ses blocs de texte (pas la réflexion, pas les outils). */
export function texteDe(message: Pick<Anthropic.Message, "content">): string {
  return message.content.map((bloc) => (bloc.type === "text" ? bloc.text : "")).join("");
}
