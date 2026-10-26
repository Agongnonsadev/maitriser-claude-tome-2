"""L'outil éditeur de texte, exécuté par notre code : un dossier fermé, des remplacements sans ambiguïté."""

from types import SimpleNamespace

import pytest

from comptoir.editeur import OUTIL, Editeur, RefusEditeur


@pytest.fixture
def editeur(tmp_path):
    (tmp_path / "faq.md").write_text("Livraison gratuite dès 3 bouteilles.\nPaiement : Mobile Money.\n", encoding="utf-8")
    return Editeur(tmp_path)


def test_l_outil_d_anthropic():
    assert OUTIL["type"] == "text_editor_20250728" and OUTIL["name"] == "str_replace_based_edit_tool"


@pytest.mark.parametrize("chemin", ["../secret.txt", "/etc/passwd", "sous/../../evasion.md"])
def test_on_ne_sort_pas_du_dossier(editeur, chemin):
    with pytest.raises(RefusEditeur, match="outside"):
        editeur.executer({"command": "view", "path": chemin})


def test_voir_avec_les_numeros_de_ligne(editeur):
    assert editeur.executer({"command": "view", "path": "faq.md"}).splitlines()[1] == "2: Paiement : Mobile Money."
    assert editeur.executer({"command": "view", "path": "."}) == "faq.md"


def test_remplacer_une_seule_occurrence_et_garder_une_sauvegarde(editeur, tmp_path):
    editeur.executer({"command": "str_replace", "path": "faq.md", "old_str": "dès 3 bouteilles", "new_str": "dès 5 bouteilles"})
    assert "dès 5 bouteilles" in (tmp_path / "faq.md").read_text(encoding="utf-8")
    assert "dès 3 bouteilles" in (tmp_path / "faq.md.backup").read_text(encoding="utf-8")


def test_un_remplacement_ambigu_ou_introuvable_est_refuse(editeur):
    with pytest.raises(RefusEditeur, match="Found 2 matches"):
        editeur.executer({"command": "str_replace", "path": "faq.md", "old_str": "Mo", "new_str": "MO"})
    with pytest.raises(RefusEditeur, match="No match"):
        editeur.executer({"command": "str_replace", "path": "faq.md", "old_str": "Porto-Novo", "new_str": "x"})


def test_creer_sans_ecraser_et_inserer(editeur, tmp_path):
    with pytest.raises(RefusEditeur, match="already exists"):
        editeur.executer({"command": "create", "path": "faq.md", "file_text": "x"})
    editeur.executer({"command": "insert", "path": "faq.md", "insert_line": 0, "insert_text": "# FAQ"})
    assert (tmp_path / "faq.md").read_text(encoding="utf-8").startswith("# FAQ\nLivraison")


def test_une_erreur_devient_un_resultat_en_erreur(editeur):
    appel = SimpleNamespace(id="t1", input={"command": "view", "path": "absent.md"})
    resultat = editeur.resultat(appel)
    assert resultat["is_error"] and "File not found" in resultat["content"]
