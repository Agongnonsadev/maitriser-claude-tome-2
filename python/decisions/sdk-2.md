# Passer au SDK anthropic 2.x et à l'API 2026-10-21 (22 octobre 2026)

Chapitre 21. Délices d'Awa, Awa et Yao sont fictifs.

## Ce qui a changé

- **Le 21 octobre 2026**, Anthropic publie la version `2026-10-21` de l'API, et le SDK Python 2.0.0, qui l'envoie par défaut (la 1.x envoyait `2023-06-01`). La 2.1.0 suit le même jour.
- **Repéré par** la veille du lundi (`python -m ch21.veille`), le 22 octobre : « SDK anthropic 1.15.0 installé, 2.1.0 disponible : une version majeure de plus ».
- **Ruptures de l'API** (guide *Migrating to API version 2026-10-21*) : `temperature`, `top_p`, `top_k` refusés ; plus de bloc `document` dans un message de l'assistant ; plus de bloc `text` avec des `citations` dans un message de l'utilisateur ; des champs renommés dans l'API Admin.
- **Ruptures du SDK Python** : `MessageParam` devient une union par rôle ; `betas` disparaît des méthodes Models non bêta ; la clé part dans `Authorization: Bearer` au lieu de `X-Api-Key` ; un client ne tient qu'un identifiant ; licence Apache 2.0.

## Ce que le Comptoir avait à changer

Recherche dans le code (comptoir/, chNN/, tests/) :

| Rupture | Dans le Comptoir |
|---|---|
| `temperature`, `top_p`, `top_k` | Jamais envoyés (trois tests le vérifiaient déjà, depuis les chapitres 2, 3 et 5) |
| `document` dans un message de l'assistant | Aucun : les documents partent dans des messages de l'utilisateur |
| `citations` dans un message de l'utilisateur | Aucune : seulement le réglage `{"enabled": true}`, toujours permis |
| `MessageParam(...)` | Jamais appelé : les messages sont des dictionnaires |
| `betas` sur les méthodes Models | Aucun ; les `betas` de l'agent du chapitre 13 passent par `client.beta` |
| `X-Api-Key` lu par un mandataire | Aucun mandataire ; l'API accepte les deux en-têtes |
| Deux identifiants dans un client | Aucun |

Changements faits : `pyproject.toml` (`anthropic>=2.1,<3`) ; `ch19/deploiement/requirements.in` et `requirements.txt` (anthropic 2.1.0, empreintes recalculées, rien d'autre ne change) ; l'exemple HTTP brut du chapitre 2 envoie `2026-10-21`.

## Les essais, avant de livrer

Un environnement séparé (`.venv-sdk2`), les autres dépendances figées aux mêmes versions :

| Essai | SDK 1.15.0, API 2023-06-01 | SDK 2.1.0, API 2026-10-21 |
|---|---|---|
| Tests sans appel | 459 réussis | 465 réussis (les 6 de la veille en plus) |
| En-têtes envoyés | — | `anthropic-version: 2026-10-21`, `Authorization: Bearer` |
| `temperature` envoyé | — | Refusé : 400, « temperature: Extra inputs are not permitted » |
| Non-régression (33 cas) | 33 sur 33, 0,0336 $, médiane 6,0 s (ce matin) | 33 sur 33, 0,0310 $, médiane 6,0 s |
| Huit conversations du chapitre 19, un essai | 0,00118 $ par conversation (chapitre 19, sans le premier essai) | 0,00116 $, 2 commandes sur 2, aucune erreur |
| Agent du chapitre 13 (Tool Runner, en-tête bêta) | — | 7 tours, 0,0094 $, 7 critères sur 7 |
| Appel HTTP brut du chapitre 2 | — | Réponse normale avec `2026-10-21` |
| Image Docker du chapitre 19 | — | 237 Mo, un message de chat : réponse juste, 0,00026 $ |

## Décision

Adopté le 22 octobre 2026. Le Comptoir passe au SDK 2.1.0 et à l'API `2026-10-21`. La 2.1.0 n'a qu'un jour : la veille du lundi suivra ses correctifs (`2.1.x`), que la contrainte `>=2.1,<3` laisse passer. Retour arrière possible : `pip install "anthropic==1.15.0"` et l'ancienne contrainte, tant que l'API accepte `2023-06-01`.
