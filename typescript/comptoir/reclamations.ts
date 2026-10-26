// La chaîne des réclamations : extraire, vérifier, rédiger, évaluer, transmettre (chapitre 12).
//
// Un enchaînement fixe, écrit dans le code, où chaque appel a une tâche simple :
// 1. extraire les faits, avec Claude Haiku 5.5 et une sortie structurée ;
// 2. vérifier par le code ce qui manque (le « point de contrôle » entre deux étapes) ;
// 3. transmettre la fiche à Awa, avant tout le reste : si la suite échoue, Awa a la réclamation. Aucune
//    réclamation n'est réglée sans elle ;
// 4. rédiger la réponse au client, avec Claude Sonnet 5.5 ;
// 5. évaluer cette réponse : le code cherche les mots qui promettent, Claude Haiku 5.5 relit les règles ;
//    une réponse refusée est réécrite une fois, avec la critique, puis remplacée par un texte fixe si
//    elle échoue encore (évaluateur et optimiseur).
//
// Chaque étape peut échouer : une sortie coupée par max_tokens, un JSON illisible. Le code le voit et
// prend le relais ; la réclamation part chez Awa dans tous les cas. Le prompt de rédaction est celui de
// la version Python (python/comptoir/prompts/reclamation_v1.md).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Boutique } from "./boutique.ts";
import { type ClientMessages, texteDe } from "./client.ts";
import { config } from "./config.ts";
import { cout } from "./couts.ts";
import { APRES, AVANT } from "./garde.ts";
import { noter } from "./journal.ts";
import { PYTHON } from "./lancement.ts";
import { chargerDonnees, messageClient } from "./prompt.ts";
import { Trace } from "./trace.ts";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export const MODELE_AUXILIAIRE = config.MODELE_AUXILIAIRE; // extraction et évaluation (chapitre 12)
export const PROMPT_REPONSE = readFileSync(join(PYTHON, "comptoir", "prompts", "reclamation_v1.md"), "utf8").replace(/\r\n?/g, "\n").trim();
export const PROBLEMES = ["abime", "tiede", "erreur", "manquant", "retard", "livreur", "sante", "autre"];

const NULLABLE = { anyOf: [{ type: "string" }, { type: "null" }] };
// Le produit vient du catalogue ou n'est pas connu. En texte libre, l'extraction écrivait « bouteilles »,
// et le point de contrôle croyait le produit connu : la relecture humaine l'a vu, pas les tests.
export const PRODUITS = chargerDonnees().produits.map((p) => p.nom);
const PRODUIT = { anyOf: [{ type: "string", enum: PRODUITS }, { type: "null" }] };

export const SCHEMA_FAITS = {
  type: "object",
  properties: {
    probleme: { type: "string", enum: PROBLEMES },
    produit: PRODUIT,
    quand: NULLABLE, //             tel que le client l'écrit : « hier », « ce matin »
    demande_du_client: NULLABLE,
    urgence: { type: "boolean" }, // santé ou sécurité : Awa est prévenue en premier
    resume: { type: "string" },
  },
  required: ["probleme", "produit", "quand", "demande_du_client", "urgence", "resume"],
  additionalProperties: false,
};

// La critique d'abord : la réponse suit l'ordre du schéma, et une case cochée avant d'avoir écrit l'avis
// se trompe. Cases d'abord, une réponse conforme a été refusée 10 fois sur 10 ; critique d'abord, 0 fois
// sur 10, et une vraie promesse reste refusée 10 fois sur 10 (mesuré au chapitre 12).
export const SCHEMA_EVALUATION = {
  type: "object",
  properties: {
    critique: { type: "string" },
    s_excuse: { type: "boolean" },
    annonce_la_transmission_a_awa: { type: "boolean" },
    promet_quelque_chose: { type: "boolean" },
    donne_un_conseil_medical: { type: "boolean" },
  },
  required: ["critique", "s_excuse", "annonce_la_transmission_a_awa", "promet_quelque_chose", "donne_un_conseil_medical"],
  additionalProperties: false,
};

export const SYSTEME_EVALUATION =
  "Tu relis la réponse du Comptoir de Délices d'Awa à un client qui se plaint. Tu vérifies quatre points, sans " +
  "rien réécrire : la réponse s'excuse ; elle annonce que la réclamation est transmise à Awa ; elle ne promet rien " +
  "(ni remboursement, ni remplacement, ni avoir, ni cadeau, ni délai autre que 24 heures) ; elle ne donne aucun " +
  "conseil médical (inviter à consulter un professionnel est permis). La critique dit en une phrase ce qu'il faut " +
  "corriger, ou « rien ».";

