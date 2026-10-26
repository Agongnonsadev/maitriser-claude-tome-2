"""Chapitre 13 : Awa valide ou refuse un bon proposé par l'agent, et peut lui laisser un retour.

Lancement, depuis le dossier python/ :
    python -m ch13.valider_bon --bons bons.json --lister
    python -m ch13.valider_bon --bons bons.json BC-1a2b3c --valider
    python -m ch13.valider_bon --bons bons.json BC-1a2b3c --refuser --note "..." --memoire memoire_atelier

La décision ne passe par aucun modèle : c'est le seul chemin qui fasse sortir un bon de
« à valider ». La note, si un dossier de mémoire est donné, est ajoutée au fichier que l'agent
lira lundi prochain. C'est le code qui l'écrit, pas l'agent.
"""

import argparse
from datetime import date
from pathlib import Path

from comptoir.atelier import Atelier, rendre_bon

FICHIER_RETOURS = "retours-awa.md"


def laisser_un_retour(memoire: Path, code: str, decision: str, note: str, jour: date) -> Path:
    # L'outil mémoire du SDK sert le sous-dossier « memories » du dossier donné : c'est là qu'il faut écrire.
    racine = memoire / "memories"
    racine.mkdir(parents=True, exist_ok=True)
    chemin = racine / FICHIER_RETOURS
    if not chemin.exists():
        chemin.write_text("# Retours d'Awa sur les bons de commande\n\n", encoding="utf-8")
    with chemin.open("a", encoding="utf-8") as f:
        f.write(f"- {jour.isoformat()}, bon {code} {decision} : {note}\n")
    return chemin


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bons", type=Path, required=True)
    parser.add_argument("code", nargs="?")
    decision = parser.add_mutually_exclusive_group()
    decision.add_argument("--valider", action="store_true")
    decision.add_argument("--refuser", action="store_true")
    decision.add_argument("--lister", action="store_true")
    parser.add_argument("--note")
    parser.add_argument("--memoire", type=Path, help="le dossier de mémoire de l'agent")
    args = parser.parse_args()

    atelier = Atelier(bons=args.bons)
    if args.lister or not args.code:
        for bon in atelier.bons():
            print(rendre_bon(bon) + "\n")
        return
    if not (args.valider or args.refuser):
        parser.error("--valider ou --refuser")
    bon = atelier.decider(args.code, valide=args.valider, note=args.note)
    print(rendre_bon(bon))
    if args.note and args.memoire:
        chemin = laisser_un_retour(args.memoire, bon.code, bon.statut, args.note, atelier.aujourdhui)
        print(f"Retour laissé dans {chemin}")


if __name__ == "__main__":
    main()
