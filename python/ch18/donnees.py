"""Chapitre 18 : les données des clients, gardées le temps promis, effacées à la demande.

Depuis le dossier python/ (GRATUIT, aucun appel à l'API) :
    python -m ch18.donnees purger                          les durées de config.py, sur les deux bases
    python -m ch18.donnees effacer <conversation>          ce qu'un client a demandé d'effacer
    python -m ch18.donnees effacer-numero <numéro>         la même chose pour un client WhatsApp (chapitre 21)

`purger` est à lancer chaque jour : le serveur web le fait pour les conversations (comptoir/web.py) ; pour
la boutique, une tâche planifiée du serveur s'en charge (chapitre 19). `effacer` sert quand un client le
demande : le Comptoir ne peut rien effacer lui-même (aucun outil ne le permet), il transmet la demande à
Awa, qui lance la commande. Les commandes passées restent, réduites au prénom et à l'initiale du client :
la comptabilité en a besoin. Le délai pour répondre dépend de la loi du pays du client.
"""

import argparse
import json
import sys

from comptoir import config, whatsapp
from comptoir.boutique import Boutique
from comptoir.conversations import Conversations


def purger(boutique: Boutique, conversations: Conversations, annuaire: whatsapp.Annuaire) -> dict:
    resultat = boutique.purger(config.CONSERVATION_DEMANDES_J, config.CONSERVATION_NOMS_J,
                               config.CONSERVATION_RECAPITULATIFS_J)
    resultat["conversations_effacees"] = conversations.purger()
    resultat["clients_whatsapp_oublies"] = annuaire.purger(config.CONSERVATION_J)
    return resultat


def effacer(boutique: Boutique, conversations: Conversations, annuaire: whatsapp.Annuaire, conversation: str) -> dict:
    resultat = boutique.effacer(conversation)
    resultat["conversation_effacee"] = conversations.effacer(conversation)
    # Chapitre 21 : le numéro WhatsApp aussi, qui restait dans l'annuaire du chapitre 19.
    resultat["numero_efface"] = annuaire.effacer(conversation) > 0
    return resultat


def effacer_numero(boutique: Boutique, conversations: Conversations, annuaire: whatsapp.Annuaire, numero: str) -> dict:
    """Un client WhatsApp donne son numéro, pas un identifiant de conversation : on le retrouve par l'empreinte."""
    conversation = annuaire.conversation(whatsapp.pseudonyme(numero, config.SEL_PSEUDONYMES))
    if conversation is None:
        return {"conversation_trouvee": False}
    return {"conversation_trouvee": True, **effacer(boutique, conversations, annuaire, conversation)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commandes = parser.add_subparsers(dest="commande", required=True)
    commandes.add_parser("purger")
    p = commandes.add_parser("effacer")
    p.add_argument("conversation")
    p = commandes.add_parser("effacer-numero")
    p.add_argument("numero", help="au format de WhatsApp, sans + ni espace : 22997000000")
    args = parser.parse_args()
    boutique, conversations = Boutique(config.BOUTIQUE), Conversations(config.CONVERSATIONS)
    annuaire = whatsapp.Annuaire(config.CONVERSATIONS)  # l'annuaire vit dans la base des conversations
    if args.commande == "purger":
        resultat = purger(boutique, conversations, annuaire)
    elif args.commande == "effacer":
        resultat = effacer(boutique, conversations, annuaire, args.conversation)
    else:
        resultat = effacer_numero(boutique, conversations, annuaire, args.numero)
    print(json.dumps(resultat, ensure_ascii=False))


if __name__ == "__main__":
    main()
