// Le Comptoir en ligne (chapitre 19) : le chat web et WhatsApp, sur le Comptoir livré.
//
//     npx tsx comptoir/en_ligne.ts --port 8019          (en local, depuis le dossier typescript/)
//
// Ce qui change par rapport au chat du chapitre 6 (comptoir/web.ts, gardé pour son exemple de flux) :
// - les deux canaux passent par le Comptoir aiguillé, avec ses outils, sa confirmation par code et ses
//   gardes (comptoir/service.ts) ; la réponse arrive d'un bloc, pas mot à mot, car la boucle d'outils
//   doit finir avant qu'on sache ce qui a été fait ;
// - un message à la fois pour tout le serveur : ce qui touche aux bases (ouvrir une conversation, écarter
//   un doublon, répondre, purger) attend son tour dans une seule file, le « fil » du Comptoir, comme le fil
//   unique de la version Python ;
// - WhatsApp : webhook vérifié et signé, réponse par l'API de Meta, numéro gardé dans l'annuaire seulement ;
// - le tableau de bord (/tableau, avec un jeton) et la santé du service (/sante) ;
// - la surveillance du chapitre 18, si elle est activée, à côté de la réponse ;
// - les limites et la purge du chapitre 18, pour les deux canaux.

import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { OptionsAiguillage } from "./aiguillage.ts";
import { arrondir } from "./arrondi.ts";
import { Boutique } from "./boutique.ts";
import { Budget } from "./budget.ts";
import type { ClientMessages } from "./client.ts";
import { config } from "./config.ts";
import { type Morceau, chargerBase } from "./connaissances.ts";
import { Conversations } from "./conversations.ts";
import { INDISPONIBLE } from "./erreurs.ts";
import { Generation } from "./flux.ts";
import { noterEvenement } from "./journal.ts";
import { PYTHON, estLance } from "./lancement.ts";
import { Limiteur } from "./limites.ts";
import { ServiceComptoir } from "./service.ts";
import { surveiller } from "./surveillance.ts";
import { charger as chargerJournal, enHtml } from "./tableau.ts";
import { type Env, GARDE_S, Message, TropDeMessages, adresse, fluxSse, refusDeLimite, tailleMaximale } from "./web.ts";
import * as whatsapp from "./whatsapp.ts";

export const PURGE_S = 24 * 3600;

const nomDe = (erreur: unknown): string => (erreur as object | null)?.constructor?.name ?? typeof erreur;

/** Ce qu'on peut fournir au serveur (les tests fournissent tout) ; le reste est créé au premier usage. */
export interface Reglages {
  client?: ClientMessages;
  boutique?: Boutique;
  budget?: Budget;
  conversations?: Conversations;
  base?: Morceau[];
  annuaire?: whatsapp.Annuaire;
  expediteur?: Pick<whatsapp.Expediteur, "envoyer">;
  /** Les options du Comptoir aiguillé (versionPrompt, effortComptoir, cache…), pour une variante. */
  options?: OptionsAiguillage;
}

/** L'état du serveur : le service, les canaux, les limites, les réponses en cours sur le web. */
export class EnLigne {
  readonly generations = new Map<string, Generation>();
  readonly messagesParMinute = new Limiteur(config.LIMITE_MESSAGES_MINUTE, 60);
  readonly conversationsParHeure = new Limiteur(config.LIMITE_CONVERSATIONS_HEURE, 3600);
  private fil: Promise<unknown> = Promise.resolve();
  private readonly surveillances = new Set<Promise<void>>();
  private _service: ServiceComptoir | null = null;
  private arrete = false;

  constructor(private readonly reglages: Reglages = {}) {}

  // Créés au premier usage : importer ce module ne lit ni la clé ni les bases.
  get client(): ClientMessages {
    return (this.reglages.client ??= new Anthropic({ timeout: config.DELAI_S * 1000, maxRetries: config.REESSAIS }));
  }

  get service(): ServiceComptoir {
    const r = this.reglages;
    return (this._service ??= new ServiceComptoir(
      this.client, r.boutique ?? new Boutique(config.BOUTIQUE), r.budget ?? new Budget(config.BUDGET),
      r.conversations ?? new Conversations(config.CONVERSATIONS), r.base ?? chargerBase(), r.options ?? {},
    ));
  }

  get annuaire(): whatsapp.Annuaire {
    return (this.reglages.annuaire ??= new whatsapp.Annuaire(config.CONVERSATIONS));
  }

