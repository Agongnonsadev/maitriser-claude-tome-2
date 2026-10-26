"""Chapitre 20 : aucun secret ne part dans un commit (hook PreToolUse, sur « git commit »).

Avant que Claude lance un commit, le hook lit ce qui va être enregistré : les changements indexés, et
aussi les fichiers modifiés ou nouveaux quand la commande les ajoute elle-même (git add … && git commit,
git commit -a). Une clé d'API Anthropic, un jeton de Meta, une clé privée, un secret écrit en clair
(MA_CLE_API=…, JETON = "…"), ou un fichier .env : le commit est bloqué (code 2), et Claude lit pourquoi.
Les valeurs de démonstration (« remplacez-moi », « …-de-test », « factice ») passent.

Le même fichier sert dans le plugin garde-secrets (tome-2/code/outils-claude) : il ne connaît aucun nom
propre au Comptoir. Une clé qui a quitté la machine se change, même si le commit est annulé : il le rappelle.
"""

import json
import re
import subprocess
import sys

# Des noms en capitales : variables d'environnement et constantes. L'argument secret="…" d'un test n'en est pas.
NOM_SECRET = r"\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|JETON|PASSWORD|_SEL)[A-Z0-9_]*"
FACTICE = r"(?![^\"'\s]*(?:remplacez|exemple|example|test|factice|fausse|faux|fake|dummy|local|essai|xxxx))"
MOTIFS = [
    ("une clé d'API Anthropic", re.compile(r"sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}")),
    ("un jeton d'accès Meta", re.compile(r"\bEAA[A-Za-z0-9]{60,}")),
    ("une clé privée", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # NOM=valeur, seul sur sa ligne (fichier .env, shell), ou NOM = "valeur" (code) ; pas NOM = os.environ…
    ("un secret écrit en clair", re.compile(
        rf"^\s*(?:export\s+)?{NOM_SECRET}\s*=\s*{FACTICE}[^\s\"'$<{{#]{{8,}}\s*$"
        rf"|\b{NOM_SECRET}\s*[=:]\s*[\"']{FACTICE}[^\"'\s$<{{]{{8,}}[\"']")),
]
# .env.exemple et .env.example ne contiennent que des valeurs factices : permis. Les autres .env, non.
FICHIER_INTERDIT = re.compile(r"(?:^|/)\.env(?:\.(?!exemple$|example$)[^/]+)?$|\.pem$|(?:^|/)\.env\.txt$")
AJOUTE_LUI_MEME = re.compile(r"\bgit\s+add\b|\bgit\s+commit\b[^&|;]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b")


def git(cwd: str, *arguments: str) -> str:
    # Pas de vérification du code de retour : « git diff --no-index » rend 1 quand il trouve une différence.
    return subprocess.run(["git", *arguments], cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace").stdout


def lignes_ajoutees(diff: str):
    """(fichier, numéro de ligne, texte) pour chaque ligne ajoutée d'un diff unifié sans contexte."""
    fichier, numero = "", 0
    for ligne in diff.splitlines():
        if ligne.startswith("+++ "):
            fichier = ligne[6:] if ligne.startswith("+++ b/") else ""
        elif ligne.startswith("@@"):
            numero = int(re.search(r"\+(\d+)", ligne).group(1))
        elif ligne.startswith("+") and fichier:
            yield fichier, numero, ligne[1:]
            numero += 1


def masquer(secret: str) -> str:
    return secret[:6] + "…" if len(secret) > 6 else "…"


def trouver(cwd: str, commande: str) -> list[str]:
    tout = bool(AJOUTE_LUI_MEME.search(commande))
    diffs = [git(cwd, "diff", "--cached", "-U0", "--no-color")]
    noms = git(cwd, "diff", "--cached", "--name-only").splitlines()
    if tout:
        diffs.append(git(cwd, "diff", "-U0", "--no-color"))
        noms += git(cwd, "diff", "--name-only").splitlines()
        nouveaux = git(cwd, "ls-files", "--others", "--exclude-standard").splitlines()
        noms += nouveaux
        for nom in nouveaux:
            diffs.append(git(cwd, "diff", "--no-index", "-U0", "--no-color", "/dev/null", nom))
    trouvailles = [f"{nom} : un fichier de secrets ne va jamais dans Git" for nom in dict.fromkeys(noms)
                   if FICHIER_INTERDIT.search(nom)]
    for diff in diffs:
        for fichier, numero, texte in lignes_ajoutees(diff):
            for nature, motif in MOTIFS:
                if trouve := motif.search(texte):
                    trouvailles.append(f"{fichier}:{numero} : {nature} ({masquer(trouve.group().strip())})")
    for nature, motif in MOTIFS[:3]:  # le message du commit, aussi
        if trouve := motif.search(commande):
            trouvailles.append(f"le message du commit : {nature} ({masquer(trouve.group())})")
    return trouvailles


def main() -> int:
    entree = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stderr.reconfigure(encoding="utf-8")
    commande = (entree.get("tool_input") or {}).get("command", "")
    if not re.search(r"\bgit\s+commit\b", commande):
        return 0
    trouvailles = trouver(entree.get("cwd") or ".", commande)
    if not trouvailles:
        return 0
    print("Commit bloqué par le garde des secrets :\n- " + "\n- ".join(trouvailles) +
          "\nRetirez ces lignes ou ces fichiers du commit (git restore --staged <fichier>), mettez le secret dans "
          "l'environnement, et prévenez la personne responsable : un secret qui a pu quitter la machine se change.",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
