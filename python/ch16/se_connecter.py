"""Chapitre 16 : se connecter au Comptoir en ligne comme le fait un client MCP, OAuth compris.

Lancement, depuis le dossier python/, le serveur tournant (voir serveur_en_ligne.py) :
    python -m ch16.se_connecter http://localhost:8016/mcp              # avec votre navigateur
    python -m ch16.se_connecter http://localhost:8016/mcp --automatique  # essai local, sans navigateur

Ce que fait le client, dans l'ordre : il appelle /mcp sans jeton et reçoit un 401 qui pointe vers
les métadonnées de la ressource ; il y lit l'adresse du serveur d'autorisation ; il s'enregistre
(enregistrement dynamique) ; il ouvre la page de connexion, avec un défi PKCE ; il reçoit un code
sur son adresse de retour ; il l'échange contre un jeton ; il rappelle /mcp avec ce jeton. Le SDK
fait tout cela : ce script ne fournit que le navigateur et l'adresse de retour.

--automatique remplace le navigateur par une requête qui remplit la page de connexion avec le mot
de passe de COMPTOIR_MOT_DE_PASSE_ESSAI : pour un serveur d'essai, sur votre ordinateur, seulement.
Les jetons sont gardés dans donnees_clients/jetons_client.json (exclu de Git).
"""

import argparse
import asyncio
import json
import os
import re
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx2
from pydantic import AnyUrl

from mcp import Client
from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken
from mcp.types import ElicitResult

from ch16.autorisation import PORTEE

RACINE = Path(__file__).parents[1]
JETONS = RACINE / "donnees_clients" / "jetons_client.json"
PORT_RETOUR = 3030


class StockageFichier:
    """Les jetons et l'enregistrement du client, dans un fichier : la connexion suivante est silencieuse."""

    def __init__(self, chemin: Path = JETONS):
        self.chemin = chemin

    def _lire(self) -> dict:
        return json.loads(self.chemin.read_text(encoding="utf-8")) if self.chemin.exists() else {}

    def _ecrire(self, cle: str, valeur: dict) -> None:
        donnees = self._lire() | {cle: valeur}
        self.chemin.parent.mkdir(parents=True, exist_ok=True)
        self.chemin.write_text(json.dumps(donnees, indent=2), encoding="utf-8")

    async def get_tokens(self) -> OAuthToken | None:
        d = self._lire().get("jetons")
        return OAuthToken.model_validate(d) if d else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._ecrire("jetons", tokens.model_dump(mode="json"))

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        d = self._lire().get("client")
        return OAuthClientInformationFull.model_validate(d) if d else None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._ecrire("client", client_info.model_dump(mode="json"))


def _resultat_du_retour(adresse: str) -> AuthorizationCodeResult:
    params = parse_qs(urlsplit(adresse).query)
    if "error" in params:
        raise SystemExit(f"Connexion refusée : {params['error'][0]}")
    return AuthorizationCodeResult(code=params["code"][0], state=params.get("state", [None])[0],
                                   iss=params.get("iss", [None])[0])


def navigateur_simule(mot_de_passe: str):
    """Ce que ferait le navigateur d'Awa : suivre /authorize, remplir la page, rapporter l'adresse de retour."""
    retour: asyncio.Future = asyncio.get_event_loop().create_future()

    async def ouvrir(adresse: str) -> None:
        async with httpx2.AsyncClient(follow_redirects=False, timeout=10) as http:
            reponse = await http.get(adresse)
            while reponse.status_code in (302, 307) and "/connexion" not in str(reponse.url):
                reponse = await http.get(urljoin(str(reponse.url), reponse.headers["location"]))
            assert "Comptoir pour Awa" in reponse.text, "page de connexion attendue"
            envoi = await http.post(str(reponse.url), data={"mot_de_passe": mot_de_passe, "decision": "autoriser"})
            if envoi.status_code != 302:
                raise SystemExit(f"Connexion refusée par la page ({envoi.status_code}) : "
                                 + re.sub(r"<[^>]+>", " ", envoi.text)[-200:])
            retour.set_result(_resultat_du_retour(envoi.headers["location"]))

    async def attendre() -> AuthorizationCodeResult:
        return await retour

    return ouvrir, attendre


