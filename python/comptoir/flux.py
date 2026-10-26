"""Streamer une réponse de Claude, la garder pour qui la lit, la reprendre si le flux casse (chapitre 6).

La génération est découplée de la connexion du navigateur : Claude écrit dans une
Generation, gardée en mémoire ; une ou plusieurs connexions la lisent. Si le téléphone
du client perd le réseau, la réponse continue de s'écrire, et la connexion suivante
reprend au morceau où la précédente s'était arrêtée.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

import anthropic
import httpx2  # le client HTTP sur lequel repose le SDK anthropic 1.x

from comptoir.couts import Cout, cout
from comptoir.erreurs import diagnostiquer, diagnostiquer_arret
from comptoir.journal import noter

log = logging.getLogger("comptoir")

# Méthode documentée pour les modèles 4.6 et suivants : un nouveau message de
# l'utilisateur, qui contient la réponse partielle et demande de continuer.
CONSIGNE_DE_REPRISE = (
    "Ta réponse précédente a été interrompue. Elle se terminait ainsi :\n"
    "<reponse_interrompue>\n{partiel}\n</reponse_interrompue>\n"
    "Reprends exactement là où tu t'es arrêté, sans répéter ce qui précède."
)

# Types d'erreur passagers qui peuvent arriver en plein flux, après le statut 200.
ERREURS_PASSAGERES = {"overloaded_error", "api_error"}


class FluxIncomplet(Exception):
    """Le flux s'est fermé sans message_stop. Le SDK ne lève alors aucune erreur : il rend
    un message tronqué, sans raison d'arrêt (vérifié par tests/test_ch06_coupure.py)."""


def reprenable(erreur: BaseException) -> bool:
    """Une coupure ou une surcharge se reprend ; une requête refusée (400, 401…) non."""
    if isinstance(erreur, FluxIncomplet):
        return True
    if isinstance(erreur, anthropic.APIStatusError):
        if erreur.status_code >= 500:  # 500 erreur interne, 529 surcharge
            return True
        # Une erreur arrivée en plein flux garde le statut 200 : son type est dans le corps.
        corps = erreur.body if isinstance(erreur.body, dict) else {}
        return corps.get("error", {}).get("type") in ERREURS_PASSAGERES
    # Une connexion qui lâche en plein flux remonte comme une erreur de transport du
    # client HTTP, pas comme une erreur du SDK (vérifié par tests/test_ch06_coupure.py).
    return isinstance(erreur, (anthropic.APIConnectionError, httpx2.TransportError))


def requete_de_reprise(requete: dict, partiel: str) -> dict:
    """La requête qui demande à Claude de finir une réponse coupée.

    On ajoute un message sans toucher aux précédents : le début de la conversation reste
    identique, son cache et la réflexion préservée restent valables. Le message se place
    juste après celui du client, avant d'éventuelles consignes d'Awa, car un message
    système en cours de conversation doit rester le dernier ou être suivi d'une réponse.
    """
    messages = list(requete["messages"])
    position = len(messages)
    while position and messages[position - 1]["role"] == "system":
        position -= 1
    messages.insert(position, {"role": "user", "content": CONSIGNE_DE_REPRISE.format(partiel=partiel)})
    return {**requete, "messages": messages}


@dataclass
class Generation:
    """Une réponse en cours d'écriture. Plusieurs connexions peuvent la suivre ;
    une connexion coupée la reprend au rang où elle en était."""

    conversation: str
    morceaux: list[str] = field(default_factory=list)
    fin: dict | None = None
    terminee_le: float | None = None
    tache: asyncio.Task | None = field(default=None, repr=False)
    _signal: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def texte(self) -> str:
        return "".join(self.morceaux)

    def ajouter(self, morceau: str) -> None:
        self.morceaux.append(morceau)
        self._reveiller()

    def terminer(self, evenement: dict) -> None:
        self.fin = evenement
        self.terminee_le = time.monotonic()
        self._reveiller()

    def _reveiller(self) -> None:
        signal, self._signal = self._signal, asyncio.Event()
        signal.set()

    async def suivre(self, depuis: int = 0, silence_max: float = 15.0):
        """Rend ("texte", rang, morceau) à partir du rang `depuis`, puis ("fin", rang, evenement).

        Rend ("silence", rang, None) quand rien n'arrive pendant silence_max secondes :
        de quoi envoyer un signe de vie, pour que ni le navigateur ni un proxy ne
        prennent la connexion pour morte.
        """
        rang = depuis
        while True:
            signal = self._signal  # pris avant de lire : rien ne peut nous échapper
            while rang < len(self.morceaux):
                yield "texte", rang, self.morceaux[rang]
                rang += 1
            if self.fin is not None:
                yield "fin", rang, self.fin
                return
            try:
                await asyncio.wait_for(signal.wait(), silence_max)
            except asyncio.TimeoutError:
                yield "silence", rang, None


@dataclass
class Resultat:
    message: object      # le dernier message reçu de l'API
    cout: Cout           # son coût (celui d'un appel coupé n'est pas connu)
    repris: bool         # True si la réponse a dû être reprise après une coupure


async def _un_flux(client, requete: dict, generation: Generation, prompt: str | None) -> tuple[object, Cout]:
    identifiant, debut = None, time.monotonic()
    try:
        async with client.messages.stream(**requete) as flux:
            identifiant = flux.request_id
            async for morceau in flux.text_stream:  # le texte seulement, jamais la réflexion
                generation.ajouter(morceau)
            message = await flux.get_final_message()
        if message.stop_reason is None:
            raise FluxIncomplet()
    except Exception as erreur:
        diagnostic = diagnostiquer(erreur)
        noter(identifiant, requete["model"], None, prompt=prompt, client=generation.conversation,
              erreur=diagnostic.code, origine=diagnostic.origine, duree_ms=_ms(debut))
        raise
    prix = cout(requete["model"], message.usage)
    arret = diagnostiquer_arret(message)
    noter(identifiant, requete["model"], prix, prompt=prompt, client=generation.conversation,
          stop_reason=message.stop_reason, duree_ms=_ms(debut),
          erreur=arret.code if arret else None, origine=arret.origine if arret else None)
    return message, prix


def _ms(debut: float) -> int:
    return round((time.monotonic() - debut) * 1000)


async def diffuser(client, requete: dict, generation: Generation, prompt: str | None = None) -> Resultat:
    """Streame la réponse dans `generation`, avec une reprise au plus si le flux casse.

    Une seule : si la reprise casse à son tour, l'erreur remonte, et c'est à l'interface
    de le dire au client plutôt que d'insister.
    """
    try:
        message, prix = await _un_flux(client, requete, generation, prompt)
        return Resultat(message, prix, repris=False)
    except Exception as erreur:
        if not reprenable(erreur):
            raise
        log.warning("Flux interrompu (%s), reprise après %d morceaux", type(erreur).__name__, len(generation.morceaux))

    partiel = generation.texte
    # Rien reçu : on renvoie simplement la requête. Sinon, on demande la suite.
    suite = requete_de_reprise(requete, partiel) if partiel else requete
    message, prix = await _un_flux(client, suite, generation, prompt)
    return Resultat(message, prix, repris=bool(partiel))
