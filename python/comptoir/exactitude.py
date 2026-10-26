"""Mesurer l'exactitude d'un extracteur, champ par champ, en classant les erreurs (chapitre 7).

Quatre issues pour un champ attendu :
- « juste » : la bonne valeur ;
- « manquée » : null alors qu'une valeur était lisible. Gênant, mais visible : Yao vérifie ;
- « inventée » : une valeur alors qu'on attendait null (illisible ou absent). La plus grave :
  elle ne se voit pas ;
- « erronée » : une autre valeur que la bonne. Grave aussi, sauf si un contrôle la rattrape.
"""

import unicodedata
from collections import Counter
from dataclasses import dataclass

# Les champs comparés. Le texte libre (remarques, libellés) n'est pas noté par le code :
# il se relit.
CHAMPS_BON = ["client", "quartier", "total_lu"]
CHAMPS_LIGNE_BON = ["produit", "quantite", "prix_unitaire_lu"]
CHAMPS_FACTURE = ["fournisseur", "numero", "total_lu", "devise"]
CHAMPS_LIGNE_FACTURE = ["quantite", "prix_unitaire", "montant"]


def _normaliser(valeur):
    if isinstance(valeur, str):
        sans_accents = unicodedata.normalize("NFKD", valeur.casefold())
        return " ".join("".join(c for c in sans_accents if not unicodedata.combining(c)).split())
    return valeur


@dataclass(frozen=True)
class Ecart:
    document: str
    champ: str
    attendu: object
    obtenu: object

    @property
    def issue(self) -> str:
        if _normaliser(self.attendu) == _normaliser(self.obtenu):
            return "juste"
        if self.obtenu is None:
            return "manquée"
        if self.attendu is None:
            return "inventée"
        return "erronée"


def comparer(document: str, attendu: dict, obtenu: dict | None, facture: bool = False) -> list[Ecart]:
    """Un écart par champ attendu. Une extraction en échec (obtenu None) manque tout."""
    obtenu = obtenu or {}
    champs, champs_ligne = (CHAMPS_FACTURE, CHAMPS_LIGNE_FACTURE) if facture else (CHAMPS_BON, CHAMPS_LIGNE_BON)
    ecarts = [Ecart(document, c, attendu.get(c), obtenu.get(c)) for c in champs]
    lignes_obtenues = obtenu.get("lignes", [])
    for rang, ligne in enumerate(attendu.get("lignes", [])):
        lue = lignes_obtenues[rang] if rang < len(lignes_obtenues) else {}
        ecarts.extend(Ecart(document, f"lignes.{rang}.{c}", ligne.get(c), lue.get(c)) for c in champs_ligne)
    # Une ligne lue en trop est une ligne inventée.
    for rang in range(len(attendu.get("lignes", [])), len(lignes_obtenues)):
        ecarts.append(Ecart(document, f"lignes.{rang}", None, lignes_obtenues[rang]))
    return ecarts


def resumer(ecarts: list[Ecart]) -> dict:
    issues = Counter(e.issue for e in ecarts)
    total = len(ecarts)
    return {
        "champs": total,
        "exactitude": issues["juste"] / total if total else 0.0,
        **{issue: issues[issue] for issue in ("juste", "manquée", "inventée", "erronée")},
    }
