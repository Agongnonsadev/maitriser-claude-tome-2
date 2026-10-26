"""La validation humaine du chapitre 7 : rien n'est enregistré sans un « o » tapé par Yao."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, Usage

from ch07 import valider_commandes

DOCUMENTS = Path(__file__).parent.parent / "ch07" / "documents"

BON = {
    "type_document": "bon_de_commande", "client": "Mme Akpovi", "quartier": "Fidjrossè",
    "date_livraison_lue": "samedi 24 octobre", "total_lu": 6000, "remarques": [],
    "lignes": [{"libelle_lu": "Jus bissap", "produit": "Jus de bissap", "quantite": 6, "prix_unitaire_lu": 1000,
                "lisibilite": "lisible", "remarque": None}],
}


class FauxClient:
    def __init__(self, bon):
        self.messages = self
        self.bon = bon

    def create(self, **requete):
        return SimpleNamespace(
            content=[TextBlock(type="text", text=json.dumps(self.bon))],
            stop_reason="end_turn",
            usage=Usage(input_tokens=3000, output_tokens=300),
            _request_id="req_test",
        )


@pytest.fixture(autouse=True)
def fichiers_temporaires(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")
    registre = tmp_path / "commandes.jsonl"
    monkeypatch.setattr(valider_commandes, "REGISTRE", registre)
    return registre


def test_sans_accord_rien_n_est_enregistre(fichiers_temporaires):
    commande = valider_commandes.valider(FauxClient(BON), DOCUMENTS / "bon-01.jpg", demander=lambda _: "")
    assert commande is None and not fichiers_temporaires.exists()


def test_avec_accord_la_commande_et_son_montant_calcule_sont_enregistres(fichiers_temporaires):
    commande = valider_commandes.valider(FauxClient(BON), DOCUMENTS / "bon-01.jpg", demander=lambda _: "o")
    assert commande["montant_fcfa"] == 6000 and commande["validee_par_un_humain"]
    assert json.loads(fichiers_temporaires.read_text(encoding="utf-8"))["document"] == "bon-01.jpg"


def test_un_montant_incalculable_n_est_meme_pas_propose(fichiers_temporaires):
    illisible = json.loads(json.dumps(BON))
    illisible["lignes"][0].update(quantite=None, lisibilite="illisible")
    question_posee = []
    commande = valider_commandes.valider(
        FauxClient(illisible), DOCUMENTS / "bon-03.jpg", demander=lambda q: question_posee.append(q) or "o"
    )
    assert commande is None and question_posee == [] and not fichiers_temporaires.exists()
