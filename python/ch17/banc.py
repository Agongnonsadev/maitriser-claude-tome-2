"""Le banc d'essai du chapitre 17 : un cas, une variante, un essai, dans un environnement neuf.

Chaque essai part de zéro : une boutique en mémoire avec le stock du chapitre 9, une horloge
arrêtée (un mardi à 10 h, heure de Cotonou), un budget vide, une conversation neuve. Rien ne
passe d'un essai à l'autre : un essai qui réussit grâce au précédent ne mesure rien.

Le client d'API est enveloppé par un enregistreur : chaque appel y laisse le modèle, l'arrêt,
les tokens, la durée, le coût, ce que Claude a écrit ou demandé, et les résultats d'outils
qu'il a reçus. C'est la transcription de l'essai, à relire quand un cas échoue.

Les messages de ce jeu sont des cas de test, pas des messages de clients : ils peuvent
figurer dans les résultats, ce que le journal du Comptoir, lui, ne fait jamais.
"""

import random
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime

from comptoir.aiguillage import ComptoirAiguille
from comptoir.boutique import COTONOU, Boutique
from comptoir.budget import Budget
from comptoir.couts import cout
from comptoir.erreurs import ErreurComptoir

HEURE_DES_ESSAIS = datetime(2026, 10, 20, 10, 0, tzinfo=COTONOU)  # un mardi, avant midi
DEBUT_RECAPITULATIF = "\n\nRécapitulatif de votre commande"


@dataclass(frozen=True)
class Variante:
    """Ce qui change d'une version du Comptoir à l'autre. Les défauts sont la version livrée au chapitre 17 ;
    depuis le chapitre 18, la version livrée a le prompt v5 (suite.VARIANTES["livree"])."""

    nom: str
    modele_comptoir: str | None = None   # None : celui de la version livrée, config.MODELE_COMPTOIR
    version_prompt: str = "v3"
    version_documents: str = "v1"
    effort_comptoir: str | None = None   # chapitre 19 : None, l'effort de la version livrée


def _resume_bloc(bloc) -> dict:
    if bloc.type == "text":
        return {"type": "text", "text": bloc.text}
    if bloc.type == "tool_use":
        return {"type": "tool_use", "name": bloc.name, "input": bloc.input}
    return {"type": bloc.type}  # la réflexion : on note qu'elle a eu lieu, pas son contenu


def _resultats_recus(requete: dict) -> list[dict]:
    """Les résultats d'outils envoyés avec cet appel : la réponse de la boutique au tour précédent."""
    dernier = requete["messages"][-1]
    if dernier["role"] != "user" or isinstance(dernier["content"], str):
        return []
    return [{"erreur": bool(b.get("is_error")), "contenu": str(b.get("content"))[:300]}
            for b in dernier["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]


class Enregistreur:
    """Se présente comme le client du SDK (client.messages.create) et garde une trace de chaque appel."""

    def __init__(self, client):
        self._client = client
        self.messages = self
        self.appels: list[dict] = []
        self._verrou = threading.Lock()

    def count_tokens(self, **requete):
        return self._client.messages.count_tokens(**requete)

    def create(self, **requete):
        debut = time.perf_counter()
        message = self._client.messages.create(**requete)
        prix = cout(requete["model"], message.usage)
        with self._verrou:
            self.appels.append({
                "modele": requete["model"],
                "arret": message.stop_reason,
                "duree_s": round(time.perf_counter() - debut, 2),
                "cout_dollars": round(prix.dollars, 6),
                "tokens": {"entree": prix.entree, "ecriture_cache": prix.ecriture_cache,
                           "lecture_cache": prix.lecture_cache, "sortie": prix.sortie, "reflexion": prix.reflexion},
                "recu": _resultats_recus(requete),
                "rendu": [_resume_bloc(b) for b in message.content],
            })
        return message


@dataclass
class Essai:
    variante: str
    cas: str
    essai: int
    categorie: str = ""
    texte: str = ""                      # ce que lit le client, récapitulatif compris
    texte_claude: str = ""               # la part écrite par Claude, sans le récapitulatif du code
    recapitulatifs: list[dict] = field(default_factory=list)   # statut et total, lus dans la boutique
    demandes: list[str] = field(default_factory=list)          # motifs des demandes transmises à Awa
    commandes: int = 0
    outils: list[str] = field(default_factory=list)
    etapes: list[dict] = field(default_factory=list)
    appels: list[dict] = field(default_factory=list)
    cout_dollars: float = 0.0
    latence_s: float = 0.0
    erreur: str | None = None

    @property
    def identifiant(self) -> str:
        return f"{self.variante}/{self.cas}/{self.essai}"

    def en_dict(self) -> dict:
        return asdict(self)


def environnement(seed: int = 17) -> Boutique:
    """Une boutique neuve : stock du chapitre 9, horloge arrêtée, codes de confirmation reproductibles."""
    return Boutique(":memory:", horloge=lambda: HEURE_DES_ESSAIS, hasard=random.Random(seed))


def essayer(client, variante: Variante, cas: dict, numero: int, base) -> Essai:
    enregistreur, boutique, conversation = Enregistreur(client), environnement(), uuid.uuid4().hex
    comptoir = ComptoirAiguille(enregistreur, boutique, Budget(":memory:"), conversation, base,
                                modele_comptoir=variante.modele_comptoir, version_prompt=variante.version_prompt,
                                version_documents=variante.version_documents, effort_comptoir=variante.effort_comptoir)
    essai = Essai(variante.nom, cas["id"], numero)
    debut = time.perf_counter()
    try:
        reponse = comptoir.repondre(cas["message"])
        essai.categorie, essai.texte = reponse.categorie, reponse.texte
        essai.etapes = [asdict(e) for e in reponse.trace.etapes]
    except ErreurComptoir as erreur:
        essai.erreur = f"{erreur.diagnostic.code} ({erreur.diagnostic.origine})"
    except Exception as erreur:  # une panne du banc ou du code : l'essai échoue, la série continue
        essai.erreur = f"{type(erreur).__name__}: {erreur}"
    essai.latence_s = round(time.perf_counter() - debut, 2)
    essai.texte_claude = essai.texte.split(DEBUT_RECAPITULATIF)[0]
    essai.recapitulatifs = [{"statut": statut, "total": total} for _, statut, total, _ in boutique.recapitulatifs(conversation)]
    essai.demandes = [motif for _, _, motif, _ in boutique.demandes()]
    essai.commandes = len(boutique.commandes())
    essai.appels = enregistreur.appels
    essai.outils = [b["name"] for a in enregistreur.appels for b in a["rendu"] if b["type"] == "tool_use"]
    essai.cout_dollars = round(sum(a["cout_dollars"] for a in enregistreur.appels), 6)
    return essai
