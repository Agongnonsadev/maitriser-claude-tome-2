"""Chapitre 7 : répondre à une question sur les conditions d'un fournisseur, en citant le passage.

Avec --files-api, le PDF est envoyé une fois à la Files API, désigné ensuite par son
identifiant, puis supprimé à la fin.

Lancement, depuis le dossier python/ :
    python -m ch07.citer_conditions "Sous quel délai dois-je signaler une casse ?"
    python -m ch07.citer_conditions --files-api "Quel est le minimum de commande ?" "Et le délai de paiement ?"
"""

import argparse
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.couts import cout
from comptoir.documents import bloc_fichier, bloc_pdf
from comptoir.journal import noter

PDF = Path(__file__).parent / "documents" / "conditions-fournisseur.pdf"
SYSTEME = (
    "Tu réponds aux questions de Yao, de Délices d'Awa, sur les conditions de ses fournisseurs. "
    "Tu réponds uniquement d'après le document fourni ; s'il ne contient pas la réponse, dis-le."
)


def demander(client, document: dict, question: str) -> None:
    requete = {
        "model": config.MODELE,
        "max_tokens": 1500,
        "system": SYSTEME,
        "messages": [{"role": "user", "content": [document, {"type": "text", "text": question}]}],
    }
    if config.EFFORT:
        requete["output_config"] = {"effort": config.EFFORT}  # jamais de format : incompatible avec les citations
    message = client.messages.create(**requete)
    prix = cout(requete["model"], message.usage)
    noter(message._request_id, requete["model"], prix)
    print(f"\n{question}")
    for bloc in message.content:
        if bloc.type != "text":
            continue
        print(bloc.text, end="")
        for citation in bloc.citations or []:
            print(f" [p. {citation.start_page_number} : « {citation.cited_text.strip()} »]", end="")
    print(f"\n({prix})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("questions", nargs="+")
    parser.add_argument("--files-api", action="store_true")
    args = parser.parse_args()
    client = anthropic.Anthropic()

    if not args.files_api:
        document = bloc_pdf(PDF, titre="Conditions de vente du fournisseur", citations=True)
        for question in args.questions:
            demander(client, document, question)
        return

    with PDF.open("rb") as f:
        fichier = client.files.upload(file=(PDF.name, f, "application/pdf"))
    print(f"Fichier envoyé : {fichier.id}")
    try:
        document = bloc_fichier(fichier.id, citations=True)
        for question in args.questions:
            demander(client, document, question)
    finally:
        client.files.delete(fichier.id)  # un fichier envoyé reste stocké tant qu'on ne le supprime pas
        print("Fichier supprimé.")


if __name__ == "__main__":
    main()
