#!/bin/sh
# Chapitre 20 : lance un hook Python du projet avec le Python du projet (.venv), sinon celui du système.
# Claude Code exécute les hooks par sh sous macOS et Linux, par Git Bash sous Windows.
racine="${CLAUDE_PROJECT_DIR:-.}"
for py in "$racine/.venv/bin/python" "$racine/.venv/Scripts/python.exe" python3 python; do
  if command -v "$py" >/dev/null 2>&1; then
    exec "$py" "$racine/.claude/hooks/$1.py"
  fi
done
echo "Hook $1 : aucun interpréteur Python trouvé." >&2
exit 1
