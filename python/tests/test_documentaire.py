"""L'assistant documentaire : requête, citations, renvois, notation ; et la base jointe au Comptoir."""

from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir import assistant, documentaire
from comptoir.connaissances import blocs_resultats, charger_base
from comptoir.couts import cout_maximal, duree_cache
from comptoir.documentaire import CasDocumentaire, ReponseDocumentaire, citations, noter_documentaire, texte_avec_renvois


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


def citation(source, texte="passage"):
    return SimpleNamespace(type="search_result_location", source=source, title=f"Titre {source}", cited_text=texte)


def message(*blocs):
    return SimpleNamespace(content=list(blocs), usage=Usage(input_tokens=40, output_tokens=60), _request_id="req",
                           stop_reason="end_turn")


def texte(t, *cites):
    return SimpleNamespace(type="text", text=t, citations=list(cites) or None)


def test_les_documents_d_abord_la_question_a_la_fin():
    base = charger_base()
    requete = documentaire.construire_requete("Vous livrez le dimanche ?", base[:3], cache=True)
    contenu = requete["messages"][0]["content"]
    assert [b["type"] for b in contenu] == ["search_result"] * 3 + ["text"]
    assert "<message_client>" in contenu[-1]["text"]
    assert "cache_control" in contenu[2] and "cache_control" not in contenu[-1]  # le point après la base, pas sur la question
    assert "cache_control" not in documentaire.construire_requete("?", base[:3], cache=False)["messages"][0]["content"][2]


def test_les_citations_sans_doublon():
    m = message(texte("Non. ", citation("kb://faq#dimanche", "Fermé.")), texte("Pas de livraison.", citation("kb://faq#dimanche", "Fermé.")),
                SimpleNamespace(type="thinking", thinking="..."))
    assert [c.source for c in citations(m)] == ["kb://faq#dimanche"]


def test_les_renvois_numerotes():
    m = message(texte("Nous livrons le lundi", citation("kb://a"), citation("kb://b")), texte(", pas le dimanche."),
                texte(" Paiement par MoMo", citation("kb://a")))
    assert texte_avec_renvois(m) == "Nous livrons le lundi[1][2], pas le dimanche. Paiement par MoMo[1]"


def reponse(t, *sources):
    return ReponseDocumentaire(t, [], None, 1.0, "req", list(sources))


def test_la_notation_d_une_question_dont_la_reponse_est_dans_les_documents():
    cas = CasDocumentaire("j", "?", sources=["kb://faq#jus"], un_parmi=["48"])
    assert noter_documentaire(cas, reponse("Buvez-le dans les 48 heures.", "kb://faq#jus")) == []
    assert "aucune des sources attendues n'est citée" in noter_documentaire(cas, reponse("Dans les 48 heures."))
    assert noter_documentaire(cas, reponse("Vite.", "kb://faq#jus")) == ["aucun de : 48"]


def test_la_notation_d_une_question_sans_reponse_dans_les_documents():
    cas = CasDocumentaire("bio", "?", absente=True)
    assert noter_documentaire(cas, reponse("Je ne trouve pas cette information dans nos documents ; je transmets à Awa.")) == []
    assert noter_documentaire(cas, reponse("Oui, ils sont bio.")) == [
        "ne dit pas que l'information manque", "ne propose pas de transmettre à Awa"]


def test_la_sante_renvoie_vers_un_professionnel():
    cas = CasDocumentaire("d", "?", sources=["kb://s"], un_parmi=["30 g"], orienter=True)
    assert noter_documentaire(cas, reponse("30 g ; demandez l'avis d'un professionnel de santé.", "kb://s")) == []
    assert noter_documentaire(cas, reponse("30 g.", "kb://s")) == ["ne renvoie pas vers un professionnel de santé"]


def test_repondre_rend_les_sources_et_le_cout():
    class Client:
        def __init__(self):
            self.messages = self

        def create(self, **requete):
            return message(texte("Le lundi", citation("kb://faq#dimanche")))

    r = documentaire.repondre(Client(), "?", charger_base()[:2])
    assert r.sources == ["kb://faq#dimanche"] and r.texte == "Le lundi[1]" and r.cout.entree == 40


# --- La base jointe au Comptoir (assistant.construire_requete) --------------------------------

def test_la_base_en_tete_du_premier_message_seulement():
    blocs = blocs_resultats(charger_base()[:2], cache=True)
    historique = [{"role": "user", "content": "<message_client>\nBonjour\n</message_client>"},
                  {"role": "assistant", "content": [{"type": "text", "text": "Bonjour !"}]}]
    requete = assistant.construire_requete("Et le dimanche ?", historique=historique, cache=True, connaissances=blocs)
    premier, dernier = requete["messages"][0], requete["messages"][-1]
    assert [b["type"] for b in premier["content"]] == ["search_result", "search_result", "text"]
    assert isinstance(dernier["content"], str)
    assert historique[0]["content"].startswith("<message_client>")  # l'historique n'est pas modifié
    assert requete["cache_control"] == {"type": "ephemeral"}  # cache automatique, en plus du point après la base
    # Deux tours de suite : le début de la requête est identique, octet pour octet.
    suivante = assistant.construire_requete("Merci", historique=historique, cache=True, connaissances=blocs)
    assert suivante["messages"][0] == premier


def test_sans_option_la_requete_ne_change_pas():
    assert "cache_control" not in assistant.construire_requete("?")
    assert isinstance(assistant.construire_requete("?")["messages"][0]["content"], str)


def test_le_cout_maximal_compte_l_ecriture_en_cache():
    # Sonnet 5.5 : 10 000 tokens écrits en cache à 2,50 $ (5 min) ou 4 $ (1 h), plus 1 000 de sortie à 10 $.
    assert cout_maximal("claude-sonnet-5-5", 10_000, 1_000, "5m") == pytest.approx(0.035)
    assert cout_maximal("claude-sonnet-5-5", 10_000, 1_000, "1h") == pytest.approx(0.05)
    assert cout_maximal("claude-sonnet-5-5", 10_000, 1_000) == pytest.approx(0.03)


def test_la_duree_de_cache_d_une_requete():
    assert duree_cache({"messages": [{"role": "user", "content": "?"}]}) is None
    assert duree_cache({"cache_control": {"type": "ephemeral"}}) == "5m"
    profonde = {"messages": [{"content": [{"type": "text", "text": "x", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]}],
                "cache_control": {"type": "ephemeral"}}
    assert duree_cache(profonde) == "1h"
