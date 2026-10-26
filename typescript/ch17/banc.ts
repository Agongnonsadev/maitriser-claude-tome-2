// Le banc d'essai du chapitre 17 : un cas, une variante, un essai, dans un environnement neuf.
//
// Chaque essai part de zéro : une boutique en mémoire avec le stock du chapitre 9, une horloge
// arrêtée (un mardi à 10 h, heure de Cotonou), un budget vide, une conversation neuve. Rien ne
// passe d'un essai à l'autre : un essai qui réussit grâce au précédent ne mesure rien.
//
// Le client d'API est enveloppé par un enregistreur : chaque appel y laisse le modèle, l'arrêt,
// les tokens, la durée, le coût, ce que Claude a écrit ou demandé, et les résultats d'outils
// qu'il a reçus. C'est la transcription de l'essai, à relire quand un cas échoue.
//
// Les messages de ce jeu sont des cas de test, pas des messages de clients : ils peuvent
// figurer dans les résultats, ce que le journal du Comptoir, lui, ne fait jamais.
//
// Un essai s'écrit avec les noms de champs de la version Python : une série de l'une se relit avec l'autre.

import type Anthropic from "@anthropic-ai/sdk";
import { ComptoirAiguille } from "../comptoir/aiguillage.ts";
import { arrondir } from "../comptoir/arrondi.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import type { ClientMessages, MessageRecu } from "../comptoir/client.ts";
import type { Morceau } from "../comptoir/connaissances.ts";
import { cout } from "../comptoir/couts.ts";
import { ErreurComptoir } from "../comptoir/erreurs.ts";
import { HasardPython } from "../comptoir/hasard.ts";
import { somme, str } from "../comptoir/python.ts";

export const HEURE_DES_ESSAIS = new Date("2026-10-20T10:00:00+01:00"); // un mardi, avant midi, à Cotonou
export const DEBUT_RECAPITULATIF = "\n\nRécapitulatif de votre commande";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** Un cas de ch17/cas.json (python/ch17/cas.json, commun aux deux versions). */
export interface CasEvaluation {
  id: string;
  jeu: "amelioration" | "verification";
  type: "courant" | "piege" | "securite";
  origine: string;
  message: string;
  categorie: string[];
  etat?: { transmis?: boolean; motif?: string[]; recapitulatif?: boolean; total?: number };
  reference: string;
  doit_contenir?: string[];
  un_parmi?: string[];
  ne_doit_pas_contenir?: string[];
  ne_doit_pas_correspondre?: string[];
  doit_transmettre?: boolean;
  phrases_max?: number;
}

/**
 * Ce qui change d'une version du Comptoir à l'autre. Les défauts sont la version livrée au chapitre 17 ;
 * depuis le chapitre 18, la version livrée a le prompt v5 (suite.VARIANTES.livree).
 */
export interface Variante {
  readonly nom: string;
  readonly modele_comptoir: string | null; //  null : celui de la version livrée, config.MODELE_COMPTOIR
  readonly version_prompt: string;
  readonly version_documents: string;
  readonly effort_comptoir: Effort | null; //  chapitre 19 : null, l'effort de la version livrée
}

export const variante = (nom: string, autres: Partial<Omit<Variante, "nom">> = {}): Variante =>
  Object.freeze({ nom, modele_comptoir: null, version_prompt: "v3", version_documents: "v1", effort_comptoir: null, ...autres });

export interface BlocRendu {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface Appel {
  modele: string;
  arret: string | null;
  duree_s: number;
  cout_dollars: number;
  tokens: { entree: number; ecriture_cache: number; lecture_cache: number; sortie: number; reflexion: number };
  recu: { erreur: boolean; contenu: string }[];
  rendu: BlocRendu[];
}

function resumeBloc(bloc: Anthropic.ContentBlock): BlocRendu {
  if (bloc.type === "text") return { type: "text", text: bloc.text };
  if (bloc.type === "tool_use") return { type: "tool_use", name: bloc.name, input: bloc.input };
  return { type: bloc.type }; // la réflexion : on note qu'elle a eu lieu, pas son contenu
}

/** Les 300 premiers caractères (et non unités UTF-16), comme texte[:300] en Python. */
const debut = (texte: string, n: number): string => [...texte].slice(0, n).join("");

/** Les résultats d'outils envoyés avec cet appel : la réponse de la boutique au tour précédent. */
function resultatsRecus(requete: Anthropic.MessageCreateParamsNonStreaming): Appel["recu"] {
  const dernier = requete.messages.at(-1);
  if (!dernier || dernier.role !== "user" || typeof dernier.content === "string") return [];
  return dernier.content
    .filter((b): b is Anthropic.ToolResultBlockParam => typeof b === "object" && b !== null && b.type === "tool_result")
    .map((b) => ({ erreur: Boolean(b.is_error), contenu: debut(str(b.content ?? null), 300) }));
}

/** Se présente comme le client du SDK (client.messages.create) et garde une trace de chaque appel. */
export class Enregistreur implements ClientMessages {
  readonly messages: ClientMessages["messages"] = this;
  readonly appels: Appel[] = [];

  constructor(private readonly client: ClientMessages) {}

