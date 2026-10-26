"""Chapitre 12 : Claude Haiku 5.5 réfléchit-il quand on le lui interdit ? Sept requêtes, une question.

La même question, posée sept fois à Claude Haiku 5.5 avec max_tokens 1 000 : sans document, avec la
base d'Awa en blocs search_result (citations activées ou non), puis en texte brut. On relève les
tokens de réflexion et la raison de l'arrêt. Coût : moins d'un centime.

Lancement, depuis le dossier python/ :  python -m ch12.reflexion_et_citations
"""

import anthropic

from comptoir import documentaire
from comptoir.connaissances import charger_base
from comptoir.couts import cout
from comptoir.journal import noter
from comptoir.prompt import message_client

MODELE = "claude-haiku-5-5"
QUESTION = "Je confirme ma commande samedi à 15 h : je suis livré quand ?"


def cas(base) -> list[tuple[str, dict]]:
    def documents(citations: bool, effort: str | None = None, disabled: bool = True) -> dict:
        r = documentaire.construire_requete(QUESTION, base, cache="1h", modele=MODELE, max_tokens=1000,
                                            sans_reflexion=disabled, avec_citations=citations)
        if effort:
            r["output_config"] = {"effort": effort}
        return r

    seule = {"model": MODELE, "max_tokens": 1000, "system": documentaire.charger_prompt().texte,
             "messages": [{"role": "user", "content": message_client(QUESTION)}]}
    texte = "\n\n".join(f"## {m.titre}\n{m.texte}" for m in base)
    brut = {**seule, "messages": [{"role": "user", "content": f"<documents>\n{texte}\n</documents>\n\n"
                                   + message_client(QUESTION)}]}
    return [
        ("sans document, réflexion désactivée", {**seule, "thinking": {"type": "disabled"}}),
        ("sans document, effort low", {**seule, "output_config": {"effort": "low"}}),
        ("search_result avec citations, désactivée", documents(True)),
        ("search_result avec citations, effort low", documents(True, "low", disabled=False)),
        ("search_result avec citations, désactivée et low", documents(True, "low")),
        ("search_result sans citations, désactivée", documents(False)),
        ("base en texte brut, désactivée", {**brut, "thinking": {"type": "disabled"}}),
    ]


def main() -> None:
    client, total = anthropic.Anthropic(), 0.0
    for nom, requete in cas(charger_base()):
        reponse = client.messages.create(**requete)
        prix = cout(MODELE, reponse.usage)
        total += prix.dollars
        noter(reponse._request_id, MODELE, prix, prompt="ch12-reflexion", stop_reason=reponse.stop_reason)
        reflexion = getattr(reponse.usage.output_tokens_details, "thinking_tokens", 0) or 0
        print(f"{nom:50} réflexion {reflexion:>4} tokens  sortie {reponse.usage.output_tokens:>4}  "
              f"arrêt {reponse.stop_reason}")
    print(f"\nCoût : {total:.4f} $")


if __name__ == "__main__":
    main()
