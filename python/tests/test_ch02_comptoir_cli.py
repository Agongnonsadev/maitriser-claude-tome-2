"""Le Comptoir en ligne de commande, testé avec un faux client : aucun appel payant."""

import json
from types import SimpleNamespace

from anthropic.types import OutputTokensDetails, Usage

from ch02 import comptoir_cli


class FauxClient:
    """Imite client.messages.create et garde la dernière requête pour l'inspecter."""

    def __init__(self, message):
        self.derniere_requete = None
        self._message = message
        self.messages = self

    def create(self, **requete):
        self.derniere_requete = requete
        return self._message


def faux_message():
    return SimpleNamespace(
        content=[
            SimpleNamespace(type="thinking", thinking=""),  # réflexion masquée par défaut
            SimpleNamespace(type="text", text="Le sirop de gingembre coûte 2 500 FCFA le flacon."),
        ],
        stop_reason="end_turn",
        usage=Usage(
            input_tokens=420,
            output_tokens=80,
            output_tokens_details=OutputTokensDetails(thinking_tokens=30),
        ),
        _request_id="req_test_0001",
    )


def test_repond_et_ignore_les_blocs_de_reflexion(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    client = FauxClient(faux_message())

    texte, prix, _ = comptoir_cli.repondre(client, "Combien coûte le sirop de gingembre ?", "claude-sonnet-5-5")

    assert texte == "Le sirop de gingembre coûte 2 500 FCFA le flacon."
    assert prix.reflexion == 30
    assert prix.dollars == (420 * 2 + 80 * 10) / 1_000_000


def test_envoie_le_prompt_systeme_et_la_question(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    client = FauxClient(faux_message())

    comptoir_cli.repondre(client, "Livrez-vous à Calavi ?", "claude-sonnet-5-5")

    requete = client.derniere_requete
    assert requete["model"] == "claude-sonnet-5-5"
    assert "Délices d'Awa" in requete["system"]
    assert requete["messages"] == [{"role": "user", "content": "Livrez-vous à Calavi ?"}]
    assert "temperature" not in requete  # refusé par les modèles actuels


def test_le_journal_ne_contient_ni_cle_ni_message(tmp_path, monkeypatch):
    journal = tmp_path / "appels.jsonl"
    monkeypatch.setattr("comptoir.config.JOURNAL", str(journal))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-cle-de-test")

    comptoir_cli.repondre(FauxClient(faux_message()), "Mon numéro est le 0197000000", "claude-sonnet-5-5")

    contenu = journal.read_text(encoding="utf-8")
    ligne = json.loads(contenu)
    assert ligne["requete"] == "req_test_0001"
    assert ligne["tokens_entree"] == 420
    assert "sk-ant" not in contenu
    assert "0197000000" not in contenu
