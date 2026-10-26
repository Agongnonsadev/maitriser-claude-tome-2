"""Chapitre 14 : fabrique l'historique fictif des commandes d'Awa, puis la copie que Yao explore.

Lancement, depuis le dossier python/ :  python -m ch14.fabriquer_commandes
Aucun appel à l'API. Le tirage est fixé : les chiffres sont les mêmes à chaque lancement
(seuls les identifiants internes, tirés par uuid, changent).

1. donnees_clients/boutique_demo.sqlite3 : la base de la boutique du chapitre 9, comme en
   production. Treize semaines de récapitulatifs, de commandes et de demandes, du lundi
   20 juillet au dimanche 18 octobre 2026, créés par le code de la boutique lui-même
   (Boutique.preparer, Boutique.confirmer, Boutique.transmettre) avec une horloge simulée.
2. donnees_clients/commandes_exploration.sqlite3 : la copie que Yao confie à Claude. Les noms
   des clients et les numéros de conversation y sont remplacés par des pseudonymes, et les
   codes de confirmation effacés : Claude n'a besoin d'aucun des trois pour compter des ventes.
"""

import json
import random
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from comptoir.boutique import COTONOU, MAXIMUM_SANS_DEVIS, Boutique, RefusBoutique

RACINE = Path(__file__).parents[1]
BASE = RACINE / "donnees_clients" / "boutique_demo.sqlite3"
COPIE = RACINE / "donnees_clients" / "commandes_exploration.sqlite3"
DEBUT = date(2026, 7, 20)                 # un lundi
FIN = date(2026, 10, 18)                  # un dimanche : treize semaines
RUPTURE_COROSSOL = date(2026, 10, 3)      # la même rupture qu'au chapitre 13
GRAINE = 14

# Le poids de chaque produit dans les demandes des clients.
PRODUITS = {"Jus de bissap": 40, "Jus de gingembre": 24, "Jus d'ananas": 15, "Jus de corossol": 11,
            "Sirop de bissap": 6, "Sirop de gingembre": 4}
# Les quartiers livrés, avec leur poids. Lieux réels de Cotonou et de ses environs ; clients fictifs.
QUARTIERS = {"Fidjrossè": 16, "Akpakpa": 14, "Cadjèhoun": 12, "Gbégamey": 10, "Haie Vive": 9, "Zogbo": 8,
             "Agla": 8, "Godomey": 8, "Cocotiers": 7, "Abomey-Calavi": 8}
# Récapitulatifs préparés par jour, du lundi au dimanche (moyennes avant tirage).
PAR_JOUR = [7, 6, 7, 8, 10, 14, 4]
PRENOMS = ["Adjoua", "Afi", "Akossiwa", "Aminata", "Bénédicte", "Bernadette", "Chantal", "Christelle", "Edwige",
           "Élodie", "Fifamè", "Gisèle", "Grâce", "Huguette", "Ida", "Jocelyne", "Larissa", "Mariam", "Nadège",
           "Odile", "Prisca", "Rachida", "Sandrine", "Sènami", "Yasmine", "Abdou", "Arnaud", "Basile", "Brice",
           "Carlos", "Cyrille", "Dossou", "Éric", "Fiacre", "Gildas", "Hervé", "Ismaël", "Jean-Marc", "Kossi",
           "Landry", "Mathieu", "Noël", "Olivier", "Parfait", "Romuald", "Serge", "Sylvain", "Thierry", "Ulrich"]
NOMS = ["Adjovi", "Agbodjan", "Ahouansou", "Akpovi", "Assogba", "Bocco", "Dagbo", "Djossou", "Dossa", "Gbaguidi",
        "Hounkpatin", "Houngbo", "Kiki", "Kpossou", "Lawson", "Mensah", "Noudéhou", "Sossa", "Tossou", "Zinsou"]
MOTIFS_DEMANDE = [("devis", "Commande pour un événement, au-delà de 50 bouteilles."),
                  ("reclamation", "Une bouteille livrée abîmée ; le client demande un remplacement."),
                  ("livraison", "Le client demande un créneau de livraison précis."),
                  ("question", "Question sur la conservation des jus hors du réfrigérateur.")]
