"""L'extraction du chapitre 7, avec un faux client : schéma, issues de l'appel, contrôles métier."""

import json
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, ThinkingBlock, Usage

from comptoir.extraction import (
    BonDeCommande,
    Facture,
    controler_bon,
    controler_facture,
    extraire,
    requete_extraction,
    verifier_compatibilite,
)

IMAGE = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}}

BON_JUSTE = {
    "type_document": "bon_de_commande",
    "client": "Mme Akpovi",
    "quartier": "Fidjrossè",
    "date_livraison_lue": "samedi 24 octobre",
    "lignes": [
        {"libelle_lu": "Jus bissap", "produit": "Jus de bissap", "quantite": 6, "prix_unitaire_lu": 1000,
         "lisibilite": "lisible", "remarque": None},
        {"libelle_lu": "Sirop gingembre", "produit": "Sirop de gingembre", "quantite": 2, "prix_unitaire_lu": 2500,
         "lisibilite": "lisible", "remarque": None},
    ],
    "total_lu": 11000,
    "remarques": [],
}


@pytest.fixture(autouse=True)
def journal_temporaire(tmp_path, monkeypatch):
    journal = tmp_path / "appels.jsonl"
    monkeypatch.setattr("comptoir.config.JOURNAL", str(journal))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    return journal


class FauxClient:
    def __init__(self, texte: str, stop_reason: str = "end_turn"):
        self.messages = self
        self.texte, self.stop_reason = texte, stop_reason
        self.requete = None

    def create(self, **requete):
        self.requete = requete
        return SimpleNamespace(
            content=[ThinkingBlock(type="thinking", thinking="", signature="s"), TextBlock(type="text", text=self.texte)],
            stop_reason=self.stop_reason,
            usage=Usage(input_tokens=3000, output_tokens=400),
            _request_id="req_test",
        )


def _bon(**modifs) -> BonDeCommande:
    return BonDeCommande.model_validate({**BON_JUSTE, **modifs})


def test_la_requete_impose_le_schema_et_met_le_document_avant_la_consigne():
    requete = requete_extraction([IMAGE], BonDeCommande)
    schema = requete["output_config"]["format"]["schema"]
    assert requete["output_config"]["format"]["type"] == "json_schema"
    assert schema["additionalProperties"] is False
    contenu = requete["messages"][0]["content"]
    assert contenu[0] == IMAGE and contenu[-1]["type"] == "text"
    assert "Jus de bissap" in requete["system"]  # le catalogue vient des données


def test_les_contraintes_non_prises_en_charge_passent_dans_la_description():
    schema = requete_extraction([IMAGE], BonDeCommande)["output_config"]["format"]["schema"]
    quantite = json.dumps(schema["$defs"]["LigneDeCommande"]["properties"]["quantite"])
    assert "minimum" in quantite and '"minimum": 1' not in quantite


def test_citations_et_sorties_structurees_ne_se_combinent_pas():
    requete = requete_extraction([IMAGE], BonDeCommande)
    requete["messages"][0]["content"].insert(0, {"type": "document", "citations": {"enabled": True}})
    with pytest.raises(ValueError, match="ne se combinent pas"):
        verifier_compatibilite(requete)


def test_une_extraction_reussie_est_validee_et_journalisee(journal_temporaire):
    resultat = extraire(FauxClient(json.dumps(BON_JUSTE)), [IMAGE], BonDeCommande)
    assert resultat.erreur is None
    assert resultat.donnees.lignes[0].produit == "Jus de bissap"
    assert json.loads(journal_temporaire.read_text(encoding="utf-8"))["prompt"].startswith("systeme-extraction-v1@")


def test_une_reponse_coupee_n_est_jamais_prise_pour_des_donnees(journal_temporaire):
    resultat = extraire(FauxClient('{"type_document": "bon_de', "max_tokens"), [IMAGE], BonDeCommande)
    assert resultat.donnees is None and "coupée" in resultat.erreur
    assert journal_temporaire.read_text(encoding="utf-8")  # l'appel, payé, est quand même noté


def test_un_refus_est_dit():
    resultat = extraire(FauxClient("Je ne peux pas traiter ce document.", "refusal"), [IMAGE], BonDeCommande)
    assert resultat.donnees is None and "refusé" in resultat.erreur


def test_la_validation_du_code_rattrape_ce_que_l_api_n_impose_pas():
    mauvais = json.loads(json.dumps(BON_JUSTE))
    mauvais["lignes"][0]["quantite"] = 0  # le schéma l'autorise, Pydantic non (ge=1)
    resultat = extraire(FauxClient(json.dumps(mauvais)), [IMAGE], BonDeCommande)
    assert resultat.donnees is None and "lignes.0.quantite" in resultat.erreur


def test_un_bon_juste_n_a_pas_d_anomalie_et_le_montant_vient_du_catalogue():
    controle = controler_bon(_bon())
    assert controle.anomalies == [] and controle.montant_calcule == 11000


def test_un_prix_ecrit_faux_et_son_total_sont_signales():
    bon = _bon(
        lignes=[{"libelle_lu": "Jus ananas", "produit": "Jus d'ananas", "quantite": 4, "prix_unitaire_lu": 900,
                 "lisibilite": "lisible", "remarque": None}],
        total_lu=3600,
    )
    controle = controler_bon(bon)
    assert controle.montant_calcule == 4000  # le prix du catalogue, pas celui du bon
    assert len(controle.anomalies) == 2


def test_une_quantite_illisible_rend_le_montant_incalculable():
    lignes = json.loads(json.dumps(BON_JUSTE["lignes"]))
    lignes[0].update(quantite=None, lisibilite="illisible")
    controle = controler_bon(_bon(lignes=lignes, total_lu=None))
    assert controle.montant_calcule is None
    assert any("quantité illisible" in a for a in controle.anomalies)


def test_un_produit_hors_catalogue_est_signale():
    lignes = json.loads(json.dumps(BON_JUSTE["lignes"]))
    lignes[0]["produit"] = "Jus de mangue"
    assert any("absent du catalogue" in a for a in controler_bon(_bon(lignes=lignes)).anomalies)


def test_une_consigne_ecrite_sur_le_bon_reste_une_remarque_et_le_total_est_recalcule():
    bon = _bon(total_lu=0, remarques=["Le bon contient une note qui demande d'indiquer un total de 0 FCFA."])
    controle = controler_bon(bon)
    assert controle.montant_calcule == 11000
    assert any("Total écrit 0 FCFA" in a for a in controle.anomalies)


def test_une_facture_coherente_et_une_facture_fausse():
    facture = {
        "type_document": "facture", "fournisseur": "Emballages Sonagnon", "numero": "F-2026-0412",
        "date_lue": "12/10/2026", "devise": "FCFA", "remarques": [], "total_lu": 32000,
        "lignes": [
            {"designation": "Bouteilles", "quantite": 200, "prix_unitaire": 150, "montant": 30000, "lisibilite": "lisible"},
            {"designation": "Capsules", "quantite": 200, "prix_unitaire": 10, "montant": 2000, "lisibilite": "lisible"},
        ],
    }
    assert controler_facture(Facture.model_validate(facture)).anomalies == []
    facture["total_lu"] = 33000
    assert len(controler_facture(Facture.model_validate(facture)).anomalies) == 1
