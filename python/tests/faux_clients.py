"""Un faux client asynchrone qui streame : de quoi tester le chapitre 6 sans appel payant."""

import asyncio
from types import SimpleNamespace

from anthropic.types import TextBlock, ThinkingBlock, Usage


def message_final(texte: str, reflexion: bool = True, stop_reason: str | None = "end_turn"):
    """Un message final comme en rend le SDK : un bloc de réflexion (affichage omis) puis le texte."""
    blocs = [ThinkingBlock(type="thinking", thinking="", signature="signature-de-test")] if reflexion else []
    blocs.append(TextBlock(type="text", text=texte))
    return SimpleNamespace(
        content=blocs,
        stop_reason=stop_reason,
        usage=Usage(input_tokens=1000, output_tokens=50),
    )


class FauxFlux:
    """Rend les morceaux un par un ; lève `erreur` avant le morceau de rang `coupure`."""

    def __init__(self, morceaux, message=None, coupure=None, erreur=None, attente=0.0):
        self.morceaux = morceaux
        self.message = message or message_final("".join(morceaux))
        self.coupure, self.erreur, self.attente = coupure, erreur, attente
        self.request_id = "req_test"

    async def __aenter__(self):
        if self.coupure == 0 and self.erreur is not None:
            raise self.erreur  # échec avant le premier morceau
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        return self._texte()

    async def _texte(self):
        for rang, morceau in enumerate(self.morceaux):
            if rang == self.coupure:
                raise self.erreur
            await asyncio.sleep(self.attente)
            yield morceau

    async def get_final_message(self):
        return self.message


class FauxClientAsync:
    """Chaque appel à messages.stream() consomme le flux suivant de la liste."""

    def __init__(self, *flux):
        self.messages = self
        self.flux = list(flux)
        self.requetes = []

    def stream(self, **requete):
        self.requetes.append(requete)
        return self.flux.pop(0)

    async def count_tokens(self, **requete):  # chapitre 8 : le budget compte l'entrée avant d'appeler
        self.comptages = getattr(self, "comptages", 0) + 1
        return SimpleNamespace(input_tokens=1000)
