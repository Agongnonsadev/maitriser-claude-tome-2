"""Les documents d'exemple du chapitre 7 : présents, bien formés, cohérents avec les contrôles."""

import json
import re
from pathlib import Path

from PIL import Image

from ch07 import fabriquer_exemples as exemples
from comptoir.documents import jetons_prevus
from comptoir.extraction import BonDeCommande, controler_bon

DOSSIER = Path(__file__).parent.parent / "ch07" / "documents"


def test_les_documents_et_les_attendus_sont_dans_le_depot():
    attendus = json.loads((DOSSIER / "attendus.json").read_text(encoding="utf-8"))
    assert attendus == exemples.attendus()  # le script et le fichier disent la même chose
    for nom in attendus:
        assert (DOSSIER / nom).exists()
    assert (DOSSIER / "conditions-fournisseur.pdf").exists()


def test_une_photo_d_exemple_coute_quelques_milliers_de_tokens():
    with Image.open(DOSSIER / "bon-01.jpg") as image:
        assert 2000 < jetons_prevus(*image.size, "claude-sonnet-5-5") <= 4784


def test_le_pdf_texte_est_bien_forme():
    contenu = (DOSSIER / "conditions-fournisseur.pdf").read_bytes()
    assert contenu.startswith(b"%PDF-1.4") and contenu.rstrip().endswith(b"%%EOF")
    # Chaque entrée de la table xref pointe bien sur le début de son objet.
    xref = int(re.search(rb"startxref\n(\d+)", contenu).group(1))
    entrees = re.findall(rb"(\d{10}) 00000 n", contenu[xref:])
    for numero, position in enumerate(entrees, start=1):
        assert contenu[int(position):].startswith(b"%d 0 obj" % numero)
    assert b"/Count 2" in contenu  # deux pages, pour des citations par page


def _bon_attendu(nom: str) -> BonDeCommande:
    """Le bon tel qu'une lecture juste le rendrait, d'après les données du script."""
    bon = next(b for b in exemples.BONS if b["fichier"] == nom)
    return BonDeCommande(
        type_document="bon_de_commande",
        client=bon["client"],
        quartier=bon["quartier"],
        date_livraison_lue=bon["date"],
        lignes=[
            {"libelle_lu": libelle, "produit": produit, "quantite": quantite, "prix_unitaire_lu": prix,
             "lisibilite": "illisible" if quantite is None else "lisible", "remarque": None}
            for libelle, produit, quantite, prix in bon["lignes"]
        ],
        total_lu=bon["total"],
        remarques=[],
    )


def test_chaque_bon_d_exemple_pose_le_probleme_prevu():
    assert controler_bon(_bon_attendu("bon-01.jpg")).anomalies == []
    assert len(controler_bon(_bon_attendu("bon-02.jpg")).anomalies) == 2  # prix et total
    assert controler_bon(_bon_attendu("bon-03.jpg")).montant_calcule is None  # quantité tachée
    assert controler_bon(_bon_attendu("bon-04.jpg")).montant_calcule == 5000
