"""Le Comptoir aiguillé : un routeur, trois services, une trace par message (chapitre 12).

Le gestionnaire est du code, pas un modèle : il demande la catégorie au routeur, puis confie le
message au bon exécutant, chacun avec son modèle, son prompt et ce qu'il doit voir, rien de plus.
- information : l'assistant documentaire, avec Claude Haiku 5.5 et la base d'Awa en cache, sans
  citations ni réflexion : avec les citations, Haiku réfléchit quand même, et ses réponses se
  dégradent (mesuré au chapitre 12) ; une réponse coupée part au Comptoir, comme, depuis le
  chapitre 18, une réponse qui annonce une transmission à Awa (comptoir/garde.py) ;
- commande et autre : le Comptoir du chapitre 9, avec ses outils et la base ; Claude Sonnet 5.5 au
  chapitre 12, Claude Haiku 5.5 depuis l'évaluation du chapitre 17 (config.MODELE_COMPTOIR) ;
- reclamation : la chaîne des réclamations, qui transmet tout à Awa.

Les échanges traités hors du Comptoir sont ajoutés à son historique, en texte simple : quand le
client enchaîne sur une commande, le Comptoir connaît la conversation.
"""

from dataclasses import dataclass

from comptoir import config, documentaire, reclamations
from comptoir.commandes import ComptoirCommandes
from comptoir.connaissances import Morceau
from comptoir.garde import annonce_une_transmission
from comptoir.prompt import message_client
from comptoir.routeur import MODELE_ROUTEUR, router
from comptoir.trace import Trace

MODELE_DOCUMENTS = config.MODELE_DOCUMENTS


@dataclass
class ReponseAiguillee:
    texte: str
    categorie: str
    trace: Trace


class ComptoirAiguille:
    def __init__(self, client, boutique, budget, conversation: str, base: list[Morceau],
                 modele_documents: str = MODELE_DOCUMENTS, cache: bool | str = "1h",
                 modele_comptoir: str | None = None, version_prompt: str = "v5", version_documents: str = "v1",
                 effort_comptoir: str | None = None):
        """Chapitre 17 : modele_comptoir, version_prompt et version_documents se changent pour
        évaluer une variante ; les défauts sont la version livrée (modèle : config.MODELE_COMPTOIR ;
        prompt v5 depuis le chapitre 18, qui dit au Comptoir qu'il est une IA).
        effort_comptoir (chapitre 19) : None pour config.EFFORT_COMPTOIR (le défaut du modèle s'il est vide).
        Cet effort-là a été mesuré pour le modèle livré : il ne s'applique pas à un autre modèle qu'on évalue
        (chapitre 20, relevé par la relecture de Claude)."""
        self.client, self.boutique, self.conversation, self.base = client, boutique, conversation, base
        self.modele_documents, self.cache = modele_documents, cache
        self.comptoir = ComptoirCommandes(client, boutique, budget, conversation, version_prompt=version_prompt,
                                          connaissances=base, cache=cache,
                                          modele=modele_comptoir or config.MODELE_COMPTOIR,
                                          effort=effort_comptoir or (config.EFFORT_COMPTOIR if modele_comptoir is None
                                                                     else None))
        self.prompt_documents = documentaire.charger_prompt(version_documents)

    def commande_en_cours(self) -> bool:
        return any(statut == "en_attente" for _, statut, _, _ in self.boutique.recapitulatifs(self.conversation))

    def _garder_le_fil(self, texte: str, reponse: str) -> None:
        self.comptoir.historique.extend([
            {"role": "user", "content": message_client(texte)},
            {"role": "assistant", "content": [{"type": "text", "text": reponse}]},
        ])

    def repondre(self, texte: str) -> ReponseAiguillee:
        trace = Trace()
        with trace.etape("routage", MODELE_ROUTEUR) as e:
            # Le réglage retenu par la mesure : Claude Haiku 5.5, sans réflexion.
            decision = router(self.client, texte, commande_en_cours=self.commande_en_cours(), sans_reflexion=True)
            e.noter(decision.cout, f"{decision.categorie} (par {decision.par})")
        categorie = decision.categorie

        if categorie == "information":
            reponse = self._information(texte, trace)
            if reponse is not None:
                return ReponseAiguillee(reponse, categorie, trace)
            categorie = "information, repli"  # une réponse coupée n'est pas une réponse : le Comptoir prend le relais
        if categorie == "reclamation":
            resultat = reclamations.traiter(self.client, texte, self.boutique, self.conversation, trace)
            self._garder_le_fil(texte, resultat.reponse)
            return ReponseAiguillee(resultat.reponse, categorie, trace)
        with trace.etape("comptoir", self.comptoir.prompt.identifiant) as e:
            avant = len(self.comptoir.historique)
            r = self.comptoir.repondre(texte)
            e.noter(_cout_du_tour(r), f"{len(self.comptoir.historique) - avant} messages ajoutés")
        return ReponseAiguillee(r.texte, categorie, trace)

    def _information(self, texte: str, trace: Trace) -> str | None:
        with trace.etape("documents", self.modele_documents) as e:
            r = documentaire.repondre(self.client, texte, self.base, self.prompt_documents, cache=self.cache,
                                      mode="aiguille", modele=self.modele_documents, sans_reflexion=True,
                                      avec_citations=False)
            e.noter(r.cout.dollars, r.arret)
        if r.arret != "end_turn" or not r.texte_simple:
            return None
        if annonce_une_transmission(r.texte_simple):
            # Chapitre 18 : l'assistant documentaire n'a aucun outil. Une transmission qu'il annonce
            # n'aura pas lieu : sa réponse n'est pas envoyée, le Comptoir, qui a l'outil, prend le relais.
            trace.ajouter("garde", "code", 0, 0.0, "transmission annoncée sans outil : relais au Comptoir")
            return None
        self._garder_le_fil(texte, r.texte_simple)
        return r.texte_simple


def _cout_du_tour(reponse) -> float:
    """Le coût des appels faits par le Comptoir pendant ce tour (0 pour une confirmation lue par le code)."""
    return reponse.tour.cout if reponse.tour else 0.0
