"""Le Comptoir qui prend des commandes : outils, récapitulatif officiel, confirmation par le client (chapitre 9).

Le motif d'approbation est simple et ne dépend pas du modèle :
1. Claude prépare un récapitulatif avec l'outil commande_preparer ;
2. le code affiche lui-même le récapitulatif officiel, avec le total et un code à quatre chiffres ;
3. le client répond « OUI 1234 » ; ce message est lu par le code, pas par Claude ;
4. le code crée la commande, une seule fois.
"""

import re
from dataclasses import dataclass

from comptoir import assistant
from comptoir.boucle import Tour, converser
from comptoir.boutique import Boutique, RefusBoutique
from comptoir.budget import Budget
from comptoir.connaissances import Morceau, blocs_resultats
from comptoir.garde import annonce_une_transmission
from comptoir.journal import noter_evenement
from comptoir.outils import OUTILS, Outils
from comptoir.prompt import charger, message_client

VERSION_PROMPT = "v2"
CONFIRMATION = re.compile(r"^\s*oui\s+(\d{4})\s*[.!]?\s*$", re.IGNORECASE)


def rendre_recapitulatif(recap: dict) -> str:
    """Le récapitulatif que voit le client : écrit par le code, à partir des données de la boutique."""
    lignes = [f"  {l['quantite']} × {l['produit']} : {l['montant']:,} FCFA".replace(",", " ") for l in recap["lignes"]]
    frais = recap["frais_livraison"]
    return "\n".join(
        ["Récapitulatif de votre commande", *lignes,
         f"  Livraison ({recap['quartier']}, {recap['livraison_prevue']}) : "
         + ("offerte" if frais == 0 else f"{frais} FCFA"),
         f"  Total : {recap['total_fcfa']:,} FCFA".replace(",", " "),
         f"Pour confirmer, répondez exactement : OUI {recap['code_de_confirmation']}"]
    )


@dataclass
class Reponse:
    texte: str                  # ce que lit le client
    nouveaux_messages: list[dict]
    tour: Tour | None = None    # None : la réponse vient du code (confirmation)


class ComptoirCommandes:
    """Une conversation avec le Comptoir, outils compris. L'historique est en ajout seul."""

    def __init__(self, client, boutique: Boutique, budget: Budget, conversation: str,
                 version_prompt: str = VERSION_PROMPT, connaissances: list[Morceau] | None = None,
                 cache: bool | str = False, modele: str | None = None, effort: str | None = None):
        """Chapitre 11 : version_prompt="v3", la base d'Awa en connaissances, et le cache.

        cache="1h" : le début commun à tous les clients (outils, prompt, base) est gardé une heure ;
        la fin de chaque conversation, elle, reste en cache automatique de 5 minutes.
        modele (chapitre 17) : None pour le modèle de config ; un autre, pour l'évaluer.
        effort (chapitre 19) : l'effort de ce modèle, constant pendant toute la conversation (en changer
        invaliderait le cache) ; None pour le défaut du modèle.
        """
        self.client, self.boutique, self.budget, self.conversation = client, boutique, budget, conversation
        self.modele, self.effort = modele, effort
        self.prompt = charger(version_prompt)
        self.cache = bool(cache)
        # Les blocs sont construits une fois pour toutes : identiques d'un tour à l'autre.
        self.blocs = blocs_resultats(connaissances, cache=cache) if connaissances else None
        self.historique: list[dict] = []

    def requete(self, texte: str) -> dict:
        requete = assistant.construire_requete(texte, historique=self.historique, prompt=self.prompt,
                                               cache=self.cache, connaissances=self.blocs, modele=self.modele,
                                               effort=self.effort)
        # Les outils ne changent pas pendant une conversation : les modifier invaliderait la réflexion
        # préservée de tous les tours précédents (chapitre 6).
        requete["tools"] = OUTILS
        return requete

    def repondre(self, texte: str) -> Reponse:
        confirmation = CONFIRMATION.match(texte)
        if confirmation:
            reponse = self._confirmer(texte, confirmation.group(1))
        else:
            tour = converser(self.client, self.requete(texte), Outils(self.boutique, self.conversation),
                             self.budget, self.conversation, self.prompt.identifiant)
            if tour.arret and tour.arret.code == "refus":
                # Comme au chapitre 8 : la réponse refusée est jetée, et le tour n'entre pas dans l'historique.
                return Reponse(tour.arret.pour_le_client, [], tour)
            visible = tour.texte
            if annonce_une_transmission(tour.texte) and not tour.execution.transmissions:
                # Chapitre 18 : le client a lu « je transmets votre demande à Awa » ; le code tient la promesse
                # que le modèle a faite sans appeler l'outil. Awa reçoit le message du client, tel quel.
                demande = self.boutique.transmettre(self.conversation, "autre",
                                                    f"Transmission annoncée au client par le Comptoir. Son message : "
                                                    f"{texte[:300]}")
                tour.execution.transmissions.append(demande)
                noter_evenement("garde", regle="transmission_annoncee", demande=demande["demande"])
            if tour.execution.recapitulatif:
                visible = f"{visible}\n\n{rendre_recapitulatif(tour.execution.recapitulatif)}"
            question = {"role": "user", "content": message_client(texte)}
            reponse = Reponse(visible, [question, *tour.nouveaux_messages], tour)
        self.historique.extend(reponse.nouveaux_messages)
        return reponse

    def _confirmer(self, texte: str, code: str) -> Reponse:
        """La confirmation ne passe pas par Claude : le code lit le message et crée la commande."""
        try:
            commande = self.boutique.confirmer(self.conversation, code)
            # Le séparateur des milliers est remplacé dans le nombre seul, pas dans la phrase.
            total = f"{commande['total_fcfa']:,}".replace(",", " ")
            visible = (f"Votre commande {commande['commande']} est enregistrée, pour un total de "
                       f"{total} FCFA. Awa vous contacte pour la livraison. Merci !")
            if commande["deja_enregistree"]:
                visible = f"Votre commande {commande['commande']} était déjà enregistrée : rien n'a été ajouté."
        except RefusBoutique as refus:
            visible = f"Je n'ai pas pu confirmer : {refus}"
        # L'échange entre dans l'historique, pour que Claude sache, au tour suivant, ce qui s'est passé.
        echange = [{"role": "user", "content": message_client(texte)},
                   {"role": "assistant", "content": [{"type": "text", "text": visible}]}]
        return Reponse(visible, echange)
