---
paths:
  - "comptoir/prompt.ts"
  - "comptoir/documentaire.ts"
  - "comptoir/routeur.ts"
---

# Les prompts du Comptoir

- Les prompts sont communs aux deux versions : ils vivent dans `../python/comptoir/prompts/`, et cette version les y lit.
- Une version publiée ne se modifie jamais : les séries d'évaluation du chapitre 17 y renvoient par son empreinte. On écrit la suivante (`systeme_v6.md`), et le hook `garde_fichiers` refuse la modification d'une version existante.
- Une nouvelle version est une variante : elle entre dans `ch17/suite.ts` (`VARIANTES`), on l'estime (`npx tsx ch17/evaluer.ts estimer`), et Yao lance lui-même la série payante.
- Les montants, les codes et les totaux viennent du code, jamais du prompt.
- Les textes pour les clients d'Awa : en français, avec le vouvoiement, et la mention de l'IA reste.
