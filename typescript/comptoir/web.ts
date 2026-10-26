// Le Comptoir sur le web (chapitres 6 et 8) : une page, un flux, des conversations gardées, et un budget
// vérifié avant chaque réponse. La même page et la même API que la version Python (python/comptoir/web.py),
// avec Hono à la place de FastAPI.
//
// Chapitre 18 : des limites par adresse réseau (comptoir/limites.ts), une taille maximale de requête, un
// quota du jour par adresse, et la suppression des conversations anciennes une fois par jour.
//
// Lancer en local, depuis le dossier typescript/ :
//     npm run web
// puis ouvrir http://127.0.0.1:8000

import Anthropic from "@anthropic-ai/sdk";
import { type HttpBindings, serve, upgradeWebSocket } from "@hono/node-server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { debuglog } from "node:util";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { requeteDeComptage } from "./appel.ts";
import { construireRequete } from "./assistant.ts";
import { Budget } from "./budget.ts";
import { config } from "./config.ts";
import { Conversations } from "./conversations.ts";
import { coutMaximal, dureeCache } from "./couts.ts";
import { INDISPONIBLE, REFUS, diagnostiquer } from "./erreurs.ts";
import { type ClientFlux, type Fin, Generation, diffuser } from "./flux.ts";
import { noterEvenement } from "./journal.ts";
import { PYTHON, estLance } from "./lancement.ts";
import { Limiteur, adresseDuClient } from "./limites.ts";
import { type PromptSysteme, charger } from "./prompt.ts";

const info = debuglog("comptoir"); // affiché avec NODE_DEBUG=comptoir, comme le niveau INFO en Python

export const GARDE_S = 600; // une réponse terminée reste 10 minutes en mémoire, pour une connexion qui revient
const PURGE_S = 24 * 3600; // les conversations anciennes sont supprimées une fois par jour (chapitre 18)

export const Message = z.object({
  conversation: z.string().nullish(),
  id_message: z.string().min(8).max(64), // créé par le navigateur, un par message
  texte: z.string().min(1).max(2000),
  depuis: z.number().int().min(0).default(0), // nombre de morceaux déjà reçus (reprise)
});
export type Message = z.infer<typeof Message>;

/** Une réponse est déjà en cours dans cette conversation. */
export class Occupee extends Error {}

/** Une limite de l'adresse est atteinte (chapitre 18) ; `attente` : les secondes avant de réessayer. */
export class TropDeMessages extends Error {
  constructor(
    readonly motif: string,
    readonly attente: number,
  ) {
    super(motif);
  }
}

/** L'état du serveur : le client de l'API, les conversations, les réponses en cours. */
export class Comptoir {
  readonly generations = new Map<string, Generation>();
  readonly messagesParMinute = new Limiteur(config.LIMITE_MESSAGES_MINUTE, 60);
  readonly conversationsParHeure = new Limiteur(config.LIMITE_CONVERSATIONS_HEURE, 3600);

  /** chargerPrompt : le prompt du jour, relu à chaque message (un test peut en fournir un autre). */
  constructor(
    private _client?: ClientFlux,
    private _conversations?: Conversations,
    private _budget?: Budget,
    private readonly chargerPrompt: () => PromptSysteme = () => charger(),
  ) {}

  // Créés au premier usage : importer ce module ne doit ni lire la clé ni ouvrir la base.
  get client(): ClientFlux {
    return (this._client ??= new Anthropic({ timeout: config.DELAI_S * 1000, maxRetries: config.REESSAIS }));
  }

  get budget(): Budget {
    return (this._budget ??= new Budget(config.BUDGET));
  }

  get conversations(): Conversations {
    return (this._conversations ??= new Conversations(config.CONVERSATIONS));
  }

  private oublierLesAnciennes(): void {
    const limite = performance.now() - GARDE_S * 1000;
    for (const [cle, g] of this.generations) if (g.termineeLe !== null && g.termineeLe < limite) this.generations.delete(cle);
  }

  private limiter(limiteur: Limiteur, motif: string, adresse: string): void {
    const attente = limiteur.accepter(adresse);
    if (attente !== null) {
      noterEvenement("limite", { motif, adresse });
      throw new TropDeMessages(motif, attente);
    }
  }

