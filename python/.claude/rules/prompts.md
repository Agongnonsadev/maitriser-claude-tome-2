---
paths:
  - "comptoir/prompts/**"
  - "comptoir/prompt.py"
---

# Les prompts du Comptoir

- Une version publiée ne se modifie jamais : les séries d'évaluation du chapitre 17 y renvoient par son empreinte. On écrit la suivante (`systeme_v6.md`), et le hook `garde_fichiers` refuse la modification d'une version existante.
- Une nouvelle version est une variante : elle entre dans `ch17/suite.py` (`VARIANTES`), on l'estime (`python -m ch17.evaluer estimer`), et Yao lance lui-même la série payante.
- Les montants, les codes et les totaux viennent du code, jamais du prompt.
- Les textes pour les clients d'Awa : en français, avec le vouvoiement, et la mention de l'IA reste.
