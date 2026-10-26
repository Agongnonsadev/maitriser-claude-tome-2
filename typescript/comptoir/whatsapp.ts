// Le Comptoir sur WhatsApp (chapitre 19) : l'API Cloud de Meta, d'après sa documentation du 22 octobre 2026.
//
// - Vérification du webhook : Meta envoie un GET avec hub.mode=subscribe, hub.verify_token et
//   hub.challenge ; on rend hub.challenge, statut 200, si le jeton est le bon.
// - Signature : chaque notification porte X-Hub-Signature-256, « sha256= » suivi du HMAC-SHA256 du corps,
//   calculé avec le secret de l'application. Une notification mal signée est refusée.
// - Messages entrants : entry[].changes[].value.messages[], avec from (le numéro), id (wamid…), type, text.body ;
//   metadata.phone_number_id dit à quel numéro de l'entreprise répondre. Les statuts (envoyé, lu) sont ignorés.
// - Doublons : Meta réessaie pendant 7 jours une notification qui n'a pas reçu un 200, et peut l'envoyer
//   deux fois ; chaque message n'est traité qu'une fois (Annuaire.nouveau).
// - Réponse : POST https://graph.facebook.com/<version>/<phone_number_id>/messages, texte de 4 096
//   caractères au plus, seulement dans la fenêtre de service de 24 heures ouverte par le client.
//
// Le numéro d'un client est une donnée personnelle : il ne quitte pas l'annuaire (Annuaire), ni vers le
// journal, ni vers le budget. Ailleurs, on écrit son empreinte (pseudonyme). Les tables de l'annuaire sont
// celles de la version Python : une même base sert aux deux.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isoformat, ouvrirBase, transaction } from "./base.ts";

export const GRAPH = "https://graph.facebook.com";
export const LONGUEUR_MAX = 4096;
// La politique d'utilisation d'Anthropic : dire au client qu'il parle à une IA, au début de chaque
// conversation. Sur le web, la page le dit ; sur WhatsApp, c'est le premier message, écrit par le code.
export const MENTION_IA =
  "Bonjour, je suis le Comptoir, l'assistant automatique de Délices d'Awa : une intelligence " +
  "artificielle, pas une personne. Pour parler à Awa, demandez-le simplement.";
export const NON_TEXTE = "Je ne lis que les messages écrits pour le moment : pouvez-vous m'écrire votre demande ?";

export function signatureValide(corps: Uint8Array, entete: string | null | undefined, secret: string): boolean {
  if (!secret || !entete || !entete.startsWith("sha256=")) return false;
  const attendue = Buffer.from(createHmac("sha256", secret).update(corps).digest("hex"));
  const recue = Buffer.from(entete.slice("sha256=".length));
  // Comme hmac.compare_digest : un temps de comparaison qui ne dit rien de la position d'un écart.
  return attendue.length === recue.length && timingSafeEqual(attendue, recue);
}

/**
 * Une empreinte stable du numéro : de quoi compter et limiter, sans écrire le numéro. Sans sel, elle ne
 * protège rien (les numéros possibles s'essaient tous) : refusée (chapitre 20). La même qu'en Python.
 */
export function pseudonyme(numero: string, sel: string): string {
  if (!sel) throw new Error("Le sel des empreintes (COMPTOIR_SEL_PSEUDONYMES) est vide.");
  return "wa-" + createHmac("sha256", sel).update(numero, "utf8").digest("hex").slice(0, 16);
}

export interface MessageEntrant {
  identifiant: string; //        wamid…, unique : la clé contre les doublons
  numero: string; //             le numéro WhatsApp du client (from)
  numeroEntreprise: string; //   metadata.phone_number_id : le numéro d'Awa qui a reçu le message
  type: string; //               text, image, audio…
  texte: string | null;
  horodatage: number;
}

/** Une notification illisible (un horodatage qui n'est pas un nombre, par exemple) : refusée par le serveur. */
export class NotificationIllisible extends Error {}

type Objet = Record<string, unknown>;
const objet = (x: unknown): Objet => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Objet) : {});
const liste = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** int(texte) de Python : un entier écrit en chiffres, sinon une erreur. */
function entier(valeur: unknown): number {
  if (!valeur) return 0;
  if (typeof valeur === "number" && Number.isInteger(valeur)) return valeur;
  const texte = String(valeur).trim();
  if (!/^[+-]?\d+$/.test(texte)) throw new NotificationIllisible(`horodatage illisible : ${texte}`);
  return Number(texte);
}

export function messagesEntrants(notification: unknown): MessageEntrant[] {
  const sortie: MessageEntrant[] = [];
  for (const entree of liste(objet(notification).entry)) {
    for (const changement of liste(objet(entree).changes)) {
      if (objet(changement).field !== "messages") continue;
      const valeur = objet(objet(changement).value);
      const numeroEntreprise = String(objet(valeur.metadata).phone_number_id ?? "");
      for (const brut of liste(valeur.messages)) {
        const m = objet(brut);
        const texte = objet(m.text).body;
        sortie.push({
          identifiant: String(m.id ?? ""), numero: String(m.from ?? ""), numeroEntreprise, type: String(m.type ?? ""),
          texte: typeof texte === "string" ? texte : null, horodatage: entier(m.timestamp),
        });
      }
    }
  }
  return sortie;
}

