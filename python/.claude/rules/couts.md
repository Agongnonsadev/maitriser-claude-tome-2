---
paths:
  - "comptoir/couts.py"
  - "comptoir/budget.py"
  - "ch*/mesurer*.py"
---

# Les coûts et le budget

- Les prix de `comptoir/couts.py` viennent de la page Pricing d'Anthropic, avec la date de lecture en commentaire. Le hook `garde_fichiers` demande à Yao de confirmer chaque modification.
- Un coût se calcule à partir des tokens de la réponse (`usage`), jamais d'une estimation du modèle.
- Le budget compte le message entier, toutes étapes comprises (`comptoir/service.py`, chapitre 19).
- Un script de mesure a un `--estimer` gratuit et un `--budget-max` ; il écrit ses résultats au fil de l'eau.
