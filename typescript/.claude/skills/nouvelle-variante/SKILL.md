---
name: nouvelle-variante
description: Prépare une variante du Comptoir à évaluer (chapitre 17) - un seul changement, son test, l'estimation gratuite. Ne lance jamais la série payante.
disable-model-invocation: true
argument-hint: "[ce qui change, par exemple : prompt v6 plus court]"
---

# Préparer une variante

Le changement demandé : $ARGUMENTS

1. Une variante ne change qu'une chose par rapport à la version livrée (`VARIANTES.livree` dans `ch17/suite.ts`). Si la demande en change deux, arrêtez-vous et proposez deux variantes.
2. Si le changement est un prompt, écrivez la version suivante dans `../python/comptoir/prompts/`, commun aux deux versions ; ne modifiez jamais une version existante.
3. Ajoutez la variante à `VARIANTES`, avec un nom court en minuscules, et complétez le test des variantes dans `tests/ch17.test.ts`.
4. Lancez `npm test`.
5. Donnez à Yao la commande d'estimation, gratuite : `npx tsx ch17/evaluer.ts estimer --jeu amelioration --essais 3`, puis celle de la série, **sans la lancer** : `npx tsx ch17/evaluer.ts lancer --variante <nom> --jeu amelioration --essais 3 --budget-max 0.3`.
