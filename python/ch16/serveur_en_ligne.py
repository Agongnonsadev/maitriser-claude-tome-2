"""Chapitre 16 : « Comptoir pour Awa » en ligne, en Streamable HTTP, sans état, derrière OAuth.

Lancement local, depuis le dossier python/ :
    COMPTOIR_URL_PUBLIQUE=http://localhost:8016 COMPTOIR_BOUTIQUE=... COMPTOIR_MOT_DE_PASSE_HACHE=... \\
        uvicorn ch16.serveur_en_ligne:app --port 8016

C'est le serveur du chapitre 15, au caractère près : les outils, la ressource, le gabarit et les
prompts sont recopiés de ch15/comptoir_pour_awa.py par le SDK lui-même. Ce qui change :
- le transport : HTTP au lieu de stdio, pour être joint depuis le téléphone d'Awa ;
- l'accès : un jeton OAuth (ch16/autorisation.py), émis après le mot de passe d'Awa ;
- un outil long, rapport_de_la_semaine, qui envoie des notifications de progression ;
- appliquer_correction demande en plus une confirmation par formulaire au client qui sait l'afficher
  (demande d'information, en plusieurs allers-retours sur la révision 2026-07-28), et s'en remet au
  jeton de préparation pour les autres, comme l'application Claude ;
- sans état : aucune session, les jetons et les corrections sont dans des bases SQLite ; plusieurs
  processus peuvent servir les mêmes clients.

Configuration (variables d'environnement) :
  COMPTOIR_URL_PUBLIQUE        l'adresse publique, en https:// en ligne (http://localhost:… en local)
  COMPTOIR_BOUTIQUE            la base de la boutique (SQLite)
  COMPTOIR_AUTORISATION        la base des jetons (par défaut donnees_clients/autorisation.sqlite3)
  COMPTOIR_MOT_DE_PASSE_HACHE  sortie de « python -m ch16.autorisation hacher »
  COMPTOIR_HOTES_SUPPLEMENTAIRES  autres noms d'hôte acceptés, séparés par des virgules (facultatif)
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from mcp import Client
from mcp.server import MCPServer
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.mcpserver import (CancelledElicitation, Context, DeclinedElicitation, Elicit, ElicitationResult,
                                  Resolve)
from mcp.server.transport_security import TransportSecuritySettings

from ch15 import comptoir_pour_awa as awa
from ch16.autorisation import PORTEE, FournisseurAwa

journal = logging.getLogger("comptoir_en_ligne")

INSTRUCTIONS = awa.INSTRUCTIONS + (
    "\n5. Pour un rapport de semaine complet (jour par jour, quartiers, comparaison), utilise "
    "rapport_de_la_semaine : il prend quelques secondes et signale sa progression.")


def _definitions() -> tuple[list, list, list, list]:
    """Les définitions du serveur du chapitre 15, lues par un client MCP en mémoire.

    Dans un fil à part : à l'import par uvicorn, une boucle d'événements tourne déjà."""
    async def lire():
        async with Client(awa.serveur) as client:
            return ((await client.list_tools()).tools, (await client.list_resources()).resources,
                    (await client.list_resource_templates()).resource_templates, (await client.list_prompts()).prompts)
    with ThreadPoolExecutor(1) as fil:
        return fil.submit(asyncio.run, lire()).result()


class Confirmation(BaseModel):
    confirme: bool = Field(description="Cochez pour appliquer la correction.")


async def confirmer(jeton: str, ctx: Context) -> Confirmation | Elicit[Confirmation]:
    """Demande la confirmation par formulaire si le client sait l'afficher ; sinon, le jeton suffit."""
    capacites = ctx.client_capabilities
    journal.info("confirmation : protocole %s, formulaire possible : %s", ctx.protocol_version,
                 bool(capacites and capacites.elicitation))
    if capacites is None or capacites.elicitation is None:
        return Confirmation(confirme=True)  # l'accord a été donné dans la conversation, sur l'écart annoncé
    with awa._ouvrir() as db:
        db.execute(awa._TABLE_CORRECTIONS)
        ligne = db.execute("SELECT produit, avant, apres FROM corrections_stock WHERE jeton = ?", (jeton.strip(),)
                           ).fetchone()
    if ligne is None:
        return Confirmation(confirme=True)  # appliquer() refusera le jeton, avec son propre message
    return Elicit(f"Corriger le stock de {ligne['produit']} : {ligne['avant']} → {ligne['apres']} ?", Confirmation)


