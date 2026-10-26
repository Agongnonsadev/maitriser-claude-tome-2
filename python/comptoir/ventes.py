"""Les ventes d'une semaine, calculées par notre code : la référence du rapport (chapitre 10).

Claude calcule le rapport dans son conteneur ; ce module refait les mêmes calculs, ici,
pour vérifier chaque chiffre avant qu'Awa ne le lise.
"""

import csv
from collections import defaultdict
from pathlib import Path


def lire(chemin: str | Path) -> list[dict]:
    with open(chemin, encoding="utf-8", newline="") as f:
        return [{**ligne, "quantite": int(ligne["quantite"]), "prix_unitaire_fcfa": int(ligne["prix_unitaire_fcfa"])}
                for ligne in csv.DictReader(f)]


def totaux(lignes: list[dict]) -> dict:
    par_produit = defaultdict(lambda: {"quantite": 0, "montant_fcfa": 0})
    par_jour, par_quartier = defaultdict(int), defaultdict(int)
    for ligne in lignes:
        montant = ligne["quantite"] * ligne["prix_unitaire_fcfa"]
        par_produit[ligne["produit"]]["quantite"] += ligne["quantite"]
        par_produit[ligne["produit"]]["montant_fcfa"] += montant
        par_jour[ligne["date"]] += montant
        par_quartier[ligne["quartier"]] += montant
    total = sum(par_jour.values())
    commandes = len({ligne["commande"] for ligne in lignes})
    return {
        "chiffre_affaires_fcfa": total,
        "commandes": commandes,
        "panier_moyen_fcfa": round(total / commandes) if commandes else 0,
        "par_produit": dict(sorted(par_produit.items())),
        "par_jour": dict(sorted(par_jour.items())),
        "par_quartier": dict(sorted(par_quartier.items())),
    }


def comparer(resume: dict, attendu: dict) -> list[str]:
    """Les écarts entre le résumé produit par Claude et notre calcul. Liste vide : tout concorde."""
    ecarts = []
    for cle in ("chiffre_affaires_fcfa", "commandes"):
        if resume.get(cle) != attendu[cle]:
            ecarts.append(f"{cle} : {resume.get(cle)!r} au lieu de {attendu[cle]}")
    if abs((resume.get("panier_moyen_fcfa") or 0) - attendu["panier_moyen_fcfa"]) > 1:  # l'arrondi peut différer
        ecarts.append(f"panier_moyen_fcfa : {resume.get('panier_moyen_fcfa')!r} au lieu de {attendu['panier_moyen_fcfa']}")
    for cle in ("par_jour", "par_quartier"):
        obtenu = resume.get(cle) or {}
        for nom, valeur in attendu[cle].items():
            if obtenu.get(nom) != valeur:
                ecarts.append(f"{cle}[{nom}] : {obtenu.get(nom)!r} au lieu de {valeur}")
    obtenu = resume.get("par_produit") or {}
    for produit, valeurs in attendu["par_produit"].items():
        if obtenu.get(produit) != valeurs:
            ecarts.append(f"par_produit[{produit}] : {obtenu.get(produit)!r} au lieu de {valeurs}")
    return ecarts
