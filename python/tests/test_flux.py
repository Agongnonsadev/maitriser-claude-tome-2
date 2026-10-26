"""Le streaming du Comptoir, avec un faux client : reprise après coupure, rien en double."""

import asyncio
import json

import anthropic
import httpx2
import pytest

from comptoir.flux import FluxIncomplet, Generation, diffuser, reprenable, requete_de_reprise
from faux_clients import FauxClientAsync, FauxFlux, message_final

REQUETE = {
    "model": "claude-sonnet-5-5",
    "max_tokens": 2000,
    "system": "prompt",
    "messages": [{"role": "user", "content": "<message_client>\nVos jus ?\n</message_client>"}],
}


@pytest.fixture(autouse=True)
def journal_temporaire(tmp_path, monkeypatch):
    journal = tmp_path / "appels.jsonl"
    monkeypatch.setattr("comptoir.config.JOURNAL", str(journal))
    return journal


def _reponse(statut: int, corps: dict | None = None) -> httpx2.Response:
    return httpx2.Response(statut, json=corps, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


def test_la_reprise_ajoute_un_message_sans_toucher_aux_precedents():
    suite = requete_de_reprise(REQUETE, "Nous avons du bissap, du gin")
    assert suite["messages"][:1] == REQUETE["messages"]
    assert len(REQUETE["messages"]) == 1  # la requête d'origine n'a pas bougé
    assert suite["messages"][-1]["role"] == "user"
    assert "Nous avons du bissap, du gin" in suite["messages"][-1]["content"]
    assert suite["system"] == REQUETE["system"]


def test_la_reprise_se_place_avant_les_consignes_d_awa():
    avec_consigne = {**REQUETE, "messages": REQUETE["messages"] + [{"role": "system", "content": "Corossol en rupture."}]}
    roles = [m["role"] for m in requete_de_reprise(avec_consigne, "début")["messages"]]
    # Un message système doit rester le dernier ou être suivi d'une réponse.
    assert roles == ["user", "user", "system"]


def test_ce_qui_se_reprend_et_ce_qui_ne_se_reprend_pas():
    surcharge_en_plein_flux = anthropic.APIStatusError(
        "Overloaded",
        response=_reponse(200),
        body={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
    )
    assert reprenable(surcharge_en_plein_flux)
    assert reprenable(httpx2.RemoteProtocolError("peer closed connection"))
    assert reprenable(FluxIncomplet())
    assert reprenable(anthropic.InternalServerError("Erreur", response=_reponse(500), body=None))
    assert not reprenable(anthropic.BadRequestError("Requête invalide", response=_reponse(400), body=None))
    assert not reprenable(anthropic.AuthenticationError("Clé invalide", response=_reponse(401), body=None))


def test_une_connexion_qui_revient_reprend_au_bon_morceau():
    async def scenario():
        generation = Generation("c1")
        for morceau in ("Bon", "jour", " !"):
            generation.ajouter(morceau)
        generation.terminer({"type": "fin"})
        return [(n, r, v) async for n, r, v in generation.suivre(depuis=1)]

    assert asyncio.run(scenario()) == [("texte", 1, "jour"), ("texte", 2, " !"), ("fin", 3, {"type": "fin"})]


def test_un_signe_de_vie_quand_rien_n_arrive():
    async def scenario():
        generation = Generation("c1")
        lecteur = generation.suivre(silence_max=0.01)
        premier = await lecteur.__anext__()
        generation.ajouter("Oui")
        generation.terminer({"type": "fin"})
        return [premier] + [e async for e in lecteur]

    assert asyncio.run(scenario()) == [("silence", 0, None), ("texte", 0, "Oui"), ("fin", 1, {"type": "fin"})]


def test_un_flux_sans_incident(journal_temporaire):
    client = FauxClientAsync(FauxFlux(["Bissap, ", "gingembre."]))
    generation = Generation("c1")
    resultat = asyncio.run(diffuser(client, REQUETE, generation, "systeme-v1@test"))
    assert generation.texte == "Bissap, gingembre."
    assert not resultat.repris
    assert len(client.requetes) == 1
    ligne = json.loads(journal_temporaire.read_text(encoding="utf-8"))
    assert ligne["requete"] == "req_test" and ligne["cout_dollars"] > 0


def test_une_coupure_en_plein_flux_est_reprise_sans_doublon(journal_temporaire):
    coupe = FauxFlux(["Nous avons ", "du bissap", " et"], coupure=2, erreur=httpx2.RemoteProtocolError("coupure"))
    suite = FauxFlux([" du gingembre."], message=message_final(" du gingembre."))
    client = FauxClientAsync(coupe, suite)
    generation = Generation("c1")
    resultat = asyncio.run(diffuser(client, REQUETE, generation))
    assert resultat.repris
    assert generation.texte == "Nous avons du bissap du gingembre."
    # La deuxième requête contient la réponse partielle, pas la première requête en entier deux fois.
    assert "Nous avons du bissap" in client.requetes[1]["messages"][-1]["content"]
    lignes = [json.loads(l) for l in journal_temporaire.read_text(encoding="utf-8").splitlines()]
    assert [l.get("interrompu", False) for l in lignes] == [True, False]


def test_un_flux_ferme_sans_message_stop_est_repris():
    tronque = FauxFlux(["Nous avons "], message=message_final("Nous avons ", stop_reason=None))
    client = FauxClientAsync(tronque, FauxFlux(["du bissap."]))
    generation = Generation("c1")
    assert asyncio.run(diffuser(client, REQUETE, generation)).repris
    assert generation.texte == "Nous avons du bissap."


def test_une_erreur_avant_le_premier_morceau_renvoie_la_meme_requete():
    surcharge = anthropic.InternalServerError("Erreur", response=_reponse(500), body=None)
    client = FauxClientAsync(FauxFlux(["x"], coupure=0, erreur=surcharge), FauxFlux(["Bonjour."]))
    resultat = asyncio.run(diffuser(client, REQUETE, Generation("c1")))
    assert not resultat.repris
    assert client.requetes[1] == REQUETE


def test_une_requete_refusee_n_est_pas_reprise():
    refus = anthropic.BadRequestError("Requête invalide", response=_reponse(400), body=None)
    client = FauxClientAsync(FauxFlux(["x"], coupure=0, erreur=refus))
    with pytest.raises(anthropic.BadRequestError):
        asyncio.run(diffuser(client, REQUETE, Generation("c1")))
    assert len(client.requetes) == 1
