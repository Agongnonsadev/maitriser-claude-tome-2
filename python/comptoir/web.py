"""Le Comptoir sur le web (chapitres 6 et 8) : une page, un flux, des conversations gardées,
et un budget vérifié avant chaque réponse.

Chapitre 18 : des limites par adresse réseau (comptoir/limites.py), une taille maximale de requête,
un quota du jour par adresse, et la suppression des conversations anciennes une fois par jour.

Lancer en local, depuis le dossier python/ :
    python -m uvicorn comptoir.web:app --reload
puis ouvrir http://127.0.0.1:8000
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from importlib import resources

import anthropic
from anthropic import AsyncAnthropic
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from comptoir import assistant, config
from comptoir.appel import CHAMPS_COMPTAGE
from comptoir.budget import Budget
from comptoir.conversations import Conversations
from comptoir.couts import cout_maximal, duree_cache
from comptoir.erreurs import INDISPONIBLE, REFUS, diagnostiquer
from comptoir.flux import Generation, diffuser
from comptoir.journal import noter_evenement
from comptoir.limites import Limiteur, adresse_du_client
from comptoir.prompt import PromptSysteme, charger

log = logging.getLogger("comptoir")

GARDE_S = 600  # une réponse terminée reste 10 minutes en mémoire, pour une connexion qui revient
PURGE_S = 24 * 3600  # les conversations anciennes sont supprimées une fois par jour (chapitre 18)


class Message(BaseModel):
    conversation: str | None = None
    id_message: str = Field(min_length=8, max_length=64)  # créé par le navigateur, un par message
    texte: str = Field(min_length=1, max_length=2000)
    depuis: int = Field(default=0, ge=0)  # nombre de morceaux déjà reçus (reprise)


class Occupee(Exception):
    """Une réponse est déjà en cours dans cette conversation."""


class TropDeMessages(Exception):
    """Une limite de l'adresse est atteinte (chapitre 18) ; `attente` : les secondes avant de réessayer."""

    def __init__(self, motif: str, attente: float):
        super().__init__(motif)
        self.motif, self.attente = motif, attente


