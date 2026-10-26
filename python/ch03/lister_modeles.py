"""Chapitre 3 : lister les modèles disponibles pour votre clé, avec leurs limites et leur date de retrait.

L'API Models ne génère aucun texte : elle ne consomme pas de tokens.
Lancement, depuis le dossier python/ :  python -m ch03.lister_modeles
"""

import anthropic

client = anthropic.Anthropic()

for modele in client.models.list():
    retrait = modele.retires_at.date().isoformat() if modele.retires_at else "non annoncé"
    contexte = f"{modele.max_input_tokens:,}" if modele.max_input_tokens else "?"
    sortie = f"{modele.max_tokens:,}" if modele.max_tokens else "?"
    print(
        f"{modele.id:<28} {modele.lifecycle:<11} contexte {contexte:>9} · "
        f"sortie {sortie:>7} · retrait : {retrait}"
    )
