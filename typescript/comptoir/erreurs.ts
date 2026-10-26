// Reconnaître chaque erreur, et savoir quoi en faire (chapitre 8).
//
// Deux questions pour chaque échec :
// - faut-il réessayer ? Oui si la même requête peut réussir plus tard (surcharge, coupure, limite de
//   débit) ; non s'il faut corriger quelque chose (clé, requête, budget) ;
// - d'où vient-il ? Du réseau, du service d'Anthropic, de notre code (l'intégration), de notre compte,
//   ou de la réponse du modèle. C'est ce qui dit qui doit agir.
//
// Les classes d'erreur sont celles du SDK @anthropic-ai/sdk 1.x, vérifiées dans sa version 1.1.0. Il
// n'a pas de classe pour 402, 413 ni 529 : on lit alors le statut, ou le type d'erreur du corps.

import Anthropic from "@anthropic-ai/sdk";

// Ce que voit le client d'Awa : jamais de détail technique, toujours le vouvoiement.
export const PASSAGERE = "Le Comptoir est très sollicité en ce moment. Réessayez dans un instant.";
export const INDISPONIBLE = "Le Comptoir ne peut pas répondre pour le moment. Awa vous répondra directement, dès que possible.";
export const REFUS = "Je ne peux pas répondre à cette demande. Awa vous répondra directement, dès que possible.";
export const ECOURTEE = "Ma réponse a été écourtée. Pouvez-vous poser votre question en plus court ?";

export type Origine = "reseau" | "service" | "integration" | "compte" | "modele";

export interface Diagnostic {
  code: string; //            court et stable, pour le journal et le tableau de bord
  reessayer: boolean; //      la même requête, plus tard, peut-elle réussir ?
  origine: Origine;
  pourLeClient: string;
  pourYao: string; //         ce qu'il faut faire
  attenteS: number | null; // ce que demande l'en-tête retry-after
}

const diagnostic = (
  code: string,
  reessayer: boolean,
  origine: Origine,
  pourLeClient: string,
  pourYao: string,
  attenteS: number | null = null,
): Diagnostic => ({ code, reessayer, origine, pourLeClient, pourYao, attenteS });

export class ErreurComptoir extends Error {
  constructor(
    readonly diagnostic: Diagnostic,
    options?: { cause?: unknown },
  ) {
    super(`${diagnostic.code} : ${diagnostic.pourYao}`, options);
  }
}

/**
 * Le flux s'est arrêté avant message_stop. Le SDK TypeScript lève alors une AnthropicError sans cause
 * (« stream ended without producing a Message… ») ; comptoir/flux.ts la traduit en FluxIncomplet
 * (vérifié par tests/ch06_coupure.test.ts).
 */
export class FluxIncomplet extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Flux fermé sans message_stop", options);
  }
}

/**
 * Une connexion qui lâche en plein flux : le SDK TypeScript la remonte comme une AnthropicError qui n'est
 * pas une erreur d'API, sans statut, avec pour cause l'erreur du fetch de Node (« terminated »).
 */
export function estUneCoupure(erreur: unknown): boolean {
  return erreur instanceof Anthropic.AnthropicError && !(erreur instanceof Anthropic.APIError) && erreur.cause !== undefined;
}

type CorpsErreur = { error?: { type?: string; message?: string; details?: { error_code?: string } | null } };

const corps = (erreur: InstanceType<typeof Anthropic.APIError>): NonNullable<CorpsErreur["error"]> =>
  ((erreur.error ?? {}) as CorpsErreur).error ?? {};

function attente(erreur: InstanceType<typeof Anthropic.APIError>): number | null {
  const valeur = erreur.headers?.get("retry-after");
  const nombre = valeur === null || valeur === undefined ? NaN : Number(valeur);
  return Number.isFinite(nombre) ? nombre : null;
}

