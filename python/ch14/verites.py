"""Chapitre 14 : les bonnes réponses aux questions de Yao, calculées par le code sur la copie.

Avant de demander quoi que ce soit à Claude, on sait ce qu'il doit trouver : c'est ce qui permet
de vérifier ses réponses, et non de les croire.
"""

import sqlite3
from pathlib import Path

from ch14.serveurs import RACINE

COPIE = RACINE / "donnees_clients" / "commandes_exploration.sqlite3"
# Les quatre dernières semaines complètes de l'historique : du lundi 21 septembre au dimanche 18 octobre.
DEBUT_PERIODE, FIN_PERIODE = "2026-09-21", "2026-10-19"


def calculer(chemin: Path = COPIE) -> dict:
    db = sqlite3.connect(chemin)
    try:
        quartiers = db.execute(
            "SELECT r.quartier, COUNT(*), SUM(c.total) FROM commandes c JOIN recapitulatifs r "
            "ON r.id = c.recapitulatif WHERE c.cree_le >= ? AND c.cree_le < ? "
            "GROUP BY r.quartier ORDER BY SUM(c.total) DESC LIMIT 3", (DEBUT_PERIODE, FIN_PERIODE)).fetchall()
        # Une conversation abandonnée : des récapitulatifs, et aucun n'est devenu une commande.
        conversations, abandons = db.execute(
            "SELECT COUNT(*), SUM(confirmee = 0) FROM (SELECT conversation, MAX(statut = 'confirme') AS confirmee "
            "FROM recapitulatifs GROUP BY conversation)").fetchone()
        heures = db.execute(
            "SELECT CAST(substr(cree_le, 12, 2) AS INTEGER) AS h, COUNT(*), SUM(statut = 'en_attente') "
            "FROM recapitulatifs WHERE statut != 'remplace' GROUP BY h HAVING COUNT(*) >= 20 "
            "ORDER BY 1.0 * SUM(statut = 'en_attente') / COUNT(*) DESC LIMIT 1").fetchone()
        (corossol,) = db.execute(
            "SELECT SUM(json_extract(j.value, '$.quantite')) FROM commandes c JOIN recapitulatifs r "
            "ON r.id = c.recapitulatif, json_each(r.lignes) j "
            "WHERE json_extract(j.value, '$.produit') = 'Jus de corossol'").fetchone()
    finally:
        db.close()
    return {
        "quartiers": [{"quartier": q, "commandes": n, "fcfa": ca} for q, n, ca in quartiers],
        "conversations": conversations,
        "abandons": abandons,
        "part_abandons": round(100 * abandons / conversations, 1),
        "heure_pire_abandon": heures[0],
        "taux_heure_pire": round(100 * heures[2] / heures[1], 1),
        "bouteilles_corossol": corossol,
    }


def bouteilles(produit: str, debut: str, fin: str, chemin: Path = COPIE) -> dict:
    """Les bouteilles d'un produit vendues entre deux dates (fin exclue), au total et par quartier."""
    db = sqlite3.connect(chemin)
    try:
        lignes = db.execute(
            "SELECT r.quartier, SUM(json_extract(j.value, '$.quantite')) AS n FROM commandes c "
            "JOIN recapitulatifs r ON r.id = c.recapitulatif, json_each(r.lignes) j "
            "WHERE json_extract(j.value, '$.produit') = ? AND c.cree_le >= ? AND c.cree_le < ? "
            "GROUP BY r.quartier ORDER BY n DESC", (produit, debut, fin)).fetchall()
    finally:
        db.close()
    return {"total": sum(n for _, n in lignes), "par_quartier": dict(lignes)}