class Comptoir:
    """L'état du serveur : le client de l'API, les conversations, les réponses en cours."""

    def __init__(self, client=None, conversations: Conversations | None = None, budget: Budget | None = None):
        self._client = client
        self._conversations = conversations
        self._budget = budget
        self.generations: dict[str, Generation] = {}
        self.messages_par_minute = Limiteur(config.LIMITE_MESSAGES_MINUTE, 60)
        self.conversations_par_heure = Limiteur(config.LIMITE_CONVERSATIONS_HEURE, 3600)

    # Créés au premier usage : importer ce module ne doit ni lire la clé ni ouvrir la base.
    @property
    def client(self):
        if self._client is None:
            self._client = AsyncAnthropic(timeout=config.DELAI_S, max_retries=config.REESSAIS)
        return self._client

    @property
    def budget(self) -> Budget:
        if self._budget is None:
            self._budget = Budget(config.BUDGET)
        return self._budget

    @property
    def conversations(self) -> Conversations:
        if self._conversations is None:
            self._conversations = Conversations(config.CONVERSATIONS)
        return self._conversations

    def _oublier_les_anciennes(self) -> None:
        limite = time.monotonic() - GARDE_S
        for cle in [c for c, g in self.generations.items() if g.terminee_le and g.terminee_le < limite]:
            del self.generations[cle]

    def _limiter(self, limiteur: Limiteur, motif: str, adresse: str) -> None:
        attente = limiteur.accepter(adresse)
        if attente is not None:
            noter_evenement("limite", motif=motif, adresse=adresse)
            raise TropDeMessages(motif, attente)

    def lancer(self, m: Message, adresse: str = "inconnue") -> tuple[Generation, str | None]:
        """Renvoie la réponse à suivre, et le motif si la conversation a dû être renouvelée."""
        self._oublier_les_anciennes()

        # Le même message, renvoyé après une coupure : on rattache, on ne rappelle pas Claude.
        deja = self.generations.get(m.id_message)
        if deja:
            if m.conversation not in (None, deja.conversation):
                raise Occupee(m.conversation)  # un identifiant déjà pris ailleurs : refusé
            return deja, None
        # Une reprise ne compte pas ; un nouveau message, si (chapitre 18).
        self._limiter(self.messages_par_minute, "messages_par_minute", adresse)

        prompt = charger()  # relu à chaque message : Awa a pu changer son catalogue
        conversation, motif = m.conversation, None
        if conversation and self.conversations.existe(conversation):
            motif = self.conversations.motif_de_cloture(conversation, prompt.identifiant)
        else:
            motif = "inconnue" if conversation else None
        if not conversation or motif:
            self._limiter(self.conversations_par_heure, "conversations_par_heure", adresse)
            conversation = self.conversations.creer(prompt.identifiant)

        # Une réponse à la fois par conversation : sinon deux réponses écrites sans se voir
        # entreraient dans le même historique, et Claude relirait un passé qu'il n'a pas vécu.
        if any(g.conversation == conversation and g.fin is None for g in self.generations.values()):
            raise Occupee(conversation)

        generation = Generation(conversation)
        self.generations[m.id_message] = generation
        generation.tache = asyncio.create_task(self._produire(generation, m.texte, prompt, adresse))
        return generation, motif

    async def _reserver(self, generation: Generation, requete: dict, adresse: str = "inconnue"):
        """Compte l'entrée (gratuit) et réserve le coût maximal. Rend (réservation, maximum) ou None."""
        try:
            compte = await self.client.messages.count_tokens(**{k: v for k, v in requete.items() if k in CHAMPS_COMPTAGE})
        except Exception as erreur:
            diagnostic = diagnostiquer(erreur)
            noter_evenement("comptage_impossible", client=generation.conversation, erreur=diagnostic.code,
                            origine=diagnostic.origine)
            generation.terminer({"type": "erreur", "message": diagnostic.pour_le_client})
            return None
        maximum = cout_maximal(requete["model"], compte.input_tokens, requete["max_tokens"], duree_cache(requete))
        decision = self.budget.reserver(generation.conversation, maximum, groupe=f"adresse:{adresse}")
        if not decision.accepte:
            noter_evenement("hors_budget", motif=decision.motif, client=generation.conversation)
            generation.terminer({"type": "erreur", "message": INDISPONIBLE})
            return None
        if decision.alerte:
            log.warning("Budget : seuil d'alerte franchi (jour %.4f $, mois %.4f $)", self.budget.du_jour(),
                        self.budget.du_mois())
        return decision.reservation, maximum

    async def _produire(self, generation: Generation, texte: str, prompt: PromptSysteme,
                        adresse: str = "inconnue") -> None:
        historique = self.conversations.historique(generation.conversation)
        requete = assistant.construire_requete(texte, historique=historique, prompt=prompt)
        reserve = await self._reserver(generation, requete, adresse)
        if reserve is None:
            return
        reservation, maximum = reserve
        try:
            resultat = await diffuser(self.client, requete, generation, prompt.identifiant)
        except Exception as erreur:
            # Rien n'est écrit dans l'historique : la question pourra être reposée telle quelle.
            diagnostic = diagnostiquer(erreur)
            log.exception("Réponse impossible (%s, origine : %s)", diagnostic.code, diagnostic.origine)
            # Refusée par l'API avant d'écrire quoi que ce soit : rien n'est facturé.
            if isinstance(erreur, anthropic.APIStatusError) and not generation.morceaux:
                self.budget.liberer(reservation)
            generation.terminer({"type": "erreur", "message": diagnostic.pour_le_client})
            return

        # Après une reprise, le coût de l'appel coupé n'est pas connu : on garde le maximum réservé.
        self.budget.regler(reservation, maximum if resultat.repris else resultat.cout.dollars)
        message, usage = resultat.message, resultat.message.usage
        if message.stop_reason == "refusal":
            # Le texte déjà affiché est à jeter, et le tour n'entre pas dans l'historique.
            generation.terminer({"type": "refus", "message": REFUS})
            return
        # Cas normal : la réponse telle quelle, blocs de réflexion compris. Après une reprise,
        # le texte complet, en un seul bloc : la réflexion d'un flux coupé ne se recolle pas.
        contenu = [{"type": "text", "text": generation.texte}] if resultat.repris else message.content
        question = requete["messages"][len(historique)]  # le message du client, tel qu'envoyé
        tokens = (
            usage.input_tokens
            + (usage.cache_read_input_tokens or 0)
            + (usage.cache_creation_input_tokens or 0)
            + usage.output_tokens
        )
        self.conversations.ajouter_tour(
            generation.conversation, [question, {"role": "assistant", "content": contenu}], tokens
        )
        log.info("Réponse %s : %s", generation.conversation[:8], resultat.cout)
        # Le coût reste côté serveur (journal) : le client d'Awa n'a pas à le voir.
        generation.terminer({"type": "fin", "tronquee": message.stop_reason == "max_tokens"})


def _evenement_sse(nom: str, donnees: dict, identifiant: int | None = None) -> str:
    """Un événement SSE. Les données sont en JSON : un retour à la ligne dans le texte de
    Claude ne peut donc pas casser le format, où une ligne vide sépare les événements."""
    lignes = [f"event: {nom}"]
    if identifiant is not None:
        lignes.append(f"id: {identifiant}")
    lignes.append("data: " + json.dumps(donnees, ensure_ascii=False))
    return "\n".join(lignes) + "\n\n"


async def _flux_sse(generation: Generation, motif: str | None, depuis: int):
    yield _evenement_sse("conversation", {"conversation": generation.conversation, "renouvelee": motif})
    async for nature, rang, valeur in generation.suivre(depuis):
        if nature == "texte":
            yield _evenement_sse("texte", {"texte": valeur}, rang)
        elif nature == "silence":
            yield ": en vie\n\n"  # un commentaire SSE : ignoré par le navigateur, mais il passe
        else:
            yield _evenement_sse(valeur["type"], valeur)


