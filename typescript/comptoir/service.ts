// Le Comptoir livré, derrière ses canaux (chapitre 19) : le chat web et WhatsApp.
//
// Jusqu'ici, le chat web du chapitre 6 parlait à un assistant sans outils, et le Comptoir aiguillé ne
// vivait que dans les bancs d'essai, une conversation en mémoire. En ligne, chaque message :
// 1. retrouve sa conversation dans la base (comptoir/conversations.ts), ou en ouvre une ;
// 2. réserve son coût dans le budget, pour le message entier ;
// 3. passe par le Comptoir aiguillé (chapitre 12), avec ses outils, sa confirmation par code et ses gardes ;
// 4. ajoute à la conversation ce que le tour a produit, sans rien réécrire, puis règle le coût réel ;
// 5. laisse dans le journal un événement « message » : canal, catégorie, coût de toutes les étapes, durée.
//    C'est ce que lit le tableau de bord : le coût par conversation, la latence par message.
//
// Pourquoi le budget au niveau du message : depuis l'aiguilleur, le routage, l'assistant documentaire et
// la chaîne des réclamations appellent Claude sans passer par comptoir/appel.ts ; le budget du chapitre 8
// ne voyait que les appels du Comptoir lui-même. Le service réserve donc un plafond par message, avec le
// quota du client et celui de son groupe (son adresse sur le web, son numéro sur WhatsApp), puis règle
// ce que la trace a vraiment coûté, toutes étapes comprises.
//
// Un message à la fois pour tout le Comptoir : les messages attendent leur tour dans une file. Les bases
// SQLite sont partagées, et le tour d'un client ne doit pas croiser celui d'un autre. À 40 conversations
// par jour, l'attente est rare ; au-delà, une base comme PostgreSQL.

import Anthropic from "@anthropic-ai/sdk";
import { ComptoirAiguille, type OptionsAiguillage } from "./aiguillage.ts";
import { arrondir } from "./arrondi.ts";
import type { Boutique } from "./boutique.ts";
import { Budget } from "./budget.ts";
import type { ClientMessages } from "./client.ts";
import type { Morceau } from "./connaissances.ts";
import type { Conversations, MessageHistorique } from "./conversations.ts";
import { INDISPONIBLE, ErreurComptoir, diagnostiquer } from "./erreurs.ts";
import { noterEvenement } from "./journal.ts";
import { charger } from "./prompt.ts";
import { jsonPython } from "./python.ts";

// Le plafond réservé pour un message, avant de connaître son coût : large devant les coûts mesurés
// (0,0009 $ par message en moyenne sur le Comptoir livré, au chapitre 17 ; une réclamation, rédigée par
// Claude Sonnet 5.5, quelques millièmes de dollar).
export const RESERVE_MESSAGE = 0.02;
export const TOKENS_DE_LA_BASE = 7000; // la base d'Awa, jointe à chaque requête (environ 6 900 tokens, chapitre 17)

export interface Tour {
  texte: string;
  conversation: string;
  categorie: string;
  coutDollars: number;
  dureeMs: number;
  erreur: string | null;
}

const tour = (texte: string, conversation: string, categorie: string, autres: Partial<Tour> = {}): Tour => ({
  texte, conversation, categorie, coutDollars: 0, dureeMs: 0, erreur: null, ...autres,
});

/**
 * La taille du contexte, à peu près : environ 3 caractères par token en français, plus la base. Elle sert
 * seulement à fermer une conversation trop longue (config.CONTEXTE_MAX).
 */
export const estimerTokens = (historique: unknown[]): number => Math.floor([...jsonPython(historique)].length / 3) + TOKENS_DE_LA_BASE;

export class ServiceComptoir {
  readonly prompt: string;
  private file: Promise<unknown> = Promise.resolve();

  /** options : celles de ComptoirAiguille (versionPrompt, effortComptoir, cache…), pour une variante. */
  constructor(
    readonly client: ClientMessages,
    readonly boutique: Boutique,
    readonly budget: Budget,
    readonly conversations: Conversations,
    readonly base: Morceau[],
    readonly options: OptionsAiguillage = {},
  ) {
    this.prompt = charger(options.versionPrompt ?? "v5").identifiant;
  }

  /** [la conversation à utiliser, le motif si l'ancienne était close, true si elle est neuve]. */
  ouvrir(conversation: string | null | undefined): [string, string | null, boolean] {
    let motif: string | null = null;
    if (conversation && this.conversations.existe(conversation)) {
      motif = this.conversations.motifDeCloture(conversation, this.prompt);
      if (motif === null) return [conversation, null, false];
    } else if (conversation) {
      motif = "inconnue";
    }
    return [this.conversations.creer(this.prompt), motif, true];
  }

  /** Un message après l'autre : chaque réponse attend que la précédente soit finie. */
  repondre(conversation: string, texte: string, canal: string, groupe: string | null = null): Promise<Tour> {
    const suivant = this.file.then(() => this.repondreMaintenant(conversation, texte, canal, groupe));
    this.file = suivant.catch(() => {});
    return suivant;
  }

  private async repondreMaintenant(conversation: string, texte: string, canal: string, groupe: string | null): Promise<Tour> {
    const decision = this.budget.reserver(conversation, RESERVE_MESSAGE, groupe);
    if (!decision.accepte) {
      noterEvenement("hors_budget", { motif: decision.motif, client: conversation, canal });
      return tour(INDISPONIBLE, conversation, "hors_budget", { erreur: decision.motif });
    }
    const historique: MessageHistorique[] = this.conversations.historique(conversation);
    // Le budget de chaque appel est tenu ici, au niveau du message : le Comptoir reçoit un budget vierge,
    // qui ne refuse rien et ne compte rien deux fois.
    const comptoir = new ComptoirAiguille(this.client, this.boutique, new Budget(":memory:"), conversation, this.base, this.options);
    comptoir.comptoir.historique.push(...historique);
    const debut = performance.now();
    let reponse;
    try {
      reponse = await comptoir.repondre(texte);
    } catch (erreur) {
      // L'aiguilleur, l'assistant documentaire et les réclamations appellent Claude hors de comptoir/appel.ts
      // (chapitre 12) : leurs erreurs arrivent brutes. Le diagnostic du chapitre 8 se fait donc ici aussi.
      if (!(erreur instanceof ErreurComptoir || erreur instanceof Anthropic.APIError)) throw erreur;
      const diagnostic = erreur instanceof ErreurComptoir ? erreur.diagnostic : diagnostiquer(erreur);
      const duree = arrondir(performance.now() - debut);
      // Le coût d'un échec n'est pas connu du code : la réservation reste, la Console fait foi.
      noterEvenement("message", { canal, conversation, erreur: diagnostic.code, origine: diagnostic.origine, duree_ms: duree });
      return tour(diagnostic.pourLeClient, conversation, "erreur", { dureeMs: duree, erreur: diagnostic.code });
    }
    const nouveaux = comptoir.comptoir.historique.slice(historique.length);
    if (nouveaux.length) this.conversations.ajouterTour(conversation, nouveaux, estimerTokens(comptoir.comptoir.historique));
    const cout = reponse.trace.cout;
    this.budget.regler(decision.reservation!, cout);
    noterEvenement("message", {
      canal, conversation, categorie: reponse.categorie, cout_dollars: arrondir(cout, 6), duree_ms: reponse.trace.dureeMs, etapes: reponse.trace.etapes.length,
    });
    return tour(reponse.texte, conversation, reponse.categorie, { coutDollars: cout, dureeMs: reponse.trace.dureeMs });
  }
}
