// Chapitre 14 : les bonnes réponses aux questions de Yao, calculées par le code sur la copie.
//
// Avant de demander quoi que ce soit à Claude, on sait ce qu'il doit trouver : c'est ce qui permet de
// vérifier ses réponses, et non de les croire. La copie est celle de la version Python
// (python/donnees_clients/commandes_exploration.sqlite3, fabriquée par python/ch14/fabriquer_commandes.py).

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { arrondir } from "../comptoir/arrondi.ts";
import { RACINE } from "./serveurs.ts";

export const COPIE = join(RACINE, "donnees_clients", "commandes_exploration.sqlite3");
// Les quatre dernières semaines complètes de l'historique : du lundi 21 septembre au dimanche 18 octobre.
export const DEBUT_PERIODE = "2026-09-21";
export const FIN_PERIODE = "2026-10-19";

export interface Verites {
  quartiers: { quartier: string; commandes: number; fcfa: number }[];
  conversations: number;
  abandons: number;
  part_abandons: number;
  heure_pire_abandon: number;
  taux_heure_pire: number;
  bouteilles_corossol: number;
}

const ouvrir = (chemin: string): DatabaseSync => new DatabaseSync(chemin, { readOnly: true });

export function calculer(chemin = COPIE): Verites {
  const db = ouvrir(chemin);
  try {
    const quartiers = db
      .prepare(
        "SELECT r.quartier AS quartier, COUNT(*) AS commandes, SUM(c.total) AS fcfa FROM commandes c JOIN recapitulatifs r " +
          "ON r.id = c.recapitulatif WHERE c.cree_le >= ? AND c.cree_le < ? " +
          "GROUP BY r.quartier ORDER BY SUM(c.total) DESC LIMIT 3",
      )
      .all(DEBUT_PERIODE, FIN_PERIODE) as Verites["quartiers"];
    // Une conversation abandonnée : des récapitulatifs, et aucun n'est devenu une commande.
    const { conversations, abandons } = db
      .prepare(
        "SELECT COUNT(*) AS conversations, SUM(confirmee = 0) AS abandons FROM (SELECT conversation, MAX(statut = 'confirme') AS confirmee " +
          "FROM recapitulatifs GROUP BY conversation)",
      )
      .get() as { conversations: number; abandons: number };
    const heures = db
      .prepare(
        "SELECT CAST(substr(cree_le, 12, 2) AS INTEGER) AS h, COUNT(*) AS n, SUM(statut = 'en_attente') AS attente " +
          "FROM recapitulatifs WHERE statut != 'remplace' GROUP BY h HAVING COUNT(*) >= 20 " +
          "ORDER BY 1.0 * SUM(statut = 'en_attente') / COUNT(*) DESC LIMIT 1",
      )
      .get() as { h: number; n: number; attente: number };
    const { corossol } = db
      .prepare(
        "SELECT SUM(json_extract(j.value, '$.quantite')) AS corossol FROM commandes c JOIN recapitulatifs r " +
          "ON r.id = c.recapitulatif, json_each(r.lignes) j " +
          "WHERE json_extract(j.value, '$.produit') = 'Jus de corossol'",
      )
      .get() as { corossol: number };
    return {
      quartiers: quartiers.map((q) => ({ quartier: q.quartier, commandes: q.commandes, fcfa: q.fcfa })),
      conversations,
      abandons,
      part_abandons: arrondir((100 * abandons) / conversations, 1),
      heure_pire_abandon: heures.h,
      taux_heure_pire: arrondir((100 * heures.attente) / heures.n, 1),
      bouteilles_corossol: corossol,
    };
  } finally {
    db.close();
  }
}

/** Les bouteilles d'un produit vendues entre deux dates (fin exclue), au total et par quartier. */
export function bouteilles(produit: string, debut: string, fin: string, chemin = COPIE): { total: number; par_quartier: Record<string, number> } {
  const db = ouvrir(chemin);
  try {
    const lignes = db
      .prepare(
        "SELECT r.quartier AS quartier, SUM(json_extract(j.value, '$.quantite')) AS n FROM commandes c " +
          "JOIN recapitulatifs r ON r.id = c.recapitulatif, json_each(r.lignes) j " +
          "WHERE json_extract(j.value, '$.produit') = ? AND c.cree_le >= ? AND c.cree_le < ? " +
          "GROUP BY r.quartier ORDER BY n DESC",
      )
      .all(produit, debut, fin) as { quartier: string; n: number }[];
    return { total: lignes.reduce((s, l) => s + l.n, 0), par_quartier: Object.fromEntries(lignes.map((l) => [l.quartier, l.n])) };
  } finally {
    db.close();
  }
}