/** Le diagnostic d'une exception levée par un appel à l'API. */
export function diagnostiquer(erreur: unknown): Diagnostic {
  // Une erreur de connexion est aussi une APIError, sans statut : on la traite plus bas, avec le réseau.
  if (erreur instanceof Anthropic.APIError && !(erreur instanceof Anthropic.APIConnectionError)) {
    const c = corps(erreur);
    const message = c.message ?? "";
    const type = c.type ?? erreur.type;
    const statut = erreur.status;

    if (erreur instanceof Anthropic.AuthenticationError) {
      return diagnostic("cle_invalide", false, "compte", INDISPONIBLE,
        "Clé refusée : mal copiée, révoquée ou expirée. Créez-en une autre dans la Console.");
    }
    if (statut === 402) {
      return diagnostic("facturation", false, "compte", INDISPONIBLE,
        "Problème de facturation : vérifiez les crédits et le moyen de paiement dans la Console.");
    }
    if (erreur instanceof Anthropic.PermissionDeniedError) {
      return diagnostic("permission", false, "compte", INDISPONIBLE,
        "La clé n'a pas accès à cette ressource : vérifiez son espace de travail.");
    }
    if (erreur instanceof Anthropic.NotFoundError) {
      return diagnostic("introuvable", false, "integration", INDISPONIBLE,
        "Modèle ou ressource introuvable : vérifiez COMPTOIR_MODELE (modèle retiré ?).");
    }
    if (statut === 413) {
      return diagnostic("requete_trop_lourde", false, "integration", INDISPONIBLE,
        "Requête au-delà de la taille permise (32 Mo) : réduisez les images, ou la Files API.");
    }
    if (erreur instanceof Anthropic.RateLimitError) {
      if (c.details?.error_code === "enforced_spend_limit_reached") {
        // Même type d'erreur qu'une limite de débit, mais sans retry-after : réessayer ne sert à rien
        // avant le mois suivant.
        return diagnostic("plafond_du_palier", false, "compte", INDISPONIBLE,
          "Plafond mensuel du palier atteint : demandez un palier supérieur dans la Console.");
      }
      return diagnostic("limite_de_debit", true, "compte", PASSAGERE,
        "Limite de débit atteinte : étalez les appels, ou demandez des limites plus hautes.", attente(erreur));
    }
    if (erreur instanceof Anthropic.BadRequestError) {
      if (message.includes("usage limits")) {
        return diagnostic("limite_de_depense", false, "compte", INDISPONIBLE,
          "Votre limite de dépense est atteinte : relevez-la dans la Console, ou attendez la date indiquée dans le message.");
      }
      return diagnostic("requete_invalide", false, "integration", INDISPONIBLE,
        `Requête refusée par l'API : corrigez le code. Message : ${message.slice(0, 200)}`);
    }
    if (erreur instanceof Anthropic.ConflictError) {
      return diagnostic("conflit", true, "service", PASSAGERE, "Conflit passager : le SDK réessaie.");
    }
    // 529, ou une erreur annoncée en plein flux : sans statut, son type est dans le corps.
    if (statut === 529 || type === "overloaded_error") {
      return diagnostic("surcharge", true, "service", PASSAGERE,
        "Service surchargé : réessai automatique ; si cela dure, voir la page de statut.");
    }
    if (statut === 504 || type === "timeout_error") {
      return diagnostic("delai_api", true, "service", PASSAGERE,
        "L'API a mis trop de temps : préférez le streaming pour les longues réponses.");
    }
    if ((statut ?? 0) >= 500 || type === "api_error") {
      return diagnostic("erreur_interne", true, "service", PASSAGERE,
        "Erreur interne d'Anthropic : réessai ; si elle persiste, support avec l'identifiant.");
    }
    return diagnostic("erreur_api", false, "integration", INDISPONIBLE, `Erreur ${statut} : ${message.slice(0, 200)}`);
  }

  if (erreur instanceof FluxIncomplet) {
    return diagnostic("flux_incomplet", true, "reseau", PASSAGERE,
      "Flux fermé sans message_stop : réponse tronquée, reprise automatique.");
  }
  if (erreur instanceof Anthropic.APIConnectionTimeoutError) { // avant APIConnectionError, dont elle hérite
    return diagnostic("delai_depasse", true, "reseau", PASSAGERE,
      "Pas de réponse dans le délai : réseau lent, ou délai trop court (COMPTOIR_DELAI_S).");
  }
  if (erreur instanceof Anthropic.APIConnectionError || estUneCoupure(erreur)) {
    return diagnostic("connexion", true, "reseau", PASSAGERE, "Connexion à l'API impossible ou coupée.");
  }
  const nom = erreur instanceof Error ? erreur.constructor.name : typeof erreur;
  return diagnostic("inconnue", false, "integration", INDISPONIBLE,
    `Erreur imprévue dans le code : ${nom}. Lisez la trace complète.`);
}

/** Le diagnostic d'une réponse arrivée, mais qui ne s'est pas arrêtée normalement. */
export function diagnostiquerArret(message: {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
}): Diagnostic | null {
  switch (message.stop_reason) {
    case "refusal": {
      const categorie = message.stop_details?.category || "non précisée";
      return diagnostic("refus", false, "modele", REFUS,
        `Refus des classificateurs de sécurité (catégorie : ${categorie}). Lire la conversation ; ` +
          "si la demande était légitime, un autre modèle peut y répondre (repli).");
    }
    case "max_tokens":
      return diagnostic("reponse_coupee", false, "integration", ECOURTEE,
        "Réponse coupée par max_tokens : relevez le plafond, ou demandez des réponses plus courtes.");
    case "model_context_window_exceeded":
      return diagnostic("contexte_plein", false, "integration", INDISPONIBLE,
        "La fenêtre de contexte est pleine : réduisez l'historique (chapitre 6).");
    case "pause_turn":
      return diagnostic("pause", true, "modele", PASSAGERE,
        "Boucle d'outils serveur en pause : renvoyer la réponse telle quelle pour continuer (chapitre 10).");
    default:
      return null;
  }
}
