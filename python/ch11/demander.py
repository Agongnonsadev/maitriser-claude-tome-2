"""Chapitre 11 : poser une question aux documents d'Awa, et voir d'où vient la réponse.

Lancement, depuis le dossier python/ :
    python -m ch11.demander "Vous livrez le dimanche ?"
    python -m ch11.demander --mode rag "Vous livrez à Godomey ?"
"""

import argparse

import anthropic

from ch11.outils_communs import index_bm25
from comptoir import documentaire
from comptoir.connaissances import charger_base


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--mode", choices=["contexte", "rag"], default="contexte")
    args = parser.parse_args()

    if args.mode == "contexte":
        morceaux, cache = charger_base(), True  # toute la base, en cache
    else:
        morceaux, cache = [m for m, _ in index_bm25(contextuel=False).chercher(args.question, k=5)], False

    reponse = documentaire.repondre(anthropic.Anthropic(), args.question, morceaux, cache=cache, mode=args.mode)
    print(reponse.texte, "\n")
    for numero, source in enumerate(reponse.sources, start=1):
        titre = next(c.titre for c in reponse.citations if c.source == source)
        print(f"[{numero}] {titre}  ({source})")
    if not reponse.sources:
        print("(aucune source citée)")
    print(f"\n[{reponse.cout.entree} tokens en entrée, {reponse.cout.ecriture_cache} écrits en cache, "
          f"{reponse.cout.lecture_cache} lus dans le cache, {reponse.cout.sortie} en sortie ; {reponse.cout} ; "
          f"{reponse.latence_s} s]")


if __name__ == "__main__":
    main()
