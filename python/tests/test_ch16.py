"""Chapitre 16 : le Comptoir en ligne et son serveur d'autorisation. Aucun appel à l'API, aucun réseau :
l'application est appelée en mémoire (ASGI), comme le ferait un client HTTP."""

import asyncio
import base64
import contextlib
import hashlib
import secrets
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest

pytest.importorskip("mcp")
httpx2 = pytest.importorskip("httpx2")

from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import ElicitResult

from ch14.fabriquer_commandes import simuler
from ch15 import comptoir_pour_awa as awa
from ch16 import autorisation, serveur_en_ligne
from ch16.autorisation import hacher

URL = "http://localhost:8016"
MOT_DE_PASSE = "mot-de-passe-des-tests-16"  # valeur de test, pour ce serveur en mémoire seulement
RETOUR = "http://localhost:3030/callback"


@pytest.fixture(scope="module")
def base_modele(tmp_path_factory):
    chemin = tmp_path_factory.mktemp("ch16") / "boutique.sqlite3"
    simuler(chemin)
    return chemin


@pytest.fixture
def app(base_modele, tmp_path, monkeypatch):
    copie = tmp_path / "boutique.sqlite3"
    copie.write_bytes(base_modele.read_bytes())
    monkeypatch.setenv("COMPTOIR_BOUTIQUE", str(copie))
    monkeypatch.setenv("COMPTOIR_AUJOURDHUI", "2026-10-17")
    application = serveur_en_ligne.application(URL, str(tmp_path / "auth.sqlite3"), hacher(MOT_DE_PASSE))
    application.state.boutique = copie
    return application


@contextlib.asynccontextmanager
async def http(app, hote: str = "localhost:8016"):
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url=f"http://{hote}") as client:
            yield client


def pkce() -> tuple[str, str]:
    verificateur = secrets.token_urlsafe(48)
    defi = base64.urlsafe_b64encode(hashlib.sha256(verificateur.encode()).digest()).decode().rstrip("=")
    return verificateur, defi


async def enregistrer(client, retours=(RETOUR,)):
    return await client.post("/register", json={"client_name": "Tests", "redirect_uris": list(retours),
                                                "token_endpoint_auth_method": "none", "scope": "comptoir"})


async def autoriser(client, client_id, defi, retour=RETOUR, ressource=f"{URL}/mcp"):
    return await client.get("/authorize", params={
        "response_type": "code", "client_id": client_id, "redirect_uri": retour, "code_challenge": defi,
        "code_challenge_method": "S256", "state": "etat-42", "scope": "comptoir", "resource": ressource})


async def se_connecter(client, mot_de_passe=MOT_DE_PASSE) -> tuple[str, str]:
    """Le parcours d'Awa jusqu'au jeton. Rend (client_id, réponse du point de jeton)."""
    client_id = (await enregistrer(client)).json()["client_id"]
    verificateur, defi = pkce()
    page = (await autoriser(client, client_id, defi)).headers["location"]
    envoi = await client.post(page, data={"mot_de_passe": mot_de_passe, "decision": "autoriser"})
    assert envoi.status_code == 302, envoi.text
    retour = parse_qs(urlsplit(envoi.headers["location"]).query)
    assert retour["state"] == ["etat-42"] and retour["iss"] == [URL]  # RFC 9207 : l'émetteur, sans barre finale
    jetons = await client.post("/token", data={
        "grant_type": "authorization_code", "code": retour["code"][0], "redirect_uri": RETOUR,
        "client_id": client_id, "code_verifier": verificateur, "resource": f"{URL}/mcp"})
    return client_id, jetons


