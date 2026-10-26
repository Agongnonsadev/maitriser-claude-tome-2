"""Chapitre 7 : extraire les données d'un bon de commande (photo) ou d'une facture (PDF).

Lancement, depuis le dossier python/ :
    python -m ch07.extraire ch07/documents/bon-01.jpg
    python -m ch07.extraire ch07/documents/bon-01.jpg --cote-max 1000
    python -m ch07.extraire ch07/documents/facture-01.pdf --estimer      (gratuit : compte les tokens)
"""

import argparse
import json

import anthropic

from comptoir.documents import bloc_document
from comptoir.extraction import (
    BonDeCommande,
    controler_bon,
    controler_facture,
    extraire,
    requete_extraction,
    schema_pour,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("document")
    parser.add_argument("--cote-max", type=int, help="réduire l'image avant l'envoi (en pixels)")
    parser.add_argument("--estimer", action="store_true", help="compter les tokens d'entrée, sans extraire")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    schema = schema_pour(args.document)
    blocs = [bloc_document(args.document, args.cote_max)]

    if args.estimer:
        requete = requete_extraction(blocs, schema)
        compte = client.messages.count_tokens(
            model=requete["model"],
            system=requete["system"],
            messages=requete["messages"],
            output_config=requete["output_config"],
        )
        print(f"Tokens d'entrée : {compte.input_tokens}")
        return

    resultat = extraire(client, blocs, schema)
    print(f"Coût : {resultat.cout}  (requête {resultat.identifiant})")
    if resultat.erreur:
        print(f"Échec : {resultat.erreur}")
        return
    print(json.dumps(resultat.donnees.model_dump(), ensure_ascii=False, indent=2))
    controle = (controler_bon if schema is BonDeCommande else controler_facture)(resultat.donnees)
    print(f"\nMontant calculé par le code : {controle.montant_calcule}")
    for anomalie in controle.anomalies:
        print(f"  ⚠ {anomalie}")
    print("À relire par un humain." if controle.a_relire else "Aucune anomalie : à valider par un humain.")


if __name__ == "__main__":
    main()
