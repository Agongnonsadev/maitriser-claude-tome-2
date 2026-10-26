"""Chapitre 11 : le Comptoir du chapitre 9, avec les documents d'Awa, sans cache puis avec.

La même conversation, plusieurs fois, avec une boutique neuve à chaque fois : une question sur
les documents, une question de stock, une commande, la confirmation. On compte les appels, les
tokens lus et écrits dans le cache, et le coût de chaque message.

Lancement, depuis le dossier python/ :
    python -m ch11.comptoir_avec_base                    (sans cache, puis cache de 5 minutes)
    python -m ch11.comptoir_avec_base --variantes 1h     (début commun gardé une heure)
"""

import argparse
import json
import re
import uuid

from comptoir import config
from comptoir.appel import creer_client
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.commandes import ComptoirCommandes
from comptoir.connaissances import charger_base

MESSAGES = [
    "Bonjour, combien de temps se garde un jus une fois ouvert ?",
    "Il vous reste du jus d'ananas et du jus de corossol ?",
    "Alors 6 bouteilles d'ananas, livrées à Akpakpa, au nom de Mme Hounkpè.",
    "OUI {code}",
]
VARIANTES = {"sans": (False, "sans cache"), "5m": (True, "cache de 5 minutes"),
             "1h": ("1h", "début commun gardé une heure")}


def lignes_du_journal(depuis: int) -> list[dict]:
    try:
        with open(config.JOURNAL, encoding="utf-8") as f:
            return [json.loads(l) for l in f][depuis:]
    except FileNotFoundError:
        return []


def jouer(cache: bool | str, nom: str) -> float:
    comptoir = ComptoirCommandes(creer_client(), Boutique(":memory:"), Budget(":memory:"), uuid.uuid4().hex,
                                 version_prompt="v3", connaissances=charger_base(), cache=cache)
    print(f"\n=== {nom} ===")
    code, total = None, 0.0
    for modele_message in MESSAGES:
        texte = modele_message.format(code=code)
        avant = len(lignes_du_journal(0))
        reponse = comptoir.repondre(texte)
        appels = [l for l in lignes_du_journal(avant) if "requete" in l]
        cout = sum(l["cout_dollars"] for l in appels)
        total += cout
        print(f"\nClient   : {texte}\nComptoir : {reponse.texte}")
        if reponse.tour and reponse.tour.execution.appels:
            print(f"  outils : {', '.join(reponse.tour.execution.appels)}")
        for l in appels:
            print(f"  appel : entrée {l['tokens_entree']:>6}  écrit {l['tokens_ecriture_cache']:>6}  "
                  f"lu {l['tokens_lecture_cache']:>6}  sortie {l['tokens_sortie']:>5}  {l['cout_dollars']:.5f} $")
        trouve = re.search(r"OUI (\d{4})", reponse.texte)
        code = trouve.group(1) if trouve else code
    print(f"\nTotal, {nom} : {total:.4f} $")
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--variantes", nargs="+", choices=list(VARIANTES), default=["sans", "5m"])
    args = parser.parse_args()
    # Sans cache, chaque appel lit toute la base au prix plein : le quota du chapitre 8 (0,15 $ par
    # client et par jour) arrêterait la conversation en route. On le relève pour cette mesure.
    print(f"Quota par client relevé de {config.QUOTA_CLIENT_JOUR} $ à 1 $ pour la mesure.")
    config.QUOTA_CLIENT_JOUR = 1.0
    totaux = {nom: jouer(cache, nom) for cache, nom in (VARIANTES[v] for v in args.variantes)}
    print("\n" + " ; ".join(f"{nom} : {t:.4f} $" for nom, t in totaux.items()))


if __name__ == "__main__":
    main()
