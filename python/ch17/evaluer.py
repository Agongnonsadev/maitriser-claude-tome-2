"""Chapitre 17 : la suite d'évaluation du Comptoir, en ligne de commande.

Depuis le dossier python/ :
    python -m ch17.evaluer estimer --jeu amelioration --essais 3              (gratuit)
    python -m ch17.evaluer lancer --variante reference --jeu amelioration --essais 3 --budget-max 1   (PAYANT)
    python -m ch17.evaluer juger <série> --modele claude-haiku-5-5 --budget-max 0.3                     (PAYANT)
    python -m ch17.evaluer resumer <série> [--modele-juge claude-haiku-5-5]                             (gratuit)
    python -m ch17.evaluer renoter <série> --raison "…"                                              (gratuit)
    python -m ch17.evaluer graduer <série>                                                           (gratuit)
    python -m ch17.evaluer regression --budget-max 0.3                    (PAYANT : la version livrée)

Le jeu « verification » ne sert qu'à la fin, pour la version choisie : le script demande
--je-livre pour le lancer, afin qu'on ne s'en serve pas, sans le vouloir, pour travailler.
"""

import argparse
import csv
import json
import statistics
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from ch17 import juge as juge_
from ch17.juge import GRILLE
from ch17.notation_code import noter
from ch17.suite import (REGISTRE, SERIES, VARIANTES, afficher, charger_cas, chemin_jugements, empreinte_cas,
                        empreinte_notation, entree_de_registre, ecrire_serie, lancer, lire_jugements, lire_serie,
                        noter_au_registre, resumer)
from comptoir.appel import creer_client
from comptoir.connaissances import charger_base
from comptoir.couts import TARIFS

DOSSIER = Path(__file__).parent
REGRESSION = DOSSIER / "regression.json"
SORTIE_SUPPOSEE_JUGE = 600  # tokens de sortie supposés par jugement, réflexion comprise, pour l'estimation


def couts_du_chapitre_12() -> dict[str, float]:
    """Le coût moyen d'un message par catégorie, mesuré au chapitre 12 avec l'aiguilleur."""
    with (DOSSIER.parent / "ch12" / "resultats" / "comptoir.csv").open(encoding="utf-8") as f:
        lignes = [l for l in csv.DictReader(f) if l["mode"] == "aiguille"]
    return {c: statistics.mean(float(l["cout_dollars"]) for l in lignes if l["attendu"] == c)
            for c in {l["attendu"] for l in lignes}}


def cmd_estimer(args) -> None:
    cas = charger_cas(args.jeu)
    moyennes = couts_du_chapitre_12()
    total = sum(moyennes[c["categorie"][0]] for c in cas) * args.essais
    print(f"{len(cas)} cas × {args.essais} essais avec la version livrée : environ {total:.2f} $ "
          f"(coûts moyens mesurés au chapitre 12 : "
          + ", ".join(f"{k} {v:.4f} $" for k, v in sorted(moyennes.items())) + ")")
    client = creer_client()
    exemple = juge_.requete(cas[0], _essai_fictif(cas[0]), args.modele_juge)
    entree = client.messages.count_tokens(**{k: exemple[k] for k in ("model", "system", "messages", "output_config")}).input_tokens
    tarif = TARIFS[args.modele_juge]
    par_jugement = (entree * tarif.entree + SORTIE_SUPPOSEE_JUGE * tarif.sortie) / 1_000_000
    print(f"Juge {args.modele_juge} : {entree} tokens d'entrée par jugement (comptage gratuit), au plus "
          f"{par_jugement:.4f} $ sans le cache, soit {par_jugement * len(cas) * args.essais:.2f} $ pour tous les essais")


def _essai_fictif(cas: dict):
    from ch17.banc import Essai
    return Essai("estimation", cas["id"], 1, texte="Réponse d'exemple.", texte_claude="Réponse d'exemple.")


