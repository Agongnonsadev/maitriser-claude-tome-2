"""La chaîne des réclamations et le Comptoir aiguillé, avec de faux clients : aucun appel payant."""

import json
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, Usage

from comptoir import reclamations
from comptoir.aiguillage import ComptoirAiguille
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.connaissances import charger_base
from comptoir.reclamations import PROMESSES, REPLI, manques, traiter
from comptoir.trace import Trace


@pytest.fixture(autouse=True)
def reglages(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 1.0)


def texte(t, arret="end_turn"):
    return SimpleNamespace(content=[TextBlock(type="text", text=t)], stop_reason=arret, stop_details=None,
                           usage=Usage(input_tokens=500, output_tokens=60), _request_id="req")


class FauxClient:
    def __init__(self, *reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []

    def create(self, **requete):
        self.requetes.append(requete)
        return self.reponses.pop(0)

    def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=500)


FAITS = {"probleme": "tiede", "produit": "bissap", "quand": "hier", "demande_du_client": None, "urgence": False,
         "resume": "Trois bouteilles tièdes."}
BIEN = {"s_excuse": True, "annonce_la_transmission_a_awa": True, "promet_quelque_chose": False,
        "donne_un_conseil_medical": False, "critique": "rien"}


def test_le_point_de_controle_demande_ce_qui_manque():
    assert manques(FAITS) == []
    assert manques({**FAITS, "produit": None, "quand": None}) == ["le produit concerné", "le jour de la livraison"]
    assert manques({**FAITS, "probleme": "retard", "produit": None}) == []  # un retard n'a pas de produit


def test_le_produit_vient_du_catalogue():
    choix = reclamations.SCHEMA_FAITS["properties"]["produit"]["anyOf"]
    assert choix[0]["enum"] == reclamations.PRODUITS and "Jus de bissap" in choix[0]["enum"]
    assert choix[1] == {"type": "null"}  # « bouteilles » n'est pas un produit : null, et le code le demande


def test_l_evaluateur_ecrit_sa_critique_avant_de_cocher():
    assert list(reclamations.SCHEMA_EVALUATION["properties"])[0] == "critique"
    assert reclamations.SCHEMA_EVALUATION["required"][0] == "critique"


def test_la_casse_d_un_enum_est_corrigee():
    faits = reclamations.normaliser({**FAITS, "probleme": "Sante", "produit": "Jus De Gingembre"})
    assert faits["probleme"] == "sante" and faits["produit"] == "Jus de gingembre"


def test_une_redaction_coupee_est_reecrite_sans_payer_l_evaluateur():
    client = FauxClient(texte(json.dumps(FAITS)), texte("Désolés. Votre réclamation est transmise à A", "max_tokens"),
                        texte("Désolés. Transmis à Awa, réponse sous 24 heures."), texte(json.dumps(BIEN)))
    resultat = traiter(client, "Les bouteilles étaient tièdes.", Boutique(), "c1")
    assert resultat.tentatives == 2 and not resultat.repli and len(client.requetes) == 4
    assert resultat.critiques == ["réponse arrêtée par max_tokens"]
    assert "<critique>" not in client.requetes[2]["messages"][0]["content"]  # incomplet, pas fautif
    assert resultat.reponse == "Désolés. Transmis à Awa, réponse sous 24 heures."


def test_une_extraction_illisible_n_arrete_pas_la_chaine():
    client = FauxClient(texte('{"probleme": "ti', "max_tokens"), texte("Désolés. Transmis à Awa, sous 24 heures."),
                        texte(json.dumps(BIEN)))
    boutique = Boutique()
    resultat = traiter(client, "Les bouteilles étaient tièdes.", boutique, "c1")
    assert resultat.manques == ["le produit concerné", "le jour de la livraison"]
    assert boutique.demandes()[0][3].startswith("Extraction impossible")  # Awa reçoit quand même la réclamation


