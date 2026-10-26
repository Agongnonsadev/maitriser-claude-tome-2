"""Ce que fait vraiment le SDK quand un flux casse, contre un faux serveur local.

Aucun appel à l'API : le client du SDK parle à un petit serveur sur 127.0.0.1, qui
commence une réponse en streaming puis la coupe de trois façons. De quoi vérifier, avec
la version installée du SDK, ce que comptoir.flux.reprenable doit reconnaître.
"""

import asyncio
import json

import anthropic
import httpx2
from anthropic import AsyncAnthropic

from comptoir.flux import reprenable

DEBUT = [
    ("message_start", {"type": "message_start", "message": {
        "id": "msg_local", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
        "content": [], "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Bonjour, "}}),
]
SURCHARGE = ("error", {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})


def _morceau(nom: str, donnees: dict) -> bytes:
    """Un événement SSE, dans un morceau HTTP « chunked », comme l'envoie l'API."""
    octets = f"event: {nom}\ndata: {json.dumps(donnees)}\n\n".encode()
    return f"{len(octets):x}\r\n".encode() + octets + b"\r\n"


def _serveur(fin: str):
    async def repondre(lecteur, ecrivain):
        entetes = (await lecteur.readuntil(b"\r\n\r\n")).decode()
        longueur = next(int(l.split(":")[1]) for l in entetes.split("\r\n") if l.lower().startswith("content-length"))
        await lecteur.readexactly(longueur)
        ecrivain.write(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n"
            b"request-id: req_local\r\ntransfer-encoding: chunked\r\n\r\n"
        )
        for nom, donnees in DEBUT:
            ecrivain.write(_morceau(nom, donnees))
        if fin == "erreur":
            ecrivain.write(_morceau(*SURCHARGE))
        if fin in ("erreur", "fermeture_propre"):
            ecrivain.write(b"0\r\n\r\n")  # fin normale du corps HTTP
        # fin == "coupure" : on ferme sans terminer le corps, comme un réseau qui lâche
        await ecrivain.drain()
        ecrivain.close()

    return repondre


def _essayer(fin: str):
    async def scenario():
        serveur = await asyncio.start_server(_serveur(fin), "127.0.0.1", 0)
        port = serveur.sockets[0].getsockname()[1]
        client = AsyncAnthropic(api_key="cle-factice-locale", base_url=f"http://127.0.0.1:{port}", max_retries=0)
        recu = []
        try:
            async with client.messages.stream(
                model="claude-sonnet-5-5", max_tokens=100, messages=[{"role": "user", "content": "Bonjour"}]
            ) as flux:
                async for texte in flux.text_stream:
                    recu.append(texte)
                return recu, await flux.get_final_message(), None
        except Exception as erreur:
            return recu, None, erreur
        finally:
            serveur.close()
            await serveur.wait_closed()

    return asyncio.run(scenario())


def test_une_connexion_coupee_remonte_comme_une_erreur_de_transport():
    recu, _, erreur = _essayer("coupure")
    assert recu == ["Bonjour, "]  # le début est bien arrivé
    assert isinstance(erreur, httpx2.TransportError)
    assert not isinstance(erreur, anthropic.APIError)  # ce n'est pas une erreur du SDK
    assert reprenable(erreur)


def test_une_erreur_en_plein_flux_garde_le_statut_200():
    recu, _, erreur = _essayer("erreur")
    assert recu == ["Bonjour, "]
    assert isinstance(erreur, anthropic.APIStatusError) and erreur.status_code == 200
    assert erreur.body["error"]["type"] == "overloaded_error"
    assert reprenable(erreur)


def test_un_flux_ferme_sans_message_stop_ne_leve_aucune_erreur():
    recu, message, erreur = _essayer("fermeture_propre")
    assert erreur is None
    # Le piège : un message tronqué, sans raison d'arrêt. D'où la vérification de stop_reason.
    assert message.stop_reason is None
    assert [b.text for b in message.content] == ["Bonjour, "]
