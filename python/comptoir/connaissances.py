"""La base de connaissances d'Awa : des documents Markdown, découpés en sections citables (chapitre 11).

Chaque section devient un « morceau » avec un identifiant stable, par exemple
kb://faq#etes-vous-ouverts-le-dimanche. Ces identifiants reviennent dans les citations :
on sait d'où vient chaque affirmation, et le test le vérifie.

La même base sert deux usages : entière dans le contexte, mise en cache ; ou par morceaux
choisis par une recherche (comptoir/recherche.py), quand elle devient trop grande.
"""

import re
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path

DOSSIER = Path(__file__).parent / "connaissances"
TAILLE_MAX = 1200  # caractères par morceau ; au-delà, une section est coupée entre deux paragraphes


@dataclass(frozen=True)
class Morceau:
    identifiant: str   # kb://<document>#<section>, stable tant que le titre ne change pas
    document: str      # le nom du fichier, sans extension
    titre: str         # « Questions fréquentes — Êtes-vous ouverts le dimanche ? »
    texte: str
    contexte: str = ""  # une phrase qui situe le morceau dans son document (Contextual Retrieval)

    def pour_la_recherche(self) -> str:
        """Ce que les index lisent : le contexte s'il existe, le titre, puis le texte."""
        return " ".join(p for p in (self.contexte, self.titre, self.texte) if p)


def ancre(titre: str) -> str:
    """« Êtes-vous ouverts le dimanche ? » -> « etes-vous-ouverts-le-dimanche »."""
    sans_accents = unicodedata.normalize("NFD", titre).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", sans_accents.lower()).strip("-")


def _paragraphes(texte: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", texte) if p.strip()]


def decouper(markdown: str, document: str, taille_max: int = TAILLE_MAX) -> list[Morceau]:
    """Une section « ## » par morceau. Une section trop longue est coupée entre deux paragraphes,
    et chaque partie reprend le dernier paragraphe de la précédente : une phrase coupée de son
    contexte se retrouve mal."""
    titre_document = re.search(r"^# (.+)$", markdown, re.M).group(1).strip()
    sections = re.split(r"^## ", markdown, flags=re.M)[1:]
    morceaux = []
    for section in sections:
        titre, _, corps = section.partition("\n")
        titre = titre.strip()
        paragraphes = _paragraphes(corps)
        parties, courante = [], []
        for p in paragraphes:
            if courante and len("\n\n".join(courante + [p])) > taille_max:
                parties.append(courante)
                courante = [courante[-1]]  # recouvrement d'un paragraphe
            courante.append(p)
        if courante:
            parties.append(courante)
        for i, partie in enumerate(parties):
            suffixe = f"-{i + 1}" if len(parties) > 1 else ""
            morceaux.append(Morceau(
                identifiant=f"kb://{document}#{ancre(titre)}{suffixe}",
                document=document,
                titre=f"{titre_document} — {titre}",
                texte="\n\n".join(partie),
            ))
    return morceaux


def charger_base(dossier: Path = DOSSIER) -> list[Morceau]:
    """Tous les morceaux, dans un ordre stable : celui des noms de fichiers, puis des sections.
    L'ordre compte : le cache exige un début de requête identique, octet pour octet."""
    morceaux = []
    for fichier in sorted(dossier.glob("*.md")):
        morceaux.extend(decouper(fichier.read_text(encoding="utf-8"), fichier.stem))
    identifiants = [m.identifiant for m in morceaux]
    doublons = {i for i in identifiants if identifiants.count(i) > 1}
    if doublons:
        raise ValueError(f"Identifiants en double dans la base : {sorted(doublons)}")
    return morceaux


def avec_contextes(morceaux: list[Morceau], contextes: dict[str, str]) -> list[Morceau]:
    return [replace(m, contexte=contextes.get(m.identifiant, m.contexte)) for m in morceaux]


def controle_cache(cache: bool | str) -> dict | None:
    """True ou "5m" : cache de 5 minutes ; "1h" : cache d'une heure, écrit deux fois plus cher."""
    if not cache:
        return None
    return {"type": "ephemeral", "ttl": "1h"} if cache == "1h" else {"type": "ephemeral"}


def bloc_resultat(morceau: Morceau, cache: bool | str = False, citations: bool = True) -> dict:
    """Un morceau en bloc search_result : Claude le cite avec notre source et notre titre."""
    bloc = {
        "type": "search_result",
        "source": morceau.identifiant,
        "title": morceau.titre,
        # Un bloc de texte par paragraphe : le paragraphe est la plus petite unité citable.
        "content": [{"type": "text", "text": p} for p in _paragraphes(morceau.texte)],
        "citations": {"enabled": citations},
    }
    if controle_cache(cache):
        bloc["cache_control"] = controle_cache(cache)
    return bloc


def blocs_resultats(morceaux: list[Morceau], cache: bool | str = False, citations: bool = True) -> list[dict]:
    """Les morceaux en blocs search_result. Avec un cache, le point est posé sur le dernier :
    tout ce qui précède, outils et prompt système compris, est mis en cache ensemble."""
    blocs = [bloc_resultat(m, citations=citations) for m in morceaux]
    if blocs and controle_cache(cache):
        blocs[-1]["cache_control"] = controle_cache(cache)
    return blocs
