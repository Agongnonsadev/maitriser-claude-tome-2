---
name: verify
description: Vérifie le Comptoir avant un commit ou une demande de fusion. Lance la suite de tests sans appel payant, relit le diff à la recherche de secrets et des règles du projet, et rend un verdict court. À utiliser avant chaque commit, ou quand on demande si le code est prêt.
allowed-tools: Bash(python -m pytest *) Bash(git diff *) Bash(git status *) PowerShell(python -m pytest *) PowerShell(git diff *) PowerShell(git status *)
---

# Vérifier le Comptoir

Chapitre 20. Le nom `verify` compte : quand une Skill de projet porte ce nom, Claude Code la lance avant chaque commit.

## Les changements

!`git status --short`

## À faire, dans l'ordre

Lancez chaque commande seule, sans tube ni enchaînement (`|`, `;`, `&&`) : seules les commandes simples sont autorisées d'avance.

1. Lancez `python -m pytest -q -p no:cacheprovider` depuis ce dossier. Aucun test n'appelle l'API : c'est gratuit.
2. Lisez `git diff HEAD` et vérifiez, fichier par fichier :
   - aucune clé, aucun jeton, aucun `.env` (le hook `garde_secrets` bloquera le commit de toute façon : dites-le avant) ;
   - aucune version publiée de prompt modifiée (`comptoir/prompts/*_vN.md`) ;
   - chaque nouvelle fonction a son test ;
   - aucun montant écrit par le modèle : les totaux viennent du code ;
   - les textes pour les clients sont en français, avec le vouvoiement.
3. Ne lancez aucun script `python -m chNN…` : beaucoup appellent l'API, et chaque appel est payant.

## Votre réponse

Trois lignes au plus : les tests (nombre réussis, ou le premier échec), ce que la relecture a trouvé, et le verdict « prêt » ou « pas prêt ».
