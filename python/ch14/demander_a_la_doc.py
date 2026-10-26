"""Chapitre 14 : vérifier les prix du Comptoir dans la documentation d'Anthropic, par le connecteur MCP.

Lancement, depuis le dossier python/ (APPEL PAYANT) :
    python -m ch14.demander_a_la_doc                    # liste blanche : search_docs et get_doc
    python -m ch14.demander_a_la_doc --epingler         # même chose, liste d'outils épinglée

Le connecteur MCP de l'API (bêta) branche un serveur MCP distant sur une requête : c'est l'API
qui se connecte au serveur, appelle ses outils et rend le tout dans une seule réponse. Ici, le
serveur officiel de la documentation (https://platform.claude.com/docs/mcp, public, sans
authentification). Claude cherche les prix et les rend en JSON ; le code les compare à
comptoir/couts.py. Claude ne décide pas si un prix a changé : il le lit, le code compare.

--epingler : avec l'en-tête mcp-client-2026-09-15, la première réponse rend la liste d'outils du
serveur ; le script l'enregistre dans ch14/outils_epingles/doc-claude.json. Les fois suivantes, il
envoie cette liste : l'API n'interroge plus le serveur sur ses outils, et un serveur qui changerait
ses descriptions ne changerait pas ce que Claude lit. Avant chaque appel, le script compare la
liste épinglée à celle que le serveur annonce aujourd'hui (gratuit) et s'arrête si elle a changé.
"""

import argparse
import asyncio
import json
from pathlib import Path

from mcp import Client

from comptoir import config
from comptoir.appel import creer_client
from comptoir.couts import TARIFS, cout
from comptoir.journal import noter
from ch14.serveurs import DOC_CLAUDE, RACINE

SERVEUR = "doc-claude"
BETA = "mcp-client-2025-11-20"
BETA_EPINGLE = "mcp-client-2026-09-15"
EPINGLE = RACINE / "ch14" / "outils_epingles" / f"{SERVEUR}.json"
MODELES_VERIFIES = ("claude-sonnet-5-5", "claude-haiku-5-5")
POSTES = ("entree", "ecriture_5m", "ecriture_1h", "lecture_cache", "sortie")

SYSTEME = (
    "Tu vérifies des faits dans la documentation officielle de Claude, avec les outils du serveur MCP "
    "doc-claude. Ne réponds jamais de mémoire : cherche, lis la page, puis recopie les chiffres tels que "
    "la page les donne. Si un chiffre n'y est pas, mets le modèle dans non_trouve plutôt que de deviner."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "prix": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "modele": {"type": "string", "description": "identifiant du modèle, par exemple claude-haiku-5-5"},
                **{poste: {"type": "number", "description": "dollars par million de tokens"} for poste in POSTES},
                "source": {"type": "string", "description": "adresse de la page lue"},
            },
            "required": ["modele", *POSTES, "source"],
            "additionalProperties": False,
        }},
        "non_trouve": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["prix", "non_trouve"],
    "additionalProperties": False,
}


def question() -> str:
    return (
        "Donne, pour " + " et ".join(MODELES_VERIFIES) + ", les prix publiés par million de tokens : entrée, "
        "écriture dans le cache de 5 minutes, écriture dans le cache d'une heure, lecture du cache, sortie. "
        "Prends les prix de base de l'API (pas la Batch API, pas les prompts longs)."
    )


def toolset(epingle: list[dict] | None) -> dict:
    """La liste blanche : tous les outils désactivés par défaut, puis deux réactivés."""
    jeu = {"type": "mcp_toolset", "mcp_server_name": SERVEUR,
           "default_config": {"enabled": False},
           "configs": {"search_docs": {"enabled": True}, "get_doc": {"enabled": True}}}
    if epingle is not None:
        jeu["tools"] = epingle
    return jeu


def requete(epingle: list[dict] | None, beta: str) -> dict:
    return {
        "model": config.MODELE_DOCUMENTS,
        "max_tokens": 3000,
        "system": SYSTEME,
        "messages": [{"role": "user", "content": question()}],
        "mcp_servers": [{"type": "url", "url": DOC_CLAUDE, "name": SERVEUR}],
        "tools": [toolset(epingle)],
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
        "betas": [beta],
    }


def _dict(bloc) -> dict:
    return bloc.model_dump(exclude_none=True) if hasattr(bloc, "model_dump") else dict(bloc)


def trace(contenu: list) -> list[str]:
    """Ce qui s'est passé dans la réponse, bloc par bloc : la trace d'un appel avec connecteur."""
    lignes = []
    for bloc in map(_dict, contenu):
        if bloc["type"] == "mcp_tool_listing":
            lignes.append(f"liste des outils de {bloc['mcp_server_name']} : {len(bloc['tools'])} outil(s)")
        elif bloc["type"] == "mcp_tool_use":
            lignes.append(f"appel {bloc['server_name']}.{bloc['name']} {json.dumps(bloc['input'], ensure_ascii=False)}")
        elif bloc["type"] == "mcp_tool_result":
            taille = sum(len(c.get("text", "")) for c in bloc.get("content") or [])
            lignes.append(f"  résultat {'en erreur' if bloc.get('is_error') else 'reçu'} : {taille} caractères")
        elif bloc["type"] == "text":
            lignes.append(f"texte : {len(bloc['text'])} caractères")
    return lignes


