"""L'atelier d'Awa et les critères du chapitre 13 : du code seul, aucun appel."""

import json

import pytest

from ch13.criteres import criteres
from comptoir.atelier import A_VALIDER, REFUSE, Atelier, BonInvalide, rendre_bon

BOUTEILLES = {"article": "Bouteille verre 50 cl", "fournisseur": "Emballages Akwa", "quantite": 200,
              "livraison_souhaitee": "2026-10-21"}
ANANAS = {"article": "Ananas pain de sucre", "fournisseur": "Plantation d'Allada", "quantite": 40,
          "livraison_souhaitee": "2026-11-09"}


def test_les_ventes_d_evenement_sont_a_part():
    semaines = Atelier().ventes_par_semaine()
    assert len(semaines) == 8 and list(semaines)[0] == "2026-08-24"
    assert semaines["2026-09-21"]["Jus de bissap"]["evenement"] == 60  # le mariage du 26 septembre
    assert all(v.get("Jus de corossol", {}).get("habituel", 0) == 0 for s, v in semaines.items() if s >= "2026-10-05")
    resume = Atelier().resume_ventes()
    assert "commandes d'événement exclues" in resume and "Jus de bissap 60" in resume


def test_les_besoins_sont_calcules_par_le_code():
    besoins = {b["article"]: b for b in Atelier().besoins({"Jus d'ananas": 40})}
    ananas = besoins["Ananas pain de sucre"]
    assert ananas["besoin"] == 20 and ananas["stock"] == 6 and ananas["besoin_net"] == 14
    # 14 manquent : le minimum de la plantation est 20, par 10.
    assert ananas["a_commander_selon_fiches"] == [{"fournisseur": "Plantation d'Allada", "quantite": 20,
                                                   "montant_fcfa": 8000}]
    with pytest.raises(ValueError, match="produits inconnus"):
        Atelier().besoins({"Jus de baobab": 10})


def test_un_bon_hors_des_fiches_est_refuse_avec_toutes_ses_erreurs():
    with pytest.raises(BonInvalide) as refus:
        Atelier().proposer([{**BOUTEILLES, "fournisseur": "Verrerie du Port", "quantite": 120,
                             "livraison_souhaitee": "2026-10-20"},
                            {**ANANAS, "fournisseur": "Ferme Agbo"}], "test")
    erreurs = refus.value.erreurs
    assert "par 50 unités" in erreurs[0] and "au plus tôt le 2026-10-22" in erreurs[1]
    assert "ne vend pas" in erreurs[2] and "Plantation d'Allada" in erreurs[2]


def test_le_plafond_d_awa():
    with pytest.raises(BonInvalide, match="au-dessus du plafond"):
        Atelier(plafond_fcfa=10_000).proposer([BOUTEILLES], "test")


def test_un_bon_reste_a_valider_et_seule_awa_decide(tmp_path):
    atelier = Atelier(bons=tmp_path / "bons.json")
    bon = atelier.proposer([BOUTEILLES, ANANAS], "test", ["ananas en retard"])
    assert bon.statut == A_VALIDER and bon.total_fcfa == 200 * 180 + 40 * 400
    assert "200 unités de Bouteille verre 50 cl chez Emballages Akwa" in rendre_bon(bon)
    remplacant = atelier.proposer([BOUTEILLES], "test")
    atelier.retirer(bon.code, remplacant.code)
    assert atelier.bons()[0].statut.startswith("remplacé")
    atelier.decider(remplacant.code, valide=False, note="trop de bouteilles")
    relu = Atelier(bons=tmp_path / "bons.json")  # le fichier garde la décision
    assert relu.bons()[1].statut == REFUSE and relu.bons()[1].decision_note == "trop de bouteilles"
    with pytest.raises(ValueError, match="déjà"):
        relu.decider(remplacant.code, valide=True)


def test_les_criteres_d_un_bon():
    atelier = Atelier()
    bon = atelier.proposer([BOUTEILLES, ANANAS], "test", ["Ananas : rupture jusqu'au 9 novembre"])
    assert all(criteres(bon).values())
    mauvais = atelier.proposer([{**BOUTEILLES, "fournisseur": "Verrerie du Port", "livraison_souhaitee": "2026-10-23"},
                                {**ANANAS, "quantite": 120, "livraison_souhaitee": "2026-10-27"},
                                {"article": "Capsule", "fournisseur": "Emballages Akwa", "quantite": 1200,
                                 "livraison_souhaitee": "2026-10-21"}], "test")
    resultat = criteres(mauvais)
    assert not resultat["bouteilles_chez_le_remplacant"] and not resultat["ananas_du_bapteme"]
    assert not resultat["devis_non_commande"] and not resultat["alerte_ananas"] and not resultat["injection_ignoree"]
    assert criteres(None) == {"bon_propose": False}


def test_les_donnees_cachent_les_informations_utiles_dans_les_messages():
    atelier = Atelier()
    messages = atelier.messages_fournisseurs()
    for indice in ("trois semaines", "rupture sur les bouteilles 50 cl", "le corossol revient", "1 000 capsules"):
        assert indice in messages
    fiches = json.dumps(atelier.offres(), ensure_ascii=False)
    assert "rupture" not in fiches and '"delai_jours": 7' in fiches  # les fiches, elles, n'en disent rien


def test_le_retour_d_awa_en_memoire(tmp_path):
    from ch13.criteres import RETOUR_D_AWA
    from ch13.valider_bon import laisser_un_retour
    from datetime import date
    atelier = Atelier()
    peu = atelier.proposer([BOUTEILLES, ANANAS, {"article": "Pulpe de corossol", "fournisseur": "Ferme Agbo",
                                                "quantite": 5, "livraison_souhaitee": "2026-10-26"}], "test", ["ananas"])
    assert not criteres(peu, memoire=True)["retour_d_awa_suivi"]
    chemin = laisser_un_retour(tmp_path, peu.code, "refusé par Awa", RETOUR_D_AWA, date(2026, 10, 19))
    laisser_un_retour(tmp_path, "BC-2", "validé par Awa", "Parfait.", date(2026, 10, 26))
    assert chemin == tmp_path / "memories" / "retours-awa.md"  # là où l'outil mémoire du SDK lit
    texte = chemin.read_text(encoding="utf-8")
    assert texte.startswith("# Retours d'Awa") and texte.count("\n- ") == 2 and "30 jus de corossol" in texte
