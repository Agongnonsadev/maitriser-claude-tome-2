"""La suite d'évaluation du Comptoir (chapitre 17) : lancer, noter, résumer, garder la trace.

- les cas vivent dans ch17/cas.json, chacun dans un jeu : « amelioration » pour travailler,
  « verification » pour vérifier, une seule fois, la version choisie ;
- chaque série d'essais va dans son propre dossier de ch17/resultats/series/, avec toutes les
  transcriptions ; une ligne entre dans ch17/resultats/registre.jsonl : la variante, les
  versions des prompts, l'empreinte des cas et de la notation, les résultats et le coût.
  Deux séries ne se comparent que si elles ont reçu les mêmes messages (empreinte des cas) ; leurs
  réponses sont alors notées ensemble, par la notation du jour : celle du code, les attendus et la
  grille du juge s'appliquent aux deux à la fois.
"""

import hashlib
import json
import statistics
import threading
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, fields
from datetime import datetime, timezone
from pathlib import Path

from ch17.banc import Essai, Variante, essayer
from ch17.notation_code import noter
from comptoir import config, documentaire
from comptoir.prompt import charger
from comptoir.routeur import PROMPT as PROMPT_ROUTEUR

DOSSIER = Path(__file__).parent
SERIES = DOSSIER / "resultats" / "series"
REGISTRE = DOSSIER / "resultats" / "registre.jsonl"

SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"
VARIANTES = {
    # La version livrée avant ce chapitre : le Comptoir sur Claude Sonnet 5.5.
    "reference": Variante("reference", modele_comptoir=SONNET),
    # Une modification à la fois, chacune comparée à la référence.
    # Le prompt : la règle de longueur reçoit son moyen (systeme_v4.md, une phrase de plus).
    "prompt-v4": Variante("prompt-v4", modele_comptoir=SONNET, version_prompt="v4"),
    # Le modèle du Comptoir : Claude Haiku 5.5, vingt fois moins cher que Sonnet 5.5 (comptoir/couts.py).
    "haiku": Variante("haiku", modele_comptoir=HAIKU),
    # Chapitre 18 : le prompt dit au Comptoir qu'il est une IA, et quoi répondre à « vous êtes Awa ? ».
    # Comparé à « haiku » (même modèle, prompt v3) : 5 cas gagnés, 3 perdus, p = 0,73 ; retenu.
    "prompt-v5": Variante("prompt-v5", version_prompt="v5"),
    # La version livrée : Haiku 5.5 (comptoir/config.py) depuis le chapitre 17, prompt v5 depuis le chapitre 18.
    "livree": Variante("livree", version_prompt="v5"),
    # Chapitre 19 : l'effort du Comptoir à low, que la documentation conseille pour le chat ; comparé à « livree ».
    "effort-low": Variante("effort-low", version_prompt="v5", effort_comptoir="low"),
}


def empreinte(texte: str) -> str:
    return hashlib.sha256(texte.encode("utf-8")).hexdigest()[:8]


def charger_cas(jeu: str | None = None, identifiants: list[str] | None = None) -> list[dict]:
    cas = json.loads((DOSSIER / "cas.json").read_text(encoding="utf-8"))
    if jeu:
        cas = [c for c in cas if c["jeu"] == jeu]
    if identifiants:
        cas = [c for c in cas if c["id"] in identifiants]
    return cas


def empreinte_cas(cas: list[dict]) -> str:
    """Ce qui fait les réponses : les identifiants et les messages. Les critères et les attendus
    peuvent être corrigés, ils s'appliquent ensuite à toutes les séries à la fois."""
    return empreinte(json.dumps([[c["id"], c["message"]] for c in cas], ensure_ascii=False))


def empreinte_notation() -> str:
    sources = [DOSSIER / "notation_code.py", DOSSIER.parent / "comptoir" / "notation.py"]
    return empreinte("".join(p.read_text(encoding="utf-8") for p in sources))


def versions(variante: Variante) -> dict:
    """Tout ce qui fait la variante, avec l'empreinte de chaque prompt : de quoi la retrouver."""
    return {
        "modele_comptoir": variante.modele_comptoir or config.MODELE_COMPTOIR,
        "effort_comptoir": variante.effort_comptoir or config.EFFORT_COMPTOIR or "défaut du modèle",
        "modele_routeur": config.MODELE_ROUTEUR,
        "modele_documents": config.MODELE_DOCUMENTS,
        "modele_reclamations": f"{config.MODELE_AUXILIAIRE} et {config.MODELE}",
        "prompt_comptoir": charger(variante.version_prompt).identifiant,
        "prompt_documents": documentaire.charger_prompt(variante.version_documents).identifiant,
        "prompt_routeur": f"routeur-v1@{empreinte(PROMPT_ROUTEUR)}",
    }


# --- Lancer ---------------------------------------------------------------------------

