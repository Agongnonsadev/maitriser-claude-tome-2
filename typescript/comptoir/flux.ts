// Streamer une réponse de Claude, la garder pour qui la lit, la reprendre si le flux casse (chapitre 6).
//
// La génération est découplée de la connexion du navigateur : Claude écrit dans une Generation, gardée
// en mémoire ; une ou plusieurs connexions la lisent. Si le téléphone du client perd le réseau, la
// réponse continue de s'écrire, et la connexion suivante reprend au morceau où la précédente s'était
// arrêtée.

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { type Cout, cout } from "./couts.ts";
import { FluxIncomplet, diagnostiquer, diagnostiquerArret, estUneCoupure } from "./erreurs.ts";
import { noter } from "./journal.ts";

export { FluxIncomplet } from "./erreurs.ts";

type Requete = Anthropic.MessageCreateParamsNonStreaming;

/** Ce que le Comptoir lit d'un flux du SDK (client.messages.stream) : ses événements, puis le message final. */
export interface FluxMessages extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
  readonly request_id?: string | null;
}

/** Le client qui streame : le vrai (new Anthropic()), ou un faux client des tests. */
export interface ClientFlux {
  messages: {
    stream(requete: Requete): FluxMessages;
    countTokens(requete: Anthropic.MessageCountTokensParams): PromiseLike<Anthropic.MessageTokensCount>;
  };
}

// Méthode documentée pour les modèles 4.6 et suivants : un nouveau message de l'utilisateur, qui
// contient la réponse partielle et demande de continuer.
export const consigneDeReprise = (partiel: string): string =>
  "Ta réponse précédente a été interrompue. Elle se terminait ainsi :\n" +
  `<reponse_interrompue>\n${partiel}\n</reponse_interrompue>\n` +
  "Reprends exactement là où tu t'es arrêté, sans répéter ce qui précède.";

// Types d'erreur passagers qui peuvent arriver en plein flux, après le statut 200.
const ERREURS_PASSAGERES = new Set(["overloaded_error", "api_error"]);

/** Une coupure ou une surcharge se reprend ; une requête refusée (400, 401…) non. */
export function reprenable(erreur: unknown): boolean {
  if (erreur instanceof FluxIncomplet) return true;
  if (erreur instanceof Anthropic.APIConnectionError) return true; // avant la réponse, délai compris
  if (erreur instanceof Anthropic.APIError) {
    if ((erreur.status ?? 0) >= 500) return true; // 500 erreur interne, 529 surcharge
    // Une erreur annoncée en plein flux n'a pas de statut dans le SDK TypeScript : son type est dans le corps.
    return erreur.status === undefined && ERREURS_PASSAGERES.has(erreur.type ?? "");
  }
  // Une connexion qui lâche en plein flux (vérifié par tests/ch06_coupure.test.ts).
  return estUneCoupure(erreur);
}

/**
 * La requête qui demande à Claude de finir une réponse coupée.
 *
 * On ajoute un message sans toucher aux précédents : le début de la conversation reste identique, son
 * cache et la réflexion préservée restent valables. Le message se place juste après celui du client,
 * avant d'éventuelles consignes d'Awa, car un message système en cours de conversation doit rester le
 * dernier ou être suivi d'une réponse.
 */
export function requeteDeReprise(requete: Requete, partiel: string): Requete {
  const messages = [...requete.messages];
  let position = messages.length;
  while (position && messages[position - 1]!.role === "system") position--;
  messages.splice(position, 0, { role: "user", content: consigneDeReprise(partiel) });
  return { ...requete, messages };
}

export type Fin = { type: string; [champ: string]: unknown };
export type Evenement = ["texte", number, string] | ["fin", number, Fin] | ["silence", number, null];

/**
 * Une réponse en cours d'écriture. Plusieurs connexions peuvent la suivre ; une connexion coupée la
 * reprend au rang où elle en était.
 */
export class Generation {
  readonly morceaux: string[] = [];
  fin: Fin | null = null;
  termineeLe: number | null = null;
  tache: Promise<void> | null = null;
  private signal = Promise.withResolvers<void>();

  constructor(readonly conversation: string) {}

  get texte(): string {
    return this.morceaux.join("");
  }

  ajouter(morceau: string): void {
    this.morceaux.push(morceau);
    this.reveiller();
  }

  terminer(evenement: Fin): void {
    this.fin = evenement;
    this.termineeLe = performance.now();
    this.reveiller();
  }

