"""Chapitre 11 : les mêmes questions, sans cache puis avec, et ce que dit le champ usage.

Trois expériences :
1. un prompt trop court pour le cache : aucune erreur, mais rien n'est mis en cache ;
2. cinq questions, toute la base dans la requête, sans cache ;
3. les mêmes, avec un point de cache après la base, précédées d'un préchauffage (max_tokens=0).

Lancement, depuis le dossier python/ :  python -m ch11.cache_avant_apres --budget-max 0.5
"""

import argparse
import time

import anthropic

from ch11.outils_communs import charger_questions
from comptoir import config, documentaire
from comptoir.connaissances import charger_base
from comptoir.couts import cout
from comptoir.journal import noter

ENTETE = f"{'série':10} {'n°':>3} {'entrée':>7} {'écrit':>7} {'lu':>7} {'sortie':>7} {'coût ($)':>9} {'durée':>7}"


def ligne(serie: str, numero: int, prix, duree: float) -> str:
    return (f"{serie:10} {numero:>3} {prix.entree:>7} {prix.ecriture_cache:>7} {prix.lecture_cache:>7} "
            f"{prix.sortie:>7} {prix.dollars:>9.5f} {duree:>6.1f}s")


def appeler(client, requete: dict, etiquette: str):
    debut = time.perf_counter()
    message = client.messages.create(**requete)
    duree = time.perf_counter() - debut
    prix = cout(requete["model"], message.usage)
    noter(message._request_id, requete["model"], prix, prompt=etiquette)
    return prix, duree


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--questions", type=int, default=5)
    parser.add_argument("--budget-max", type=float, default=0.5)
    args = parser.parse_args()

    client = anthropic.Anthropic()
    base = charger_base()
    prompt = documentaire.charger_prompt()
    questions = [c.question for c in charger_questions()[: args.questions]]
    depense = 0.0

    print("1. Un prompt trop court pour le cache")
    court = {"model": config.MODELE, "max_tokens": 50,
             "system": [{"type": "text", "text": "Tu es le Comptoir de Délices d'Awa.",
                         "cache_control": {"type": "ephemeral"}}],
             "messages": [{"role": "user", "content": "Bonjour"}]}
    prix, duree = appeler(client, court, "trop-court")
    depense += prix.dollars
    print(f"   écrit en cache : {prix.ecriture_cache}, lu dans le cache : {prix.lecture_cache}, entrée : {prix.entree} "
          "(en dessous de la longueur minimale, le point de cache est ignoré, sans erreur)\n")

    print(ENTETE)
    totaux = {}
    for serie, cache in (("sans cache", False), ("avec cache", True)):
        total = 0.0
        if cache:
            # Préchauffage : la base est écrite dans le cache avant la première vraie question.
            prechauffage = documentaire.construire_requete("préchauffage", base, prompt, cache=True)
            prechauffage["max_tokens"] = 0
            prix, duree = appeler(client, prechauffage, "prechauffage")
            print(ligne("préchauff.", 0, prix, duree))
            total += prix.dollars
        for numero, question in enumerate(questions, start=1):
            if depense + total >= args.budget_max:
                print(f"Budget de {args.budget_max} $ atteint : arrêt.")
                return
            prix, duree = appeler(client, documentaire.construire_requete(question, base, prompt, cache=cache),
                                  f"{prompt.identifiant}/{serie}")
            print(ligne(serie, numero, prix, duree))
            total += prix.dollars
        totaux[serie] = total
        depense += total
    print(f"\nTotal sans cache : {totaux['sans cache']:.4f} $ ; avec cache, préchauffage compris : "
          f"{totaux['avec cache']:.4f} $ ; dépense du script : {depense:.4f} $")


if __name__ == "__main__":
    main()
