"""Chercher les bons passages quand la base ne tient plus dans le contexte (chapitre 11).

- IndexBM25 : la recherche lexicale, qui trouve les mots exacts (« Godomey », « 48 heures »).
- IndexVecteurs : la recherche par le sens, avec des embeddings. Anthropic n'en fournit pas :
  la fonction qui les calcule est passée en paramètre (Voyage AI, ou un faux pour les tests).
- fusionner : la recherche hybride, qui combine plusieurs classements (fusion des rangs).
- reclasser : Claude relit les meilleurs candidats et garde les plus utiles.
- contextualiser : Claude écrit, pour chaque morceau, la phrase qui le situe dans son document
  (Contextual Retrieval), en lisant le document depuis le cache.

Tout est en Python pur : une base de quelques milliers de morceaux n'a besoin ni de base de
données vectorielle, ni de bibliothèque de recherche.
"""

import json
import math
import os
import re
import unicodedata
import urllib.request
from collections import Counter
from collections.abc import Callable

from comptoir.connaissances import Morceau
from comptoir.couts import cout
from comptoir.journal import noter

# Des mots trop fréquents pour aider à trouver quoi que ce soit.
MOTS_VIDES = set("""
a au aux avec ce ces cet cette d dans de des du elle en est et etre il ils j je l la le les leur
leurs lui m ma mais me mes mon n ne nos notre nous on ou par pas pour qu que quel quelle quelles
quels qui s sa se ses si son sont sur t ta te tes ton tu un une vos votre vous y c ca est-ce
""".split())

Classement = list[tuple[Morceau, float]]


def mots(texte: str) -> list[str]:
    """Minuscules, sans accents, sans mots vides, et un pluriel simple ramené au singulier."""
    sans_accents = unicodedata.normalize("NFD", texte).encode("ascii", "ignore").decode().lower()
    resultat = []
    for mot in re.findall(r"[a-z0-9]+", sans_accents):
        if mot in MOTS_VIDES:
            continue
        if len(mot) > 3 and mot[-1] in "sx":
            mot = mot[:-1]
        resultat.append(mot)
    return resultat


class IndexBM25:
    """BM25 : la fréquence d'un mot dans le morceau compte, mais de moins en moins (k1), les
    mots rares comptent plus que les mots courants (idf), et un long morceau ne gagne pas
    seulement parce qu'il est long (b)."""

    def __init__(self, morceaux: list[Morceau], k1: float = 1.5, b: float = 0.75):
        self.morceaux, self.k1, self.b = morceaux, k1, b
        self.termes = [Counter(mots(m.pour_la_recherche())) for m in morceaux]
        self.longueurs = [sum(t.values()) for t in self.termes]
        self.longueur_moyenne = sum(self.longueurs) / len(morceaux) if morceaux else 0
        frequences = Counter(mot for t in self.termes for mot in t)
        n = len(morceaux)
        self.idf = {mot: math.log(1 + (n - f + 0.5) / (f + 0.5)) for mot, f in frequences.items()}

    def score(self, i: int, question: list[str]) -> float:
        termes, longueur = self.termes[i], self.longueurs[i]
        total = 0.0
        for mot in question:
            f = termes.get(mot, 0)
            if f:
                norme = 1 - self.b + self.b * longueur / self.longueur_moyenne
                total += self.idf[mot] * f * (self.k1 + 1) / (f + self.k1 * norme)
        return total

    def chercher(self, question: str, k: int = 5) -> Classement:
        q = mots(question)
        scores = [(m, self.score(i, q)) for i, m in enumerate(self.morceaux)]
        return sorted((s for s in scores if s[1] > 0), key=lambda s: -s[1])[:k]


Plongeur = Callable[[list[str], str], list[list[float]]]  # (textes, "document" ou "query") -> vecteurs


class IndexVecteurs:
    """La recherche par le sens : la question et les morceaux deviennent des vecteurs, et l'on
    garde les morceaux dont le vecteur est le plus proche de celui de la question."""

    def __init__(self, morceaux: list[Morceau], plonger: Plongeur):
        self.morceaux, self.plonger = morceaux, plonger
        self.vecteurs = plonger([m.pour_la_recherche() for m in morceaux], "document")

    def chercher(self, question: str, k: int = 5) -> Classement:
        q = self.plonger([question], "query")[0]
        scores = [(m, _cosinus(q, v)) for m, v in zip(self.morceaux, self.vecteurs)]
        return sorted(scores, key=lambda s: -s[1])[:k]


def _cosinus(a: list[float], b: list[float]) -> float:
    produit = sum(x * y for x, y in zip(a, b))
    normes = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return produit / normes if normes else 0.0


