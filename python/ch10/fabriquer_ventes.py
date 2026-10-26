"""Chapitre 10 : fabrique l'export fictif des ventes d'une semaine, et sa FAQ à corriger.

Lancement, depuis le dossier python/ :  python -m ch10.fabriquer_ventes
Aucun appel à l'API. Le tirage est fixé : le fichier est le même à chaque lancement.
"""

import csv
import random
from datetime import date, timedelta
from pathlib import Path

from comptoir.prompt import charger_donnees

DOSSIER = Path(__file__).parent / "donnees"
VENTES = DOSSIER / "ventes-2026-10-12.csv"
QUARTIERS = ["Akpakpa", "Cadjèhoun", "Fidjrossè", "Gbégamey", "Zogbo", "Agla"]
CANAUX = ["whatsapp", "whatsapp", "whatsapp", "telephone", "marche"]

# Une FAQ du site d'Awa, avec deux erreurs par rapport à ses conditions : de quoi faire
# travailler l'outil éditeur de texte.
FAQ = """# Questions fréquentes — Délices d'Awa (document fictif)

## Où livrez-vous ?
Nous livrons à Cotonou et à Porto-Novo.

## La livraison est-elle gratuite ?
Oui, dès 3 bouteilles. En dessous, elle coûte 500 FCFA.

## Comment payer ?
Par Mobile Money (MTN MoMo, Moov Money) ou en espèces à la livraison.
"""


def fabriquer() -> list[list]:
    hasard = random.Random(2026)
    produits = charger_donnees()["produits"]
    lignes, numero = [], 0
    for jour in range(7):
        journee = date(2026, 10, 12) + timedelta(days=jour)
        for _ in range(hasard.randint(4, 9)):  # des commandes par jour
            numero += 1
            quartier, canal = hasard.choice(QUARTIERS), hasard.choice(CANAUX)
            for produit in hasard.sample(produits, hasard.randint(1, 3)):
                quantite = hasard.randint(1, 3) if "Sirop" in produit["nom"] else hasard.randint(2, 8)
                lignes.append([journee.isoformat(), f"C-{numero:04d}", produit["nom"], quantite,
                               produit["prix_fcfa"], quartier, canal])
    return lignes


def main() -> None:
    DOSSIER.mkdir(exist_ok=True)
    with VENTES.open("w", encoding="utf-8", newline="") as f:
        ecrivain = csv.writer(f)
        ecrivain.writerow(["date", "commande", "produit", "quantite", "prix_unitaire_fcfa", "quartier", "canal"])
        ecrivain.writerows(fabriquer())
    (DOSSIER / "faq-modele.md").write_text(FAQ, encoding="utf-8")
    print(f"Écrit : {VENTES.name} et faq-modele.md")


if __name__ == "__main__":
    main()
