// Le budget du Comptoir : plafonds par client, par jour et par mois, vérifiés avant chaque appel
// (chapitre 8).
//
// Le principe est celui du plafond quotidien de Studio Botlyx : vérifier avant de lancer, en comptant
// ce qui est déjà en cours. Chaque appel réserve d'abord son coût maximal possible (entrée connue,
// sortie au plus max_tokens), puis règle son coût réel une fois terminé. Dix appels lancés en même
// temps ne peuvent donc pas dépasser le plafond à eux dix.
//
// Les jours et les mois sont comptés en temps universel (UTC), comme le plafond mensuel d'Anthropic,
// qui repart le 1er à 00:00 UTC.

import type { DatabaseSync } from "node:sqlite";
import { identifiantAleatoire, ouvrirBase, transaction } from "./base.ts";
import { config } from "./config.ts";

export interface Decision {
  accepte: boolean;
  reservation: string | null;
  motif: string | null; //  quota_client, quota_reseau, budget_jour, budget_mois
  alerte: boolean; //       le seuil d'alerte du jour ou du mois est franchi
}

export class Budget {
  readonly db: DatabaseSync;

  constructor(
    chemin = ":memory:",
    private readonly horloge: () => Date = () => new Date(),
  ) {
    this.db = ouvrirBase(chemin);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS depenses (
        id TEXT PRIMARY KEY, jour TEXT NOT NULL, mois TEXT NOT NULL,
        client TEXT NOT NULL, dollars REAL NOT NULL, reglee INTEGER NOT NULL, groupe TEXT)`,
    );
    // Chapitre 18 : la colonne groupe (l'adresse réseau du client), ajoutée aux bases déjà créées.
    const colonnes = this.db.prepare("PRAGMA table_info(depenses)").all().map((l) => l.name);
    if (!colonnes.includes("groupe")) this.db.exec("ALTER TABLE depenses ADD COLUMN groupe TEXT");
  }

  private maintenant(): [jour: string, mois: string] {
    const instant = this.horloge().toISOString();
    return [instant.slice(0, 10), instant.slice(0, 7)];
  }

  private somme(condition: string, ...valeurs: string[]): number {
    const ligne = this.db.prepare(`SELECT COALESCE(SUM(dollars), 0) AS total FROM depenses WHERE ${condition}`).get(...valeurs);
    return Number(ligne?.total ?? 0);
  }

  duJour(): number {
    return this.somme("jour = ?", this.maintenant()[0]);
  }

  duMois(): number {
    return this.somme("mois = ?", this.maintenant()[1]);
  }

  duClient(clientId: string): number {
    return this.somme("jour = ? AND client = ?", this.maintenant()[0], clientId);
  }

  duGroupe(groupe: string): number {
    return this.somme("jour = ? AND groupe = ?", this.maintenant()[0], groupe);
  }

  /**
   * Réserve le coût maximal d'un appel, s'il tient dans les plafonds.
   *
   * groupe (chapitre 18) : ce qui relie plusieurs conversations, l'adresse réseau sur le web. Une
   * conversation neuve à chaque message ne remet pas ce compteur à zéro.
   */
  reserver(clientId: string, maximum: number, groupe: string | null = null): Decision {
    const [jour, mois] = this.maintenant();
    // Vérifier et réserver dans la même transaction.
    const decision = transaction(this.db, (): Decision => {
      const plafonds: [string, number, number][] = [["quota_client", this.duClient(clientId), config.QUOTA_CLIENT_JOUR]];
      if (groupe) plafonds.push(["quota_reseau", this.duGroupe(groupe), config.QUOTA_RESEAU_JOUR]);
      plafonds.push(["budget_jour", this.duJour(), config.BUDGET_JOUR], ["budget_mois", this.duMois(), config.BUDGET_MOIS]);
      for (const [motif, depense, plafond] of plafonds) {
        if (depense + maximum > plafond) return { accepte: false, reservation: null, motif, alerte: true };
      }
      const reservation = identifiantAleatoire();
      this.db
        .prepare("INSERT INTO depenses (id, jour, mois, client, dollars, reglee, groupe) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .run(reservation, jour, mois, clientId, maximum, groupe);
      return { accepte: true, reservation, motif: null, alerte: false };
    });
    return decision.accepte ? { ...decision, alerte: this.enAlerte() } : decision;
  }

  /** Remplace la réservation par le coût réel de l'appel. */
  regler(reservation: string, dollars: number): void {
    this.db.prepare("UPDATE depenses SET dollars = ?, reglee = 1 WHERE id = ?").run(dollars, reservation);
  }

  /**
   * Compte une dépense déjà faite, sans plafond à vérifier : l'appel a eu lieu (la surveillance du
   * chapitre 19, qui tourne à côté de la réponse et ne réserve rien avant).
   */
  ajouter(clientId: string, dollars: number, groupe: string | null = null): void {
    const [jour, mois] = this.maintenant();
    this.db
      .prepare("INSERT INTO depenses (id, jour, mois, client, dollars, reglee, groupe) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(identifiantAleatoire(), jour, mois, clientId, dollars, groupe);
  }

  /** Annule une réservation : l'appel n'a rien coûté (refusé par l'API avant tout traitement). */
  liberer(reservation: string): void {
    this.db.prepare("DELETE FROM depenses WHERE id = ?").run(reservation);
  }

  enAlerte(): boolean {
    return this.duJour() >= config.SEUIL_ALERTE * config.BUDGET_JOUR || this.duMois() >= config.SEUIL_ALERTE * config.BUDGET_MOIS;
  }
}