  /** Renvoie la réponse à suivre, et le motif si la conversation a dû être renouvelée. */
  lancer(m: Message, adresse = "inconnue"): { generation: Generation; motif: string | null } {
    this.oublierLesAnciennes();

    // Le même message, renvoyé après une coupure : on rattache, on ne rappelle pas Claude.
    const deja = this.generations.get(m.id_message);
    if (deja) {
      if (m.conversation != null && m.conversation !== deja.conversation) throw new Occupee(m.conversation); // un identifiant déjà pris ailleurs
      return { generation: deja, motif: null };
    }
    // Une reprise ne compte pas ; un nouveau message, si (chapitre 18).
    this.limiter(this.messagesParMinute, "messages_par_minute", adresse);

    const prompt = this.chargerPrompt(); // relu à chaque message : Awa a pu changer son catalogue
    let conversation = m.conversation ?? null;
    let motif: string | null = null;
    if (conversation && this.conversations.existe(conversation)) {
      motif = this.conversations.motifDeCloture(conversation, prompt.identifiant);
    } else {
      motif = conversation ? "inconnue" : null;
    }
    if (!conversation || motif) {
      this.limiter(this.conversationsParHeure, "conversations_par_heure", adresse);
      conversation = this.conversations.creer(prompt.identifiant);
    }

    // Une réponse à la fois par conversation : sinon deux réponses écrites sans se voir entreraient
    // dans le même historique, et Claude relirait un passé qu'il n'a pas vécu.
    for (const g of this.generations.values()) if (g.conversation === conversation && g.fin === null) throw new Occupee(conversation);

    const generation = new Generation(conversation);
    this.generations.set(m.id_message, generation);
    // Une erreur imprévue ne doit ni arrêter le serveur (Node le ferait, pour une promesse rejetée sans
    // gestionnaire), ni laisser le client attendre une fin qui ne viendrait pas.
    generation.tache = this.produire(generation, m.texte, prompt, adresse).catch((erreur: unknown) => {
      console.error("Réponse impossible :", erreur);
      if (generation.fin === null) generation.terminer({ type: "erreur", message: INDISPONIBLE });
    });
    return { generation, motif };
  }

  /** Compte l'entrée (gratuit) et réserve le coût maximal. Rend [réservation, maximum] ou null. */
  private async reserver(
    generation: Generation,
    requete: Anthropic.MessageCreateParamsNonStreaming,
    adresse: string,
  ): Promise<[string, number] | null> {
    let entree: number;
    try {
      entree = (await this.client.messages.countTokens(requeteDeComptage(requete))).input_tokens;
    } catch (erreur) {
      const d = diagnostiquer(erreur);
      noterEvenement("comptage_impossible", { client: generation.conversation, erreur: d.code, origine: d.origine });
      generation.terminer({ type: "erreur", message: d.pourLeClient });
      return null;
    }
    const maximum = coutMaximal(requete.model, entree, requete.max_tokens, dureeCache(requete));
    const decision = this.budget.reserver(generation.conversation, maximum, `adresse:${adresse}`);
    if (!decision.accepte) {
      noterEvenement("hors_budget", { motif: decision.motif, client: generation.conversation });
      generation.terminer({ type: "erreur", message: INDISPONIBLE });
      return null;
    }
    if (decision.alerte) {
      console.warn(`Budget : seuil d'alerte franchi (jour ${this.budget.duJour().toFixed(4)} $, mois ${this.budget.duMois().toFixed(4)} $)`);
    }
    return [decision.reservation!, maximum];
  }