def vrai_navigateur():
    """Ouvre le navigateur, et attend le retour sur http://localhost:3030/callback."""
    recu: dict = {}

    class Retour(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (nom imposé par http.server)
            recu["adresse"] = self.path
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p>C'est fait : vous pouvez fermer cette page.</p>".encode())

        def log_message(self, *_):
            pass

    serveur = HTTPServer(("127.0.0.1", PORT_RETOUR), Retour)

    async def ouvrir(adresse: str) -> None:
        Thread(target=serveur.handle_request, daemon=True).start()
        print(f"Ouvrez cette page si le navigateur ne s'ouvre pas : {adresse}")
        webbrowser.open(adresse)

    async def attendre() -> AuthorizationCodeResult:
        while "adresse" not in recu:
            await asyncio.sleep(0.2)
        serveur.server_close()
        return _resultat_du_retour(recu["adresse"])

    return ouvrir, attendre


async def accepter(_contexte, params) -> ElicitResult:
    """Le formulaire de confirmation, dans la console : c'est ici qu'Awa dirait oui."""
    print(f"\n[formulaire du serveur] {params.message}")
    if os.environ.get("COMPTOIR_REPONSE_FORMULAIRE"):
        reponse = os.environ["COMPTOIR_REPONSE_FORMULAIRE"]
    else:
        reponse = input("Confirmer ? (o/n) ").strip().lower()
    print(f"[réponse] {reponse}")
    return ElicitResult(action="accept", content={"confirme": reponse == "o"})


async def progression(fait: float, total: float | None, message: str | None) -> None:
    print(f"  [{int(fait)}/{int(total or 0)}] {message}")


async def main(adresse: str, automatique: bool, produit: str, compte: int) -> None:
    if automatique:
        mot_de_passe = os.environ.get("COMPTOIR_MOT_DE_PASSE_ESSAI", "")
        # Un serveur d'essai seulement : votre ordinateur, ou l'hôte d'essai que vous nommez (un tunnel).
        hotes = {"localhost", "127.0.0.1", os.environ.get("COMPTOIR_HOTE_D_ESSAI", "")} - {""}
        if not mot_de_passe or urlsplit(adresse).hostname not in hotes:
            raise SystemExit("--automatique : seulement sur un serveur d'essai, avec COMPTOIR_MOT_DE_PASSE_ESSAI.")
        ouvrir, attendre = navigateur_simule(mot_de_passe)
    else:
        ouvrir, attendre = vrai_navigateur()
    oauth = OAuthClientProvider(
        server_url=adresse,
        client_metadata=OAuthClientMetadata(client_name="Script de Yao", scope=PORTEE,
                                            redirect_uris=[AnyUrl(f"http://localhost:{PORT_RETOUR}/callback")],
                                            token_endpoint_auth_method="none"),
        storage=StockageFichier(), redirect_handler=ouvrir, callback_handler=attendre)
    async with httpx2.AsyncClient(auth=oauth, timeout=httpx2.Timeout(30.0, read=120.0)) as http:
        async with Client(streamable_http_client(adresse, http_client=http), elicitation_callback=accepter) as client:
            print(f"Connecté : {client.server_info.name} {client.server_info.version}, protocole {client.protocol_version}")
            print("Outils :", ", ".join(t.name for t in (await client.list_tools()).tools))
            print("Stock :", (await client.call_tool("stock", {})).structured_content["resume"])
            print("Rapport de la semaine :")
            rapport = await client.call_tool("rapport_de_la_semaine", {"un_jour_de_la_semaine": "2026-10-14"},
                                             progress_callback=progression)
            print(" ", rapport.structured_content["resume"])
            projet = (await client.call_tool("preparer_correction", {"produit": produit, "quantite_comptee": compte})
                      ).structured_content
            print("Préparation :", projet["a_dire_a_awa"])
            fait = await client.call_tool("appliquer_correction", {"jeton": projet["jeton"]})
            print("Application :", fait.structured_content["resume"] if not fait.is_error else fait.content[0].text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("adresse")
    parser.add_argument("--automatique", action="store_true")
    parser.add_argument("--produit", default="Jus de bissap")
    parser.add_argument("--compte", type=int, default=38)
    args = parser.parse_args()
    asyncio.run(main(args.adresse, args.automatique, args.produit, args.compte))
