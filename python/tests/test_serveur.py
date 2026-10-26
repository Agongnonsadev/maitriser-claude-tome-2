"""Les outils serveur : définitions, reprise après une pause, sources, erreurs, fichiers, coût."""

from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir.couts import cout
from comptoir.serveur import (appeler, erreurs_outils, fichiers_produits, lecture_web, recherche_web, sources,
                              texte)


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


def test_les_definitions():
    assert recherche_web()["type"] == "web_search_20250305"
    assert recherche_web(filtrage_dynamique=True)["type"] == "web_search_20260209"
    assert recherche_web(domaines=["gouv.bj"])["allowed_domains"] == ["gouv.bj"]
    assert recherche_web()["user_location"]["city"] == "Cotonou"
    assert "country" not in recherche_web()["user_location"]  # « BJ » refusé par l'API (400)
    lecture = lecture_web(max_content_tokens=2000)
    assert lecture["type"] == "web_fetch_20250910" and lecture["max_content_tokens"] == 2000


def test_une_recherche_coute_un_centime_en_plus_des_tokens():
    usage = Usage(input_tokens=10_000, output_tokens=500,
                  server_tool_use={"web_search_requests": 2, "web_fetch_requests": 0})
    prix = cout("claude-sonnet-5-5", usage)
    assert prix.recherches == 2
    assert prix.dollars == pytest.approx(10_000 * 2 / 1e6 + 500 * 10 / 1e6 + 2 * 0.01)


def message(stop_reason, *blocs, recherches=0):
    return SimpleNamespace(content=list(blocs), stop_reason=stop_reason, _request_id="req",
                           usage=Usage(input_tokens=1000, output_tokens=100,
                                       server_tool_use={"web_search_requests": recherches, "web_fetch_requests": 0}))


class FauxClient:
    def __init__(self, *reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []

    def create(self, **requete):
        self.requetes.append(requete)
        return self.reponses.pop(0)


def test_une_pause_se_reprend_en_renvoyant_la_reponse_telle_quelle():
    pause = message("pause_turn", SimpleNamespace(type="server_tool_use", id="srv1"), recherches=1)
    fin = message("end_turn", SimpleNamespace(type="text", text="Voici.", citations=None), recherches=1)
    client = FauxClient(pause, fin)
    requete = {"model": "claude-sonnet-5-5", "max_tokens": 100, "tools": [recherche_web()],
               "messages": [{"role": "user", "content": "?"}]}
    resultat = appeler(client, requete)
    assert resultat.texte == "Voici." and resultat.reprises == 1 and resultat.recherches == 2
    deuxieme = client.requetes[1]
    assert deuxieme["messages"][-1] == {"role": "assistant", "content": pause.content}
    assert deuxieme["tools"] == requete["tools"]  # les mêmes outils, sinon l'API refuse la reprise


def test_les_sources_le_texte_et_les_erreurs():
    citation = SimpleNamespace(type="web_search_result_location", url="https://exemple.bj/feries", title="Jours fériés")
    reponse = message(
        "end_turn",
        SimpleNamespace(type="text", text="Le 1er novembre ", citations=None),
        SimpleNamespace(type="text", text="est férié.", citations=[citation, citation]),
        SimpleNamespace(type="web_search_tool_result",
                        content=SimpleNamespace(type="web_search_tool_result_error", error_code="max_uses_exceeded")),
    )
    assert texte(reponse) == "Le 1er novembre est férié."
    assert sources(reponse) == [{"source": "https://exemple.bj/feries", "titre": "Jours fériés"}]
    assert erreurs_outils(reponse) == ["web_search_tool_result : max_uses_exceeded"]


def test_les_fichiers_produits_par_le_code():
    sortie = SimpleNamespace(type="bash_code_execution_output", file_id="file_123")
    bloc = SimpleNamespace(type="bash_code_execution_tool_result",
                           content=SimpleNamespace(type="bash_code_execution_result", content=[sortie]))
    assert fichiers_produits(message("end_turn", bloc)) == ["file_123"]
