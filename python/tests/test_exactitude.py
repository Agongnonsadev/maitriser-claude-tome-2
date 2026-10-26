"""Mesurer l'exactitude : chaque champ juste, manqué, inventé ou erroné."""

from comptoir.exactitude import Ecart, comparer, resumer

ATTENDU = {
    "client": "Mme Dossou",
    "quartier": "Cadjèhoun",
    "total_lu": None,
    "lignes": [
        {"produit": "Jus de corossol", "quantite": None, "prix_unitaire_lu": 1000},
        {"produit": "Jus de gingembre", "quantite": 3, "prix_unitaire_lu": 1000},
    ],
}


def test_les_quatre_issues():
    assert Ecart("d", "c", "Cadjèhoun", "cadjehoun").issue == "juste"  # casse et accents ignorés
    assert Ecart("d", "c", 3, None).issue == "manquée"
    assert Ecart("d", "c", None, 12).issue == "inventée"
    assert Ecart("d", "c", 3, 8).issue == "erronée"
    assert Ecart("d", "c", None, None).issue == "juste"  # « illisible » attendu, « illisible » rendu


def test_une_quantite_tachee_devinee_est_une_valeur_inventee():
    obtenu = {**ATTENDU, "lignes": [{**ATTENDU["lignes"][0], "quantite": 12}, ATTENDU["lignes"][1]]}
    issues = {e.champ: e.issue for e in comparer("bon-03.jpg", ATTENDU, obtenu)}
    assert issues["lignes.0.quantite"] == "inventée"
    assert sum(1 for i in issues.values() if i == "juste") == len(issues) - 1


def test_une_extraction_en_echec_manque_tout():
    resume = resumer(comparer("bon-03.jpg", ATTENDU, None))
    # Les champs attendus à null sont « justes » : un échec ne les invente pas.
    assert resume["manquée"] == 7 and resume["inventée"] == 0


def test_une_ligne_lue_en_trop_est_inventee():
    obtenu = {**ATTENDU, "lignes": ATTENDU["lignes"] + [{"produit": "Jus de bissap", "quantite": 2}]}
    assert comparer("bon-03.jpg", ATTENDU, obtenu)[-1].issue == "inventée"
