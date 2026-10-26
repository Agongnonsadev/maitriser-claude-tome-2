"""Chapitre 3 : comparer modèles et niveaux d'effort sur les cas du Comptoir.

Pour chaque configuration (modèle, effort), chaque cas est posé plusieurs fois, parce que
les réponses varient. On relève la réussite, le coût, la latence et la réflexion, puis on
calcule le coût par tâche réussie.

Lancement, depuis le dossier python/ :
    python -m ch03.comparer_modeles --estimer        # gratuit : estimation du coût avant de lancer
    python -m ch03.comparer_modeles --repetitions 3 --budget-max 2
"""

import argparse
import csv
import json
import statistics
import time
from dataclasses import dataclass
from pathlib import Path

import anthropic

from ch02.comptoir_cli import PROMPT_SYSTEME
from comptoir.couts import TARIFS, cout
from comptoir.journal import noter as noter_au_journal
from comptoir.notation import Cas, noter

CONFIGURATIONS = [
    ("claude-opus-5-5", "medium"),
    ("claude-opus-5-5", "low"),
    ("claude-sonnet-5-5", "high"),
    ("claude-sonnet-5-5", "low"),
    ("claude-haiku-5-5", "medium"),
    ("claude-haiku-5-5", "low"),
]

DOSSIER = Path(__file__).parent


def charger_cas(chemin: Path = DOSSIER / "cas.json") -> list[Cas]:
    return [Cas.depuis_dict(d) for d in json.loads(chemin.read_text(encoding="utf-8"))]


@dataclass
class Essai:
    modele: str
    effort: str
    cas: str
    repetition: int
    reussi: bool
    raisons: str
    a_relire: str
    reponse: str
    latence_s: float
    tokens_entree: int
    tokens_sortie: int
    tokens_reflexion: int
    cout_dollars: float
    raison_arret: str


def interroger(client, modele: str, effort: str, cas: Cas, repetition: int) -> Essai:
    debut = time.perf_counter()
    message = client.messages.create(
        model=modele,
        max_tokens=2000,
        system=PROMPT_SYSTEME,
        output_config={"effort": effort},
        messages=[{"role": "user", "content": cas.question}],
    )
    latence = time.perf_counter() - debut
    texte = "".join(b.text for b in message.content if b.type == "text")
    prix = cout(modele, message.usage)
    noter_au_journal(message._request_id, modele, prix)
    note = noter(cas, texte)
    if message.stop_reason != "end_turn":
        note.reussi = False
        note.raisons.append(f"arrêt : {message.stop_reason}")
    return Essai(
        modele, effort, cas.identifiant, repetition, note.reussi, " ; ".join(note.raisons),
        note.a_relire, texte, round(latence, 2), prix.entree, prix.sortie, prix.reflexion,
        prix.dollars, message.stop_reason,
    )


def resumer(essais: list[Essai]) -> list[dict]:
    """Une ligne par configuration : taux de réussite, coûts, latence, réflexion."""
    lignes = []
    for modele, effort in dict.fromkeys((e.modele, e.effort) for e in essais):
        groupe = [e for e in essais if e.modele == modele and e.effort == effort]
        reussites = sum(e.reussi for e in groupe)
        cout_total = sum(e.cout_dollars for e in groupe)
        lignes.append({
            "modele": modele,
            "effort": effort,
            "essais": len(groupe),
            "reussite": reussites / len(groupe),
            "cout_par_appel": cout_total / len(groupe),
            # Le chiffre qui compte : ce que coûte une réponse utilisable.
            "cout_par_reussite": cout_total / reussites if reussites else None,
            "latence_mediane_s": statistics.median(e.latence_s for e in groupe),
            "reflexion_moyenne": statistics.mean(e.tokens_reflexion for e in groupe),
        })
    return lignes


def comparer(client, cas: list[Cas], configurations, repetitions: int, budget_max: float) -> list[Essai]:
    essais, depense = [], 0.0
    for modele, effort in configurations:
        for c in cas:
            for r in range(1, repetitions + 1):
                if depense >= budget_max:
                    print(f"Budget de {budget_max} $ atteint : arrêt de la comparaison.")
                    return essais
                essai = interroger(client, modele, effort, c, r)
                depense += essai.cout_dollars
                essais.append(essai)
    return essais


def estimer(client, cas: list[Cas], configurations, repetitions: int, sortie_supposee: int) -> float:
    """Estimation gratuite : tokens d'entrée comptés, tokens de sortie supposés."""
    total = 0.0
    for modele, _ in configurations:
        tarif = TARIFS[modele]
        for c in cas:
            entree = client.messages.count_tokens(
                model=modele, system=PROMPT_SYSTEME,
                messages=[{"role": "user", "content": c.question}],
            ).input_tokens
            total += repetitions * (entree * tarif.entree + sortie_supposee * tarif.sortie) / 1_000_000
    return total


def ecrire_csv(essais: list[Essai], chemin: Path) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", newline="", encoding="utf-8") as f:
        ecrivain = csv.DictWriter(f, fieldnames=list(Essai.__dataclass_fields__))
        ecrivain.writeheader()
        for e in essais:
            ecrivain.writerow(e.__dict__)


def afficher(lignes: list[dict]) -> None:
    print(f"{'Modèle':<20}{'Effort':<8}{'Réussite':>10}{'$/appel':>11}{'$/réussite':>12}{'Latence':>9}{'Réflexion':>11}")
    for l in lignes:
        par_reussite = f"{l['cout_par_reussite']:.5f}" if l["cout_par_reussite"] else "—"
        print(
            f"{l['modele']:<20}{l['effort']:<8}{l['reussite']:>9.0%} {l['cout_par_appel']:>10.5f}"
            f"{par_reussite:>12}{l['latence_mediane_s']:>8.1f}s{l['reflexion_moyenne']:>11.0f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--budget-max", type=float, default=2.0, help="arrêt au-delà de ce montant, en dollars")
    parser.add_argument("--estimer", action="store_true", help="estimer le coût sans appeler le modèle")
    parser.add_argument("--sortie-supposee", type=int, default=300, help="tokens de sortie supposés par appel")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    cas = charger_cas()
    if args.estimer:
        total = estimer(client, cas, CONFIGURATIONS, args.repetitions, args.sortie_supposee)
        print(f"{len(cas)} cas × {len(CONFIGURATIONS)} configurations × {args.repetitions} répétitions")
        print(f"Coût estimé : {total:.2f} $ (avec {args.sortie_supposee} tokens de sortie supposés par appel)")
        return

    essais = comparer(client, cas, CONFIGURATIONS, args.repetitions, args.budget_max)
    ecrire_csv(essais, DOSSIER / "resultats" / "essais.csv")
    afficher(resumer(essais))
    a_relire = sorted({(e.cas, e.a_relire) for e in essais if e.a_relire})
    if a_relire:
        print("\nÀ relire à la main (voir resultats/essais.csv) :")
        for identifiant, consigne in a_relire:
            print(f"- {identifiant} : {consigne}")


if __name__ == "__main__":
    main()
