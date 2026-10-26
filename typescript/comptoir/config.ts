// Réglages du Comptoir, lus dans l'environnement quand ils existent : les mêmes variables, et les
// mêmes valeurs par défaut, que la version Python (python/comptoir/config.py).
//
// La clé d'API n'apparaît jamais ici : le SDK la lit lui-même dans la variable d'environnement
// ANTHROPIC_API_KEY.
//
// Un objet, et non des constantes : les tests changent un réglage (le journal, par exemple) le temps
// d'un essai.

const texte = (nom: string, defaut: string): string => process.env[nom] ?? defaut;
const nombre = (nom: string, defaut: string): number => Number(texte(nom, defaut));
/** Une variable vide vaut « pas de valeur » : le défaut du modèle. */
const facultatif = (nom: string, defaut = ""): string | null => texte(nom, defaut) || null;

export const config = {
  // Le modèle est un réglage, pas une constante enfouie dans le code : le jour où il sera retiré, on
  // le change ici, après évaluation (chapitre 21).
  MODELE: texte("COMPTOIR_MODELE", "claude-sonnet-5-5"),

  // Le niveau d'effort choisi au chapitre 3, par la mesure. Vide = défaut du modèle.
  EFFORT: facultatif("COMPTOIR_EFFORT"),

  // Chapitre 12 : un modèle et un effort par étape, choisis par la mesure. L'aiguilleur et les
  // questions : Claude Haiku 5.5.
  MODELE_ROUTEUR: texte("COMPTOIR_MODELE_ROUTEUR", "claude-haiku-5-5"),
  MODELE_DOCUMENTS: texte("COMPTOIR_MODELE_DOCUMENTS", "claude-haiku-5-5"),
  // Les réclamations : extraction et évaluation par ce modèle, rédaction par MODELE.
  MODELE_AUXILIAIRE: texte("COMPTOIR_MODELE_AUXILIAIRE", "claude-haiku-5-5"),
  // Chapitre 17 : le Comptoir aiguillé, choisi par l'évaluation (python/decisions/modele.md).
  MODELE_COMPTOIR: texte("COMPTOIR_MODELE_COMPTOIR", "claude-haiku-5-5"),
  // Trois phrases n'ont pas besoin de réflexion (chapitre 12). Vide = défaut du modèle.
  EFFORT_REDACTION: facultatif("COMPTOIR_EFFORT_REDACTION", "low"),

  // Taux de conversion du livre (1 $ = 570 FCFA ≈ 0,87 €).
  TAUX_FCFA: nombre("COMPTOIR_TAUX_FCFA", "570"),
  TAUX_EUR: nombre("COMPTOIR_TAUX_EUR", "0.87"),

  // Délai maximal d'un appel, en secondes (chapitre 6). Le défaut du SDK, 10 minutes, est fait pour
  // les longues générations, pas pour un chat sur téléphone.
  DELAI_S: nombre("COMPTOIR_DELAI_S", "60"),

  // Une conversation sans message depuis ce nombre d'heures est close ; la suivante repart à zéro.
  EXPIRATION_H: nombre("COMPTOIR_EXPIRATION_H", "24"),
  // Une conversation dont le contexte dépasse ce nombre de tokens est close, elle aussi.
  CONTEXTE_MAX: nombre("COMPTOIR_CONTEXTE_MAX", "40000"),

  // Les conversations sont des données de clients : elles vivent hors du dépôt, et sont supprimées
  // après ce nombre de jours (chapitre 18 pour le cadre légal).
  CONVERSATIONS: texte("COMPTOIR_CONVERSATIONS", "donnees_clients/conversations.sqlite3"),
  CONSERVATION_J: nombre("COMPTOIR_CONSERVATION_J", "30"),

  // Chapitre 18 : les données de clients de la boutique, et leurs durées de conservation.
  BOUTIQUE: texte("COMPTOIR_BOUTIQUE", "donnees_clients/boutique.sqlite3"),
  CONSERVATION_DEMANDES_J: nombre("COMPTOIR_CONSERVATION_DEMANDES_J", "90"),
  CONSERVATION_NOMS_J: nombre("COMPTOIR_CONSERVATION_NOMS_J", "90"),
  CONSERVATION_RECAPITULATIFS_J: nombre("COMPTOIR_CONSERVATION_RECAPITULATIFS_J", "2"),

  // Chapitre 18 : les limites par adresse réseau, devant le budget.
  LIMITE_MESSAGES_MINUTE: nombre("COMPTOIR_LIMITE_MESSAGES_MINUTE", "20"),
  LIMITE_CONVERSATIONS_HEURE: nombre("COMPTOIR_LIMITE_CONVERSATIONS_HEURE", "10"),
  QUOTA_RESEAU_JOUR: nombre("COMPTOIR_QUOTA_RESEAU_JOUR", "0.40"),
  TAILLE_MAX_REQUETE: nombre("COMPTOIR_TAILLE_MAX_REQUETE", "16384"), // octets
  // Les relais dont on croit l'en-tête X-Forwarded-For ; vide : aucun.
  PROXIES_DE_CONFIANCE: texte("COMPTOIR_PROXIES_DE_CONFIANCE", "").split(",").filter(Boolean),

  // Réessais automatiques du SDK (chapitre 8). Le défaut du SDK est 2.
  REESSAIS: nombre("COMPTOIR_REESSAIS", "2"),

  // Le budget de l'API, fixé par Awa (exigence I7 du chapitre 1) : 15 000 FCFA par mois, soit
  // environ 26 $. Le plafond du jour vaut 1,5 fois un jour moyen ; celui du mois ne se dépasse pas.
  BUDGET_MOIS: nombre("COMPTOIR_BUDGET_MOIS", "26"),
  BUDGET_JOUR: nombre("COMPTOIR_BUDGET_JOUR", "1.30"),
  QUOTA_CLIENT_JOUR: nombre("COMPTOIR_QUOTA_CLIENT_JOUR", "0.15"),
  SEUIL_ALERTE: nombre("COMPTOIR_SEUIL_ALERTE", "0.8"), // alerte à 80 %
  BUDGET: texte("COMPTOIR_BUDGET_BASE", "donnees_clients/budget.sqlite3"),

  // Où le Comptoir note chaque appel (identifiant, tokens, coût ; jamais la clé).
  JOURNAL: texte("COMPTOIR_JOURNAL", "journal/appels.jsonl"),

  // Chapitre 19 : l'effort du Comptoir aiguillé. Vide : le défaut du modèle.
  EFFORT_COMPTOIR: facultatif("COMPTOIR_EFFORT_COMPTOIR"),

  // Chapitre 19 : WhatsApp (API Cloud de Meta). Tout vient de l'environnement du serveur.
  WHATSAPP_SECRET_APP: texte("COMPTOIR_WHATSAPP_SECRET_APP", ""),
  WHATSAPP_JETON: texte("COMPTOIR_WHATSAPP_JETON", ""),
  WHATSAPP_JETON_VERIFICATION: texte("COMPTOIR_WHATSAPP_JETON_VERIFICATION", ""),
  WHATSAPP_VERSION_API: texte("COMPTOIR_WHATSAPP_VERSION_API", "v26.0"),
  TAILLE_MAX_WEBHOOK: nombre("COMPTOIR_TAILLE_MAX_WEBHOOK", String(4 * 1024 * 1024)),
  // Le numéro d'un client ne va ni dans le journal ni dans le budget : une empreinte, avec ce sel.
  SEL_PSEUDONYMES: texte("COMPTOIR_SEL_PSEUDONYMES", ""),

  // Chapitre 19 : le tableau de bord en ligne, réservé à Awa et Yao.
  TABLEAU_JETON: texte("COMPTOIR_TABLEAU_JETON", ""),
  // Le filtre du chapitre 18, en surveillance : 1 pour l'activer.
  FILTRE_SURVEILLANCE: texte("COMPTOIR_FILTRE_SURVEILLANCE", "0") === "1",
};
