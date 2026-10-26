"""Chapitre 16 : le serveur d'autorisation OAuth du Comptoir, pour une seule personne, Awa.

Le serveur MCP en ligne n'ouvre ses outils qu'avec un jeton d'accès. Ce module émet ces jetons :
il implémente le « fournisseur » que le SDK MCP attend (OAuthAuthorizationServerProvider) ; le
SDK, lui, sert les adresses du protocole OAuth (métadonnées, /authorize, /token, /register,
/revoke) et vérifie PKCE. Ce que ce module ajoute :
- une page de connexion, en français, où Awa tape son mot de passe et voit qui demande l'accès ;
- une liste blanche des adresses de retour : l'application Claude, et Claude Code sur cet ordinateur ;
- des jetons opaques, dont seule l'empreinte est gardée, dans une base SQLite (rien en mémoire :
  plusieurs processus peuvent servir les mêmes jetons) ;
- la rotation des jetons de renouvellement, et la révocation de tout s'il en revient un usagé ;
- un blocage après cinq mots de passe faux en quinze minutes.

Pour plusieurs personnes ou une entreprise, préférez un fournisseur d'identité (Keycloak, Auth0,
Entra…) : le SDK vérifie alors ses jetons, et ce module n'a plus lieu d'être.

Hacher le mot de passe d'Awa, à mettre dans COMPTOIR_MOT_DE_PASSE_HACHE ; tout révoquer :
    python -m ch16.autorisation hacher
    python -m ch16.autorisation deconnecter-tout donnees_clients/autorisation.sqlite3
"""

import base64
import getpass
import hashlib
import hmac
import html
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import AnyUrl
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import InvalidRedirectUriError, OAuthClientInformationFull, OAuthToken

PORTEE = "comptoir"
RETOUR_CLAUDE = "https://claude.ai/api/mcp/auth_callback"  # claude.ai, application de bureau et mobile
DUREE_DEMANDE = 10 * 60
DUREE_CODE = 5 * 60
DUREE_ACCES = 60 * 60
DUREE_RENOUVELLEMENT = 30 * 24 * 60 * 60
ESSAIS_MAX, FENETRE_ESSAIS = 5, 15 * 60


# ---------- Mot de passe -----------------------------------------------------------------------


def hacher(mot_de_passe: str, sel: bytes | None = None) -> str:
    """scrypt, avec un sel aléatoire : « scrypt:16384:8:1:sel:empreinte ».

    Des deux-points et non des « $ » : Docker Compose lirait « $… » comme une variable dans un fichier .env."""
    sel = sel or secrets.token_bytes(16)
    empreinte = hashlib.scrypt(mot_de_passe.encode(), salt=sel, n=2**14, r=8, p=1, dklen=32)
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
    return f"scrypt:16384:8:1:{b64(sel)}:{b64(empreinte)}"


