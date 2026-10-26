"""Chapitre 11 : 20 questions, trois façons de donner les documents à Claude, une même grille.

- contexte : toute la base dans la requête, lue dans le cache ;
- rag : les 5 morceaux trouvés par BM25 (contextuel si les contextes existent) ;
- rag-reclasse : les 10 premiers de BM25, reclassés par Claude Haiku 5.5, qui en garde 3.

Lancement, depuis le dossier python/ :
    python -m ch11.evaluer_documentaire --budget-max 0.8
    python -m ch11.evaluer_documentaire --modes contexte --budget-max 0.3
    python -m ch11.evaluer_documentaire --modes contexte --modele claude-haiku-5-5 --sortie essais-haiku.csv
"""

import argparse
import csv
import statistics
from dataclasses import asdict, dataclass

import anthropic

from ch11.outils_communs import DOSSIER, charger_questions, index_bm25
from comptoir import documentaire
from comptoir.connaissances import charger_base
from comptoir.recherche import reclasser

MODES = ("contexte", "rag", "rag-reclasse")


@dataclass
class Essai:
    mode: str
    cas: str
    reussi: bool
    raisons: str
    a_relire: str
    reponse: str
    sources: str
    morceaux_envoyes: int
    tokens_entree: int
    ecrit_cache: int
    lu_cache: int
    tokens_sortie: int
    cout_dollars: float
    cout_reclassement: float
    latence_s: float


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--modes", nargs="+", choices=MODES, default=list(MODES))
    parser.add_argument("--budget-max", type=float, default=0.8)
    parser.add_argument("--modele", default=None, help="le modèle qui répond (par défaut, celui du Comptoir)")
    parser.add_argument("--sortie", default="essais.csv")
    parser.add_argument("--sans-reflexion", action="store_true", help="Claude Haiku 5.5 : répondre sans réfléchir")
    parser.add_argument("--max-tokens", type=int, default=documentaire.MAX_TOKENS)
    parser.add_argument("--prompt", default="v1", help="la version du prompt documentaire")
    parser.add_argument("--sans-citations", action="store_true", help="sans citations : les sources ne sont pas notées")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    base, prompt = charger_base(), documentaire.charger_prompt(args.prompt)
    # Mesuré (ch11.mesurer_recherche) : sur cette base, le BM25 contextuel ne fait pas mieux.
    index = index_bm25(contextuel=False)
    essais, depense = [], 0.0
    for mode in args.modes:
        for cas in charger_questions():
            if depense >= args.budget_max:
                print(f"Budget de {args.budget_max} $ atteint : arrêt.")
                break
            cout_recherche = 0.0
            if mode == "contexte":
                morceaux, cache = base, True
            elif mode == "rag":
                morceaux, cache = [m for m, _ in index.chercher(cas.question, k=5)], False
            else:
                candidats = [m for m, _ in index.chercher(cas.question, k=10)]
                (morceaux, cout_recherche), cache = reclasser(client, cas.question, candidats, garder=3), False
            reponse = documentaire.repondre(client, cas.question, morceaux, prompt, cache=cache, mode=mode, modele=args.modele,
                                           sans_reflexion=args.sans_reflexion, max_tokens=args.max_tokens,
                                           avec_citations=not args.sans_citations)
            raisons = documentaire.noter_documentaire(cas, reponse, exiger_sources=not args.sans_citations)
            depense += reponse.cout.dollars + cout_recherche
            essais.append(Essai(mode, cas.identifiant, not raisons, " ; ".join(raisons), cas.a_relire, reponse.texte,
                                " ".join(reponse.sources), len(morceaux), reponse.cout.entree,
                                reponse.cout.ecriture_cache, reponse.cout.lecture_cache, reponse.cout.sortie,
                                reponse.cout.dollars, round(cout_recherche, 6), reponse.latence_s))

    sortie = DOSSIER / "resultats" / args.sortie
    sortie.parent.mkdir(parents=True, exist_ok=True)
    with sortie.open("w", newline="", encoding="utf-8") as f:
        ecrivain = csv.DictWriter(f, fieldnames=list(Essai.__dataclass_fields__))
        ecrivain.writeheader()
        ecrivain.writerows(asdict(e) for e in essais)

    print(f"{'mode':14} {'réussite':>9} {'coût/réponse':>13} {'coût total':>11} {'latence méd.':>13} {'entrée moy.':>12}")
    for mode in dict.fromkeys(e.mode for e in essais):
        g = [e for e in essais if e.mode == mode]
        print(f"{mode:14} {sum(e.reussi for e in g):>5}/{len(g):<3} {statistics.mean(e.cout_dollars + e.cout_reclassement for e in g):>13.5f} "
              f"{sum(e.cout_dollars + e.cout_reclassement for e in g):>11.4f} {statistics.median(e.latence_s for e in g):>12.1f}s "
              f"{statistics.mean(e.tokens_entree + e.ecrit_cache + e.lu_cache for e in g):>12.0f}")
    print("\nÉchecs selon le code :")
    for e in essais:
        if not e.reussi:
            print(f"  {e.mode:13} {e.cas:16} {e.raisons}")
    print(f"\nDépense des réponses : {depense:.4f} $ (reclassement compris). "
          f"Réponses à relire : {sortie}")


if __name__ == "__main__":
    main()
