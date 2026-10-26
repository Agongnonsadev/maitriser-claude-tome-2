"""Chapitre 13 : plusieurs séances de l'agent par réglage, ses critères, son coût et sa durée.

Lancement, depuis le dossier python/ :  python -m ch13.evaluer_agent --repetitions 3 --budget-max 2
Réglages :  sonnet (sous-agent pour les messages), sonnet-lecture-directe, haiku, opus
Chaque séance est gardée dans ch13/resultats/seances.jsonl, pour la relecture.
"""

import argparse
import csv
import json
import statistics
from dataclasses import asdict
from pathlib import Path

import anthropic

from ch13.criteres import criteres
from comptoir.agent_reappro import Garde, Reglages, lancer
from comptoir.atelier import Atelier

DOSSIER = Path(__file__).parent / "resultats"
REGLAGES = {
    "sonnet": Reglages(),
    "sonnet-lecture-directe": Reglages(sous_agent=False),
    "haiku": Reglages(modele="claude-haiku-5-5"),
    "opus": Reglages(modele="claude-opus-5-5"),
}


def lignes_du_resume(texte: str) -> int:
    return sum(1 for ligne in texte.splitlines() if ligne.strip())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--reglages", nargs="+", choices=list(REGLAGES), default=["sonnet", "sonnet-lecture-directe",
                                                                                   "haiku"])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--budget-max", type=float, default=2.0, help="en dollars, pour toute l'évaluation")
    parser.add_argument("--sortie", default="agent.csv")
    args = parser.parse_args()

    client, lignes, depense = anthropic.Anthropic(), [], 0.0
    DOSSIER.mkdir(exist_ok=True)
    with (DOSSIER / "seances.jsonl").open("a", encoding="utf-8") as seances:
        for nom in args.reglages:
            for passage in range(1, args.repetitions + 1):
                if depense >= args.budget_max:
                    raise SystemExit(f"Budget de {args.budget_max} $ atteint : arrêt.")
                r = lancer(client, Atelier(), REGLAGES[nom], Garde(budget_dollars=0.60))
                depense += r.depense
                verdict = criteres(r.bon)
                ligne = {"reglage": nom, "passage": passage, "arret": r.arret or "", "tours": r.tours,
                         "cout_dollars": round(r.depense, 5), "dont_sous_agent": round(r.cout_sous_agent, 5),
                         "duree_s": round(r.duree_s, 1), "pic_contexte": r.pic_contexte, "appels_outils": len(r.outils),
                         "total_fcfa": r.bon.total_fcfa if r.bon else "", "lignes_du_resume": lignes_du_resume(r.texte),
                         "criteres_reussis": sum(verdict.values()), **verdict}
                lignes.append(ligne)
                seances.write(json.dumps({**ligne, "bon": asdict(r.bon) if r.bon else None, "resume": r.texte,
                                          "outils": r.outils, "trace": r.trace.afficher()}, ensure_ascii=False) + "\n")
                print(f"{nom:24} {passage}  {ligne['criteres_reussis']}/{len(verdict)}  {r.tours:>2} tours  "
                      f"{r.depense:.4f} $  {r.duree_s:5.1f} s  {r.arret or ''}")

    with (DOSSIER / args.sortie).open("w", newline="", encoding="utf-8") as f:
        champs = list(dict.fromkeys(k for l in lignes for k in l))
        ecrivain = csv.DictWriter(f, fieldnames=champs)
        ecrivain.writeheader()
        ecrivain.writerows(lignes)
    print(f"\n{'réglage':24} {'séances':>7} {'critères':>9} {'coût moyen':>11} {'durée méd.':>10} {'tours':>6} {'contexte max':>12}")
    for nom in args.reglages:
        g = [l for l in lignes if l["reglage"] == nom]
        print(f"{nom:24} {len(g):>7} {sum(l['criteres_reussis'] for l in g):>4}/{7 * len(g):<4} "
              f"{statistics.mean(l['cout_dollars'] for l in g):>10.4f}$ {statistics.median(l['duree_s'] for l in g):>9.1f}s "
              f"{statistics.mean(l['tours'] for l in g):>6.1f} {max(l['pic_contexte'] for l in g):>12}")
    print(f"\nDépense : {depense:.4f} $")


if __name__ == "__main__":
    main()