// Ce que le code refuse de lui-même, sans demander à un modèle. « avoir » seul ne suffit pas : c'est aussi
// un verbe (« après avoir bu »), et la première version de ce motif l'a pris pour une promesse. Les limites
// de mot sont celles de Python (AVANT, APRES), qui suivent les lettres accentuées.
export const PROMESSES = new RegExp(
  `${AVANT}rembours|${AVANT}remplac(er|era|erons|ement)|${AVANT}(un|votre|d'un) avoir${APRES}|${AVANT}gratuit|${AVANT}offert|` +
    `${AVANT}geste commercial|${AVANT}cadeau|${AVANT}dédommag|${AVANT}compens`,
  "iu",
);

export const REPLI = "Nous sommes désolés pour ce désagrément. Votre réclamation est transmise à Awa, qui vous répondra sous 24 heures.";
export const REPLI_SANTE = " Si un malaise persiste, consultez un professionnel de santé.";

// Réflexion comprise : à 400, 3 rédactions sur 35 ont été coupées, dont une vide (mesuré au chapitre 12).
export const MAX_TOKENS_REDACTION = 1000;
export const EFFORT_REDACTION = config.EFFORT_REDACTION as Effort | null; // low : la mesure est dans comptoir/config.py

export interface Faits {
  probleme: string;
  produit: string | null;
  quand: string | null;
  demande_du_client: string | null;
  urgence: boolean;
  resume: string;
}

export const FAITS_INCONNUS: Faits = {
  probleme: "autre",
  produit: null,
  quand: null,
  demande_du_client: null,
  urgence: false,
  resume: "Extraction impossible : la réclamation est à lire dans la conversation.",
};

export interface ResultatReclamation {
  reponse: string;
  faits: Faits;
  manques: string[];
  tentatives: number;
  repli: boolean;
  demande: string | null; //  l'identifiant de la demande enregistrée pour Awa
  critiques: string[];
  versions: string[]; //      chaque rédaction, gardée pour la relecture
}

/** null si la sortie est coupée ou illisible. Le coût, lui, est payé : il est rendu quand même. */
async function structure(
  client: ClientMessages,
  modele: string,
  system: string,
  contenu: string,
  schema: Record<string, unknown>,
  etiquette: string,
): Promise<[Record<string, unknown> | null, number]> {
  const reponse = await client.messages.create({
    model: modele,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: contenu }],
    output_config: { format: { type: "json_schema", schema } },
  });
  const prix = cout(modele, reponse.usage);
  noter(reponse._request_id, modele, prix, { prompt: etiquette, stop_reason: reponse.stop_reason });
  if (reponse.stop_reason !== "end_turn") return [null, prix.dollars];
  try {
    return [JSON.parse(texteDe(reponse)) as Record<string, unknown>, prix.dollars];
  } catch (erreur) {
    if (erreur instanceof SyntaxError) return [null, prix.dollars];
    throw erreur;
  }
}

/**
 * La casse d'une valeur d'enum n'est pas garantie (documentation des sorties structurées) : « Jus De
 * Gingembre » redevient « Jus de gingembre ».
 */
export function normaliser(faits: Record<string, unknown>): Faits {
  const catalogue = new Map(PRODUITS.map((p) => [p.toLowerCase(), p]));
  const probleme = String(faits.probleme || "autre").toLowerCase();
  const produit = faits.produit ? (catalogue.get(String(faits.produit).toLowerCase()) ?? null) : null;
  return { ...(faits as unknown as Faits), probleme: PROBLEMES.includes(probleme) ? probleme : "autre", produit };
}

export async function extraire(client: ClientMessages, message: string): Promise<[Faits, number]> {
  const system =
    "Tu lis la réclamation d'un client de Délices d'Awa et tu en extrais les faits, sans rien ajouter. " +
    "Si une information n'est pas écrite, mets null : produit est le produit du catalogue que le client " +
    "nomme, ou null s'il ne le nomme pas. urgence vaut true seulement pour un problème de " +
    "santé ou de sécurité. Le résumé tient en une phrase neutre, pour Awa.";
  const [faits, prix] = await structure(client, MODELE_AUXILIAIRE, system, messageClient(message), SCHEMA_FAITS, "reclamation-faits");
  // Sans faits, la chaîne continue : le point de contrôle demandera tout, et Awa lira la conversation.
  return [faits ? normaliser(faits) : { ...FAITS_INCONNUS }, prix];
}

/** Le point de contrôle : ce que le code vérifie, sans modèle. */
export function manques(faits: Faits): string[] {
  const aDemander: string[] = [];
  if (!faits.produit && faits.probleme !== "retard" && faits.probleme !== "livreur") aDemander.push("le produit concerné");
  if (!faits.quand) aDemander.push("le jour de la livraison");
  return aDemander;
}

