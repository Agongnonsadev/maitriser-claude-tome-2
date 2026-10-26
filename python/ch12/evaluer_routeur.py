"""Chapitre 12 : le routeur classe-t-il bien ? 30 messages, plusieurs réglages, plusieurs passes.

Pour chaque réglage : la réussite, les réclamations manquées (le seul échec interdit), le coût
et la durée par message. Le vote à trois est calculé à partir des trois passes, sans appel de plus.

Lancement, depuis le dossier python/ :  python -m ch12.evaluer_routeur --repetitions 3 --budget-max 0.5
"""

import argparse
import csv
import json
import statistics
import time
from collections import Counter
from pathlib import Path

import anthropic

from comptoir.routeur import Decision, RoutageImpossible, classer, par_le_code, voter

DOSSIER = Path(__file__).parent
REGLAGES = {
    "haiku": {"modele": "claude-haiku-5-5"},
    "haiku-sans-reflexion": {"modele": "claude-haiku-5-5", "sans_reflexion": True},
    "sonnet-low": {"modele": "claude-sonnet-5-5", "effort": "low"},
}


def charger_messages() -> list[dict]:
    return json.loads((DOSSIER / "messages.json").read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--reglages", nargs="+", choices=list(REGLAGES), default=list(REGLAGES))
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--budget-max", type=float, default=0.5)
    args = parser.parse_args()

    client, messages, lignes, depense = anthropic.Anthropic(), charger_messages(), [], 0.0
    for nom in args.reglages:
        for m in messages:
            for passe in range(1, args.repetitions + 1):
                if depense >= args.budget_max:
                    raise SystemExit(f"Budget de {args.budget_max} $ atteint : arrêt.")
                debut = time.perf_counter()
                try:
                    decision = par_le_code(m["message"]) or classer(client, m["message"], **REGLAGES[nom])
                except RoutageImpossible as erreur:  # compté comme une erreur de classement
                    decision = Decision("erreur", str(erreur), REGLAGES[nom]["modele"])
                duree = time.perf_counter() - debut
                depense += decision.cout
                lignes.append({"reglage": nom, "id": m["id"], "passe": passe, "attendu": m["attendu"],
                               "obtenu": decision.categorie, "raison": decision.raison, "par": decision.par,
                               "cout_dollars": round(decision.cout, 6), "duree_s": round(duree, 2)})

    sortie = DOSSIER / "resultats" / "routage.csv"
    sortie.parent.mkdir(parents=True, exist_ok=True)
    with sortie.open("w", newline="", encoding="utf-8") as f:
        ecrivain = csv.DictWriter(f, fieldnames=list(lignes[0]))
        ecrivain.writeheader()
        ecrivain.writerows(lignes)

    print(f"{'réglage':22} {'réussite':>9} {'vote à 3':>9} {'récl. manquées':>15} {'coût/message':>13} {'durée méd.':>11}")
    for nom in args.reglages:
        g = [l for l in lignes if l["reglage"] == nom]
        justes = sum(l["obtenu"] == l["attendu"] for l in g)
        votes = {}
        for m in messages:
            passes = [Decision(l["obtenu"], "", l["par"]) for l in g if l["id"] == m["id"] and l["obtenu"] != "erreur"]
            votes[m["id"]] = voter(passes) if passes else "erreur"
        vote_juste = sum(votes[m["id"]] == m["attendu"] for m in messages)
        manquees = sum(l["attendu"] == "reclamation" and l["obtenu"] != "reclamation" for l in g)
        appels = [l for l in g if l["par"] != "code"]
        print(f"{nom:22} {justes:>4}/{len(g):<4} {vote_juste:>4}/{len(messages):<4} {manquees:>15} "
              f"{statistics.mean(l['cout_dollars'] for l in appels):>13.6f} {statistics.median(l['duree_s'] for l in appels):>10.1f}s")
        erreurs = Counter((l["id"], l["attendu"], l["obtenu"]) for l in g if l["obtenu"] != l["attendu"])
        for (identifiant, attendu, obtenu), n in sorted(erreurs.items()):
            print(f"{'':22}   {identifiant} : {attendu} → {obtenu} ({n} fois sur {args.repetitions})")
    print(f"\nDépense : {depense:.4f} $ ; détail : {sortie}")


if __name__ == "__main__":
    main()