  countTokens(requete: Anthropic.MessageCountTokensParams): PromiseLike<Anthropic.MessageTokensCount> {
    return this.client.messages.countTokens(requete);
  }

  async create(requete: Anthropic.MessageCreateParamsNonStreaming): Promise<MessageRecu> {
    const debutAppel = performance.now();
    const message = await this.client.messages.create(requete);
    const prix = cout(requete.model, message.usage);
    this.appels.push({
      modele: requete.model,
      arret: message.stop_reason,
      duree_s: arrondir((performance.now() - debutAppel) / 1000, 2),
      cout_dollars: arrondir(prix.dollars, 6),
      tokens: { entree: prix.entree, ecriture_cache: prix.ecritureCache, lecture_cache: prix.lectureCache, sortie: prix.sortie, reflexion: prix.reflexion },
      recu: resultatsRecus(requete),
      rendu: message.content.map(resumeBloc),
    });
    return message;
  }
}

/** Une étape de la trace du chapitre 12, aux noms de la version Python. */
export interface EtapeEnregistree {
  nom: string;
  modele: string;
  duree_ms: number;
  cout_dollars: number;
  resultat: string;
  erreur: string | null;
}

export interface Essai {
  variante: string;
  cas: string;
  essai: number;
  categorie: string;
  texte: string; //                                       ce que lit le client, récapitulatif compris
  texte_claude: string; //                                la part écrite par Claude, sans le récapitulatif du code
  recapitulatifs: { statut: string; total: number }[]; // statut et total, lus dans la boutique
  demandes: string[]; //                                  motifs des demandes transmises à Awa
  commandes: number;
  outils: string[];
  etapes: EtapeEnregistree[];
  appels: Appel[];
  cout_dollars: number;
  latence_s: number;
  erreur: string | null;
}

export const CHAMPS_ESSAI = [
  "variante", "cas", "essai", "categorie", "texte", "texte_claude", "recapitulatifs", "demandes", "commandes",
  "outils", "etapes", "appels", "cout_dollars", "latence_s", "erreur",
] as const satisfies readonly (keyof Essai)[];

/** Essai(variante, cas, essai, …) en Python : les autres champs ont leur valeur par défaut. */
export const creerEssai = (variante: string, cas: string, numero: number, champs: Partial<Essai> = {}): Essai => ({
  variante, cas, essai: numero, categorie: "", texte: "", texte_claude: "", recapitulatifs: [], demandes: [], commandes: 0,
  outils: [], etapes: [], appels: [], cout_dollars: 0, latence_s: 0, erreur: null, ...champs,
});

export const identifiant = (e: Pick<Essai, "variante" | "cas" | "essai">): string => `${e.variante}/${e.cas}/${e.essai}`;

/** Une boutique neuve : stock du chapitre 9, horloge arrêtée, codes de confirmation reproductibles (les mêmes qu'en Python). */
export function environnement(graine = 17): Boutique {
  const hasard = new HasardPython(graine);
  return new Boutique(":memory:", { horloge: () => HEURE_DES_ESSAIS, hasard: (n) => hasard.randrange(n) });
}

export async function essayer(client: ClientMessages, v: Variante, cas: CasEvaluation, numero: number, base: Morceau[]): Promise<Essai> {
  const enregistreur = new Enregistreur(client);
  const boutique = environnement();
  const conversation = identifiantAleatoire();
  const comptoir = new ComptoirAiguille(enregistreur, boutique, new Budget(":memory:"), conversation, base, {
    modeleComptoir: v.modele_comptoir, versionPrompt: v.version_prompt, versionDocuments: v.version_documents, effortComptoir: v.effort_comptoir,
  });
  const essai = creerEssai(v.nom, cas.id, numero);
  const debutEssai = performance.now();
  try {
    const reponse = await comptoir.repondre(cas.message);
    essai.categorie = reponse.categorie;
    essai.texte = reponse.texte;
    essai.etapes = reponse.trace.etapes.map((e) => ({
      nom: e.nom, modele: e.modele, duree_ms: e.dureeMs, cout_dollars: e.coutDollars, resultat: e.resultat, erreur: e.erreur,
    }));
  } catch (erreur) {
    if (erreur instanceof ErreurComptoir) {
      essai.erreur = `${erreur.diagnostic.code} (${erreur.diagnostic.origine})`;
    } else {
      // Une panne du banc ou du code : l'essai échoue, la série continue.
      essai.erreur = erreur instanceof Error ? `${erreur.constructor.name}: ${erreur.message}` : String(erreur);
    }
  }
  essai.latence_s = arrondir((performance.now() - debutEssai) / 1000, 2);
  essai.texte_claude = essai.texte.split(DEBUT_RECAPITULATIF)[0]!;
  essai.recapitulatifs = boutique.recapitulatifs(conversation).map((r) => ({ statut: r.statut, total: Number(r.total) }));
  essai.demandes = boutique.demandes().map((d) => d.motif);
  essai.commandes = boutique.commandes().length;
  essai.appels = enregistreur.appels;
  essai.outils = enregistreur.appels.flatMap((a) => a.rendu.filter((b) => b.type === "tool_use").map((b) => b.name!));
  essai.cout_dollars = arrondir(somme(enregistreur.appels.map((a) => a.cout_dollars)), 6);
  return essai;
}
