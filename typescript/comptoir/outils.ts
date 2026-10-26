// Les outils du Comptoir : ce que Claude peut demander, et ce que le code fait vraiment (chapitre 9).
//
// Trois outils seulement, chacun avec une description qui dit quoi, quand, et ce qu'il ne fait pas. Le
// mode strict garantit des paramètres conformes au schéma ; les règles que le schéma ne peut pas porter
// (quantité au moins égale à 1, produit du catalogue) sont vérifiées par la boutique, qui répond par une
// erreur explicite.
//
// Aucun outil ne crée de commande : c'est le client qui confirme, par un code que le code vérifie
// (comptoir/commandes.ts).

import type Anthropic from "@anthropic-ai/sdk";
import { type Boutique, type LigneDemandee, type Recapitulatif, RefusBoutique } from "./boutique.ts";
import { jsonPython } from "./python.ts";

/** Un objet de schéma strict : tous les champs déclarés, aucun champ en plus. */
const objet = (proprietes: Record<string, unknown>, requis: string[]) => ({
  type: "object" as const,
  properties: proprietes,
  required: requis,
  additionalProperties: false,
});

export const OUTILS: Anthropic.Tool[] = [
  {
    name: "stock_verifier",
    description:
      "Donne la quantité disponible aujourd'hui pour un ou plusieurs produits du catalogue de Délices d'Awa. " +
      "À utiliser quand un client veut commander, ou demande si un produit est disponible. " +
      "Les noms doivent être ceux du catalogue, à l'identique, par exemple « Jus de bissap ». " +
      "Ne renvoie ni prix ni délai : les prix sont dans le catalogue, les délais dans les conditions.",
    strict: true,
    input_schema: objet(
      { produits: { type: "array", items: { type: "string" }, description: "Les noms exacts des produits du catalogue à vérifier." } },
      ["produits"],
    ),
  },
  {
    name: "commande_preparer",
    description:
      "Prépare le récapitulatif officiel d'une commande : vérifie les produits et le stock, calcule le total " +
      "avec les prix du catalogue et les frais de livraison. Ne crée pas la commande : elle n'existe qu'après " +
      "la confirmation du client, que le système recueille lui-même avec un code. " +
      "À appeler quand le client a dit ce qu'il veut, à quel nom et dans quel quartier de Cotonou le livrer. " +
      "Si le client change d'avis, rappelle l'outil avec la nouvelle commande : le récapitulatif précédent " +
      "est annulé. Si l'outil renvoie une erreur (produit inconnu, stock insuffisant, devis nécessaire), " +
      "explique-la au client et propose une solution.",
    strict: true,
    input_schema: objet(
      {
        lignes: {
          type: "array",
          description: "Les produits commandés, une ligne par produit.",
          items: objet(
            {
              produit: { type: "string", description: "Le nom exact du catalogue." },
              quantite: { type: "integer", description: "Le nombre de bouteilles ou de flacons, au moins 1." },
            },
            ["produit", "quantite"],
          ),
        },
        nom_client: { type: "string", description: "Le nom donné par le client pour la livraison." },
        quartier: { type: "string", description: "Le quartier de livraison, à Cotonou." },
      },
      ["lignes", "nom_client", "quartier"],
    ),
  },
  {
    name: "transmettre_a_awa",
    description:
      "Transmet à Awa une demande que seule elle peut traiter : remise ou prix spécial, réclamation, devis " +
      "(événement, ou plus de 50 bouteilles), livraison hors de Cotonou, ou question sans réponse dans le " +
      "catalogue et les conditions. Awa lit ces demandes plusieurs fois par jour et répond elle-même au client. " +
      "Après l'appel, dis au client que sa demande est transmise ; ne promets ni résultat, ni autre délai " +
      "que ceux des conditions.",
    strict: true,
    input_schema: objet(
      {
        motif: { type: "string", enum: ["remise", "reclamation", "devis", "hors_zone", "autre"] },
        resume: { type: "string", description: "La demande en une ou deux phrases, pour qu'Awa la comprenne sans relire la conversation." },
      },
      ["motif", "resume"],
    ),
  },
];

export const NOMS = new Set(OUTILS.map((o) => o.name));

/**
 * Du JSON écrit comme json.dumps de Python (« , » et « : » suivis d'une espace) : un résultat d'outil
 * est le même texte, donc le même nombre de tokens, dans les deux versions du Comptoir.
 */
export const versJson = (valeur: unknown): string => jsonPython(valeur);

/** Ce qu'un tour d'outils a produit, en plus des résultats renvoyés à Claude. */
export class Execution {
  recapitulatif: Recapitulatif | null = null;
  readonly transmissions: { demande: string; transmise: true }[] = [];
  readonly appels: string[] = [];
}

/** Exécute les outils pour une conversation donnée, sur une boutique donnée. */
export class Outils {
  constructor(
    readonly boutique: Boutique,
    readonly conversation: string,
  ) {}

  /** Un bloc tool_use en entrée, un bloc tool_result en sortie. Jamais d'exception vers la boucle. */
  executer(appel: Pick<Anthropic.ToolUseBlock, "id" | "name" | "input">, execution: Execution): Anthropic.ToolResultBlockParam {
    execution.appels.push(appel.name);
    try {
      const resultat = this.executerOutil(appel.name, appel.input as Record<string, unknown>, execution);
      return { type: "tool_result", tool_use_id: appel.id, content: versJson(resultat) };
    } catch (refus) {
      if (!(refus instanceof RefusBoutique)) throw refus;
      // Une erreur instructive : ce qui ne va pas, et ce que Claude doit faire maintenant.
      return { type: "tool_result", tool_use_id: appel.id, content: refus.message, is_error: true };
    }
  }

  private executerOutil(nom: string, entree: Record<string, unknown>, execution: Execution): unknown {
    if (nom === "stock_verifier") {
      return Object.fromEntries(
        (entree.produits as string[]).map((p) => [p, this.boutique.catalogue.has(p) ? this.boutique.disponible(p) : "absent du catalogue"]),
      );
    }
    if (nom === "commande_preparer") {
      const recap = this.boutique.preparer(this.conversation, entree.lignes as LigneDemandee[], String(entree.nom_client), String(entree.quartier));
      execution.recapitulatif = recap;
      // Claude ne reçoit pas le code : le système affiche lui-même le récapitulatif officiel.
      const { code_de_confirmation: _code, a_dire_au_client: _phrase, ...pourClaude } = recap;
      return pourClaude;
    }
    if (nom === "transmettre_a_awa") {
      const demande = this.boutique.transmettre(this.conversation, String(entree.motif), String(entree.resume));
      execution.transmissions.push(demande);
      return demande;
    }
    throw new RefusBoutique(`Outil « ${nom} » inconnu. Outils disponibles : ${[...NOMS].sort().join(", ")}.`);
  }
}
