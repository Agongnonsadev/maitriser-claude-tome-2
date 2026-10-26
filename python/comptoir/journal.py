"""Noter chaque appel dans un journal : de quoi retrouver une requête et suivre les coûts.

Une ligne JSON par appel. On y met l'identifiant de la requête (à donner au support
d'Anthropic en cas de problème), le modèle, les tokens et le coût. Jamais la clé d'API,
jamais le contenu des messages des clients.

Depuis le chapitre 8, chaque ligne peut aussi porter de quoi analyser les échecs : la
raison de l'arrêt, la durée, le code de l'erreur et son origine, la conversation.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from comptoir import config
from comptoir.couts import Cout


def _ecrire(ligne: dict, chemin: str | None) -> dict:
    fichier = Path(chemin or config.JOURNAL)
    fichier.parent.mkdir(parents=True, exist_ok=True)
    with fichier.open("a", encoding="utf-8") as f:
        f.write(json.dumps(ligne, ensure_ascii=False) + "\n")
    return ligne


def noter(
    identifiant: str | None,
    modele: str,
    cout: Cout | None,
    chemin: str | None = None,
    prompt: str | None = None,
    **details,
) -> dict:
    """cout=None : l'appel n'est pas allé au bout (flux coupé, erreur). Son coût réel n'est
    pas connu du code ; la Console fait foi.

    details (chapitre 8) : stop_reason, duree_ms, erreur, origine, client… Les valeurs
    None ne sont pas écrites.
    """
    ligne = {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "requete": identifiant,
        "modele": modele,
        "prompt": prompt,  # version et empreinte du prompt système (chapitre 5)
        "tokens_entree": cout.entree if cout else None,
        "tokens_ecriture_cache": cout.ecriture_cache if cout else None,
        "tokens_lecture_cache": cout.lecture_cache if cout else None,
        "tokens_sortie": cout.sortie if cout else None,
        "tokens_reflexion": cout.reflexion if cout else None,
        "cout_dollars": round(cout.dollars, 6) if cout else None,
    }
    if cout and cout.recherches:
        ligne["recherches_web"] = cout.recherches  # chapitre 10
    if cout is None:
        ligne["interrompu"] = True
    ligne.update({cle: valeur for cle, valeur in details.items() if valeur is not None})
    return _ecrire(ligne, chemin)


def noter_evenement(evenement: str, chemin: str | None = None, **details) -> dict:
    """Un événement sans appel à l'API : un message refusé par le budget, par exemple."""
    ligne = {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "evenement": evenement}
    ligne.update({cle: valeur for cle, valeur in details.items() if valeur is not None})
    return _ecrire(ligne, chemin)
