---
name: nouvelle-variante
description: Prépare une variante du Comptoir à évaluer (chapitre 17) - un seul changement, son test, l'estimation gratuite. Ne lance jamais la série payante.
disable-model-invocation: true
argument-hint: "[ce qui change, par exemple : prompt v6 plus court]"
---

# Préparer une variante

Le changement demandé : $ARGUMENTS

1. Une variante ne change qu'une chose par rapport à la version livrée (`VARIANTES["livree"]` dans `ch17/suite.py`). Si la demande en change deux, arrêtez-vous et proposez deux variantes.
2. Si le changement est un prompt, écrivez la version suivante dans `comptoir/prompts/` ; ne modifiez jamais une version existante.
3. Ajoutez la variante à `VARIANTES`, avec un nom court en minuscules, et complétez le test des variantes dans `tests/test_ch17.py`.
4. Lancez `python -m pytest tests/test_ch17.py -q`.
5. Donnez à Yao la commande d'estimation, gratuite : `python -m ch17.evaluer estimer --jeu amelioration --essais 3`, puis celle de la série, **sans la lancer** : `python -m ch17.evaluer lancer --variante <nom> --jeu amelioration --essais 3 --budget-max 0.3`.
