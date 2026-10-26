"""Chapitre 7 : Yao valide les commandes extraites des photos, une par une, avant tout enregistrement.

Rien n'est enregistré sans un « o » tapé par un humain, même quand aucune anomalie n'est
signalée : une commande engage un montant, une livraison et la parole d'Awa.

Lancement, depuis le dossier python/ :  python -m ch07.valider_commandes ch07/documents/bon-*.jpg
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import anthropic

from comptoir.documents import bloc_image
from comptoir.extraction import BonDeCommande, controler_bon, extraire

REGISTRE = Path("donnees_clients/commandes.jsonl")  # données de clients : hors de Git


def resume(bon: BonDeCommande) -> str:
    lignes = [f"{bon.client or '?'} — {bon.quartier or '?'} — livraison : {bon.date_livraison_lue or '?'}"]
    for ligne in bon.lignes:
        lignes.append(f"  {ligne.quantite if ligne.quantite is not None else '?'} × {ligne.produit or ligne.libelle_lu}")
    return "\n".join(lignes)


def valider(client, chemin: Path, demander=input) -> dict | None:
    resultat = extraire(client, [bloc_image(chemin)], BonDeCommande)
    print(f"\n=== {chemin.name}  ({resultat.cout})")
    if resultat.erreur:
        print(f"Échec de l'extraction : {resultat.erreur} — à saisir à la main.")
        return None
    controle = controler_bon(resultat.donnees)
    print(resume(resultat.donnees))
    print(f"Montant calculé par le code : {controle.montant_calcule if controle.montant_calcule is not None else '?'} FCFA")
    for anomalie in controle.anomalies:
        print(f"  ⚠ {anomalie}")
    if controle.montant_calcule is None:
        print("Montant incalculable : corrigez le bon avec le client avant d'enregistrer.")
        return None
    if demander("Enregistrer cette commande ? [o/N] ").strip().lower() != "o":
        print("Non enregistrée.")
        return None
    commande = {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "document": chemin.name,
        "requete": resultat.identifiant,
        "commande": resultat.donnees.model_dump(),
        "montant_fcfa": controle.montant_calcule,
        "anomalies_acceptees": controle.anomalies,
        "validee_par_un_humain": True,
    }
    REGISTRE.parent.mkdir(parents=True, exist_ok=True)
    with REGISTRE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(commande, ensure_ascii=False) + "\n")
    print("Enregistrée.")
    return commande


if __name__ == "__main__":
    client = anthropic.Anthropic()
    for nom in sys.argv[1:]:
        valider(client, Path(nom))
