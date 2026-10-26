"""Reconnaître chaque erreur, et savoir quoi en faire (chapitre 8).

Deux questions pour chaque échec :
- faut-il réessayer ? Oui si la même requête peut réussir plus tard (surcharge, coupure,
  limite de débit) ; non s'il faut corriger quelque chose (clé, requête, budget) ;
- d'où vient-il ? Du réseau, du service d'Anthropic, de notre code (l'intégration), de
  notre compte, ou de la réponse du modèle. C'est ce qui dit qui doit agir.

Les classes d'erreur sont celles du SDK anthropic 1.x, vérifiées dans sa version 1.15.0.
"""

from dataclasses import dataclass

import anthropic
import httpx2

# Ce que voit le client d'Awa : jamais de détail technique, toujours le vouvoiement.
PASSAGERE = "Le Comptoir est très sollicité en ce moment. Réessayez dans un instant."
INDISPONIBLE = "Le Comptoir ne peut pas répondre pour le moment. Awa vous répondra directement, dès que possible."
REFUS = "Je ne peux pas répondre à cette demande. Awa vous répondra directement, dès que possible."
ECOURTEE = "Ma réponse a été écourtée. Pouvez-vous poser votre question en plus court ?"


@dataclass(frozen=True)
class Diagnostic:
    code: str               # court et stable, pour le journal et le tableau de bord
    reessayer: bool         # la même requête, plus tard, peut-elle réussir ?
    origine: str            # reseau, service, integration, compte, modele
    pour_le_client: str
    pour_yao: str           # ce qu'il faut faire
    attente_s: float | None = None  # ce que demande l'en-tête retry-after


class ErreurComptoir(Exception):
    def __init__(self, diagnostic: Diagnostic):
        super().__init__(f"{diagnostic.code} : {diagnostic.pour_yao}")
        self.diagnostic = diagnostic


def _corps(erreur: anthropic.APIStatusError) -> dict:
    return erreur.body if isinstance(erreur.body, dict) else {}


def _attente(erreur: anthropic.APIStatusError) -> float | None:
    valeur = erreur.response.headers.get("retry-after")
    try:
        return float(valeur) if valeur is not None else None
    except ValueError:
        return None


