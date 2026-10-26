"""Chapitre 2 : le Comptoir en ligne de commande. Il répond à une question de client
et affiche ce que la réponse a coûté.

Lancement, depuis le dossier python/ :
    python -m ch02.comptoir_cli "Combien coûte le sirop de gingembre ?"
"""

import sys

import anthropic

from comptoir import config
from comptoir.couts import Cout, cout
from comptoir.journal import noter

# Version 0 du prompt système : le strict minimum. Le chapitre 5 le réécrit.
PROMPT_SYSTEME = """Tu es le Comptoir, l'assistant de Délices d'Awa, une entreprise de jus naturels et de sirops artisanaux à Cotonou (entreprise fictive).

Informations à jour :
- Jus de bissap, gingembre, ananas, corossol : 1 000 FCFA la bouteille de 50 cl.
- Sirops (bissap, gingembre) : 2 500 FCFA le flacon.
- Commandes par WhatsApp, de 8 h à 19 h.
- Livraison à Cotonou : le jour même pour toute commande passée avant 12 h, sinon le lendemain. Gratuite dès 5 bouteilles, 500 FCFA en dessous.
- Paiement : Mobile Money (MTN MoMo, Moov Money) ou espèces à la livraison.

Réponds en français, en trois phrases au plus. Si la réponse ne figure pas dans ces informations, dis-le et propose de transmettre la question à Awa."""


def repondre(client, question: str, modele: str = config.MODELE) -> tuple[str, Cout, object]:
    """Envoie la question au modèle et renvoie le texte, le coût et le message complet."""
    message = client.messages.create(
        model=modele,
        max_tokens=1000,
        system=PROMPT_SYSTEME,
        messages=[{"role": "user", "content": question}],
    )
    texte = "".join(bloc.text for bloc in message.content if bloc.type == "text")
    prix = cout(modele, message.usage)
    noter(message._request_id, modele, prix)
    return texte, prix, message


def main() -> None:
    question = " ".join(sys.argv[1:]) or input("Question du client : ")
    texte, prix, message = repondre(anthropic.Anthropic(), question)
    print(texte)
    print()
    print(
        f"[{prix.entree} tokens en entrée, {prix.sortie} en sortie "
        f"dont {prix.reflexion} de réflexion. Coût : {prix}]"
    )
    if message.stop_reason != "end_turn":
        print(f"[Attention : réponse arrêtée pour la raison « {message.stop_reason} »]")


if __name__ == "__main__":
    main()