  get expediteur(): Pick<whatsapp.Expediteur, "envoyer"> {
    return (this.reglages.expediteur ??= new whatsapp.Expediteur(config.WHATSAPP_JETON, config.WHATSAPP_VERSION_API));
  }

  /** Une tâche dans le fil du Comptoir : elle attend que les précédentes soient finies. */
  dansLeFil<T>(tache: () => T | Promise<T>): Promise<T> {
    if (this.arrete) return Promise.reject(new Error("Le serveur s'arrête."));
    const suivante = this.fil.then(tache);
    this.fil = suivante.catch(() => {});
    return suivante;
  }

  /** Attendre la fin de tout ce qui est dans le fil (pour les tests, et avant de s'arrêter). */
  async attendreLeFil(): Promise<void> {
    let avant: Promise<unknown>;
    do {
      avant = this.fil;
      await avant;
    } while (avant !== this.fil);
  }

  /** Attendre la fin des examens de surveillance en cours. */
  async attendreLaSurveillance(): Promise<void> {
    await Promise.all(this.surveillances);
  }

  /** Les messages en file sont finis avant l'arrêt : Meta a déjà reçu son 200 et ne les renverra pas. */
  async arreter(): Promise<void> {
    await this.attendreLeFil();
    this.arrete = true;
  }

  limiter(limiteur: Limiteur, motif: string, cle: string): void {
    const attente = limiteur.accepter(cle);
    if (attente !== null) {
      noterEvenement("limite", { motif, adresse: cle });
      throw new TropDeMessages(motif, attente);
    }
  }

  surveiller(texte: string, conversation: string, canal: string, groupe: string | null = null): void {
    if (!config.FILTRE_SURVEILLANCE) return;
    // À côté de la réponse : l'appel à Claude ne la retarde pas. La dépense, elle, est comptée dans le fil
    // du Comptoir, comme tout ce qui touche aux bases (chapitre 20).
    const examen = surveiller(this.client, texte, conversation, canal).then(async ([, dollars]) => {
      if (!dollars) return;
      await this.dansLeFil(() => this.compterSurveillance(conversation, groupe, dollars, canal)).catch(() => {
        // le serveur s'arrête : l'appel reste au journal, avec son coût
      });
    });
    this.surveillances.add(examen);
    void examen.finally(() => this.surveillances.delete(examen));
  }

  compterSurveillance(conversation: string, groupe: string | null, dollars: number, canal: string): void {
    try {
      this.service.budget.ajouter(conversation, dollars, groupe);
    } catch (erreur) {
      // Une erreur ici ne remonte nulle part : on la note (relecture de Claude, chapitre 20).
      noterEvenement("surveillance_impossible", { conversation, canal, erreur: nomDe(erreur), cout_dollars: arrondir(dollars, 6) });
      return;
    }
    noterEvenement("surveillance", { conversation, canal, cout_dollars: arrondir(dollars, 6) });
  }

  // --- Le chat web ------------------------------------------------------------------------------

  async lancerWeb(m: Message, ici: string): Promise<[Generation, string | null]> {
    const limite = performance.now() - GARDE_S * 1000;
    for (const [cle, g] of this.generations) if (g.termineeLe !== null && g.termineeLe < limite) this.generations.delete(cle);
    let deja = this.generations.get(m.id_message);
    if (deja) return [deja, null]; // le même message, renvoyé après une coupure : on rattache
    this.limiter(this.messagesParMinute, "messages_par_minute", ici);
    const [conversation, motif] = await this.dansLeFil(() => this.ouvrirWeb(m.conversation ?? null, ici));
    deja = this.generations.get(m.id_message);
    if (deja) return [deja, null]; // arrivé deux fois pendant l'attente : on rattache au premier
    const generation = new Generation(conversation);
    this.generations.set(m.id_message, generation);
    generation.tache = this.produireWeb(generation, m.texte, ici);
    return [generation, motif];
  }

  /** Dans le fil du Comptoir : la conversation existe-t-elle, en ouvrir une, compter les neuves. */
  private ouvrirWeb(conversation: string | null, ici: string): [string, string | null] {
    if (!conversation || !this.service.conversations.existe(conversation)) this.limiter(this.conversationsParHeure, "conversations_par_heure", ici);
    const [ouverte, motif] = this.service.ouvrir(conversation);
    return [ouverte, motif];
  }

