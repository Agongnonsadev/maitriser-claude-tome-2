"""La boucle d'outils et le Comptoir qui prend des commandes, avec un faux client : aucun appel payant."""

import json
import random
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, ThinkingBlock, ToolUseBlock, Usage

from comptoir.boucle import converser
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.commandes import ComptoirCommandes, rendre_recapitulatif
from comptoir.erreurs import REFUS, ErreurComptoir
from comptoir.outils import OUTILS, Outils


@pytest.fixture(autouse=True)
def reglages(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.JOURNAL", str(tmp_path / "appels.jsonl"))
    monkeypatch.setattr("comptoir.config.MODELE", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.QUOTA_CLIENT_JOUR", 1.0)


def reponse(*blocs, stop_reason="end_turn"):
    return SimpleNamespace(content=list(blocs), stop_reason=stop_reason, stop_details=None,
                           usage=Usage(input_tokens=1500, output_tokens=120), _request_id="req_test")


def outil(nom, entree, identifiant):
    return ToolUseBlock(type="tool_use", id=identifiant, name=nom, input=entree)


class FauxClient:
    """Rend les réponses prévues, une par appel, et garde chaque requête reçue."""

    def __init__(self, *reponses):
        self.messages = self
        self.reponses = list(reponses)
        self.requetes = []

    def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=1500)

    def create(self, **requete):
        self.requetes.append(json.loads(json.dumps(requete, default=str)))
        return self.reponses.pop(0)


REQUETE = {"model": "claude-sonnet-5-5", "max_tokens": 2000, "system": "s", "tools": OUTILS,
           "messages": [{"role": "user", "content": "Il vous reste de l'ananas et du gingembre ?"}]}


def test_deux_appels_en_parallele_rendent_leurs_resultats_dans_un_seul_message():
    client = FauxClient(
        reponse(ThinkingBlock(type="thinking", thinking="", signature="sig"),
                outil("stock_verifier", {"produits": ["Jus d'ananas"]}, "t1"),
                outil("stock_verifier", {"produits": ["Jus de gingembre"]}, "t2"), stop_reason="tool_use"),
        reponse(TextBlock(type="text", text="Oui : 12 ananas et 25 gingembres.")),
    )
    tour = converser(client, REQUETE, Outils(Boutique(), "c1"), Budget(), "c1")
    assert tour.texte == "Oui : 12 ananas et 25 gingembres."
    deuxieme = client.requetes[1]["messages"]
    assert deuxieme[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig"}  # intacte
    resultats = deuxieme[2]["content"]
    assert [r["tool_use_id"] for r in resultats] == ["t1", "t2"] and len(deuxieme) == 3
    assert [m["role"] for m in tour.nouveaux_messages] == ["assistant", "user", "assistant"]


def test_une_boucle_qui_tourne_en_rond_est_arretee():
    boucle = [reponse(outil("stock_verifier", {"produits": ["Jus d'ananas"]}, f"t{i}"), stop_reason="tool_use")
              for i in range(3)]
    with pytest.raises(ErreurComptoir) as erreur:
        converser(FauxClient(*boucle), REQUETE, Outils(Boutique(), "c1"), Budget(), "c1", tours_max=3)
    assert erreur.value.diagnostic.code == "boucle_trop_longue"


def comptoir(*reponses):
    boutique = Boutique(hasard=random.Random(7))
    return ComptoirCommandes(FauxClient(*reponses), boutique, Budget(), "c1"), boutique


PREPARER = {"lignes": [{"produit": "Jus de bissap", "quantite": 6}], "nom_client": "Mme Hounkpè", "quartier": "Akpakpa"}


def test_de_la_commande_a_la_confirmation():
    c, boutique = comptoir(
        reponse(outil("commande_preparer", PREPARER, "t1"), stop_reason="tool_use"),
        reponse(TextBlock(type="text", text="Voici votre récapitulatif ; vérifiez-le avant de confirmer.")),
    )
    premiere = c.repondre("6 bissap à Akpakpa, au nom de Mme Hounkpè")
    # Le total et le code affichés au client viennent du code, pas de Claude.
    code = boutique.recapitulatifs("c1")[0][0]
    assert "Total : 6 000 FCFA" in premiere.texte and f"OUI {code}" in premiere.texte
    assert boutique.commandes() == []  # rien n'est créé avant la confirmation

    confirmation = c.repondre(f"oui {code}")
    assert confirmation.tour is None  # la confirmation n'est pas passée par Claude
    assert "C-0001" in confirmation.texte and len(boutique.commandes()) == 1
    # Le séparateur des milliers ne doit pas avaler la virgule de la phrase (vu en mesure réelle).
    assert "est enregistrée, pour un total de 6 000 FCFA." in confirmation.texte
    assert len(c.client.requetes) == 2  # aucun appel de plus pour confirmer
    assert [m["role"] for m in c.historique] == ["user", "assistant", "user", "assistant", "user", "assistant"]


def test_un_faux_code_ne_cree_rien():
    c, boutique = comptoir(
        reponse(outil("commande_preparer", PREPARER, "t1"), stop_reason="tool_use"),
        reponse(TextBlock(type="text", text="Vérifiez le récapitulatif.")),
    )
    c.repondre("6 bissap")
    code = boutique.recapitulatifs("c1")[0][0]
    faux = "0000" if code != "0000" else "1111"
    assert "pas pu confirmer" in c.repondre(f"OUI {faux}").texte and boutique.commandes() == []


def test_une_reponse_refusee_n_entre_pas_dans_l_historique():
    refus = SimpleNamespace(content=[], stop_reason="refusal", stop_details=SimpleNamespace(category="general_harms"),
                            usage=Usage(input_tokens=1500, output_tokens=0), _request_id="req_test")
    c, _ = comptoir(refus)
    assert c.repondre("Une demande refusée").texte == REFUS and c.historique == []


def test_le_recapitulatif_officiel():
    recap = Boutique().preparer("c1", [{"produit": "Jus de bissap", "quantite": 2}], "M. Dossou", "Zogbo")
    texte = rendre_recapitulatif(recap)
    assert "2 × Jus de bissap : 2 000 FCFA" in texte and "Livraison (Zogbo" in texte and ": 500 FCFA" in texte
    assert texte.endswith(f"OUI {recap['code_de_confirmation']}")


def test_la_base_d_awa_est_envoyee_mais_jamais_enregistree():
    # Chapitre 11 : le Comptoir v3 joint la base au premier message de chaque requête, avec le cache.
    from comptoir.connaissances import charger_base

    client = FauxClient(reponse(TextBlock(type="text", text="Bonjour !")), reponse(TextBlock(type="text", text="Oui.")))
    c = ComptoirCommandes(client, Boutique(), Budget(), "c1", version_prompt="v3",
                          connaissances=charger_base()[:3], cache=True)
    c.repondre("Bonjour")
    c.repondre("Vous livrez le dimanche ?")
    premiere, deuxieme = client.requetes
    assert [b["type"] for b in premiere["messages"][0]["content"]][:3] == ["search_result"] * 3
    assert deuxieme["messages"][0] == premiere["messages"][0]  # même début de requête : lu dans le cache
    assert premiere["cache_control"] == {"type": "ephemeral"} and premiere["tools"] == OUTILS
    assert isinstance(c.historique[0]["content"], str)  # l'historique garde le message du client seul
