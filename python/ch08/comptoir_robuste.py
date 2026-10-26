"""Chapitre 8 : le Comptoir en ligne de commande, avec son budget et ses diagnostics.

Lancement, depuis le dossier python/ :
    python -m ch08.comptoir_robuste "Combien coûtent 6 bouteilles de bissap ?" --client essai-1
"""

import argparse

from comptoir import assistant, config
from comptoir.appel import appeler, creer_client
from comptoir.budget import Budget
from comptoir.erreurs import ErreurComptoir
from comptoir.prompt import charger


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--client", default="essai", help="l'identifiant du client, pour son quota du jour")
    args = parser.parse_args()

    budget = Budget(config.BUDGET)
    prompt = charger()
    requete = assistant.construire_requete(args.question, prompt=prompt)
    try:
        reponse = appeler(creer_client(), requete, budget, args.client, prompt=prompt.identifiant)
    except ErreurComptoir as erreur:
        print(f"Au client : {erreur.diagnostic.pour_le_client}")
        print(f"Pour Yao  : {erreur.diagnostic.pour_yao}")
        return
    if reponse.arret and reponse.arret.code == "refus":
        print(reponse.arret.pour_le_client)  # un éventuel début de réponse est à jeter
    else:
        print(reponse.texte)
    if reponse.arret:
        print(f"Pour Yao  : {reponse.arret.pour_yao}")
    print(f"\n[{reponse.cout}] ; dépensé aujourd'hui : {budget.du_jour():.4f} $ sur {config.BUDGET_JOUR:.2f} $")
    if reponse.alerte:
        print("⚠ Seuil d'alerte franchi : le budget du jour ou du mois approche de son plafond.")


if __name__ == "__main__":
    main()
