"""Chapitre 10 : l'outil éditeur de texte, exécuté par notre code dans un dossier fermé.

Claude relit la FAQ du site d'Awa, la compare aux conditions officielles, et corrige les
erreurs avec l'outil éditeur. Le script travaille sur une copie, dans un dossier temporaire,
et affiche les différences : rien n'est modifié dans le dépôt.

Lancement, depuis le dossier python/ :  python -m ch10.corriger_faq
"""

import difflib
import shutil
import tempfile
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.conversations import en_blocs
from comptoir.couts import cout
from comptoir.editeur import OUTIL, Editeur
from comptoir.journal import noter
from comptoir.prompt import charger_donnees, rendre_conditions

MODELE_FAQ = Path(__file__).parent / "donnees" / "faq-modele.md"
TOURS_MAX = 8


def main() -> None:
    dossier = Path(tempfile.mkdtemp(prefix="faq-"))
    shutil.copy(MODELE_FAQ, dossier / "faq.md")
    editeur, client = Editeur(dossier), anthropic.Anthropic()
    consigne = (
        "Le fichier faq.md est la FAQ du site de Délices d'Awa. Compare-la aux conditions officielles ci-dessous "
        "et corrige chaque affirmation qui les contredit, sans rien changer d'autre.\n\n<conditions>\n"
        f"{rendre_conditions(charger_donnees())}\n</conditions>"
    )
    messages = [{"role": "user", "content": consigne}]
    total = 0.0
    for _ in range(TOURS_MAX):
        message = client.messages.create(model=config.MODELE, max_tokens=4000, tools=[OUTIL], messages=messages)
        prix = cout(config.MODELE, message.usage)
        noter(message._request_id, config.MODELE, prix, stop_reason=message.stop_reason)
        total += prix.dollars
        messages.append({"role": "assistant", "content": en_blocs(message.content)})
        appels = [b for b in message.content if b.type == "tool_use"]
        for appel in appels:
            print(f"  outil : {appel.input.get('command')} {appel.input.get('path')}")
        if message.stop_reason != "tool_use":
            break
        messages.append({"role": "user", "content": [editeur.resultat(appel) for appel in appels]})

    print("\n" + "".join(b.text for b in message.content if b.type == "text"))
    avant = MODELE_FAQ.read_text(encoding="utf-8").splitlines(keepends=True)
    apres = (dossier / "faq.md").read_text(encoding="utf-8").splitlines(keepends=True)
    print("".join(difflib.unified_diff(avant, apres, "faq.md (avant)", "faq.md (après)")))
    print(f"Coût : {total:.4f} $ (≈ {total * config.TAUX_FCFA:.1f} FCFA)")
    shutil.rmtree(dossier)


if __name__ == "__main__":
    main()
