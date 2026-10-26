// Convertir la consommation d'un appel (le champ usage) en dollars, en FCFA et en euros (chapitre 2).
//
// Prix relevés sur platform.claude.com le 19 octobre 2026, revérifiés le 22 octobre 2026 (annexe D),
// en dollars par million de tokens : les mêmes que python/comptoir/couts.py.
// Vérifiez-les avant de vous en servir : ils changent (annexe D, page d'accompagnement).

import { config } from "./config.ts";

export interface Tarif {
  entree: number; //        tokens d'entrée hors cache
  ecriture5m: number; //    écriture dans le cache de 5 minutes
  ecriture1h: number; //    écriture dans le cache d'une heure
  lectureCache: number; //  lecture depuis le cache
  sortie: number; //        tokens de sortie, réflexion comprise
}

const tarif = (entree: number, ecriture5m: number, ecriture1h: number, lectureCache: number, sortie: number): Tarif =>
  ({ entree, ecriture5m, ecriture1h, lectureCache, sortie });

export const TARIFS: Record<string, Tarif> = {
  "claude-fable-5-1": tarif(10.0, 12.5, 20.0, 0.25, 50.0),
  "claude-opus-5-5": tarif(4.0, 5.0, 8.0, 0.2, 20.0),
  "claude-sonnet-5-5": tarif(2.0, 2.5, 4.0, 0.1, 10.0),
  "claude-haiku-5-5": tarif(0.1, 0.125, 0.2, 0.01, 0.5),
};

// Claude Haiku 5.5 coûte plus cher quand le prompt dépasse 100 000 tokens.
export const SEUIL_LONG_PROMPT = 100_000;
export const TARIFS_LONG_PROMPT: Record<string, Tarif> = {
  "claude-haiku-5-5": tarif(0.5, 0.625, 1.0, 0.05, 2.5),
};

// Batch API (traitement par lot) : 50 % de remise sur l'entrée et la sortie, et les multiplicateurs
// du cache se cumulent avec cette remise, donc tous les postes sont réduits de moitié. Source : page
// Pricing d'Anthropic, relue le 20 octobre 2026.
export const REMISE_LOT = 0.5;

// Recherche web : 10 $ les 1 000 recherches, en plus des tokens (Pricing, 20 octobre 2026). Même prix
// par la Batch API. La lecture de pages ne coûte que ses tokens (chapitre 10).
export const PRIX_RECHERCHE_WEB = 10.0 / 1000;

/**
 * L'usage d'un appel, tel que le SDK le donne ou tel qu'on le relit dans un JSON (journal, résultats
 * d'un lot). Un champ absent ou nul compte zéro.
 */
export interface UsageLu {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** 0.0071 -> « 0,0071 » : virgule décimale, comme dans le livre. */
const francais = (nombre: number, decimales: number): string => nombre.toFixed(decimales).replace(".", ",");

export class Cout {
  constructor(
    readonly dollars: number,
    readonly entree: number,
    readonly ecritureCache: number,
    readonly lectureCache: number,
    readonly sortie: number,
    readonly reflexion: number,
    readonly recherches = 0, // recherches web, facturées à part (chapitre 10)
  ) {}

  get fcfa(): number {
    return this.dollars * config.TAUX_FCFA;
  }

  get euros(): number {
    return this.dollars * config.TAUX_EUR;
  }

  toString(): string {
    return `${francais(this.dollars, 4)} $ (≈ ${francais(this.fcfa, 1)} FCFA ; ${francais(this.euros, 4)} €)`;
  }
}

function tarifDe(modele: string, longueurPrompt: number): Tarif {
  const normal = TARIFS[modele];
  if (!normal) throw new Error(`Prix inconnu pour le modèle « ${modele} » : ajoutez-le dans TARIFS.`);
  return (longueurPrompt > SEUIL_LONG_PROMPT && TARIFS_LONG_PROMPT[modele]) || normal;
}

/**
 * Le coût le plus élevé possible d'un appel, en dollars, avant de le lancer (chapitre 8).
 *
 * L'entrée est connue (countTokens, gratuit) ; la sortie ne dépassera pas maxTokens, réflexion
 * comprise. ecritureCache ("5m" ou "1h", chapitre 11) : si la requête pose un point de cache, le pire
 * cas est une entrée entièrement écrite dans le cache, qui coûte 1,25 ou 2 fois le prix d'entrée.
 */
export function coutMaximal(modele: string, tokensEntree: number, maxTokens: number, ecritureCache: "5m" | "1h" | null = null): number {
  const t = tarifDe(modele, tokensEntree);
  const prixEntree = ecritureCache === "5m" ? t.ecriture5m : ecritureCache === "1h" ? t.ecriture1h : t.entree;
  return (tokensEntree * prixEntree + maxTokens * t.sortie) / 1_000_000;
}

/**
 * La durée de cache la plus chère que demande une requête : "1h", "5m", ou null sans point de cache.
 * Les points peuvent être n'importe où : en tête, sur un outil, un bloc, un message.
 */
export function dureeCache(requete: unknown): "1h" | "5m" | null {
  const durees = new Set<string>();
  const parcourir = (objet: unknown): void => {
    if (Array.isArray(objet)) {
      objet.forEach(parcourir);
    } else if (objet !== null && typeof objet === "object") {
      const controle = (objet as { cache_control?: unknown }).cache_control;
      if (controle !== null && typeof controle === "object") durees.add((controle as { ttl?: string }).ttl ?? "5m");
      Object.values(objet).forEach(parcourir);
    }
  };
  parcourir(requete);
  return durees.has("1h") ? "1h" : durees.size ? "5m" : null;
}

/**
 * Calcule le coût d'un appel à partir de son champ usage.
 *
 * lot=true pour un appel passé par la Batch API. usage.service_tier peut valoir « batch », mais la
 * remise reste demandée explicitement par l'appelant.
 */
export function cout(modele: string, usage: UsageLu | null | undefined, lot = false): Cout {
  const entree = usage?.input_tokens ?? 0;
  const sortie = usage?.output_tokens ?? 0;
  const lecture = usage?.cache_read_input_tokens ?? 0;
  const ecriture = usage?.cache_creation_input_tokens ?? 0;
  const ecriture1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const ecriture5m = ecriture - ecriture1h; // sans détail, tout est compté en 5 minutes
  const reflexion = usage?.output_tokens_details?.thinking_tokens ?? 0;
  const recherches = usage?.server_tool_use?.web_search_requests ?? 0;

  // La longueur du prompt compte tous les tokens d'entrée, cache compris.
  const t = tarifDe(modele, entree + lecture + ecriture);
  let dollars =
    (entree * t.entree +
      ecriture5m * t.ecriture5m +
      ecriture1h * t.ecriture1h +
      lecture * t.lectureCache +
      sortie * t.sortie) / // output_tokens inclut déjà la réflexion
    1_000_000;
  if (lot) dollars *= REMISE_LOT; // après le choix du tarif : le seuil porte sur les tokens bruts
  dollars += recherches * PRIX_RECHERCHE_WEB; // sans remise de lot

  return new Cout(dollars, entree, ecriture, lecture, sortie, reflexion, recherches);
}