  private async produireWeb(generation: Generation, texte: string, ici: string): Promise<void> {
    this.surveiller(texte, generation.conversation, "web", `adresse:${ici}`);
    let tour;
    try {
      tour = await this.dansLeFil(() => this.service.repondre(generation.conversation, texte, "web", `adresse:${ici}`));
    } catch (erreur) {
      console.error("Réponse impossible :", erreur);
      generation.terminer({ type: "erreur", message: INDISPONIBLE });
      return;
    }
    generation.ajouter(tour.texte);
    generation.terminer({ type: "fin", tronquee: false });
  }

  // --- WhatsApp ---------------------------------------------------------------------------------

  /** Dans le fil du Comptoir : une réponse par message, envoyée par l'API de Meta. */
  async traiterWhatsapp(message: whatsapp.MessageEntrant): Promise<void> {
    try {
      await this.traiterUnMessage(message);
    } catch (erreur) {
      // Une erreur dans le fil ne remonte nulle part : sans cette trace, le client attendrait en silence.
      console.error("Message WhatsApp non traité :", erreur);
      noterEvenement("whatsapp_traitement", { erreur: nomDe(erreur) });
    }
  }

  private async traiterUnMessage(message: whatsapp.MessageEntrant): Promise<void> {
    if (!this.annuaire.nouveau(message.identifiant)) return; // Meta réessaie : un message n'est traité qu'une fois
    const pseudo = whatsapp.pseudonyme(message.numero, config.SEL_PSEUDONYMES);
    try {
      this.limiter(this.messagesParMinute, "messages_par_minute", pseudo);
    } catch (erreur) {
      if (erreur instanceof TropDeMessages) return; // un script, pas un client : pas de réponse, pas de coût
      throw erreur;
    }
    const [conversation, , nouvelle] = this.service.ouvrir(this.annuaire.conversation(pseudo));
    this.annuaire.lier(pseudo, message.numero, conversation);
    let texte: string;
    if (message.type !== "text" || !message.texte) {
      texte = whatsapp.NON_TEXTE;
    } else {
      this.surveiller(message.texte, conversation, "whatsapp", pseudo);
      texte = (await this.service.repondre(conversation, message.texte, "whatsapp", pseudo)).texte;
    }
    if (nouvelle) texte = `${whatsapp.MENTION_IA}\n\n${texte}`;
    try {
      await this.expediteur.envoyer(message.numeroEntreprise, message.numero, texte);
      noterEvenement("whatsapp_envoi", { conversation });
    } catch (erreur) {
      noterEvenement("whatsapp_envoi", { conversation, erreur: nomDe(erreur), statut: (erreur as { statut?: number }).statut ?? null });
    }
  }

  purger(): Record<string, number> {
    const resultat: Record<string, number> = this.service.boutique.purger(
      config.CONSERVATION_DEMANDES_J, config.CONSERVATION_NOMS_J, config.CONSERVATION_RECAPITULATIFS_J,
    );
    resultat.conversations = this.service.conversations.purger();
    resultat.clients_whatsapp = this.annuaire.purger(config.CONSERVATION_J);
    return resultat;
  }
}

const jetonValide = (autorisation: string | undefined): boolean => Boolean(config.TABLEAU_JETON) && autorisation === `Bearer ${config.TABLEAU_JETON}`;

export interface ServeurEnLigne {
  app: Hono<Env>;
  etat: EnLigne;
  /** Lance la purge (au démarrage puis chaque jour) ; rend de quoi l'arrêter. */
  demarrer(): () => void;
}

