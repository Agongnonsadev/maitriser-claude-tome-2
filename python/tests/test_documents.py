"""Préparer images et PDF, et prévoir leur coût en tokens, sans appel à l'API."""

import base64
import io

import pytest
from PIL import Image

from comptoir.documents import (
    HAUTE_RESOLUTION,
    STANDARD,
    bloc_document,
    bloc_fichier,
    bloc_image,
    bloc_pdf,
    jetons_image,
    jetons_prevus,
    taille_vue,
)

# Le tableau de la page Vision d'Anthropic (20 octobre 2026) : taille vue et tokens.
EXEMPLES_STANDARD = [
    ((200, 200), (200, 200), 64),
    ((1000, 1000), (1000, 1000), 1296),
    ((1092, 1092), (1092, 1092), 1521),
    ((1920, 1080), (1456, 819), 1560),
    # Le tableau de la page indique 1269 × 952 ; l'implémentation de référence de la même
    # documentation donne 1270 × 952. Même coût : 1564 tokens.
    ((2000, 1500), (1270, 952), 1564),
    ((3840, 2160), (1456, 819), 1560),
]
EXEMPLES_HAUTE_RESOLUTION = [
    ((1920, 1080), (1920, 1080), 2691),
    ((2000, 1500), (2000, 1500), 3888),
    ((3840, 2160), (2576, 1449), 4784),
]


@pytest.mark.parametrize("taille, vue, jetons", EXEMPLES_STANDARD)
def test_le_niveau_standard_suit_le_tableau_d_anthropic(taille, vue, jetons):
    assert taille_vue(*taille, *STANDARD) == vue
    assert jetons_image(*vue) == jetons


@pytest.mark.parametrize("taille, vue, jetons", EXEMPLES_HAUTE_RESOLUTION)
def test_la_haute_resolution_suit_le_tableau_d_anthropic(taille, vue, jetons):
    assert taille_vue(*taille, *HAUTE_RESOLUTION) == vue
    assert jetons_image(*vue) == jetons


def test_l_exemple_de_la_page_a4():
    # Une page A4 scannée à 130 points par pouce : réduite en standard, pas en haute résolution.
    assert taille_vue(1075, 1520, *STANDARD) == (924, 1307)
    assert taille_vue(1075, 1520, *HAUTE_RESOLUTION) == (1075, 1520)


def test_une_photo_de_telephone_coute_au_plus_4784_tokens_avec_sonnet_5_5():
    assert jetons_prevus(3000, 4000, "claude-sonnet-5-5") <= 4784


def _photo(tmp_path, taille=(3000, 4000), nom="photo.jpg"):
    chemin = tmp_path / nom
    Image.new("RGB", taille, (200, 180, 160)).save(chemin, quality=80)
    return chemin


def test_un_bloc_image_en_base64(tmp_path):
    bloc = bloc_image(_photo(tmp_path))
    assert bloc["type"] == "image"
    assert bloc["source"]["media_type"] == "image/jpeg"
    assert base64.standard_b64decode(bloc["source"]["data"])[:2] == b"\xff\xd8"  # début d'un JPEG


def test_reduire_avant_d_envoyer(tmp_path):
    bloc = bloc_image(_photo(tmp_path), cote_max=1000)
    image = Image.open(io.BytesIO(base64.standard_b64decode(bloc["source"]["data"])))
    assert max(image.size) == 1000 and image.size == (750, 1000)


def test_un_format_refuse(tmp_path):
    chemin = tmp_path / "scan.tiff"
    chemin.write_bytes(b"II*\x00")
    with pytest.raises(ValueError, match="format non accepté"):
        bloc_image(chemin)


def test_un_bloc_pdf_avec_titre_et_citations(tmp_path):
    chemin = tmp_path / "f.pdf"
    chemin.write_bytes(b"%PDF-1.4\n")
    bloc = bloc_pdf(chemin, titre="Facture", citations=True)
    assert bloc["source"]["media_type"] == "application/pdf"
    assert bloc["title"] == "Facture" and bloc["citations"] == {"enabled": True}
    assert bloc_document(chemin)["type"] == "document"


def test_un_fichier_de_la_files_api():
    assert bloc_fichier("file_abc", citations=True) == {
        "type": "document",
        "source": {"type": "file", "file_id": "file_abc"},
        "citations": {"enabled": True},
    }
