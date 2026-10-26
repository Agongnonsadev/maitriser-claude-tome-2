"""La boucle d'outils, écrite à la main (chapitre 9).

Claude répond ; s'il demande des outils (stop_reason « tool_use »), le code les exécute et
renvoie tous les résultats dans un seul message ; on recommence jusqu'à une réponse finale.
Chaque appel passe par comptoir.appel : budget, journal et diagnostics du chapitre 8.
"""

from dataclasses import dataclass, field

from comptoir.appel import appeler
from comptoir.budget import Budget
from comptoir.conversations import en_blocs
from comptoir.erreurs import Diagnostic, ErreurComptoir, INDISPONIBLE
from comptoir.outils import Execution, Outils

TOURS_MAX = 6  # au-delà, quelque chose tourne en rond : on s'arrête plutôt que de payer


@dataclass
class Tour:
    texte: str                        # la réponse finale de Claude, pour le client
    nouveaux_messages: list[dict]     # à ajouter à l'historique, dans l'ordre, sans rien réécrire
    execution: Execution = field(default_factory=Execution)
    arret: Diagnostic | None = None
    cout: float = 0.0                 # tous les appels du tour, en dollars (chapitre 12)


def converser(client, requete: dict, outils: Outils, budget: Budget, client_id: str,
              prompt: str | None = None, tours_max: int = TOURS_MAX) -> Tour:
    """requete : une requête du Comptoir (comptoir.assistant), dont le dernier message est celui du client."""
    messages = list(requete["messages"])
    nouveaux: list[dict] = []
    execution = Execution()
    total = 0.0
    for _ in range(tours_max):
        reponse = appeler(client, {**requete, "messages": messages}, budget, client_id, prompt)
        total += reponse.cout.dollars
        # Le message de l'assistant est gardé tel quel : réflexion, texte et appels d'outils. Dans
        # un tour d'outils, les blocs de réflexion doivent revenir intacts avec les résultats.
        assistant = {"role": "assistant", "content": en_blocs(reponse.message.content)}
        messages.append(assistant)
        nouveaux.append(assistant)
        if reponse.message.stop_reason != "tool_use":
            return Tour(reponse.texte, nouveaux, execution, reponse.arret, total)

        appels = [bloc for bloc in reponse.message.content if bloc.type == "tool_use"]
        # Tous les résultats dans UN message, dans l'ordre des appels, et rien avant eux.
        resultats = {"role": "user", "content": [outils.executer(appel, execution) for appel in appels]}
        messages.append(resultats)
        nouveaux.append(resultats)

    raise ErreurComptoir(Diagnostic("boucle_trop_longue", False, "integration", INDISPONIBLE,
                                    f"Plus de {tours_max} tours d'outils pour un seul message : lire la trace."))
