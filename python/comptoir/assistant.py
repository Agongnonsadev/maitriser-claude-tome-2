"""Le Comptoir, version du chapitre 5 : prompt versionné, message client balisé,
consignes d'Awa en cours de conversation.
"""

from comptoir import config
from comptoir.couts import Cout, cout
from comptoir.journal import noter
from comptoir.prompt import PromptSysteme, charger, message_client

MAX_TOKENS = 2000


def consigne_operateur(texte: str) -> dict:
    """Un message système ajouté en cours de conversation, avec l'autorité du prompt système.

    Il doit suivre immédiatement un message de l'utilisateur, et être le dernier de la
    liste ou suivi d'une réponse de l'assistant. Il ne casse pas le cache du début.
    """
    return {"role": "system", "content": texte}


def joindre_connaissances(messages: list[dict], blocs: list[dict] | None) -> list[dict]:
    """Les documents d'Awa en tête du premier message de la conversation (chapitre 11).

    Ils sont joints à chaque requête, à l'identique, et jamais enregistrés dans l'historique :
    le début de la requête ne change pas d'un tour à l'autre, ni d'un client à l'autre, et il
    peut donc être lu dans le cache.
    """
    if not blocs or not messages:
        return messages
    premier = messages[0]
    contenu = premier["content"]
    if isinstance(contenu, str):
        contenu = [{"type": "text", "text": contenu}]
    return [{**premier, "content": [*blocs, *contenu]}, *messages[1:]]


def construire_requete(
    question: str,
    historique: list[dict] | None = None,
    consignes: list[str] | None = None,
    prompt: PromptSysteme | None = None,
    cache: bool = False,
    connaissances: list[dict] | None = None,
    modele: str | None = None,
    effort: str | None = None,
) -> dict:
    """cache=True (chapitre 11) : cache automatique, dont le point avance avec la conversation.
    connaissances : les blocs search_result de la base d'Awa (comptoir.connaissances).
    modele (chapitre 17) : un autre modèle que celui de config, pour l'évaluer ; l'effort de
    config ne vaut alors plus, puisqu'il a été choisi pour le modèle du Comptoir.
    effort (chapitre 19) : l'effort de ce modèle-là, s'il a été mesuré ; None pour son défaut."""
    prompt = prompt or charger()
    messages = list(historique or [])
    messages.append({"role": "user", "content": message_client(question)})
    # Placées juste après le message du client, les consignes d'Awa s'appliquent à sa réponse.
    messages.extend(consigne_operateur(c) for c in consignes or [])
    requete = {
        "model": modele or config.MODELE,
        "max_tokens": MAX_TOKENS,
        "system": prompt.texte,
        "messages": joindre_connaissances(messages, connaissances),
    }
    if config.EFFORT and not modele:
        requete["output_config"] = {"effort": config.EFFORT}
    if effort:
        requete["output_config"] = {"effort": effort}
    if cache:
        requete["cache_control"] = {"type": "ephemeral"}
    return requete


def repondre(client, question: str, **options) -> tuple[str, Cout, object]:
    prompt = options.pop("prompt", None) or charger()
    requete = construire_requete(question, prompt=prompt, **options)
    message = client.messages.create(**requete)
    texte = "".join(b.text for b in message.content if b.type == "text")
    prix = cout(requete["model"], message.usage)
    noter(message._request_id, requete["model"], prix, prompt=prompt.identifiant)
    return texte, prix, message
