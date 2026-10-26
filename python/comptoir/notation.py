"""Noter une réponse du Comptoir avec des critères écrits à l'avance (chapitre 3).

Chaque cas dit ce que la réponse doit contenir, ce qu'elle ne doit pas contenir, et si elle
doit proposer de transmettre la demande à Awa. Ce que le code ne sait pas juger est signalé
pour une relecture humaine. Le chapitre 17 ira beaucoup plus loin.
"""

import re
import unicodedata
from dataclasses import dataclass, field

# Espaces qu'on trouve entre les chiffres : normale, insécable, fine insécable.
_ESPACES_ENTRE_CHIFFRES = re.compile(r"(?<=\d)[   ](?=\d)")
_FIN_DE_PHRASE = re.compile(r"[.!?…]+(?=\s|$)")
# « Bonjour ! », « Bonsoir Madame ! », « Hello! » en tête de réponse : une politesse, pas une phrase.
# Ajouté au chapitre 5 : l'exemple du prompt v1 commence lui-même par « Bonjour ! ».
_SALUTATION = re.compile(r"^(bonjour|bonsoir|hello|hi|good (morning|afternoon|evening))\b[^.!?…]{0,25}[.!]\s+",
                         re.IGNORECASE)


def normaliser(texte: str) -> str:
    """Minuscules, apostrophes droites, « 2 500 » et « 2500 » écrits pareil."""
    texte = unicodedata.normalize("NFC", texte).lower().replace("’", "'")
    return _ESPACES_ENTRE_CHIFFRES.sub("", texte)


def compter_phrases(texte: str) -> int:
    texte = _SALUTATION.sub("", texte.strip(), count=1)
    return max(1, len(_FIN_DE_PHRASE.findall(texte.strip()))) if texte.strip() else 0


@dataclass
class Cas:
    identifiant: str
    question: str
    doit_contenir: list[str] = field(default_factory=list)          # tous obligatoires
    un_parmi: list[str] = field(default_factory=list)               # au moins un
    ne_doit_pas_contenir: list[str] = field(default_factory=list)
    ne_doit_pas_correspondre: list[str] = field(default_factory=list)  # expressions régulières
    doit_transmettre: bool = False
    phrases_max: int = 3
    a_relire: str = ""   # ce qu'un humain doit vérifier, si le code ne peut pas le juger

    @classmethod
    def depuis_dict(cls, d: dict) -> "Cas":
        return cls(**d)


@dataclass
class Note:
    reussi: bool
    raisons: list[str]
    a_relire: str = ""


MOTS_DE_TRANSMISSION = ("awa", "transmet", "transmettre", "transmis")


def noter(cas: Cas, reponse: str) -> Note:
    texte = normaliser(reponse)
    raisons = []

    for attendu in cas.doit_contenir:
        if normaliser(attendu) not in texte:
            raisons.append(f"manque « {attendu} »")
    if cas.un_parmi and not any(normaliser(a) in texte for a in cas.un_parmi):
        raisons.append(f"aucun de : {', '.join(cas.un_parmi)}")
    for interdit in cas.ne_doit_pas_contenir:
        if normaliser(interdit) in texte:
            raisons.append(f"contient « {interdit} »")
    for motif in cas.ne_doit_pas_correspondre:
        if re.search(motif, texte):
            raisons.append(f"correspond à {motif}")
    if cas.doit_transmettre and not any(m in texte for m in MOTS_DE_TRANSMISSION):
        raisons.append("ne propose pas de transmettre à Awa")
    if compter_phrases(reponse) > cas.phrases_max:
        raisons.append(f"plus de {cas.phrases_max} phrases")

    return Note(reussi=not raisons, raisons=raisons, a_relire=cas.a_relire)
