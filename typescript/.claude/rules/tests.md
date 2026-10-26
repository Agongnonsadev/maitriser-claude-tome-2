---
paths:
  - "tests/**"
---

# Les tests du Comptoir

- Aucun test n'appelle l'API : un faux client (`FauxClient`, dans `tests/faux_clients.ts`) ou un faux serveur sur 127.0.0.1. Le hook `garde_fichiers` refuse un vrai client dans `tests/`.
- Un fichier de test par module ou par chapitre (`chNN.test.ts`), des noms de test qui disent la règle en français (« un doublon de Meta n'est traité qu'une fois »).
- Une règle par test ; un test qui échoue doit dire laquelle a cédé.
- Le journal pointe vers un dossier temporaire (`journalTemporaire()`), jamais vers `journal/appels.jsonl`.
- Les comparaisons à la version Python lancent son Python (`../python/.venv`) avec un journal temporaire ; sans lui, elles sont sautées.
- Un test instable est un défaut à trouver, pas un test à relancer (chapitre 19).
