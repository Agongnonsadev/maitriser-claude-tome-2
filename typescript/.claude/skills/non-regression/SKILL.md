---
name: non-regression
description: Lance la non-régression du chapitre 17 sur la version livrée (33 cas, payant, environ 0,03 $, plafonné à 0,30 $) et résume le résultat.
disable-model-invocation: true
allowed-tools: Bash(npx tsx ch17/evaluer.ts regression *) PowerShell(npx tsx ch17/evaluer.ts regression *)
---

# La non-régression

Yao vient de la demander : c'est la seule raison de lancer ce script payant.

1. Lancez `npx tsx ch17/evaluer.ts regression --budget-max 0.3` depuis ce dossier.
2. Résumez : le nombre de cas réussis sur 33, le coût, et pour chaque échec le cas, ce que la notation reproche, et la phrase de la réponse en cause.
3. Ne relancez pas un cas qui échoue pour obtenir du vert : un échec se lit, se rejoue au plus trois fois pour compter, et se décide (chapitre 18).
