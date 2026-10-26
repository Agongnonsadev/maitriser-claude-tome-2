"""Le routeur du Comptoir : un message, une catégorie, un service (chapitre 12).

Le code décide d'abord ce qu'il sait : une confirmation « OUI 1234 », une commande en cours.
Le modèle classe le reste, avec une sortie structurée qui ne peut prendre que quatre valeurs.
Il ne voit que le message : ni les outils, ni la base, ni l'historique. Un message piégé ne
peut donc rien lui faire faire d'autre que choisir une catégorie.
"""

import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from comptoir import config
from comptoir.commandes import CONFIRMATION
from comptoir.couts import cout
from comptoir.journal import noter
from comptoir.prompt import message_client

CATEGORIES = ("reclamation", "commande", "information", "autre")  # par ordre de priorité
MODELE_ROUTEUR = config.MODELE_ROUTEUR
PROMPT = (Path(__file__).parent / "prompts" / "routeur_v1.md").read_text(encoding="utf-8").strip()

SCHEMA = {
    "type": "object",
    "properties": {
        "categorie": {"type": "string", "enum": list(CATEGORIES)},
        "raison": {"type": "string"},
    },
    "required": ["categorie", "raison"],
    "additionalProperties": False,
}


class RoutageImpossible(Exception):
    """Une réponse coupée ou illisible : le message part au Comptoir, qui sait tout traiter."""


@dataclass(frozen=True)
class Decision:
    categorie: str
    raison: str
    par: str          # « code » ou le nom du modèle
    cout: float = 0.0


def requete_routage(message: str, modele: str = MODELE_ROUTEUR, effort: str | None = None,
                    sans_reflexion: bool = False) -> dict:
    output_config = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if effort:
        output_config["effort"] = effort
    requete = {
        "model": modele,
        # Assez de place pour la réflexion et le JSON : un plafond trop bas coupe la réponse.
        "max_tokens": 1000,
        "system": PROMPT,
        "messages": [{"role": "user", "content": message_client(message)}],
        "output_config": output_config,
    }
    if sans_reflexion:
        requete["thinking"] = {"type": "disabled"}  # accepté par Claude Haiku 5.5 (chapitre 3)
    return requete


def classer(client, message: str, modele: str = MODELE_ROUTEUR, effort: str | None = None,
            sans_reflexion: bool = False) -> Decision:
    """Un appel au modèle. La catégorie est validée par le code : hors des quatre, c'est une erreur."""
    requete = requete_routage(message, modele, effort, sans_reflexion)
    reponse = client.messages.create(**requete)
    prix = cout(modele, reponse.usage)
    noter(reponse._request_id, modele, prix, prompt="routeur-v1", stop_reason=reponse.stop_reason)
    if reponse.stop_reason != "end_turn":
        raise RoutageImpossible(f"réponse arrêtée par {reponse.stop_reason}")
    try:
        donnees = json.loads("".join(b.text for b in reponse.content if b.type == "text"))
    except json.JSONDecodeError as erreur:
        raise RoutageImpossible("réponse illisible") from erreur
    # La casse d'une valeur d'enum n'est pas garantie : « Information » est une information.
    categorie = str(donnees.get("categorie", "")).lower()
    if categorie not in CATEGORIES:
        raise RoutageImpossible(f"catégorie inconnue : {donnees.get('categorie')!r}")
    return Decision(categorie, donnees["raison"], modele, prix.dollars)


def par_le_code(message: str) -> Decision | None:
    """Ce que le code sait sans demander : la confirmation d'un récapitulatif."""
    if CONFIRMATION.match(message):
        return Decision("commande", "confirmation d'un récapitulatif", "code")
    return None


def router(client, message: str, commande_en_cours: bool = False, **options) -> Decision:
    try:
        decision = par_le_code(message) or classer(client, message, **options)
    except RoutageImpossible as erreur:
        # Le service le plus général : le Comptoir, dont les règles transmettent les réclamations à Awa.
        return Decision("autre", f"classement impossible ({erreur})", "repli")
    # Pendant une commande, la suite va au Comptoir, qui a l'historique et les outils.
    # Une réclamation, elle, reste une réclamation.
    if commande_en_cours and decision.categorie in ("information", "autre"):
        return Decision("commande", f"commande en cours ({decision.categorie})", decision.par, decision.cout)
    return decision


def voter(decisions: list[Decision]) -> str:
    """La catégorie la plus votée ; à égalité, la plus prioritaire : dans le doute, une réclamation
    va chez Awa plutôt que de se perdre."""
    compte = Counter(d.categorie for d in decisions)
    meilleur = max(compte.values())
    return next(c for c in CATEGORIES if compte.get(c) == meilleur)


def router_par_vote(client, message: str, votes: int = 3, **options) -> tuple[str, list[Decision]]:
    """Le même classement, plusieurs fois en parallèle (parallélisation par vote)."""
    with ThreadPoolExecutor(max_workers=votes) as executeur:
        decisions = list(executeur.map(lambda _: classer(client, message, **options), range(votes)))
    return voter(decisions), decisions
