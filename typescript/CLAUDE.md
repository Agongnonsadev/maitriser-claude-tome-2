# Le Comptoir d'Awa, en TypeScript

Assistant de commandes et de service client pour Délices d'Awa (entreprise fictive), en TypeScript sur Node 22.13 ou plus récent, avec le SDK `@anthropic-ai/sdk` 1.x (API `2026-10-21`). Code d'accompagnement du Tome 2 de « Maîtriser Claude » (Botlyx Academy) : l'équivalent de la version Python (`../python/`), qui reste la référence du livre.

## Commandes
- Installer : `npm ci`
- Tester : `npm test` (aucun test n'appelle l'API ; les tests utilisent un faux client). Vérifier les types : `npm run typecheck`
- Lancer un script de chapitre : `npx tsx ch02/comptoir_cli.ts "question"` depuis ce dossier

## Organisation
- `comptoir/` : code commun (configuration, coûts, journal, notation), les mêmes modules qu'en Python
- `chNN/` : scripts du chapitre NN, aux mêmes noms qu'en Python
- `tests/` : un fichier de test par module ou par chapitre ; `faux_clients.ts` pour les faux clients
- Les données communes aux deux versions (catalogue, prompts, base d'Awa, cas d'évaluation) restent dans `../python/` : cette version les y lit. Une seule copie.

## Règles
- Ne jamais lire, afficher ni écrire la clé d'API. Elle vit dans `ANTHROPIC_API_KEY`, jamais dans le code ni dans un fichier.
- Ne jamais lancer un script qui appelle l'API sans que je le demande : chaque appel est payant.
- Le modèle et l'effort viennent de `comptoir/config.ts`, jamais d'une chaîne en dur dans le code du Comptoir.
- Les montants exacts (prix, totaux, frais) sont calculés par le code, jamais par le modèle.
- Les prix de `comptoir/couts.ts` viennent de la page Pricing d'Anthropic : ne pas les modifier sans source datée.
- Ce qui doit donner le même résultat que la version Python passe par `comptoir/python.ts` (repr, json.dumps, sum, moyenne), `comptoir/arrondi.ts` (round) et `comptoir/hasard.ts` (random.Random).
- Chaque nouvelle fonction a ses tests ; un test ne doit jamais appeler l'API.
- Ne pas toucher aux fichiers hors du périmètre de la tâche demandée.
- Textes destinés aux clients d'Awa : en français, avec le vouvoiement.

## Outils du projet (chapitre 20)
- Avant un commit : `/verify` (tests, types et relecture du diff, gratuit). Relecture approfondie : `/relecture`.
- Règles par dossier : `.claude/rules/` (tests, prompts, coûts), chargées quand vous touchez ces fichiers.
- Les hooks de `.claude/settings.json` bloquent un secret dans un commit, un vrai client dans `tests/`, la modification d'une version publiée de prompt, relancent les tests en fin de tour, et notent chaque commande dans `.claude/journal-outils.jsonl` : ne cherchez pas à les contourner, dites à Yao ce qui bloque. Ce sont des programmes TypeScript sans dépendance, que Node lance seul.
