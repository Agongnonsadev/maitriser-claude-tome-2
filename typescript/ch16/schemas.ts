// Chapitre 16 : ce que le Comptoir en ligne annonce de plus que le serveur du chapitre 15 : l'outil
// rapport_de_la_semaine et le formulaire de confirmation d'appliquer_correction. Ce sont les textes et les
// schémas que publie la version Python (python/ch16/serveur_en_ligne.py), tels que pydantic les écrit, relevés
// le 23 octobre 2026 par un client MCP. Un test les compare au serveur Python.

export const RAPPORT = {
  "title": "Rapport de la semaine",
  "description": "Le rapport complet d'une semaine : ventes, jour par jour, par quartier, et comparaison avec la\nsemaine précédente. Signale sa progression pendant le calcul. Ne modifie rien.",
  "annotations": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "entree": {
    "type": "object",
    "properties": {
      "un_jour_de_la_semaine": {
        "anyOf": [
          {
            "format": "date",
            "type": "string"
          },
          {
            "type": "null"
          }
        ],
        "default": null,
        "description": "AAAA-MM-JJ, n'importe quel jour de la semaine voulue. Sans date : la semaine en cours.",
        "title": "Un Jour De La Semaine"
      }
    },
    "title": "rapport_de_la_semaineArguments"
  },
  "sortie": {
    "$defs": {
      "JourDuRapport": {
        "properties": {
          "jour": {
            "title": "Jour",
            "type": "string"
          },
          "commandes": {
            "title": "Commandes",
            "type": "integer"
          },
          "total_fcfa": {
            "title": "Total Fcfa",
            "type": "integer"
          }
        },
        "required": [
          "jour",
          "commandes",
          "total_fcfa"
        ],
        "title": "JourDuRapport",
        "type": "object"
      },
      "VenteProduit": {
        "properties": {
          "produit": {
            "title": "Produit",
            "type": "string"
          },
          "quantite": {
            "title": "Quantite",
            "type": "integer"
          },
          "montant_fcfa": {
            "title": "Montant Fcfa",
            "type": "integer"
          }
        },
        "required": [
          "produit",
          "quantite",
          "montant_fcfa"
        ],
        "title": "VenteProduit",
        "type": "object"
      },
      "VentesSemaine": {
        "properties": {
          "du": {
            "title": "Du",
            "type": "string"
          },
          "au": {
            "title": "Au",
            "type": "string"
          },
          "commandes": {
            "title": "Commandes",
            "type": "integer"
          },
          "total_fcfa": {
            "title": "Total Fcfa",
            "type": "integer"
          },
          "par_produit": {
            "items": {
              "$ref": "#/$defs/VenteProduit"
            },
            "title": "Par Produit",
            "type": "array"
          },
          "semaine_precedente_fcfa": {
            "title": "Semaine Precedente Fcfa",
            "type": "integer"
          },
          "resume": {
            "title": "Resume",
            "type": "string"
          }
        },
        "required": [
          "du",
          "au",
          "commandes",
          "total_fcfa",
          "par_produit",
          "semaine_precedente_fcfa",
          "resume"
        ],
        "title": "VentesSemaine",
        "type": "object"
      }
    },
    "properties": {
      "ventes": {
        "$ref": "#/$defs/VentesSemaine"
      },
      "par_jour": {
        "items": {
          "$ref": "#/$defs/JourDuRapport"
        },
        "title": "Par Jour",
        "type": "array"
      },
      "par_quartier": {
        "additionalProperties": {
          "type": "integer"
        },
        "description": "Total en FCFA par quartier, du plus au moins rapporteur.",
        "title": "Par Quartier",
        "type": "object"
      },
      "resume": {
        "title": "Resume",
        "type": "string"
      }
    },
    "required": [
      "ventes",
      "par_jour",
      "par_quartier",
      "resume"
    ],
    "title": "RapportSemaine",
    "type": "object"
  }
} as const;

/** Le formulaire de confirmation (le modèle Confirmation de la version Python). */
export const CONFIRMATION = {
  "properties": {
    "confirme": {
      "description": "Cochez pour appliquer la correction.",
      "title": "Confirme",
      "type": "boolean"
    }
  },
  "required": [
    "confirme"
  ],
  "type": "object"
} as const;
