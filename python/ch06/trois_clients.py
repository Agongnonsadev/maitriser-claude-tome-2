"""Chapitre 6 : trois clients écrivent en même temps. L'un après l'autre, puis ensemble.

Avec le client asynchrone, le serveur n'attend pas la réponse de Claude les bras
croisés : pendant qu'une réponse arrive, il en lance une autre. Le sémaphore borne
le nombre d'appels simultanés, pour rester sous les limites de débit de l'organisation.

Lancement, depuis le dossier python/ :  python -m ch06.trois_clients
Coût : six appels courts (trois questions, deux fois).
"""

import asyncio
import time

from anthropic import AsyncAnthropic

from comptoir import assistant, config
from comptoir.couts import cout
from comptoir.journal import noter
from comptoir.prompt import charger

QUESTIONS = [
    "Bonjour, livrez-vous à Akpakpa ?",
    "Combien coûtent 6 bouteilles de bissap ?",
    "Le sirop de gingembre se garde combien de temps ?",
]

APPELS_SIMULTANES_MAX = 2


async def repondre(client, question: str, prompt, limite: asyncio.Semaphore) -> float:
    async with limite:  # au plus APPELS_SIMULTANES_MAX appels à la fois
        requete = assistant.construire_requete(question, prompt=prompt)
        message = await client.messages.create(**requete)
        prix = cout(requete["model"], message.usage)
        noter(message._request_id, requete["model"], prix, prompt=prompt.identifiant)
        return prix.dollars


async def main() -> None:
    client = AsyncAnthropic(timeout=config.DELAI_S)
    prompt = charger()

    depart = time.perf_counter()
    une_a_une = asyncio.Semaphore(1)
    couts = [await repondre(client, q, prompt, une_a_une) for q in QUESTIONS]
    print(f"L'une après l'autre : {time.perf_counter() - depart:.1f} s, {sum(couts):.4f} $")

    depart = time.perf_counter()
    limite = asyncio.Semaphore(APPELS_SIMULTANES_MAX)
    couts = await asyncio.gather(*(repondre(client, q, prompt, limite) for q in QUESTIONS))
    print(f"Ensemble (au plus {APPELS_SIMULTANES_MAX} à la fois) : {time.perf_counter() - depart:.1f} s, {sum(couts):.4f} $")


if __name__ == "__main__":
    asyncio.run(main())
