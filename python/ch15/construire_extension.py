"""Chapitre 15 : fabrique l'extension de bureau « Comptoir pour Awa » (.mcpb) à partir du serveur.

Lancement, depuis le dossier python/ (gratuit) :
    python -m ch15.construire_extension            # prépare ch15/build/comptoir-pour-awa/
    python -m ch15.construire_extension --paquet   # puis le valide et l'empaquette avec mcpb

Le manifeste est écrit par le code, à partir du serveur lui-même : la liste des outils et des
prompts qu'il annonce ne peut pas diverger de ce que le serveur expose. Le paquet est de type
« uv » (manifeste 0.4) : l'application installe Python et les dépendances de pyproject.toml, et
uv.lock fige l'arbre entier, comme package-lock.json au chapitre 14. Il faut, pour --paquet, les
outils de ch15/outils (npm ci) et uv (pip install uv).
"""

import argparse
import asyncio
import json
import shutil
import subprocess
from pathlib import Path

from mcp import Client

from ch15 import comptoir_pour_awa as serveur_awa

RACINE = Path(__file__).parents[1]
NOM = "comptoir-pour-awa"
BUILD = RACINE / "ch15" / "build"
DOSSIER = BUILD / NOM
MCPB = RACINE / "ch15" / "outils" / "node_modules" / "@anthropic-ai" / "mcpb" / "dist" / "cli" / "cli.js"
VERSION_MCP = "2.3.0"  # le SDK MCP avec lequel le serveur a été testé

REGLAGES = {
    "base_boutique": {
        "type": "file",
        "title": "Base de la boutique",
        "description": "Le fichier de la boutique que Yao vous a donné (boutique.sqlite3). Il reste sur votre "
                       "ordinateur : l'extension le lit, et n'y change que le stock, après votre accord.",
        "required": True,
    },
}


def _premiere_phrase(texte: str) -> str:
    texte = " ".join((texte or "").split())
    return texte.split(". ")[0].rstrip(".") + "."


async def _inventaire() -> tuple[list[dict], list[dict]]:
    """Les outils et les prompts tels que le serveur les annonce, lus par un client MCP en mémoire."""
    async with Client(serveur_awa.serveur) as client:
        outils = [{"name": t.name, "description": _premiere_phrase(t.description)}
                  for t in (await client.list_tools()).tools]
        prompts = []
        for p in (await client.list_prompts()).prompts:
            arguments = [a.name for a in (p.arguments or [])]
            rendu = await client.get_prompt(p.name, {a: f"${{arguments.{a}}}" for a in arguments})
            prompts.append({"name": p.name, "description": _premiere_phrase(p.description),
                            "arguments": arguments, "text": rendu.messages[0].content.text})
    return outils, prompts


def manifeste(outils: list[dict], prompts: list[dict]) -> dict:
    return {
        "manifest_version": "0.4",
        "name": NOM,
        "display_name": "Comptoir pour Awa",
        "version": serveur_awa.VERSION,
        "description": "Vos commandes, votre stock et vos ventes de la semaine, dans Claude.",
        "long_description": (
            "Comptoir pour Awa relie Claude à la boutique de Délices d'Awa. Demandez vos commandes du jour, "
            "votre stock ou vos ventes de la semaine. Après un inventaire, Claude peut corriger le stock, "
            "mais seulement après vous avoir montré l'écart et obtenu votre accord. Aucune autre donnée n'est "
            "modifiée. Exemple du livre « Développer avec Claude » (Botlyx Academy) : entreprise et personnes "
            "fictives."),
        "author": {"name": "Botlyx Academy", "url": "https://academy.botlyx.com"},
        "icon": "icon.png",
        "server": {
            "type": "uv",
            "entry_point": "src/server.py",
            "mcp_config": {
                "command": "uv",
                "args": ["run", "--directory", "${__dirname}", "src/server.py"],
                "env": {"COMPTOIR_BOUTIQUE": "${user_config.base_boutique}"},
            },
        },
        "tools": outils,
        "prompts": prompts,
        "user_config": REGLAGES,
        "keywords": ["commandes", "stock", "ventes", "botlyx"],
        "license": "MIT",
        "compatibility": {"platforms": ["darwin", "win32"], "runtimes": {"python": ">=3.10"}},
    }


PYPROJECT = f"""[project]
name = "{NOM}"
version = "{serveur_awa.VERSION}"
description = "Comptoir pour Awa : le serveur MCP de Délices d'Awa (exemple du Tome 2 de « Maîtriser Claude »)"
requires-python = ">=3.10"
dependencies = ["mcp=={VERSION_MCP}"]
"""


def icone(chemin: Path) -> None:
    """Une icône simple : un disque couleur bissap, avec un « A » blanc. 512 × 512, fond transparent."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    dessin = ImageDraw.Draw(image)
    dessin.ellipse((16, 16, 496, 496), fill=(150, 20, 60, 255))
    police = ImageFont.load_default(size=300)
    dessin.text((256, 268), "A", fill=(255, 255, 255, 255), font=police, anchor="mm")
    image.save(chemin)


def preparer() -> Path:
    if DOSSIER.exists():
        shutil.rmtree(DOSSIER)
    (DOSSIER / "src").mkdir(parents=True)
    shutil.copyfile(Path(serveur_awa.__file__), DOSSIER / "src" / "server.py")
    shutil.copyfile(RACINE / "comptoir" / "donnees" / "delices_awa.json", DOSSIER / "src" / "catalogue.json")
    (DOSSIER / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    (DOSSIER / ".mcpbignore").write_text(".venv/\n__pycache__/\n*.pyc\n", encoding="utf-8")
    outils, prompts = asyncio.run(_inventaire())
    (DOSSIER / "manifest.json").write_text(json.dumps(manifeste(outils, prompts), ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8")
    icone(DOSSIER / "icon.png")
    return DOSSIER


def empaqueter() -> Path:
    uv = shutil.which("uv") or str(RACINE / ".venv" / "Scripts" / "uv.exe")
    # uv.lock fige toutes les dépendances, transitives comprises.
    subprocess.run([uv, "lock", "--directory", str(DOSSIER)], check=True)
    subprocess.run(["node", str(MCPB), "validate", str(DOSSIER / "manifest.json")], check=True)
    paquet = BUILD / f"{NOM}-{serveur_awa.VERSION}.mcpb"
    subprocess.run(["node", str(MCPB), "pack", str(DOSSIER), str(paquet)], check=True)
    return paquet


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--paquet", action="store_true", help="valider et empaqueter avec mcpb (Node et uv)")
    args = parser.parse_args()
    dossier = preparer()
    print(f"Extension préparée : {dossier.relative_to(RACINE)}")
    if args.paquet:
        print(f"Paquet : {empaqueter().relative_to(RACINE)}")


if __name__ == "__main__":
    main()
