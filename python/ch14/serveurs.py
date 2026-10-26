"""Chapitre 14 : les serveurs MCP du chapitre, au même endroit, chacun à une version figée.

Les deux serveurs locaux sont installés une fois dans ch14/mcp/ (npm ci), et non téléchargés
par npx à chaque lancement : package-lock.json fige le paquet et tout son arbre de dépendances,
et les signatures se vérifient avec npm audit signatures. Pour changer de version : relire la
page du projet, modifier ch14/mcp/package.json, réinstaller, puis relancer ch14.explorer_serveur
avant de rebrancher le serveur à Claude (un test vérifie que .mcp.json reste d'accord).
"""

import json
from pathlib import Path

from mcp import StdioServerParameters

RACINE = Path(__file__).parents[1]
MODULES = RACINE / "ch14" / "mcp" / "node_modules"

# Les points d'entrée, en chemins relatifs au dossier python/ : c'est de là que Claude Code et
# les scripts lancent les serveurs.
DBHUB = "ch14/mcp/node_modules/@bytebase/dbhub/dist/index.js"
EVERYTHING = "ch14/mcp/node_modules/@modelcontextprotocol/server-everything/dist/index.js"
DOC_CLAUDE = "https://platform.claude.com/docs/mcp"  # serveur de la documentation d'Anthropic

# DBHub sur la copie d'exploration, en lecture seule (voir ch14/dbhub.toml).
ARGUMENTS_DBHUB = [DBHUB, "--transport", "stdio", "--config", "ch14/dbhub.toml"]


def version_installee(paquet: str) -> str:
    return json.loads((MODULES / paquet / "package.json").read_text(encoding="utf-8"))["version"]


def commandes() -> StdioServerParameters:
    """Le serveur des commandes d'Awa : un programme local, lancé par le client, qui parle par stdio."""
    return StdioServerParameters(command="node", args=ARGUMENTS_DBHUB, cwd=str(RACINE),
                                 env={"CLAUDE_PROJECT_DIR": str(RACINE)})


def everything() -> StdioServerParameters:
    """Le serveur de démonstration du projet MCP : des outils, des ressources et des prompts d'exemple.
    La 2.0.0 (19 octobre 2026) demande Node 24 ; la 1.0.0 tourne sur Node 22."""
    return StdioServerParameters(command="node", args=[EVERYTHING, "stdio"], cwd=str(RACINE))


SERVEURS = {"commandes": commandes, "everything": everything, "doc": lambda: DOC_CLAUDE}
