"""Chapitre 12 : l'évaluateur coche-t-il avant ou après avoir écrit sa critique ? 40 appels.

Deux réponses à une réclamation : l'une conforme, l'autre qui promet une livraison. Chacune est
relue dix fois par Claude Haiku 5.5 avec le schéma d'évaluation, les cases d'abord puis la critique
d'abord. Une sortie structurée suit l'ordre des propriétés requises du schéma : la case
« promet_quelque_chose » est donc remplie avant, ou après, l'avis. Coût : moins d'un centime.

Lancement, depuis le dossier python/ :  python -m ch12.ordre_des_champs
"""

import json
from concurrent.futures import ThreadPoolExecutor

import anthropic

from comptoir import reclamations
from comptoir.couts import cout
from comptoir.journal import noter

MODELE = reclamations.MODELE_AUXILIAIRE
CONFORME = ("Nous sommes sincèrement désolés pour cette bouteille manquante dans votre livraison. Votre réclamation "
            "est transmise à Awa, qui vous répondra sous 24 heures, conformément à nos conditions de vente. "
            "Pourriez-vous nous préciser quel produit était concerné ?")
PROMESSE = ("Nous sommes sincèrement désolés pour cette bouteille manquante. Votre réclamation est transmise à Awa, "
            "qui vous répondra sous 24 heures, et la bouteille vous sera livrée dès demain.")


def schema(critique_d_abord: bool) -> dict:
    """Le schéma du Comptoir (critique d'abord), ou sa première version (cases d'abord)."""
    s = json.loads(json.dumps(reclamations.SCHEMA_EVALUATION))
    if not critique_d_abord:
        proprietes = s["properties"]
        s["properties"] = {**{k: v for k, v in proprietes.items() if k != "critique"}, "critique": proprietes["critique"]}
        s["required"] = [k for k in s["required"] if k != "critique"] + ["critique"]
    return s


def relire(client, texte: str, critique_d_abord: bool) -> tuple[dict, float]:
    reponse = client.messages.create(model=MODELE, max_tokens=600, system=reclamations.SYSTEME_EVALUATION,
                                     messages=[{"role": "user", "content": f"<reponse>{texte}</reponse>"}],
                                     output_config={"format": {"type": "json_schema", "schema": schema(critique_d_abord)}})
    prix = cout(MODELE, reponse.usage)
    noter(reponse._request_id, MODELE, prix, prompt="ch12-ordre-des-champs", stop_reason=reponse.stop_reason)
    return json.loads("".join(b.text for b in reponse.content if b.type == "text")), prix.dollars


def main() -> None:
    client, total = anthropic.Anthropic(), 0.0
    for nom, texte in [("réponse conforme", CONFORME), ("réponse qui promet", PROMESSE)]:
        for critique_d_abord in (False, True):
            with ThreadPoolExecutor(max_workers=5) as executeur:
                resultats = list(executeur.map(lambda _: relire(client, texte, critique_d_abord), range(10)))
            total += sum(prix for _, prix in resultats)
            promet = sum(j["promet_quelque_chose"] for j, _ in resultats)
            ordre = "critique d'abord" if critique_d_abord else "cases d'abord"
            print(f"{nom:20} {ordre:17} : « promet » coché {promet} fois sur 10 ; "
                  f"premier champ rendu : {next(iter(resultats[0][0]))}")
            print(f"{'':20} exemple de critique : {resultats[0][0]['critique'][:150]}")
    print(f"\nCoût : {total:.4f} $")


if __name__ == "__main__":
    main()
