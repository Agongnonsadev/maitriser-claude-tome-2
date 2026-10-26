// Les outils qu'Anthropic exécute pour vous : recherche web, lecture de pages, exécution de code
// (chapitre 10).
//
// Vous les déclarez dans la requête ; l'API les exécute pendant la requête et met leurs résultats dans la
// réponse. Votre code n'exécute rien, mais il lit tout : les sources citées, les erreurs (qui arrivent
// dans une réponse 200), les fichiers produits, le coût.

import type Anthropic from "@anthropic-ai/sdk";
import { type ClientMessages, type MessageRecu, texteDe } from "./client.ts";
import { cout } from "./couts.ts";
import { noter } from "./journal.ts";

// Les recherches partent de Cotonou : les résultats locaux passent devant. Sans le pays : le 20 octobre
// 2026, l'API refusait le code « BJ » (« Country code BJ is not supported », 400).
export const LIEU_COTONOU: Anthropic.UserLocation = { type: "approximate", city: "Cotonou", timezone: "Africa/Porto-Novo" };

/**
 * Le filtrage dynamique (versions 20260209 et suivantes) fait trier les résultats par du code avant qu'ils
 * n'entrent dans le contexte : moins de tokens, mais plus de ZDR par défaut.
 */
export function rechercheWeb(maxUses = 3, domaines: string[] | null = null, filtrageDynamique = false): Anthropic.ToolUnion {
  const outil = {
    type: filtrageDynamique ? ("web_search_20260209" as const) : ("web_search_20250305" as const),
    name: "web_search" as const,
    max_uses: maxUses,
    user_location: LIEU_COTONOU,
    ...(domaines?.length ? { allowed_domains: domaines } : {}),
  };
  return outil;
}

/** maxContentTokens borne ce qu'une page coûte : une page moyenne pèse déjà 2 500 tokens. */
export function lectureWeb(maxUses = 2, maxContentTokens = 8000, citations = true, domaines: string[] | null = null): Anthropic.WebFetchTool20250910 {
  return {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: maxUses,
    max_content_tokens: maxContentTokens,
    citations: { enabled: citations },
    ...(domaines?.length ? { allowed_domains: domaines } : {}),
  };
}

export const EXECUTION_CODE: Anthropic.CodeExecutionTool20250825 = { type: "code_execution_20250825", name: "code_execution" };

export interface Resultat {
  message: MessageRecu; //  le dernier message
  texte: string;
  cout: number; //          en dollars, tous les appels de la requête, recherches comprises
  appels: number;
  recherches: number;
  reprises: number; //      nombre de pause_turn traités
  messages: MessageRecu[];
}

/**
 * Un appel avec outils serveur, en reprenant les pauses (pause_turn) jusqu'à reprisesMax fois.
 *
 * Une pause n'est pas une erreur : la boucle d'outils côté serveur a fait une pause. On renvoie la
 * réponse telle quelle, avec les mêmes outils, et Claude continue.
 */
export async function appeler(
  client: ClientMessages,
  requete: Anthropic.MessageCreateParamsNonStreaming,
  reprisesMax = 3,
  prompt: string | null = null,
): Promise<Resultat> {
  let messages = [...requete.messages];
  let total = 0;
  let recherches = 0;
  const recus: MessageRecu[] = [];
  for (let reprise = 0; reprise <= reprisesMax; reprise++) {
    const message = await client.messages.create({ ...requete, messages });
    const prix = cout(requete.model, message.usage);
    noter(message._request_id, requete.model, prix, { prompt, stop_reason: message.stop_reason });
    total += prix.dollars;
    recherches += prix.recherches;
    recus.push(message);
    if (message.stop_reason !== "pause_turn") {
      return { message, texte: texteDe(message), cout: total, appels: recus.length, recherches, reprises: reprise, messages: recus };
    }
    messages = [...messages, { role: "assistant", content: message.content as Anthropic.ContentBlockParam[] }];
  }
  throw new Error(`Toujours en pause après ${reprisesMax} reprises : relancez plus tard ou réduisez max_uses.`);
}

/** Le texte de la réponse. Avec les citations, il arrive en plusieurs blocs, à recoller. */
export const texte = (message: Pick<Anthropic.Message, "content">): string => texteDe(message);

type Bloc = { type: string; citations?: unknown[] | null; content?: unknown };
type Citation = { url?: string | null; title?: string | null; document_title?: string | null };

/** Les sources citées, sans doublon, dans l'ordre d'apparition. À montrer au lecteur. */
export function sources(message: { content: unknown[] }): { source: string; titre: string | null }[] {
  const vues = new Set<string>();
  const liste: { source: string; titre: string | null }[] = [];
  for (const bloc of message.content as Bloc[]) {
    for (const citation of (bloc.citations ?? []) as Citation[]) {
      const cle = citation.url || citation.document_title;
      if (cle && !vues.has(cle)) {
        vues.add(cle);
        liste.push({ source: cle, titre: citation.title || citation.document_title || null });
      }
    }
  }
  return liste;
}

/** Les erreurs des outils serveur. Elles n'interrompent rien : elles arrivent dans une réponse 200. */
export function erreursOutils(message: { content: unknown[] }): string[] {
  return (message.content as Bloc[])
    .filter((b) => b.type.endsWith("_tool_result"))
    .flatMap((b) => {
      const code = (b.content as { error_code?: string } | undefined)?.error_code;
      return code ? [`${b.type} : ${code}`] : [];
    });
}

/** Les identifiants des fichiers créés par l'exécution de code, à télécharger par la Files API. */
export function fichiersProduits(message: { content: unknown[] }): string[] {
  return (message.content as Bloc[])
    .filter((b) => b.type === "bash_code_execution_tool_result")
    .flatMap((b) => {
      const resultat = b.content as { type?: string; content?: { file_id?: string }[] };
      return resultat?.type === "bash_code_execution_result" ? (resultat.content ?? []).flatMap((s) => (s.file_id ? [s.file_id] : [])) : [];
    });
}
