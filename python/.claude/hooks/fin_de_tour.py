"""Chapitre 20 : Claude ne rend pas la main sur des tests rouges (hook Stop).

Quand Claude a fini de répondre, le hook regarde si du code Python a changé depuis le dernier passage au
vert. Si oui, la suite de tests tourne (sans appel payant : un faux client partout). Rouge : le hook
renvoie la fin du rapport avec « decision: block », et Claude continue pour corriger, ou explique pourquoi
l'échec est attendu. Vert : l'empreinte des changements est notée, pour ne pas relancer la même suite.

Claude Code arrête lui-même la boucle après huit relances de suite (documentation des hooks).
COMPTOIR_HOOK_TESTS remplace la commande de test (pour les tests du hook).
"""

import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

ETAT = Path(".claude") / ".dernier-vert"   # ignoré par Git (.claude/.gitignore)


def git(racine: Path, *arguments: str) -> str:
    return subprocess.run(["git", *arguments], cwd=racine, capture_output=True, text=True, encoding="utf-8",
                          errors="replace").stdout


def empreinte(racine: Path) -> str:
    """L'état du code Python par rapport au dernier commit : modifié, ajouté ou nouveau. Vide si rien n'a changé."""
    diff = git(racine, "diff", "HEAD", "--no-color", "--", "*.py")
    nouveaux = git(racine, "ls-files", "--others", "--exclude-standard", "--", "*.py").split()
    if not diff and not nouveaux:
        return ""
    h = hashlib.sha256(diff.encode("utf-8"))
    for nom in sorted(nouveaux):
        h.update(nom.encode("utf-8"))
        h.update((racine / nom).read_bytes())
    return h.hexdigest()


def main() -> int:
    json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    sys.stdout.reconfigure(encoding="utf-8")
    racine = Path(os.environ.get("CLAUDE_PROJECT_DIR") or ".")
    actuelle = empreinte(racine)
    etat = racine / ETAT
    if not actuelle or (etat.exists() and etat.read_text(encoding="utf-8") == actuelle):
        return 0
    commande = shlex.split(os.environ.get("COMPTOIR_HOOK_TESTS", "")) or [
        sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider"]
    resultat = subprocess.run(commande, cwd=racine, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if resultat.returncode == 0:
        etat.parent.mkdir(exist_ok=True)
        etat.write_text(actuelle, encoding="utf-8")
        return 0
    fin = "\n".join((resultat.stdout + resultat.stderr).strip().splitlines()[-25:])
    print(json.dumps({"decision": "block", "reason": (
        "La suite de tests échoue après vos modifications. Corrigez avant de rendre la main, ou expliquez à Yao "
        "pourquoi l'échec est attendu. Fin du rapport :\n" + fin)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
