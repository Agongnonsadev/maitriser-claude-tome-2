"""Les outils du Comptoir : ce que Claude peut demander, et ce que le code fait vraiment (chapitre 9).

Trois outils seulement, chacun avec une description qui dit quoi, quand, et ce qu'il ne
fait pas. Le mode strict garantit des paramètres conformes au schéma ; les règles que le
schéma ne peut pas porter (quantité au moins égale à 1, produit du catalogue) sont
vérifiées par la boutique, qui répond par une erreur explicite.

Aucun outil ne crée de commande : c'est le client qui confirme, par un code que le code
vérifie (comptoir/commandes.py).
"""

import json
from dataclasses import dataclass, field

from comptoir.boutique import Boutique, RefusBoutique


def _objet(proprietes: dict, requis: list[str]) -> dict:
    """Un objet de schéma strict : tous les champs déclarés, aucun champ en plus."""
    return {"type": "object", "properties": proprietes, "required": requis, "additionalProperties": False}


OUTILS = [
    {
        "name": "stock_verifier",
        "description": (
            "Donne la quantité disponible aujourd'hui pour un ou plusieurs produits du catalogue de Délices d'Awa. "
            "À utiliser quand un client veut commander, ou demande si un produit est disponible. "
            "Les noms doivent être ceux du catalogue, à l'identique, par exemple « Jus de bissap ». "
            "Ne renvoie ni prix ni délai : les prix sont dans le catalogue, les délais dans les conditions."
        ),
        "strict": True,
        "input_schema": _objet(
            {"produits": {"type": "array", "items": {"type": "string"},
                          "description": "Les noms exacts des produits du catalogue à vérifier."}},
            ["produits"],
        ),
    },
    {
        "name": "commande_preparer",
        "description": (
            "Prépare le récapitulatif officiel d'une commande : vérifie les produits et le stock, calcule le total "
            "avec les prix du catalogue et les frais de livraison. Ne crée pas la commande : elle n'existe qu'après "
            "la confirmation du client, que le système recueille lui-même avec un code. "
            "À appeler quand le client a dit ce qu'il veut, à quel nom et dans quel quartier de Cotonou le livrer. "
            "Si le client change d'avis, rappelle l'outil avec la nouvelle commande : le récapitulatif précédent "
            "est annulé. Si l'outil renvoie une erreur (produit inconnu, stock insuffisant, devis nécessaire), "
            "explique-la au client et propose une solution."
        ),
        "strict": True,
        "input_schema": _objet(
            {
                "lignes": {
                    "type": "array",
                    "description": "Les produits commandés, une ligne par produit.",
                    "items": _objet(
                        {"produit": {"type": "string", "description": "Le nom exact du catalogue."},
                         "quantite": {"type": "integer", "description": "Le nombre de bouteilles ou de flacons, au moins 1."}},
                        ["produit", "quantite"],
                    ),
                },
                "nom_client": {"type": "string", "description": "Le nom donné par le client pour la livraison."},
                "quartier": {"type": "string", "description": "Le quartier de livraison, à Cotonou."},
            },
            ["lignes", "nom_client", "quartier"],
        ),
    },
    {
        "name": "transmettre_a_awa",
        "description": (
            "Transmet à Awa une demande que seule elle peut traiter : remise ou prix spécial, réclamation, devis "
            "(événement, ou plus de 50 bouteilles), livraison hors de Cotonou, ou question sans réponse dans le "
            "catalogue et les conditions. Awa lit ces demandes plusieurs fois par jour et répond elle-même au client. "
            "Après l'appel, dis au client que sa demande est transmise ; ne promets ni résultat, ni autre délai "
            "que ceux des conditions."
        ),
        "strict": True,
        "input_schema": _objet(
            {
                "motif": {"type": "string", "enum": ["remise", "reclamation", "devis", "hors_zone", "autre"]},
                "resume": {"type": "string",
                           "description": "La demande en une ou deux phrases, pour qu'Awa la comprenne sans relire la conversation."},
            },
            ["motif", "resume"],
        ),
    },
]

NOMS = {outil["name"] for outil in OUTILS}


@dataclass
class Execution:
    """Ce qu'un tour d'outils a produit, en plus des résultats renvoyés à Claude."""

    recapitulatif: dict | None = None
    transmissions: list[dict] = field(default_factory=list)
    appels: list[str] = field(default_factory=list)


class Outils:
    """Exécute les outils pour une conversation donnée, sur une boutique donnée."""

    def __init__(self, boutique: Boutique, conversation: str):
        self.boutique = boutique
        self.conversation = conversation

    def executer(self, appel, execution: Execution) -> dict:
        """Un bloc tool_use en entrée, un bloc tool_result en sortie. Jamais d'exception vers la boucle."""
        execution.appels.append(appel.name)
        try:
            resultat = self._executer(appel.name, appel.input, execution)
            return {"type": "tool_result", "tool_use_id": appel.id,
                    "content": json.dumps(resultat, ensure_ascii=False)}
        except RefusBoutique as refus:
            # Une erreur instructive : ce qui ne va pas, et ce que Claude doit faire maintenant.
            return {"type": "tool_result", "tool_use_id": appel.id, "content": str(refus), "is_error": True}

    def _executer(self, nom: str, entree: dict, execution: Execution) -> dict:
        if nom == "stock_verifier":
            return {produit: (self.boutique.disponible(produit) if produit in self.boutique.catalogue
                              else "absent du catalogue") for produit in entree["produits"]}
        if nom == "commande_preparer":
            recap = self.boutique.preparer(self.conversation, entree["lignes"], entree["nom_client"], entree["quartier"])
            execution.recapitulatif = recap
            # Claude ne reçoit pas le code : le système affiche lui-même le récapitulatif officiel.
            return {cle: valeur for cle, valeur in recap.items() if cle not in ("code_de_confirmation", "a_dire_au_client")}
        if nom == "transmettre_a_awa":
            demande = self.boutique.transmettre(self.conversation, entree["motif"], entree["resume"])
            execution.transmissions.append(demande)
            return demande
        raise RefusBoutique(f"Outil « {nom} » inconnu. Outils disponibles : {', '.join(sorted(NOMS))}.")
