"""Les définitions des outils, et leur exécution sans exception vers la boucle."""

import json
import re
from types import SimpleNamespace

from comptoir.boutique import Boutique
from comptoir.outils import OUTILS, Execution, Outils


def _objets(schema):
    """Tous les objets d'un schéma, imbriqués compris."""
    if schema.get("type") == "object":
        yield schema
        for propriete in schema["properties"].values():
            yield from _objets(propriete)
    if schema.get("type") == "array":
        yield from _objets(schema["items"])


def test_des_definitions_strictes_et_bien_decrites():
    for outil in OUTILS:
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", outil["name"])
        assert outil["strict"] is True
        # Anthropic conseille au moins trois ou quatre phrases par description.
        assert outil["description"].count(". ") + 1 >= 3, outil["name"]
        for objet in _objets(outil["input_schema"]):
            assert objet["additionalProperties"] is False
            assert set(objet["required"]) == set(objet["properties"])


def appel(nom, entree, identifiant="toolu_1"):
    return SimpleNamespace(type="tool_use", id=identifiant, name=nom, input=entree)


def test_le_stock_de_plusieurs_produits():
    outils = Outils(Boutique(), "c1")
    resultat = outils.executer(appel("stock_verifier", {"produits": ["Jus d'ananas", "Jus de mangue"]}), Execution())
    assert json.loads(resultat["content"]) == {"Jus d'ananas": 12, "Jus de mangue": "absent du catalogue"}
    assert "is_error" not in resultat


def test_une_erreur_de_la_boutique_devient_un_resultat_en_erreur():
    outils = Outils(Boutique(), "c1")
    entree = {"lignes": [{"produit": "Jus de mangue", "quantite": 3}], "nom_client": "A", "quartier": "B"}
    resultat = outils.executer(appel("commande_preparer", entree), Execution())
    assert resultat["is_error"] is True and "absent du catalogue" in resultat["content"]


def test_claude_ne_recoit_pas_le_code_de_confirmation():
    outils, execution = Outils(Boutique(), "c1"), Execution()
    entree = {"lignes": [{"produit": "Jus de bissap", "quantite": 6}], "nom_client": "A", "quartier": "B"}
    resultat = json.loads(outils.executer(appel("commande_preparer", entree), execution)["content"])
    assert "code_de_confirmation" not in resultat and resultat["total_fcfa"] == 6000
    assert execution.recapitulatif["code_de_confirmation"]  # le code, lui, le garde pour l'afficher


def test_un_outil_inconnu():
    resultat = Outils(Boutique(), "c1").executer(appel("commande_creer", {}), Execution())
    assert resultat["is_error"] and "inconnu" in resultat["content"]


def test_la_transmission_a_awa():
    boutique = Boutique()
    execution = Execution()
    Outils(boutique, "c1").executer(appel("transmettre_a_awa", {"motif": "remise", "resume": "20 % pour 10 bouteilles"}), execution)
    assert boutique.demandes()[0][1:3] == ("c1", "remise") and execution.transmissions
