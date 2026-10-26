---
paths:
  - "tests/**"
---

# Les tests du Comptoir

- Aucun test n'appelle l'API : un faux client (`FauxClient`) ou un faux serveur sur 127.0.0.1. Le hook `garde_fichiers` refuse un vrai client dans `tests/`.
- Un fichier de test par module ou par chapitre (`test_chNN.py`), des noms de test qui disent la règle en français (`test_un_doublon_de_meta_n_est_traite_qu_une_fois`).
- Une règle par test ; un test qui échoue doit dire laquelle a cédé.
- Le journal pointe vers `tmp_path` (fixture), jamais vers `journal/appels.jsonl`.
- Un test instable est un défaut à trouver, pas un test à relancer (chapitre 19).
