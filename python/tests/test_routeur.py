"""Le routeur, la trace et le vote, avec un faux client : aucun appel payant."""

import json
from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir import routeur
from comptoir.routeur import CATEGORIES, Decision, RoutageImpossible, classer, requete_routage, router, voter
from comptoir.trace import Trace


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


class FauxClient:
    def __init__(self, *reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []

    def create(self, **requete):
        self.requetes.append(requete)
        texte, arret = self.reponses.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=texte)], stop_reason=arret,
                               usage=Usage(input_tokens=1100, output_tokens=40), _request_id="req")


def json_categorie(categorie):
    return json.dumps({"categorie": categorie, "raison": "test"}), "end_turn"


def test_la_requete_ne_voit_que_le_message():
    requete = requete_routage("Vous livrez le dimanche ?", sans_reflexion=True)
    assert requete["model"] == "claude-haiku-5-5" and "tools" not in requete
    assert requete["thinking"] == {"type": "disabled"}
    assert requete["output_config"]["format"]["schema"]["properties"]["categorie"]["enum"] == list(CATEGORIES)
    assert requete["messages"][0]["content"].startswith("<message_client>")


def test_une_classification_et_son_cout():
    decision = classer(FauxClient(json_categorie("information")), "Vous livrez le dimanche ?")
    assert decision.categorie == "information" and decision.par == "claude-haiku-5-5"
    assert decision.cout == pytest.approx((1100 * 0.10 + 40 * 0.50) / 1e6)


def test_une_reponse_coupee_ou_inventee_est_un_routage_impossible():
    with pytest.raises(RoutageImpossible):
        classer(FauxClient(('{"categorie": "inf', "max_tokens")), "?")
    with pytest.raises(RoutageImpossible):
        classer(FauxClient(json_categorie("remboursement")), "?")
    # La casse d'une valeur d'enum n'est pas garantie : comparée sans elle.
    assert classer(FauxClient(json_categorie("Information")), "?").categorie == "information"
    # En production, le message part au Comptoir, qui sait tout traiter.
    decision = router(FauxClient(('{"categ', "max_tokens")), "?")
    assert decision.categorie == "autre" and decision.par == "repli"


def test_le_code_decide_ce_qu_il_sait():
    client = FauxClient()
    assert router(client, "OUI 4821").par == "code" and client.requetes == []  # aucun appel


def test_pendant_une_commande_la_suite_va_au_comptoir_sauf_une_reclamation():
    assert router(FauxClient(json_categorie("information")), "Et le dimanche ?", commande_en_cours=True).categorie == "commande"
    assert router(FauxClient(json_categorie("reclamation")), "C'est tiède !", commande_en_cours=True).categorie == "reclamation"


def test_le_vote_et_l_egalite():
    d = lambda c: Decision(c, "", "m")  # noqa: E731
    assert voter([d("commande"), d("information"), d("commande")]) == "commande"
    # À égalité, la catégorie la plus prioritaire : une réclamation ne se perd pas.
    assert voter([d("information"), d("reclamation")]) == "reclamation"


def test_le_vote_en_parallele(monkeypatch):
    client = FauxClient(json_categorie("commande"), json_categorie("information"), json_categorie("commande"))
    gagnant, decisions = routeur.router_par_vote(client, "?", votes=3)
    assert gagnant == "commande" and len(decisions) == 3


def test_la_trace_d_un_traitement(tmp_path):
    trace = Trace()
    with trace.etape("routage", "claude-haiku-5-5") as e:
        e.noter(0.0001, "information")
    with pytest.raises(ValueError):
        with trace.etape("documents", "claude-haiku-5-5"):
            raise ValueError("panne")
    assert [e.nom for e in trace.etapes] == ["routage", "documents"]
    assert trace.etapes[1].erreur == "ValueError" and trace.cout == pytest.approx(0.0001)
    assert "routage" in trace.afficher() and "ERREUR ValueError" in trace.afficher()
    lignes = [json.loads(l) for l in open(tmp_path / "appels.jsonl", encoding="utf-8")]
    assert [l["etape"] for l in lignes] == ["routage", "documents"] and lignes[0]["trace"] == trace.identifiant
    assert "message" not in lignes[0]  # jamais le texte du client


def test_les_messages_de_test_sont_bien_formes():
    from ch12.evaluer_routeur import charger_messages
    messages = charger_messages()
    assert len(messages) == 30 and len({m["id"] for m in messages}) == 30
    assert {m["attendu"] for m in messages} <= set(CATEGORIES)
