"""Chapitre 9 : jouer les 10 scénarios de commande, et vérifier par le code ce qui doit l'être.

Chaque scénario part d'une boutique neuve, en mémoire. Le code vérifie : le nombre de
commandes créées, les outils appelés, les demandes transmises à Awa, l'absence de produit
inventé, et qu'aucun message de Claude n'annonce une commande enregistrée. Le reste se
relit : le script affiche chaque échange.

Lancement, depuis le dossier python/ :
    python -m ch09.jouer_scenarios --budget-max 0.5
    python -m ch09.jouer_scenarios --seulement remise devis
"""

import argparse
import json
import re
import uuid
from pathlib import Path

from comptoir.appel import creer_client
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.commandes import ComptoirCommandes
from comptoir.erreurs import ErreurComptoir

SCENARIOS = Path(__file__).parent / "scenarios.json"

# Claude ne doit jamais annoncer une commande comme faite : seul le code le fait, après le code du client.
ANNONCE_INTERDITE = re.compile(r"commande\s+(?:\S+\s+){0,3}?(?:est|a été|bien)?\s*(?:enregistrée|confirmée|validée|créée)",
                               re.IGNORECASE)


def charger() -> list[dict]:
    return json.loads(SCENARIOS.read_text(encoding="utf-8"))


def remplacer_codes(message: str, boutique: Boutique, conversation: str) -> str | None:
    recaps = boutique.recapitulatifs(conversation)
    if "{code}" in message or "{premier_code}" in message:
        if not recaps:
            return None
        return message.replace("{code}", recaps[-1][0]).replace("{premier_code}", recaps[0][0])
    return message


def verifier(scenario: dict, boutique: Boutique, conversation: str, appels: list[str], textes_claude: list[str]) -> list[str]:
    """Les écarts entre ce qui s'est passé et ce qui était attendu. Liste vide : réussi."""
    attendu, ecarts = scenario["attendu"], []
    commandes = [c for c in boutique.commandes() if c[2] == conversation]
    if len(commandes) != attendu.get("commandes", 0):
        ecarts.append(f"{len(commandes)} commande(s) créée(s), {attendu.get('commandes', 0)} attendue(s)")
    for outil in attendu.get("outils_requis", []):
        if outil not in appels:
            ecarts.append(f"outil {outil} jamais appelé")
    produits = {l["produit"] for _, _, _, lignes in boutique.recapitulatifs(conversation) for l in json.loads(lignes)}
    for interdit in attendu.get("produits_interdits", []):
        if interdit in produits:
            ecarts.append(f"produit inventé dans un récapitulatif : {interdit}")
    if "transmis" in attendu:
        motifs = [d[2] for d in boutique.demandes() if d[1] == conversation]
        if attendu["transmis"] is None and motifs:
            ecarts.append(f"transmis à Awa sans raison : {motifs}")
        if attendu["transmis"] and attendu["transmis"] not in motifs:
            ecarts.append(f"demande « {attendu['transmis']} » non transmise (transmis : {motifs})")
    if attendu.get("premier_recapitulatif_remplace"):
        recaps = boutique.recapitulatifs(conversation)
        if len(recaps) < 2 or recaps[0][1] != "remplace":
            ecarts.append("le premier récapitulatif n'a pas été remplacé")
    for texte in textes_claude:
        if annonce_une_commande(texte):
            ecarts.append(f"Claude annonce une commande enregistrée : « {texte[:80]} »")
    return ecarts


def annonce_une_commande(texte: str) -> bool:
    """« Votre commande est enregistrée » : oui. « Elle n'est pas encore enregistrée » : non."""
    return any("pas" not in m.group(0).lower() for m in ANNONCE_INTERDITE.finditer(texte))


def jouer(client, scenario: dict, budget: Budget) -> list[str]:
    boutique, conversation = Boutique(), uuid.uuid4().hex
    comptoir = ComptoirCommandes(client, boutique, budget, conversation)
    appels, textes_claude = [], []
    print(f"\n=== {scenario['id']}")
    for message in scenario["messages"]:
        message = remplacer_codes(message, boutique, conversation)
        if message is None:
            return ["aucun récapitulatif : le code de confirmation n'existe pas"]
        print(f"Client   : {message}")
        try:
            reponse = comptoir.repondre(message)
        except ErreurComptoir as erreur:
            return [f"erreur : {erreur.diagnostic.code}"]
        print(f"Comptoir : {reponse.texte}")
        if reponse.tour:
            appels += reponse.tour.execution.appels
            textes_claude.append(reponse.tour.texte)  # le récapitulatif ajouté par le code n'en fait pas partie
    return verifier(scenario, boutique, conversation, appels, textes_claude)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget-max", type=float, default=0.5, help="dépense maximale de la série, en dollars")
    parser.add_argument("--seulement", nargs="*", help="identifiants des scénarios à jouer")
    args = parser.parse_args()

    from comptoir import config  # un budget dédié à la série : plafonds du jour et du client = budget-max
    config.BUDGET_JOUR = config.QUOTA_CLIENT_JOUR = args.budget_max
    budget, client = Budget(), creer_client()
    bilan = {}
    for scenario in charger():
        if args.seulement and scenario["id"] not in args.seulement:
            continue
        bilan[scenario["id"]] = jouer(client, scenario, budget)
    print(f"\n=== Bilan (dépense : {budget.du_jour():.4f} $)")
    for identifiant, ecarts in bilan.items():
        print(f"{'réussi' if not ecarts else 'ÉCHEC '}  {identifiant}" + "".join(f"\n         - {e}" for e in ecarts))


if __name__ == "__main__":
    main()