def diagnostiquer(erreur: BaseException) -> Diagnostic:
    """Le diagnostic d'une exception levée par un appel à l'API."""
    if isinstance(erreur, anthropic.APIStatusError):
        corps = _corps(erreur).get("error", {})
        message = corps.get("message", "")
        code_detail = (corps.get("details") or {}).get("error_code")
        statut = erreur.status_code

        if isinstance(erreur, anthropic.AuthenticationError):  # 401
            return Diagnostic("cle_invalide", False, "compte", INDISPONIBLE,
                              "Clé refusée : mal copiée, révoquée ou expirée. Créez-en une autre dans la Console.")
        if statut == 402:
            return Diagnostic("facturation", False, "compte", INDISPONIBLE,
                              "Problème de facturation : vérifiez les crédits et le moyen de paiement dans la Console.")
        if isinstance(erreur, anthropic.PermissionDeniedError):  # 403
            return Diagnostic("permission", False, "compte", INDISPONIBLE,
                              "La clé n'a pas accès à cette ressource : vérifiez son espace de travail.")
        if isinstance(erreur, anthropic.NotFoundError):  # 404
            return Diagnostic("introuvable", False, "integration", INDISPONIBLE,
                              "Modèle ou ressource introuvable : vérifiez COMPTOIR_MODELE (modèle retiré ?).")
        if isinstance(erreur, anthropic.RequestTooLargeError):  # 413
            return Diagnostic("requete_trop_lourde", False, "integration", INDISPONIBLE,
                              "Requête au-delà de la taille permise (32 Mo) : réduisez les images, ou la Files API.")
        if isinstance(erreur, anthropic.RateLimitError):  # 429
            if code_detail == "enforced_spend_limit_reached":
                # Même type d'erreur qu'une limite de débit, mais sans retry-after : réessayer
                # ne sert à rien avant le mois suivant.
                return Diagnostic("plafond_du_palier", False, "compte", INDISPONIBLE,
                                  "Plafond mensuel du palier atteint : demandez un palier supérieur dans la Console.")
            return Diagnostic("limite_de_debit", True, "compte", PASSAGERE,
                              "Limite de débit atteinte : étalez les appels, ou demandez des limites plus hautes.",
                              _attente(erreur))
        if isinstance(erreur, anthropic.BadRequestError):  # 400
            if "usage limits" in message:
                return Diagnostic("limite_de_depense", False, "compte", INDISPONIBLE,
                                  "Votre limite de dépense est atteinte : relevez-la dans la Console, "
                                  "ou attendez la date indiquée dans le message.")
            return Diagnostic("requete_invalide", False, "integration", INDISPONIBLE,
                              f"Requête refusée par l'API : corrigez le code. Message : {message[:200]}")
        if isinstance(erreur, anthropic.ConflictError):  # 409
            return Diagnostic("conflit", True, "service", PASSAGERE, "Conflit passager : le SDK réessaie.")
        if isinstance(erreur, anthropic.OverloadedError) or corps.get("type") == "overloaded_error":  # 529
            return Diagnostic("surcharge", True, "service", PASSAGERE,
                              "Service surchargé : réessai automatique ; si cela dure, voir la page de statut.")
        if statut == 504 or corps.get("type") == "timeout_error":
            return Diagnostic("delai_api", True, "service", PASSAGERE,
                              "L'API a mis trop de temps : préférez le streaming pour les longues réponses.")
        if statut >= 500 or corps.get("type") == "api_error":
            return Diagnostic("erreur_interne", True, "service", PASSAGERE,
                              "Erreur interne d'Anthropic : réessai ; si elle persiste, support avec l'identifiant.")
        return Diagnostic("erreur_api", False, "integration", INDISPONIBLE, f"Erreur {statut} : {message[:200]}")

    if type(erreur).__name__ == "FluxIncomplet":  # comptoir.flux, chapitre 6
        return Diagnostic("flux_incomplet", True, "reseau", PASSAGERE,
                          "Flux fermé sans message_stop : réponse tronquée, reprise automatique.")
    if isinstance(erreur, anthropic.APITimeoutError):  # avant APIConnectionError, dont elle hérite
        return Diagnostic("delai_depasse", True, "reseau", PASSAGERE,
                          "Pas de réponse dans le délai : réseau lent, ou délai trop court (COMPTOIR_DELAI_S).")
    if isinstance(erreur, (anthropic.APIConnectionError, httpx2.TransportError)):
        return Diagnostic("connexion", True, "reseau", PASSAGERE, "Connexion à l'API impossible ou coupée.")
    return Diagnostic("inconnue", False, "integration", INDISPONIBLE,
                      f"Erreur imprévue dans le code : {type(erreur).__name__}. Lisez la trace complète.")


def diagnostiquer_arret(message) -> Diagnostic | None:
    """Le diagnostic d'une réponse arrivée, mais qui ne s'est pas arrêtée normalement."""
    raison = message.stop_reason
    if raison == "refusal":
        details = getattr(message, "stop_details", None)
        categorie = getattr(details, "category", None) or "non précisée"
        return Diagnostic("refus", False, "modele", REFUS,
                          f"Refus des classificateurs de sécurité (catégorie : {categorie}). Lire la conversation ; "
                          "si la demande était légitime, un autre modèle peut y répondre (repli).")
    if raison == "max_tokens":
        return Diagnostic("reponse_coupee", False, "integration", ECOURTEE,
                          "Réponse coupée par max_tokens : relevez le plafond, ou demandez des réponses plus courtes.")
    if raison == "model_context_window_exceeded":
        return Diagnostic("contexte_plein", False, "integration", INDISPONIBLE,
                          "La fenêtre de contexte est pleine : réduisez l'historique (chapitre 6).")
    if raison == "pause_turn":
        return Diagnostic("pause", True, "modele", PASSAGERE,
                          "Boucle d'outils serveur en pause : renvoyer la réponse telle quelle pour continuer (chapitre 10).")
    return None