class JourDuRapport(BaseModel):
    jour: str
    commandes: int
    total_fcfa: int


class RapportSemaine(BaseModel):
    ventes: awa.VentesSemaine
    par_jour: list[JourDuRapport]
    par_quartier: dict[str, int] = Field(description="Total en FCFA par quartier, du plus au moins rapporteur.")
    resume: str


def construire(url_publique: str, chemin_autorisation: str, mot_de_passe_hache: str) -> MCPServer:
    url = url_publique.rstrip("/")
    ressource = f"{url}/mcp"
    fournisseur = FournisseurAwa(chemin_autorisation, url, ressource, mot_de_passe_hache)
    serveur = MCPServer(
        "comptoir-pour-awa", title="Comptoir pour Awa", version=awa.VERSION, instructions=INSTRUCTIONS,
        auth_server_provider=fournisseur,
        auth=AuthSettings(
            # Des chaînes, pas AnyHttpUrl(...) : AuthSettings garde l'adresse sans barre finale, et l'émetteur
            # annoncé doit être identique au paramètre iss que la page de connexion renvoie (RFC 9207).
            issuer_url=url, resource_server_url=ressource, required_scopes=[PORTEE],
            validate_token_resource=True,
            client_registration_options=ClientRegistrationOptions(enabled=True, valid_scopes=[PORTEE],
                                                                  default_scopes=[PORTEE]),
            revocation_options=RevocationOptions(enabled=True)))

    outils, ressources, gabarits, prompts = _definitions()
    for o in outils:
        if o.name == "appliquer_correction":
            continue  # redéfini plus bas, avec la confirmation
        serveur.add_tool(getattr(awa, o.name), name=o.name, title=o.title, description=o.description,
                         annotations=o.annotations, meta=o.meta)
    for r in ressources:
        serveur.resource(str(r.uri), name=r.name, title=r.title, description=r.description,
                         mime_type=r.mime_type)(getattr(awa, r.name))
    for g in gabarits:
        serveur.resource(g.uri_template, name=g.name, title=g.title, description=g.description,
                         mime_type=g.mime_type)(getattr(awa, g.name))
    for p in prompts:
        serveur.prompt(name=p.name, title=p.title, description=p.description)(getattr(awa, p.name))

    appliquer = next(o for o in outils if o.name == "appliquer_correction")

    @serveur.tool(name=appliquer.name, title=appliquer.title, annotations=appliquer.annotations, meta=appliquer.meta,
                  description=appliquer.description)
    def appliquer_correction(
        jeton: Annotated[str, Field(description="Le jeton rendu par preparer_correction.")],
        # ElicitationResult seul : le SDK passe alors le refus et l'annulation à l'outil, qui répond lui-même. Une
        # union avec Confirmation, il ne la reconnaît pas : il arrêterait l'appel avant, avec son propre message.
        # Le Confirmation que rend confirmer() sans formulaire arrive comme une acceptation.
        confirmation: Annotated[ElicitationResult[Confirmation], Resolve(confirmer)],
    ) -> awa.CorrectionAppliquee:
        refus = {DeclinedElicitation: "refusée", CancelledElicitation: "annulée"}
        if type(confirmation) in refus:
            raise awa.ToolError(f"Correction {refus[type(confirmation)]} par Awa : le stock n'a pas changé.")
        if not confirmation.data.confirme:
            raise awa.ToolError("Awa n'a pas coché la confirmation : le stock n'a pas changé.")
        with awa._ouvrir() as db:
            return awa.appliquer(db, jeton, awa._maintenant())

    @serveur.tool(title="Rapport de la semaine", annotations=awa.LECTURE)
    async def rapport_de_la_semaine(
        ctx: Context,
        un_jour_de_la_semaine: Annotated[date | None, Field(
            description="AAAA-MM-JJ, n'importe quel jour de la semaine voulue. Sans date : la semaine en cours.")] = None,
    ) -> RapportSemaine:
        """Le rapport complet d'une semaine : ventes, jour par jour, par quartier, et comparaison avec la
        semaine précédente. Signale sa progression pendant le calcul. Ne modifie rien."""
        un_jour = un_jour_de_la_semaine or awa._aujourdhui()
        lundi = un_jour - timedelta(days=un_jour.weekday())
        with awa._ouvrir() as db:
            ventes = awa.lire_ventes_semaine(db, awa._catalogue(), un_jour)
            commandes = awa._commandes(db)
        par_jour, quartiers = [], {}
        for i in range(7):
            jour = lundi + timedelta(days=i)
            du_jour = [c for c in commandes if c.quand.date() == jour]
            for c in du_jour:
                quartiers[c.quartier] = quartiers.get(c.quartier, 0) + c.total
            par_jour.append(JourDuRapport(jour=jour.isoformat(), commandes=len(du_jour),
                                          total_fcfa=sum(c.total for c in du_jour)))
            await ctx.report_progress(i + 1, total=8, message=f"{awa.jour_en_toutes_lettres(jour)} : "
                                                                f"{len(du_jour)} commande{'s' if len(du_jour) > 1 else ''}")
        par_quartier = dict(sorted(quartiers.items(), key=lambda q: -q[1]))
        await ctx.report_progress(8, total=8, message="Rapport prêt")
        meilleur = max(par_jour, key=lambda j: j.total_fcfa)
        resume = (f"{ventes.resume} Meilleur jour : {awa.jour_en_toutes_lettres(date.fromisoformat(meilleur.jour))}"
                  f" ({awa.fcfa(meilleur.total_fcfa)}). Premier quartier : "
                  f"{next(iter(par_quartier), '—')}.")
        return RapportSemaine(ventes=ventes, par_jour=par_jour, par_quartier=par_quartier, resume=resume)

    @serveur.custom_route("/connexion", methods=["GET", "POST"])
    async def connexion(requete: Request):
        return await fournisseur.page_de_connexion(requete)

    @serveur.custom_route("/sante", methods=["GET"])
    async def sante(_: Request):
        # Jamais authentifiée : ne rien dire ici qui ne soit public.
        return JSONResponse({"etat": "ok", "version": awa.VERSION})

    serveur.fournisseur = fournisseur  # pour les scripts d'administration et les tests
    return serveur


