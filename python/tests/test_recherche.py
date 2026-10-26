"""La recherche : BM25, embeddings, fusion des rangs, reclassement et contexte par Claude, sans appel payant."""

import io
import json
from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir import recherche
from comptoir.connaissances import Morceau, charger_base
from comptoir.recherche import (IndexBM25, IndexVecteurs, contextualiser, fusionner, mots, plongeur_voyage, rappel,
                                reclasser, requete_contexte, requete_reclassement)


@pytest.fixture(autouse=True)
def journal(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))


def morceau(identifiant, texte):
    return Morceau(identifiant, "doc", identifiant, texte)


def test_les_mots_d_une_question():
    assert mots("Êtes-vous ouverts le dimanche ?") == ["ete", "ouvert", "dimanche"]
    # « prix » devient « pri », au singulier comme au pluriel : seule compte la même forme des deux côtés.
    assert mots("Les bouteilles et le prix") == mots("la bouteille, les prix") == ["bouteille", "pri"]


def test_bm25_trouve_le_mot_exact():
    resultats = [m.identifiant for m, _ in IndexBM25(charger_base()).chercher("Vous livrez à Godomey ?", k=3)]
    # « Godomey » n'apparaît que dans la page des zones ; « livrez », mot pour mot, dans le titre d'une
    # question de la FAQ, plus courte : elle passe devant. Le bon morceau est dans les trois premiers.
    assert resultats[:2] == ["kb://faq#livrez-vous-hors-de-cotonou", "kb://zones-de-livraison#hors-de-cotonou"]


def test_bm25_un_mot_rare_compte_plus_qu_un_mot_courant():
    index = IndexBM25([morceau("a", "jus jus jus"), morceau("b", "jus corossol"), morceau("c", "jus ananas")])
    assert index.chercher("jus corossol", k=1)[0][0].identifiant == "b"
    assert index.chercher("le la les") == []  # que des mots vides : aucun résultat, plutôt qu'un hasard


def test_les_embeddings_cherchent_par_le_sens():
    vecteurs = {"livraison": [1.0, 0.0], "paiement": [0.0, 1.0], "on livre quand": [0.9, 0.1]}
    appels = []

    def plonger(textes, type_entree):
        appels.append(type_entree)
        return [vecteurs[t.split()[-1]] if t.split()[-1] in vecteurs else vecteurs[t] for t in textes]

    index = IndexVecteurs([morceau("l", "livraison"), morceau("p", "paiement")], plonger)
    assert index.chercher("on livre quand", k=1)[0][0].identifiant == "l"
    assert appels == ["document", "query"]  # Voyage distingue les documents des questions


def test_le_plongeur_voyage_appelle_l_api_de_mongodb(monkeypatch):
    vu = {}

    def faux_urlopen(requete, timeout):
        vu["url"], vu["entetes"], vu["corps"] = requete.full_url, dict(requete.headers), json.loads(requete.data)
        reponse = {"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]}
        return io.BytesIO(json.dumps(reponse).encode())

    monkeypatch.setattr(recherche.urllib.request, "urlopen", faux_urlopen)
    vecteurs = plongeur_voyage(cle="cle-de-test")(["a", "b"], "document")
    assert vecteurs == [[1.0, 0.0], [0.0, 1.0]]  # remis dans l'ordre des textes
    assert vu["url"] == "https://ai.mongodb.com/v1/embeddings"
    assert vu["entetes"]["Authorization"] == "Bearer cle-de-test"
    assert vu["corps"] == {"input": ["a", "b"], "model": "voyage-4", "input_type": "document"}


def test_la_fusion_des_rangs():
    a, b, c = morceau("a", ""), morceau("b", ""), morceau("c", "")
    lexical = [(a, 12.0), (b, 3.0)]
    semantique = [(b, 0.91), (c, 0.90)]
    fusion = fusionner(lexical, semantique, garder=3)
    assert [m.identifiant for m, _ in fusion] == ["b", "a", "c"]  # b, bien placé deux fois, passe devant


def test_le_rappel():
    assert rappel([(morceau("a", ""), 1.0)], ["x", "a"]) and not rappel([], ["a"])


class FauxClient:
    def __init__(self, *textes):
        self.messages, self.textes, self.requetes = self, list(textes), []

    def create(self, **requete):
        self.requetes.append(requete)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.textes.pop(0))],
                               usage=Usage(input_tokens=100, output_tokens=20), _request_id="req")


def test_le_reclassement_ecarte_les_identifiants_inconnus():
    candidats = [morceau("a", "un"), morceau("b", "deux"), morceau("c", "trois")]
    client = FauxClient(json.dumps({"pertinents": ["c", "inconnu", "a", "c"]}))
    choisis, prix = reclasser(client, "?", candidats, garder=3)
    assert [m.identifiant for m in choisis] == ["c", "a"]
    assert prix == pytest.approx((100 * 0.10 + 20 * 0.50) / 1e6)  # Haiku 5.5
    assert client.requetes[0]["output_config"]["format"]["type"] == "json_schema"
    assert reclasser(FauxClient(), "?", []) == ([], 0.0)


def test_la_requete_de_reclassement_ne_demande_pas_de_reponse():
    requete = requete_reclassement("Vous livrez ?", [morceau("a", "texte")], 3)
    assert requete["model"] == "claude-haiku-5-5"
    assert '<passage id="a">' in requete["messages"][0]["content"]


def test_le_document_a_contextualiser_est_mis_en_cache():
    requete = requete_contexte("Le document entier.", morceau("a", "Un passage."))
    document, consigne = requete["messages"][0]["content"]
    assert document["cache_control"] == {"type": "ephemeral"} and "Le document entier." in document["text"]
    assert "cache_control" not in consigne and "Un passage." in consigne["text"]


def test_contextualiser_un_appel_par_morceau():
    client = FauxClient(" Situe a. ", "Situe b.")
    contextes, usages = contextualiser(client, "doc", [morceau("a", "x"), morceau("b", "y")])
    assert contextes == {"a": "Situe a.", "b": "Situe b."} and len(usages) == 2
    # Le même document, à l'identique, dans chaque requête : c'est ce qui permet la lecture du cache.
    assert client.requetes[0]["messages"][0]["content"][0] == client.requetes[1]["messages"][0]["content"][0]