/**
 * Un texte trop long pour un seul message, coupé entre deux paragraphes quand c'est possible. Les longueurs
 * se comptent en caractères, comme en Python (et non en unités UTF-16 : un émoji compte pour un).
 */
export function decouper(texte: string, longueur = LONGUEUR_MAX): string[] {
  const morceaux: string[] = [];
  let reste = [...texte];
  while (reste.length > longueur) {
    let coupe = reste.slice(0, longueur).lastIndexOf("\n");
    coupe = coupe > Math.floor(longueur / 2) ? coupe : longueur;
    morceaux.push(reste.slice(0, coupe).join("").trimEnd());
    reste = [...reste.slice(coupe).join("").trimStart()];
  }
  return reste.length ? [...morceaux, reste.join("")] : morceaux;
}

/** Une réponse de Meta en erreur, comme httpx.HTTPStatusError : son statut est noté au journal. */
export class ErreurHttp extends Error {
  constructor(readonly statut: number) {
    super(`Meta a répondu ${statut}`);
  }
}

/** Envoie les réponses par l'API Graph, avec le jeton d'un utilisateur système (jamais dans le code). */
export class Expediteur {
  constructor(
    private readonly jeton: string,
    private readonly version = "v26.0",
    private readonly http: typeof fetch = (entree, options) => fetch(entree, { ...options, signal: AbortSignal.timeout(30_000) }),
  ) {}

  /** Rend les identifiants des messages envoyés ; lève ErreurHttp si Meta refuse. */
  async envoyer(numeroEntreprise: string, numero: string, texte: string): Promise<string[]> {
    const identifiants: string[] = [];
    for (const morceau of decouper(texte)) {
      const r = await this.http(`${GRAPH}/${this.version}/${numeroEntreprise}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.jeton}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: numero, type: "text", text: { body: morceau } }),
      });
      if (!r.ok) throw new ErreurHttp(r.status);
      identifiants.push(...liste(objet(await r.json()).messages).map((m) => objet(m).id as string));
    }
    return identifiants;
  }
}

const maintenant = (): Date => new Date();

/**
 * Pour chaque client WhatsApp : son empreinte, son numéro (pour lui répondre), sa conversation en cours.
 * Dans la même base que les conversations, et purgé avec elles : c'est la seule place du numéro. Garde
 * aussi les messages déjà traités, contre les doublons de Meta.
 */
export class Annuaire {
  readonly db: DatabaseSync;

  constructor(chemin = ":memory:") {
    this.db = ouvrirBase(chemin);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_clients (
          pseudonyme TEXT PRIMARY KEY, numero TEXT NOT NULL, conversation TEXT NOT NULL, vu_le TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS whatsapp_deja_vus (identifiant TEXT PRIMARY KEY, recu_le TEXT NOT NULL);
    `);
  }

  /** Vrai la première fois qu'on voit ce message ; faux pour un doublon. */
  nouveau(identifiant: string): boolean {
    return transaction(this.db, () =>
      this.db.prepare("INSERT OR IGNORE INTO whatsapp_deja_vus VALUES (?, ?)").run(identifiant, isoformat(maintenant())).changes === 1,
    );
  }

  conversation(pseudo: string): string | null {
    const ligne = this.db.prepare("SELECT conversation FROM whatsapp_clients WHERE pseudonyme = ?").get(pseudo);
    return ligne ? String(ligne.conversation) : null;
  }

  lier(pseudo: string, numero: string, conversation: string): void {
    transaction(this.db, () => this.db.prepare("INSERT OR REPLACE INTO whatsapp_clients VALUES (?, ?, ?, ?)").run(pseudo, numero, conversation, isoformat(maintenant())));
  }

  /**
   * Le numéro lié à une conversation qu'un client a demandé d'effacer (chapitre 21 : la commande d'effacement
   * du chapitre 18 oubliait l'annuaire, où le numéro restait).
   */
  effacer(conversation: string): number {
    return Number(transaction(this.db, () => this.db.prepare("DELETE FROM whatsapp_clients WHERE conversation = ?").run(conversation).changes));
  }

  /** Oublie les clients sans message depuis `jours` jours, et les doublons de plus de 8 jours (Meta ne réessaie que pendant 7 jours). */
  purger(jours: number, instant: Date = maintenant()): number {
    const avant = (j: number): string => isoformat(new Date(instant.getTime() - j * 86_400_000));
    return transaction(this.db, () => {
      const clients = this.db.prepare("DELETE FROM whatsapp_clients WHERE vu_le < ?").run(avant(jours)).changes;
      this.db.prepare("DELETE FROM whatsapp_deja_vus WHERE recu_le < ?").run(avant(8));
      return Number(clients);
    });
  }
}