def lancer(client, variante: Variante, cas: list[dict], essais: int, budget_max: float, base,
           paralleles: int = 4, au_fil=print) -> tuple[list[Essai], bool]:
    """Chaque cas, `essais` fois. Un premier essai par chemin (information, commande, réclamation, autre)
    part seul : il écrit les caches que les suivants liront, au lieu de quatre écritures en parallèle.
    Renvoie les essais et True si le budget a arrêté la série avant la fin."""
    taches = [(c, n) for n in range(1, essais + 1) for c in cas]
    ordre = {(c["id"], n): rang for rang, (c, n) in enumerate(taches)}
    chemins, seuls = set(), []
    for t in taches:
        if t[0]["categorie"][0] not in chemins:
            chemins.add(t[0]["categorie"][0])
            seuls.append(t)
    taches = seuls + [t for t in taches if t not in seuls]
    resultats, depense, verrou = [], 0.0, threading.Lock()

    def un(tache):
        c, n = tache
        essai = essayer(client, variante, c, n, base)
        echecs = noter(c, essai)
        au_fil(f"  {essai.identifiant:45} {'ok' if not echecs else 'ÉCHEC'} {essai.cout_dollars:.4f} $ "
               f"{essai.latence_s:>5.1f} s {'; '.join(e.raison for e in echecs)[:90]}")
        return essai

    if not taches:
        return [], False
    for tache in seuls:
        essai = un(tache)
        resultats.append(essai)
        depense += essai.cout_dollars
    arrete = False
    with ThreadPoolExecutor(max_workers=paralleles) as executeur:
        en_cours, reste = set(), list(taches[len(seuls):])
        while reste or en_cours:
            while reste and len(en_cours) < paralleles:
                with verrou:
                    if depense >= budget_max:
                        arrete, reste = True, []
                        break
                en_cours.add(executeur.submit(un, reste.pop(0)))
            if not en_cours:
                break
            finis, en_cours = wait(en_cours, return_when=FIRST_COMPLETED)
            for f in finis:
                essai = f.result()
                with verrou:
                    resultats.append(essai)
                    depense += essai.cout_dollars
    resultats.sort(key=lambda e: ordre[(e.cas, e.essai)])
    return resultats, arrete


# --- Écrire et relire -------------------------------------------------------------------

def ecrire_serie(dossier: Path, essais: list[Essai]) -> None:
    dossier.mkdir(parents=True, exist_ok=True)
    with (dossier / "essais.jsonl").open("w", encoding="utf-8") as f:
        for e in essais:
            f.write(json.dumps(e.en_dict(), ensure_ascii=False) + "\n")


def lire_serie(dossier: Path) -> list[Essai]:
    noms = {f.name for f in fields(Essai)}
    with (dossier / "essais.jsonl").open(encoding="utf-8") as f:
        return [Essai(**{k: v for k, v in json.loads(l).items() if k in noms}) for l in f if l.strip()]


def chemin_jugements(dossier: Path, modele: str, grille: str = "v1") -> Path:
    """Un fichier par juge et par version de la grille : une grille corrigée ne mélange pas ses notes aux anciennes."""
    return dossier / f"jugements-{modele}-{grille}.jsonl"


def lire_jugements(dossier: Path, modele: str, grille: str = "v1") -> dict[str, dict]:
    chemin = chemin_jugements(dossier, modele, grille)
    if not chemin.exists():
        return {}
    with chemin.open(encoding="utf-8") as f:
        return {j["essai"]: j for j in (json.loads(l) for l in f if l.strip())}


def noter_au_registre(entree: dict) -> None:
    REGISTRE.parent.mkdir(parents=True, exist_ok=True)
    with REGISTRE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entree, ensure_ascii=False) + "\n")


# --- Résumer ----------------------------------------------------------------------------

def _p90(valeurs: list[float]) -> float:
    valeurs = sorted(valeurs)
    return valeurs[min(len(valeurs) - 1, round(0.9 * (len(valeurs) - 1)))] if valeurs else 0.0


