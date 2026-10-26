"""Réglages du Comptoir, lus dans l'environnement quand ils existent.

La clé d'API n'apparaît jamais ici : le SDK la lit lui-même dans
la variable d'environnement ANTHROPIC_API_KEY.
"""

import os

# Le modèle est un réglage, pas une constante enfouie dans le code :
# le jour où il sera retiré, on le change ici, après évaluation (chapitre 21).
MODELE = os.environ.get("COMPTOIR_MODELE", "claude-sonnet-5-5")

# Le niveau d'effort choisi au chapitre 3, par la mesure. Vide = défaut du modèle.
EFFORT = os.environ.get("COMPTOIR_EFFORT") or None

# Chapitre 12 : un modèle et un effort par étape, choisis par la mesure.
# L'aiguilleur et les questions : Claude Haiku 5.5, réflexion désactivée (90 sur 90 au classement ;
# 20 sur 20 aux questions du chapitre 11, sans citations).
MODELE_ROUTEUR = os.environ.get("COMPTOIR_MODELE_ROUTEUR", "claude-haiku-5-5")
MODELE_DOCUMENTS = os.environ.get("COMPTOIR_MODELE_DOCUMENTS", "claude-haiku-5-5")
# Les réclamations : extraction et évaluation par ce modèle, rédaction par MODELE.
MODELE_AUXILIAIRE = os.environ.get("COMPTOIR_MODELE_AUXILIAIRE", "claude-haiku-5-5")
# Chapitre 17 : le Comptoir aiguillé (commandes et autres demandes), choisi par l'évaluation :
# Claude Haiku 5.5 fait au moins aussi bien que Sonnet 5.5 sur les 60 cas, pour six fois moins
# (decisions/modele.md). La rédaction des réclamations reste sur MODELE.
MODELE_COMPTOIR = os.environ.get("COMPTOIR_MODELE_COMPTOIR", "claude-haiku-5-5")
# Trois phrases n'ont pas besoin de réflexion. Mesuré sur 12 réclamations : à l'effort par défaut,
# jusqu'à 339 tokens de réflexion et 425 de sortie, 0,00313 $ et 6,2 s par réclamation ; en low,
# aucune réflexion, 136 tokens au plus, 0,00252 $ et 5,5 s ; 12 conformes du premier coup dans les
# deux cas. Vide = défaut du modèle.
EFFORT_REDACTION = os.environ.get("COMPTOIR_EFFORT_REDACTION", "low") or None

# Taux de conversion du livre (1 $ = 570 FCFA ≈ 0,87 €).
TAUX_FCFA = float(os.environ.get("COMPTOIR_TAUX_FCFA", "570"))
TAUX_EUR = float(os.environ.get("COMPTOIR_TAUX_EUR", "0.87"))

# Délai maximal d'un appel, en secondes (chapitre 6). Le défaut du SDK, 600 s, est fait
# pour les longues générations, pas pour un chat sur téléphone.
DELAI_S = float(os.environ.get("COMPTOIR_DELAI_S", "60"))

# Une conversation sans message depuis ce nombre d'heures est close ; la suivante repart à zéro.
EXPIRATION_H = float(os.environ.get("COMPTOIR_EXPIRATION_H", "24"))

# Une conversation dont le contexte dépasse ce nombre de tokens est close, elle aussi.
# Choix du livre pour un service client, très loin de la fenêtre d'un million de tokens.
CONTEXTE_MAX = int(os.environ.get("COMPTOIR_CONTEXTE_MAX", "40000"))

# Les conversations sont des données de clients : elles vivent hors du dépôt, et sont
# supprimées après ce nombre de jours (chapitre 18 pour le cadre légal).
CONVERSATIONS = os.environ.get("COMPTOIR_CONVERSATIONS", "donnees_clients/conversations.sqlite3")
CONSERVATION_J = int(os.environ.get("COMPTOIR_CONSERVATION_J", "30"))

# Chapitre 18 : la boutique garde aussi des données de clients. Durées choisies par Awa, à revoir avec
# le cadre légal de son pays : une demande transmise est effacée après 90 jours ; le nom du client
# d'une commande est réduit à son prénom et son initiale après 90 jours, le reste (produits, total,
# quartier) reste pour la comptabilité et les ventes. Un récapitulatif jamais confirmé part après 2 jours.
BOUTIQUE = os.environ.get("COMPTOIR_BOUTIQUE", "donnees_clients/boutique.sqlite3")
CONSERVATION_DEMANDES_J = int(os.environ.get("COMPTOIR_CONSERVATION_DEMANDES_J", "90"))
CONSERVATION_NOMS_J = int(os.environ.get("COMPTOIR_CONSERVATION_NOMS_J", "90"))
CONSERVATION_RECAPITULATIFS_J = int(os.environ.get("COMPTOIR_CONSERVATION_RECAPITULATIFS_J", "2"))

