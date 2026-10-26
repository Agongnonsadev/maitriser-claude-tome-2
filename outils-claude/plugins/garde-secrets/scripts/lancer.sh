#!/bin/sh
# Lance un script Python du plugin avec le Python du système (aucune dépendance hors de la bibliothèque standard).
dossier="$(dirname "$0")"
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c "import sys" >/dev/null 2>&1; then
    exec "$py" "$dossier/$1.py"
  fi
done
echo "Plugin garde-secrets : aucun interpréteur Python trouvé." >&2
exit 1
