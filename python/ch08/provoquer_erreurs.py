"""Chapitre 8 : provoquer volontairement chaque erreur, et lire le diagnostic du Comptoir.

Lancement, depuis le dossier python/ :
    python -m ch08.provoquer_erreurs              (tous les cas)
    python -m ch08.provoquer_erreurs cle budget   (certains cas)

Coût : presque nul. Les erreurs renvoyées par l'API (clé, modèle, requête invalide) ne sont
pas facturées ; le cas max_tokens fait un appel de quelques tokens ; le cas budget ne fait
qu'un comptage, gratuit.
"""

import sys

import anthropic

from comptoir import assistant, config
from comptoir.appel import appeler
from comptoir.budget import Budget
from comptoir.erreurs import ErreurComptoir, diagnostiquer, diagnostiquer_arret

QUESTION = [{"role": "user", "content": "Bonjour"}]


def montrer(nom: str, diagnostic) -> None:
    if diagnostic is None:
        print(f"{nom:10} aucune anomalie")
        return
    print(f"{nom:10} {diagnostic.code} (origine : {diagnostic.origine}, réessayer : {'oui' if diagnostic.reessayer else 'non'})")
    print(f"{'':10} client : {diagnostic.pour_le_client}")
    print(f"{'':10} Yao    : {diagnostic.pour_yao}")


def essayer(nom: str, client, **requete) -> None:
    requete = {"model": config.MODELE, "max_tokens": 50, "messages": QUESTION, **requete}
    try:
        message = client.messages.create(**requete)
    except Exception as erreur:
        montrer(nom, diagnostiquer(erreur))
        return
    montrer(nom, diagnostiquer_arret(message))


def cas_budget() -> None:
    """Un quota de client minuscule : l'appel est refusé avant de partir."""
    config.QUOTA_CLIENT_JOUR = 0.000001
    try:
        appeler(anthropic.Anthropic(), assistant.construire_requete("Bonjour"), Budget(), "essai-budget")
    except ErreurComptoir as erreur:
        montrer("budget", erreur.diagnostic)


CAS = {
    # Une clé fausse, écrite en clair exprès : elle ne donne accès à rien.
    "cle": lambda: essayer("cle", anthropic.Anthropic(api_key="sk-ant-cle-volontairement-fausse", max_retries=0)),
    "modele": lambda: essayer("modele", anthropic.Anthropic(max_retries=0), model="claude-modele-inexistant"),
    "prefill": lambda: essayer(
        "prefill", anthropic.Anthropic(max_retries=0),
        messages=QUESTION + [{"role": "assistant", "content": "Bonjour, je"}],
    ),
    "delai": lambda: essayer("delai", anthropic.Anthropic(timeout=0.001, max_retries=0)),
    "max_tokens": lambda: essayer("max_tokens", anthropic.Anthropic(), max_tokens=5),
    "budget": cas_budget,
}


if __name__ == "__main__":
    for nom in sys.argv[1:] or CAS:
        CAS[nom]()
