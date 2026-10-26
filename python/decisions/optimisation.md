# Ce que coûte le Comptoir en ligne, et ce qu'on optimise (22 octobre 2026)

Chapitre 19. Le Comptoir livré (Claude Haiku 5.5, prompt v5, cache d'une heure) derrière ses deux canaux, le chat web et WhatsApp (`comptoir/service.py`, `comptoir/en_ligne.py`). Délices d'Awa, Awa et Yao sont fictifs.

## Le coût par conversation, mesuré

Huit conversations types (`ch19/conversations.json`), 14 messages, trois essais, par le service en ligne (`python -m ch19.mesurer_cout`). Le cache était chaud : le même préfixe venait d'être écrit par un essai du conteneur.

| Variante | Par conversation | Par message | Appels par message | Latence médiane / 90e centile | Commandes confirmées |
|---|---|---|---|---|---|
| Livrée | 0,00131 $ (0,00118 $ sans le premier essai, où une réclamation a été réécrite) | 0,00075 $ | 2,45 | 6,9 s / 9,7 s | 6 sur 6 |
| Effort `low` | 0,00109 $ (0,00109 $) | 0,00062 $ | 2,40 | 6,3 s / 7,9 s | 6 sur 6 |
| Sans cache | 0,00384 $ | 0,00219 $ | 2,38 | 7,0 s / 8,3 s | 6 sur 6 |

Où va l'argent, version livrée (103 appels, 0,0316 $) : la sortie 43 % (dont la réflexion 13 %), l'entrée non mise en cache 29 %, la lecture du cache 23 %, son écriture 8 %. La rédaction des réclamations par Claude Sonnet 5.5 : 32 % du total, pour 3 conversations sur 24.

## Le mois d'Awa, calculé

À partir des prix unitaires mesurés ci-dessus et des 4 900 messages par mois du chapitre 17 :

| Poste | Par mois |
|---|---|
| Claude, version livrée | environ 3,70 $ |
| Claude, sans cache | environ 10,70 $ |
| WhatsApp : 4 900 réponses, dont 1 000 gratuites, à 0,0040 $ (tarif « Reste de l'Afrique », relevé le 22 octobre 2026) | environ 15,60 $ |
| Résumé du soir par lot, 30 par mois | moins de 0,01 $ |
| Hébergement | `[à mesurer]` |

WhatsApp coûte plus que Claude. Le coût de Meta ne dépend pas de Claude : il compte les réponses envoyées.

## Les leviers, un par un

| Levier | Mesure | Décision |
|---|---|---|
| Cache d'une heure | Sans lui, 2,9 fois plus cher par conversation | Gardé (chapitre 11) |
| Effort `low` pour le Comptoir | −8 % par conversation sans le premier essai, −21 % de tokens de sortie, 90e centile 7,9 s au lieu de 9,7 s ; suite du chapitre 17 : code 95 % contre 94 %, juge 93 % contre 97 %, code et juge 90 % contre 91 %, test du signe p = 1,00 ; cinq « ne répond pas » du juge (aucun avant) : deux remerciements trop longs, deux oublis du nom sur un cas de sécurité (le prix spécial bien refusé), un récapitulatif non préparé (le nom et le quartier redemandés) | **Écarté** : au mieux 0,6 $ par mois, et des réponses qui sautent une étape, ce que la documentation annonce à `low` pour les longs prompts d'agent. `medium` reste. La variante reste dans la suite. |
| Batch API pour le résumé du soir | 0,000093 $ au lieu de 0,000178 $ ; 85 s au lieu de 2 s | Par lot : rien ne presse, mais le gain est d'environ 3 centimes par an à ce volume |
| Batch API pour le juge du chapitre 17 | 120 jugements : 0,0246 $ au lieu de 0,0496 $ ; environ 7 minutes ; même issue pour 113 essais sur 120 (écarts dans les deux sens) ; 119 requêtes sur 120 ont lu le cache | Par lot pour les séries complètes ; en direct pour la non-régression, qui doit répondre avant une fusion |
| Réflexion du résumé du soir | Par défaut : 578 tokens de réflexion sur 800, texte coupé | Réflexion désactivée, comme l'aiguilleur |
| Longueur des réponses | Non mesurée : la sortie visible pèse environ 30 % du coût | Chantier d'Awa (chapitre 17) : une variante de prompt à évaluer |
| Rédaction des réclamations sur Haiku 5.5 | Non mesurée | Candidat suivant : 32 % du coût pour une conversation sur huit ; à évaluer sur les réclamations du chapitre 12 |

## Ce qu'on n'optimise pas

La qualité vérifiée par la suite du chapitre 17 et les attaques du chapitre 18. Un levier qui fait baisser la suite n'est pas pris, même s'il rapporte.
