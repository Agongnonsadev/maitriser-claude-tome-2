"""Chapitre 13 : l'agent de réapprovisionnement, lancé chaque lundi à 7 h par Managed Agents (bêta).

Par défaut, ce script n'appelle pas l'API : il affiche la requête qu'il enverrait. Avec --creer,
il crée un déploiement planifié, qui lancera une session chaque lundi, avec son budget, jusqu'à
ce que vous l'archiviez (python -m ch13.planifier_lundi --archiver ID). Chaque session coûte.

Attention : l'agent du chapitre a des outils personnalisés, exécutés par votre code. Une session
planifiée qui appelle un tel outil se met en attente (requires_action) tant que personne ne
répond. Pour une planification, il faut donc un programme à l'écoute des événements (webhooks),
ou des outils qui tournent côté Anthropic : un serveur MCP (chapitres 14 à 16).

Lancement, depuis le dossier python/ :
    python -m ch13.planifier_lundi --agent AGENT_ID --environnement ENV_ID            (affiche seulement)
    python -m ch13.planifier_lundi --agent AGENT_ID --environnement ENV_ID --creer    (crée le déploiement)
"""

import argparse
import json

import anthropic

from comptoir.agent_reappro import CONSIGNE

LUNDI_7H = {"type": "cron", "expression": "0 7 * * 1", "timezone": "Africa/Porto-Novo"}


def requete(agent: str, environnement: str, budget_cents: int) -> dict:
    return {
        "name": "Réapprovisionnement du lundi",
        "agent": agent,
        "environment_id": environnement,
        "initial_events": [{"type": "user.message", "content": [{"type": "text", "text": CONSIGNE}]}],
        "schedule": LUNDI_7H,
        # Copié sur chaque session lancée : il borne chaque lundi, pas le total.
        "budget": {"type": "limit", "max_list_cost": {"amount": str(budget_cents), "currency": "USD"}},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--agent")
    parser.add_argument("--environnement")
    parser.add_argument("--budget-cents", type=int, default=50)
    parser.add_argument("--creer", action="store_true", help="crée vraiment le déploiement (payant chaque lundi)")
    parser.add_argument("--archiver", metavar="DEPLOIEMENT_ID", help="archive un déploiement : plus aucun lancement")
    args = parser.parse_args()

    if args.archiver:
        anthropic.Anthropic().beta.deployments.archive(args.archiver)
        print(f"Déploiement {args.archiver} archivé : il ne lancera plus rien.")
        return
    if not (args.agent and args.environnement):
        parser.error("--agent et --environnement sont nécessaires")
    corps = requete(args.agent, args.environnement, args.budget_cents)
    if not args.creer:
        print("Requête qui serait envoyée (rien n'est créé sans --creer) :")
        print(json.dumps(corps, ensure_ascii=False, indent=2))
        return
    deploiement = anthropic.Anthropic().beta.deployments.create(**corps)
    print(f"Déploiement {deploiement.id} créé ; prochains lancements : {deploiement.schedule.upcoming_runs_at}")
    print(f"Pour l'arrêter : python -m ch13.planifier_lundi --archiver {deploiement.id}")


if __name__ == "__main__":
    main()
