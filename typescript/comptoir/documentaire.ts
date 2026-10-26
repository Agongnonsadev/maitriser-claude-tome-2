// Répondre à partir des documents d'Awa, avec les sources (chapitre 11).
//
// Deux façons de donner les documents à Claude, avec la même requête et les mêmes citations :
// - toute la base, mise en cache : le début de la requête ne change jamais, il est lu dans le cache à
//   chaque question ;
// - les seuls morceaux trouvés par une recherche (RAG) : moins de tokens, mais un début de requête qui
//   change à chaque question, donc rien à mettre en cache.
//
// Les morceaux sont des blocs search_result : chaque citation revient avec notre identifiant
// (kb://faq#…), que le code peut vérifier et afficher. Les prompts sont ceux de la version Python
// (python/comptoir/prompts/documentaire_vN.md).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arrondir } from "./arrondi.ts";
import { type ClientMessages, texteDe } from "./client.ts";
import { config } from "./config.ts";
import { type Cache, type Morceau, blocsResultats } from "./connaissances.ts";
import { type Cout, cout } from "./couts.ts";
import { noter } from "./journal.ts";
import { PYTHON } from "./lancement.ts";
import { normaliser } from "./notation.ts";
import { PromptSysteme, messageClient } from "./prompt.ts";

const DOSSIER_PROMPTS = join(PYTHON, "comptoir", "prompts");
export const MAX_TOKENS = 1000;

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export function chargerPrompt(version = "v1"): PromptSysteme {
  const texte = readFileSync(join(DOSSIER_PROMPTS, `documentaire_${version}.md`), "utf8").replace(/\r\n/g, "\n").trim();
  return new PromptSysteme(texte, `documentaire-${version}`);
}

export interface OptionsRequete {
  prompt?: PromptSysteme | null;
  cache?: Cache;
  modele?: string | null;
  /** Chapitre 12 : pour Claude Haiku 5.5, qui accepte de ne pas réfléchir. */
  sansReflexion?: boolean;
  maxTokens?: number;
  avecCitations?: boolean;
}

/**
 * Les documents d'abord, la question à la fin : c'est l'ordre que recommande Anthropic pour les longs
 * documents, et le seul qui permette le cache (le début ne varie pas).
 */
export function construireRequete(question: string, morceaux: Morceau[], options: OptionsRequete = {}): Anthropic.MessageCreateParamsNonStreaming {
  const { cache = true, modele = null, sansReflexion = false, maxTokens = MAX_TOKENS, avecCitations = true } = options;
  const prompt = options.prompt ?? chargerPrompt();
  const contenu: Anthropic.ContentBlockParam[] = [...blocsResultats(morceaux, cache, avecCitations), { type: "text", text: messageClient(question) }];
  const requete: Anthropic.MessageCreateParamsNonStreaming = {
    model: modele || config.MODELE,
    max_tokens: maxTokens,
    system: prompt.texte,
    messages: [{ role: "user", content: contenu }],
  };
  // L'effort choisi au chapitre 3 vaut pour le modèle du Comptoir.
  if (config.EFFORT && !modele) requete.output_config = { effort: config.EFFORT as Effort };
  if (sansReflexion) requete.thinking = { type: "disabled" };
  return requete;
}

export interface Citation {
  source: string; // kb://faq#…
  titre: string;
  texte: string; //  le passage cité, tel qu'il est dans le document
}

export interface ReponseDocumentaire {
  texte: string;
  citations: Citation[];
  cout: Cout;
  latence: number; //    en secondes
  requeteId: string | null;
  sources: string[]; //  les identifiants cités, sans doublon
  texteSimple: string; // le même texte, sans renvois : pour un client sur WhatsApp
  arret: string; //      la raison de l'arrêt : une réponse coupée n'est pas une réponse (chapitre 8)
}

type Bloc = { type: string; text?: string; citations?: { type?: string; source?: string; title?: string | null; cited_text?: string }[] | null };

/** Les citations des passages de la base (search_result_location), sans doublon. */
export function citations(message: { content: unknown[] }): Citation[] {
  const vues = new Set<string>();
  const resultat: Citation[] = [];
  for (const bloc of message.content as Bloc[]) {
    if (bloc.type !== "text") continue;
    for (const c of bloc.citations ?? []) {
      if (c.type !== "search_result_location") continue;
      const cle = JSON.stringify([c.source, c.cited_text]);
      if (!vues.has(cle)) {
        vues.add(cle);
        resultat.push({ source: c.source!, titre: c.title || "", texte: c.cited_text! });
      }
    }
  }
  return resultat;
}

