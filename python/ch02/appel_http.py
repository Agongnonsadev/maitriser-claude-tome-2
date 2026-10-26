"""Chapitre 2 : un appel à Claude en HTTP brut, sans SDK, avec la seule bibliothèque standard.

Lancement, depuis le dossier python/ :  python -m ch02.appel_http
"""

import json
import os
import urllib.request

corps_requete = {
    "model": "claude-sonnet-5-5",
    "max_tokens": 1000,
    "messages": [
        {"role": "user", "content": "Bonjour ! Présente-toi en une phrase."},
    ],
}

requete = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(corps_requete).encode("utf-8"),
    headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],  # lue dans l'environnement, jamais écrite ici
        "anthropic-version": "2026-10-21",  # la version de l'API depuis le 21 octobre 2026 (chapitre 21)
        "content-type": "application/json",
    },
    method="POST",
)

with urllib.request.urlopen(requete, timeout=60) as reponse:
    identifiant = reponse.headers.get("request-id")
    corps = json.load(reponse)

# La réponse est une liste de blocs : on ne garde que les blocs de texte.
texte = "".join(bloc["text"] for bloc in corps["content"] if bloc["type"] == "text")

print(texte)
print("Identifiant de la requête :", identifiant)
print("Raison de l'arrêt :", corps["stop_reason"])
print("Consommation :", corps["usage"])
