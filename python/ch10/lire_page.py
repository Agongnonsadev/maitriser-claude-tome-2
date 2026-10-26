"""Chapitre 10 : lire une page précise, en bornant ce qu'elle coûte.

Lancement, depuis le dossier python/ :
    python -m ch10.lire_page https://fr.wikipedia.org/wiki/Bissap "Résume en trois phrases."
    python -m ch10.lire_page --max-tokens-lus 2000 https://fr.wikipedia.org/wiki/Bissap "…"
La lecture de pages ne coûte que ses tokens ; --max-tokens-lus en fixe le plafond.
"""

import argparse

import anthropic

from comptoir import config
from comptoir.serveur import appeler, erreurs_outils, lecture_web, sources


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url")
    parser.add_argument("consigne")
    parser.add_argument("--max-tokens-lus", type=int, default=8000)
    args = parser.parse_args()

    requete = {
        "model": config.MODELE,
        "max_tokens": 2000,
        "tools": [lecture_web(max_uses=1, max_content_tokens=args.max_tokens_lus)],
        # L'adresse doit figurer dans le message : Claude ne lit que des URL déjà apparues
        # dans la conversation, jamais une adresse qu'il aurait écrite lui-même.
        "messages": [{"role": "user", "content": f"{args.consigne}\n\nPage à lire : {args.url}"}],
    }
    resultat = appeler(anthropic.Anthropic(), requete)
    print(resultat.texte)
    for source in sources(resultat.message):
        print(f"  [source : {source['titre']}]")
    for erreur in erreurs_outils(resultat.message):
        print(f"  ⚠ {erreur}")
    usage = resultat.message.usage
    print(f"\nEntrée {usage.input_tokens} tokens (plafond de lecture : {args.max_tokens_lus}), sortie {usage.output_tokens} ; "
          f"coût {resultat.cout:.4f} $ (≈ {resultat.cout * config.TAUX_FCFA:.1f} FCFA)")


if __name__ == "__main__":
    main()
