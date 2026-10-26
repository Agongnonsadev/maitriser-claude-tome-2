#!/usr/bin/env sh
# Chapitre 21 : remettre une base sauvegardée par sauvegarder.sh. Sur le serveur, depuis ce dossier :
#   ./restaurer.sh 2026-10-22 conversations        (ou boutique, ou budget)
# Le Comptoir est arrêté le temps de la copie. La copie se fait dans un conteneur jetable, au nom de root,
# puis le fichier est rendu à l'utilisateur du Comptoir : copiée par « docker cp », une base appartient à
# root et le Comptoir, sans droits, ne peut plus y écrire (essayé au chapitre 21).
set -eu
date="$1"; base="$2"
test -f "sauvegardes/$date/$base.sqlite3" || { echo "Pas de sauvegarde sauvegardes/$date/$base.sqlite3" >&2; exit 1; }
docker compose stop comptoir
docker compose run --rm --no-deps --user root -v "$PWD/sauvegardes:/sauvegardes:ro" --entrypoint sh comptoir -c \
  "cp /sauvegardes/$date/$base.sqlite3 /donnees/$base.sqlite3 && chown comptoir:comptoir /donnees/$base.sqlite3"
docker compose start comptoir
echo "Base $base remise à l'état du $date. Vérifiez /sante et le tableau de bord."
