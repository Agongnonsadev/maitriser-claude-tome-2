"""La comparaison des modèles, avec un faux client qui imite deux modèles : aucun appel payant."""

from types import SimpleNamespace

import pytest
from anthropic.types import OutputTokensDetails, Usage

from ch03 import comparer_modeles as cm
from comptoir.notation import Cas


class FauxClient:
    """Le « grand » modèle répond juste ; le « petit » se trompe sur le prix du sirop."""

    def __init__(self):
        self.messages = self
        self.requetes = []

    def create(self, **requete):
        self.requetes.append(requete)
        question = requete["messages"][0]["content"]
        bon_prix = requete["model"] == "claude-opus-5-5" or "sirop" not in question
        texte = "Le sirop coûte 2 500 FCFA." if bon_prix else "Le sirop coûte 3 000 FCFA."
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=texte)],
            stop_reason="end_turn",
            usage=Usage(input_tokens=500, output_tokens=100,
                        output_tokens_details=OutputTokensDetails(thinking_tokens=40)),
            _request_id="req_test",
        )

    def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=500)


CAS = [
    Cas("prix-sirop", "Combien coûte le sirop ?", doit_contenir=["2 500"]),
    Cas("autre", "Et le jus ?", doit_contenir=["2 500"]),
]
CONFIGS = [("claude-opus-5-5", "medium"), ("claude-haiku-5-5", "low")]


@pytest.fixture(autouse=True)
def journal_temporaire(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


def test_chaque_cas_est_repete_pour_chaque_configuration():
    client = FauxClient()
    essais = cm.comparer(client, CAS, CONFIGS, repetitions=3, budget_max=10)
    assert len(essais) == 2 * 2 * 3
    assert {r["output_config"]["effort"] for r in client.requetes} == {"medium", "low"}
    assert all("temperature" not in r for r in client.requetes)


def test_cout_par_tache_reussie():
    essais = cm.comparer(FauxClient(), CAS, CONFIGS, repetitions=2, budget_max=10)
    resume = {(l["modele"], l["effort"]): l for l in cm.resumer(essais)}

    opus = resume[("claude-opus-5-5", "medium")]
    haiku = resume[("claude-haiku-5-5", "low")]
    assert opus["reussite"] == 1.0
    assert haiku["reussite"] == 0.5
    cout_haiku = (500 * 0.10 + 100 * 0.50) / 1e6
    # Le petit modèle ne réussit qu'une fois sur deux : sa réussite coûte deux appels.
    assert haiku["cout_par_reussite"] == pytest.approx(2 * cout_haiku)
    assert opus["reflexion_moyenne"] == 40


def test_le_budget_arrete_la_comparaison():
    # Un appel Opus coûte ici 0,004 $ : avec 0,005 $ de budget, on s'arrête après le deuxième.
    essais = cm.comparer(FauxClient(), CAS, CONFIGS, repetitions=3, budget_max=0.005)
    assert len(essais) == 2


def test_estimation_gratuite():
    total = cm.estimer(FauxClient(), CAS, CONFIGS, repetitions=1, sortie_supposee=100)
    attendu = 2 * (500 * 4 + 100 * 20) / 1e6 + 2 * (500 * 0.10 + 100 * 0.50) / 1e6
    assert total == pytest.approx(attendu)


def test_les_cas_du_livre_se_chargent():
    cas = cm.charger_cas()
    assert len(cas) == 15
    assert len({c.identifiant for c in cas}) == 15
