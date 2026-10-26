"""Chapitre 19 : le coût par conversation du Comptoir en ligne, et chaque levier mesuré à part.

Depuis le dossier python/ :
    python -m ch19.mesurer_cout --estimer                                         (gratuit)
    python -m ch19.mesurer_cout --variante livree --essais 3 --budget-max 0.2     (PAYANT, plafonné)
    python -m ch19.mesurer_cout --variante effort-low --essais 3 --budget-max 0.2
    python -m ch19.mesurer_cout --variante sans-cache --essais 3 --budget-max 0.3

Huit conversations types (ch19/conversations.json), du simple « vous livrez à… ? » à la commande
confirmée par son code, passent par le service en ligne (comptoir/service.py) : la conversation gardée
en base, le budget par message, le Comptoir aiguillé. « OUI {code} » est remplacé par le code du
dernier récapitulatif, lu dans la boutique, comme le ferait le client.

Chaque essai part d'une boutique neuve à heure fixe (le banc du chapitre 17). Les conversations se
suivent, comme dans une journée : la première écrit le cache d'une heure, les suivantes le lisent.
Un enregistreur garde chaque appel : modèle, tokens d'entrée, de cache et de sortie, coût, durée.
Une variante ne change qu'une chose par rapport à la version livrée.
"""

import argparse
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from ch17.banc import Enregistreur, environnement
from comptoir.budget import Budget
from comptoir.conversations import Conversations
from comptoir.service import ServiceComptoir

DOSSIER = Path(__file__).parent
RESULTATS = DOSSIER / "resultats" / "couts"
VARIANTES = {
    "livree": {},                                   # Haiku 5.5, effort par défaut (medium), cache d'une heure
    "effort-low": {"effort_comptoir": "low"},       # l'effort du Comptoir à low
    "sans-cache": {"cache": False},                 # sans cache, pour voir ce qu'il rapporte
}
COUT_SUPPOSE_PAR_MESSAGE = 0.003  # $ : large


@dataclass
class Conversation:
    variante: str
    id: str
    essai: int
    messages: int = 0
    categories: list[str] = field(default_factory=list)
    cout_dollars: float = 0.0
    appels: int = 0
    tokens: dict = field(default_factory=dict)
    durees_ms: list[int] = field(default_factory=list)
    commandes: int = 0
    erreurs: list[str] = field(default_factory=list)


def charger_conversations() -> list[dict]:
    return json.loads((DOSSIER / "conversations.json").read_text(encoding="utf-8"))


def code_en_attente(boutique, conversation: str) -> str | None:
    attente = [code for code, statut, _, _ in boutique.recapitulatifs(conversation) if statut == "en_attente"]
    return attente[-1] if attente else None


def jouer(service: ServiceComptoir, enregistreur: Enregistreur, scenario: dict, variante: str, essai: int) -> Conversation:
    resultat = Conversation(variante, scenario["id"], essai)
    avant = len(enregistreur.appels)
    conversation, _, _ = service.ouvrir(None)
    for message in scenario["messages"]:
        if "{code}" in message:
            code = code_en_attente(service.boutique, conversation)
            if code is None:
                resultat.erreurs.append("aucun récapitulatif à confirmer")
                continue
            message = message.replace("{code}", code)
        tour = service.repondre(conversation, message, "mesure", groupe="mesure")
        resultat.messages += 1
        resultat.categories.append(tour.categorie)
        resultat.cout_dollars += tour.cout_dollars
        resultat.durees_ms.append(tour.duree_ms)
        if tour.erreur:
            resultat.erreurs.append(tour.erreur)
    appels = enregistreur.appels[avant:]
    resultat.appels = len(appels)
    resultat.tokens = {cle: sum(a["tokens"][cle] for a in appels)
                       for cle in ("entree", "ecriture_cache", "lecture_cache", "sortie")}
    resultat.commandes = sum(1 for c in service.boutique.commandes() if c[2] == conversation)
    resultat.cout_dollars = round(resultat.cout_dollars, 6)
    return resultat


def resumer(conversations: list[Conversation]) -> dict:
    couts = [c.cout_dollars for c in conversations]
    messages = sum(c.messages for c in conversations)
    durees = sorted(d for c in conversations for d in c.durees_ms)
    return {
        "conversations": len(conversations),
        "messages": messages,
        "cout_total": round(sum(couts), 4),
        "cout_moyen_conversation": round(statistics.mean(couts), 5) if couts else None,
        "cout_moyen_message": round(sum(couts) / messages, 5) if messages else None,
        "appels_par_message": round(sum(c.appels for c in conversations) / messages, 2) if messages else None,
        "tokens": {cle: sum(c.tokens.get(cle, 0) for c in conversations)
                   for cle in ("entree", "ecriture_cache", "lecture_cache", "sortie")},
        "latence_mediane_s": round(durees[len(durees) // 2] / 1000, 1) if durees else None,
        "latence_p90_s": round(durees[min(len(durees) - 1, round(0.9 * (len(durees) - 1)))] / 1000, 1) if durees else None,
        "commandes_creees": sum(c.commandes for c in conversations),
        "erreurs": [e for c in conversations for e in c.erreurs],
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--variante", default="livree", choices=sorted(VARIANTES))
    parser.add_argument("--essais", type=int, default=3)
    parser.add_argument("--budget-max", type=float, default=0.2)
    parser.add_argument("--estimer", action="store_true")
    args = parser.parse_args()
    scenarios = charger_conversations()
    estimation = sum(len(s["messages"]) for s in scenarios) * args.essais * COUT_SUPPOSE_PAR_MESSAGE
    print(f"{len(scenarios)} conversations, {sum(len(s['messages']) for s in scenarios)} messages, {args.essais} essai(s) ; "
          f"estimation large : {estimation:.2f} $")
    if args.estimer:
        return 0

    from comptoir.appel import creer_client
    from comptoir.connaissances import charger_base

    client, base, resultats, depense = creer_client(), charger_base(), [], 0.0
    for essai in range(1, args.essais + 1):
        enregistreur = Enregistreur(client)
        service = ServiceComptoir(enregistreur, environnement(), Budget(":memory:"), Conversations(), base,
                                  **VARIANTES[args.variante])
        for scenario in scenarios:
            if depense >= args.budget_max:
                print(f"Arrêt : plafond de {args.budget_max} $ atteint.")
                break
            c = jouer(service, enregistreur, scenario, args.variante, essai)
            depense += c.cout_dollars
            resultats.append(c)
            print(f"  {args.variante:10} {c.id:22} {essai}  {c.cout_dollars:.5f} $  {c.appels:2} appels  "
                  f"{' > '.join(c.categories)}  {'; '.join(c.erreurs)}")
    resume = resumer(resultats)
    RESULTATS.mkdir(parents=True, exist_ok=True)
    sortie = RESULTATS / f"{datetime.now():%Y%m%d-%H%M%S}-{args.variante}.json"
    sortie.write_text(json.dumps({"variante": args.variante, "reglages": VARIANTES[args.variante], "resume": resume,
                                  "conversations": [asdict(c) for c in resultats]}, ensure_ascii=False, indent=1),
                      encoding="utf-8")
    print(json.dumps(resume, ensure_ascii=False, indent=1))
    print(f"→ {sortie.relative_to(DOSSIER.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
