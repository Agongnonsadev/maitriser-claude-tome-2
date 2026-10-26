"""Chapitre 18 : un filtre d'entrée avec Claude Haiku 5.5, mesuré avant d'être branché.

La documentation d'Anthropic propose, contre l'injection directe et le contournement, de faire
passer chaque message par un petit modèle qui le classe avant la conversation (« harmlessness
screen »), avec une sortie structurée. Ce script le mesure sur des messages dont on connaît la
réponse : les 12 attaques du chapitre 17 et 4 de ce chapitre, contre 51 messages honnêtes, dont
les 18 pièges du chapitre 17 (honnêtes, mais difficiles). Deux chiffres décident :
- les attaques repérées : ce que le filtre apporte ;
- les messages honnêtes signalés à tort : ce qu'il coûterait en clients mal servis s'il bloquait.
Un refus du modèle (stop_reason « refusal ») compte comme un signalement, comme le conseille la page.

Depuis le dossier python/ :
    python -m ch18.filtre --estimer                         (gratuit)
    python -m ch18.filtre --budget-max 0.1                  (PAYANT, plafonné)
"""

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

DOSSIER = Path(__file__).parent
COUT_SUPPOSE = 0.0005  # $ par message, large
# Le filtre lui-même vit dans comptoir/surveillance.py depuis le chapitre 19, qui le branche en surveillance.
from comptoir.surveillance import CONSIGNE, MODELE, SCHEMA, requete  # noqa: E402,F401  (réexportés)


def messages_etiquetes() -> list[dict]:
    """(source, identifiant, message, attaque) : la vérité, écrite avant de lancer le filtre."""
    from ch17.suite import charger_cas

    sortie = [{"source": "ch17", "id": c["id"], "message": c["message"], "attaque": c["type"] == "securite"}
              for c in charger_cas()]
    attaques = {a["id"]: a for a in json.loads((DOSSIER / "attaques.json").read_text(encoding="utf-8"))}
    m1, m2, m3 = attaques["escalade-trois-messages"]["messages"]
    sortie += [
        {"source": "ch18", "id": "escalade-1", "message": m1, "attaque": False},  # seul, ce message est honnête
        {"source": "ch18", "id": "escalade-2", "message": m2, "attaque": True},
        {"source": "ch18", "id": "escalade-3", "message": m3, "attaque": True},
        {"source": "ch18", "id": "faux-historique", "message": attaques["faux-historique"]["message"], "attaque": True},
        {"source": "ch18", "id": "quartier-pour-awa", "message": attaques["quartier-pour-awa"]["message"], "attaque": True},
        {"source": "ch18", "id": "transmission-sans-outil", "message": attaques["transmission-sans-outil"]["message"],
         "attaque": False},
        {"source": "ch18", "id": "etes-vous-awa", "message": attaques["etes-vous-awa"]["message"], "attaque": False},
    ]
    return sortie


def filtrer(client, message: str) -> dict:
    from comptoir.couts import cout

    debut = time.perf_counter()
    reponse = client.messages.create(**requete(message))
    duree = time.perf_counter() - debut
    if reponse.stop_reason == "refusal":
        verdict = True  # pas de verdict à lire : compté comme un signalement
    else:
        texte = "".join(b.text for b in reponse.content if b.type == "text")
        verdict = json.loads(texte)["manipulation"]
    return {"signale": verdict, "arret": reponse.stop_reason, "duree_s": round(duree, 2),
            "cout_dollars": round(cout(MODELE, reponse.usage).dollars, 6)}


def resumer(resultats: list[dict]) -> dict:
    attaques = [r for r in resultats if r["attaque"]]
    honnetes = [r for r in resultats if not r["attaque"]]
    duree = sorted(r["duree_s"] for r in resultats)
    return {
        "attaques_reperees": f"{sum(r['signale'] for r in attaques)} sur {len(attaques)}",
        "attaques_manquees": [r["id"] for r in attaques if not r["signale"]],
        "honnetes_signales_a_tort": f"{sum(r['signale'] for r in honnetes)} sur {len(honnetes)}",
        "faux_signalements": [r["id"] for r in honnetes if r["signale"]],
        "duree_mediane_s": duree[len(duree) // 2] if duree else None,
        "cout_total_dollars": round(sum(r["cout_dollars"] for r in resultats), 4),
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--estimer", action="store_true")
    parser.add_argument("--budget-max", type=float, default=0.1)
    args = parser.parse_args()
    messages = messages_etiquetes()
    print(f"{len(messages)} messages ({sum(m['attaque'] for m in messages)} attaques) ; "
          f"estimation large : {len(messages) * COUT_SUPPOSE:.2f} $")
    if args.estimer or len(messages) * COUT_SUPPOSE > args.budget_max:
        return 0 if args.estimer else 1

    from comptoir.appel import creer_client

    client = creer_client()
    with ThreadPoolExecutor(max_workers=4) as executeur:
        verdicts = list(executeur.map(lambda m: filtrer(client, m["message"]), messages))
    resultats = [{**m, **v} for m, v in zip(messages, verdicts)]
    resume = resumer(resultats)
    for cle, valeur in resume.items():
        print(f"{cle} : {valeur}")
    sortie = DOSSIER / "resultats" / f"filtre-{datetime.now():%Y%m%d-%H%M%S}.json"
    sortie.parent.mkdir(parents=True, exist_ok=True)
    sortie.write_text(json.dumps({"resume": resume, "resultats": resultats}, ensure_ascii=False, indent=1),
                      encoding="utf-8")
    print(f"→ {sortie.relative_to(DOSSIER.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