NOTE = ("Données fictives : Délices d'Awa et ses clients sont imaginaires, créés pour « Maîtriser Claude », "
        "Tome 2. Les quartiers sont de vrais quartiers de Cotonou et de ses environs.")


class Horloge:
    """Une horloge que le simulateur avance à la main : la boutique date tout avec elle."""

    def __init__(self, instant: datetime):
        self.instant = instant

    def __call__(self) -> datetime:
        return self.instant


def fabriquer_clients(hasard: random.Random, nombre: int = 140) -> list[dict]:
    """Des clients fictifs, chacun avec son quartier ; les premiers commandent bien plus souvent."""
    clients, vus = [], set()
    while len(clients) < nombre:
        nom = f"{hasard.choice(PRENOMS)} {hasard.choice(NOMS)}"
        if nom in vus:
            continue
        vus.add(nom)
        quartier = hasard.choices(list(QUARTIERS), weights=list(QUARTIERS.values()))[0]
        clients.append({"nom": nom, "quartier": quartier, "poids": 1 / (1 + len(clients)) ** 0.8})
    return clients


def _produits_du_jour(jour: date) -> dict:
    return {p: w for p, w in PRODUITS.items() if not (p == "Jus de corossol" and jour >= RUPTURE_COROSSOL)}


def _lignes(hasard: random.Random, jour: date) -> list[dict]:
    produits = _produits_du_jour(jour)
    choisis = set(hasard.choices(list(produits), weights=list(produits.values()), k=hasard.choice([1, 1, 2, 2, 3])))
    lignes = []
    for produit in sorted(choisis):
        quantite = hasard.choice([1, 1, 2, 2, 2, 3, 4, 6])
        if hasard.random() < 0.03:  # un anniversaire, une réunion de famille
            quantite = hasard.choice([12, 18, 24, 30])
        lignes.append({"produit": produit, "quantite": quantite})
    return lignes


def simuler(chemin: Path, graine: int = GRAINE) -> dict:
    """Remplit la base de la boutique, jour après jour. Rend un bilan pour vérifier le résultat."""
    if chemin.exists():
        chemin.unlink()
    hasard = random.Random(graine)
    clients = fabriquer_clients(hasard)
    horloge = Horloge(datetime.combine(DEBUT, datetime.min.time(), COTONOU))
    # Un stock large pendant la simulation : la question du chapitre est ce qui s'est vendu.
    boutique = Boutique(str(chemin), stock={p: 1_000_000 for p in PRODUITS}, horloge=horloge,
                        hasard=random.Random(graine + 1))
    bilan = {"recapitulatifs": 0, "commandes": 0, "abandons": 0, "changements_d_avis": 0, "demandes": 0}
    numero_conversation = 0
    jour = DEBUT
    while jour <= FIN:
        moyenne = PAR_JOUR[jour.weekday()]
        for _ in range(max(0, round(hasard.gauss(moyenne, moyenne ** 0.5)))):
            numero_conversation += 1
            conversation = f"wa-{numero_conversation:05d}"
            client = hasard.choices(clients, weights=[c["poids"] for c in clients])[0]
            heure = hasard.choices(range(8, 21), weights=[3, 5, 6, 6, 5, 3, 3, 4, 5, 6, 7, 6, 3])[0]
            horloge.instant = datetime.combine(jour, datetime.min.time(), COTONOU) + timedelta(
                hours=heure, minutes=hasard.randrange(60))
            lignes = _lignes(hasard, jour)
            if sum(l["quantite"] for l in lignes if not l["produit"].startswith("Sirop")) > MAXIMUM_SANS_DEVIS:
                boutique.transmettre(conversation, "devis", MOTIFS_DEMANDE[0][1])
                bilan["demandes"] += 1
                continue
            try:
                recap = boutique.preparer(conversation, lignes, client["nom"], client["quartier"])
            except RefusBoutique:
                continue
            bilan["recapitulatifs"] += 1
            if hasard.random() < 0.08:  # le client change d'avis : un nouveau récapitulatif remplace l'ancien
                horloge.instant += timedelta(minutes=hasard.randrange(2, 15))
                lignes = _lignes(hasard, jour)
                recap = boutique.preparer(conversation, lignes, client["nom"], client["quartier"])
                bilan["recapitulatifs"] += 1
                bilan["changements_d_avis"] += 1
            if hasard.random() < 0.78:
                horloge.instant += timedelta(minutes=hasard.randrange(1, 90))
                boutique.confirmer(conversation, recap["code_de_confirmation"])
                bilan["commandes"] += 1
            else:
                bilan["abandons"] += 1
            if hasard.random() < 0.04:
                motif, resume = hasard.choice(MOTIFS_DEMANDE[1:])
                horloge.instant += timedelta(minutes=hasard.randrange(5, 120))
                boutique.transmettre(conversation, motif, resume)
                bilan["demandes"] += 1
        jour += timedelta(days=1)
    # Le stock de ce matin, celui du chapitre 9 : le corossol est en rupture.
    stock = json.loads((RACINE / "comptoir" / "donnees" / "stock_initial.json").read_text(encoding="utf-8"))["stock"]
    Boutique(str(chemin), stock=stock)
    with sqlite3.connect(chemin) as db:
        db.execute("CREATE TABLE IF NOT EXISTS a_propos (note TEXT NOT NULL)")
        db.execute("INSERT INTO a_propos VALUES (?)", (NOTE,))
    return bilan


