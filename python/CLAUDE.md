# Le Comptoir d'Awa

Assistant de commandes et de service client pour Délices d'Awa (entreprise fictive), en Python 3.10+ avec le SDK `anthropic` 2.x (API `2026-10-21`). Code d'accompagnement du Tome 2 de « Maîtriser Claude » (Botlyx Academy).

## Commandes
- Installer : `pip install -e ".[tests]"` dans un environnement virtuel `.venv`
- Tester : `python -m pytest` (aucun test n'appelle l'API ; les tests utilisent un faux client)
- Lancer un script de chapitre : `python -m ch02.comptoir_cli "question"` depuis ce dossier

## Organisation
- `comptoir/` : code commun (configuration, coûts, journal, notation)
- `chNN/` : scripts du chapitre NN
- `tests/` : un fichier de test par module ou par chapitre

## Règles
- Ne jamais lire, afficher ni écrire la clé d'API. Elle vit dans `ANTHROPIC_API_KEY`, jamais dans le code ni dans un fichier.
- Ne jamais lancer un script qui appelle l'API sans que je le demande : chaque appel est payant.
- Le modèle et l'effort viennent de `comptoir/config.py`, jamais d'une chaîne en dur dans le code du Comptoir.
- Les montants exacts (prix, totaux, frais) sont calculés par le code, jamais par le modèle.
- Les prix de `comptoir/couts.py` viennent de la page Pricing d'Anthropic : ne pas les modifier sans source datée.
- Chaque nouvelle fonction a ses tests ; un test ne doit jamais appeler l'API.
- Ne pas toucher aux fichiers hors du périmètre de la tâche demandée.
- Textes destinés aux clients d'Awa : en français, avec le vouvoiement.

## Outils du projet (chapitre 20)
- Avant un commit : `/verify` (tests et relecture du diff, gratuit). Relecture approfondie : `/relecture`.
- Règles par dossier : `.claude/rules/` (tests, prompts, coûts), chargées quand vous touchez ces fichiers.
- Les hooks de `.claude/settings.json` bloquent un secret dans un commit, un vrai client dans `tests/`, la modification d'une version publiée de prompt, relancent les tests en fin de tour, et notent chaque commande dans `.claude/journal-outils.jsonl` : ne cherchez pas à les contourner, dites à Yao ce qui bloque.
