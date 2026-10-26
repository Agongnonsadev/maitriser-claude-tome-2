"""Chapitre 2 : le même appel avec le SDK officiel, et son coût.

Lancement, depuis le dossier python/ :  python -m ch02.premier_appel
"""

import anthropic

from comptoir.couts import cout

client = anthropic.Anthropic()  # lit ANTHROPIC_API_KEY dans l'environnement

message = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1000,
    messages=[
        {"role": "user", "content": "Bonjour ! Présente-toi en une phrase."},
    ],
)

for bloc in message.content:
    if bloc.type == "text":
        print(bloc.text)

print("Identifiant de la requête :", message._request_id)
print("Raison de l'arrêt :", message.stop_reason)
print("Tokens :", message.usage.input_tokens, "en entrée,", message.usage.output_tokens, "en sortie")
print("Coût :", cout(message.model, message.usage))
