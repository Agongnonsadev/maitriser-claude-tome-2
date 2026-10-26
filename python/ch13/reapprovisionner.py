"""Chapitre 13 : une séance de l'agent de réapprovisionnement, avec sa trace, son bon et ses critères.

Lancement, depuis le dossier python/ :  python -m ch13.reapprovisionner
Variantes :  --sans-sous-agent   --modele claude-haiku-5-5   --memoire memoire_atelier
             --budget-de-tache 40000   --effacer-apres 8000   --compacter-apres-tour 2
             --tours-max 3   --budget-max 0.05
"""

import argparse
from pathlib import Path

import anthropic

from ch13.criteres import criteres
from comptoir import config
from comptoir.agent_reappro import Garde, Reglages, lancer
from comptoir.atelier import Atelier, rendre_bon


def arguments(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    parser.add_argument("--modele", default=config.MODELE)
    parser.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--sans-sous-agent", action="store_true", help="l'agent lit lui-même tous les messages")
    parser.add_argument("--memoire", type=Path, help="dossier de la mémoire de l'agent, gardé d'une semaine à l'autre")
    parser.add_argument("--budget-de-tache", type=int, help="en tokens, 20 000 au moins (bêta)")
    parser.add_argument("--effacer-apres", type=int, help="efface les anciens résultats d'outils au-delà de N tokens")
    parser.add_argument("--compacter-apres-tour", type=int, help="résume la séance après ce tour (bêta)")
    parser.add_argument("--tours-max", type=int, default=20)
    parser.add_argument("--budget-max", type=float, default=0.50, help="en dollars, pour la séance")
    parser.add_argument("--delai", type=float, default=300, help="en secondes, pour la séance")
    return parser


def reglages_et_garde(args) -> tuple[Reglages, Garde]:
    return (Reglages(modele=args.modele, effort=args.effort, sous_agent=not args.sans_sous_agent,
                     memoire=args.memoire, budget_de_tache=args.budget_de_tache,
                     effacer_resultats_apres=args.effacer_apres, compacter_apres_tour=args.compacter_apres_tour),
            Garde(tours_max=args.tours_max, budget_dollars=args.budget_max, delai_s=args.delai))


def main() -> None:
    parser = arguments(argparse.ArgumentParser(description=__doc__.splitlines()[0]))
    parser.add_argument("--bons", type=Path, help="fichier où garder les bons proposés (par défaut : en mémoire)")
    args = parser.parse_args()
    reglages, garde = reglages_et_garde(args)
    if args.memoire:
        args.memoire.mkdir(parents=True, exist_ok=True)
    resultat = lancer(anthropic.Anthropic(), Atelier(bons=args.bons), reglages, garde)
    print(resultat.trace.afficher())
    print(f"\nArrêt : {resultat.arret or 'terminé par l agent'} ; {resultat.tours} tours ; {resultat.depense:.4f} $ "
          f"(dont sous-agent {resultat.cout_sous_agent:.4f} $) ; {resultat.duree_s:.1f} s ; "
          f"plus gros contexte : {resultat.pic_contexte} tokens")
    if resultat.effacements:
        print(f"Effacements : {resultat.effacements}")
    print("\n" + (rendre_bon(resultat.bon) if resultat.bon else "Aucun bon proposé."))
    print("\nRésumé de l'agent :\n" + resultat.texte)
    print("\nCritères : " + ", ".join(f"{k} {'oui' if v else 'NON'}"
                                      for k, v in criteres(resultat.bon, memoire=args.memoire is not None).items()))


if __name__ == "__main__":
    main()