  private async produire(generation: Generation, texte: string, prompt: PromptSysteme, adresse: string): Promise<void> {
    const historique = this.conversations.historique(generation.conversation);
    const requete = construireRequete(texte, { historique, prompt });
    const reserve = await this.reserver(generation, requete, adresse);
    if (reserve === null) return;
    const [reservation, maximum] = reserve;
    let resultat;
    try {
      resultat = await diffuser(this.client, requete, generation, prompt.identifiant);
    } catch (erreur) {
      // Rien n'est écrit dans l'historique : la question pourra être reposée telle quelle.
      const d = diagnostiquer(erreur);
      console.error(`Réponse impossible (${d.code}, origine : ${d.origine}) :`, erreur);
      // Refusée par l'API avant d'écrire quoi que ce soit : rien n'est facturé.
      if (erreur instanceof Anthropic.APIError && erreur.status !== undefined && !generation.morceaux.length) {
        this.budget.liberer(reservation);
      }
      generation.terminer({ type: "erreur", message: d.pourLeClient });
      return;
    }

    // Après une reprise, le coût de l'appel coupé n'est pas connu : on garde le maximum réservé.
    this.budget.regler(reservation, resultat.repris ? maximum : resultat.cout.dollars);
    const { message } = resultat;
    if (message.stop_reason === "refusal") {
      // Le texte déjà affiché est à jeter, et le tour n'entre pas dans l'historique.
      generation.terminer({ type: "refus", message: REFUS });
      return;
    }
    // Cas normal : la réponse telle quelle, blocs de réflexion compris. Après une reprise, le texte
    // complet, en un seul bloc : la réflexion d'un flux coupé ne se recolle pas.
    const contenu = resultat.repris ? [{ type: "text", text: generation.texte }] : message.content;
    const question = requete.messages[historique.length]!; // le message du client, tel qu'envoyé
    const u = message.usage;
    const tokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
    this.conversations.ajouterTour(generation.conversation, [question, { role: "assistant", content: contenu }], tokens);
    info("Réponse %s : %s", generation.conversation.slice(0, 8), String(resultat.cout));
    // Le coût reste côté serveur (journal) : le client d'Awa n'a pas à le voir.
    generation.terminer({ type: "fin", tronquee: message.stop_reason === "max_tokens" });
  }
}

/**
 * Un événement SSE. Les données sont en JSON : un retour à la ligne dans le texte de Claude ne peut donc
 * pas casser le format, où une ligne vide sépare les événements.
 */
export function evenementSse(nom: string, donnees: object, identifiant?: number): string {
  const lignes = [`event: ${nom}`];
  if (identifiant !== undefined) lignes.push(`id: ${identifiant}`);
  lignes.push(`data: ${JSON.stringify(donnees)}`);
  return lignes.join("\n") + "\n\n";
}

export async function fluxSse(flux: SSEStreamingApi, generation: Generation, motif: string | null, depuis: number): Promise<void> {
  await flux.write(evenementSse("conversation", { conversation: generation.conversation, renouvelee: motif }));
  for await (const [nature, rang, valeur] of generation.suivre(depuis)) {
    if (flux.aborted) return; // la réponse continue de s'écrire ; une nouvelle connexion la reprendra
    if (nature === "texte") await flux.write(evenementSse("texte", { texte: valeur }, rang));
    else if (nature === "silence") await flux.write(": en vie\n\n"); // un commentaire SSE : ignoré par le navigateur, mais il passe
    else await flux.write(evenementSse((valeur as Fin).type, valeur as Fin));
  }
}

/** Chapitre 18 : la suppression promise au chapitre 6, faite pour de bon. */
function purger(comptoir: Comptoir): void {
  try {
    noterEvenement("purge", { conversations: comptoir.conversations.purger() });
  } catch (erreur) {
    console.error("Purge des conversations impossible :", erreur);
  }
}

/**
 * Chapitre 18 : un corps trop gros est refusé (413). Devant le Comptoir, Caddy fait de même (directive
 * request_body, max_size) ; la vérification reste ici, au cas où. Le middleware bodyLimit de Hono lit
 * Content-Length, et compte aussi les octets d'un corps envoyé en morceaux, qui n'en a pas (la correction
 * du chapitre 19 en Python). `maximum` donne la limite d'un chemin, lue à chaque requête dans config.
 */
export function tailleMaximale(maximum: (chemin: string) => number = () => config.TAILLE_MAX_REQUETE): MiddlewareHandler {
  return (c, next) =>
    bodyLimit({ maxSize: maximum(c.req.path), onError: (c) => c.json({ erreur: "Message trop long." }, 413) })(c, next);
}

export type Env = { Bindings: HttpBindings };

/**
 * L'adresse du client, vue du serveur Node (ou passée par les tests), puis corrigée par X-Forwarded-For.
 * relaisDeConfiance (chapitre 19, derrière Caddy) : le voisin direct est un relais, son en-tête fait foi.
 */
export function adresse(c: Context<Env>, relaisDeConfiance = false): string {
  const hote = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket?.remoteAddress;
  const relais = relaisDeConfiance && hote ? [...config.PROXIES_DE_CONFIANCE, hote] : config.PROXIES_DE_CONFIANCE;
  return adresseDuClient(hote, c.req.header("x-forwarded-for"), relais);
}

