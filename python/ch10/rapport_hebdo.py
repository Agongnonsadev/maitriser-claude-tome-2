"""Chapitre 10 : le rapport hebdomadaire des ventes d'Awa, calculé et mis en page par l'exécution de code.

1. L'export CSV part dans le conteneur, par la Files API.
2. Claude écrit et exécute le code : totaux, graphique PNG, rapport PDF, résumé JSON.
3. Le script télécharge les fichiers, puis compare le résumé à notre propre calcul.
4. Il supprime de la Files API le fichier envoyé et les fichiers produits.

Lancement, depuis le dossier python/ :  python -m ch10.rapport_hebdo
"""

import json
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.serveur import EXECUTION_CODE, appeler, erreurs_outils, fichiers_produits
from comptoir.ventes import comparer, lire, totaux

VENTES = Path(__file__).parent / "donnees" / "ventes-2026-10-12.csv"
SORTIE = Path("rapports") / "semaine-2026-10-12"

CONSIGNE = """Voici l'export des ventes de la semaine du 12 au 18 octobre 2026 de Délices d'Awa, un fichier CSV.
Avec du code, et seulement avec du code (aucun chiffre de tête) :
1. calcule le chiffre d'affaires total en FCFA (quantite × prix_unitaire_fcfa), le nombre de commandes distinctes,
   le panier moyen arrondi à l'unité, et le chiffre d'affaires par produit (quantité et montant), par jour et par quartier ;
2. trace le chiffre d'affaires par produit en barres horizontales, lisible sur un téléphone, dans graphique.png ;
3. produis rapport.pdf, une page en français : titre, chiffres clés, tableau par produit, le graphique ;
4. écris resume.json avec exactement ces clés : chiffre_affaires_fcfa, commandes, panier_moyen_fcfa,
   par_produit (produit -> {"quantite", "montant_fcfa"}), par_jour (date ISO -> montant), par_quartier (quartier -> montant).
Copie graphique.png, rapport.pdf et resume.json dans $OUTPUT_DIR, puis liste ce dossier dans la même commande.
Termine par trois phrases pour Awa sur la semaine."""


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
            print(f"  fichier reçu : {SORTIE / nom}")

        resume = SORTIE / "resume.json"
        if resume.exists():
            ecarts = comparer(json.loads(resume.read_text(encoding="utf-8")), totaux(lire(VENTES)))
            print("\nVérification par notre code : " + ("tous les chiffres concordent." if not ecarts else "ÉCARTS"))
            for ecart in ecarts:
                print(f"  - {ecart}")
        else:
            print("\nPas de resume.json : le rapport ne peut pas être vérifié, donc pas envoyé.")

        usage = resultat.message.usage
        print(f"\n{resultat.appels} appel(s), {resultat.reprises} reprise(s) ; dernier appel : entrée {usage.input_tokens} "
              f"tokens, sortie {usage.output_tokens} ; coût en tokens {resultat.cout:.4f} $ "
              f"(≈ {resultat.cout * config.TAUX_FCFA:.0f} FCFA) ; conteneur {resultat.message.container.id if resultat.message.container else '?'}")
    finally:
        # Un fichier envoyé ou produit reste stocké tant qu'on ne le supprime pas.
        for identifiant in [envoye.id, *produits]:
            client.files.delete(identifiant)
        print("Fichiers supprimés de la Files API.")


if __name__ == "__main__":
    main()
