"""Chapitre 6 : les événements d'un flux, un par un, avec le temps de leur arrivée.

Montre ce que le SDK reçoit de l'API : message_start, puis pour chaque bloc
content_block_start, des content_block_delta et content_block_stop, puis
message_delta (raison de l'arrêt, usage cumulé) et message_stop.
Les événements ping, eux, sont absorbés par le SDK : vous ne les verrez pas ici.

Lancement, depuis le dossier python/ :  python -m ch06.evenements "Quels jus avez-vous ?"
"""

import sys
import time

import anthropic

from comptoir import assistant
from comptoir.couts import cout
from comptoir.journal import noter
from comptoir.prompt import charger

# Les événements bruts de l'API. Le SDK y ajoute les siens (text, thinking…), plus pratiques.
BRUTS = {"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}


def main(question: str) -> None:
    client = anthropic.Anthropic()
    prompt = charger()
    requete = assistant.construire_requete(question, prompt=prompt)
    depart = time.perf_counter()
    premier_texte = None

    with client.messages.stream(**requete) as flux:
        for evenement in flux:
            if evenement.type not in BRUTS:
                continue
            ms = (time.perf_counter() - depart) * 1000
            if evenement.type == "content_block_start":
                print(f"{ms:7.0f} ms  content_block_start  (bloc {evenement.index} : {evenement.content_block.type})")
            elif evenement.type == "content_block_delta":
                if evenement.delta.type == "text_delta":
                    premier_texte = premier_texte or ms
                    print(f"{ms:7.0f} ms  content_block_delta  {evenement.delta.text!r}")
                else:
                    print(f"{ms:7.0f} ms  content_block_delta  ({evenement.delta.type})")
            elif evenement.type == "message_delta":
                print(f"{ms:7.0f} ms  message_delta        stop_reason={evenement.delta.stop_reason}")
            else:
                print(f"{ms:7.0f} ms  {evenement.type}")
        message = flux.get_final_message()
        identifiant = flux.request_id

    total = (time.perf_counter() - depart) * 1000
    prix = cout(requete["model"], message.usage)
    noter(identifiant, requete["model"], prix, prompt=prompt.identifiant)
    print(f"\nPremier texte après {premier_texte or 0:.0f} ms ; réponse complète après {total:.0f} ms.")
    print(f"Blocs du message final : {[b.type for b in message.content]}")
    print(f"Coût : {prix}")


if __name__ == "__main__":
    main(" ".join(sys.argv[1:]) or "Quels jus avez-vous, et à quel prix ?")