export function refusDeLimite(c: Context, limite: TropDeMessages): Response {
  c.header("Retry-After", String(Math.trunc(limite.attente) + 1));
  return c.json({ erreur: "Beaucoup de messages en peu de temps : réessayez dans une minute." }, 429);
}

export interface Serveur {
  app: Hono<Env>;
  comptoir: Comptoir;
  /** Lance la purge (au démarrage puis chaque jour) ; rend de quoi l'arrêter. */
  demarrer(): () => void;
}

export function creerApp(
  client?: ClientFlux,
  conversations?: Conversations,
  budget?: Budget,
  chargerPrompt?: () => PromptSysteme,
): Serveur {
  const comptoir = new Comptoir(client, conversations, budget, chargerPrompt);
  const app = new Hono<Env>();
  app.use("*", tailleMaximale());

  // La page de la version Python, servie telle quelle (fins de ligne normalisées, comme Python la lit).
  app.get("/", (c) => c.html(readFileSync(join(PYTHON, "comptoir", "pages", "comptoir.html"), "utf8").replace(/\r\n/g, "\n")));

  app.post("/api/messages", async (c) => {
    const lu = Message.safeParse(await c.req.json().catch(() => null));
    if (!lu.success) return c.json({ erreur: "Message refusé." }, 422);
    const m = lu.data;
    let lance;
    try {
      lance = comptoir.lancer(m, adresse(c));
    } catch (erreur) {
      if (erreur instanceof Occupee) return c.json({ erreur: "Une réponse est déjà en cours." }, 409);
      if (erreur instanceof TropDeMessages) return refusDeLimite(c, erreur);
      throw erreur;
    }
    // X-Accel-Buffering : demande à un proxy nginx de transmettre chaque morceau sans attendre d'en avoir
    // plein. streamSSE ajoute Content-Type: text/event-stream et Cache-Control: no-cache.
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, (flux) => fluxSse(flux, lance.generation, lance.motif, m.depuis));
  });

  /** La même conversation par WebSocket : une connexion ouverte dans les deux sens. */
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const ici = adresse(c as Context<Env>);
      let ouverte = true;
      let file = Promise.resolve(); // un message après l'autre, comme la boucle de la version Python
      return {
        onMessage(evenement, ws) {
          file = file.then(async () => {
            let lance;
            let m: Message;
            try {
              const lu = Message.safeParse(JSON.parse(String(evenement.data)));
              if (!lu.success) throw lu.error;
              m = lu.data;
              lance = comptoir.lancer(m, ici);
            } catch {
              ws.send(JSON.stringify({ type: "erreur", message: "Message refusé ou réponse déjà en cours." }));
              return;
            }
            ws.send(JSON.stringify({ type: "conversation", conversation: lance.generation.conversation, renouvelee: lance.motif }));
            for await (const [nature, rang, valeur] of lance.generation.suivre(m.depuis)) {
              if (!ouverte) return; // la réponse continue de s'écrire ; une nouvelle connexion la reprendra
              if (nature === "texte") ws.send(JSON.stringify({ type: "texte", rang, texte: valeur }));
              else if (nature === "silence") ws.send(JSON.stringify({ type: "en_vie" }));
              else ws.send(JSON.stringify(valeur));
            }
          });
        },
        onClose() {
          ouverte = false;
        },
      };
    }),
  );

  const demarrer = (): (() => void) => {
    purger(comptoir);
    const minuterie = setInterval(() => purger(comptoir), PURGE_S * 1000);
    return () => clearInterval(minuterie);
  };
  return { app, comptoir, demarrer };
}

/** Le serveur Node : HTTP et WebSocket sur le même port, puis la purge quotidienne. */
export function servir(
  { app, demarrer }: Serveur = creerApp(),
  port = Number(process.env.PORT ?? 8000),
  hote = process.env.HOTE ?? "127.0.0.1",
) {
  const websockets = new WebSocketServer({ noServer: true });
  const serveur = serve({ fetch: app.fetch, port, hostname: hote, websocket: { server: websockets } }, (adresse) =>
    console.log(`Le Comptoir d'Awa : http://${hote}:${adresse.port}`),
  );
  const arreterLaPurge = demarrer();
  const arreter = () => {
    arreterLaPurge();
    serveur.close(() => process.exit(0));
  };
  process.on("SIGINT", arreter);
  process.on("SIGTERM", arreter);
  return serveur;
}

if (estLance(import.meta.url)) servir();
