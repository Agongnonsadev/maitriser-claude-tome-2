---
name: relire
description: Relecture d'un diff ou d'une demande de fusion par le sous-agent relecteur, contre les règles du projet. Lecture seule.
disable-model-invocation: true
argument-hint: "[rien : la branche contre main | une plage git | un numéro de demande de fusion]"
context: fork
agent: relecture:relecteur
background: false
---

Relisez ce changement : $ARGUMENTS

- Sans précision : la branche courante contre `main`, modifications non commitées comprises (`git diff main...HEAD`, puis `git diff HEAD`).
- Une plage : `git diff <plage>`. Un numéro de demande de fusion : `gh pr diff <numéro>`.

Suivez votre consigne de relecteur, et rendez votre rapport.
