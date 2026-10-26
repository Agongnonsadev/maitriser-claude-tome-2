"""Chapitre 9 : parler au Comptoir dans le terminal, et lui passer commande.

Lancement, depuis le dossier python/ :  python -m ch09.comptoir_commandes
Tapez vos messages comme un client ; une ligne vide pour quitter. Pour confirmer un
récapitulatif, répondez « OUI » suivi du code affiché.

La boutique (stock, récapitulatifs, commandes) vit dans donnees_clients/boutique.sqlite3.
"""

import uuid

from comptoir import config
from comptoir.appel import creer_client
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.commandes import ComptoirCommandes
from comptoir.erreurs import ErreurComptoir

BOUTIQUE = "donnees_clients/boutique.sqlite3"


def main() -> None:
    comptoir = ComptoirCommandes(creer_client(), Boutique(BOUTIQUE), Budget(config.BUDGET), uuid.uuid4().hex)
    print("Le Comptoir d'Awa — une ligne vide pour quitter.\n")
    while texte := input("Vous : ").strip():
        try:
            reponse = comptoir.repondre(texte)
        except ErreurComptoir as erreur:
            print(f"Comptoir : {erreur.diagnostic.pour_le_client}\n  (pour Yao : {erreur.diagnostic.pour_yao})\n")
            continue
        print(f"Comptoir : {reponse.texte}\n")
        if reponse.tour and reponse.tour.execution.appels:
            print(f"  (outils appelés : {', '.join(reponse.tour.execution.appels)})\n")


if __name__ == "__main__":
    main()
