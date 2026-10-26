// De faux messages et de faux clients pour les tests : aucun appel payant.

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessages, MessageRecu } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import type { ClientFlux, FluxMessages } from "../comptoir/flux.ts";

/** Un message complet, tel que le SDK le rendrait, à partir de ses seuls blocs et de son usage. */
export function fauxMessage({
  contenu,
  usage = {},
  raisonArret = "end_turn",
  modele = "claude-sonnet-5-5",
  identifiant = "req_test",
}: {
  contenu: object[];
  usage?: Partial<Anthropic.Usage>;
  raisonArret?: Anthropic.StopReason;
  modele?: string;
  identifiant?: string;
}): MessageRecu {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: modele,
    content: contenu,
    stop_reason: raisonArret,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens_details: null,
      server_tool_use: null,
      ...usage,
    },
    _request_id: identifiant,
  } as unknown as MessageRecu;
}

/** Comme pytest.approx : égalité à un millionième près, en valeur relative. */
export function presque(obtenu: number, attendu: number): void {
  assert.ok(Math.abs(obtenu - attendu) <= 1e-6 * Math.max(Math.abs(attendu), 1e-12), `${obtenu} ≠ ${attendu}`);
}

/** Le journal des appels dans un dossier temporaire, le temps d'un test. */
export function journalTemporaire(): string {
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "appels.jsonl");
  config.JOURNAL = chemin;
  return chemin;
}

const aRemettre: (() => void)[] = [];

/**
 * Change des réglages le temps d'un test, comme monkeypatch.setattr : remettreLesReglages(), appelée
 * après chaque test, rend leur valeur d'avant, dans l'ordre inverse.
 */
export function regler(valeurs: Partial<typeof config>): void {
  const avant = Object.fromEntries(Object.keys(valeurs).map((cle) => [cle, config[cle as keyof typeof config]]));
  Object.assign(config, valeurs);
  aRemettre.push(() => Object.assign(config, avant));
}

export function remettreLesReglages(): void {
  while (aRemettre.length) aRemettre.pop()!();
}

/** Les lignes du journal, une par appel ou par événement. */
export const lignesDuJournal = (chemin: string): Record<string, unknown>[] =>
  readFileSync(chemin, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- Le streaming (chapitre 6) -------------------------------------------------------------------

/** Un message final comme en rend le SDK : un bloc de réflexion (affichage omis) puis le texte. */
export function messageFinal(texte: string, { reflexion = true, raisonArret = "end_turn" as Anthropic.StopReason | null } = {}): Anthropic.Message {
  const blocs: object[] = reflexion ? [{ type: "thinking", thinking: "", signature: "signature-de-test" }] : [];
  blocs.push({ type: "text", text: texte, citations: null });
  return fauxMessage({ contenu: blocs, usage: { input_tokens: 1000, output_tokens: 50 }, raisonArret: raisonArret as Anthropic.StopReason });
}

/** Rend les morceaux un par un ; lève `erreur` avant le morceau de rang `coupure`. */
export class FauxFlux implements FluxMessages {
  readonly request_id = "req_test";
  readonly message: Anthropic.Message;
  constructor(
    readonly morceaux: string[],
    readonly options: { message?: Anthropic.Message; coupure?: number; erreur?: unknown; attenteMs?: number } = {},
  ) {
    this.message = options.message ?? messageFinal(morceaux.join(""));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Anthropic.MessageStreamEvent> {
    for (const [rang, morceau] of this.morceaux.entries()) {
      if (rang === this.options.coupure) throw this.options.erreur;
      await new Promise((ok) => setTimeout(ok, this.options.attenteMs ?? 0));
      yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: morceau } } as Anthropic.MessageStreamEvent;
    }
  }

  async finalMessage(): Promise<Anthropic.Message> {
    return this.message;
  }
}

/** Chaque appel à messages.stream() consomme le flux suivant de la liste. */
export class FauxClientFlux implements ClientFlux {
  readonly requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  comptages = 0;
  private readonly flux: FauxFlux[];
  readonly messages: ClientFlux["messages"];

  constructor(...flux: FauxFlux[]) {
    this.flux = flux;
    this.messages = {
      stream: (requete) => {
        this.requetes.push(requete);
        const suivant = this.flux.shift();
        if (!suivant) throw new Error("Le faux client n'a plus de flux à rendre.");
        return suivant;
      },
      // Chapitre 8 : le budget compte l'entrée avant d'appeler.
      countTokens: async () => {
        this.comptages++;
        return { input_tokens: 1000 };
      },
    };
  }
}

/** Une erreur de l'API, comme le SDK la lève pour ce statut (la bonne classe : 400, 401, 429…). */
export function erreurApi(statut: number, type = "api_error", message = "", details?: object, entetes: Record<string, string> = {}): Error {
  const corps = { type: "error", error: { type, message, ...(details ? { details } : {}) } };
  return Anthropic.APIError.generate(statut, corps, message, new Headers(entetes));
}

// --- Des réponses écrites à l'avance (chapitre 12) -----------------------------------------------

/** Un message de texte seul, comme le SDK le rendrait (500 tokens en entrée, 60 en sortie). */
export const reponseTexte = (texte: string, raisonArret: Anthropic.StopReason = "end_turn"): MessageRecu =>
  fauxMessage({ contenu: [{ type: "text", text: texte, citations: null }], usage: { input_tokens: 500, output_tokens: 60 }, raisonArret, identifiant: "req" });

/**
 * Rend les réponses prévues, une par appel, et garde chaque requête reçue, copiée telle qu'envoyée (un
 * historique modifié ensuite ne la change pas). countTokens compte toujours 500 tokens.
 */
export class FauxClient implements ClientMessages {
  readonly requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly reponses: (MessageRecu | (() => MessageRecu))[];
  readonly messages: ClientMessages["messages"];

  constructor(...reponses: (MessageRecu | (() => MessageRecu))[]) {
    this.reponses = reponses;
    this.messages = {
      countTokens: async () => ({ input_tokens: 500 }),
      create: async (requete) => {
        this.requetes.push(JSON.parse(JSON.stringify(requete)));
        const suivante = this.reponses.shift();
        if (!suivante) throw new Error("Le faux client n'a plus de réponse à rendre.");
        return typeof suivante === "function" ? suivante() : suivante;
      },
    };
  }
}
