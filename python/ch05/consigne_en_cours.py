"""Chapitre 5 : une consigne d'Awa ajoutée en cours de conversation, sans toucher au prompt.

Le prompt système ne change pas (et son cache reste valable, chapitre 11) : la consigne
arrive comme un message système placé juste après le message du client.

Lancement, depuis le dossier python/ :  python -m ch05.consigne_en_cours
"""

import anthropic

from comptoir.assistant import repondre

CONSIGNE = (
    "Information d'Awa, valable aujourd'hui seulement : le jus de corossol est en rupture "
    "jusqu'à demain matin. Ne le propose pas ; propose plutôt l'ananas ou le gingembre."
)

client = anthropic.Anthropic()
question = "Bonjour, je voudrais 3 bouteilles de corossol pour ce soir."

for consignes in ([], [CONSIGNE]):
    texte, prix, _ = repondre(client, question, consignes=consignes)
    print("Avec la consigne :" if consignes else "Sans consigne :")
    print(texte)
    print(f"[{prix}]\n")