def copier_pour_exploration(source: Path, copie: Path) -> int:
    """Copie la base en retirant ce que Claude n'a pas à lire. Rend le nombre de clients pseudonymisés.

    Les noms deviennent « Client 001 », « Client 002 »… dans l'ordre de leur première commande,
    les conversations « conv-00001 »…, et les codes de confirmation sont vidés. VACUUM réécrit
    le fichier : sans lui, les anciennes valeurs restent lisibles dans les pages libérées.
    """
    if copie.exists():
        copie.unlink()
    with sqlite3.connect(source) as origine, sqlite3.connect(copie) as cible:
        origine.backup(cible)
    db = sqlite3.connect(copie)
    try:
        noms = [n for (n,) in db.execute("SELECT nom_client FROM recapitulatifs GROUP BY nom_client ORDER BY MIN(cree_le)")]
        pseudonymes = {nom: f"Client {i:03d}" for i, nom in enumerate(noms, start=1)}
        conversations = [c for (c,) in db.execute(
            "SELECT conversation FROM (SELECT conversation, cree_le FROM recapitulatifs UNION ALL "
            "SELECT conversation, cree_le FROM demandes) GROUP BY conversation ORDER BY MIN(cree_le)")]
        alias = {c: f"conv-{i:05d}" for i, c in enumerate(conversations, start=1)}
        with db:
            db.executemany("UPDATE recapitulatifs SET nom_client = ? WHERE nom_client = ?",
                           [(p, n) for n, p in pseudonymes.items()])
            for table in ("recapitulatifs", "commandes", "demandes"):
                db.executemany(f"UPDATE {table} SET conversation = ? WHERE conversation = ?",
                               [(a, c) for c, a in alias.items()])
            db.execute("UPDATE recapitulatifs SET code = ''")
            db.execute("DELETE FROM a_propos")
            db.execute("INSERT INTO a_propos VALUES (?)", (
                NOTE + " Copie d'exploration : noms des clients et conversations pseudonymisés, "
                "codes de confirmation effacés.",))
        db.execute("VACUUM")
    finally:
        db.close()
    return len(pseudonymes)


def main() -> None:
    bilan = simuler(BASE)
    clients = copier_pour_exploration(BASE, COPIE)
    print(f"Base de la boutique : {BASE.relative_to(RACINE)}")
    print(f"  {bilan['recapitulatifs']} récapitulatifs, {bilan['commandes']} commandes, "
          f"{bilan['abandons']} abandons, {bilan['changements_d_avis']} changements d'avis, "
          f"{bilan['demandes']} demandes transmises à Awa")
    print(f"Copie d'exploration : {COPIE.relative_to(RACINE)} ({clients} clients pseudonymisés)")


if __name__ == "__main__":
    main()