def resumer(essais: list[Essai], cas: list[dict], jugements: dict[str, dict] | None = None) -> dict:
    """Qualité, coût et latence, ensemble. Un essai réussit si le code ne trouve rien à redire,
    et, quand le juge est passé, s'il dit « oui » à tous les critères. Si le juge n'a lu qu'un
    échantillon, le résumé ne porte que sur les essais jugés."""
    par_id = {c["id"]: c for c in cas}
    if jugements:
        essais = [e for e in essais if e.identifiant in jugements]
    notes = {e.identifiant: noter(par_id[e.cas], e) for e in essais}
    reussis_code = {i for i, echecs in notes.items() if not echecs}
    resume = {
        "essais": len(essais),
        "cas": len({e.cas for e in essais}),
        "reussite_code": len(reussis_code) / len(essais) if essais else 0.0,
        "echecs_par_famille": dict(Counter(e.famille for echecs in notes.values() for e in echecs)),
    }
    reussis = set(reussis_code)
    if jugements:
        issues = {i: _issue(j) for i, j in jugements.items() if i in notes}
        resume["juges"] = len(issues)
        resume["reussite_juge"] = sum(v == "reussi" for v in issues.values()) / len(issues) if issues else 0.0
        resume["a_relire"] = sum(v == "a_relire" for v in issues.values())
        resume["non_par_critere"] = dict(Counter(c for j in jugements.values() if j["essai"] in notes
                                                 for c, v in j["verdicts"].items() if v == "non"))
        reussis = {i for i in reussis_code if issues.get(i) == "reussi"}
        resume["reussite"] = len(reussis) / len(essais) if essais else 0.0
        resume["cout_juge"] = round(sum(j["cout_dollars"] for j in jugements.values() if j["essai"] in notes), 4)
    par_cas: dict[str, list[bool]] = {}
    for e in essais:
        par_cas.setdefault(e.cas, []).append(e.identifiant in reussis)
    resume["cas_toujours_reussis"] = sum(all(v) for v in par_cas.values())
    resume["cas_jamais_reussis"] = sum(not any(v) for v in par_cas.values())
    resume["cas_instables"] = sorted(c for c, v in par_cas.items() if any(v) and not all(v))
    resume["par_type"] = {}
    for t in ("courant", "piege", "securite"):
        groupe = [e for e in essais if par_id[e.cas]["type"] == t]
        if groupe:
            resume["par_type"][t] = sum(e.identifiant in reussis for e in groupe) / len(groupe)
    couts = [e.cout_dollars for e in essais]
    latences = [e.latence_s for e in essais if not e.erreur]
    resume.update({
        "cout_total": round(sum(couts), 4),
        "cout_moyen": round(statistics.mean(couts), 5) if couts else 0.0,
        "cout_par_reussite": round(sum(couts) / len(reussis), 5) if reussis else None,
        "latence_mediane_s": round(statistics.median(latences), 1) if latences else None,
        "latence_p90_s": round(_p90(latences), 1) if latences else None,
        "appels_moyens": round(statistics.mean(len(e.appels) for e in essais), 2) if essais else 0.0,
    })
    return resume


def _issue(jugement: dict) -> str:
    if jugement.get("erreur") or not jugement.get("verdicts"):
        return "a_relire"
    v = jugement["verdicts"].values()
    return "echoue" if "non" in v else ("reussi" if all(x == "oui" for x in v) else "a_relire")


def taux_par_cas(essais: list[Essai], cas: list[dict], jugements: dict[str, dict] | None = None) -> dict[str, float]:
    par_id = {c["id"]: c for c in cas}
    par_cas: dict[str, list[bool]] = {}
    for e in essais:
        ok = not noter(par_id[e.cas], e)
        if jugements is not None:
            ok = ok and e.identifiant in jugements and _issue(jugements[e.identifiant]) == "reussi"
        par_cas.setdefault(e.cas, []).append(ok)
    return {c: sum(v) / len(v) for c, v in par_cas.items()}


def afficher(resume: dict) -> str:
    lignes = [f"{resume['essais']} essais sur {resume['cas']} cas"]
    lignes.append(f"  réussite (code) : {resume['reussite_code']:.0%}  échecs par famille : {resume['echecs_par_famille']}")
    if "reussite_juge" in resume:
        lignes.append(f"  réussite (juge) : {resume['reussite_juge']:.0%}  à relire : {resume['a_relire']}  "
                      f"« non » par critère : {resume['non_par_critere']}")
        lignes.append(f"  réussite (code et juge) : {resume['reussite']:.0%}")
    lignes.append(f"  cas réussis à tous les essais : {resume['cas_toujours_reussis']} ; jamais : "
                  f"{resume['cas_jamais_reussis']} ; instables : {len(resume['cas_instables'])}")
    lignes.append("  par type : " + ", ".join(f"{t} {v:.0%}" for t, v in resume["par_type"].items()))
    par = f"{resume['cout_par_reussite']:.4f} $" if resume["cout_par_reussite"] else "—"
    lignes.append(f"  coût : {resume['cout_total']:.4f} $ au total, {resume['cout_moyen']:.4f} $ par essai, {par} par réussite"
                  + (f" ; juge : {resume['cout_juge']:.4f} $" if "cout_juge" in resume else ""))
    lignes.append(f"  latence : médiane {resume['latence_mediane_s']} s, 90 % sous {resume['latence_p90_s']} s ; "
                  f"{resume['appels_moyens']} appels par essai")
    return "\n".join(lignes)


def entree_de_registre(dossier: Path, variante: Variante, jeu: str, cas: list[dict], essais: int,
                       resume: dict, arrete: bool) -> dict:
    return {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "serie": dossier.name,
        "variante": asdict(variante),
        "versions": versions(variante),
        "jeu": jeu,
        "empreinte_cas": empreinte_cas(cas),
        "empreinte_notation": empreinte_notation(),
        "essais_par_cas": essais,
        "arretee_par_le_budget": arrete,
        "resume": resume,
    }
