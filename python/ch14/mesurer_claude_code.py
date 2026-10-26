"""Chapitre 14 : trois questions de Yao à Claude Code, sur la copie des commandes, par MCP.

Lancement, depuis le dossier python/ (APPEL PAYANT : Claude Code utilise votre clé d'API) :
    python -m ch14.mesurer_claude_code --claude "chemin/vers/claude" --budget-max 0.40

Chaque question est posée dans une séance neuve de `claude -p`, qui charge le serveur MCP du
fichier .mcp.json (portée projet). Seuls les deux outils du serveur des commandes sont permis ;
tout autre outil est refusé (--permission-mode dontAsk). Chaque réponse est comparée aux bonnes
réponses calculées par le code (ch14/verites.py), et le coût est lu dans la sortie JSON.
"""

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from ch14.serveurs import RACINE
from ch14.verites import calculer

OUTILS = "mcp__commandes__execute_sql,mcp__commandes__search_objects"
RESULTATS = RACINE / "ch14" / "resultats"
MODELE = "claude-sonnet-5-5"  # le modèle du Comptoir (chapitre 3)

QUESTIONS = [
    ("schema", "Décris-moi la base des commandes branchée par MCP : quelles tables, et comment une "
               "commande est reliée à ses produits et au quartier du client ? Réponds en cinq lignes au plus."),
    ("quartiers", "Du lundi 21 septembre au dimanche 18 octobre 2026, quels sont les trois quartiers qui ont "
                  "rapporté le plus, en FCFA, et combien de commandes pour chacun ? Donne les montants exacts."),
    ("abandons", "Combien de conversations ont reçu au moins un récapitulatif sans qu'aucun ne devienne une "
                 "commande, sur combien de conversations au total ? À quelle heure de la journée le taux "
                 "d'abandon est-il le plus élevé (parmi les heures d'au moins 20 récapitulatifs) ?"),
]


def chiffres(texte: str) -> str:
    """« 194 500 » ou « 194.500 » ou « 194 500 » : on compare les chiffres sans les séparateurs."""
    return re.sub(r"(?<=\d)[\s  .,](?=\d{3}\b)", "", texte)


def verifier(question: str, reponse: str, verites: dict) -> list[str]:
    """Les écarts entre la réponse et ce que le code a calculé. Liste vide : réponse juste."""
    texte = chiffres(reponse)
    ecarts = []
    if question == "schema":
        for mot in ("recapitulatifs", "commandes", "lignes", "quartier"):
            if mot not in texte.lower().replace("é", "e"):
                ecarts.append(f"ne cite pas « {mot} »")
        if "json" not in texte.lower():
            ecarts.append("ne dit pas que les lignes sont en JSON")
    elif question == "quartiers":
        for q in verites["quartiers"]:
            if q["quartier"] not in reponse:
                ecarts.append(f"quartier manquant : {q['quartier']}")
            if str(q["fcfa"]) not in texte:
                ecarts.append(f"montant manquant pour {q['quartier']} : {q['fcfa']}")
            if not re.search(rf"\b{q['commandes']}\b", texte):
                ecarts.append(f"nombre de commandes manquant pour {q['quartier']} : {q['commandes']}")
    elif question == "abandons":
        for cle in ("abandons", "conversations"):
            if not re.search(rf"\b{verites[cle]}\b", texte):
                ecarts.append(f"{cle} : {verites[cle]} attendu")
        heure = verites["heure_pire_abandon"]
        if not re.search(rf"\b{heure}\s*h|\b{heure}:00|\b{heure} heures", texte):
            ecarts.append(f"heure attendue : {heure} h")
    return ecarts


def poser(claude: str, question: str, budget: float) -> dict:
    commande = [claude, "-p", question, "--model", MODELE, "--output-format", "json",
                "--allowedTools", OUTILS, "--permission-mode", "dontAsk",
                "--max-budget-usd", f"{budget:.2f}", "--no-session-persistence"]
    sortie = subprocess.run(commande, cwd=RACINE, capture_output=True, text=True, encoding="utf-8", timeout=600)
    if sortie.returncode != 0 and not sortie.stdout.strip():
        raise RuntimeError(f"claude -p a échoué : {sortie.stderr[-800:]}")
    return json.loads(sortie.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--claude", default="claude", help="le programme claude (Claude Code)")
    parser.add_argument("--budget-max", type=float, default=0.40, help="plafond par question, en dollars")
    parser.add_argument("--seulement", choices=[q for q, _ in QUESTIONS])
    args = parser.parse_args()
    verites = calculer()
    RESULTATS.mkdir(parents=True, exist_ok=True)
    total = 0.0
    for nom, question in QUESTIONS:
        if args.seulement and nom != args.seulement:
            continue
        resultat = poser(args.claude, question, args.budget_max)
        reponse = resultat.get("result", "")
        ecarts = verifier(nom, reponse, verites)
        cout = resultat.get("total_cost_usd", 0.0)
        total += cout
        horodatage = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (RESULTATS / f"{horodatage}-{nom}.json").write_text(
            json.dumps({"question": question, "ecarts": ecarts, "sortie": resultat}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"\n=== {nom} : {'juste' if not ecarts else 'ÉCARTS : ' + ' ; '.join(ecarts)}")
        print(f"{resultat.get('num_turns')} tours, {cout:.4f} $, arrêt : {resultat.get('subtype')}")
        print(reponse.strip()[:1500])
    print(f"\nCoût total : {total:.4f} $")


if __name__ == "__main__":
    main()