async def _purger_chaque_jour(comptoir: Comptoir) -> None:
    """Chapitre 18 : la suppression promise au chapitre 6, faite pour de bon, au démarrage puis chaque jour."""
    while True:
        try:
            supprimees = comptoir.conversations.purger()
            noter_evenement("purge", conversations=supprimees)
        except Exception:
            log.exception("Purge des conversations impossible")
        await asyncio.sleep(PURGE_S)


def _refus_de_limite(limite: TropDeMessages) -> JSONResponse:
    return JSONResponse({"erreur": "Beaucoup de messages en peu de temps : réessayez dans une minute."},
                        status_code=429, headers={"Retry-After": str(int(limite.attente) + 1)})


class TailleMaximale:
    """Chapitre 18 : un corps trop gros est refusé (413). Devant le Comptoir, Caddy fait de même (directive
    request_body, max_size) ; la vérification reste ici, au cas où.

    Corrigé au chapitre 19 : lire l'en-tête Content-Length ne suffit pas, car un corps envoyé en morceaux
    (Transfer-Encoding: chunked) n'en a pas. Les octets sont donc aussi comptés à mesure qu'ils arrivent,
    et la lecture s'arrête au premier octet de trop. `maximum` donne la limite d'un chemin, lue à chaque
    requête dans comptoir/config.py."""

    def __init__(self, app, maximum=lambda chemin: config.TAILLE_MAX_REQUETE):
        self.app, self.maximum = app, maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        maximum = self.maximum(scope["path"])
        longueur = dict(scope["headers"]).get(b"content-length", b"")
        if longueur.isdigit() and int(longueur) > maximum:
            return await JSONResponse({"erreur": "Message trop long."}, status_code=413)(scope, receive, send)
        recus = 0

        async def recevoir():
            nonlocal recus
            message = await receive()
            if message["type"] == "http.request":
                recus += len(message.get("body", b""))
                if recus > maximum:
                    raise HTTPException(status_code=413, detail="Message trop long.")
            return message

        await self.app(scope, recevoir, send)


def creer_app(client=None, conversations: Conversations | None = None, budget: Budget | None = None) -> FastAPI:
    comptoir = Comptoir(client, conversations, budget)

    @asynccontextmanager
    async def cycle_de_vie(_app):
        tache = asyncio.create_task(_purger_chaque_jour(comptoir))
        try:
            yield
        finally:
            tache.cancel()

    app = FastAPI(title="Le Comptoir d'Awa", lifespan=cycle_de_vie)
    app.state.comptoir = comptoir
    app.add_middleware(TailleMaximale)

    @app.get("/", response_class=HTMLResponse)
    def page() -> str:
        return resources.files("comptoir").joinpath("pages/comptoir.html").read_text(encoding="utf-8")

    @app.post("/api/messages")
    async def messages(m: Message, requete: Request):
        adresse = adresse_du_client(requete.client.host if requete.client else None,
                                    requete.headers.get("x-forwarded-for"), config.PROXIES_DE_CONFIANCE)
        try:
            generation, motif = comptoir.lancer(m, adresse)
        except Occupee:
            return JSONResponse({"erreur": "Une réponse est déjà en cours."}, status_code=409)
        except TropDeMessages as limite:
            return _refus_de_limite(limite)
        return StreamingResponse(
            _flux_sse(generation, motif, m.depuis),
            media_type="text/event-stream",
            # no-cache : rien ne doit garder ce flux ; X-Accel-Buffering : demande à un proxy
            # nginx de transmettre chaque morceau sans attendre d'en avoir plein.
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.websocket("/ws")
    async def websocket(socket: WebSocket):
        """La même conversation par WebSocket : une connexion ouverte dans les deux sens."""
        await socket.accept()
        adresse = adresse_du_client(socket.client.host if socket.client else None,
                                    socket.headers.get("x-forwarded-for"), config.PROXIES_DE_CONFIANCE)
        try:
            while True:
                try:
                    m = Message.model_validate(await socket.receive_json())
                    generation, motif = comptoir.lancer(m, adresse)
                except (ValidationError, Occupee, TropDeMessages):
                    await socket.send_json({"type": "erreur", "message": "Message refusé ou réponse déjà en cours."})
                    continue
                await socket.send_json(
                    {"type": "conversation", "conversation": generation.conversation, "renouvelee": motif}
                )
                async for nature, rang, valeur in generation.suivre(m.depuis):
                    if nature == "texte":
                        await socket.send_json({"type": "texte", "rang": rang, "texte": valeur})
                    elif nature == "silence":
                        await socket.send_json({"type": "en_vie"})
                    else:
                        await socket.send_json(valeur)
        except WebSocketDisconnect:
            pass  # la réponse continue de s'écrire ; une nouvelle connexion la reprendra

    return app


app = creer_app()
