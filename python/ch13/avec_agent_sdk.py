"""Chapitre 13 : le même agent, construit avec le Claude Agent SDK, le moteur de Claude Code en bibliothèque.

- les outils de l'atelier, les mêmes fonctions qu'avec le Tool Runner, deviennent un serveur MCP
  qui tourne dans ce processus ;
- aucun outil intégré de Claude Code, sauf Agent, qui confie une tâche à un sous-agent ;
- un sous-agent « lecteur », sur Claude Haiku 5.5, est le seul à pouvoir lire les messages des
  fournisseurs : un hook PreToolUse le vérifie à chaque appel, par le code ;
- un hook PostToolUse note chaque action dans le journal ;
- aucun réglage de l'utilisateur n'est chargé (setting_sources=[]), la configuration de Claude
  Code est neuve (CLAUDE_CONFIG_DIR), et l'agent travaille dans un dossier vide.

Lancement, depuis le dossier python/ :  python -m ch13.avec_agent_sdk --budget-max 0.60
"""

import argparse
import asyncio
import tempfile
import time
from pathlib import Path

from anthropic.tools import ToolError
from claude_agent_sdk import (AgentDefinition, AssistantMessage, ClaudeAgentOptions, HookMatcher, ResultMessage,
                              create_sdk_mcp_server, query, tool)

from ch13.criteres import criteres
from comptoir import config
from comptoir.agent_reappro import CONSIGNE, LECTEUR, SYSTEME, Contexte, Garde, Reglages, creer_outils
from comptoir.atelier import Atelier, rendre_bon
from comptoir.journal import noter_evenement
from comptoir.trace import Trace

SERVEUR = "atelier"
LECTURE = f"mcp__{SERVEUR}__lire_messages_fournisseurs"


def serveur_de_l_atelier(ctx: Contexte):
    """Les outils du Tool Runner, enveloppés pour le SDK : même nom, même description, même schéma."""
    outils = []
    for outil in creer_outils(ctx, Reglages(sous_agent=False)):  # lecture directe : c'est le sous-agent qui lit
        def enveloppe(o):
            @tool(o.name, o.description, o.input_schema)
            async def appeler(arguments: dict) -> dict:
                try:
                    return {"content": [{"type": "text", "text": o.call(arguments)}]}
                except ToolError as erreur:
                    return {"content": [{"type": "text", "text": str(erreur)}], "is_error": True}
            return appeler
        outils.append(enveloppe(outil))
    return create_sdk_mcp_server(name=SERVEUR, version="1.0.0", tools=outils)


async def garder(entree: dict, tool_use_id, contexte) -> dict:
    """PreToolUse : la règle est dans le code, pas dans le prompt. Les sous-agents ont un agent_id."""
    nom = entree["tool_name"]
    refus = None
    if nom != "Agent" and not nom.startswith(f"mcp__{SERVEUR}__"):
        refus = "seuls les outils de l'atelier sont permis"
    elif nom == LECTURE and not entree.get("agent_id"):
        refus = "la lecture des messages est réservée au sous-agent lecteur : confie-lui ta question"
    if refus:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": refus}}
    return {}


async def noter_action(entree: dict, tool_use_id, contexte) -> dict:
    """PostToolUse : le journal des actions, sans les données (seulement qui a fait quoi)."""
    noter_evenement("action", outil=entree["tool_name"], par=entree.get("agent_type") or "agent principal")
    return {}


def options(ctx: Contexte, budget_max: float, dossier: str) -> ClaudeAgentOptions:
    outils_atelier = [f"mcp__{SERVEUR}__{nom}" for nom in ("lire_ventes", "lire_stock", "lire_evenements",
                                                            "lire_fournisseurs", "calculer_besoins",
                                                            "lire_messages_fournisseurs", "proposer_bon_de_commande")]
    return ClaudeAgentOptions(
        model=config.MODELE,
        system_prompt=SYSTEME + "\n\nPour connaître les messages des fournisseurs, confie ta question au sous-agent "
                                "« lecteur », avec l'outil Agent.",
        mcp_servers={SERVEUR: serveur_de_l_atelier(ctx)},
        tools=["Agent"],                      # aucun outil intégré, sauf la délégation à un sous-agent
        allowed_tools=["Agent", *outils_atelier],
        permission_mode="dontAsk",            # ce qui n'est pas permis est refusé, sans question
        agents={"lecteur": AgentDefinition(
            description="Lit les messages WhatsApp des fournisseurs et répond à une question précise, en citant les "
                        "dates et les fournisseurs.",
            prompt=LECTEUR + "\n\nLis les messages avec l'outil lire_messages_fournisseurs.",
            tools=[LECTURE], model=config.MODELE_AUXILIAIRE)},
        hooks={"PreToolUse": [HookMatcher(hooks=[garder])], "PostToolUse": [HookMatcher(hooks=[noter_action])]},
        max_turns=20,
        max_budget_usd=budget_max,            # une estimation côté client, qui peut être un peu dépassée
        setting_sources=[],                   # ni vos réglages, ni votre CLAUDE.md, ni vos Skills
        cwd=dossier,
        env={"CLAUDE_CONFIG_DIR": str(Path(dossier) / ".config")},
    )


async def lancer_avec_le_sdk(budget_max: float) -> tuple[ResultMessage | None, Contexte, list[str]]:
    ctx = Contexte(None, Atelier(), Garde(), Trace())
    appels: list[str] = []
    with tempfile.TemporaryDirectory() as dossier:
        resultat = None
        async for message in query(prompt=CONSIGNE, options=options(ctx, budget_max, dossier)):
            if isinstance(message, AssistantMessage):
                appels += [b.name for b in message.content if type(b).__name__ == "ToolUseBlock"]
            elif isinstance(message, ResultMessage):
                resultat = message
    return resultat, ctx, appels


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget-max", type=float, default=0.60)
    args = parser.parse_args()
    debut = time.perf_counter()
    resultat, ctx, appels = asyncio.run(lancer_avec_le_sdk(args.budget_max))
    print(f"Appels d'outils de l'agent principal : {appels}")
    print(ctx.trace.afficher())
    if resultat:
        print(f"\nFin : {resultat.subtype} ; {resultat.num_turns} tours ; {resultat.total_cost_usd} $ "
              f"(estimation du SDK) ; {resultat.duration_ms / 1000:.1f} s")
        print(f"Coût par modèle : {getattr(resultat, 'model_usage', None)}")
        print("\nRésumé de l'agent :\n" + (resultat.result or ""))
    print(f"\nDurée totale : {time.perf_counter() - debut:.1f} s")
    print("\n" + (rendre_bon(ctx.bon) if ctx.bon else "Aucun bon proposé."))
    print("\nCritères : " + ", ".join(f"{k} {'oui' if v else 'NON'}" for k, v in criteres(ctx.bon).items()))


if __name__ == "__main__":
    main()