def test_sans_jeton_le_serveur_dit_ou_s_authentifier(app):
    async def _():
        async with http(app) as c:
            refus = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                 headers={"Accept": "application/json, text/event-stream"})
            ressource = (await c.get("/.well-known/oauth-protected-resource/mcp")).json()
            serveur = (await c.get("/.well-known/oauth-authorization-server")).json()
            return refus, ressource, serveur
    refus, ressource, serveur = asyncio.run(_())
    assert refus.status_code == 401
    assert f'resource_metadata="{URL}/.well-known/oauth-protected-resource/mcp"' in refus.headers["www-authenticate"]
    assert ressource["resource"] == f"{URL}/mcp" and ressource["authorization_servers"][0].rstrip("/") == URL
    assert serveur["issuer"] == URL and serveur["code_challenge_methods_supported"] == ["S256"]
    assert serveur["registration_endpoint"] == f"{URL}/register"


def test_une_adresse_de_retour_etrangere_est_refusee(app):
    async def _():
        async with http(app) as c:
            return (await enregistrer(c, ["https://exemple.invalid/vol"])), (await enregistrer(c, [autorisation.RETOUR_CLAUDE]))
    etrangere, claude = asyncio.run(_())
    assert etrangere.status_code == 400 and etrangere.json()["error"] == "invalid_redirect_uri"
    assert claude.status_code == 201


def test_le_parcours_complet_ouvre_les_outils(app):
    async def _():
        async with http(app) as c:
            _, jetons = await se_connecter(c)
            acces = jetons.json()["access_token"]
            c.headers["Authorization"] = f"Bearer {acces}"
            async with Client(streamable_http_client(f"{URL}/mcp", http_client=c)) as mcp_client:
                outils = [t.name for t in (await mcp_client.list_tools()).tools]
                stock = (await mcp_client.call_tool("stock", {})).structured_content
                return jetons.json(), outils, stock, mcp_client.protocol_version
    jetons, outils, stock, version = asyncio.run(_())
    assert jetons["token_type"].lower() == "bearer" and jetons["expires_in"] == 3600 and jetons["refresh_token"]
    assert outils[-1] == "rapport_de_la_semaine" and len(outils) == 6
    assert stock["resume"].startswith("En rupture") and version == "2026-07-28"


def test_la_page_montre_qui_demande_et_previent_pour_un_retour_local(app):
    async def _():
        async with http(app) as c:
            client_id = (await enregistrer(c)).json()["client_id"]
            page = (await autoriser(c, client_id, pkce()[1])).headers["location"]
            return await c.get(page)
    page = asyncio.run(_())
    assert page.status_code == 200 and "<strong>Tests</strong> demande l'accès" in page.text
    assert "<strong>localhost</strong>" in page.text and "Le retour se fait sur cet ordinateur" in page.text
    assert page.headers["cache-control"] == "no-store" and page.headers["x-frame-options"] == "DENY"
    # La redirection qui suit le formulaire doit être permise par la CSP, et seulement vers ce retour-là.
    assert page.headers["content-security-policy"].endswith("form-action 'self' http://localhost:3030")


def test_le_port_d_une_adresse_locale_peut_changer(app):
    async def _():
        async with http(app) as c:
            client_id = (await enregistrer(c)).json()["client_id"]
            autre_port = await autoriser(c, client_id, pkce()[1], retour="http://localhost:51234/callback")
            autre_chemin = await autoriser(c, client_id, pkce()[1], retour="http://localhost:51234/ailleurs")
            return autre_port, autre_chemin
    autre_port, autre_chemin = asyncio.run(_())
    assert autre_port.status_code == 302 and "/connexion?demande=" in autre_port.headers["location"]
    assert autre_chemin.status_code == 400  # le chemin, lui, doit être le même


def test_un_formulaire_renvoye_apres_succes_rend_la_meme_redirection(app):
    # Constaté pendant l'essai : sur une connexion qui se coupe, le navigateur renvoie le formulaire.
    async def _():
        async with http(app) as c:
            client_id = (await enregistrer(c)).json()["client_id"]
            page = (await autoriser(c, client_id, pkce()[1])).headers["location"]
            premier = await c.post(page, data={"mot_de_passe": MOT_DE_PASSE, "decision": "autoriser"})
            second = await c.post(page, data={"mot_de_passe": MOT_DE_PASSE, "decision": "autoriser"})
            return premier, second
    premier, second = asyncio.run(_())
    assert premier.status_code == second.status_code == 302
    assert premier.headers["location"] == second.headers["location"]  # le même code, pas un second