def test_le_motif_des_promesses():
    assert PROMESSES.search("Nous vous rembourserons") and PROMESSES.search("un avoir de 1 000 FCFA")
    assert not PROMESSES.search("après avoir bu votre jus")  # le verbe, pas l'avoir : faux positif corrigé


def test_une_reclamation_conforme_du_premier_coup():
    client = FauxClient(texte(json.dumps(FAITS)), texte("Désolés. Transmis à Awa, réponse sous 24 heures."),
                        texte(json.dumps(BIEN)))
    boutique, trace = Boutique(), Trace()
    resultat = traiter(client, "Les bouteilles étaient tièdes.", boutique, "c1", trace)
    assert resultat.tentatives == 1 and not resultat.repli and resultat.versions == [resultat.reponse]
    assert [e.nom for e in trace.etapes] == ["extraction", "verification", "transmission", "redaction", "evaluation"]
    assert boutique.demandes()[0][2] == "reclamation"  # toujours transmise à Awa


def test_une_promesse_est_refusee_puis_le_texte_de_repli():
    promesse = "Désolés, nous vous rembourserons. Transmis à Awa."
    client = FauxClient(texte(json.dumps({**FAITS, "urgence": True})), texte(promesse), texte(json.dumps(BIEN)),
                        texte(promesse), texte(json.dumps(BIEN)))
    boutique = Boutique()
    resultat = traiter(client, "Mon fils a été malade.", boutique, "c1")
    assert resultat.repli and resultat.reponse.startswith(REPLI) and "professionnel de santé" in resultat.reponse
    assert len(resultat.critiques) == 2 and "rembours" in resultat.critiques[0]
    assert "<critique>" in client.requetes[3]["messages"][0]["content"]  # la 2e rédaction reçoit la critique
    assert boutique.demandes()[0][2] == "reclamation-urgente"


def test_le_comptoir_aiguille_une_question_vers_les_documents():
    client = FauxClient(texte(json.dumps({"categorie": "information", "raison": "zones"})),
                        texte("Nous ne livrons pas à Godomey."))
    c = ComptoirAiguille(client, Boutique(), Budget(), "c1", charger_base()[:3])
    r = c.repondre("Vous livrez à Godomey ?")
    assert r.categorie == "information" and r.texte == "Nous ne livrons pas à Godomey."
    documents = client.requetes[1]
    assert documents["model"] == "claude-haiku-5-5" and documents["thinking"] == {"type": "disabled"}
    assert all(b.get("citations") == {"enabled": False} for b in documents["messages"][0]["content"][:3])
    assert [e.nom for e in r.trace.etapes] == ["routage", "documents"]
    assert c.comptoir.historique[-1]["content"][0]["text"] == "Nous ne livrons pas à Godomey."  # le fil est gardé


def test_une_reponse_coupee_part_au_comptoir():
    client = FauxClient(texte(json.dumps({"categorie": "information", "raison": "?"})), texte("", arret="max_tokens"),
                        texte("Le Comptoir répond."))
    r = ComptoirAiguille(client, Boutique(), Budget(), "c1", charger_base()[:3]).repondre("Une question ?")
    assert r.categorie == "information, repli" and r.texte == "Le Comptoir répond."
    assert [e.nom for e in r.trace.etapes] == ["routage", "documents", "comptoir"]
    # Le Comptoir aiguillé tourne sur config.MODELE_COMPTOIR, Claude Haiku 5.5, depuis le chapitre 17.
    assert client.requetes[2]["model"] == "claude-haiku-5-5" and "tools" in client.requetes[2]


class ClientEnPanne(FauxClient):
    """Répond à l'extraction, puis tombe en panne."""

    def create(self, **requete):
        if self.requetes:
            raise ConnectionError("panne du réseau")
        return super().create(**requete)


def test_une_panne_pendant_la_redaction_ne_perd_pas_la_reclamation():
    boutique = Boutique()
    with pytest.raises(ConnectionError):
        traiter(ClientEnPanne(texte(json.dumps(FAITS))), "Les bouteilles étaient tièdes.", boutique, "c1")
    assert len(boutique.demandes()) == 1  # transmise avant la rédaction
