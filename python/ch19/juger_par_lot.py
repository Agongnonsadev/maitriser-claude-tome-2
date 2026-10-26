"""Chapitre 19 : le juge du chapitre 17, par la Batch API. La moitié du prix, et la même note ?

Depuis le dossier python/ :
    python -m ch19.juger_par_lot <série> --estimer                        (gratuit)
    python -m ch19.juger_par_lot <série> --attente-max 3600               (PAYANT, un lot)
    python -m ch19.juger_par_lot <série> --relire <lot>                   (gratuit : relire un lot fini)
    python -m ch19.juger_par_lot <série> --comparer                       (gratuit : le fichier du lot, sans appel)

Les jugements d'une série du chapitre 17 ne pressent pas : ils se font la nuit, ou pendant que Yao
fait autre chose. Chaque jugement devient une requête du lot, identique à celle du juge en direct
(ch17/juge.py), documents en cache compris : la documentation prévient que le cache, dans un lot, ne
sert qu'« au mieux », les requêtes passant dans n'importe quel ordre. Le script écrit les jugements à
côté de ceux du juge en direct (jugements-<modèle>-<grille>-lot.jsonl) et compare : le coût, la durée,
et l'accord entre les deux juges, puisque le même juge ne rend pas deux fois exactement la même note.
"""

import argparse
import json
import re
import sys
import time
from dataclasses import asdict, fields
from pathlib import Path

from ch17 import juge as juge_
from ch17.suite import charger_cas, lire_jugements, lire_serie
from comptoir.couts import cout
from comptoir.journal import noter

PRIX_SUPPOSE = 0.0002  # $ par jugement par lot, large (0,0004 $ en direct au chapitre 17)


def identifiant_lot(essai_id: str) -> str:
    """custom_id : lettres, chiffres, tirets et soulignés, 64 caractères au plus."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", essai_id)[:64]


def requetes(dossier: Path, modele: str) -> tuple[list[dict], dict[str, str]]:
    cas = {c["id"]: c for c in charger_cas()}
    grille = juge_.charger_grille()
    demandes, correspondance = [], {}
    for essai in lire_serie(dossier):
        if essai.erreur:
            continue
        cle = identifiant_lot(essai.identifiant)
        if cle in correspondance:  # deux essais réduits au même custom_id : leurs résultats se mélangeraient
            raise ValueError(f"custom_id en double : {cle}")
        correspondance[cle] = essai.identifiant
        demandes.append({"custom_id": cle, "params": juge_.requete(cas[essai.cas], essai, modele, grille)})
    return demandes, correspondance


def lire_resultats(client, lot: str, correspondance: dict[str, str], modele: str) -> list[juge_.Jugement]:
    grille = juge_.charger_grille()
    jugements = []
    for entree in client.messages.batches.results(lot):
        jugement = juge_.Jugement(correspondance[entree.custom_id], modele, grille.identifiant)
        if entree.result.type != "succeeded":
            jugement.erreur = f"lot : {entree.result.type}"
            jugements.append(jugement)
            continue
        message = entree.result.message
        prix = cout(modele, message.usage, lot=True)
        noter(message.id, modele, prix, prompt=grille.identifiant, stop_reason=message.stop_reason, lot=lot)
        jugement.cout_dollars = round(prix.dollars, 6)
        if message.stop_reason != "end_turn":
            jugement.erreur = f"jugement arrêté par {message.stop_reason}"
        else:
            donnees = json.loads("".join(b.text for b in message.content if b.type == "text"))
            jugement.verdicts = {c: donnees[c]["verdict"] for c in juge_.CRITERES}
            jugement.constats = {c: donnees[c]["constat"] for c in juge_.CRITERES}
        jugements.append(jugement)
    return jugements


def jugement(donnees: dict) -> juge_.Jugement:
    """Un jugement relu d'un fichier, sans les champs calculés qu'on y a écrits (« issue »)."""
    return juge_.Jugement(**{f.name: donnees[f.name] for f in fields(juge_.Jugement) if f.name in donnees})


def comparer(par_lot: list[juge_.Jugement], en_direct: dict[str, dict]) -> dict:
    communs = [j for j in par_lot if j.essai in en_direct and not j.erreur]
    meme_issue = sum(1 for j in communs if j.issue == jugement(en_direct[j.essai]).issue)
    criteres = sum(1 for j in communs for c in juge_.CRITERES if j.verdicts.get(c) == en_direct[j.essai]["verdicts"].get(c))
    return {
        "jugements_compares": len(communs),
        "meme_issue": meme_issue,
        "memes_verdicts": f"{criteres} sur {len(communs) * len(juge_.CRITERES)}",
        "cout_par_lot": round(sum(j.cout_dollars for j in par_lot), 4),
        "cout_en_direct": round(sum(en_direct[j.essai]["cout_dollars"] for j in communs), 4),
        "erreurs_par_lot": [j.erreur for j in par_lot if j.erreur],
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("serie")
    parser.add_argument("--modele", default="claude-haiku-5-5")
    parser.add_argument("--estimer", action="store_true")
    parser.add_argument("--attente-max", type=float, default=3600)
    parser.add_argument("--relire", help="un lot déjà lancé")
    parser.add_argument("--comparer", action="store_true",
                        help="comparer le fichier du lot déjà lu, sans appel (gratuit ; le journal a déjà son coût)")
    args = parser.parse_args()
    dossier = Path(args.serie)
    demandes, correspondance = requetes(dossier, args.modele)
    print(f"{len(demandes)} jugements ; estimation large : {len(demandes) * PRIX_SUPPOSE:.3f} $")
    if args.estimer:
        return 0
    sortie = dossier / f"jugements-{args.modele}-{juge_.GRILLE}-lot.jsonl"
    if args.comparer:
        jugements = [jugement(json.loads(l)) for l in sortie.read_text(encoding="utf-8").splitlines() if l.strip()]
        return ecrire_bilan(dossier, args.modele, {"lot": None, "duree_s": None}, jugements)

    from comptoir.appel import creer_client
    client = creer_client()
    debut = time.perf_counter()
    lot = args.relire
    if not lot:
        lot = client.messages.batches.create(requests=demandes).id
        print(f"Lot {lot} créé.")
        while (etat := client.messages.batches.retrieve(lot)).processing_status != "ended":
            if time.perf_counter() - debut > args.attente_max:
                print(f"Pas fini après {args.attente_max:.0f} s ; relancez avec --relire {lot}")
                return 1
            print(f"  {time.perf_counter() - debut:5.0f} s : {etat.request_counts}")
            time.sleep(30)
    duree = round(time.perf_counter() - debut, 1)
    jugements = lire_resultats(client, lot, correspondance, args.modele)
    sortie.write_text("".join(json.dumps(asdict(j), ensure_ascii=False) + "\n" for j in jugements), encoding="utf-8")
    return ecrire_bilan(dossier, args.modele, {"lot": lot, "duree_s": None if args.relire else duree}, jugements)


def ecrire_bilan(dossier: Path, modele: str, entete: dict, jugements: list[juge_.Jugement]) -> int:
    bilan = {**entete, **comparer(jugements, lire_jugements(dossier, modele, juge_.GRILLE))}
    print(json.dumps(bilan, ensure_ascii=False, indent=1))
    (dossier / f"lot-{modele}-{juge_.GRILLE}.json").write_text(json.dumps(bilan, ensure_ascii=False, indent=1),
                                                                encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
