// Chapitre 15 : ce que le serveur « Comptoir pour Awa » annonce de ses outils, de ses ressources et de ses
// prompts. Ce sont les textes et les schémas que publie la version Python (python/ch15/comptoir_pour_awa.py),
// tels que pydantic les écrit à partir de ses modèles et de ses docstrings, relevés le 23 octobre 2026 par un
// client MCP : Claude lit la même chose dans les deux versions. Un test les compare au serveur Python.

export const INSTRUCTIONS = "Comptoir pour Awa donne accès aux ventes et au stock de Délices d'Awa, l'entreprise de jus d'Awa à Cotonou. Règles :\n1. Les chiffres (bouteilles, montants, écarts) viennent des outils : ne les recalcule pas et ne les arrondis pas.\n2. Pour corriger le stock : appelle preparer_correction, montre à Awa l'écart tel que l'outil le donne, et attends son accord explicite avant appliquer_correction. Une correction par produit, jamais plusieurs à la suite sans accord pour chacune.\n3. Ne propose jamais de modifier autre chose que le stock : les commandes et les clients ne se changent pas ici.\n4. Réponds à Awa en français, en la vouvoyant, simplement : elle n'est pas informaticienne.";

export const OUTILS = {
  "commandes_du_jour": {
    "title": "Commandes d'un jour",
    "description": "Les commandes confirmées d'un jour : heure, client, quartier, produits, total. Pour « mes commandes\nd'aujourd'hui », « qu'est-ce que j'ai livré samedi ». Ne modifie rien.",
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "entree": {
      "type": "object",
      "properties": {
        "jour": {
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
          "description": "AAAA-MM-JJ. Sans date : aujourd'hui.",
          "title": "Jour"
        }
      },
      "title": "commandes_du_jourArguments"
    },
    "sortie": {
      "$defs": {
        "CommandeDuJour": {
          "properties": {
            "numero": {
              "title": "Numero",
              "type": "string"
            },
            "heure": {
              "title": "Heure",
              "type": "string"
            },
            "client": {
              "description": "Prénom et initiale du nom.",
              "title": "Client",
              "type": "string"
            },
            "quartier": {
              "title": "Quartier",
              "type": "string"
            },
            "produits": {
              "title": "Produits",
              "type": "string"
            },
            "total_fcfa": {
              "title": "Total Fcfa",
              "type": "integer"
            }
          },
          "required": [
            "numero",
            "heure",
            "client",
            "quartier",
            "produits",
            "total_fcfa"
          ],
          "title": "CommandeDuJour",
          "type": "object"
        }
      },
      "properties": {
        "jour": {
          "title": "Jour",
          "type": "string"
        },
        "nombre": {
          "title": "Nombre",
          "type": "integer"
        },
        "total_fcfa": {
          "title": "Total Fcfa",
          "type": "integer"
        },
        "commandes": {
          "items": {
            "$ref": "#/$defs/CommandeDuJour"
          },
          "title": "Commandes",
          "type": "array"
        },
        "resume": {
          "description": "Une phrase à dire à Awa, avec les chiffres exacts.",
          "title": "Resume",
          "type": "string"
        }
      },
      "required": [
        "jour",
        "nombre",
        "total_fcfa",
        "commandes",
        "resume"
      ],
      "title": "CommandesDuJour",
      "type": "object"
    }
  },
  "stock": {
    "title": "Stock",
    "description": "Le stock de chaque produit, avec les ruptures et les stocks bas. Ne modifie rien.",
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "entree": {
      "type": "object",
      "properties": {},
      "title": "stockArguments"
    },
    "sortie": {
      "$defs": {
        "LigneStock": {
          "properties": {
            "produit": {
              "title": "Produit",
              "type": "string"
            },
            "format": {
              "title": "Format",
              "type": "string"
            },
            "quantite": {
              "title": "Quantite",
              "type": "integer"
            },
            "etat": {
              "enum": [
                "rupture",
                "bas",
                "suffisant"
              ],
              "title": "Etat",
              "type": "string"
            }
          },
          "required": [
            "produit",
            "format",
            "quantite",
            "etat"
          ],
          "title": "LigneStock",
          "type": "object"
        }
      },
      "properties": {
        "produits": {
          "items": {
            "$ref": "#/$defs/LigneStock"
          },
          "title": "Produits",
          "type": "array"
        },
        "resume": {
          "title": "Resume",
          "type": "string"
        }
      },
      "required": [
        "produits",
        "resume"
      ],
      "title": "Stock",
      "type": "object"
    }
  },
  "ventes_de_la_semaine": {
    "title": "Ventes d'une semaine",
    "description": "Les ventes d'une semaine, du lundi au dimanche : commandes, total, bouteilles par produit, et\ncomparaison avec la semaine précédente. Ne modifie rien.",
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
          "description": "AAAA-MM-JJ, n'importe quel jour de la semaine voulue (du lundi au dimanche). Sans date : la semaine en cours.",
          "title": "Un Jour De La Semaine"
        }
      },
      "title": "ventes_de_la_semaineArguments"
    },
    "sortie": {
      "$defs": {
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
        }
      },
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
  "preparer_correction": {
    "title": "Préparer une correction de stock",
    "description": "Première étape d'une correction de stock après un inventaire : compare ce qu'Awa a compté au stock\ndu Comptoir et rend l'écart avec un jeton valable 10 minutes. Ne modifie pas le stock. Montrez\nl'écart à Awa (a_dire_a_awa) et attendez son accord avant appliquer_correction.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "entree": {
      "type": "object",
      "properties": {
        "produit": {
          "enum": [
            "Jus de bissap",
            "Jus de gingembre",
            "Jus d'ananas",
            "Jus de corossol",
            "Sirop de bissap",
            "Sirop de gingembre"
          ],
          "title": "Produit",
          "type": "string"
        },
        "quantite_comptee": {
          "description": "Ce qu'Awa a compté sur l'étagère.",
          "maximum": 1000,
          "minimum": 0,
          "title": "Quantite Comptee",
          "type": "integer"
        }
      },
      "required": [
        "produit",
        "quantite_comptee"
      ],
      "title": "preparer_correctionArguments"
    },
    "sortie": {
      "properties": {
        "produit": {
          "title": "Produit",
          "type": "string"
        },
        "stock_actuel": {
          "title": "Stock Actuel",
          "type": "integer"
        },
        "quantite_comptee": {
          "title": "Quantite Comptee",
          "type": "integer"
        },
        "ecart": {
          "title": "Ecart",
          "type": "integer"
        },
        "jeton": {
          "title": "Jeton",
          "type": "string"
        },
        "valable_jusqu_a": {
          "title": "Valable Jusqu A",
          "type": "string"
        },
        "a_dire_a_awa": {
          "title": "A Dire A Awa",
          "type": "string"
        }
      },
      "required": [
        "produit",
        "stock_actuel",
        "quantite_comptee",
        "ecart",
        "jeton",
        "valable_jusqu_a",
        "a_dire_a_awa"
      ],
      "title": "Correction",
      "type": "object"
    }
  },
  "appliquer_correction": {
    "title": "Appliquer une correction de stock",
    "description": "Seconde étape : remplace le stock du produit par la quantité comptée. Seulement avec un jeton de\npreparer_correction, et seulement après l'accord explicite d'Awa sur l'écart annoncé. Un jeton\nne sert qu'une fois.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "_meta": {
      "anthropic/requiresUserInteraction": true
    },
    "entree": {
      "type": "object",
      "properties": {
        "jeton": {
          "description": "Le jeton rendu par preparer_correction.",
          "title": "Jeton",
          "type": "string"
        }
      },
      "required": [
        "jeton"
      ],
      "title": "appliquer_correctionArguments"
    },
    "sortie": {
      "properties": {
        "produit": {
          "title": "Produit",
          "type": "string"
        },
        "avant": {
          "title": "Avant",
          "type": "integer"
        },
        "apres": {
          "title": "Apres",
          "type": "integer"
        },
        "resume": {
          "title": "Resume",
          "type": "string"
        }
      },
      "required": [
        "produit",
        "avant",
        "apres",
        "resume"
      ],
      "title": "CorrectionAppliquee",
      "type": "object"
    }
  }
} as const;

export const RESSOURCES = [
  {
    "name": "catalogue",
    "title": "Catalogue et conditions",
    "uri": "comptoir://catalogue",
    "description": "Les produits de Délices d'Awa, leurs prix et les conditions de commande et de livraison.",
    "mimeType": "text/markdown"
  }
] as const;

export const MODELES_DE_RESSOURCES = [
  {
    "name": "une_commande",
    "title": "Une commande",
    "uriTemplate": "comptoir://commande/{numero}",
    "description": "Le détail d'une commande, par son numéro (par exemple C-0042).",
    "mimeType": "text/markdown"
  }
] as const;

export const PROMPTS = [
  {
    "name": "bilan_du_soir",
    "title": "Bilan du soir",
    "description": "Le point de fin de journée : commandes, stock à surveiller, ce qu'il faut préparer pour demain.",
    "arguments": [
      {
        "name": "jour",
        "required": false
      }
    ]
  },
  {
    "name": "inventaire",
    "title": "Inventaire",
    "description": "Guide l'inventaire produit par produit, avec une correction de stock seulement après accord.",
    "arguments": []
  }
] as const;
