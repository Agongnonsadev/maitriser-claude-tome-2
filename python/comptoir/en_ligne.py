"""Le Comptoir en ligne (chapitre 19) : le chat web et WhatsApp, sur le Comptoir livré.

    python -m uvicorn comptoir.en_ligne:app --port 8019          (en local, depuis le dossier python/)

Ce qui change par rapport au chat du chapitre 6 (comptoir/web.py, gardé pour son exemple de flux) :
- les deux canaux passent par le Comptoir aiguillé, avec ses outils, sa confirmation par code et ses
  gardes (comptoir/service.py) ; la réponse arrive d'un bloc, pas mot à mot, car la boucle d'outils
  doit finir avant qu'on sache ce qui a été fait ;
- un message à la fois pour tout le serveur (un seul fil pour le Comptoir) ; les bases ne se lisent et ne
  s'écrivent que dans ce fil, purge et dédoublonnage compris : deux fils sur une même connexion SQLite
  mélangent leurs transactions et leurs compteurs de lignes (un test instable l'a montré) ;
- WhatsApp : webhook vérifié et signé, réponse par l'API de Meta, numéro gardé dans l'annuaire seulement ;
- le tableau de bord (/tableau, avec un jeton) et la santé du service (/sante) ;
- la surveillance du chapitre 18, si elle est activée, à côté de la réponse ;
- les limites et la purge du chapitre 18, pour les deux canaux.
"""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from importlib import resources

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse

from comptoir import config, tableau, whatsapp
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.conversations import Conversations
from comptoir.erreurs import INDISPONIBLE
from comptoir.flux import Generation
from comptoir.journal import noter_evenement
from comptoir.limites import Limiteur, adresse_du_client
from comptoir.service import ServiceComptoir
from comptoir.surveillance import surveiller
from comptoir.web import GARDE_S, Message, TailleMaximale, TropDeMessages, _flux_sse, _refus_de_limite

log = logging.getLogger("comptoir")
PURGE_S = 24 * 3600


