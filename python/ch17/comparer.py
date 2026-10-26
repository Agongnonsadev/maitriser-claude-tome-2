"""Chapitre 17 : comparer deux séries d'essais, cas par cas, et dire si l'écart dépasse le hasard.

Lancement, depuis le dossier python/ (gratuit : aucun appel) :
    python -m ch17.comparer <série A> <série B> [--modele-juge claude-haiku-5-5]

Trois précautions :
- les deux séries doivent avoir reçu les mêmes messages (empreinte des cas, au registre) ; elles
  sont notées ici par la même notation, celle du jour ;
- on compare cas par cas : un cas gagné, un cas perdu, et non une moyenne ;
- le test du signe dit si une majorité de cas qui bougent dans le même sens peut venir du hasard.
  Il ne prouve rien sur un ou deux cas : il faut alors plus d'essais, ou plus de cas.
"""

import argparse
import json
from math import comb
from pathlib import Path

from ch17.juge import GRILLE
from ch17.suite import REGISTRE, afficher, charger_cas, lire_jugements, lire_serie, resumer, taux_par_cas


def test_du_signe(gagnes: int, perdus: int) -> float:
    """Probabilité d'un écart au moins aussi net si les deux versions se valaient (bilatérale)."""
    n = gagnes + perdus
    if n == 0:
        return 1.0
    k = min(gagnes, perdus)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)


def entree(serie: Path) -> dict | None:
    if not REGISTRE.exists():
        return None
    with REGISTRE.open(encoding="utf-8") as f:
        lignes = [json.loads(l) for l in f if l.strip()]
    return next((l for l in reversed(lignes) if l["serie"] == serie.name), None)


def comparer(a: dict[str, float], b: dict[str, float]) -> tuple[list[str], list[str]]:
    """Les cas mieux réussis par B, et ceux mieux réussis par A."""
    communs = sorted(set(a) & set(b))
    return [c for c in communs if b[c] > a[c]], [c for c in communs if b[c] < a[c]]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("a")
    parser.add_argument("b")
    parser.add_argument("--modele-juge")
    parser.add_argument("--grille", default=GRILLE)
    args = parser.parse_args()
    cas = charger_cas()
    series = [Path(args.a), Path(args.b)]
    infos = [entree(s) for s in series]
    if all(infos):
        for cle in ("empreinte_cas", "jeu"):
            if infos[0][cle] != infos[1][cle]:
                raise SystemExit(f"Séries incomparables : {cle} différent ({infos[0][cle]} / {infos[1][cle]}).")
    taux = []
    for s, info in zip(series, infos):
        essais = lire_serie(s)
        jugements = lire_jugements(s, args.modele_juge, args.grille) if args.modele_juge else None
        print(f"\n{s.name}" + (f" — {info['versions']}" if info else ""))
        print(afficher(resumer(essais, cas, jugements)))
        taux.append(taux_par_cas(essais, cas, jugements))
    gagnes, perdus = comparer(*taux)
    print(f"\nCas mieux réussis par B : {len(gagnes)} {gagnes}")
    print(f"Cas mieux réussis par A : {len(perdus)} {perdus}")
    print(f"Test du signe : p = {test_du_signe(len(gagnes), len(perdus)):.2f} "
          "(sous 0,05, l'écart a peu de chances de venir du hasard)")


if __name__ == "__main__":
    main()
