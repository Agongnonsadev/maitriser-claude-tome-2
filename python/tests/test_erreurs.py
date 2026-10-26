"""Chaque erreur reçoit le bon diagnostic : réessayer ou corriger, et d'où elle vient."""

from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from comptoir.erreurs import INDISPONIBLE, PASSAGERE, REFUS, diagnostiquer, diagnostiquer_arret

REQUETE = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def erreur_api(classe, statut, type_erreur, message="", details=None, entetes=None):
    corps = {"type": "error", "error": {"type": type_erreur, "message": message}}
    if details:
        corps["error"]["details"] = details
    reponse = httpx2.Response(statut, json=corps, headers=entetes or {}, request=REQUETE)
    return classe(message, response=reponse, body=corps)


@pytest.mark.parametrize(
    "erreur, code, reessayer, origine",
    [
        (erreur_api(anthropic.AuthenticationError, 401, "authentication_error"), "cle_invalide", False, "compte"),
        (erreur_api(anthropic.APIStatusError, 402, "billing_error"), "facturation", False, "compte"),
        (erreur_api(anthropic.PermissionDeniedError, 403, "permission_error"), "permission", False, "compte"),
        (erreur_api(anthropic.NotFoundError, 404, "not_found_error"), "introuvable", False, "integration"),
        (erreur_api(anthropic.RequestTooLargeError, 413, "request_too_large"), "requete_trop_lourde", False, "integration"),
        (erreur_api(anthropic.BadRequestError, 400, "invalid_request_error", "messages.0: bad"), "requete_invalide", False, "integration"),
        (erreur_api(anthropic.OverloadedError, 529, "overloaded_error"), "surcharge", True, "service"),
        (erreur_api(anthropic.InternalServerError, 500, "api_error"), "erreur_interne", True, "service"),
        (erreur_api(anthropic.InternalServerError, 504, "timeout_error"), "delai_api", True, "service"),
        (anthropic.APITimeoutError(request=REQUETE), "delai_depasse", True, "reseau"),
        (anthropic.APIConnectionError(request=REQUETE), "connexion", True, "reseau"),
        (httpx2.RemoteProtocolError("coupure"), "connexion", True, "reseau"),
        (KeyError("bogue"), "inconnue", False, "integration"),
    ],
)
def test_chaque_erreur_a_son_diagnostic(erreur, code, reessayer, origine):
    diagnostic = diagnostiquer(erreur)
    assert (diagnostic.code, diagnostic.reessayer, diagnostic.origine) == (code, reessayer, origine)
    assert diagnostic.pour_le_client in (PASSAGERE, INDISPONIBLE)


def test_une_limite_de_debit_se_reessaie_apres_le_delai_demande():
    erreur = erreur_api(anthropic.RateLimitError, 429, "rate_limit_error", entetes={"retry-after": "12"})
    diagnostic = diagnostiquer(erreur)
    assert diagnostic.code == "limite_de_debit" and diagnostic.reessayer and diagnostic.attente_s == 12


def test_le_plafond_du_palier_ne_se_reessaie_pas():
    # Même statut et même type qu'une limite de débit, mais un code qui change tout.
    erreur = erreur_api(anthropic.RateLimitError, 429, "rate_limit_error",
                        "You have reached your API usage limits: ...", {"error_code": "enforced_spend_limit_reached"})
    diagnostic = diagnostiquer(erreur)
    assert diagnostic.code == "plafond_du_palier" and not diagnostic.reessayer


def test_la_limite_de_depense_que_vous_avez_fixee():
    erreur = erreur_api(anthropic.BadRequestError, 400, "invalid_request_error",
                        "You have reached your specified API usage limits. You will regain access on 2026-11-01.")
    assert diagnostiquer(erreur).code == "limite_de_depense"


def test_une_erreur_en_plein_flux_garde_le_statut_200():
    erreur = erreur_api(anthropic.APIStatusError, 200, "overloaded_error", "Overloaded")
    assert diagnostiquer(erreur).code == "surcharge"


def test_les_raisons_d_arret():
    refus = SimpleNamespace(stop_reason="refusal", stop_details=SimpleNamespace(category="cyber"))
    diagnostic = diagnostiquer_arret(refus)
    assert diagnostic.code == "refus" and "cyber" in diagnostic.pour_yao and diagnostic.pour_le_client == REFUS
    assert diagnostiquer_arret(SimpleNamespace(stop_reason="max_tokens")).code == "reponse_coupee"
    assert diagnostiquer_arret(SimpleNamespace(stop_reason="model_context_window_exceeded")).code == "contexte_plein"
    assert diagnostiquer_arret(SimpleNamespace(stop_reason="end_turn")) is None
