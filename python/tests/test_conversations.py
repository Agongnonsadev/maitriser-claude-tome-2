"""L'historique des conversations : en ajout seul, blocs gardés tels quels, clôture et purge."""

from datetime import datetime, timedelta, timezone

from anthropic.types import TextBlock, ThinkingBlock

from comptoir.conversations import Conversations

QUESTION = {"role": "user", "content": "<message_client>\nBonjour\n</message_client>"}
REPONSE = {
    "role": "assistant",
    "content": [
        ThinkingBlock(type="thinking", thinking="", signature="sig-1"),
        TextBlock(type="text", text="Bonjour ! Que puis-je pour vous ?"),
    ],
}


def test_les_blocs_de_claude_sont_gardes_tels_quels():
    conversations = Conversations()
    c = conversations.creer()
    conversations.ajouter_tour(c, [QUESTION, REPONSE], tokens=1200)
    historique = conversations.historique(c)
    assert historique[0] == QUESTION
    # La réflexion et sa signature sont là, et aucun champ vide (citations: null) n'a été ajouté.
    assert historique[1]["content"] == [
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "text", "text": "Bonjour ! Que puis-je pour vous ?"},
    ]


def test_l_historique_ne_fait_que_s_allonger():
    conversations = Conversations()
    c = conversations.creer()
    conversations.ajouter_tour(c, [QUESTION, REPONSE], tokens=1200)
    avant = conversations.historique(c)
    conversations.ajouter_tour(c, [QUESTION, {"role": "assistant", "content": "Avec plaisir."}], tokens=1500)
    apres = conversations.historique(c)
    # Le début est identique, au caractère près : le cache et la réflexion préservée restent valables.
    assert apres[: len(avant)] == avant
    assert [m["role"] for m in apres] == ["user", "assistant", "user", "assistant"]


def test_une_conversation_se_clot_apres_24_heures_ou_quand_elle_est_trop_longue(monkeypatch):
    monkeypatch.setattr("comptoir.config.EXPIRATION_H", 24)
    monkeypatch.setattr("comptoir.config.CONTEXTE_MAX", 40_000)
    conversations = Conversations()
    c = conversations.creer()
    conversations.ajouter_tour(c, [QUESTION, REPONSE], tokens=1200)
    maintenant = datetime.now(timezone.utc)
    assert conversations.motif_de_cloture(c, maintenant=maintenant) is None
    assert conversations.motif_de_cloture(c, maintenant=maintenant + timedelta(hours=25)) == "expiree"
    conversations.ajouter_tour(c, [QUESTION, REPONSE], tokens=41_000)
    assert conversations.motif_de_cloture(c, maintenant=maintenant) == "trop_longue"


def test_un_nouveau_prompt_clot_la_conversation():
    conversations = Conversations()
    c = conversations.creer(prompt="systeme-v1@aaaa1111")
    assert conversations.motif_de_cloture(c, prompt="systeme-v1@aaaa1111") is None
    # Awa a changé un prix : le prompt rendu change d'empreinte, la conversation est close.
    assert conversations.motif_de_cloture(c, prompt="systeme-v1@bbbb2222") == "nouveau_prompt"


def test_la_purge_supprime_les_vieilles_conversations_et_leurs_messages(monkeypatch):
    monkeypatch.setattr("comptoir.config.CONSERVATION_J", 30)
    conversations = Conversations()
    c = conversations.creer()
    conversations.ajouter_tour(c, [QUESTION, REPONSE], tokens=1200)
    assert conversations.purger(datetime.now(timezone.utc) + timedelta(days=29)) == 0
    assert conversations.purger(datetime.now(timezone.utc) + timedelta(days=31)) == 1
    assert not conversations.existe(c)
    assert conversations.historique(c) == []