def securite(url_publique: str) -> TransportSecuritySettings:
    """Les noms d'hôte acceptés : celui de l'adresse publique, et ceux qu'on ajoute (un tunnel d'essai)."""
    hotes = [urlsplit(url_publique).hostname] + [h.strip() for h in
                                                os.environ.get("COMPTOIR_HOTES_SUPPLEMENTAIRES", "").split(",") if h.strip()]
    return TransportSecuritySettings(allowed_hosts=[f for h in hotes for f in (h, f"{h}:*")],
                                     allowed_origins=["https://claude.ai"])


class JournalDesAcces:
    """Une ligne par requête MCP : la méthode, la révision du protocole, le client. Jamais le jeton."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/mcp":
            return await self.app(scope, receive, send)
        entetes = {k.decode().lower(): v.decode(errors="replace") for k, v in scope["headers"]}
        statut = {}

        async def envoyer(message):
            if message["type"] == "http.response.start":
                statut["code"] = message["status"]
            await send(message)

        await self.app(scope, receive, envoyer)
        journal.info("mcp %s %s protocole=%s client=%s -> %s", scope["method"], entetes.get("mcp-method", "-"),
                     entetes.get("mcp-protocol-version", "-"), entetes.get("user-agent", "-")[:60], statut.get("code"))


def application(url_publique: str, chemin_autorisation: str, mot_de_passe_hache: str):
    serveur = construire(url_publique, chemin_autorisation, mot_de_passe_hache)
    # stateless_http : les clients de la révision 2025-11-25 (l'application Claude, entre autres) n'ont pas
    # de session non plus ; ceux de la révision 2026-07-28 n'en ont jamais.
    app = serveur.streamable_http_app(stateless_http=True, transport_security=securite(url_publique))
    app.state.serveur = serveur
    app.add_middleware(JournalDesAcces)
    return app


def _depuis_l_environnement():
    url = os.environ.get("COMPTOIR_URL_PUBLIQUE", "").strip()
    hache = os.environ.get("COMPTOIR_MOT_DE_PASSE_HACHE", "").strip()
    if not url or not hache:
        return None  # importé par les tests ou par construire_extension : rien à servir
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    return application(url, os.environ.get("COMPTOIR_AUTORISATION", "donnees_clients/autorisation.sqlite3"), hache)


app = _depuis_l_environnement()