def comparer(reponse: dict) -> list[str]:
    """Les écarts entre les prix lus dans la documentation et ceux de comptoir/couts.py."""
    ecarts = [f"{m} : prix non trouvé dans la documentation" for m in reponse.get("non_trouve", [])]
    vus = set()
    for ligne in reponse["prix"]:
        modele = ligne["modele"]
        if modele not in MODELES_VERIFIES:
            continue
        vus.add(modele)
        tarif = TARIFS[modele]
        for poste in POSTES:
            if abs(getattr(tarif, poste) - ligne[poste]) > 1e-9:
                ecarts.append(f"{modele} {poste} : {getattr(tarif, poste)} $ dans couts.py, "
                              f"{ligne[poste]} $ dans la documentation ({ligne['source']})")
    ecarts += [f"{m} : absent de la réponse" for m in MODELES_VERIFIES if m not in vus]
    return ecarts


async def outils_annonces() -> list[dict]:
    """La liste d'outils que le serveur annonce aujourd'hui, au format du connecteur. Gratuit."""
    async with Client(DOC_CLAUDE) as client:
        return [{"name": t.name, "description": t.description, "input_schema": t.input_schema}
                for t in (await client.list_tools()).tools]


def epingle_a_jour(epingle: list[dict], annonces: list[dict]) -> list[str]:
    """Les outils dont la définition a changé depuis l'épinglage (ou apparus, ou disparus)."""
    avant = {t["name"]: t for t in epingle}
    maintenant = {t["name"]: t for t in annonces}
    changes = [n for n in avant.keys() & maintenant.keys() if avant[n] != maintenant[n]]
    return sorted(changes + [f"+{n}" for n in maintenant.keys() - avant.keys()]
                  + [f"-{n}" for n in avant.keys() - maintenant.keys()])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--epingler", action="store_true", help="épingler la liste d'outils du serveur")
    parser.add_argument("--budget-max", type=float, default=0.10, help="plafond de la séance, en dollars")
    args = parser.parse_args()

    epingle, beta = None, BETA
    if args.epingler:
        beta = BETA_EPINGLE
        if EPINGLE.exists():
            epingle = json.loads(EPINGLE.read_text(encoding="utf-8"))
            changes = epingle_a_jour(epingle, asyncio.run(outils_annonces()))
            if changes:
                raise SystemExit(f"Le serveur a changé ses outils depuis l'épinglage : {', '.join(changes)}. "
                                 f"Relisez-les (python -m ch14.explorer_serveur doc), puis supprimez {EPINGLE.name} "
                                 "pour épingler la nouvelle liste.")
            print(f"Liste d'outils épinglée : {len(epingle)} outil(s), identique à celle du serveur.")

    client = creer_client()
    params = requete(epingle, beta)
    messages = list(params.pop("messages"))
    depense, appels = 0.0, 0
    while True:
        # Pas de comptage préalable : l'endpoint count_tokens refuse mcp_servers, et les résultats
        # des outils entrent pendant l'appel. Le plafond se vérifie donc après chaque appel.
        message = client.beta.messages.create(messages=messages, **params)
        appels += 1
        prix = cout(params["model"], message.usage)
        depense += prix.dollars
        noter(message._request_id, params["model"], prix, client="ch14-doc", stop_reason=message.stop_reason,
              origine="connecteur-mcp")
        for ligne in trace(message.content):
            print(ligne)
        if args.epingler and epingle is None:
            for bloc in map(_dict, message.content):
                if bloc["type"] == "mcp_tool_listing" and bloc["mcp_server_name"] == SERVEUR:
                    EPINGLE.parent.mkdir(parents=True, exist_ok=True)
                    EPINGLE.write_text(json.dumps(bloc["tools"], ensure_ascii=False, indent=2), encoding="utf-8")
                    print(f"Liste d'outils épinglée dans {EPINGLE.relative_to(RACINE)}")
                    epingle = bloc["tools"]
        if message.stop_reason != "pause_turn":
            break
        if depense >= args.budget_max or appels >= 4:
            raise SystemExit(f"Arrêt : {depense:.4f} $ dépensés en {appels} appels, plafond atteint.")
        # pause_turn : l'API a interrompu un long tour d'outils ; on renvoie sa réponse telle quelle.
        messages.append({"role": "assistant", "content": [_dict(b) for b in message.content]})

    texte = "".join(b.text for b in message.content if b.type == "text")
    reponse = json.loads(texte)
    ecarts = comparer(reponse)
    print()
    for ligne in reponse["prix"]:
        print(f"{ligne['modele']} : " + ", ".join(f"{p} {ligne[p]}" for p in POSTES) + f"  ({ligne['source']})")
    print("\nPrix de comptoir/couts.py :", "à jour." if not ecarts else "ÉCARTS")
    for e in ecarts:
        print(" -", e)
    print(f"\n{appels} appel(s), {message.usage.input_tokens} tokens d'entrée au dernier, coût : {depense:.4f} $")
    if depense > args.budget_max:
        print(f"Attention : le plafond de {args.budget_max} $ est dépassé ; il ne peut être vérifié qu'après l'appel.")


if __name__ == "__main__":
    main()