def plongeur_voyage(modele: str = "voyage-4", cle: str | None = None,
                    adresse: str = "https://ai.mongodb.com/v1/embeddings") -> Plongeur:
    """Les embeddings de Voyage AI, par l'API HTTP de MongoDB Atlas (clé dans VOYAGE_API_KEY).
    Payant au token : comptez les textes avant d'indexer une grande base."""
    cle = cle or os.environ["VOYAGE_API_KEY"]

    def plonger(textes: list[str], type_entree: str) -> list[list[float]]:
        corps = json.dumps({"input": textes, "model": modele, "input_type": type_entree}).encode()
        requete = urllib.request.Request(adresse, data=corps, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {cle}"})
        with urllib.request.urlopen(requete, timeout=60) as reponse:
            donnees = json.load(reponse)
        return [d["embedding"] for d in sorted(donnees["data"], key=lambda d: d["index"])]

    return plonger


def fusionner(*classements: Classement, k: int = 60, garder: int = 5) -> Classement:
    """Fusion des rangs (reciprocal rank fusion) : chaque index donne 1 / (k + rang) à ses
    morceaux. On additionne : un morceau bien placé par deux index passe devant. Les scores
    bruts ne se comparent pas d'un index à l'autre ; les rangs, si."""
    scores: dict[str, float] = {}
    par_id: dict[str, Morceau] = {}
    for classement in classements:
        for rang, (morceau, _) in enumerate(classement, start=1):
            scores[morceau.identifiant] = scores.get(morceau.identifiant, 0.0) + 1 / (k + rang)
            par_id[morceau.identifiant] = morceau
    meilleurs = sorted(scores.items(), key=lambda s: -s[1])[:garder]
    return [(par_id[i], s) for i, s in meilleurs]


# --- Claude au service de la recherche ---------------------------------------------------

MODELE_AUXILIAIRE = "claude-haiku-5-5"  # petites tâches à gros volume : classer, situer

SCHEMA_RECLASSEMENT = {
    "type": "object",
    "properties": {"pertinents": {"type": "array", "items": {"type": "string"}}},
    "required": ["pertinents"],
    "additionalProperties": False,
}


def requete_reclassement(question: str, candidats: list[Morceau], garder: int,
                         modele: str = MODELE_AUXILIAIRE) -> dict:
    passages = "\n\n".join(
        f'<passage id="{m.identifiant}">\n{m.titre}\n{m.texte}\n</passage>' for m in candidats)
    return {
        "model": modele,
        "max_tokens": 500,
        "system": ("Tu classes des passages de la documentation de Délices d'Awa selon leur utilité pour "
                   "répondre à une question de client. Tu ne réponds pas à la question."),
        "messages": [{"role": "user", "content": (
            f"{passages}\n\n<question>{question}</question>\n\n"
            f"Donne les identifiants des {garder} passages au plus qui aident à répondre, du plus utile au "
            "moins utile. Si aucun n'aide, renvoie une liste vide.")}],
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA_RECLASSEMENT}},
    }


def reclasser(client, question: str, candidats: list[Morceau], garder: int = 3,
              modele: str = MODELE_AUXILIAIRE) -> tuple[list[Morceau], float]:
    """Claude relit les candidats et rend les plus utiles, dans l'ordre, avec le coût en dollars.
    Un identifiant inconnu est écarté : le code ne croit pas sur parole une liste produite par
    un modèle."""
    if not candidats:
        return [], 0.0
    requete = requete_reclassement(question, candidats, garder, modele)
    message = client.messages.create(**requete)
    prix = cout(modele, message.usage)
    noter(message._request_id, modele, prix, prompt="reclassement")
    texte = "".join(b.text for b in message.content if b.type == "text")
    par_id = {m.identifiant: m for m in candidats}
    choisis = [i for i in json.loads(texte)["pertinents"] if i in par_id]
    return [par_id[i] for i in dict.fromkeys(choisis)][:garder], prix.dollars


CONSIGNE_CONTEXTE = (
    "Voici un passage de ce document :\n<passage>\n{passage}\n</passage>\n"
    "Écris une phrase courte qui situe ce passage dans l'ensemble du document, pour qu'on le "
    "retrouve mieux dans une recherche. Réponds seulement par cette phrase."
)


def requete_contexte(document: str, morceau: Morceau, modele: str = MODELE_AUXILIAIRE) -> dict:
    """Le document entier d'abord, avec un point de cache ; le passage ensuite. Du deuxième
    passage au dernier, le document est lu dans le cache, à une fraction du prix."""
    return {
        "model": modele,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": f"<document>\n{document}\n</document>",
             "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": CONSIGNE_CONTEXTE.format(passage=morceau.texte)},
        ]}],
    }


def contextualiser(client, document: str, morceaux: list[Morceau],
                   modele: str = MODELE_AUXILIAIRE) -> tuple[dict[str, str], list]:
    """Une phrase de contexte par morceau. Les appels se suivent, un par un : une entrée du
    cache n'est disponible qu'une fois la première réponse commencée. Rend aussi les usages,
    pour vérifier que le cache a bien servi."""
    contextes, usages = {}, []
    for morceau in morceaux:
        message = client.messages.create(**requete_contexte(document, morceau, modele))
        noter(message._request_id, modele, cout(modele, message.usage), prompt="contexte")
        contextes[morceau.identifiant] = "".join(b.text for b in message.content if b.type == "text").strip()
        usages.append(message.usage)
    return contextes, usages


def rappel(classement: Classement, attendus: list[str]) -> bool:
    """Le classement contient-il au moins un des morceaux attendus ? (rappel à k)"""
    return any(m.identifiant in attendus for m, _ in classement)
