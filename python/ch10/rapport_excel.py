"""Chapitre 10 : le même rapport, en classeur Excel, avec la Skill « xlsx » d'Anthropic.

Une Skill est un dossier d'instructions et de scripts que Claude charge dans le conteneur
quand il en a besoin. Les Skills d'Anthropic (xlsx, pptx, docx, pdf) s'ajoutent par le
paramètre container, avec l'outil d'exécution de code.

Lancement, depuis le dossier python/ :  python -m ch10.rapport_excel
"""

import zipfile
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.serveur import EXECUTION_CODE, appeler, erreurs_outils, fichiers_produits

VENTES = Path(__file__).parent / "donnees" / "ventes-2026-10-12.csv"
SORTIE = Path("rapports") / "semaine-2026-10-12"

CONSIGNE = """Voici l'export des ventes de la semaine du 12 au 18 octobre 2026 de Délices d'Awa (CSV).
Produis ventes-semaine.xlsx, en français, avec trois feuilles : « Ventes » (les données brutes),
« Par produit » (quantités et montants calculés par des formules Excel à partir de la feuille Ventes)
et « Par jour » (montants par date, par formules). Mets les montants au format nombre sans décimale.
Copie le fichier dans $OUTPUT_DIR et liste ce dossier dans la même commande."""


def feuilles(classeur: Path) -> list[str]:
    """Les noms des feuilles d'un .xlsx, lus sans bibliothèque : c'est une archive zip."""
    with zipfile.ZipFile(classeur) as archive:
        contenu = archive.read("xl/workbook.xml").decode("utf-8")
    return [morceau.split('"')[0] for morceau in contenu.split('<sheet name="')[1:]]


def main() -> None:
    client = anthropic.Anthropic()
    with VENTES.open("rb") as f:
        envoye = client.files.upload(file=(VENTES.name, f, "text/csv"))
    produits: list[str] = []
    try:
        requete = {
            "model": config.MODELE,
            "max_tokens": 16000,
            "tools": [EXECUTION_CODE],
            "container": {"skills": [{"type": "anthropic", "skill_id": "xlsx", "version": "latest"}]},
            "messages": [{"role": "user", "content": [{"type": "container_upload", "file_id": envoye.id},
                                                      {"type": "text", "text": CONSIGNE}]}],
        }
        resultat = appeler(client, requete)
        print(resultat.texte)
        for erreur in erreurs_outils(resultat.message):
            print(f"  ⚠ {erreur}")
        SORTIE.mkdir(parents=True, exist_ok=True)
        for message in resultat.messages:
            produits += fichiers_produits(message)
        for identifiant in produits:
            nom = client.files.retrieve_metadata(identifiant).filename
            client.files.download(identifiant).write_to_file(SORTIE / nom)
            print(f"  fichier reçu : {SORTIE / nom}" + (f" — feuilles : {feuilles(SORTIE / nom)}" if nom.endswith(".xlsx") else ""))
        usage = resultat.message.usage
        print(f"\n{resultat.appels} appel(s) ; dernier appel : entrée {usage.input_tokens} tokens, sortie {usage.output_tokens} ; "
              f"coût en tokens {resultat.cout:.4f} $ (≈ {resultat.cout * config.TAUX_FCFA:.0f} FCFA)")
    finally:
        for identifiant in [envoye.id, *produits]:
            client.files.delete(identifiant)
        print("Fichiers supprimés de la Files API.")


if __name__ == "__main__":
    main()
