"""Préparer une image ou un PDF pour Claude, et prévoir ce qu'il coûtera (chapitre 7).

Règles et limites relevées le 20 octobre 2026 sur platform.claude.com (Vision, PDF support,
Coordinates and bounding boxes). Elles changent : vérifiez-les (page d'accompagnement).
"""

import base64
import io
import math
from pathlib import Path

TYPES_IMAGE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",  # seule la première image d'une animation est lue
    ".webp": "image/webp",
}

# Par l'API d'Anthropic : 10 Mo par image une fois encodée en base64 (5 Mo sur Bedrock et
# Google Cloud), 32 Mo par requête, 8000 px au plus de côté.
IMAGE_BASE64_MAX = 10 * 1024 * 1024
REQUETE_MAX = 32 * 1024 * 1024
COTE_ABSOLU_MAX = 8000

# Claude voit une image par carrés de 28 × 28 pixels : un carré, un token.
CARRE = 28

# Deux niveaux de résolution. Les modèles 4.7 et suivants (tous ceux du Comptoir) sont en
# haute résolution : 2576 px de côté et 4784 tokens au plus. Les autres : 1568 et 1568.
HAUTE_RESOLUTION = (2576, 4784)
STANDARD = (1568, 1568)
MODELES_HAUTE_RESOLUTION = {"claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}


def limites(modele: str) -> tuple[int, int]:
    return HAUTE_RESOLUTION if modele in MODELES_HAUTE_RESOLUTION else STANDARD


def jetons_image(largeur: int, hauteur: int) -> int:
    """Tokens d'une image de cette taille, si Claude la voit sans la réduire."""
    return math.ceil(largeur / CARRE) * math.ceil(hauteur / CARRE)


def taille_vue(largeur: int, hauteur: int, cote_max: int, jetons_max: int) -> tuple[int, int]:
    """La taille à laquelle Claude réduit une image avant de la lire.

    Traduction de l'implémentation de référence d'Anthropic : la plus grande taille, aux
    mêmes proportions, qui respecte à la fois le côté maximal et le nombre de tokens.
    """

    def tient(l: int, h: int) -> bool:
        return (
            math.ceil(l / CARRE) * CARRE <= cote_max
            and math.ceil(h / CARRE) * CARRE <= cote_max
            and jetons_image(l, h) <= jetons_max
        )

    if tient(largeur, hauteur):
        return largeur, hauteur
    if hauteur > largeur:
        h, l = taille_vue(hauteur, largeur, cote_max, jetons_max)
        return l, h
    proportion = largeur / hauteur
    bas, haut = 1, largeur  # bas tient toujours, haut jamais
    while bas + 1 < haut:
        milieu = (bas + haut) // 2
        if tient(milieu, max(round(milieu / proportion), 1)):
            bas = milieu
        else:
            haut = milieu
    return bas, max(round(bas / proportion), 1)


def jetons_prevus(largeur: int, hauteur: int, modele: str) -> int:
    """Tokens que coûtera l'image avec ce modèle, réduction comprise."""
    return jetons_image(*taille_vue(largeur, hauteur, *limites(modele)))


def type_image(chemin: Path) -> str:
    try:
        return TYPES_IMAGE[chemin.suffix.lower()]
    except KeyError:
        raise ValueError(f"{chemin.name} : format non accepté (JPEG, PNG, GIF ou WebP seulement).") from None


def reduire(octets: bytes, cote_max: int) -> tuple[bytes, str]:
    """Réduit une image pour que son grand côté ne dépasse pas cote_max, en JPEG de bonne qualité.

    Réduire avant d'envoyer coûte moins de tokens et allège la requête ; trop réduire rend
    l'écriture illisible. Mesurez avant de choisir (étape 6 du chapitre).
    """
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(io.BytesIO(octets)))  # remet la photo droite
    image.thumbnail((cote_max, cote_max))
    sortie = io.BytesIO()
    image.convert("RGB").save(sortie, format="JPEG", quality=90)
    return sortie.getvalue(), "image/jpeg"


def bloc_image(chemin: str | Path, cote_max: int | None = None) -> dict:
    """Un bloc image en base64, prêt pour l'API."""
    chemin = Path(chemin)
    media_type = type_image(chemin)
    octets = chemin.read_bytes()
    if cote_max:
        octets, media_type = reduire(octets, cote_max)
    donnees = base64.standard_b64encode(octets).decode("ascii")
    if len(donnees) > IMAGE_BASE64_MAX:
        raise ValueError(f"{chemin.name} : plus de 10 Mo une fois encodée ; réduisez-la (cote_max).")
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": donnees}}


def bloc_pdf(chemin: str | Path, titre: str | None = None, citations: bool = False) -> dict:
    """Un bloc document PDF en base64. Claude lit le texte de chaque page et son image."""
    chemin = Path(chemin)
    if chemin.suffix.lower() != ".pdf":
        raise ValueError(f"{chemin.name} : un PDF est attendu.")
    donnees = base64.standard_b64encode(chemin.read_bytes()).decode("ascii")
    if len(donnees) > REQUETE_MAX:
        raise ValueError(f"{chemin.name} : trop lourd pour une requête ; découpez-le ou passez par la Files API.")
    bloc = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": donnees}}
    if titre:
        bloc["title"] = titre
    if citations:
        bloc["citations"] = {"enabled": True}
    return bloc


def bloc_fichier(file_id: str, genre: str = "document", citations: bool = False) -> dict:
    """Un bloc qui désigne un fichier déjà envoyé par la Files API (genre : document ou image)."""
    bloc = {"type": genre, "source": {"type": "file", "file_id": file_id}}
    if citations and genre == "document":
        bloc["citations"] = {"enabled": True}
    return bloc


def bloc_document(chemin: str | Path, cote_max: int | None = None) -> dict:
    """Image ou PDF, selon l'extension du fichier."""
    chemin = Path(chemin)
    if chemin.suffix.lower() == ".pdf":
        return bloc_pdf(chemin)
    return bloc_image(chemin, cote_max)
