"""Le Comptoir livré, derrière ses canaux (chapitre 19) : le chat web et WhatsApp.

Jusqu'ici, le chat web du chapitre 6 parlait à un assistant sans outils, et le Comptoir aiguillé ne
vivait que dans les bancs d'essai, une conversation en mémoire. En ligne, chaque message :
1. retrouve sa conversation dans la base (comptoir/conversations.py), ou en ouvre une ;
2. réserve son coût dans le budget, pour le message entier ;
3. passe par le Comptoir aiguillé (chapitre 12), avec ses outils, sa confirmation par code et ses gardes ;
4. ajoute à la conversation ce que le tour a produit, sans rien réécrire, puis règle le coût réel ;
5. laisse dans le journal un événement « message » : canal, catégorie, coût de toutes les étapes, durée.
   C'est ce que lit le tableau de bord : le coût par conversation, la latence par message.

Pourquoi le budget au niveau du message : depuis l'aiguilleur, le routage, l'assistant documentaire et
la chaîne des réclamations appellent Claude sans passer par comptoir/appel.py ; le budget du chapitre 8
ne voyait que les appels du Comptoir lui-même. Le service réserve donc un plafond par message, avec le
quota du client et celui de son groupe (son adresse sur le web, son numéro sur WhatsApp), puis règle
ce que la trace a vraiment coûté, toutes étapes comprises.

Un message à la fois pour tout le Comptoir (un seul fil d'exécution, côté serveur web) : les bases
SQLite sont partagées, et une transaction ne doit pas en croiser une autre. À 40 conversations par
jour, l'attente est rare ; au-delà, une connexion par fil ou une base comme PostgreSQL.
"""

import json
import threading
import time
from dataclasses import dataclass

import anthropic

from comptoir import config
from comptoir.aiguillage import ComptoirAiguille
from comptoir.budget import Budget
from comptoir.erreurs import INDISPONIBLE, ErreurComptoir, diagnostiquer
from comptoir.journal import noter_evenement
from comptoir.prompt import charger

# Le plafond réservé pour un message, avant de connaître son coût : large devant les coûts mesurés
# (0,0009 $ par message en moyenne sur le Comptoir livré, au chapitre 17 ; une réclamation, rédigée par
# Claude Sonnet 5.5, quelques millièmes de dollar).
RESERVE_MESSAGE = 0.02
TOKENS_DE_LA_BASE = 7000  # la base d'Awa, jointe à chaque requête (environ 6 900 tokens, chapitre 17)


@dataclass
class Tour:
    texte: str
    conversation: str
    categorie: str
    cout_dollars: float = 0.0
    duree_ms: int = 0
    erreur: str | None = None


def estimer_tokens(historique: list[dict]) -> int:
    """La taille du contexte, à peu près : environ 3 caractères par token en français, plus la base.
    Elle sert seulement à fermer une conversation trop longue (config.CONTEXTE_MAX)."""
    return len(json.dumps(historique, ensure_ascii=False)) // 3 + TOKENS_DE_LA_BASE


class ServiceComptoir:
    def __init__(self, client, boutique, budget: Budget, conversations, base, **options):
        """options : celles de ComptoirAiguille (version_prompt, effort_comptoir, cache…), pour une variante."""
        self.client, self.boutique, self.budget, self.conversations, self.base = client, boutique, budget, conversations, base
        self.options = options
        self.prompt = charger(options.get("version_prompt", "v5")).identifiant
        self._verrou = threading.Lock()

    def ouvrir(self, conversation: str | None) -> tuple[str, str | None, bool]:
        """(la conversation à utiliser, le motif si l'ancienne était close, True si elle est neuve)."""
        motif = None
        if conversation and self.conversations.existe(conversation):
            motif = self.conversations.motif_de_cloture(conversation, self.prompt)
            if motif is None:
                return conversation, None, False
        elif conversation:
            motif = "inconnue"
        return self.conversations.creer(self.prompt), motif, True

    def repondre(self, conversation: str, texte: str, canal: str, groupe: str | None = None) -> Tour:
        with self._verrou:
            return self._repondre(conversation, texte, canal, groupe)

    def _repondre(self, conversation: str, texte: str, canal: str, groupe: str | None) -> Tour:
        decision = self.budget.reserver(conversation, RESERVE_MESSAGE, groupe=groupe)
        if not decision.accepte:
            noter_evenement("hors_budget", motif=decision.motif, client=conversation, canal=canal)
            return Tour(INDISPONIBLE, conversation, "hors_budget", erreur=decision.motif)
        historique = self.conversations.historique(conversation)
        # Le budget de chaque appel est tenu ici, au niveau du message : le Comptoir reçoit un budget
        # vierge, qui ne refuse rien et ne compte rien deux fois.
        comptoir = ComptoirAiguille(self.client, self.boutique, Budget(":memory:"), conversation, self.base,
                                    **self.options)
        comptoir.comptoir.historique = list(historique)
        debut = time.perf_counter()
        try:
            reponse = comptoir.repondre(texte)
        except (ErreurComptoir, anthropic.APIError) as erreur:
            # L'aiguilleur, l'assistant documentaire et les réclamations appellent Claude hors de comptoir/appel.py
            # (chapitre 12) : leurs erreurs arrivent brutes. Le diagnostic du chapitre 8 se fait donc ici aussi.
            diagnostic = erreur.diagnostic if isinstance(erreur, ErreurComptoir) else diagnostiquer(erreur)
            duree = round((time.perf_counter() - debut) * 1000)
            # Le coût d'un échec n'est pas connu du code : la réservation reste, la Console fait foi.
            noter_evenement("message", canal=canal, conversation=conversation, erreur=diagnostic.code,
                            origine=diagnostic.origine, duree_ms=duree)
            return Tour(diagnostic.pour_le_client, conversation, "erreur", duree_ms=duree, erreur=diagnostic.code)
        nouveaux = comptoir.comptoir.historique[len(historique):]
        if nouveaux:
            self.conversations.ajouter_tour(conversation, nouveaux, estimer_tokens(comptoir.comptoir.historique))
        cout = reponse.trace.cout
        self.budget.regler(decision.reservation, cout)
        noter_evenement("message", canal=canal, conversation=conversation, categorie=reponse.categorie,
                        cout_dollars=round(cout, 6), duree_ms=reponse.trace.duree_ms,
                        etapes=len(reponse.trace.etapes))
        return Tour(reponse.texte, conversation, reponse.categorie, cout, reponse.trace.duree_ms)
