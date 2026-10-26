"""La boutique : prix et frais calculés par le code, stock vérifié, une commande créée une seule fois."""

import random
from datetime import datetime, timedelta, timezone

import pytest

from comptoir.boutique import Boutique, RefusBoutique

MATIN = datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc)  # 9 h à Cotonou


class Horloge:
    def __init__(self, instant):
        self.instant = instant

    def __call__(self):
        return self.instant


def boutique(horloge=None) -> Boutique:
    return Boutique(horloge=horloge or Horloge(MATIN), hasard=random.Random(42))


def test_le_stock_initial_et_un_produit_inconnu():
    b = boutique()
    assert b.disponible("Jus de bissap") == 40 and b.disponible("Jus de corossol") == 0
    assert b.disponible("Jus de mangue") is None


def test_le_total_vient_du_catalogue_et_la_livraison_est_offerte_des_5_bouteilles():
    recap = boutique().preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "Mme Hounkpè", "Akpakpa")
    assert recap["total_fcfa"] == 6000 and recap["frais_livraison"] == 0
    assert recap["livraison_prevue"] == "aujourd'hui"  # commande passée avant midi, heure de Cotonou


def test_sous_5_bouteilles_la_livraison_coute_500_fcfa_et_les_sirops_ne_comptent_pas():
    recap = boutique().preparer("c1", [{"produit": "Jus de bissap", "quantite": 2},
                                       {"produit": "Sirop de gingembre", "quantite": 3}], "M. Dossou", "Zogbo")
    assert recap["frais_livraison"] == 500 and recap["total_fcfa"] == 2000 + 7500 + 500


def test_l_apres_midi_la_livraison_est_pour_demain():
    apres_midi = boutique(Horloge(MATIN.replace(hour=12)))  # 13 h à Cotonou
    assert apres_midi.preparer("c1", [{"produit": "Jus d'ananas", "quantite": 5}], "A", "B")["livraison_prevue"] == "demain"


@pytest.mark.parametrize(
    "lignes, motif",
    [
        ([{"produit": "Jus de mangue", "quantite": 3}], "absent du catalogue"),
        ([{"produit": "Jus d'ananas", "quantite": 0}], "au moins 1"),
        ([{"produit": "Jus d'ananas", "quantite": 15}], "Stock insuffisant : 12"),
        ([{"produit": "Jus de bissap", "quantite": 40}, {"produit": "Jus de gingembre", "quantite": 20}], "devis"),
        ([], "vide"),
    ],
)
def test_les_refus_disent_quoi_faire(lignes, motif):
    with pytest.raises(RefusBoutique, match=motif):
        boutique().preparer("c1", lignes, "A", "B")


def test_une_commande_n_est_creee_qu_une_fois_et_le_stock_baisse():
    b = boutique()
    code = b.preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "A", "B")["code_de_confirmation"]
    premiere = b.confirmer("c1", code)
    seconde = b.confirmer("c1", code)  # le client renvoie son « OUI » : rien de plus
    assert premiere["commande"] == seconde["commande"] == "C-0001" and seconde["deja_enregistree"]
    assert len(b.commandes()) == 1 and b.disponible("Jus de bissap") == 34


def test_l_ancien_code_ne_vaut_plus_apres_un_changement_d_avis():
    b = boutique()
    ancien = b.preparer("c1", [{"produit": "Jus de bissap", "quantite": 4}], "A", "B")["code_de_confirmation"]
    nouveau = b.preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "A", "B")["code_de_confirmation"]
    with pytest.raises(RefusBoutique, match="remplacé"):
        b.confirmer("c1", ancien)
    assert b.confirmer("c1", nouveau)["total_fcfa"] == 6000


def test_un_code_ne_sert_que_dans_sa_conversation():
    b = boutique()
    code = b.preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "A", "B")["code_de_confirmation"]
    with pytest.raises(RefusBoutique, match="aucun récapitulatif"):
        b.confirmer("autre-conversation", code)


def test_un_recapitulatif_expire():
    horloge = Horloge(MATIN)
    b = boutique(horloge)
    code = b.preparer("c1", [{"produit": "Jus de bissap", "quantite": 6}], "A", "B")["code_de_confirmation"]
    horloge.instant = MATIN + timedelta(hours=3)
    with pytest.raises(RefusBoutique, match="expiré"):
        b.confirmer("c1", code)


def test_le_stock_est_reverifie_au_moment_de_creer():
    b = boutique()
    code_c1 = b.preparer("c1", [{"produit": "Jus d'ananas", "quantite": 10}], "A", "B")["code_de_confirmation"]
    b.confirmer("c2", b.preparer("c2", [{"produit": "Jus d'ananas", "quantite": 5}], "C", "D")["code_de_confirmation"])
    with pytest.raises(RefusBoutique, match="stock"):
        b.confirmer("c1", code_c1)  # il ne reste que 7 ananas
