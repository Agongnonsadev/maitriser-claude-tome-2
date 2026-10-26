---
name: relecture
description: Relecture d'un diff ou d'une demande de fusion du Comptoir par le sous-agent relecteur, contre les règles du projet. Lecture seule.
disable-model-invocation: true
argument-hint: "[rien : la branche contre main | une plage git | un numéro de demande de fusion]"
context: fork
agent: relecteur
background: false
---

Relisez ce changement : $ARGUMENTS

- Sans précision, c'est la branche courante contre `main`, modifications non commitées comprises : `git diff main...HEAD` puis `git diff HEAD`.
- Une plage (`main...ma-branche`, `HEAD~3..HEAD`) : `git diff <plage>`.
- Un numéro de demande de fusion : `gh pr diff <numéro>`.

Suivez votre consigne de relecteur, et rendez votre rapport.
