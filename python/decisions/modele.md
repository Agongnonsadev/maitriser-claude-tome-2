# Décision — Modèle du Comptoir (20 octobre 2026)

- **Choix :** Claude Sonnet 5.5 (`claude-sonnet-5-5`), effort `high` (son effort par défaut). `COMPTOIR_EFFORT` peut rester vide.
- **Pourquoi :** 45 réussites sur 45 et une relecture propre, pour 0,0026 $ par réussite ; latence médiane de 2,2 s.
- **Écarté :**
  - Opus 5.5 : 1,6 à 1,8 fois plus cher, rien de réussi en plus sur ces cas.
  - Sonnet 5.5 en `low` : la consigne de langue ignorée trois fois sur trois, pour 22 % d'économie par réussite.
  - Haiku 5.5, pour l'instant : des libertés avec les informations (« uniquement à Cotonou », un numéro de commande qui n'existe pas). Plus de vingt fois moins cher : candidat des questions simples, derrière un routeur (chapitre 12).
- **Non mesuré :** l'effort `medium`, suggéré par la documentation pour un chat avec Sonnet 5.5.
- **Budget :** 19 $ par mois pour 7 200 appels au coût mesuré, mais 57,60 $ avec les 3 000 tokens d'entrée prévus au chapitre 1. Le cache (chapitre 11) et le routeur (chapitre 12) sont nécessaires pour tenir les 26 $.
- **À réévaluer :** à chaque nouveau modèle, à chaque changement important du prompt, et au plus tard trois mois après la mise en ligne, avec l'évaluation complète du chapitre 17.

Mesure : `python -m ch03.comparer_modeles --repetitions 3 --budget-max 2`, 15 cas, prompt version 0, 270 appels, 0,6247 $. Détail : `ch03/resultats/essais.csv`.

## Révision du 21 octobre 2026 — l'évaluation du chapitre 17

- **Choix :** le Comptoir aiguillé (commandes et autres demandes) passe sur **Claude Haiku 5.5** (`COMPTOIR_MODELE_COMPTOIR`, défaut `claude-haiku-5-5`). Sonnet 5.5 reste le modèle de la rédaction des réclamations (`COMPTOIR_MODELE`), qui n'a pas été évaluée avec un autre modèle. L'aiguilleur et l'assistant documentaire étaient déjà sur Haiku 5.5.
- **Pourquoi :** sur les 40 cas d'amélioration, trois essais : 92 % (code), 90 % (code et juge) contre 90 % et 85 % pour Sonnet 5.5, six cas gagnés et cinq perdus (hasard) ; sur les 20 cas de vérification : 80 % et 78 % contre 68 % et 62 %, huit cas gagnés et deux perdus (p = 0,11). Awa accepte ses réponses comme celles de Sonnet 5.5 (dix réponses relues à l'aveugle). Coût moyen d'un essai : 0,0009 $ contre 0,0056 $. Budget recalculé avec le mélange du chapitre 12 : environ 5 $ par mois contre environ 27 $.
- **Ce qui a changé depuis le chapitre 3 :** les « libertés avec les informations » de Haiku 5.5 se retrouvent (trois fois sur trois, il transmet une demande d'étiquettes pour 80 bouteilles sans rappeler le seuil de 100), mais Sonnet 5.5 a ses propres échecs (des réponses de quatre phrases), et le code les attrape les uns comme les autres.
- **Pas encore prêt pour tous les clients :** 78 % sur le jeu de vérification, pour un seuil de 90 %. À corriger, une chose à la fois : l'aiguilleur (une garantie classée en réclamation), l'assistant documentaire (des transmissions annoncées sans outil), le contrôle par mots des réclamations (une négation prise pour une promesse), et la règle de longueur (décision d'Awa sur les formules de politesse).
- **À réévaluer :** à chaque modification, par `python -m ch17.evaluer regression` ; avant chaque livraison, par la suite complète et un nouveau jeu de vérification.

Mesure : `python -m ch17.evaluer` (séries et registre dans `ch17/resultats/`), 513 essais, 2,59 $ avec les juges.