/** Le texte de la réponse, avec un renvoi [1], [2]… après chaque passage cité. */
export function texteAvecRenvois(message: { content: unknown[] }): string {
  const numeros = new Map<string, number>();
  const morceaux: string[] = [];
  for (const bloc of message.content as Bloc[]) {
    if (bloc.type !== "text") continue;
    morceaux.push(bloc.text ?? "");
    const sources = [...new Set((bloc.citations ?? []).filter((c) => c.type === "search_result_location").map((c) => c.source!))];
    for (const s of sources) if (!numeros.has(s)) numeros.set(s, numeros.size + 1);
    morceaux.push(sources.map((s) => `[${numeros.get(s)}]`).join(""));
  }
  return morceaux.join("").trim();
}

/** Une question de test, écrite avant les essais (chapitre 3). Les champs sont ceux de ch11/questions.json. */
export interface CasDocumentaire {
  identifiant: string;
  question: string;
  sources: string[]; //  au moins une doit être citée
  un_parmi: string[]; // au moins un de ces faits dans la réponse
  absente: boolean; //   la réponse n'est pas dans les documents
  orienter: boolean; //  question de santé : renvoyer vers un professionnel
  a_relire: string;
}

const CHAMPS_CAS = ["identifiant", "question", "sources", "un_parmi", "absente", "orienter", "a_relire"];

/** Un cas complété de ses valeurs par défaut. Un champ inconnu est refusé, comme en Python (cls(**d)). */
export function creerCasDocumentaire(d: Pick<CasDocumentaire, "identifiant" | "question"> & Partial<CasDocumentaire>): CasDocumentaire {
  const inconnus = Object.keys(d).filter((cle) => !CHAMPS_CAS.includes(cle));
  if (inconnus.length) throw new TypeError(`Champ inconnu dans un cas : ${inconnus.join(", ")}`);
  return { sources: [], un_parmi: [], absente: false, orienter: false, a_relire: "", ...d };
}

// Les façons de dire « je ne sais pas » que le code reconnaît. Une autre formulation sera comptée comme
// un échec, puis relue : la grille se corrige par écrit, jamais en douce.
export const NE_SAIT_PAS = new RegExp(
  "je ne trouve pas|ne figure pas|n'apparait pas|n'apparaît pas|pas d'information|aucune information|" +
    "pas cette information|je ne sais pas|n'ai pas d'information|ne précisent pas|ne mentionnent pas|" +
    "ne parlent pas|ne disent pas|don't have|do not have|couldn't find|could not find|no information",
  "iu",
);

/** Les raisons de l'échec ; une liste vide si la réponse passe les critères du code. */
export function noterDocumentaire(cas: CasDocumentaire, reponse: Pick<ReponseDocumentaire, "texte" | "sources" | "arret">, exigerSources = true): string[] {
  const texte = normaliser(reponse.texte);
  const raisons: string[] = [];
  if (reponse.arret !== "end_turn") raisons.push(`réponse arrêtée par ${reponse.arret}`);
  if (cas.absente) {
    if (!NE_SAIT_PAS.test(reponse.texte)) raisons.push("ne dit pas que l'information manque");
    if (!texte.includes("awa")) raisons.push("ne propose pas de transmettre à Awa");
    return raisons;
  }
  if (exigerSources && !cas.sources.some((s) => reponse.sources.includes(s))) raisons.push("aucune des sources attendues n'est citée");
  if (cas.un_parmi.length && !cas.un_parmi.some((f) => texte.includes(normaliser(f)))) raisons.push(`aucun de : ${cas.un_parmi.join(", ")}`);
  if (cas.orienter && !["professionnel", "médecin", "medecin"].some((m) => texte.includes(m))) {
    raisons.push("ne renvoie pas vers un professionnel de santé");
  }
  return raisons;
}

export interface OptionsReponse extends OptionsRequete {
  mode?: string; // pour le journal : contexte, rag, rag-reclasse
}

export async function repondre(client: ClientMessages, question: string, morceaux: Morceau[], options: OptionsReponse = {}): Promise<ReponseDocumentaire> {
  const prompt = options.prompt ?? chargerPrompt();
  const requete = construireRequete(question, morceaux, { ...options, prompt });
  const debut = performance.now();
  const message = await client.messages.create(requete);
  const latence = (performance.now() - debut) / 1000;
  const prix = cout(requete.model, message.usage);
  noter(message._request_id, requete.model, prix, { prompt: prompt.identifiant, mode: options.mode ?? "contexte", stop_reason: message.stop_reason });
  const cites = citations(message);
  return {
    texte: texteAvecRenvois(message),
    citations: cites,
    cout: prix,
    latence: arrondir(latence, 2),
    requeteId: message._request_id ?? null,
    sources: [...new Set(cites.map((c) => c.source))],
    texteSimple: texteDe(message).trim(),
    arret: message.stop_reason ?? "None",
  };
}
