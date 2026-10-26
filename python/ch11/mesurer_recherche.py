"""Chapitre 11 : la recherche trouve-t-elle le bon morceau ? Rappel à 1, 3 et 5, sans appel à Claude.

Pour chaque question dont la réponse est dans les documents, on regarde si l'un des morceaux
attendus est dans les k premiers résultats. Index comparés : BM25 sur les morceaux bruts, BM25
sur les morceaux contextualisés (si ch11.contextualiser a été lancé), et, si VOYAGE_API_KEY est
posée, les embeddings de Voyage AI et la recherche hybride (fusion des rangs).

Lancement, depuis le dossier python/ :  python -m ch11.mesurer_recherche
"""

import os

from ch11.outils_communs import base_contextualisee, charger_questions
from comptoir.connaissances import charger_base
from comptoir.recherche import IndexBM25, IndexVecteurs, fusionner, plongeur_voyage, rappel


def main() -> None:
    cas = [c for c in charger_questions() if not c.absente]
    chercheurs = {"BM25": IndexBM25(charger_base()).chercher}
    contextualisee = base_contextualisee()
    if contextualisee:
        chercheurs["BM25 contextuel"] = IndexBM25(contextualisee).chercher
    if os.environ.get("VOYAGE_API_KEY"):
        vecteurs = IndexVecteurs(contextualisee or charger_base(), plongeur_voyage())
        bm25 = IndexBM25(contextualisee or charger_base())
        chercheurs["embeddings"] = vecteurs.chercher
        chercheurs["hybride"] = lambda q, k=5: fusionner(bm25.chercher(q, 20), vecteurs.chercher(q, 20), garder=k)

    print(f"{len(cas)} questions dont la réponse est dans les documents\n")
    print(f"{'index':18} {'rappel@1':>9} {'rappel@3':>9} {'rappel@5':>9}")
    for nom, chercher in chercheurs.items():
        taux = [sum(rappel(chercher(c.question, k), c.sources) for c in cas) / len(cas) for k in (1, 3, 5)]
        print(f"{nom:18} " + " ".join(f"{t:>9.0%}" for t in taux))
        rates = [c.identifiant for c in cas if not rappel(chercher(c.question, 5), c.sources)]
        if rates:
            print(f"{'':18} hors des 5 premiers : {', '.join(rates)}")


if __name__ == "__main__":
    main()
