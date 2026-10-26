"""Chapitre 7 : mesurer l'exactitude de l'extracteur sur un jeu de documents dont on connaît la réponse.

Les valeurs attendues sont dans ch07/documents/attendus.json. Pour votre propre jeu,
écrivez-les avant le premier essai, et fixez l'objectif d'exactitude avant de mesurer.

Lancement, depuis le dossier python/ :
    python -m ch07.mesurer_exactitude --repetitions 3 --budget-max 0.5
    python -m ch07.mesurer_exactitude --cote-max 1000 --repetitions 3 --budget-max 0.5
"""

import argparse
import json
from pathlib import Path

import anthropic

from comptoir.documents import bloc_document
from comptoir.exactitude import comparer, resumer
from comptoir.extraction import Facture, extraire, schema_pour

DOCUMENTS = Path(__file__).parent / "documents"


def mesurer(client, attendus: dict, repetitions: int, budget_max: float, cote_max: int | None = None):
    ecarts, depense, echecs = [], 0.0, []
    for _ in range(repetitions):
        for nom, attendu in attendus.items():
            if depense >= budget_max:
                print(f"Budget atteint ({depense:.4f} $) : arrêt.")
                return ecarts, depense, echecs
            schema = schema_pour(nom)
            resultat = extraire(client, [bloc_document(DOCUMENTS / nom, cote_max)], schema)
            depense += resultat.cout.dollars
            if resultat.erreur:
                echecs.append((nom, resultat.erreur))
            obtenu = resultat.donnees.model_dump() if resultat.donnees else None
            ecarts.extend(comparer(nom, attendu, obtenu, facture=schema is Facture))
    return ecarts, depense, echecs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--budget-max", type=float, default=0.5, help="en dollars")
    parser.add_argument("--cote-max", type=int)
    args = parser.parse_args()

    attendus = json.loads((DOCUMENTS / "attendus.json").read_text(encoding="utf-8"))
    ecarts, depense, echecs = mesurer(anthropic.Anthropic(), attendus, args.repetitions, args.budget_max, args.cote_max)
    resume = resumer(ecarts)
    print(f"\nChamps notés : {resume['champs']}  —  exactitude : {resume['exactitude']:.1%}  —  dépense : {depense:.4f} $")
    print(f"justes {resume['juste']}, manquées {resume['manquée']}, inventées {resume['inventée']}, erronées {resume['erronée']}")
    for e in ecarts:
        if e.issue != "juste":
            print(f"  {e.issue:9} {e.document} {e.champ} : attendu {e.attendu!r}, obtenu {e.obtenu!r}")
    for nom, erreur in echecs:
        print(f"  échec     {nom} : {erreur}")


if __name__ == "__main__":
    main()
