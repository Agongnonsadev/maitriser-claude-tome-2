"""L'appel robuste du chapitre 8, avec un faux client synchrone : budget, journal, diagnostics."""

import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from anthropic.types import TextBlock, Usage

from comptoir.appel import HorsBudget, appeler
from comptoir.budget import Budget
from comptoir.erreurs import ErreurComptoir

REQUETE = {"model": "claude-sonnet-5-5", "max_tokens": 2000, "system": "s", "messages": [{"role": "user", "content": "Bonjour"}]}


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    chemin = tmp_path / "appels.jsonl"
    monkeypatch.setattr("comptoir.config.JOURNAL", str(chemin))
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 0.15)
    monkeypatch.setattr("comptoir.config.BUDGET_JOUR", 1.30)
    monkeypatch.setattr("comptoir.config.BUDGET_MOIS", 26.0)
    return chemin


def lignes(chemin):
    return [json.loads(l) for l in chemin.read_text(encoding="utf-8").splitlines()]


class FauxClient:
    def __init__(self, erreur=None, stop_reason="end_turn"):
        self.messages = self
        self.erreur, self.stop_reason = erreur, stop_reason
        self.appels = 0

    def count_tokens(self, **requete):
        assert "max_tokens" not in requete  # l'outil de comptage ne le prend pas
        return SimpleNamespace(input_tokens=1000)

    def create(self, **requete):
        self.appels += 1
        if self.erreur:
            raise self.erreur
        return SimpleNamespace(
            content=[TextBlock(type="text", text="Bonjour !")],
            stop_reason=self.stop_reason,
            stop_details=SimpleNamespace(category="general_harms") if self.stop_reason == "refusal" else None,
            usage=Usage(input_tokens=1000, output_tokens=100),
            _request_id="req_test",
        )


def test_un_appel_reussi_regle_le_cout_reel_et_se_note(journal):
    budget = Budget()
    reponse = appeler(FauxClient(), REQUETE, budget, "c1")
    assert reponse.texte == "Bonjour !" and reponse.arret is None
    assert budget.du_client("c1") == pytest.approx(reponse.cout.dollars)  # pas le maximum réservé
    ligne = lignes(journal)[0]
    assert ligne["client"] == "c1" and ligne["stop_reason"] == "end_turn" and "duree_ms" in ligne


def test_hors_budget_aucun_appel_ne_part(journal, monkeypatch):
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 0.0001)
    client = FauxClient()
    with pytest.raises(HorsBudget):
        appeler(client, REQUETE, Budget(), "c1")
    assert client.appels == 0
    assert lignes(journal)[0] == {**lignes(journal)[0], "evenement": "hors_budget", "motif": "quota_client"}


def test_une_erreur_de_l_api_libere_la_reservation(journal):
    reponse = httpx2.Response(401, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    budget = Budget()
    with pytest.raises(ErreurComptoir) as erreur:
        appeler(FauxClient(anthropic.AuthenticationError("Clé", response=reponse, body=None)), REQUETE, budget, "c1")
    assert erreur.value.diagnostic.code == "cle_invalide"
    assert budget.du_jour() == 0  # une erreur renvoyée par l'API n'est pas facturée
    assert lignes(journal)[0]["erreur"] == "cle_invalide"


def test_une_coupure_reseau_garde_la_reservation():
    budget = Budget()
    with pytest.raises(ErreurComptoir):
        appeler(FauxClient(httpx2.RemoteProtocolError("coupure")), REQUETE, budget, "c1")
    assert budget.du_jour() > 0  # la requête a pu aboutir sans que la réponse arrive


def test_un_refus_arrive_comme_une_reponse_normale(journal):
    reponse = appeler(FauxClient(stop_reason="refusal"), REQUETE, Budget(), "c1")
    assert reponse.arret.code == "refus" and "general_harms" in reponse.arret.pour_yao
    assert lignes(journal)[0]["erreur"] == "refus"