def cmd_lancer(args) -> None:
    if args.jeu == "verification" and not args.je_livre:
        raise SystemExit("Le jeu de vérification se lance une fois, pour la version choisie : ajoutez --je-livre.")
    variante = VARIANTES[args.variante]
    cas = charger_cas(args.jeu, args.cas)
    dossier = SERIES / f"{datetime.now():%Y%m%d-%H%M%S}-{variante.nom}-{args.jeu}"
    print(f"Variante {variante.nom} · jeu {args.jeu} ({len(cas)} cas, empreinte {empreinte_cas(cas)}) · "
          f"{args.essais} essais · plafond {args.budget_max} $")
    essais, arrete = lancer(creer_client(), variante, cas, args.essais, args.budget_max, charger_base(),
                            paralleles=args.paralleles)
    ecrire_serie(dossier, essais)
    resume = resumer(essais, cas)
    noter_au_registre(entree_de_registre(dossier, variante, args.jeu, cas, args.essais, resume, arrete))
    print(("\nBUDGET ATTEINT : série incomplète.\n" if arrete else "\n") + afficher(resume))
    print(f"Série : {dossier}")


def cmd_juger(args) -> None:
    dossier = Path(args.serie)
    essais = lire_serie(dossier)
    if args.echantillon:
        retenus = set(json.loads(Path(args.echantillon).read_text(encoding="utf-8"))["essais"])
        essais = [e for e in essais if e.identifiant in retenus]
    deja = lire_jugements(dossier, args.modele, args.grille)
    a_juger = [e for e in essais if e.identifiant not in deja]
    cas = {c["id"]: c for c in charger_cas()}
    grille = juge_.charger_grille(args.grille)
    client, verrou, depense = creer_client(), threading.Lock(), [0.0]
    chemin = chemin_jugements(dossier, args.modele, args.grille)
    print(f"{len(a_juger)} essais à juger par {args.modele} ({grille.identifiant}), {len(deja)} déjà jugés")

    def un(essai):
        with verrou:
            if depense[0] >= args.budget_max:
                return None
        j = juge_.juger(client, cas[essai.cas], essai, args.modele, grille)
        with verrou:
            depense[0] += j.cout_dollars
            with chemin.open("a", encoding="utf-8") as f:
                f.write(json.dumps({**asdict(j), "issue": j.issue}, ensure_ascii=False) + "\n")
        print(f"  {essai.identifiant:45} {j.issue:9} {j.cout_dollars:.5f} $ "
              + " ".join(f"{c}={v}" for c, v in j.verdicts.items()) + (f" {j.erreur}" if j.erreur else ""))
        return j

    if a_juger:
        un(a_juger[0])  # le premier seul : il écrit les documents dans le cache
        with ThreadPoolExecutor(max_workers=args.paralleles) as executeur:
            list(executeur.map(un, a_juger[1:]))
    print(f"Dépense du juge : {depense[0]:.4f} $")
    cmd_resumer(argparse.Namespace(serie=str(dossier), modele_juge=args.modele, grille=args.grille))


def cmd_resumer(args) -> None:
    dossier = Path(args.serie)
    essais = lire_serie(dossier)
    cas = charger_cas()
    jugements = lire_jugements(dossier, args.modele_juge, args.grille) if args.modele_juge else None
    print(afficher(resumer(essais, cas, jugements)))


