"""Chapitre 16 : parler MCP à la main, en HTTP, pour voir les messages que les SDK échangent.

Lancement, depuis le dossier python/, après python -m ch16.se_connecter (qui garde un jeton) :
    python -m ch16.client_brut http://localhost:8016/mcp

Trois requêtes JSON-RPC de la révision 2026-07-28, envoyées avec httpx et rien d'autre :
server/discover, tools/list, tools/call. Sur cette révision, pas de poignée de main : chaque
requête porte elle-même sa version, l'identité du client et ses capacités (dans _meta), et le
serveur ne rend aucun identifiant de session. Une requête vaut pour elle seule.
"""

import argparse
import json
from pathlib import Path

import httpx2

VERSION = "2026-07-28"
JETONS = Path(__file__).parents[1] / "donnees_clients" / "jetons_client.json"


def message(identifiant: int, methode: str, params: dict | None = None) -> dict:
    meta = {"io.modelcontextprotocol/protocolVersion": VERSION,
            "io.modelcontextprotocol/clientInfo": {"name": "client-brut-de-yao", "version": "0.1"},
            "io.modelcontextprotocol/clientCapabilities": {}}
    return {"jsonrpc": "2.0", "id": identifiant, "method": methode, "params": {**(params or {}), "_meta": meta}}


def entetes(jeton: str, methode: str, nom: str | None = None) -> dict:
    e = {"Authorization": f"Bearer {jeton}", "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": VERSION, "Mcp-Method": methode}
    if nom:
        e["Mcp-Name"] = nom  # exigé pour tools/call, resources/read et prompts/get
    return e


def lire_reponse(reponse: httpx2.Response) -> dict:
    """Une réponse JSON, ou un flux d'événements (SSE) dont on garde le message final."""
    if reponse.headers.get("content-type", "").startswith("text/event-stream"):
        donnees = [l[5:].strip() for l in reponse.text.splitlines() if l.startswith("data:")]
        return json.loads(donnees[-1])
    return reponse.json()


def envoyer(http: httpx2.Client, adresse: str, jeton: str, identifiant: int, methode: str,
            params: dict | None = None, nom: str | None = None) -> dict:
    corps = message(identifiant, methode, params)
    print(f"\n→ POST {adresse}   Mcp-Method: {methode}" + (f"   Mcp-Name: {nom}" if nom else ""))
    print("  " + json.dumps(corps, ensure_ascii=False)[:400])
    reponse = http.post(adresse, headers=entetes(jeton, methode, nom), json=corps)
    session = reponse.headers.get("mcp-session-id")
    print(f"← {reponse.status_code} {reponse.headers.get('content-type')}   session : {session or 'aucune'}")
    resultat = lire_reponse(reponse)
    print("  " + json.dumps(resultat, ensure_ascii=False)[:600])
    return resultat


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("adresse")
    args = parser.parse_args()
    if not JETONS.exists():
        raise SystemExit("Pas de jeton : lancez d'abord python -m ch16.se_connecter.")
    jeton = json.loads(JETONS.read_text(encoding="utf-8"))["jetons"]["access_token"]  # jamais affiché
    with httpx2.Client(timeout=30) as http:
        envoyer(http, args.adresse, jeton, 1, "server/discover")
        envoyer(http, args.adresse, jeton, 2, "tools/list")
        envoyer(http, args.adresse, jeton, 3, "tools/call", {"name": "stock", "arguments": {}}, nom="stock")
        print("\nSans jeton :")
        reponse = http.post(args.adresse, headers={k: v for k, v in entetes("", "tools/list").items()
                                                   if k != "Authorization"}, json=message(4, "tools/list"))
        print(f"← {reponse.status_code}   WWW-Authenticate: {reponse.headers.get('www-authenticate')}")


if __name__ == "__main__":
    main()
