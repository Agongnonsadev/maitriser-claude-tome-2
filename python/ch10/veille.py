"""Chapitre 10 : une question d'actualité, avec la recherche web et ses sources.

Lancement, depuis le dossier python/ :
    python -m ch10.veille "Quels sont les jours fériés au Bénin en novembre et décembre 2026 ?"
    python -m ch10.veille --filtrage "…"          (filtrage dynamique des résultats)
Coût : 10 $ les 1 000 recherches (au plus --max-recherches), plus les tokens des résultats.
"""

import argparse

import anthropic

from comptoir import config
from comptoir.serveur import appeler, erreurs_outils, recherche_web, sources

SYSTEME = (
    "Tu aides Yao, de Délices d'Awa, à Cotonou, à préparer son planning. Réponds en français, brièvement, "
    "et appuie chaque information sur une source trouvée. Si les sources se contredisent ou manquent, dis-le."
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--max-recherches", type=int, default=3)
    parser.add_argument("--filtrage", action="store_true", help="filtrage dynamique (web_search_20260209)")
    args = parser.parse_args()

    requete = {
        "model": config.MODELE,
        "max_tokens": 3000,
        "system": SYSTEME,
        "tools": [recherche_web(args.max_recherches, filtrage_dynamique=args.filtrage)],
        "messages": [{"role": "user", "content": args.question}],
    }
    resultat = appeler(anthropic.Anthropic(), requete)
    print(resultat.texte)
    print("\nSources :")
    for source in sources(resultat.message):
        print(f"  - {source['titre']} — {source['source']}")
    for erreur in erreurs_outils(resultat.message):
        print(f"  ⚠ {erreur}")
    usage = resultat.message.usage
    print(f"\n{resultat.recherches} recherche(s), {resultat.appels} appel(s), {resultat.reprises} reprise(s) ; "
          f"entrée {usage.input_tokens} tokens, sortie {usage.output_tokens} ; "
          f"coût {resultat.cout:.4f} $ (≈ {resultat.cout * config.TAUX_FCFA:.0f} FCFA)")


if __name__ == "__main__":
    main()
