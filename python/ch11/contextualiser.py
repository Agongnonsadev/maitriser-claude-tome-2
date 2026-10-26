"""Chapitre 11 : écrire, pour chaque morceau de la base, la phrase qui le situe dans son document.

C'est la méthode « Contextual Retrieval » d'Anthropic. Le document entier est envoyé avec un
point de cache ; du deuxième morceau au dernier, il est lu dans le cache. Les phrases sont
gardées dans ch11/resultats/contextes.json : on ne les recalcule que si un document change.

Lancement, depuis le dossier python/ :  python -m ch11.contextualiser
Modèle : Claude Haiku 5.5. Coût : une quarantaine d'appels courts.
"""

import json

import anthropic

from ch11.outils_communs import CONTEXTES
from comptoir.connaissances import DOSSIER, decouper
from comptoir.couts import cout
from comptoir.recherche import MODELE_AUXILIAIRE, contextualiser


def main() -> None:
    client = anthropic.Anthropic()
    tous, total = {}, 0.0
    print(f"{'document':22} {'morceaux':>8} {'écrit':>7} {'lu':>7} {'entrée':>7} {'sortie':>7} {'coût ($)':>9}")
    for fichier in sorted(DOSSIER.glob("*.md")):
        texte = fichier.read_text(encoding="utf-8")
        morceaux = decouper(texte, fichier.stem)
        contextes, usages = contextualiser(client, texte, morceaux)
        prix = [cout(MODELE_AUXILIAIRE, u) for u in usages]
        somme = sum(p.dollars for p in prix)
        total += somme
        print(f"{fichier.stem:22} {len(morceaux):>8} {sum(p.ecriture_cache for p in prix):>7} "
              f"{sum(p.lecture_cache for p in prix):>7} {sum(p.entree for p in prix):>7} "
              f"{sum(p.sortie for p in prix):>7} {somme:>9.5f}")
        tous.update(contextes)
    CONTEXTES.parent.mkdir(parents=True, exist_ok=True)
    CONTEXTES.write_text(json.dumps(tous, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(tous)} contextes écrits dans {CONTEXTES} ; coût total : {total:.5f} $")
    exemple = next(iter(tous.items()))
    print(f"Exemple, {exemple[0]} :\n  {exemple[1]}")


if __name__ == "__main__":
    main()
