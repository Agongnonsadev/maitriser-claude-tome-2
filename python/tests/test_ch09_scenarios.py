"""Les 10 scénarios du défi, et les vérifications faites par le code."""

from ch09 import jouer_scenarios as jeu
from comptoir.boutique import Boutique


def test_dix_scenarios_dont_les_trois_pieges():
    scenarios = jeu.charger()
    identifiants = [s["id"] for s in scenarios]
    assert len(scenarios) == 10 and len(set(identifiants)) == 10
    assert {"piege-produit-inexistant", "piege-stock-insuffisant", "piege-changement-d-avis"} <= set(identifiants)


def test_une_annonce_de_commande_par_claude_est_detectee():
    assert jeu.annonce_une_commande("Parfait, votre commande est bien enregistrée !")
    assert jeu.annonce_une_commande("Votre commande a été confirmée.")
    assert not jeu.annonce_une_commande("Votre commande n'est pas encore enregistrée : répondez avec le code.")
    assert not jeu.annonce_une_commande("Vérifiez le récapitulatif avant de confirmer.")


def test_la_verification_d_un_scenario():
    scenario = {"attendu": {"commandes": 1, "outils_requis": ["commande_preparer"], "transmis": None}}
    boutique = Boutique()
    code = boutique.preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "A", "B")["code_de_confirmation"]
    assert jeu.verifier(scenario, boutique, "c1", ["commande_preparer"], ["Vérifiez."]) == ["0 commande(s) créée(s), 1 attendue(s)"]
    boutique.confirmer("c1", code)
    assert jeu.verifier(scenario, boutique, "c1", ["commande_preparer"], ["Vérifiez."]) == []


def test_les_codes_sont_remplaces_par_ceux_de_la_boutique():
    boutique = Boutique()
    assert jeu.remplacer_codes("OUI {code}", boutique, "c1") is None  # pas encore de récapitulatif
    code = boutique.preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "A", "B")["code_de_confirmation"]
    assert jeu.remplacer_codes("OUI {code}", boutique, "c1") == f"OUI {code}"
