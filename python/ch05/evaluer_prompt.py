"""Chapitre 5 : comparer la version 0 du prompt (chapitre 2) et la version 1, sur 20 cas.

Une seule chose change entre les deux variantes : le prompt système (et la balise autour
du message du client, qui va avec). Le modèle, l'effort et max_tokens sont les mêmes.

Lancement, depuis le dossier python/ :
    python -m ch05.evaluer_prompt --estimer
    python -m ch05.evaluer_prompt --repetitions 3 --budget-max 1
    python -m ch05.evaluer_prompt --renoter      (gratuit : la grille actuelle, sur les réponses déjà obtenues)
"""

import argparse
import json
from pathlib import Path

import anthropic

from ch02.comptoir_cli import PROMPT_SYSTEME as PROMPT_V0
from comptoir import config
from comptoir.assistant import MAX_TOKENS, construire_requete
from comptoir.couts import TARIFS
from comptoir.evaluation import ecrire_csv, evaluer, lire_csv, regressions, renoter, resumer
from comptoir.notation import Cas
from comptoir.prompt import charger

DOSSIER = Path(__file__).parent


def requete_v0(cas: Cas) -> dict:
    requete = {
        "model": config.MODELE,
        "max_tokens": MAX_TOKENS,
        "system": PROMPT_V0,
        "messages": [{"role": "user", "content": cas.question}],
    }
    if config.EFFORT:
        requete["output_config"] = {"effort": config.EFFORT}
    return requete


def requete_v1(cas: Cas) -> dict:
    return construire_requete(cas.question, prompt=charger("v1"))


VARIANTES = {"v0": requete_v0, "v1": requete_v1}


def charger_cas() -> list[Cas]:
    return [Cas.depuis_dict(d) for d in json.loads((DOSSIER / "cas.json").read_text(encoding="utf-8"))]


def estimer(client, cas, repetitions: int, sortie_supposee: int) -> float:
    tarif = TARIFS[config.MODELE]
    total = 0.0
    for construire in VARIANTES.values():
        for c in cas:
            requete = construire(c)
            comptage = {k: requete[k] for k in ("model", "system", "messages")}
            entree = client.messages.count_tokens(**comptage).input_tokens
            total += repetitions * (entree * tarif.entree + sortie_supposee * tarif.sortie) / 1_000_000
    return total


def afficher(essais) -> None:
    for ligne in resumer(essais):
        par_reussite = f"{ligne['cout_par_reussite']:.5f} $" if ligne["cout_par_reussite"] else "—"
        print(f"{ligne['variante']} : réussite {ligne['reussite']:.0%} · {par_reussite} par réussite · "
              f"latence médiane {ligne['latence_mediane_s']:.1f} s")
    perdus = regressions(essais, "v0", "v1")
    print("Régressions de v1 par rapport à v0 :", ", ".join(perdus) if perdus else "aucune")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--budget-max", type=float, default=1.0)
    parser.add_argument("--estimer", action="store_true")
    parser.add_argument("--sortie-supposee", type=int, default=250)
    parser.add_argument("--renoter", action="store_true")
    args = parser.parse_args()

    if args.renoter:
        essais = renoter(lire_csv(DOSSIER / "resultats" / "essais.csv"), charger_cas())
        ecrire_csv(essais, DOSSIER / "resultats" / "essais-renotes.csv")
        afficher(essais)
        return

    client = anthropic.Anthropic()
    cas = charger_cas()
    print(f"Modèle : {config.MODELE} · effort : {config.EFFORT or 'défaut'} · prompt v1 : {charger('v1').identifiant}")
    if args.estimer:
        total = estimer(client, cas, args.repetitions, args.sortie_supposee)
        print(f"Coût estimé : {total:.2f} $ ({len(cas)} cas × 2 versions × {args.repetitions} répétitions)")
        return

    essais = evaluer(client, cas, VARIANTES, args.repetitions, args.budget_max)
    ecrire_csv(essais, DOSSIER / "resultats" / "essais.csv")
    afficher(essais)


if __name__ == "__main__":
    main()
