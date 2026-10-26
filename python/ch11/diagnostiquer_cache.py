"""Chapitre 11 : un cache qui ne sert jamais, et l'API qui dit pourquoi (diagnostic du cache).

Erreur volontaire : l'heure est écrite dans le prompt système. Le début de la requête change
donc à chaque appel, et le cache est réécrit à chaque fois. Le diagnostic du cache le signale
(system_changed). Puis la correction : l'heure passe après le point de cache, dans le message.

Lancement, depuis le dossier python/ :  python -m ch11.diagnostiquer_cache
Coût : quatre appels avec toute la base, dont trois écritures dans le cache.
"""

import time
from datetime import datetime

import anthropic

from comptoir import config, documentaire
from comptoir.connaissances import blocs_resultats, charger_base
from comptoir.couts import cout
from comptoir.journal import noter
from comptoir.prompt import message_client


def requete(prompt_systeme: str, question: str, base, precedent: str | None) -> dict:
    return {
        "model": config.MODELE,
        "max_tokens": 300,
        "system": prompt_systeme,
        "messages": [{"role": "user", "content": blocs_resultats(base, cache=True)
                      + [{"type": "text", "text": message_client(question)}]}],
        "diagnostics": {"previous_message_id": precedent},
    }


def lancer(client, etiquette: str, req: dict):
    message = client.beta.messages.create(**req)
    prix = cout(req["model"], message.usage)
    noter(message._request_id, req["model"], prix, prompt=etiquette)
    raison = getattr(message, "diagnostics", None)
    raison = raison.cache_miss_reason if raison is not None else None
    detail = "aucune divergence" if raison is None else f"{raison.type}"
    if raison is not None and getattr(raison, "cache_missed_input_tokens", None) is not None:
        detail += f" ({raison.cache_missed_input_tokens} tokens perdus, estimation)"
    print(f"{etiquette:28} écrit {prix.ecriture_cache:>6}  lu {prix.lecture_cache:>6}  {prix.dollars:.4f} $  "
          f"diagnostic : {detail}")
    return message


def main() -> None:
    client = anthropic.Anthropic()
    base = charger_base()
    prompt = documentaire.charger_prompt().texte
    question = "Vous livrez le dimanche ?"

    def maintenant() -> str:
        return datetime.now().strftime("%d/%m/%Y %H:%M:%S")

    print("L'erreur : l'heure dans le prompt système")
    m1 = lancer(client, "1. heure dans le système", requete(f"{prompt}\n\nNous sommes le {maintenant()}.", question, base, None))
    time.sleep(2)
    m2 = lancer(client, "2. même erreur", requete(f"{prompt}\n\nNous sommes le {maintenant()}.", question, base, m1.id))

    print("\nLa correction : l'heure après le point de cache, dans le message du client")
    m3 = lancer(client, "3. système stable", requete(prompt, f"(Nous sommes le {maintenant()}.) {question}", base, m2.id))
    time.sleep(2)
    lancer(client, "4. système stable, à nouveau", requete(prompt, f"(Nous sommes le {maintenant()}.) {question}", base, m3.id))


if __name__ == "__main__":
    main()
