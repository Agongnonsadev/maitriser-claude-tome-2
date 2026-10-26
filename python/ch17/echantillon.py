"""Chapitre 17 : tirer les réponses qu'un humain va noter, puis étalonner le juge sur ses notes.

Depuis le dossier python/ (gratuit : aucun appel) :
    python -m ch17.echantillon tirer <série> --taille 30
    python -m ch17.echantillon page [--complement resultats/echantillon-haiku.json]   (resultats/a_noter.html)
    python -m ch17.echantillon etalonner <série> --modele claude-haiku-5-5 [--moitie etalonnage]

La page garde les notes dans le navigateur ; un bouton les télécharge en notes_humaines.json,
à poser dans resultats/.

L'échantillon prend un seul essai par cas, pour voir le plus de cas possible, et respecte la
part de chaque type (courant, piège, sécurité). Il est coupé en deux moitiés : on corrige la
grille du juge en regardant la moitié « etalonnage », et on vérifie la grille corrigée sur la
moitié « controle », qu'on n'a pas regardée. Sinon, on ajuste la grille à ces réponses-là.

L'humain note à l'aveugle, sans voir les verdicts du juge, avec les mêmes informations que lui :
le message, la réponse, le récapitulatif, ce que le système a fait, l'attendu, et les documents.
Ses notes vont dans resultats/notes_humaines.json : {essai : {critère : verdict}}.
"""

import argparse
import json
import random
from pathlib import Path

from ch17 import etalonnage
from ch17.juge import CRITERES, GRILLE, actions, documents
from ch17.suite import charger_cas, lire_jugements, lire_serie

DOSSIER = Path(__file__).parent / "resultats"
ECHANTILLON = DOSSIER / "echantillon.json"
NOTES = DOSSIER / "notes_humaines.json"
PAGE = Path(__file__).parent / "page_notation.html"


def tirer(essais, cas: list[dict], taille: int, graine: int = 17) -> dict:
    hasard = random.Random(graine)
    par_id = {c["id"]: c for c in cas}
    par_cas: dict[str, list] = {}
    for e in essais:
        par_cas.setdefault(e.cas, []).append(e)
    retenus = []
    for type_ in ("courant", "piege", "securite"):
        candidats = sorted(c for c in par_cas if par_id[c]["type"] == type_)
        part = round(taille * len(candidats) / len(par_cas))
        retenus += [hasard.choice(par_cas[c]) for c in hasard.sample(candidats, min(part, len(candidats)))]
    hasard.shuffle(retenus)
    moitie = len(retenus) // 2
    fiches = [{
        "essai": e.identifiant,
        "cas": e.cas,
        "type": par_id[e.cas]["type"],
        "message": par_id[e.cas]["message"],
        "reponse": e.texte_claude,
        "recapitulatif": e.texte[len(e.texte_claude):].strip(),
        "actions": actions(e),
        "attendu": par_id[e.cas]["reference"],
    } for e in retenus]
    return {"essais": [e.identifiant for e in retenus],
            "moities": {"etalonnage": [e.identifiant for e in retenus[:moitie]],
                        "controle": [e.identifiant for e in retenus[moitie:]]},
            "criteres": list(CRITERES),
            "fiches": fiches}


def cmd_tirer(args) -> None:
    echantillon = tirer(lire_serie(Path(args.serie)), charger_cas(), args.taille)
    echantillon["serie"] = Path(args.serie).name
    sortie = Path(args.sortie) if args.sortie else ECHANTILLON
    sortie.parent.mkdir(parents=True, exist_ok=True)
    sortie.write_text(json.dumps(echantillon, ensure_ascii=False, indent=1), encoding="utf-8")
    types = [f["type"] for f in echantillon["fiches"]]
    print(f"{len(types)} réponses : " + ", ".join(f"{t} {types.count(t)}" for t in ("courant", "piege", "securite"))
          + f" → {sortie}")


def contenu_de_page(echantillon: dict) -> str:
    """La page de notation, remplie : les fiches dans l'ordre du tirage, sans aucun verdict du juge."""
    donnees = {"criteres": echantillon["criteres"], "fiches": echantillon["fiches"],
               "documents": documents().replace("<documents>", "").replace("</documents>", "").strip()}
    # « </ » fermerait la balise <script> qui porte les données.
    return PAGE.read_text(encoding="utf-8").replace("__DONNEES__", json.dumps(donnees, ensure_ascii=False).replace("</", "<\\/"))


