"""Chapitre 20 : ce que Claude a lancé ou modifié, dans un journal local (hook PostToolUse).

Une ligne JSON par commande ou par fichier : la date, la séance, l'outil, la commande ou le chemin. Jamais
le contenu d'un fichier ni la sortie d'une commande : le journal dit ce qui s'est passé, pas ce qui a été lu.
Il sert à relire une séance longue ou sans surveillance, comme le journal des appels du Comptoir
(chapitre 2). Il reste sur le poste (.claude/.gitignore).
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

JOURNAL = Path(".claude") / "journal-outils.jsonl"


def ligne(entree: dict) -> dict:
    arguments = entree.get("tool_input") or {}
    return {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "seance": entree.get("session_id"),
            "outil": entree.get("tool_name"),
            "cible": (arguments.get("command") or arguments.get("file_path") or "")[:500]}


def main() -> int:
    entree = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    chemin = Path(os.environ.get("CLAUDE_PROJECT_DIR") or ".") / JOURNAL
    chemin.parent.mkdir(exist_ok=True)
    with chemin.open("a", encoding="utf-8") as f:
        f.write(json.dumps(ligne(entree), ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
