// Chercher les bons passages quand la base ne tient plus dans le contexte (chapitre 11).
//
// - IndexBM25 : la recherche lexicale, qui trouve les mots exacts (« Godomey », « 48 heures »).
// - IndexVecteurs : la recherche par le sens, avec des embeddings. Anthropic n'en fournit pas : la
//   fonction qui les calcule est passée en paramètre (Voyage AI, ou un faux pour les tests).
// - fusionner : la recherche hybride, qui combine plusieurs classements (fusion des rangs).
// - reclasser : Claude relit les meilleurs candidats et garde les plus utiles.
// - contextualiser : Claude écrit, pour chaque morceau, la phrase qui le situe dans son document
//   (Contextual Retrieval), en lisant le document depuis le cache.
//
// Tout est écrit ici, sans dépendance : une base de quelques milliers de morceaux n'a besoin ni de base
// de données vectorielle, ni de bibliothèque de recherche.

import type Anthropic from "@anthropic-ai/sdk";
import { type ClientMessages, texteDe } from "./client.ts";
import { type Morceau, pourLaRecherche } from "./connaissances.ts";
import { cout } from "./couts.ts";
import { noter } from "./journal.ts";
import { somme } from "./python.ts";

// Des mots trop fréquents pour aider à trouver quoi que ce soit.
const MOTS_VIDES = new Set(
  `a au aux avec ce ces cet cette d dans de des du elle en est et etre il ils j je l la le les leur
leurs lui m ma mais me mes mon n ne nos notre nous on ou par pas pour qu que quel quelle quelles
quels qui s sa se ses si son sont sur t ta te tes ton tu un une vos votre vous y c ca est-ce`
    .split(/\s+/)
    .filter(Boolean),
);

export type Classement = [Morceau, number][];

/** Minuscules, sans accents, sans mots vides, et un pluriel simple ramené au singulier. */
export function mots(texte: string): string[] {
  // Comme encode("ascii", "ignore") en Python : tout caractère hors ASCII disparaît, accents compris.
  const sansAccents = texte.normalize("NFD").replace(/[^\x00-\x7f]/g, "").toLowerCase();
  const resultat: string[] = [];
  for (let mot of sansAccents.match(/[a-z0-9]+/g) ?? []) {
    if (MOTS_VIDES.has(mot)) continue;
    if (mot.length > 3 && "sx".includes(mot.at(-1)!)) mot = mot.slice(0, -1);
    resultat.push(mot);
  }
  return resultat;
}

/** Les morceaux par score décroissant ; à score égal, l'ordre de départ (le tri est stable, comme en Python). */
const parScore = (a: [Morceau, number], b: [Morceau, number]): number => b[1] - a[1];

/**
 * BM25 : la fréquence d'un mot dans le morceau compte, mais de moins en moins (k1), les mots rares
 * comptent plus que les mots courants (idf), et un long morceau ne gagne pas seulement parce qu'il est
 * long (b).
 */
export class IndexBM25 {
  readonly termes: Map<string, number>[];
  readonly longueurs: number[];
  readonly longueurMoyenne: number;
  readonly idf = new Map<string, number>();

  constructor(
    readonly morceaux: Morceau[],
    readonly k1 = 1.5,
    readonly b = 0.75,
  ) {
    this.termes = morceaux.map((m) => {
      const compte = new Map<string, number>();
      for (const mot of mots(pourLaRecherche(m))) compte.set(mot, (compte.get(mot) ?? 0) + 1);
      return compte;
    });
    this.longueurs = this.termes.map((t) => [...t.values()].reduce((x, y) => x + y, 0));
    this.longueurMoyenne = morceaux.length ? this.longueurs.reduce((x, y) => x + y, 0) / morceaux.length : 0;
    const frequences = new Map<string, number>();
    for (const t of this.termes) for (const mot of t.keys()) frequences.set(mot, (frequences.get(mot) ?? 0) + 1);
    const n = morceaux.length;
    // Math.log de V8 et celui de Python diffèrent parfois au dernier bit : des scores égaux à 10^-15 près.
    for (const [mot, f] of frequences) this.idf.set(mot, Math.log(1 + (n - f + 0.5) / (f + 0.5)));
  }