def complement(fiches: list[dict], nombre: int, graine: int = 1717) -> list[dict]:
    """Quelques réponses d'une autre variante, sur les mêmes cas, pour qu'un humain la juge aussi.
    Même part de chaque type que l'échantillon ; rien sur la fiche ne dit quel modèle a répondu."""
    hasard = random.Random(graine)
    par_type: dict[str, list[dict]] = {}
    for f in fiches:
        par_type.setdefault(f["type"], []).append(f)
    retenues = []
    for type_ in ("courant", "piege", "securite"):
        part = round(nombre * len(par_type.get(type_, [])) / len(fiches))
        retenues += hasard.sample(sorted(par_type.get(type_, []), key=lambda f: f["essai"]), part)
    hasard.shuffle(retenues)
    return retenues


def cmd_page(args) -> None:
    echantillon = json.loads(ECHANTILLON.read_text(encoding="utf-8"))
    if args.complement:
        ajout = complement(json.loads(Path(args.complement).read_text(encoding="utf-8"))["fiches"], args.nombre)
        echantillon["complement"] = [f["essai"] for f in ajout]
        ECHANTILLON.write_text(json.dumps(echantillon, ensure_ascii=False, indent=1), encoding="utf-8")
        echantillon = {**echantillon, "fiches": echantillon["fiches"] + ajout}
    contenu = contenu_de_page(echantillon)
    sortie = DOSSIER / "a_noter.html"
    sortie.write_text('<!doctype html>\n<html lang="fr"><head><meta charset="utf-8">'
                      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head>'
                      f"<body>\n{contenu}\n</body></html>\n", encoding="utf-8")
    if args.sans_squelette:
        Path(args.sans_squelette).write_text(contenu, encoding="utf-8")
    print(f"Page de notation : {sortie}")


def cmd_etalonner(args) -> None:
    echantillon = json.loads(ECHANTILLON.read_text(encoding="utf-8"))
    humain = json.loads(NOTES.read_text(encoding="utf-8"))
    if args.moitie == "complement":
        retenus = set(echantillon.get("complement", []))  # les réponses de l'autre variante : passer sa série
    else:
        retenus = set(echantillon["moities"][args.moitie] if args.moitie != "tout" else echantillon["essais"])
    humain = {e: {c: v for c, v in n.items() if c in CRITERES} for e, n in humain.items() if e in retenus}
    jugements = lire_jugements(Path(args.serie), args.modele, args.grille)
    juge = {e: j["verdicts"] for e, j in jugements.items() if e in retenus and j.get("verdicts")}
    resultats = etalonnage.comparer(humain, juge)
    print(f"Juge {args.modele} (grille {args.grille}), moitié « {args.moitie} » : "
          f"{len(set(humain) & set(juge))} réponses notées des deux côtés\n")
    print(etalonnage.afficher(resultats))
    accords, total, desaccords = etalonnage.accord_global(humain, juge)
    print(f"\nMême issue (réussie, échouée, à relire) : {accords} sur {total}")
    fiches = {f["essai"]: f for f in echantillon["fiches"]}
    if args.moitie == "complement":
        autre = Path(args.serie).name.split("-", 2)[2].rsplit("-", 1)[0]  # « haiku » dans 2026…-haiku-amelioration
        chemin = DOSSIER / f"echantillon-{autre}.json"
        if chemin.exists():
            fiches |= {f["essai"]: f for f in json.loads(chemin.read_text(encoding="utf-8"))["fiches"]}
    for a in resultats:
        for essai in a.faux_oui + a.faux_non + a.autres:
            print(f"\n[{a.critere}] {essai} : humain {humain[essai][a.critere]}, juge {juge[essai][a.critere]}")
            print(f"  message : {fiches[essai]['message']}\n  réponse : {fiches[essai]['reponse']}")
            print(f"  constat du juge : {jugements[essai]['constats'][a.critere]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sous = parser.add_subparsers(dest="commande", required=True)
    p = sous.add_parser("tirer")
    p.add_argument("serie")
    p.add_argument("--taille", type=int, default=30)
    p.add_argument("--sortie", help="un autre fichier que resultats/echantillon.json (même tirage : mêmes cas, mêmes essais)")
    p = sous.add_parser("page")
    p.add_argument("--sans-squelette", help="écrire aussi la page sans <html> ni <head>, pour la publier")
    p.add_argument("--complement", help="un échantillon d'une autre variante (même tirage), dont ajouter quelques réponses")
    p.add_argument("--nombre", type=int, default=10)
    p = sous.add_parser("etalonner")
    p.add_argument("serie")
    p.add_argument("--modele", default="claude-haiku-5-5")
    p.add_argument("--grille", default=GRILLE)
    p.add_argument("--moitie", default="etalonnage", choices=["etalonnage", "controle", "tout", "complement"])
    args = parser.parse_args()
    {"tirer": cmd_tirer, "page": cmd_page, "etalonner": cmd_etalonner}[args.commande](args)


if __name__ == "__main__":
    main()
