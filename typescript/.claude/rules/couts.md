---
paths:
  - "comptoir/couts.ts"
  - "comptoir/budget.ts"
  - "ch*/mesurer*.ts"
---

# Les coûts et le budget

- Les prix de `comptoir/couts.ts` viennent de la page Pricing d'Anthropic, avec la date de lecture en commentaire, et restent les mêmes que ceux de `../python/comptoir/couts.py`. Le hook `garde_fichiers` demande à Yao de confirmer chaque modification.
- Un coût se calcule à partir des tokens de la réponse (`usage`), jamais d'une estimation du modèle.
- Le budget compte le message entier, toutes étapes comprises (`comptoir/service.ts`, chapitre 19).
- Un script de mesure a un `--estimer` gratuit et un `--budget-max` ; il écrit ses résultats au fil de l'eau.
