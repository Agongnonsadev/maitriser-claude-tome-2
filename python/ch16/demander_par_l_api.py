"""Chapitre 16 : interroger le Comptoir en ligne depuis l'API, par le connecteur MCP, avec un jeton OAuth.

Lancement, depuis le dossier python/ (APPEL PAYANT), après python -m ch16.se_connecter sur la même
adresse publique (qui garde le jeton dans donnees_clients/jetons_client.json) :
    python -m ch16.demander_par_l_api https://<adresse-publique>/mcp

Le connecteur MCP ne joint qu'un serveur public, en https://. C'est à votre application d'obtenir le
jeton OAuth et de le renouveler : l'API se contente de le présenter au serveur (authorization_token).
Ici, une liste noire : tous les outils du serveur, sauf les deux qui touchent au stock. L'assistant
qui en résulte ne peut que lire.
"""

import argparse
import json
from pathlib import Path

from comptoir import config
from comptoir.appel import creer_client
from comptoir.couts import cout
from comptoir.journal import noter
from ch14.demander_a_la_doc import trace

JETONS = Path(__file__).parents[1] / "donnees_clients" / "jetons_client.json"
QUESTION = ("Combien de commandes avons-nous eues le samedi 17 octobre 2026, pour quel total, et quels produits "
            "sont en rupture de stock ?")


def requete(adresse: str, jeton: str) -> dict:
    return {
        "model": config.MODELE_DOCUMENTS,
        "max_tokens": 800,
        "system": "Tu réponds à Awa, en français, en la vouvoyant, en deux phrases, avec les chiffres exacts des outils.",
        "messages": [{"role": "user", "content": QUESTION}],
        "mcp_servers": [{"type": "url", "url": adresse, "name": "comptoir", "authorization_token": jeton}],
        "tools": [{"type": "mcp_toolset", "mcp_server_name": "comptoir",
                   # Liste noire : tout est permis, sauf ce qui écrit.
                   "configs": {"preparer_correction": {"enabled": False},
                               "appliquer_correction": {"enabled": False}}}],
        "betas": ["mcp-client-2025-11-20"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("adresse")
    args = parser.parse_args()
    if not args.adresse.startswith("https://"):
        raise SystemExit("Le connecteur MCP n'accepte qu'une adresse en https://.")
    jeton = json.loads(JETONS.read_text(encoding="utf-8"))["jetons"]["access_token"]  # jamais affiché
    params = requete(args.adresse, jeton)
    message = creer_client().beta.messages.create(**params)
    prix = cout(params["model"], message.usage)
    noter(message._request_id, params["model"], prix, client="ch16-api", stop_reason=message.stop_reason,
          origine="connecteur-mcp-oauth")
    for ligne in trace(message.content):
        print(ligne)
    texte = "".join(b.text for b in message.content if b.type == "text")
    juste = "6 commandes" in texte and "50" in texte and "500" in texte and "corossol" in texte.lower()
    print(f"\n{texte}\n\n{'Juste' if juste else 'À VÉRIFIER'} ; arrêt : {message.stop_reason} ; "
          f"{message.usage.input_tokens} tokens d'entrée ; coût : {prix.dollars:.4f} $")


if __name__ == "__main__":
    main()
