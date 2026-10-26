# Procédure de migration du Comptoir

Chapitre 21. Pour un modèle retiré ou remplacé, une nouvelle version majeure du SDK, ou une nouvelle version de l'API. Une migration est une variante comme une autre (chapitre 17) : elle se mesure avant de se livrer.

## 1. Savoir qu'il faut migrer

- Chaque lundi, ou par le job planifié `veille.yml` : `python -m ch21.veille`. Le code de sortie vaut 1 s'il y a une alerte.
- La veille croise deux sources : la page *Model deprecations* (état publié, date de retrait) et l'API Models (ce que la clé voit). Le 22 octobre 2026, elles n'étaient pas d'accord sur Claude Sonnet 4.5 : la page fait foi.
- Anthropic prévient au moins 60 jours avant le retrait d'un modèle publié, par courriel et dans la documentation. Lisez aussi les notes de version de la plateforme.
- Pour savoir quel modèle sert réellement : Console, page Usage, Export (le détail par clé et par modèle).

## 2. Lire avant de toucher

- Le guide de migration du modèle (par exemple *Claude Haiku 5.5 migration guide*) ou de la version d'API (*Migrating to API version 2026-10-21*).
- Cherchez dans le code chaque rupture qui vous concerne, et écrivez le résultat dans une décision (`decisions/`), même quand il n'y a rien à changer.
- Pour un modèle : le prix, le nombre de tokens d'un même texte, les paramètres refusés, l'effort par défaut, la réflexion.

## 3. Essayer à part

- Une branche, et un environnement séparé (`python -m venv .venv-essai`), les autres dépendances figées aux mêmes versions (`pip freeze` en contraintes) : on ne mesure qu'un changement à la fois.
- Un modèle : une variante dans `ch17/suite.py` (`/nouvelle-variante` dans Claude Code), jamais un changement direct de `comptoir/config.py`.

## 4. Mesurer

Dans l'ordre, du gratuit au payant :

1. `python -m pytest -q` : aucun appel.
2. Un appel minimal, pour voir ce qui part vraiment (`with_raw_response`, en-têtes).
3. `python -m ch17.evaluer regression --budget-max 0.3` : 33 cas, environ 0,03 $.
4. Pour un modèle : la suite complète du chapitre 17 (40 cas, trois essais, le juge), puis le jeu de vérification, une seule fois. `python -m ch17.comparer` contre la série de la version livrée.
5. `python -m ch19.mesurer_cout --variante … --essais 1` : le coût par conversation, toutes étapes comprises.
6. L'image (`ch19/deploiement/`) reconstruite, et un message réel.

## 5. Décider, livrer, garder la porte ouverte

- La décision écrite : ce qui a changé, ce qui a été mesuré, ce qui a été choisi, et comment revenir en arrière.
- Les dépendances de l'image recalculées (`uv pip compile … --generate-hashes`), la non-régression dans la CI, puis la mise en production (`docs/exploitation.md`).
- Le retour arrière tient tant que l'ancien modèle ou l'ancienne version d'API répond : notez jusqu'à quand.
