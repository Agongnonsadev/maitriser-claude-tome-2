"""Chapitre 14 : la question du soir d'Awa, posée au Comptoir, qui lit la base par un serveur MCP local.

Lancement, depuis le dossier python/ (APPEL PAYANT) :
    python -m ch14.question_du_soir
    python -m ch14.question_du_soir "Quel jus s'est le mieux vendu à Fidjrossè en septembre ?"

Le connecteur MCP de l'API ne joint que des serveurs distants, en HTTP. Pour un serveur local,
qui parle par stdio, c'est votre code qui est le client MCP : il lance DBHub, lui demande ses
outils, et le SDK anthropic les convertit pour le Tool Runner (async_mcp_tool, extra [mcp]).
Claude écrit les requêtes SQL ; la base fait les comptes ; DBHub refuse toute écriture.
"""

import argparse
import asyncio
import json

import anthropic
from anthropic.lib.tools.mcp import async_mcp_tool
from mcp import Client

from comptoir import config
from comptoir.couts import cout
from comptoir.journal import noter
from ch14.serveurs import commandes

QUESTION = ("Combien de bouteilles de jus de bissap avons-nous vendues la semaine dernière, du lundi 12 au "
            "dimanche 18 octobre, et dans quels quartiers surtout ?")

# Ce que Yao a appris en explorant la base avec Claude Code devient le contexte du Comptoir :
# moins de tours pour retrouver le schéma, donc moins de tokens.
SYSTEME = """Tu es le Comptoir, l'assistant de Délices d'Awa. Awa te pose une question sur ses ventes ; tu y réponds avec l'outil execute_sql, sur une base SQLite en lecture seule.

La base :
- une commande (table commandes) est un récapitulatif confirmé (table recapitulatifs, colonne statut = 'confirme') ; commandes.recapitulatif = recapitulatifs.id ;
- les produits d'un récapitulatif sont dans recapitulatifs.lignes, du JSON : [{"produit": ..., "quantite": ..., "prix_unitaire": ...}] ; lis-les avec json_each ;
- le quartier du client est recapitulatifs.quartier ; les dates (cree_le) sont en heure de Cotonou (+01:00) ;
- les montants sont en FCFA.

Règles :
- les chiffres viennent de la base : fais faire les sommes et les comptes par SQL, jamais de tête ;
- réponds à Awa en français, en la vouvoyant, en quatre phrases au plus, avec les chiffres exacts ;
- si la base ne permet pas de répondre, dis-le.
Nous sommes le mercredi 21 octobre 2026."""


async def demander(question: str, budget_max: float, iterations_max: int = 8) -> tuple[str, float, int]:
    client = anthropic.AsyncAnthropic(timeout=config.DELAI_S, max_retries=config.REESSAIS)
    depense, tours, texte = 0.0, 0, ""
    async with Client(commandes(), read_timeout_seconds=60) as mcp_client:
        outils = (await mcp_client.list_tools()).tools
        runner = client.beta.messages.tool_runner(
            model=config.MODELE,
            max_tokens=2000,
            system=SYSTEME,
            messages=[{"role": "user", "content": question}],
            tools=[async_mcp_tool(outil, mcp_client) for outil in outils],
            max_iterations=iterations_max,
        )
        async for message in runner:
            tours += 1
            prix = cout(config.MODELE, message.usage)
            depense += prix.dollars
            noter(message._request_id, config.MODELE, prix, client="ch14-soir", stop_reason=message.stop_reason,
                  origine="mcp-local")
            for bloc in message.content:
                if bloc.type == "tool_use":
                    print(f"SQL : {json.dumps(bloc.input, ensure_ascii=False)}")
                elif bloc.type == "text":
                    texte = bloc.text
            if depense >= budget_max and message.stop_reason == "tool_use":
                print(f"Arrêt : {depense:.4f} $ dépensés, plafond de {budget_max} $ atteint.")
                break
    return texte, depense, tours


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", nargs="?", default=QUESTION)
    parser.add_argument("--budget-max", type=float, default=0.10)
    args = parser.parse_args()
    texte, depense, tours = asyncio.run(demander(args.question, args.budget_max))
    print(f"\n{texte}\n\n{tours} tour(s), {depense:.4f} $")


if __name__ == "__main__":
    main()
