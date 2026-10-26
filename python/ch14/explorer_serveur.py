"""Chapitre 14 : regarder un serveur MCP avant de le confier à Claude. Aucun appel à l'API Claude.

Lancement, depuis le dossier python/ :
    python -m ch14.explorer_serveur commandes                 # DBHub sur la copie d'exploration
    python -m ch14.explorer_serveur commandes --essayer-d-ecrire
    python -m ch14.explorer_serveur everything                # outils, ressources et prompts d'exemple
    python -m ch14.explorer_serveur doc                       # la documentation d'Anthropic

Le script se comporte comme un client MCP : il se connecte, affiche la version du protocole
négociée, les instructions du serveur et la description complète de chaque outil, ressource
et prompt. C'est ce texte que Claude lira comme des consignes : il faut le lire avant lui.
"""

import argparse
import asyncio
import re
import sqlite3
import sys

from mcp import Client

from ch14.serveurs import RACINE, SERVEURS

# Des tournures qui n'ont rien à faire dans la description d'un outil : un serveur qui les
# emploie essaie peut-être de diriger Claude (empoisonnement des outils). Ce n'est qu'une alerte :
# rien ne remplace la lecture.
SUSPECT = re.compile(
    r"ignore (all|any|previous|the above)|ignorez|instead of|au lieu de|do not tell|ne (le )?dites pas"
    r"|system prompt|prompt système|<important>|before using any other tool|avant tout autre outil"
    r"|send .{0,40}(to|vers) https?://|~/\.ssh|\.env\b|api[_ -]?key|mot de passe|password",
    re.IGNORECASE,
)


def alertes(texte: str | None) -> list[str]:
    """Les passages d'une description qui méritent une relecture attentive."""
    return sorted({m.group(0) for m in SUSPECT.finditer(texte or "")})


def _court(texte: str | None, largeur: int = 400) -> str:
    texte = " ".join((texte or "").split())
    return texte if len(texte) <= largeur else texte[: largeur - 1] + "…"


async def explorer(nom: str) -> int:
    signalements = 0
    async with Client(SERVEURS[nom](), read_timeout_seconds=60) as client:
        info = client.server_info
        print(f"Serveur : {getattr(info, 'name', '?')} {getattr(info, 'version', '')}")
        print(f"Protocole négocié : {client.protocol_version}")
        if client.instructions:
            print(f"Instructions du serveur : {_court(client.instructions)}")
        capacites = client.server_capabilities

        outils = (await client.list_tools()).tools
        print(f"\n{len(outils)} outil(s)")
        for outil in outils:
            proprietes = list((outil.input_schema or {}).get("properties", {}))
            annotations = outil.annotations.model_dump(exclude_none=True) if outil.annotations else {}
            print(f"- {outil.name}({', '.join(proprietes)}) {annotations or ''}")
            print(f"    {_court(outil.description, 600)}")
            for passage in alertes(outil.description):
                signalements += 1
                print(f"    ⚠ à relire : « {passage} »")

        if capacites and capacites.resources:
            ressources = (await client.list_resources()).resources
            print(f"\n{len(ressources)} ressource(s)")
            for r in ressources[:10]:
                print(f"- {r.uri}  ({r.mime_type or '?'}) {_court(r.name, 80)}")
            if len(ressources) > 10:
                print(f"  … et {len(ressources) - 10} autres")
        if capacites and capacites.prompts:
            prompts = (await client.list_prompts()).prompts
            print(f"\n{len(prompts)} prompt(s)")
            for p in prompts:
                arguments = [a.name for a in (p.arguments or [])]
                print(f"- {p.name}({', '.join(arguments)}) : {_court(p.description, 200)}")
    print(f"\n{signalements} passage(s) à relire." if signalements else "\nAucune tournure suspecte repérée.")
    return signalements


def compter_commandes() -> int:
    with sqlite3.connect(RACINE / "donnees_clients" / "commandes_exploration.sqlite3") as db:
        return db.execute("SELECT COUNT(*) FROM commandes").fetchone()[0]


async def essayer_d_ecrire() -> bool:
    """Demande au serveur des commandes d'effacer une commande. Rend True si l'écriture est refusée."""
    avant = compter_commandes()
    async with Client(SERVEURS["commandes"](), read_timeout_seconds=60) as client:
        lecture = await client.call_tool("execute_sql", {"sql": "SELECT COUNT(*) AS commandes FROM commandes"})
        print("Lecture :", _court(" ".join(c.text for c in lecture.content if c.type == "text"), 200))
        ecriture = await client.call_tool("execute_sql", {"sql": "DELETE FROM commandes WHERE id = 'C-0001'"})
        print("Écriture :", "refusée" if ecriture.is_error else "ACCEPTÉE",
              "—", _court(" ".join(c.text for c in ecriture.content if c.type == "text"), 300))
    apres = compter_commandes()
    print(f"Commandes dans la copie : {avant} avant, {apres} après.")
    return bool(ecriture.is_error) and avant == apres


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("serveur", choices=sorted(SERVEURS))
    parser.add_argument("--essayer-d-ecrire", action="store_true",
                        help="vérifier que le serveur des commandes refuse une écriture")
    args = parser.parse_args()
    if args.essayer_d_ecrire:
        if args.serveur != "commandes":
            parser.error("--essayer-d-ecrire ne vaut que pour le serveur des commandes")
        sys.exit(0 if asyncio.run(essayer_d_ecrire()) else 1)
    asyncio.run(explorer(args.serveur))


if __name__ == "__main__":
    main()
