#!/usr/bin/env sh
# Chapitre 19 : une copie des bases du Comptoir, à lancer chaque nuit sur le serveur (cron), depuis ce dossier.
# SQLite copié à chaud par sa propre commande .backup : la copie est cohérente même si le Comptoir écrit.
# Les copies contiennent des données de clients : gardez-les sur le serveur ou chiffrées, et effacez-les
# selon les mêmes durées que les bases (ici, les 14 dernières).
set -eu
cible="sauvegardes/$(date +%Y-%m-%d)"
mkdir -p "$cible"
for base in boutique conversations budget; do
  docker compose exec -T comptoir python -c \
    "import sqlite3; s=sqlite3.connect('/donnees/$base.sqlite3'); d=sqlite3.connect('/donnees/copie-$base.sqlite3'); s.backup(d); d.close()"
  docker compose cp "comptoir:/donnees/copie-$base.sqlite3" "$cible/$base.sqlite3"
  docker compose exec -T comptoir rm "/donnees/copie-$base.sqlite3"
done
ls -1d sauvegardes/* | sort | head -n -14 | xargs -r rm -rf
