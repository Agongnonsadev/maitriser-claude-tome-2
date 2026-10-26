"""Chapitre 20 : ce que Claude Code ne modifie pas sans que Yao le voie (hook PreToolUse, Edit et Write).

CLAUDE.md demande ces règles ; ce hook les fait respecter, à chaque fois, sans que Claude ait à s'en souvenir :
- une version de prompt ne se modifie pas : on écrit la suivante, et on l'évalue (chapitres 5 et 17) ;
- un test n'appelle jamais l'API : pas de vrai client dans tests/, sauf vers un faux serveur local ;
- les prix de comptoir/couts.py viennent de la page Pricing d'Anthropic : Yao confirme chaque modification.

Entrée : l'événement en JSON sur l'entrée standard. Sortie : rien (pas d'objection), ou une décision
« deny » ou « ask » avec sa raison, que Claude lit.
"""

import json
import os
import re
import sys
from pathlib import Path

PROMPT_VERSIONNE = re.compile(r"^comptoir/prompts/[a-z_]+_v\d+\.md$")
CLIENT = re.compile(r"\b(?:Async)?Anthropic\(|\bcreer_client\(")
SERVEUR_LOCAL = re.compile(r"base_url\s*=\s*f?[\"']https?://(?:127\.0\.0\.1|localhost)")


def relatif(chemin: str, racine: Path) -> str:
    """Le chemin du fichier par rapport au projet, avec des barres obliques, sous Windows aussi."""
    if not chemin:
        return ""
    p = Path(chemin)
    try:
        p = p.resolve().relative_to(racine.resolve())
    except (ValueError, OSError):
        pass
    return p.as_posix()


def textes_ecrits(arguments: dict) -> list[str]:
    """Ce que l'outil va écrire : le contenu de Write, le nouveau texte d'Edit (ou de chaque Edit groupé)."""
    textes = [arguments.get("content") or "", arguments.get("new_string") or ""]
    textes += [e.get("new_string") or "" for e in arguments.get("edits") or []]
    return [t for t in textes if t]


def appelle_l_api(texte: str) -> bool:
    """Un vrai client, ou creer_client() : interdits dans un test. Un client vers 127.0.0.1 reste permis
    (le faux serveur du chapitre 6)."""
    for trouve in CLIENT.finditer(texte):
        if trouve.group().startswith("creer_client"):
            return True
        if not SERVEUR_LOCAL.search(texte[trouve.end():trouve.end() + 400]):
            return True
    return False


def examiner(entree: dict, racine: Path) -> tuple[str, str] | None:
    arguments = entree.get("tool_input") or {}
    fichier = relatif(arguments.get("file_path", ""), racine)
    if PROMPT_VERSIONNE.match(fichier) and (racine / fichier).exists():
        version = int(re.search(r"_v(\d+)\.md$", fichier).group(1))
        suivante = re.sub(r"_v\d+\.md$", f"_v{version + 1}.md", fichier)
        return "deny", (f"{fichier} est une version publiée : des séries d'évaluation y renvoient par son empreinte. "
                        f"Écrivez la version suivante ({suivante}), puis évaluez-la comme une variante (chapitre 17).")
    if fichier.startswith("tests/") and any(appelle_l_api(t) for t in textes_ecrits(arguments)):
        return "deny", ("Un test n'appelle jamais l'API : chaque appel est payant. Utilisez un faux client "
                        "(voir FauxClient dans les tests existants), ou un faux serveur sur 127.0.0.1.")
    if fichier == "comptoir/couts.py":
        return "ask", ("Les prix de comptoir/couts.py viennent de la page Pricing d'Anthropic. "
                       "La modification a-t-elle une source datée ? Yao confirme lui-même.")
    return None


def main() -> int:
    # Claude Code écrit et lit en UTF-8 ; la console Windows, non : on ne laisse pas Python deviner.
    entree = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stdout.reconfigure(encoding="utf-8")
    racine = Path(os.environ.get("CLAUDE_PROJECT_DIR") or entree.get("cwd") or ".")
    resultat = examiner(entree, racine)
    if resultat:
        decision, raison = resultat
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                                 "permissionDecisionReason": raison}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