  score(i: number, question: string[]): number {
    const termes = this.termes[i]!;
    const longueur = this.longueurs[i]!;
    let total = 0;
    for (const mot of question) {
      const f = termes.get(mot) ?? 0;
      if (f) {
        const norme = 1 - this.b + (this.b * longueur) / this.longueurMoyenne;
        total += (this.idf.get(mot)! * f * (this.k1 + 1)) / (f + this.k1 * norme);
      }
    }
    return total;
  }

  chercher(question: string, k = 5): Classement {
    const q = mots(question);
    const scores: Classement = this.morceaux.map((m, i) => [m, this.score(i, q)]);
    return scores.filter((s) => s[1] > 0).sort(parScore).slice(0, k);
  }
}

/** (textes, "document" ou "query") -> vecteurs. Un appel réseau, donc une promesse. */
export type Plongeur = (textes: string[], typeEntree: "document" | "query") => Promise<number[][]> | number[][];

/**
 * La recherche par le sens : la question et les morceaux deviennent des vecteurs, et l'on garde les
 * morceaux dont le vecteur est le plus proche de celui de la question. Les vecteurs des morceaux se
 * calculent à la création : IndexVecteurs.creer(), à attendre (await).
 */
export class IndexVecteurs {
  private constructor(
    readonly morceaux: Morceau[],
    readonly plonger: Plongeur,
    readonly vecteurs: number[][],
  ) {}

  static async creer(morceaux: Morceau[], plonger: Plongeur): Promise<IndexVecteurs> {
    return new IndexVecteurs(morceaux, plonger, await plonger(morceaux.map(pourLaRecherche), "document"));
  }

  async chercher(question: string, k = 5): Promise<Classement> {
    const q = (await this.plonger([question], "query"))[0]!;
    const n = Math.min(this.morceaux.length, this.vecteurs.length);
    const scores: Classement = this.morceaux.slice(0, n).map((m, i) => [m, cosinus(q, this.vecteurs[i]!)]);
    return scores.sort(parScore).slice(0, k);
  }
}

/** Les sommes comme sum() de Python : des scores identiques au bit près. */
function cosinus(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const produit = somme(a.slice(0, n).map((x, i) => x * b[i]!));
  const normes = Math.sqrt(somme(a.map((x) => x * x))) * Math.sqrt(somme(b.map((y) => y * y)));
  return normes ? produit / normes : 0;
}

/**
 * Les embeddings de Voyage AI, par l'API HTTP de MongoDB Atlas (clé dans VOYAGE_API_KEY). Payant au
 * token : comptez les textes avant d'indexer une grande base.
 */
export function plongeurVoyage(modele = "voyage-4", cle: string | null = null, adresse = "https://ai.mongodb.com/v1/embeddings"): Plongeur {
  const jeton = cle || process.env.VOYAGE_API_KEY;
  if (!jeton) throw new Error("VOYAGE_API_KEY n'est pas définie.");
  return async (textes, typeEntree) => {
    const reponse = await fetch(adresse, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ input: textes, model: modele, input_type: typeEntree }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!reponse.ok) throw new Error(`Voyage AI : HTTP ${reponse.status}`); // urlopen lève une HTTPError
    const donnees = (await reponse.json()) as { data: { index: number; embedding: number[] }[] };
    return [...donnees.data].sort((x, y) => x.index - y.index).map((d) => d.embedding);
  };
}

/**
 * Fusion des rangs (reciprocal rank fusion) : chaque index donne 1 / (k + rang) à ses morceaux. On
 * additionne : un morceau bien placé par deux index passe devant. Les scores bruts ne se comparent pas
 * d'un index à l'autre ; les rangs, si.
 */
export function fusionner(classements: Classement[], { k = 60, garder = 5 } = {}): Classement {
  const scores = new Map<string, number>();
  const parId = new Map<string, Morceau>();
  for (const classement of classements) {
    classement.forEach(([morceau], i) => {
      scores.set(morceau.identifiant, (scores.get(morceau.identifiant) ?? 0) + 1 / (k + i + 1));
      parId.set(morceau.identifiant, morceau);
    });
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, garder).map(([id, s]) => [parId.get(id)!, s]);
}

// --- Claude au service de la recherche -----------------------------------------------------------

export const MODELE_AUXILIAIRE = "claude-haiku-5-5"; // petites tâches à gros volume : classer, situer