class EnLigne:
    """L'état du serveur : le service, les canaux, les limites, les réponses en cours sur le web."""

    def __init__(self, client=None, boutique=None, budget=None, conversations=None, base=None, annuaire=None,
                 expediteur=None, **options):
        self._client, self._boutique, self._budget = client, boutique, budget
        self._conversations, self._base, self._annuaire, self._expediteur = conversations, base, annuaire, expediteur
        self.options = options
        self._service = None
        self.fil = ThreadPoolExecutor(max_workers=1, thread_name_prefix="comptoir")       # le Comptoir
        self.fil_surveillance = ThreadPoolExecutor(max_workers=2, thread_name_prefix="surveillance")
        self.generations: dict[str, Generation] = {}
        self.messages_par_minute = Limiteur(config.LIMITE_MESSAGES_MINUTE, 60)
        self.conversations_par_heure = Limiteur(config.LIMITE_CONVERSATIONS_HEURE, 3600)

    # Créés au premier usage : importer ce module ne lit ni la clé ni les bases.
    @property
    def client(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(timeout=config.DELAI_S, max_retries=config.REESSAIS)
        return self._client

    @property
    def service(self) -> ServiceComptoir:
        if self._service is None:
            from comptoir.connaissances import charger_base
            self._service = ServiceComptoir(
                self.client, self._boutique or Boutique(config.BOUTIQUE), self._budget or Budget(config.BUDGET),
                self._conversations or Conversations(config.CONVERSATIONS),
                self._base if self._base is not None else charger_base(), **self.options)
        return self._service

    @property
    def annuaire(self) -> whatsapp.Annuaire:
        if self._annuaire is None:
            self._annuaire = whatsapp.Annuaire(config.CONVERSATIONS)
        return self._annuaire

    @property
    def expediteur(self) -> whatsapp.Expediteur:
        if self._expediteur is None:
            self._expediteur = whatsapp.Expediteur(config.WHATSAPP_JETON, config.WHATSAPP_VERSION_API)
        return self._expediteur

    def limiter(self, limiteur: Limiteur, motif: str, cle: str) -> None:
        attente = limiteur.accepter(cle)
        if attente is not None:
            noter_evenement("limite", motif=motif, adresse=cle)
            raise TropDeMessages(motif, attente)

    def surveiller(self, texte: str, conversation: str, canal: str, groupe: str | None = None) -> None:
        if config.FILTRE_SURVEILLANCE:
            self.fil_surveillance.submit(self._surveiller, texte, conversation, canal, groupe)

    def _surveiller(self, texte: str, conversation: str, canal: str, groupe: str | None) -> None:
        """Dans le fil de surveillance : l'appel à Claude. La dépense, elle, est comptée dans le fil du
        Comptoir, comme tout ce qui touche aux bases (chapitre 20)."""
        _, dollars = surveiller(self.client, texte, conversation, canal)
        if dollars:
            try:
                self.fil.submit(self._compter_surveillance, conversation, groupe, dollars, canal)
            except RuntimeError:  # le serveur s'arrête : l'appel reste au journal, avec son coût
                pass

    def _compter_surveillance(self, conversation: str, groupe: str | None, dollars: float, canal: str) -> None:
        try:
            self.service.budget.ajouter(conversation, dollars, groupe)
        except Exception as erreur:
            # Dans le fil, une exception ne remonte nulle part : on la note (relecture de Claude, chapitre 20).
            noter_evenement("surveillance_impossible", conversation=conversation, canal=canal,
                            erreur=type(erreur).__name__, cout_dollars=round(dollars, 6))
            return
        noter_evenement("surveillance", conversation=conversation, canal=canal, cout_dollars=round(dollars, 6))

    # --- Le chat web ------------------------------------------------------------------------------

    async def lancer_web(self, m: Message, adresse: str) -> tuple[Generation, str | None]:
        limite = time.monotonic() - GARDE_S
        for cle in [c for c, g in self.generations.items() if g.terminee_le and g.terminee_le < limite]:
            del self.generations[cle]
        deja = self.generations.get(m.id_message)
        if deja:  # le même message, renvoyé après une coupure : on rattache
            return deja, None
        self.limiter(self.messages_par_minute, "messages_par_minute", adresse)
        conversation, motif = await asyncio.get_running_loop().run_in_executor(
            self.fil, self._ouvrir_web, m.conversation, adresse)
        deja = self.generations.get(m.id_message)
        if deja:  # arrivé deux fois pendant l'attente : on rattache au premier
            return deja, None
        generation = Generation(conversation)
        self.generations[m.id_message] = generation
        generation.tache = asyncio.create_task(self._produire_web(generation, m.texte, adresse))
        return generation, motif

    def _ouvrir_web(self, conversation: str | None, adresse: str) -> tuple[str, str | None]:
        """Dans le fil du Comptoir : la conversation existe-t-elle, en ouvrir une, compter les neuves."""
        if not conversation or not self.service.conversations.existe(conversation):
            self.limiter(self.conversations_par_heure, "conversations_par_heure", adresse)
        conversation, motif, _ = self.service.ouvrir(conversation)
        return conversation, motif

    async def _produire_web(self, generation: Generation, texte: str, adresse: str) -> None:
        self.surveiller(texte, generation.conversation, "web", f"adresse:{adresse}")
        try:
            tour = await asyncio.get_running_loop().run_in_executor(
                self.fil, self.service.repondre, generation.conversation, texte, "web", f"adresse:{adresse}")
        except Exception:
            log.exception("Réponse impossible")
            generation.terminer({"type": "erreur", "message": INDISPONIBLE})
            return
        generation.ajouter(tour.texte)
        generation.terminer({"type": "fin", "tronquee": False})

    # --- WhatsApp ---------------------------------------------------------------------------------

    def traiter_whatsapp(self, message: whatsapp.MessageEntrant) -> None:
        """Dans le fil du Comptoir : une réponse par message, envoyée par l'API de Meta."""
        try:
            self._traiter_whatsapp(message)
        except Exception as erreur:
            # Une exception dans le fil ne remonte nulle part : sans cette trace, le client attendrait en silence.
            log.exception("Message WhatsApp non traité")
            noter_evenement("whatsapp_traitement", erreur=type(erreur).__name__)

    def _traiter_whatsapp(self, message: whatsapp.MessageEntrant) -> None:
        if not self.annuaire.nouveau(message.identifiant):  # Meta réessaie : un message n'est traité qu'une fois
            return
        pseudo = whatsapp.pseudonyme(message.numero, config.SEL_PSEUDONYMES)
        try:
            self.limiter(self.messages_par_minute, "messages_par_minute", pseudo)
        except TropDeMessages:
            return  # un script, pas un client : pas de réponse, pas de coût
        conversation, _, nouvelle = self.service.ouvrir(self.annuaire.conversation(pseudo))
        self.annuaire.lier(pseudo, message.numero, conversation)
        if message.type != "text" or not message.texte:
            texte = whatsapp.NON_TEXTE
        else:
            self.surveiller(message.texte, conversation, "whatsapp", pseudo)
            texte = self.service.repondre(conversation, message.texte, "whatsapp", groupe=pseudo).texte
        if nouvelle:
            texte = f"{whatsapp.MENTION_IA}\n\n{texte}"
        try:
            self.expediteur.envoyer(message.numero_entreprise, message.numero, texte)
            noter_evenement("whatsapp_envoi", conversation=conversation)
        except Exception as erreur:
            noter_evenement("whatsapp_envoi", conversation=conversation, erreur=type(erreur).__name__,
                            statut=getattr(getattr(erreur, "response", None), "status_code", None))

    def purger(self) -> dict:
        resultat = self.service.boutique.purger(config.CONSERVATION_DEMANDES_J, config.CONSERVATION_NOMS_J,
                                                config.CONSERVATION_RECAPITULATIFS_J)
        resultat["conversations"] = self.service.conversations.purger()
        resultat["clients_whatsapp"] = self.annuaire.purger(config.CONSERVATION_J)
        return resultat


def _jeton_valide(requete: Request) -> bool:
    return bool(config.TABLEAU_JETON) and requete.headers.get("authorization") == f"Bearer {config.TABLEAU_JETON}"


def creer_app(**reglages) -> FastAPI:
    etat = EnLigne(**reglages)

    async def purger_chaque_jour() -> None:
        while True:
            try:
                noter_evenement("purge", **await asyncio.get_running_loop().run_in_executor(etat.fil, etat.purger))
            except Exception:
                log.exception("Purge impossible")
            await asyncio.sleep(PURGE_S)

    @asynccontextmanager
    async def cycle_de_vie(_app):
        tache = asyncio.create_task(purger_chaque_jour())
        try:
            yield
        finally:
            tache.cancel()
            # Les messages en file sont finis avant l'arrêt : Meta a déjà reçu son 200 et ne les renverra pas.
            # (compose.yaml laisse 30 secondes au conteneur pour s'arrêter.) La surveillance, elle, peut attendre.
            etat.fil.shutdown(wait=True)
            etat.fil_surveillance.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Le Comptoir d'Awa, en ligne", lifespan=cycle_de_vie)
    app.state.etat = etat

    # Chapitre 18 : un corps trop gros est refusé, même envoyé en morceaux. WhatsApp a sa propre limite :
    # Meta envoie des notifications jusqu'à 3 Mo.
    app.add_middleware(TailleMaximale, maximum=lambda chemin: (
        config.TAILLE_MAX_WEBHOOK if chemin == "/whatsapp" else config.TAILLE_MAX_REQUETE))

    @app.get("/", response_class=HTMLResponse)
    def page() -> str:
        return resources.files("comptoir").joinpath("pages/comptoir.html").read_text(encoding="utf-8")

    @app.post("/api/messages")
    async def messages(m: Message, requete: Request):
        adresse = adresse_du_client(requete.client.host if requete.client else None,
                                    requete.headers.get("x-forwarded-for"), config.PROXIES_DE_CONFIANCE)
        try:
            generation, motif = await etat.lancer_web(m, adresse)
        except TropDeMessages as limite:
            return _refus_de_limite(limite)
        return StreamingResponse(_flux_sse(generation, motif, m.depuis), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/whatsapp")
    def verifier_webhook(requete: Request):
        """La vérification de Meta : rendre hub.challenge si le jeton est le bon."""
        p = requete.query_params
        if (config.WHATSAPP_JETON_VERIFICATION and p.get("hub.mode") == "subscribe"
                and p.get("hub.verify_token") == config.WHATSAPP_JETON_VERIFICATION):
            return PlainTextResponse(p.get("hub.challenge", ""))
        return PlainTextResponse("Refusé", status_code=403)

    @app.post("/whatsapp")
    async def recevoir(requete: Request):
        corps = await requete.body()
        if not whatsapp.signature_valide(corps, requete.headers.get("x-hub-signature-256"), config.WHATSAPP_SECRET_APP):
            noter_evenement("whatsapp_signature_invalide")
            return PlainTextResponse("Signature invalide", status_code=401)
        if not config.SEL_PSEUDONYMES:
            # Sans sel, l'empreinte d'un numéro se retrouve en essayant tous les numéros possibles : on ne
            # traite rien. Meta, qui reçoit 503, renvoie la notification pendant 7 jours (chapitre 20).
            noter_evenement("whatsapp_non_configure", manque="COMPTOIR_SEL_PSEUDONYMES")
            return PlainTextResponse("WhatsApp n'est pas encore configuré", status_code=503)
        try:
            entrants = whatsapp.messages_entrants(await requete.json())
        except ValueError:
            return PlainTextResponse("Corps illisible", status_code=400)
        for message in entrants:
            # Confié au fil du Comptoir, sans l'attendre : Meta reçoit son 200 tout de suite. Le doublon est
            # écarté dans le fil, comme tout ce qui touche aux bases.
            etat.fil.submit(etat.traiter_whatsapp, message)
        return PlainTextResponse("ok")

    @app.get("/tableau", response_class=HTMLResponse)
    def tableau_de_bord(requete: Request):
        if not _jeton_valide(requete):
            return PlainTextResponse("Accès réservé", status_code=401)
        return tableau.en_html(tableau.charger())

    @app.get("/sante")
    def sante():
        return {"etat": "ok"}

    return app


app = creer_app()