# Chapitre 18 : les limites par adresse réseau, devant le budget. Une adresse peut être partagée par
# beaucoup d'abonnés d'un opérateur mobile : ces limites sont larges, faites pour arrêter un script,
# pas une famille. Le quota par adresse, en dollars, laisse toujours une part du jour aux autres.
LIMITE_MESSAGES_MINUTE = int(os.environ.get("COMPTOIR_LIMITE_MESSAGES_MINUTE", "20"))
LIMITE_CONVERSATIONS_HEURE = int(os.environ.get("COMPTOIR_LIMITE_CONVERSATIONS_HEURE", "10"))
QUOTA_RESEAU_JOUR = float(os.environ.get("COMPTOIR_QUOTA_RESEAU_JOUR", "0.40"))
TAILLE_MAX_REQUETE = int(os.environ.get("COMPTOIR_TAILLE_MAX_REQUETE", "16384"))  # octets
# Les relais dont on croit l'en-tête X-Forwarded-For (Caddy, sur la même machine) ; vide : aucun.
PROXIES_DE_CONFIANCE = [p for p in os.environ.get("COMPTOIR_PROXIES_DE_CONFIANCE", "").split(",") if p]

# Réessais automatiques du SDK (chapitre 8). Le défaut du SDK est 2 ; un chat n'a pas
# intérêt à faire attendre le client beaucoup plus longtemps.
REESSAIS = int(os.environ.get("COMPTOIR_REESSAIS", "2"))

# Le budget de l'API, fixé par Awa (exigence I7 du chapitre 1) : 15 000 FCFA par mois,
# soit environ 26 $. Le plafond du jour vaut 1,5 fois un jour moyen, pour les jours de
# fête ; le plafond du mois, lui, ne se dépasse pas. Choix du livre : réglez-les.
BUDGET_MOIS = float(os.environ.get("COMPTOIR_BUDGET_MOIS", "26"))
BUDGET_JOUR = float(os.environ.get("COMPTOIR_BUDGET_JOUR", "1.30"))
QUOTA_CLIENT_JOUR = float(os.environ.get("COMPTOIR_QUOTA_CLIENT_JOUR", "0.15"))
SEUIL_ALERTE = float(os.environ.get("COMPTOIR_SEUIL_ALERTE", "0.8"))  # alerte à 80 %
BUDGET = os.environ.get("COMPTOIR_BUDGET_BASE", "donnees_clients/budget.sqlite3")

# Où le Comptoir note chaque appel (identifiant, tokens, coût ; jamais la clé).
JOURNAL = os.environ.get("COMPTOIR_JOURNAL", "journal/appels.jsonl")

# Chapitre 19 : l'effort du Comptoir aiguillé (Claude Haiku 5.5). Vide : le défaut du modèle (medium).
# Une valeur ne se change qu'après l'évaluation du chapitre 17 : elle change les réponses. Mesuré : low
# coûte 8 % de moins par conversation, mais le juge passe de 97 % à 93 %, avec des réponses qui sautent
# une étape ; écarté (decisions/optimisation.md).
EFFORT_COMPTOIR = os.environ.get("COMPTOIR_EFFORT_COMPTOIR") or None

# Chapitre 19 : WhatsApp (API Cloud de Meta). Rien n'est écrit ici : tout vient de l'environnement du
# serveur. Le secret de l'application vérifie la signature des webhooks ; le jeton d'utilisateur système
# envoie les réponses ; le jeton de vérification est une chaîne choisie par Yao, saisie aussi chez Meta.
WHATSAPP_SECRET_APP = os.environ.get("COMPTOIR_WHATSAPP_SECRET_APP", "")
WHATSAPP_JETON = os.environ.get("COMPTOIR_WHATSAPP_JETON", "")
WHATSAPP_JETON_VERIFICATION = os.environ.get("COMPTOIR_WHATSAPP_JETON_VERIFICATION", "")
WHATSAPP_VERSION_API = os.environ.get("COMPTOIR_WHATSAPP_VERSION_API", "v26.0")
# Meta envoie des notifications jusqu'à 3 Mo (documentation des webhooks) : la limite du chat ne vaut pas ici.
TAILLE_MAX_WEBHOOK = int(os.environ.get("COMPTOIR_TAILLE_MAX_WEBHOOK", str(4 * 1024 * 1024)))
# Le numéro d'un client ne va ni dans le journal ni dans le budget : on y écrit une empreinte, calculée
# avec ce sel secret. Changer le sel rend les anciennes empreintes impossibles à relier.
SEL_PSEUDONYMES = os.environ.get("COMPTOIR_SEL_PSEUDONYMES", "")

# Chapitre 19 : le tableau de bord en ligne, réservé à Awa et Yao (jeton dans l'en-tête Authorization).
TABLEAU_JETON = os.environ.get("COMPTOIR_TABLEAU_JETON", "")
# Le filtre du chapitre 18, en surveillance : lancé à côté de la réponse, il ne la retarde pas et ne
# bloque rien ; il note les messages suspects. 1 pour l'activer (environ 0,00005 $ par message).
FILTRE_SURVEILLANCE = os.environ.get("COMPTOIR_FILTRE_SURVEILLANCE", "0") == "1"
