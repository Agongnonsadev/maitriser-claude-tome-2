"""Les ventes de la semaine : un export fixe, et notre calcul de référence pour vérifier le rapport."""

import csv
import io

from ch10 import fabriquer_ventes as fabrique
from comptoir.ventes import comparer, lire, totaux


def test_l_export_est_dans_le_depot_et_ne_change_pas():
    lignes = lire(fabrique.VENTES)
    attendu = fabrique.fabriquer()
    assert len(lignes) == len(attendu) == 77
    assert [l["commande"] for l in lignes] == [a[1] for a in attendu]


def test_les_totaux_de_reference():
    t = totaux(lire(fabrique.VENTES))
    assert t["chiffre_affaires_fcfa"] == 394_000 and t["commandes"] == 37
    assert t["panier_moyen_fcfa"] == 10_649
    assert sum(t["par_jour"].values()) == sum(t["par_quartier"].values()) == t["chiffre_affaires_fcfa"]
    assert sum(p["montant_fcfa"] for p in t["par_produit"].values()) == t["chiffre_affaires_fcfa"]


def test_la_comparaison_trouve_un_ecart_et_tolere_un_arrondi():
    t = totaux(lire(fabrique.VENTES))
    assert comparer(t, t) == []
    assert comparer({**t, "panier_moyen_fcfa": t["panier_moyen_fcfa"] + 1}, t) == []  # arrondi différent
    faux = {**t, "par_jour": {**t["par_jour"], "2026-10-12": 1}}
    assert comparer(faux, t) == [f"par_jour[2026-10-12] : 1 au lieu de {t['par_jour']['2026-10-12']}"]


def test_le_calcul_sur_un_petit_export():
    texte = "date,commande,produit,quantite,prix_unitaire_fcfa,quartier,canal\n" \
            "2026-10-12,C-1,Jus de bissap,2,1000,Zogbo,whatsapp\n2026-10-12,C-1,Sirop de bissap,1,2500,Zogbo,whatsapp\n"
    lignes = [{**l, "quantite": int(l["quantite"]), "prix_unitaire_fcfa": int(l["prix_unitaire_fcfa"])}
              for l in csv.DictReader(io.StringIO(texte))]
    assert totaux(lignes)["chiffre_affaires_fcfa"] == 4500 and totaux(lignes)["commandes"] == 1
