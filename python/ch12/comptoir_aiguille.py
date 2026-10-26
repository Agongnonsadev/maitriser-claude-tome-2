"""Chapitre 12 : les 30 messages, avec et sans routeur, chacun dans une conversation neuve.

- direct : tout part au Comptoir du chapitre 11 (Claude Sonnet 5.5, outils, base, cache d'une heure) ;
- aiguille : le routeur choisit le service, chaque étape est tracée.

Lancement, depuis le dossier python/ :  python -m ch12.comptoir_aiguille --budget-max 1
"""

import argparse
import csv
import json
import statistics
import time
import uuid
from pathlib import Path

from ch12.evaluer_routeur import charger_messages
from comptoir import config
from comptoir.aiguillage import ComptoirAiguille
from comptoir.appel import creer_client
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.commandes import ComptoirCommandes
from comptoir.connaissances import charger_base

DOSSIER = Path(__file__).parent


def cout_journal(depuis: int) -> tuple[float, int]:
    with open(config.JOURNAL, encoding="utf-8") as f:
        lignes = [json.loads(l) for l in f][depuis:]
    appels = [l for l in lignes if "requete" in l]
    return sum(l["cout_dollars"] for l in appels), len(appels)


def taille_journal() -> int:
    try:
        with open(config.JOURNAL, encoding="utf-8") as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--modes", nargs="+", choices=["direct", "aiguille"], default=["direct", "aiguille"])
    parser.add_argument("--budget-max", type=float, default=1.0)
    parser.add_argument("--traces", nargs="*", default=["godomey", "malaise", "six-bissap"])
    args = parser.parse_args()

    client, base, lignes, depense = creer_client(), charger_base(), [], 0.0
    for mode in args.modes:
        for m in charger_messages():
            if depense >= args.budget_max:
                raise SystemExit(f"Budget de {args.budget_max} $ atteint : arrêt.")
            boutique, conversation = Boutique(":memory:"), uuid.uuid4().hex
            avant, debut = taille_journal(), time.perf_counter()
            if mode == "direct":
                comptoir = ComptoirCommandes(client, boutique, Budget(":memory:"), conversation, version_prompt="v3",
                                             connaissances=base, cache="1h")
                texte, categorie, trace = comptoir.repondre(m["message"]).texte, "—", None
            else:
                # Le Comptoir de ce chapitre : Claude Sonnet 5.5 (le chapitre 17 l'a remplacé par Haiku 5.5).
                r = ComptoirAiguille(client, boutique, Budget(":memory:"), conversation, base,
                                     modele_comptoir=config.MODELE).repondre(m["message"])
                texte, categorie, trace = r.texte, r.categorie, r.trace
            duree = time.perf_counter() - debut
            cout, appels = cout_journal(avant)
            depense += cout
            lignes.append({"mode": mode, "id": m["id"], "attendu": m["attendu"], "categorie": categorie,
                           "appels": appels, "cout_dollars": round(cout, 6), "duree_s": round(duree, 2),
                           "demandes_pour_awa": len(boutique.demandes()), "reponse": texte})
            if trace and m["id"] in args.traces:
                print(f"\n--- {m['id']} : {m['message']}\n{texte}\n{trace.afficher()}")

    sortie = DOSSIER / "resultats" / "comptoir.csv"
    sortie.parent.mkdir(parents=True, exist_ok=True)
    if sortie.exists():  # relancer un seul mode garde les lignes de l'autre
        with sortie.open(encoding="utf-8", newline="") as f:
            lignes = [l for l in csv.DictReader(f) if l["mode"] not in args.modes] + lignes
    with sortie.open("w", newline="", encoding="utf-8") as f:
        ecrivain = csv.DictWriter(f, fieldnames=list(lignes[0]))
        ecrivain.writeheader()
        ecrivain.writerows(lignes)

    print(f"\n{'mode':9} {'catégorie attendue':20} {'messages':>8} {'appels':>7} {'coût moyen':>11} {'durée méd.':>11}")
    for mode in args.modes:
        for attendu in ("information", "commande", "reclamation", "autre", None):
            g = [l for l in lignes if l["mode"] == mode and (attendu is None or l["attendu"] == attendu)]
            print(f"{mode:9} {attendu or 'TOUT':20} {len(g):>8} {sum(l['appels'] for l in g):>7} "
                  f"{statistics.mean(l['cout_dollars'] for l in g):>11.5f} {statistics.median(l['duree_s'] for l in g):>10.1f}s")
    print(f"\nDépense : {depense:.4f} $ ; réponses à relire : {sortie}")


if __name__ == "__main__":
    main()
