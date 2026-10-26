"""Les outils qu'Anthropic exécute pour vous : recherche web, lecture de pages, exécution de code (chapitre 10).

Vous les déclarez dans la requête ; l'API les exécute pendant la requête et met leurs
résultats dans la réponse. Votre code n'exécute rien, mais il lit tout : les sources
citées, les erreurs (qui arrivent dans une réponse 200), les fichiers produits, le coût.
"""

from dataclasses import dataclass, field

from comptoir.couts import Cout, cout
from comptoir.journal import noter

# Les recherches partent de Cotonou : les résultats locaux passent devant. Sans le pays :
# le 20 octobre 2026, l'API refusait le code « BJ » (« Country code BJ is not supported », 400).
LIEU_COTONOU = {"type": "approximate", "city": "Cotonou", "timezone": "Africa/Porto-Novo"}


def recherche_web(max_uses: int = 3, domaines: list[str] | None = None, filtrage_dynamique: bool = False) -> dict:
    """Le filtrage dynamique (versions 20260209 et suivantes) fait trier les résultats par du
    code avant qu'ils n'entrent dans le contexte : moins de tokens, mais plus de ZDR par défaut."""
    outil = {
        "type": "web_search_20260209" if filtrage_dynamique else "web_search_20250305",
        "name": "web_search",
        "max_uses": max_uses,
        "user_location": LIEU_COTONOU,
    }
    if domaines:
        outil["allowed_domains"] = domaines
    return outil


def lecture_web(max_uses: int = 2, max_content_tokens: int = 8000, citations: bool = True,
                domaines: list[str] | None = None) -> dict:
    """max_content_tokens borne ce qu'une page coûte : une page moyenne pèse déjà 2 500 tokens."""
    outil = {
        "type": "web_fetch_20250910",
        "name": "web_fetch",
        "max_uses": max_uses,
        "max_content_tokens": max_content_tokens,
        "citations": {"enabled": citations},
    }
    if domaines:
        outil["allowed_domains"] = domaines
    return outil


EXECUTION_CODE = {"type": "code_execution_20250825", "name": "code_execution"}


@dataclass
class Resultat:
    message: object                 # le dernier message
    texte: str
    cout: float                     # en dollars, tous les appels de la requête, recherches comprises
    appels: int
    recherches: int
    reprises: int                   # nombre de pause_turn traités
    messages: list[object] = field(default_factory=list)


def appeler(client, requete: dict, reprises_max: int = 3, prompt: str | None = None) -> Resultat:
    """Un appel avec outils serveur, en reprenant les pauses (pause_turn) jusqu'à reprises_max fois.

    Une pause n'est pas une erreur : la boucle d'outils côté serveur a fait une pause. On
    renvoie la réponse telle quelle, avec les mêmes outils, et Claude continue.
    """
    messages = list(requete["messages"])
    total, recherches, recus = 0.0, 0, []
    for reprise in range(reprises_max + 1):
        message = client.messages.create(**{**requete, "messages": messages})
        prix: Cout = cout(requete["model"], message.usage)
        noter(message._request_id, requete["model"], prix, prompt=prompt, stop_reason=message.stop_reason)
        total += prix.dollars
        recherches += prix.recherches
        recus.append(message)
        if message.stop_reason != "pause_turn":
            return Resultat(message, texte(message), total, len(recus), recherches, reprise, recus)
        messages = messages + [{"role": "assistant", "content": message.content}]
    raise RuntimeError(f"Toujours en pause après {reprises_max} reprises : relancez plus tard ou réduisez max_uses.")


def texte(message) -> str:
    """Le texte de la réponse. Avec les citations, il arrive en plusieurs blocs, à recoller."""
    return "".join(bloc.text for bloc in message.content if bloc.type == "text")


def sources(message) -> list[dict]:
    """Les sources citées, sans doublon, dans l'ordre d'apparition. À montrer au lecteur."""
    vues, liste = set(), []
    for bloc in message.content:
        for citation in getattr(bloc, "citations", None) or []:
            cle = getattr(citation, "url", None) or getattr(citation, "document_title", None)
            if cle and cle not in vues:
                vues.add(cle)
                liste.append({"source": cle, "titre": getattr(citation, "title", None) or getattr(citation, "document_title", None)})
    return liste


def erreurs_outils(message) -> list[str]:
    """Les erreurs des outils serveur. Elles n'interrompent rien : elles arrivent dans une réponse 200."""
    erreurs = []
    for bloc in message.content:
        if not bloc.type.endswith("_tool_result"):
            continue
        contenu = getattr(bloc, "content", None)
        code = getattr(contenu, "error_code", None)
        if code:
            erreurs.append(f"{bloc.type} : {code}")
    return erreurs


def fichiers_produits(message) -> list[str]:
    """Les identifiants des fichiers créés par l'exécution de code, à télécharger par la Files API."""
    identifiants = []
    for bloc in message.content:
        if bloc.type != "bash_code_execution_tool_result":
            continue
        resultat = bloc.content
        if getattr(resultat, "type", None) == "bash_code_execution_result":
            identifiants += [sortie.file_id for sortie in resultat.content if getattr(sortie, "file_id", None)]
    return identifiants
