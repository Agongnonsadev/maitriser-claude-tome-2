"""Évaluer des variantes (prompts, modèles, réglages) sur un même jeu de cas (chapitre 5).

Une variante est une fonction qui, pour un cas, renvoie la requête à envoyer. On pose chaque
cas plusieurs fois, on note, et on compare : réussite, coût par réussite, régressions.
Le chapitre 17 en fait une vraie suite d'évaluation.
"""

import csv
import statistics
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from comptoir.couts import cout
from comptoir.journal import noter as noter_au_journal
from comptoir.notation import Cas, Note, noter

Variante = Callable[[Cas], dict]


@dataclass
class Essai:
    variante: str
    cas: str
    repetition: int
    reussi: bool
    raisons: str
    a_relire: str
    reponse: str
    latence_s: float
    tokens_entree: int
    tokens_sortie: int
    cout_dollars: float
    raison_arret: str


def noter_essai(cas: Cas, texte: str, raison_arret: str) -> Note:
    """Les critères du cas, plus une règle commune : une réponse qui ne s'arrête pas sur end_turn échoue."""
    note = noter(cas, texte)
    if raison_arret != "end_turn":
        note.reussi = False
        note.raisons.append(f"arrêt : {raison_arret}")
    return note


def essayer(client, nom: str, requete: dict, cas: Cas, repetition: int) -> Essai:
    debut = time.perf_counter()
    message = client.messages.create(**requete)
    latence = time.perf_counter() - debut
    texte = "".join(b.text for b in message.content if b.type == "text")
    prix = cout(requete["model"], message.usage)
    noter_au_journal(message._request_id, requete["model"], prix, prompt=nom)
    note = noter_essai(cas, texte, message.stop_reason)
    return Essai(nom, cas.identifiant, repetition, note.reussi, " ; ".join(note.raisons), note.a_relire,
                 texte, round(latence, 2), prix.entree, prix.sortie, prix.dollars, message.stop_reason)


def evaluer(client, cas: list[Cas], variantes: dict[str, Variante], repetitions: int, budget_max: float) -> list[Essai]:
    essais, depense = [], 0.0
    for nom, construire in variantes.items():
        for c in cas:
            for r in range(1, repetitions + 1):
                if depense >= budget_max:
                    print(f"Budget de {budget_max} $ atteint : arrêt.")
                    return essais
                essai = essayer(client, nom, construire(c), c, r)
                depense += essai.cout_dollars
                essais.append(essai)
    return essais


def resumer(essais: list[Essai]) -> list[dict]:
    lignes = []
    for nom in dict.fromkeys(e.variante for e in essais):
        groupe = [e for e in essais if e.variante == nom]
        reussites = sum(e.reussi for e in groupe)
        total = sum(e.cout_dollars for e in groupe)
        lignes.append({
            "variante": nom,
            "essais": len(groupe),
            "reussite": reussites / len(groupe),
            "cout_par_appel": total / len(groupe),
            "cout_par_reussite": total / reussites if reussites else None,
            "latence_mediane_s": statistics.median(e.latence_s for e in groupe),
        })
    return lignes


def taux_par_cas(essais: list[Essai], variante: str) -> dict[str, float]:
    par_cas: dict[str, list[bool]] = {}
    for e in essais:
        if e.variante == variante:
            par_cas.setdefault(e.cas, []).append(e.reussi)
    return {c: sum(v) / len(v) for c, v in par_cas.items()}


def regressions(essais: list[Essai], avant: str, apres: str) -> list[str]:
    """Les cas mieux réussis par l'ancienne variante que par la nouvelle."""
    a, b = taux_par_cas(essais, avant), taux_par_cas(essais, apres)
    return sorted(c for c in a if c in b and b[c] < a[c])


def renoter(essais: list[Essai], cas: list[Cas]) -> list[Essai]:
    """Applique la grille actuelle aux réponses déjà obtenues : aucun appel, aucun coût.

    À réserver à une correction de la grille décidée pour une raison écrite, et appliquée
    à toutes les variantes à la fois ; on garde les deux résultats, avant et après.
    """
    par_identifiant = {c.identifiant: c for c in cas}
    renotes = []
    for e in essais:
        note = noter_essai(par_identifiant[e.cas], e.reponse, e.raison_arret)
        renotes.append(replace(e, reussi=note.reussi, raisons=" ; ".join(note.raisons), a_relire=note.a_relire))
    return renotes


def lire_csv(chemin: Path) -> list[Essai]:
    types = {"repetition": int, "tokens_entree": int, "tokens_sortie": int,
             "latence_s": float, "cout_dollars": float, "reussi": lambda v: v == "True"}
    with chemin.open(newline="", encoding="utf-8") as f:
        return [Essai(**{k: types.get(k, str)(v) for k, v in ligne.items()}) for ligne in csv.DictReader(f)]


def ecrire_csv(essais: list[Essai], chemin: Path) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", newline="", encoding="utf-8") as f:
        ecrivain = csv.DictWriter(f, fieldnames=list(Essai.__dataclass_fields__))
        ecrivain.writeheader()
        for e in essais:
            ecrivain.writerow(asdict(e))