def test_cinq_mots_de_passe_faux_bloquent_la_connexion(app):
    async def _():
        async with http(app) as c:
            client_id = (await enregistrer(c)).json()["client_id"]
            page = (await autoriser(c, client_id, pkce()[1])).headers["location"]
            codes = [(await c.post(page, data={"mot_de_passe": "faux", "decision": "autoriser"})).status_code
                     for _ in range(5)]
            bloque = await c.post(page, data={"mot_de_passe": MOT_DE_PASSE, "decision": "autoriser"})
            return codes, bloque
    codes, bloque = asyncio.run(_())
    assert codes == [401] * 5 and bloque.status_code == 429 and "Trop d'essais" in bloque.text


def test_refuser_renvoie_access_denied(app):
    async def _():
        async with http(app) as c:
            client_id = (await enregistrer(c)).json()["client_id"]
            page = (await autoriser(c, client_id, pkce()[1])).headers["location"]
            return await c.post(page, data={"decision": "refuser"})
    refus = asyncio.run(_())
    assert refus.status_code == 302 and "error=access_denied" in refus.headers["location"]


def test_une_ressource_etrangere_est_refusee(app):
    async def _():
        async with http(app) as c:
            client_id = (await enregistrer(c)).json()["client_id"]
            return await autoriser(c, client_id, pkce()[1], ressource="https://autre.invalid/mcp")
    reponse = asyncio.run(_())
    assert reponse.status_code == 302 and "error=invalid_target" in reponse.headers["location"]


def test_rotation_et_vol_d_un_jeton_de_renouvellement(app):
    async def _():
        async with http(app) as c:
            client_id, jetons = await se_connecter(c)
            premier = jetons.json()
            renouvele = await c.post("/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                     "refresh_token": premier["refresh_token"]})
            second = renouvele.json()
            # L'ancien jeton de renouvellement revient : quelqu'un l'a copié. Tout est révoqué.
            vol = await c.post("/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                               "refresh_token": premier["refresh_token"]})
            apres = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                 headers={"Authorization": f"Bearer {second['access_token']}",
                                          "Accept": "application/json, text/event-stream"})
            return premier, renouvele, second, vol, apres
    premier, renouvele, second, vol, apres = asyncio.run(_())
    assert renouvele.status_code == 200 and second["refresh_token"] != premier["refresh_token"]
    assert vol.status_code == 400 and vol.json()["error"] == "invalid_grant"
    assert apres.status_code == 401


def test_les_jetons_ne_sont_gardes_qu_en_empreinte(app, tmp_path):
    async def _():
        async with http(app) as c:
            return (await se_connecter(c))[1].json()
    jetons = asyncio.run(_())
    contenu = (tmp_path / "auth.sqlite3").read_bytes()
    assert jetons["access_token"].encode() not in contenu and jetons["refresh_token"].encode() not in contenu
    assert hashlib.sha256(jetons["access_token"].encode()).hexdigest().encode() in contenu


def test_un_hote_inconnu_est_refuse(app):
    # Sans jeton, la requête s'arrête au 401. Avec un jeton valide, c'est la liste des hôtes qui l'arrête :
    # la protection contre la réaffectation DNS ne dépend pas de l'authentification.
    async def _():
        async with app.router.lifespan_context(app):  # le gestionnaire de transport ne démarre qu'une fois
            transport = httpx2.ASGITransport(app=app)
            async with httpx2.AsyncClient(transport=transport, base_url="http://localhost:8016") as c:
                acces = (await se_connecter(c))[1].json()["access_token"]
            async with httpx2.AsyncClient(transport=transport, base_url="http://comptoir.exemple.invalid") as c:
                return await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                    headers={"Accept": "application/json, text/event-stream",
                                             "Authorization": f"Bearer {acces}"})
    assert asyncio.run(_()).status_code == 421


