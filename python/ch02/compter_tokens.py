"""Chapitre 2 : compter les tokens d'un même message dans plusieurs langues, avant de l'envoyer.

Le comptage est gratuit (il a seulement sa propre limite de débit).
Lancement, depuis le dossier python/ :
    python -m ch02.compter_tokens
    python -m ch02.compter_tokens "La même phrase dans votre langue locale"
"""

import sys

import anthropic

MODELE = "claude-sonnet-5-5"

phrases = {
    "français": (
        "Bonjour, je voudrais commander deux bouteilles de jus de bissap "
        "et un sirop de gingembre, livrés demain matin à Cotonou."
    ),
    "anglais": (
        "Hello, I would like to order two bottles of bissap juice "
        "and one ginger syrup, delivered tomorrow morning in Cotonou."
    ),
}
if len(sys.argv) > 1:
    phrases["autre langue"] = " ".join(sys.argv[1:])

client = anthropic.Anthropic()

for langue, phrase in phrases.items():
    compte = client.messages.count_tokens(
        model=MODELE,
        messages=[{"role": "user", "content": phrase}],
    )
    print(f"{langue:<14} {len(phrase):>4} caractères   {compte.input_tokens:>4} tokens")
