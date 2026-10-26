"""Chapitre 13 : le même agent, hébergé par Anthropic avec Claude Managed Agents (bêta).

Anthropic fait tourner la boucle d'agent ; les outils de l'atelier restent chez vous. Ce sont des
outils personnalisés (custom) : la session émet un appel, ce script l'exécute avec les mêmes
fonctions qu'au Tool Runner, et renvoie le résultat. Aucun outil intégré n'est activé : ni bash,
ni fichiers, ni web. Un budget de session, en cents de dollar, plafonne la dépense ; un délai
interrompt la session si elle tarde.

À la fin, la session, l'agent et l'environnement sont archivés : leur historique reste lisible,
et plus rien ne peut tourner. Rien n'est supprimé.

Lancement, depuis le dossier python/ :  python -m ch13.avec_managed_agents --budget-cents 100
"""

import argparse
import copy
import time

import anthropic
from anthropic.tools import ToolError

from ch13.criteres import criteres
from comptoir import config
from comptoir.agent_reappro import CONSIGNE, SYSTEME, Contexte, Garde, Reglages, creer_outils
from comptoir.atelier import Atelier, rendre_bon
from comptoir.trace import Trace


def sans_references(schema: dict) -> dict:
    """Remplace les $ref par leur définition : un schéma d'outil personnalisé tout d'un bloc."""
    definitions = schema.get("$defs", {})

    def remplacer(noeud):
        if isinstance(noeud, dict):
            if "$ref" in noeud:
                return remplacer(copy.deepcopy(definitions[noeud["$ref"].split("/")[-1]]))
            return {k: remplacer(v) for k, v in noeud.items() if k != "$defs"}
        if isinstance(noeud, list):
            return [remplacer(v) for v in noeud]
        return noeud

    return remplacer(schema)


def outils_personnalises(outils) -> list[dict]:
    return [{"type": "custom", "name": o.name, "description": o.description, "input_schema": sans_references(o.input_schema)}
            for o in outils]


def executer(outils: dict, nom: str, arguments: dict) -> tuple[str, bool]:
    try:
        return outils[nom].call(arguments), False
    except ToolError as erreur:
        return str(erreur), True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget-cents", type=int, default=100, help="plafond dur de la session, en cents de dollar")
    parser.add_argument("--delai", type=float, default=600, help="en secondes : au-delà, la session est interrompue")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    ctx = Contexte(client, Atelier(), Garde(), Trace())
    outils = {o.name: o for o in creer_outils(ctx, Reglages(sous_agent=True))}
    environnement = client.beta.environments.create(
        name="atelier-awa-ch13", config={"type": "cloud", "networking": {"type": "limited"}})
    agent = client.beta.agents.create(name="Réapprovisionnement Délices d'Awa (chapitre 13)", model=config.MODELE,
                                      system=SYSTEME, tools=outils_personnalises(outils.values()))
    session = client.beta.sessions.create(
        agent=agent.id, environment_id=environnement.id, title="Bon du 19 octobre 2026",
        budget={"type": "limit", "max_list_cost": {"amount": str(args.budget_cents), "currency": "USD"}})
    print(f"Environnement {environnement.id}, agent {agent.id} (version {agent.version}), session {session.id}")

    debut, textes, appels, fin = time.perf_counter(), [], [], None
    try:
        with client.beta.sessions.events.stream(session.id) as flux:
            # Le flux ne livre que les événements émis après son ouverture : on l'ouvre d'abord.
            client.beta.sessions.events.send(session.id, events=[
                {"type": "user.message", "content": [{"type": "text", "text": CONSIGNE}]}])
            for evenement in flux:
                if time.perf_counter() - debut > args.delai:
                    client.beta.sessions.events.send(session.id, events=[{"type": "user.interrupt"}])
                    fin = "délai dépassé : session interrompue"
                    break
                if evenement.type == "agent.custom_tool_use":
                    appels.append(evenement.name)
                    texte, erreur = executer(outils, evenement.name, dict(evenement.input))
                    client.beta.sessions.events.send(session.id, events=[{
                        "type": "user.custom_tool_result", "custom_tool_use_id": evenement.id,
                        "content": [{"type": "text", "text": texte}], "is_error": erreur}])
                elif evenement.type == "agent.message":
                    textes += [b.text for b in evenement.content if b.type == "text"]
                elif evenement.type == "session.status_idle":
                    raison = evenement.stop_reason.type if evenement.stop_reason else None
                    if raison in ("end_turn", "budget_reached"):
                        fin = raison
                        break
                    # requires_action : les résultats sont déjà partis, la session repart d'elle-même.
    finally:
        duree = time.perf_counter() - debut
        relue = client.beta.sessions.retrieve(session.id)
        print(f"\nFin : {fin} ; {duree:.1f} s ; appels d'outils : {appels}")
        print(f"Usage de la session : {relue.usage}")
        print(f"Dont sous-agent (appelé par notre code) : {ctx.cout_sous_agent:.4f} $")
        for nom, archiver, identifiant in (("session", client.beta.sessions.archive, session.id),
                                           ("agent", client.beta.agents.archive, agent.id),
                                           ("environnement", client.beta.environments.archive, environnement.id)):
            try:
                archiver(identifiant)
                print(f"{nom} archivé")
            except anthropic.APIError as erreur:
                print(f"{nom} NON archivé : {erreur}")

    print("\nRésumé de l'agent :\n" + "\n".join(textes[-1:]))
    print("\n" + (rendre_bon(ctx.bon) if ctx.bon else "Aucun bon proposé."))
    print("\nCritères : " + ", ".join(f"{k} {'oui' if v else 'NON'}" for k, v in criteres(ctx.bon).items()))


if __name__ == "__main__":
    main()