def test_le_serveur_en_ligne_reprend_le_serveur_de_bureau(app):
    serveur = app.state.serveur

    async def _():
        async with Client(awa.serveur) as bureau, Client(serveur) as en_ligne:
            return ((await bureau.list_tools()).tools, (await en_ligne.list_tools()).tools,
                    [p.name for p in (await en_ligne.list_prompts()).prompts],
                    [t.uri_template for t in (await en_ligne.list_resource_templates()).resource_templates])
    bureau, en_ligne, prompts, gabarits = asyncio.run(_())
    par_nom = {t.name: t for t in en_ligne}
    for t in bureau:
        assert par_nom[t.name].model_dump(exclude={"meta", "output_schema"}) == t.model_dump(exclude={"meta", "output_schema"})
        assert (par_nom[t.name].meta or {}).get("anthropic/requiresUserInteraction") == (t.meta or {}).get(
            "anthropic/requiresUserInteraction")
    assert prompts == ["bilan_du_soir", "inventaire"] and gabarits == ["comptoir://commande/{numero}"]


def test_le_rapport_signale_sa_progression(app):
    rapports = []

    async def noter(fait, total, message):
        rapports.append((fait, total, message))

    async def _():
        async with Client(app.state.serveur, raise_exceptions=True) as c:
            return await c.call_tool("rapport_de_la_semaine", {"un_jour_de_la_semaine": "2026-10-14"},
                                     progress_callback=noter)
    resultat = asyncio.run(_()).structured_content
    assert [f for f, _, _ in rapports] == list(range(1, 9)) and rapports[-1][2] == "Rapport prêt"
    assert rapports[0][2].startswith("lundi 12 octobre 2026 : ")
    assert resultat["ventes"]["total_fcfa"] == sum(j["total_fcfa"] for j in resultat["par_jour"])


@pytest.mark.parametrize("reponse, attendu, message", [
    (ElicitResult(action="accept", content={"confirme": True}), 32, None),
    (ElicitResult(action="accept", content={"confirme": False}), 40,
     "Awa n'a pas coché la confirmation : le stock n'a pas changé."),
    (ElicitResult(action="decline"), 40, "Correction refusée par Awa : le stock n'a pas changé."),
    (ElicitResult(action="cancel"), 40, "Correction annulée par Awa : le stock n'a pas changé."),
])
def test_la_correction_demande_confirmation_au_client_qui_sait_le_faire(app, reponse, attendu, message):
    questions = []

    async def formulaire(_contexte, params):
        questions.append(params.message)
        return reponse

    async def _():
        async with Client(app.state.serveur, elicitation_callback=formulaire) as c:
            projet = (await c.call_tool("preparer_correction", {"produit": "Jus de bissap", "quantite_comptee": 32})
                      ).structured_content
            return await c.call_tool("appliquer_correction", {"jeton": projet["jeton"]})
    resultat = asyncio.run(_())
    assert questions == ["Corriger le stock de Jus de bissap : 40 → 32 ?"]
    assert resultat.is_error == (attendu == 40)
    if message:  # le message de l'outil, pas celui du SDK : le refus doit être dit clairement à Awa
        assert resultat.content[0].text == f"Error executing tool appliquer_correction: {message}"
    with sqlite3.connect(app.state.boutique) as db:
        assert db.execute("SELECT quantite FROM stock WHERE produit = 'Jus de bissap'").fetchone() == (attendu,)


def test_sans_formulaire_possible_le_jeton_suffit(app):
    async def _():
        async with Client(app.state.serveur) as c:  # aucun elicitation_callback : comme l'application Claude
            projet = (await c.call_tool("preparer_correction", {"produit": "Jus de bissap", "quantite_comptee": 32})
                      ).structured_content
            return await c.call_tool("appliquer_correction", {"jeton": projet["jeton"]})
    assert asyncio.run(_()).structured_content["apres"] == 32
