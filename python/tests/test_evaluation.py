"""La comparaison de deux versions de prompt, avec un faux client : aucun appel payant."""

from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from ch05 import evaluer_prompt
from comptoir.evaluation import Essai, ecrire_csv, evaluer, lire_csv, regressions, renoter, resumer
from comptoir.notation import Cas


class FauxClient:
    """La version « v1 » répond juste au cas prix ; « v0 » au cas remise seulement."""

    def __init__(self):
        self.messages = self

    def create(self, **requete):
        v1 = "message_client" in requete["messages"][-1]["content"]
        question = requete["messages"][-1]["content"]
        if "prix" in question:
            texte = "C'est 2 500 FCFA." if v1 else "C'est 3 000 FCFA."
        else:
            texte = "Je transmets à Awa." if not v1 else "D'accord, 10 % pour vous."
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=texte)],
            stop_reason="end_turn",
            usage=Usage(input_tokens=1000, output_tokens=100),
            _request_id="req_test",
        )


CAS = [
    Cas("prix", "Le prix du sirop ?", doit_contenir=["2 500"]),
    Cas("remise", "Une remise ?", doit_transmettre=True),
]


@pytest.fixture(autouse=True)
def journal_temporaire(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")


def test_les_deux_versions_et_la_regression():
    essais = evaluer(FauxClient(), CAS, evaluer_prompt.VARIANTES, repetitions=2, budget_max=10)
    assert len(essais) == 2 * 2 * 2
    resume = {l["variante"]: l for l in resumer(essais)}
    assert resume["v0"]["reussite"] == resume["v1"]["reussite"] == 0.5
    # Même score global, mais v1 casse un cas que v0 réussissait : c'est une régression.
    assert regressions(essais, "v0", "v1") == ["remise"]


def test_seul_le_prompt_change_entre_les_variantes():
    cas = CAS[0]
    v0, v1 = evaluer_prompt.requete_v0(cas), evaluer_prompt.requete_v1(cas)
    assert v0["model"] == v1["model"] and v0["max_tokens"] == v1["max_tokens"]
    assert v0.get("output_config") == v1.get("output_config")
    assert v0["system"] != v1["system"]


def test_le_budget_arrete_l_evaluation():
    # Un appel coûte 0,003 $ sur Sonnet 5.5 : avec 0,004 $, on s'arrête après le deuxième.
    essais = evaluer(FauxClient(), CAS, evaluer_prompt.VARIANTES, repetitions=3, budget_max=0.004)
    assert len(essais) == 2


def test_les_vingt_cas_du_chapitre():
    cas = evaluer_prompt.charger_cas()
    assert len(cas) == 20
    assert len({c.identifiant for c in cas}) == 20


def test_renoter_relit_les_reponses_sans_appel(tmp_path):
    cas = [Cas("court", "?", doit_contenir=["1 000"])]
    texte = "Bonjour ! Le jus est à 1 000 FCFA. Il se commande sur WhatsApp. Autre chose ?"
    ancien = Essai("v1", "court", 1, False, "plus de 3 phrases", "", texte, 1.2, 1700, 60, 0.004, "end_turn")
    coupe = Essai("v1", "court", 2, False, "", "", "1 000 FCFA", 1.0, 1700, 2000, 0.02, "max_tokens")
    ecrire_csv([ancien, coupe], tmp_path / "essais.csv")
    relus = lire_csv(tmp_path / "essais.csv")
    assert relus == [ancien, coupe]  # les types reviennent intacts : entiers, réels, booléens
    renotes = renoter(relus, cas)
    assert renotes[0].reussi and renotes[0].raisons == ""  # « Bonjour ! » ne compte plus comme une phrase
    assert not renotes[1].reussi and "max_tokens" in renotes[1].raisons  # la règle de l'arrêt reste
    assert renotes[0].cout_dollars == 0.004  # le coût est celui de l'appel d'origine : rien n'est rappelé
