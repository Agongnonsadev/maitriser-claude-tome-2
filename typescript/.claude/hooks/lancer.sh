#!/bin/sh
# Chapitre 20 : lance un hook du projet, écrit en TypeScript, avec Node seul : Node 22 retire les types
# (--experimental-strip-types, actif par défaut depuis Node 22.18) ; le hook n'importe rien du projet.
# Claude Code exécute les hooks par sh sous macOS et Linux, par Git Bash sous Windows.
racine="${CLAUDE_PROJECT_DIR:-.}"
if command -v node >/dev/null 2>&1; then
  exec node --experimental-strip-types --disable-warning=ExperimentalWarning "$racine/.claude/hooks/$1.ts"
fi
echo "Hook $1 : Node est introuvable." >&2
exit 1
