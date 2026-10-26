"""Répondre à partir des documents d'Awa, avec les sources (chapitre 11).

Deux façons de donner les documents à Claude, avec la même requête et les mêmes citations :
- toute la base, mise en cache : le début de la requête ne change jamais, il est lu dans le
  cache à chaque question ;
- les seuls morceaux trouvés par une recherche (RAG) : moins de tokens, mais un début de
  requête qui change à chaque question, donc rien à mettre en cache.

Les morceaux sont des blocs search_result : chaque citation revient avec notre identifiant
(kb://faq#…), que le code peut vérifier et afficher.
"""

import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from comptoir import config
from comptoir.connaissances import Morceau, blocs_resultats
from comptoir.couts import Cout, cout
from comptoir.journal import noter
from comptoir.notation import normaliser
from comptoir.prompt import PromptSysteme, message_client

DOSSIER_PROMPTS = Path(__file__).parent / "prompts"
MAX_TOKENS = 1000


def charger_prompt(version: str = "v1") -> PromptSysteme:
    texte = (DOSSIER_PROMPTS / f"documentaire_{version}.md").read_text(encoding="utf-8").strip()
    return PromptSysteme(texte, f"documentaire-{version}")


def construire_requete(question: str, morceaux: list[Morceau], prompt: PromptSysteme | None = None,
                       cache: bool | str = True, modele: str | None = None, sans_reflexion: bool = False,
                       max_tokens: int = MAX_TOKENS, avec_citations: bool = True) -> dict:
    """Les documents d'abord, la question à la fin : c'est l'ordre que recommande Anthropic pour
    les longs documents, et le seul qui permette le cache (le début ne varie pas)."""
    prompt = prompt or charger_prompt()
    contenu = blocs_resultats(morceaux, cache=cache, citations=avec_citations) + [{"type": "text", "text": message_client(question)}]
    requete = {
        "model": modele or config.MODELE,
        "max_tokens": max_tokens,
        "system": prompt.texte,
        "messages": [{"role": "user", "content": contenu}],
    }
    if config.EFFORT and not modele:  # l'effort choisi au chapitre 3 vaut pour le modèle du Comptoir
        requete["output_config"] = {"effort": config.EFFORT}
    if sans_reflexion:  # chapitre 12 : pour Claude Haiku 5.5, qui accepte de ne pas réfléchir
        requete["thinking"] = {"type": "disabled"}
    return requete


@dataclass(frozen=True)
class Citation:
    source: str   # kb://faq#…
    titre: str
    texte: str    # le passage cité, tel qu'il est dans le document


@dataclass
class ReponseDocumentaire:
    texte: str
    citations: list[Citation]
    cout: Cout
    latence_s: float
    requete_id: str | None
    sources: list[str] = field(default_factory=list)  # les identifiants cités, sans doublon
    texte_simple: str = ""  # le même texte, sans renvois : pour un client sur WhatsApp
    arret: str = "end_turn"  # la raison de l'arrêt : une réponse coupée n'est pas une réponse (chapitre 8)


def citations(message) -> list[Citation]:
    vues, resultat = set(), []
    for bloc in message.content:
        if bloc.type != "text":
            continue
        for c in getattr(bloc, "citations", None) or []:
            if getattr(c, "type", None) != "search_result_location":
                continue
            cle = (c.source, c.cited_text)
            if cle not in vues:
                vues.add(cle)
                resultat.append(Citation(c.source, c.title or "", c.cited_text))
    return resultat


def texte_avec_renvois(message) -> str:
    """Le texte de la réponse, avec un renvoi [1], [2]… après chaque passage cité."""
    numeros: dict[str, int] = {}
    morceaux = []
    for bloc in message.content:
        if bloc.type != "text":
            continue
        morceaux.append(bloc.text)
        sources = list(dict.fromkeys(c.source for c in getattr(bloc, "citations", None) or []
                                     if getattr(c, "type", None) == "search_result_location"))
        if sources:
            for s in sources:
                numeros.setdefault(s, len(numeros) + 1)
            morceaux.append("".join(f"[{numeros[s]}]" for s in sources))
    return "".join(morceaux).strip()


@dataclass
class CasDocumentaire:
    """Une question de test, écrite avant les essais (chapitre 3)."""
    identifiant: str
    question: str
    sources: list[str] = field(default_factory=list)   # au moins une doit être citée
    un_parmi: list[str] = field(default_factory=list)  # au moins un de ces faits dans la réponse
    absente: bool = False      # la réponse n'est pas dans les documents
    orienter: bool = False     # question de santé : renvoyer vers un professionnel
    a_relire: str = ""

    @classmethod
    def depuis_dict(cls, d: dict) -> "CasDocumentaire":
        return cls(**d)


# Les façons de dire « je ne sais pas » que le code reconnaît. Une autre formulation sera
# comptée comme un échec, puis relue : la grille se corrige par écrit, jamais en douce.
NE_SAIT_PAS = re.compile(
    r"je ne trouve pas|ne figure pas|n'apparait pas|n'apparaît pas|pas d'information|aucune information|"
    r"pas cette information|je ne sais pas|n'ai pas d'information|ne précisent pas|ne mentionnent pas|"
    r"ne parlent pas|ne disent pas|don't have|do not have|couldn't find|could not find|no information",
    re.IGNORECASE)


def noter_documentaire(cas: CasDocumentaire, reponse: ReponseDocumentaire, exiger_sources: bool = True) -> list[str]:
    """Les raisons de l'échec ; une liste vide si la réponse passe les critères du code."""
    texte = normaliser(reponse.texte)
    raisons = []
    if reponse.arret != "end_turn":
        raisons.append(f"réponse arrêtée par {reponse.arret}")
    if cas.absente:
        if not NE_SAIT_PAS.search(reponse.texte):
            raisons.append("ne dit pas que l'information manque")
        if "awa" not in texte:
            raisons.append("ne propose pas de transmettre à Awa")
        return raisons
    if exiger_sources and not set(cas.sources) & set(reponse.sources):
        raisons.append("aucune des sources attendues n'est citée")
    if cas.un_parmi and not any(normaliser(f) in texte for f in cas.un_parmi):
        raisons.append(f"aucun de : {', '.join(cas.un_parmi)}")
    if cas.orienter and not any(m in texte for m in ("professionnel", "médecin", "medecin")):
        raisons.append("ne renvoie pas vers un professionnel de santé")
    return raisons


def repondre(client, question: str, morceaux: list[Morceau], prompt: PromptSysteme | None = None,
             cache: bool | str = True, mode: str = "contexte", modele: str | None = None,
             sans_reflexion: bool = False, max_tokens: int = MAX_TOKENS,
             avec_citations: bool = True) -> ReponseDocumentaire:
    prompt = prompt or charger_prompt()
    requete = construire_requete(question, morceaux, prompt, cache, modele, sans_reflexion, max_tokens, avec_citations)
    debut = time.perf_counter()
    message = client.messages.create(**requete)
    latence = time.perf_counter() - debut
    prix = cout(requete["model"], message.usage)
    noter(message._request_id, requete["model"], prix, prompt=prompt.identifiant, mode=mode,
          stop_reason=message.stop_reason)
    cites = citations(message)
    simple = "".join(b.text for b in message.content if b.type == "text").strip()
    return ReponseDocumentaire(texte_avec_renvois(message), cites, prix, round(latence, 2), message._request_id,
                               list(dict.fromkeys(c.source for c in cites)), simple, message.stop_reason)