def cmd_renoter(args) -> None:
    """La notation actuelle, appliquée aux réponses déjà obtenues : aucun appel, aucun coût.
    Une nouvelle ligne entre au registre, avec la nouvelle empreinte de la notation ; l'ancienne reste."""
    dossier = Path(args.serie)
    with REGISTRE.open(encoding="utf-8") as f:
        avant = next(l for l in reversed([json.loads(x) for x in f if x.strip()]) if l["serie"] == dossier.name)
    essais = lire_serie(dossier)
    cas = charger_cas(identifiants=sorted({e.cas for e in essais}))
    resume = resumer(essais, cas)
    entree = {**avant, "resume": resume, "empreinte_notation": empreinte_notation(), "empreinte_cas": empreinte_cas(cas),
              "renotation": True,
              "date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "raison": args.raison}
    noter_au_registre(entree)
    print(f"Notation {avant['empreinte_notation']} : réussite (code) {avant['resume']['reussite_code']:.0%}")
    print(f"Notation {entree['empreinte_notation']} : réussite (code) {resume['reussite_code']:.0%}")
    print(afficher(resume))


def cmd_graduer(args) -> None:
    """Les cas réussis par le code à chaque essai d'une série entrent dans la non-régression :
    de « sait-on le faire ? », ils passent à « le fait-on toujours ? »."""
    dossier = Path(args.serie)
    essais = lire_serie(dossier)
    cas = {c["id"]: c for c in charger_cas()}
    par_cas: dict[str, list[bool]] = {}
    for e in essais:
        par_cas.setdefault(e.cas, []).append(not noter(cas[e.cas], e))
    retenus = sorted(c for c, v in par_cas.items() if all(v))
    REGRESSION.write_text(json.dumps({"serie": dossier.name, "empreinte_notation": empreinte_notation(), "cas": retenus},
                                     ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(retenus)} cas sur {len(par_cas)} entrent dans la non-régression → {REGRESSION}")


def cmd_regression(args) -> int:
    """Les cas que la version livrée réussit à chaque essai : un seul essai chacun, notés par le code.
    Code de sortie 1 au premier échec : de quoi bloquer une modification, à la main ou dans la CI (chapitre 20)."""
    identifiants = json.loads(REGRESSION.read_text(encoding="utf-8"))["cas"]
    cas = charger_cas(identifiants=identifiants)
    variante = VARIANTES[args.variante]
    essais, arrete = lancer(creer_client(), variante, cas, 1, args.budget_max, charger_base(), paralleles=args.paralleles)
    par_id = {c["id"]: c for c in cas}
    echecs = {e.cas: noter(par_id[e.cas], e) for e in essais}
    rates = sorted(c for c, e in echecs.items() if e)
    dossier = SERIES / f"{datetime.now():%Y%m%d-%H%M%S}-{variante.nom}-regression"
    ecrire_serie(dossier, essais)
    resume = resumer(essais, cas)
    noter_au_registre(entree_de_registre(dossier, variante, "regression", cas, 1, resume, arrete))
    print(afficher(resume))
    if arrete or rates:
        print(f"NON-RÉGRESSION : {'série incomplète ; ' if arrete else ''}{len(rates)} cas en échec : {', '.join(rates)}")
        return 1
    print(f"Non-régression : {len(cas)} cas sur {len(cas)}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sous = parser.add_subparsers(dest="commande", required=True)
    p = sous.add_parser("estimer")
    p.add_argument("--jeu", default="amelioration")
    p.add_argument("--essais", type=int, default=3)
    p.add_argument("--modele-juge", default="claude-haiku-5-5")
    p = sous.add_parser("lancer")
    p.add_argument("--variante", default="reference", choices=sorted(VARIANTES))
    p.add_argument("--jeu", default="amelioration", choices=["amelioration", "verification"])
    p.add_argument("--cas", nargs="*", help="seulement ces cas")
    p.add_argument("--essais", type=int, default=3)
    p.add_argument("--budget-max", type=float, default=1.0)
    p.add_argument("--paralleles", type=int, default=4)
    p.add_argument("--je-livre", action="store_true")
    p = sous.add_parser("juger")
    p.add_argument("serie")
    p.add_argument("--modele", default="claude-haiku-5-5")
    p.add_argument("--grille", default=GRILLE)
    p.add_argument("--echantillon")
    p.add_argument("--budget-max", type=float, default=0.3)
    p.add_argument("--paralleles", type=int, default=4)
    p = sous.add_parser("resumer")
    p.add_argument("serie")
    p.add_argument("--modele-juge")
    p.add_argument("--grille", default=GRILLE)
    p = sous.add_parser("renoter")
    p.add_argument("serie")
    p.add_argument("--raison", required=True, help="pourquoi la notation a changé, écrit au registre")
    p = sous.add_parser("graduer")
    p.add_argument("serie")
    p = sous.add_parser("regression")
    p.add_argument("--variante", default="livree", choices=sorted(VARIANTES))
    p.add_argument("--budget-max", type=float, default=0.3)
    p.add_argument("--paralleles", type=int, default=4)
    args = parser.parse_args()
    if args.commande == "regression":
        return cmd_regression(args)
    {"estimer": cmd_estimer, "lancer": cmd_lancer, "juger": cmd_juger, "resumer": cmd_resumer,
     "renoter": cmd_renoter, "graduer": cmd_graduer}[args.commande](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
