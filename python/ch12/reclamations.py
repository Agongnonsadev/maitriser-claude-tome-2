"""Chapitre 12 : la chaîne des réclamations, sur les six réclamations de test, avec leur trace.

Lancement, depuis le dossier python/ :  python -m ch12.reclamations
Comparer deux efforts de rédaction :     python -m ch12.reclamations --effort defaut --repetitions 2
                                          python -m ch12.reclamations --effort low --repetitions 2
"""

import argparse
import statistics
import uuid

import anthropic

from ch12.evaluer_routeur import charger_messages
from comptoir import reclamations
from comptoir.boutique import Boutique
from comptoir.trace import Trace


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seulement", nargs="*")
    parser.add_argument("--effort", choices=["defaut", "low", "medium", "high"],
                        help="effort de la rédaction ; sans cette option, celui du module ; « defaut » : celui du modèle")
    parser.add_argument("--repetitions", type=int, default=1)
    args = parser.parse_args()
    effort = {None: reclamations.EFFORT_REDACTION, "defaut": None}.get(args.effort, args.effort)
    client, boutique, traces, resultats = anthropic.Anthropic(), Boutique(":memory:"), [], []
    choisis = [m for m in charger_messages() if m["attendu"] == "reclamation"]
    for _ in range(args.repetitions):
        for m in [m for m in choisis if not args.seulement or m["id"] in args.seulement]:
            trace = Trace()
            resultat = reclamations.traiter(client, m["message"], boutique, uuid.uuid4().hex, trace, effort=effort)
            traces.append(trace)
            resultats.append(resultat)
            print(f"\n=== {m['id']} ===\nClient   : {m['message']}\nComptoir : {resultat.reponse}")
            print(f"Faits    : {resultat.faits}")
            print(f"À demander : {resultat.manques or 'rien'} ; versions : {resultat.tentatives} ; "
                  f"texte de repli : {'oui' if resultat.repli else 'non'}")
            for numero, (version, critique) in enumerate(zip(resultat.versions, resultat.critiques), start=1):
                print(f"Version {numero}, refusée : {version}")
                print(f"  Critique : {critique}")
            print(trace.afficher())
    coupees = sum(c.startswith("réponse arrêtée") for r in resultats for c in r.critiques)
    print(f"\nEffort de rédaction : {effort or 'défaut du modèle'} ; réclamations : {len(resultats)} ; "
          f"conformes à la 1re version : {sum(r.tentatives == 1 and not r.repli for r in resultats)} ; "
          f"rédactions coupées : {coupees} ; textes de repli : {sum(r.repli for r in resultats)}")
    print(f"Coût moyen : {statistics.mean(t.cout for t in traces):.5f} $ ; durée médiane : "
          f"{statistics.median(t.duree_ms for t in traces) / 1000:.1f} s ; coût total : {sum(t.cout for t in traces):.4f} $ ; "
          f"demandes enregistrées pour Awa : {len(boutique.demandes())}")


if __name__ == "__main__":
    main()