def verifier_mot_de_passe(mot_de_passe: str, attendu: str) -> bool:
    try:
        _, n, r, p, sel, empreinte = attendu.split(":")
        decode = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        calcule = hashlib.scrypt(mot_de_passe.encode(), salt=decode(sel), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(calcule, decode(empreinte))


def _empreinte(jeton: str) -> str:
    return hashlib.sha256(jeton.encode()).hexdigest()


# ---------- Adresses de retour -------------------------------------------------------------------


def _locale(uri: str) -> bool:
    parties = urlsplit(uri)
    return parties.scheme == "http" and parties.hostname in ("localhost", "127.0.0.1")


def retour_autorise(uri: str) -> bool:
    """L'application Claude, ou un client sur cet ordinateur (Claude Code, nos scripts), port libre."""
    return uri == RETOUR_CLAUDE or (_locale(uri) and urlsplit(uri).path == "/callback")


def _sans_port(uri: str) -> str:
    p = urlsplit(uri)
    return f"{p.scheme}://{p.hostname}{p.path}"


class ClientAwa(OAuthClientInformationFull):
    """Un client enregistré, dont une adresse de retour locale vaut pour tous les ports.

    Claude Code change de port à chaque séance : RFC 8252 (§ 7.3) et la documentation d'Anthropic
    demandent de comparer une adresse de boucle locale sans son port.
    """

    def validate_redirect_uri(self, redirect_uri: AnyUrl | None) -> AnyUrl:
        if redirect_uri is not None and self.redirect_uris:
            demande = str(redirect_uri)
            for enregistree in map(str, self.redirect_uris):
                if demande == enregistree or (_locale(demande) and _locale(enregistree)
                                              and _sans_port(demande) == _sans_port(enregistree)):
                    return redirect_uri
            raise InvalidRedirectUriError(f"Adresse de retour non enregistrée pour ce client : {demande}")
        return super().validate_redirect_uri(redirect_uri)


# ---------- Le fournisseur ---------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL, cree_le REAL NOT NULL);
CREATE TABLE IF NOT EXISTS demandes (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expire REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes (empreinte TEXT PRIMARY KEY, donnees TEXT NOT NULL, expire REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jetons (empreinte TEXT PRIMARY KEY, sorte TEXT NOT NULL, client_id TEXT NOT NULL,
    portees TEXT NOT NULL, ressource TEXT, expire REAL NOT NULL, etat TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS echecs (quand REAL NOT NULL);
CREATE TABLE IF NOT EXISTS accords (demande TEXT PRIMARY KEY, retour TEXT NOT NULL, expire REAL NOT NULL);
"""


class FournisseurAwa:
    """Le serveur d'autorisation d'Awa, branché sur le SDK MCP (auth_server_provider)."""

    def __init__(self, base: str | Path, url_publique: str, ressource: str, mot_de_passe_hache: str,
                 horloge=time.time):
        self.chemin = str(base)
        self.url = url_publique.rstrip("/")
        self.ressource = ressource
        self.mot_de_passe_hache = mot_de_passe_hache
        self.horloge = horloge
        with self._db() as db:
            db.executescript(_SCHEMA)

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.chemin, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    # --- Clients (enregistrement dynamique, RFC 7591) ---

    async def get_client(self, client_id: str) -> ClientAwa | None:
        with self._db() as db:
            ligne = db.execute("SELECT info FROM clients WHERE client_id = ?", (client_id,)).fetchone()
        return ClientAwa.model_validate_json(ligne["info"]) if ligne else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        refusees = [str(u) for u in client_info.redirect_uris or [] if not retour_autorise(str(u))]
        if refusees:
            raise RegistrationError("invalid_redirect_uri",
                                    f"Adresse de retour refusée par ce serveur : {', '.join(refusees)}")
        with self._db() as db:
            db.execute("INSERT INTO clients VALUES (?, ?, ?)",
                       (client_info.client_id, client_info.model_dump_json(), self.horloge()))

    # --- Autorisation : la page de connexion ---

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource and params.resource.rstrip("/") != self.ressource.rstrip("/"):
            raise AuthorizeError("invalid_target", "Ce serveur ne délivre des jetons que pour le Comptoir.")
        identifiant = secrets.token_urlsafe(24)
        with self._db() as db:
            db.execute("DELETE FROM demandes WHERE expire < ?", (self.horloge(),))
            db.execute("INSERT INTO demandes VALUES (?, ?, ?, ?)",
                       (identifiant, client.client_id, params.model_dump_json(), self.horloge() + DUREE_DEMANDE))
        return f"{self.url}/connexion?demande={identifiant}"

    def _bloque(self, db: sqlite3.Connection) -> bool:
        (echecs,) = db.execute("SELECT COUNT(*) FROM echecs WHERE quand > ?",
                               (self.horloge() - FENETRE_ESSAIS,)).fetchone()
        return echecs >= ESSAIS_MAX

    async def page_de_connexion(self, requete: Request) -> Response:
        identifiant = requete.query_params.get("demande", "")
        with self._db() as db:
            ligne = db.execute("SELECT * FROM demandes WHERE id = ? AND expire > ?",
                               (identifiant, self.horloge())).fetchone()
            if ligne is None:
                # Sur une connexion qui se coupe, la réponse au premier envoi peut se perdre et le navigateur
                # renvoie le formulaire : on rend la même redirection, sans nouveau code. Sans danger : le
                # code ne sert qu'une fois, et seulement au client qui détient le vérificateur PKCE.
                accord = db.execute("SELECT retour FROM accords WHERE demande = ? AND expire > ?",
                                    (identifiant, self.horloge())).fetchone()
                if accord:
                    return RedirectResponse(accord["retour"], 302)
                return _page("Cette demande a expiré", "<p>Retournez dans Claude et relancez la connexion.</p>", 400)
            params = AuthorizationParams.model_validate_json(ligne["params"])
            client = await self.get_client(ligne["client_id"])
            if requete.method == "GET":
                return _page_accord(identifiant, client, params)
            formulaire = await requete.form()
            if formulaire.get("decision") == "refuser":
                db.execute("DELETE FROM demandes WHERE id = ?", (identifiant,))
                return RedirectResponse(construct_redirect_uri(str(params.redirect_uri), error="access_denied",
                                                               state=params.state, iss=self.url), 302)
            if self._bloque(db):
                return _page_accord(identifiant, client, params, "Trop d'essais : attendez quinze minutes.", 429)
            if not verifier_mot_de_passe(str(formulaire.get("mot_de_passe", "")), self.mot_de_passe_hache):
                db.execute("INSERT INTO echecs VALUES (?)", (self.horloge(),))
                return _page_accord(identifiant, client, params, "Mot de passe incorrect.", 401)
            code = secrets.token_urlsafe(32)
            donnees = AuthorizationCode(
                code=code, scopes=params.scopes or [PORTEE], expires_at=self.horloge() + DUREE_CODE,
                client_id=client.client_id, code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
                redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                resource=params.resource or self.ressource, subject="awa")
            # RFC 9207 : l'émetteur accompagne le code, et le client le vérifie.
            retour = construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state, iss=self.url)
            db.execute("DELETE FROM demandes WHERE id = ?", (identifiant,))
            db.execute("INSERT INTO codes VALUES (?, ?, ?)", (_empreinte(code), donnees.model_dump_json(),
                                                              donnees.expires_at))
            db.execute("INSERT INTO accords VALUES (?, ?, ?)", (identifiant, retour, donnees.expires_at))
        return RedirectResponse(retour, 302)

    # --- Codes et jetons ---

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str
                                      ) -> AuthorizationCode | None:
        with self._db() as db:
            ligne = db.execute("SELECT donnees FROM codes WHERE empreinte = ?", (_empreinte(authorization_code),)
                               ).fetchone()
        if ligne is None:
            return None
        code = AuthorizationCode.model_validate_json(ligne["donnees"])
        return code if code.client_id == client.client_id else None

    def _emettre(self, db: sqlite3.Connection, client_id: str, portees: list[str], ressource: str | None) -> OAuthToken:
        acces, renouvellement = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        maintenant = self.horloge()
        for jeton, sorte, duree in ((acces, "acces", DUREE_ACCES), (renouvellement, "renouvellement",
                                                                     DUREE_RENOUVELLEMENT)):
            db.execute("INSERT INTO jetons VALUES (?, ?, ?, ?, ?, ?, 'valide')",
                       (_empreinte(jeton), sorte, client_id, " ".join(portees), ressource, maintenant + duree))
        return OAuthToken(access_token=acces, token_type="Bearer", expires_in=DUREE_ACCES,
                          refresh_token=renouvellement, scope=" ".join(portees))

    async def exchange_authorization_code(self, client: OAuthClientInformationFull,
                                          authorization_code: AuthorizationCode) -> OAuthToken:
        with self._db() as db:
            supprime = db.execute("DELETE FROM codes WHERE empreinte = ?", (_empreinte(authorization_code.code),))
            if supprime.rowcount != 1:  # un code ne sert qu'une fois
                raise TokenError("invalid_grant", "Ce code a déjà servi.")
            return self._emettre(db, client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        with self._db() as db:
            ligne = db.execute("SELECT * FROM jetons WHERE empreinte = ? AND sorte = 'renouvellement'",
                               (_empreinte(refresh_token),)).fetchone()
            if ligne is None or ligne["client_id"] != client.client_id:
                return None
            if ligne["etat"] == "utilise":
                # Un jeton de renouvellement déjà échangé qui revient : il a été volé, ou copié.
                # On révoque tout ce que ce client détient (OAuth 2.1, rotation des jetons).
                db.execute("UPDATE jetons SET etat = 'revoque' WHERE client_id = ?", (client.client_id,))
                return None
            if ligne["etat"] != "valide" or ligne["expire"] < self.horloge():
                return None
        return RefreshToken(token=refresh_token, client_id=ligne["client_id"], scopes=ligne["portees"].split(),
                            expires_at=int(ligne["expire"]), resource=ligne["ressource"], subject="awa")

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken,
                                     scopes: list[str]) -> OAuthToken:
        with self._db() as db:
            db.execute("UPDATE jetons SET etat = 'utilise' WHERE empreinte = ?", (_empreinte(refresh_token.token),))
            return self._emettre(db, client.client_id, scopes or refresh_token.scopes, refresh_token.resource)

    async def load_access_token(self, token: str) -> AccessToken | None:
        with self._db() as db:
            ligne = db.execute("SELECT * FROM jetons WHERE empreinte = ? AND sorte = 'acces'",
                               (_empreinte(token),)).fetchone()
        if ligne is None or ligne["etat"] != "valide" or ligne["expire"] < self.horloge():
            return None
        return AccessToken(token=token, client_id=ligne["client_id"], scopes=ligne["portees"].split(),
                           expires_at=int(ligne["expire"]), resource=ligne["ressource"], subject="awa",
                           claims={"iss": self.url})

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        with self._db() as db:
            db.execute("UPDATE jetons SET etat = 'revoque' WHERE empreinte = ?", (_empreinte(token.token),))

    def deconnecter_tout(self) -> int:
        """Révoque tous les jetons : à faire si le téléphone d'Awa est perdu. Rend le nombre révoqué."""
        with self._db() as db:
            return db.execute("UPDATE jetons SET etat = 'revoque' WHERE etat = 'valide'").rowcount


# ---------- Les pages ----------------------------------------------------------------------------

_STYLE = ("body{font-family:system-ui,sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem;line-height:1.5}"
          "button{font-size:1rem;padding:.6rem 1rem;margin:.3rem .3rem 0 0}input{font-size:1rem;padding:.5rem;width:100%}"
          ".alerte{background:#fde8e8;padding:.6rem;border-radius:.4rem}.note{background:#fff6dd;padding:.6rem;border-radius:.4rem}")


def _origine(uri: str) -> str:
    p = urlsplit(uri)
    return f"{p.scheme}://{p.netloc}"


def _page(titre: str, corps: str, statut: int = 200, retour: str | None = None) -> HTMLResponse:
    # form-action s'applique aussi à la redirection qui suit l'envoi du formulaire : sans l'origine de
    # l'adresse de retour, le navigateur bloquerait le retour vers Claude (constaté pendant l'essai).
    action = "'self'" + (f" {_origine(retour)}" if retour else "")
    page = (f"<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" "
            f"content=\"width=device-width,initial-scale=1\"><title>{html.escape(titre)}</title><style>{_STYLE}</style>"
            f"</head><body><h1>{html.escape(titre)}</h1>{corps}</body></html>")
    return HTMLResponse(page, statut, headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY",
                                               "Content-Security-Policy": f"default-src 'none'; style-src 'unsafe-inline'; form-action {action}"})


def _page_accord(identifiant: str, client: OAuthClientInformationFull | None, params: AuthorizationParams,
                 erreur: str = "", statut: int = 200) -> HTMLResponse:
    retour = urlsplit(str(params.redirect_uri))
    texte = lambda s: html.escape(s, quote=False)  # un texte entre deux balises : < > & suffisent
    nom = texte((client.client_name if client else None) or "Une application")
    corps = (f"<p><strong>{nom}</strong> demande l'accès à votre Comptoir : lire vos commandes, votre stock et vos "
             f"ventes, et corriger le stock avec votre accord.</p><p>Après votre réponse, vous reviendrez sur "
             f"<strong>{texte(retour.hostname or '')}</strong>.</p>")
    if _locale(str(params.redirect_uri)):
        corps += ("<p class=\"note\">Le retour se fait sur cet ordinateur. N'acceptez que si vous venez de lancer "
                  "vous-même la connexion, par exemple depuis Claude Code.</p>")
    if erreur:
        corps += f"<p class=\"alerte\">{texte(erreur)}</p>"
    corps += (f"<form method=\"post\"><input type=\"hidden\" name=\"demande\" value=\"{html.escape(identifiant)}\">"
              "<label>Votre mot de passe du Comptoir<input type=\"password\" name=\"mot_de_passe\" "
              "autocomplete=\"current-password\" autofocus></label>"
              "<button name=\"decision\" value=\"autoriser\">Autoriser</button>"
              "<button name=\"decision\" value=\"refuser\">Refuser</button></form>")
    return _page("Comptoir pour Awa", corps, statut, retour=str(params.redirect_uri))


def main() -> None:
    if sys.argv[1:] == ["hacher"]:
        mot_de_passe = getpass.getpass("Mot de passe d'Awa (il ne s'affiche pas) : ")
        if len(mot_de_passe) < 12:
            raise SystemExit("Au moins 12 caractères.")
        print(hacher(mot_de_passe))
    elif sys.argv[1:2] == ["deconnecter-tout"] and len(sys.argv) == 3:
        # Téléphone perdu, mot de passe changé : toutes les applications devront se reconnecter.
        base = Path(sys.argv[2])
        if not base.is_file():
            raise SystemExit(f"Base introuvable : {base}")
        with sqlite3.connect(base) as db:
            n = db.execute("UPDATE jetons SET etat = 'revoque' WHERE etat = 'valide'").rowcount
        print(f"{n} jeton(s) révoqué(s).")
    else:
        raise SystemExit("Usage : python -m ch16.autorisation hacher\n"
                         "        python -m ch16.autorisation deconnecter-tout <base des jetons>")


if __name__ == "__main__":
    main()
