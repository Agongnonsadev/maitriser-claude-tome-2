"""Ce que les scripts du chapitre 11 partagent : la base, les contextes déjà calculés, la recherche."""

import json
from pathlib import Path

from comptoir.connaissances import Morceau, avec_contextes, charger_base
from comptoir.documentaire import CasDocumentaire
from comptoir.recherche import IndexBM25

DOSSIER = Path(__file__).parent
CONTEXTES = DOSSIER / "resultats" / "contextes.json"


def charger_questions() -> list[CasDocumentaire]:
    return [CasDocumentaire.depuis_dict(d) for d in json.loads((DOSSIER / "questions.json").read_text(encoding="utf-8"))]


def base_contextualisee() -> list[Morceau] | None:
    """La base avec ses phrases de contexte, si ch11.contextualiser a déjà été lancé."""
    if not CONTEXTES.exists():
        return None
    return avec_contextes(charger_base(), json.loads(CONTEXTES.read_text(encoding="utf-8")))


def index_bm25(contextuel: bool = True) -> IndexBM25:
    base = base_contextualisee() if contextuel else None
    return IndexBM25(base or charger_base())