  private reveiller(): void {
    const signal = this.signal;
    this.signal = Promise.withResolvers<void>();
    signal.resolve();
  }

  /**
   * Rend ["texte", rang, morceau] à partir du rang `depuis`, puis ["fin", rang, evenement].
   *
   * Rend ["silence", rang, null] quand rien n'arrive pendant silenceMaxS secondes : de quoi envoyer un
   * signe de vie, pour que ni le navigateur ni un proxy ne prennent la connexion pour morte.
   */
  async *suivre(depuis = 0, silenceMaxS = 15): AsyncGenerator<Evenement> {
    let rang = depuis;
    while (true) {
      const signal = this.signal.promise; // pris avant de lire : rien ne peut nous échapper
      while (rang < this.morceaux.length) {
        yield ["texte", rang, this.morceaux[rang]!];
        rang++;
      }
      if (this.fin !== null) {
        yield ["fin", rang, this.fin];
        return;
      }
      let minuterie: NodeJS.Timeout | undefined;
      const silence = new Promise<"silence">((ok) => (minuterie = setTimeout(() => ok("silence"), silenceMaxS * 1000)));
      const quoi = await Promise.race([signal, silence]);
      clearTimeout(minuterie);
      if (quoi === "silence") yield ["silence", rang, null];
    }
  }
}

export interface Resultat {
  message: Anthropic.Message; // le dernier message reçu de l'API
  cout: Cout; //                 son coût (celui d'un appel coupé n'est pas connu)
  repris: boolean; //            true si la réponse a dû être reprise après une coupure
}

const ms = (debut: number): number => Math.round(performance.now() - debut);

async function unFlux(
  client: ClientFlux,
  requete: Requete,
  generation: Generation,
  prompt: string | null,
): Promise<{ message: Anthropic.Message; prix: Cout }> {
  const debut = performance.now();
  let flux: FluxMessages | undefined;
  let message: Anthropic.Message;
  try {
    flux = client.messages.stream(requete);
    for await (const evenement of flux) {
      // Le texte seulement, jamais la réflexion.
      if (evenement.type === "content_block_delta" && evenement.delta.type === "text_delta") generation.ajouter(evenement.delta.text);
    }
    message = await flux.finalMessage();
    if (message.stop_reason === null) throw new FluxIncomplet();
  } catch (brute) {
    // Un flux fermé avant message_stop : le SDK TypeScript lève une AnthropicError sans cause.
    const erreur =
      brute instanceof Anthropic.AnthropicError && !(brute instanceof Anthropic.APIError) && !estUneCoupure(brute)
        ? new FluxIncomplet({ cause: brute })
        : brute;
    const d = diagnostiquer(erreur);
    noter(flux?.request_id ?? null, requete.model, null, {
      prompt, client: generation.conversation, erreur: d.code, origine: d.origine, duree_ms: ms(debut),
    });
    throw erreur;
  }
  const prix = cout(requete.model, message.usage);
  const arret = diagnostiquerArret(message);
  noter(flux.request_id ?? null, requete.model, prix, {
    prompt, client: generation.conversation, stop_reason: message.stop_reason, duree_ms: ms(debut),
    erreur: arret?.code, origine: arret?.origine,
  });
  return { message, prix };
}

/**
 * Streame la réponse dans `generation`, avec une reprise au plus si le flux casse.
 *
 * Une seule : si la reprise casse à son tour, l'erreur remonte, et c'est à l'interface de le dire au
 * client plutôt que d'insister.
 */
export async function diffuser(client: ClientFlux, requete: Requete, generation: Generation, prompt: string | null = null): Promise<Resultat> {
  try {
    const { message, prix } = await unFlux(client, requete, generation, prompt);
    return { message, cout: prix, repris: false };
  } catch (erreur) {
    if (!reprenable(erreur)) throw erreur;
    const nom = erreur instanceof Error ? erreur.constructor.name : typeof erreur;
    console.warn(`Flux interrompu (${nom}), reprise après ${generation.morceaux.length} morceaux`);
  }
  const partiel = generation.texte;
  // Rien reçu : on renvoie simplement la requête. Sinon, on demande la suite.
  const suite = partiel ? requeteDeReprise(requete, partiel) : requete;
  const { message, prix } = await unFlux(client, suite, generation, prompt);
  return { message, cout: prix, repris: Boolean(partiel) };
}
