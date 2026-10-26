"""Chapitre 8 : le tableau de bord du Comptoir, tiré du journal. Aucun appel à l'API.

Lancement, depuis le dossier python/ :
    python -m ch08.tableau_de_bord
    python -m ch08.tableau_de_bord --html journal/tableau.html
"""

import argparse
from pathlib import Path

from comptoir import config
from comptoir.tableau import a_reprendre, charger, en_html, latences, modes_d_echec, par_jour


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--journal", default=config.JOURNAL)
    parser.add_argument("--html", help="écrire aussi une page HTML à ce chemin")
    args = parser.parse_args()

    lignes = charger(args.journal)
    print("Jour        Appels   Coût ($)    FCFA   Échecs")
    for jour, j in par_jour(lignes).items():
        print(f"{jour}  {j['appels']:6}  {j['dollars']:9.4f}  {j['dollars'] * config.TAUX_FCFA:6.0f}   {j['echecs']:6}")
    mediane, p95 = latences(lignes)
    if mediane is not None:
        print(f"\nLatence des appels réussis : médiane {mediane:.0f} ms, 95e centile {p95:.0f} ms")
    echecs = modes_d_echec(lignes)
    if echecs:
        print("\nModes d'échec (origine, code) :")
        for (origine, code), nombre in echecs.most_common():
            print(f"  {origine:12} {code:22} {nombre}")
    reprendre = a_reprendre(lignes)
    if reprendre:
        print("\nConversations à reprendre par Awa :")
        for r in reprendre:
            print(f"  {r['date']}  {r['conversation']}  ({r['motif']})")
    if args.html:
        Path(args.html).write_text(en_html(lignes), encoding="utf-8")
        print(f"\nPage écrite : {args.html}")


if __name__ == "__main__":
    main()
