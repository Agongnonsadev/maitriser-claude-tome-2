"""Le Comptoir du chapitre 5, avec un faux client : aucun appel payant."""

import json
from types import SimpleNamespace

from anthropic.types import Usage

from comptoir import assistant
from comptoir.prompt import charger


class FauxClient:
    def __init__(self):
        self.messages = self
        self.requete = None

    def create(self, **requete):
        self.requete = requete
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text="Le sirop coûte 2 500 FCFA.")],
            stop_reason="end_turn",
            usage=Usage(input_tokens=900, output_tokens=60),
            _request_id="req_test",
        )


def test_la_requete_balise_le_message_et_utilise_le_prompt_v1():
    requete = assistant.construire_requete("Combien coûte le sirop ?")
    assert requete["system"] == charger("v1").texte
    assert requete["messages"] == [
        {"role": "user", "content": "<message_client>\nCombien coûte le sirop ?\n</message_client>"}
    ]
    assert "temperature" not in requete


def test_la_consigne_d_awa_suit_le_message_du_client():
    requete = assistant.construire_requete("3 corossols ce soir ?", consignes=["Corossol en rupture."])
    roles = [m["role"] for m in requete["messages"]]
    assert roles == ["user", "system"]
    assert requete["messages"][-1]["content"] == "Corossol en rupture."
    # Le prompt système, lui, n'a pas bougé : son cache reste valable.
    assert requete["system"] == assistant.construire_requete("autre chose")["system"]


def test_l_historique_est_conserve_tel_quel():
    historique = [
        {"role": "user", "content": "<message_client>\nBonjour\n</message_client>"},
        {"role": "assistant", "content": "Bonjour ! Que puis-je pour vous ?"},
    ]
    requete = assistant.construire_requete("Le bissap ?", historique=historique)
    assert requete["messages"][:2] == historique
    assert len(requete["messages"]) == 3


def test_l_effort_vient_de_la_configuration(monkeypatch):
    monkeypatch.setattr("comptoir.config.EFFORT", "low")
    assert assistant.construire_requete("?")["output_config"] == {"effort": "low"}
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    assert "output_config" not in assistant.construire_requete("?")


def test_le_journal_note_la_version_du_prompt(tmp_path, monkeypatch):
    journal = tmp_path / "appels.jsonl"
    monkeypatch.setattr("comptoir.config.JOURNAL", str(journal))
    texte, _, _ = assistant.repondre(FauxClient(), "Combien coûte le sirop ?")
    assert texte == "Le sirop coûte 2 500 FCFA."
    ligne = json.loads(journal.read_text(encoding="utf-8"))
    assert ligne["prompt"] == charger("v1").identifiant