/** relaisDeConfiance : derrière Caddy, seul à joindre le serveur, son en-tête X-Forwarded-For fait foi. */
export function creerApp(reglages: Reglages = {}, { relaisDeConfiance = false } = {}): ServeurEnLigne {
  const etat = new EnLigne(reglages);
  const app = new Hono<Env>();

  // Chapitre 18 : un corps trop gros est refusé, même envoyé en morceaux. WhatsApp a sa propre limite :
  // Meta envoie des notifications jusqu'à 3 Mo.
  app.use("*", tailleMaximale((chemin) => (chemin === "/whatsapp" ? config.TAILLE_MAX_WEBHOOK : config.TAILLE_MAX_REQUETE)));

  // La page de la version Python, servie telle quelle (fins de ligne normalisées, comme Python la lit).
  app.get("/", (c) => c.html(readFileSync(join(PYTHON, "comptoir", "pages", "comptoir.html"), "utf8").replace(/\r\n/g, "\n")));

  app.post("/api/messages", async (c) => {
    const lu = Message.safeParse(await c.req.json().catch(() => null));
    if (!lu.success) return c.json({ erreur: "Message refusé." }, 422);
    const m = lu.data;
    let lance: [Generation, string | null];
    try {
      lance = await etat.lancerWeb(m, adresse(c, relaisDeConfiance));
    } catch (erreur) {
      if (erreur instanceof TropDeMessages) return refusDeLimite(c, erreur);
      throw erreur;
    }
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, (flux) => fluxSse(flux, lance[0], lance[1], m.depuis));
  });

  /** La vérification de Meta : rendre hub.challenge si le jeton est le bon. */
  app.get("/whatsapp", (c) => {
    if (config.WHATSAPP_JETON_VERIFICATION && c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === config.WHATSAPP_JETON_VERIFICATION) {
      return c.text(c.req.query("hub.challenge") ?? "");
    }
    return c.text("Refusé", 403);
  });

  app.post("/whatsapp", async (c) => {
    const corps = new Uint8Array(await c.req.arrayBuffer());
    if (!whatsapp.signatureValide(corps, c.req.header("x-hub-signature-256"), config.WHATSAPP_SECRET_APP)) {
      noterEvenement("whatsapp_signature_invalide");
      return c.text("Signature invalide", 401);
    }
    if (!config.SEL_PSEUDONYMES) {
      // Sans sel, l'empreinte d'un numéro se retrouve en essayant tous les numéros possibles : on ne traite
      // rien. Meta, qui reçoit 503, renvoie la notification pendant 7 jours (chapitre 20).
      noterEvenement("whatsapp_non_configure", { manque: "COMPTOIR_SEL_PSEUDONYMES" });
      return c.text("WhatsApp n'est pas encore configuré", 503);
    }
    let entrants: whatsapp.MessageEntrant[];
    try {
      entrants = whatsapp.messagesEntrants(JSON.parse(new TextDecoder().decode(corps)));
    } catch {
      return c.text("Corps illisible", 400);
    }
    // Confié au fil du Comptoir, sans l'attendre : Meta reçoit son 200 tout de suite. Le doublon est écarté
    // dans le fil, comme tout ce qui touche aux bases.
    for (const message of entrants) void etat.dansLeFil(() => etat.traiterWhatsapp(message)).catch(() => {});
    return c.text("ok");
  });

  app.get("/tableau", (c) => {
    if (!jetonValide(c.req.header("authorization"))) return c.text("Accès réservé", 401);
    return c.html(enHtml(chargerJournal()));
  });

  app.get("/sante", (c) => c.json({ etat: "ok" }));

  const purgerUneFois = async (): Promise<void> => {
    try {
      noterEvenement("purge", await etat.dansLeFil(() => etat.purger()));
    } catch (erreur) {
      console.error("Purge impossible :", erreur);
    }
  };
  const demarrer = (): (() => void) => {
    void purgerUneFois();
    const minuterie = setInterval(() => void purgerUneFois(), PURGE_S * 1000);
    return () => clearInterval(minuterie);
  };
  return { app, etat, demarrer };
}

/** Le serveur Node, puis la purge quotidienne ; à l'arrêt, les messages en file sont finis d'abord. */
export function servir(serveur: ServeurEnLigne, port: number, hote: string) {
  const http = serve({ fetch: serveur.app.fetch, port, hostname: hote }, (a) => console.log(`Le Comptoir en ligne : http://${hote}:${a.port}`));
  const arreterLaPurge = serveur.demarrer();
  const arreter = (): void => {
    arreterLaPurge();
    // compose.yaml laisse 30 secondes au conteneur pour s'arrêter.
    http.close();
    void serveur.etat.arreter().finally(() => process.exit(0));
  };
  process.on("SIGINT", arreter);
  process.on("SIGTERM", arreter);
  return http;
}

if (estLance(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      port: { type: "string", default: "8019" },
      hote: { type: "string", default: "127.0.0.1" },
      // Derrière Caddy, qui termine le HTTPS : faire confiance à son en-tête X-Forwarded-For (un relais).
      "derriere-un-relais": { type: "boolean", default: false },
    },
  });
  servir(creerApp({}, { relaisDeConfiance: args["derriere-un-relais"] }), Number(args.port), args.hote);
}
