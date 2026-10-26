"""Un appel à Claude qui encaisse les pannes et respecte le budget (chapitre 8).

Dans l'ordre : compter l'entrée (gratuit), réserver le coût maximal, appeler, noter dans le
journal ce qui s'est passé, régler le coût réel, et traduire tout échec en un diagnostic.
"""

import time
from dataclasses import dataclass

import anthropic

from comptoir import config
from comptoir.budget import Budget
from comptoir.couts import Cout, cout, cout_maximal, duree_cache
from comptoir.erreurs import INDISPONIBLE, Diagnostic, ErreurComptoir, diagnostiquer, diagnostiquer_arret
from comptoir.journal import noter, noter_evenement

# Les paramètres de la requête que l'outil de comptage accepte aussi.
CHAMPS_COMPTAGE = ("model", "messages", "system", "tools", "tool_choice", "thinking", "output_config")


class HorsBudget(ErreurComptoir):
    pass


def creer_client() -> anthropic.Anthropic:
    """Le client du Comptoir : délai et réessais réglés, plutôt que les défauts du SDK."""
    return anthropic.Anthropic(timeout=config.DELAI_S, max_retries=config.REESSAIS)


def estimer_maximum(client, requete: dict) -> float:
    compte = client.messages.count_tokens(**{k: v for k, v in requete.items() if k in CHAMPS_COMPTAGE})
    # Avec un point de cache, l'entrée peut être écrite dans le cache : plus chère que l'entrée (chapitre 11).
    return cout_maximal(requete["model"], compte.input_tokens, requete["max_tokens"], duree_cache(requete))


@dataclass
class Reponse:
    message: object
    texte: str
    cout: Cout
    arret: Diagnostic | None  # None : la réponse s'est arrêtée normalement
    alerte: bool              # le budget du jour ou du mois approche de son plafond


def appeler(client, requete: dict, budget: Budget, client_id: str, prompt: str | None = None) -> Reponse:
    try:
        maximum = estimer_maximum(client, requete)
    except Exception as erreur:  # le comptage échoue comme l'appel échouerait : même diagnostic
        diagnostic = diagnostiquer(erreur)
        noter_evenement("comptage_impossible", client=client_id, erreur=diagnostic.code, origine=diagnostic.origine)
        raise ErreurComptoir(diagnostic) from erreur
    decision = budget.reserver(client_id, maximum)
    if not decision.accepte:
        noter_evenement("hors_budget", motif=decision.motif, client=client_id)
        raise HorsBudget(Diagnostic(decision.motif, False, "compte", INDISPONIBLE,
                                    f"Appel refusé par le budget du Comptoir ({decision.motif})."))

    debut = time.monotonic()
    try:
        message = client.messages.create(**requete)
    except Exception as erreur:
        diagnostic = diagnostiquer(erreur)
        identifiant = getattr(erreur, "request_id", None)
        noter(identifiant, requete["model"], None, prompt=prompt, client=client_id, erreur=diagnostic.code,
              origine=diagnostic.origine, duree_ms=round((time.monotonic() - debut) * 1000))
        # Une erreur renvoyée par l'API n'est pas facturée ; une coupure réseau peut l'être
        # (la requête a pu aboutir sans que la réponse arrive) : on garde alors la réserve.
        if isinstance(erreur, anthropic.APIStatusError):
            budget.liberer(decision.reservation)
        raise ErreurComptoir(diagnostic) from erreur

    prix = cout(requete["model"], message.usage)
    budget.regler(decision.reservation, prix.dollars)
    arret = diagnostiquer_arret(message)
    noter(message._request_id, requete["model"], prix, prompt=prompt, client=client_id,
          stop_reason=message.stop_reason, duree_ms=round((time.monotonic() - debut) * 1000),
          erreur=arret.code if arret else None, origine=arret.origine if arret else None)
    texte = "".join(b.text for b in message.content if b.type == "text")
    return Reponse(message, texte, prix, arret, budget.en_alerte())
