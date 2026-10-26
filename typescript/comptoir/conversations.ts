// Les conversations du Comptoir, gardées par l'application (chapitre 6).
//
// L'API ne garde rien : c'est ici que vit l'historique. Il est en ajout seul : on ajoute des messages,
// on ne modifie ni ne supprime jamais un message passé d'une conversation ouverte. Les blocs renvoyés
// par Claude, réflexion comprise, sont gardés tels quels.

import type Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import { identifiantAleatoire, isoformat, ouvrirBase, transaction } from "./base.ts";
import { config } from "./config.ts";

/** Un message de l'historique, tel qu'il se renvoie à l'API. */
export type MessageHistorique = Anthropic.MessageParam;
export type MotifDeCloture = "nouveau_prompt" | "expiree" | "trop_longue";

/**
 * Le contenu d'un message, sous une forme qui se range en JSON et se renvoie à l'API : sans les champs
 * vides (citations: null…) que la réponse porte, et que l'API refuse quand on les lui renvoie. Les
 * arguments d'un outil (input) sont des données : ils restent tels quels.
 */
export function enBlocs(contenu: unknown): unknown {
  if (Array.isArray(contenu)) return contenu.map(enBlocs);
  if (contenu !== null && typeof contenu === "object") {
    return Object.fromEntries(
      Object.entries(contenu)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, k === "input" ? v : enBlocs(v)]),
    );
  }
  return contenu;
}

export class Conversations {
  readonly db: DatabaseSync;

  constructor(chemin = ":memory:") {
    this.db = ouvrirBase(chemin);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        creee_le TEXT NOT NULL,
        derniere_activite TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        prompt TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        rang INTEGER NOT NULL,
        role TEXT NOT NULL,
        contenu TEXT NOT NULL,
        PRIMARY KEY (conversation, rang));
      PRAGMA foreign_keys = ON;
    `);
  }

  /** prompt : l'identifiant du prompt système (version et empreinte) qui ouvre la conversation. */
  creer(prompt: string | null = null): string {
    const identifiant = identifiantAleatoire();
    const date = isoformat(new Date());
    this.db.prepare("INSERT INTO conversations VALUES (?, ?, ?, 0, ?)").run(identifiant, date, date, prompt);
    return identifiant;
  }

  existe(identifiant: string): boolean {
    return this.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(identifiant) !== undefined;
  }

  historique(identifiant: string): MessageHistorique[] {
    return this.db
      .prepare("SELECT role, contenu FROM messages WHERE conversation = ? ORDER BY rang")
      .all(identifiant)
      .map((l) => ({ role: l.role, content: JSON.parse(String(l.contenu)) }) as MessageHistorique);
  }

  /**
   * Ajoute un tour complet (message du client, réponse de Claude) dans une seule transaction.
   *
   * On n'enregistre jamais une question sans sa réponse : si l'appel échoue, rien n'est écrit, et
   * l'historique reste tel que Claude l'a vu la dernière fois.
   * tokens : la taille du contexte après ce tour (entrée, cache compris, plus la sortie).
   */
  ajouterTour(identifiant: string, messages: { role: string; content: unknown }[], tokens: number): void {
    transaction(this.db, () => {
      const ligne = this.db.prepare("SELECT COALESCE(MAX(rang), -1) + 1 AS rang FROM messages WHERE conversation = ?").get(identifiant);
      const rang = Number(ligne?.rang ?? 0);
      const inserer = this.db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
      messages.forEach((message, decalage) => {
        inserer.run(identifiant, rang + decalage, message.role, JSON.stringify(enBlocs(message.content)));
      });
      this.db
        .prepare("UPDATE conversations SET derniere_activite = ?, tokens = ? WHERE id = ?")
        .run(isoformat(new Date()), tokens, identifiant);
    });
  }

  /**
   * « nouveau_prompt », « expiree », « trop_longue », ou null si la conversation peut continuer.
   *
   * Un prompt système modifié invalide les blocs de réflexion déjà dans l'historique : la requête
   * suivante serait refusée (erreur 400). La conversation est donc close quand le prompt du jour n'est
   * plus celui qui l'a ouverte.
   */
  motifDeCloture(identifiant: string, prompt: string | null = null, maintenant = new Date()): MotifDeCloture | null {
    const ligne = this.db.prepare("SELECT derniere_activite, tokens, prompt FROM conversations WHERE id = ?").get(identifiant);
    if (!ligne) throw new Error(`Conversation inconnue : ${identifiant}`);
    if (prompt !== null && prompt !== ligne.prompt) return "nouveau_prompt";
    const ecoule = maintenant.getTime() - new Date(String(ligne.derniere_activite)).getTime();
    if (ecoule > config.EXPIRATION_H * 3600 * 1000) return "expiree";
    if (Number(ligne.tokens) > config.CONTEXTE_MAX) return "trop_longue";
    return null;
  }

  /** À la demande du client (chapitre 18) : la conversation et tous ses messages, tout de suite. */
  effacer(identifiant: string): boolean {
    return Number(this.db.prepare("DELETE FROM conversations WHERE id = ?").run(identifiant).changes) === 1;
  }

  /** Supprime les conversations sans activité depuis CONSERVATION_J jours. Renvoie leur nombre. */
  purger(maintenant = new Date()): number {
    const limite = new Date(maintenant.getTime() - config.CONSERVATION_J * 24 * 3600 * 1000);
    return Number(this.db.prepare("DELETE FROM conversations WHERE derniere_activite < ?").run(isoformat(limite)).changes);
  }
}
