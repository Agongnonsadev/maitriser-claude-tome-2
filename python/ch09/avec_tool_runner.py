"""Chapitre 9 : la même boucle d'outils, confiée au Tool Runner du SDK (en bêta).

Le décorateur @beta_tool tire le schéma de l'outil des annotations de type et de la
docstring ; le runner appelle Claude, exécute les outils, renvoie les résultats et
recommence, jusqu'à une réponse sans appel d'outil, ou jusqu'à max_iterations.

Lancement, depuis le dossier python/ :  python -m ch09.avec_tool_runner
"""

import json

import anthropic
from anthropic import beta_tool

from comptoir import config
from comptoir.boutique import Boutique
from comptoir.couts import cout
from comptoir.prompt import charger

boutique = Boutique()  # en mémoire : le stock fictif du chapitre, rien n'est écrit


@beta_tool
def stock_verifier(produits: list[str]) -> str:
    """Donne la quantité disponible aujourd'hui pour des produits du catalogue de Délices d'Awa.

    À utiliser quand un client demande si un produit est disponible. Les noms doivent être
    ceux du catalogue, à l'identique. Ne renvoie ni prix ni délai.

    Args:
        produits: Les noms exacts des produits du catalogue à vérifier.
    """
    return json.dumps({p: boutique.disponible(p) if p in boutique.catalogue else "absent du catalogue"
                       for p in produits}, ensure_ascii=False)


def main() -> None:
    client = anthropic.Anthropic()
    runner = client.beta.messages.tool_runner(
        model=config.MODELE,
        max_tokens=2000,
        max_iterations=4,  # une borne, comme TOURS_MAX dans la boucle écrite à la main
        system=charger("v2").texte,
        tools=[stock_verifier],
        messages=[{"role": "user", "content": "Il vous reste du jus d'ananas et du jus de corossol ?"}],
    )
    for message in runner:  # un message par appel à Claude
        types = [bloc.type for bloc in message.content]
        # Le coût s'affiche, mais rien ne l'enregistre : ni budget ni journal, contrairement au Comptoir.
        print(f"[{message.stop_reason}] {types} {cout(config.MODELE, message.usage)}")
    final = runner.until_done()
    print("\n" + "".join(b.text for b in final.content if b.type == "text"))


if __name__ == "__main__":
    main()
