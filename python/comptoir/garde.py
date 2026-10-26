"""Les gardes du Comptoir (chapitre 18) : ce que le code vérifie lui-même, quoi qu'écrive le modèle.

- Ce qu'une réponse annonce, contre ce qui a été fait : l'assistant documentaire n'a aucun outil ; s'il
  écrit « je transmets votre demande à Awa », c'est une promesse que personne ne tiendra. Le chapitre 17
  l'a mesuré (deux fois sur trois sur un cas), le chapitre 18 l'a reproduit (trois fois sur trois).
- Les champs écrits par le client et gardés par la boutique, le nom et le quartier : ils finissent dans
  l'application Claude d'Awa, par le serveur MCP du chapitre 15. Un texte libre y deviendrait une
  injection indirecte. Ce sont des données courtes ; le code refuse tout le reste, avant d'enregistrer.

Les motifs viennent de la notation du chapitre 17 (ch17/notation_code.py), qui juge les essais ; ici,
ils protègent les clients. Les deux restent séparés : la garde peut évoluer sans changer les notes.
"""

import re

# « Je transmets », « j'ai transmis », « est transmise » : une transmission annoncée comme faite.
# « Je peux transmettre », « souhaitez-vous que je transmette » sont des propositions : ignorées.
ANNONCE_TRANSMISSION = re.compile(
    r"\bje (la |le |lui |les |vous )?transmets\b|\bj'ai (bien )?transmis\b|\bje viens de (la |le |lui )?transmettre\b|"
    r"\b(est|a été|a bien été|sont|ont été) transmise?s?\b|"
    r"\bi(['’]ve| have) (passed|forwarded|sent)\b|\bi(['’]m| am) (passing|forwarding)\b|\b(has been|have been) (passed|forwarded)\b",
    re.IGNORECASE)
_PHRASE = re.compile(r"[^.!?…]+[.!?…]*")
_CONDITION = re.compile(r"\b(si|s'il|if|quand|lorsque|dès que|une fois que)\b", re.IGNORECASE)
# Ce qui clôt une condition : « si le devis le prévoit, donc je transmets » est une annonce. Mesuré au
# chapitre 18 : la première version de cette garde, comme la notation du chapitre 17, s'y laissait prendre.
_FIN_DE_CONDITION = re.compile(r"\b(donc|alors|so)\b|[:;]", re.IGNORECASE)


def sous_condition(avant: str) -> bool:
    """Vrai si une condition gouverne ce qui suit : un « si » sans « donc », « alors », deux-points ni
    point-virgule entre lui et la suite. « Si vous le souhaitez, je lui transmets » reste une proposition."""
    conditions = list(_CONDITION.finditer(avant))
    return bool(conditions) and not _FIN_DE_CONDITION.search(avant[conditions[-1].end():])


def annonce_une_transmission(texte: str) -> bool:
    """Vrai si une phrase affirme une transmission, sans condition qui la gouverne et sans être une question."""
    for phrase in _PHRASE.findall(texte.replace("’", "'")):
        trouve = ANNONCE_TRANSMISSION.search(phrase)
        if trouve and not sous_condition(phrase[:trouve.start()]) and not phrase.rstrip().endswith("?"):
            return True
    return False


# --- Les champs du client ----------------------------------------------------------------------

LONGUEUR_MAX_NOM = 60
LONGUEUR_MAX_QUARTIER = 40
# Des lettres (accents compris), séparées par une espace, un tiret, une apostrophe ou un point :
# « Larissa Noudéhou », « Mme Akpovi », « Jean-Marc », « N'Dah ». Ni chiffre, ni deux-points, ni crochet.
_NOM = re.compile(r"[^\W\d_]+(?:[ '’.-]+[^\W\d_]+)*\.?")
# Un quartier peut porter un numéro (« Zone 4 », « PK 10 ») : lettres et chiffres, mêmes séparateurs.
_QUARTIER = re.compile(r"[^\W_]+(?:[ '’.-]+[^\W_]+)*")
_MOTS_MAX = 6


def _probleme(valeur: str, motif: re.Pattern, longueur_max: int, quoi: str) -> str | None:
    valeur = valeur.strip()
    if not valeur:
        return f"{quoi} est vide"
    if len(valeur) > longueur_max or len(valeur.split()) > _MOTS_MAX:
        return f"{quoi} est trop long ({len(valeur)} caractères)"
    if not motif.fullmatch(valeur):
        return f"{quoi} contient autre chose que des lettres{' et des chiffres' if motif is _QUARTIER else ''}"
    return None


def probleme_de_nom(nom: str) -> str | None:
    """None si le nom est acceptable ; sinon, ce qui ne va pas, pour le dire à Claude."""
    return _probleme(nom, _NOM, LONGUEUR_MAX_NOM, "le nom")


def probleme_de_quartier(quartier: str) -> str | None:
    return _probleme(quartier, _QUARTIER, LONGUEUR_MAX_QUARTIER, "le quartier")