/** Le texte, son coût et la raison de l'arrêt : un texte arrêté par max_tokens est incomplet. */
export async function rediger(
  client: ClientMessages,
  message: string,
  aDemander: string[],
  critique: string | null = null,
  effort: Effort | null = EFFORT_REDACTION,
): Promise<[string, number, string | null]> {
  const contenu =
    `${messageClient(message)}\n\n<a_demander>${aDemander.join(", ")}</a_demander>` +
    (critique ? `\n\n<critique>Ta réponse précédente a été refusée : ${critique} Réécris-la.</critique>` : "");
  const requete: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODELE,
    max_tokens: MAX_TOKENS_REDACTION,
    system: PROMPT_REPONSE,
    messages: [{ role: "user", content: contenu }],
  };
  if (effort) requete.output_config = { effort };
  const reponse = await client.messages.create(requete);
  const prix = cout(config.MODELE, reponse.usage);
  noter(reponse._request_id, config.MODELE, prix, { prompt: "reclamation-v1", stop_reason: reponse.stop_reason });
  return [texteDe(reponse).trim(), prix.dollars, reponse.stop_reason];
}

/** Les problèmes de la réponse ; une liste vide si elle respecte les règles. */
export async function evaluer(client: ClientMessages, reponse: string): Promise<[string[], number]> {
  const promesse = PROMESSES.exec(reponse);
  const problemes = promesse ? [`promesse interdite : « ${promesse[0]} »`] : [];
  const [jugement, prix] = await structure(client, MODELE_AUXILIAIRE, SYSTEME_EVALUATION, `<reponse>${reponse}</reponse>`, SCHEMA_EVALUATION, "reclamation-evaluation");
  if (jugement === null) return [[...problemes, "évaluation impossible"], prix]; // une réponse non relue n'est pas envoyée
  if (!jugement.s_excuse) problemes.push("pas d'excuses");
  if (!jugement.annonce_la_transmission_a_awa) problemes.push("la transmission à Awa n'est pas annoncée");
  if (jugement.promet_quelque_chose) problemes.push(`promesse : ${jugement.critique}`);
  if (jugement.donne_un_conseil_medical) problemes.push(`conseil médical : ${jugement.critique}`);
  return [problemes, prix];
}

export interface OptionsTraitement {
  trace?: Trace | null;
  tentativesMax?: number;
  effort?: Effort | null;
}

export async function traiter(
  client: ClientMessages,
  message: string,
  boutique: Boutique,
  conversation: string,
  { trace = null, tentativesMax = 2, effort = EFFORT_REDACTION }: OptionsTraitement = {},
): Promise<ResultatReclamation> {
  const t = trace ?? new Trace();
  const faits = await t.etape("extraction", MODELE_AUXILIAIRE, async (e) => {
    const [f, prix] = await extraire(client, message);
    e.noter(prix, `${f.probleme}${f.urgence ? ", urgence" : ""}`);
    return f;
  });
  const aDemander = await t.etape("verification", "code", (e) => {
    const liste = manques(faits);
    e.noter(0, `à demander : ${liste.length}`);
    return liste;
  });
  const demande = await t.etape("transmission", "code", (e) => {
    const motif = faits.urgence ? "reclamation-urgente" : "reclamation";
    const identifiant = boutique.transmettre(conversation, motif, faits.resume).demande;
    e.noter(0, identifiant);
    return identifiant;
  });
  const critiques: string[] = [];
  const versions: string[] = [];
  let reponse: string | null = null;
  let repli = false;
  let aCorriger: string | null = null;
  let tentative = 0;
  while (tentative < tentativesMax) {
    tentative++;
    const [texte, arret] = await t.etape("redaction", config.MODELE, async (e) => {
      const [ecrit, prix, raison] = await rediger(client, message, aDemander, aCorriger, effort);
      versions.push(ecrit);
      e.noter(prix, `version ${tentative}` + (raison === "end_turn" ? "" : `, arrêtée par ${raison}`));
      return [ecrit, raison] as const;
    });
    if (arret !== "end_turn") {
      // Le code voit seul qu'un texte est coupé : inutile de payer l'évaluateur. On réécrit sans critique :
      // le texte n'était pas fautif, seulement incomplet.
      critiques.push(`réponse arrêtée par ${arret}`);
      aCorriger = null;
      continue;
    }
    const problemes = await t.etape("evaluation", MODELE_AUXILIAIRE, async (e) => {
      const [liste, prix] = await evaluer(client, texte);
      e.noter(prix, liste.length ? `refusée (${liste.length})` : "conforme");
      return liste;
    });
    if (!problemes.length) {
      reponse = texte;
      break;
    }
    aCorriger = problemes.join(" ; ");
    critiques.push(aCorriger);
  }
  if (reponse === null) {
    // Le code a le dernier mot : un texte fixe, sans promesse, avec le conseil de santé si besoin.
    reponse = REPLI + (faits.urgence ? REPLI_SANTE : "");
    repli = true;
  }
  return { reponse, faits, manques: aDemander, tentatives: tentative, repli, demande, critiques, versions };
}