export const SCHEMA_RECLASSEMENT = {
  type: "object",
  properties: { pertinents: { type: "array", items: { type: "string" } } },
  required: ["pertinents"],
  additionalProperties: false,
};

export function requeteReclassement(question: string, candidats: Morceau[], garder: number, modele = MODELE_AUXILIAIRE): Anthropic.MessageCreateParamsNonStreaming {
  const passages = candidats.map((m) => `<passage id="${m.identifiant}">\n${m.titre}\n${m.texte}\n</passage>`).join("\n\n");
  return {
    model: modele,
    max_tokens: 500,
    system:
      "Tu classes des passages de la documentation de Délices d'Awa selon leur utilité pour " +
      "répondre à une question de client. Tu ne réponds pas à la question.",
    messages: [
      {
        role: "user",
        content:
          `${passages}\n\n<question>${question}</question>\n\n` +
          `Donne les identifiants des ${garder} passages au plus qui aident à répondre, du plus utile au ` +
          "moins utile. Si aucun n'aide, renvoie une liste vide.",
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA_RECLASSEMENT } },
  };
}

/**
 * Claude relit les candidats et rend les plus utiles, dans l'ordre, avec le coût en dollars. Un
 * identifiant inconnu est écarté : le code ne croit pas sur parole une liste produite par un modèle.
 */
export async function reclasser(
  client: ClientMessages,
  question: string,
  candidats: Morceau[],
  garder = 3,
  modele = MODELE_AUXILIAIRE,
): Promise<[Morceau[], number]> {
  if (!candidats.length) return [[], 0];
  const message = await client.messages.create(requeteReclassement(question, candidats, garder, modele));
  const prix = cout(modele, message.usage);
  noter(message._request_id, modele, prix, { prompt: "reclassement" });
  const parId = new Map(candidats.map((m) => [m.identifiant, m]));
  const pertinents = (JSON.parse(texteDe(message)) as { pertinents: unknown[] }).pertinents;
  if (!Array.isArray(pertinents)) throw new Error("Réponse de reclassement sans liste « pertinents ».");
  const choisis = [...new Set(pertinents.filter((i): i is string => typeof i === "string" && parId.has(i)))];
  return [choisis.slice(0, garder).map((i) => parId.get(i)!), prix.dollars];
}

export const consigneContexte = (passage: string): string =>
  `Voici un passage de ce document :\n<passage>\n${passage}\n</passage>\n` +
  "Écris une phrase courte qui situe ce passage dans l'ensemble du document, pour qu'on le " +
  "retrouve mieux dans une recherche. Réponds seulement par cette phrase.";

/**
 * Le document entier d'abord, avec un point de cache ; le passage ensuite. Du deuxième passage au
 * dernier, le document est lu dans le cache, à une fraction du prix.
 */
export function requeteContexte(document: string, morceau: Morceau, modele = MODELE_AUXILIAIRE): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: modele,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `<document>\n${document}\n</document>`, cache_control: { type: "ephemeral" } },
          { type: "text", text: consigneContexte(morceau.texte) },
        ],
      },
    ],
  };
}

/**
 * Une phrase de contexte par morceau. Les appels se suivent, un par un : une entrée du cache n'est
 * disponible qu'une fois la première réponse commencée. Rend aussi les usages, pour vérifier que le
 * cache a bien servi.
 */
export async function contextualiser(
  client: ClientMessages,
  document: string,
  morceaux: Morceau[],
  modele = MODELE_AUXILIAIRE,
): Promise<[Record<string, string>, Anthropic.Usage[]]> {
  const contextes: Record<string, string> = {};
  const usages: Anthropic.Usage[] = [];
  for (const morceau of morceaux) {
    const message = await client.messages.create(requeteContexte(document, morceau, modele));
    noter(message._request_id, modele, cout(modele, message.usage), { prompt: "contexte" });
    contextes[morceau.identifiant] = texteDe(message).trim();
    usages.push(message.usage);
  }
  return [contextes, usages];
}

/** Le classement contient-il au moins un des morceaux attendus ? (rappel à k) */
export const rappel = (classement: Classement, attendus: string[]): boolean => classement.some(([m]) => attendus.includes(m.identifiant));
