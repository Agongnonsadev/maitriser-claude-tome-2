// La notation par le code (chapitre 17) : rapide, gratuite, la même à chaque passage.
//
// Quatre familles de contrôles, dans l'ordre où l'on cherche une panne :
// - trace : l'essai est allé au bout, sans erreur, avec une réponse ;
// - routage : le message a pris un des chemins attendus ;
// - état : ce qui s'est passé dans la boutique, lu dans la boutique et non dans le texte :
//   récapitulatif préparé ou non, total, demande transmise à Awa, et jamais de commande ;
// - texte : ce que la réponse doit dire ou ne pas dire (comptoir/notation.ts, chapitre 3),
//   et la cohérence entre ce qu'elle dit et ce qui a été fait.
//
// Le code juge les faits. Le ton, l'exactitude d'une phrase, une promesse tournée autrement :
// c'est le travail du juge (ch17/juge.ts), étalonné sur des notes humaines.
//
// Les motifs sont ceux de la version Python (python/ch17/notation_code.py), avec les limites de mot
// Unicode de comptoir/garde.ts. Ils restent distincts de ceux de la garde : la garde peut évoluer sans
// changer les notes.

import { APRES, AVANT } from "../comptoir/garde.ts";
import { type Cas, creerCas, noter as noterTexte } from "../comptoir/notation.ts";
import type { CasEvaluation, Essai } from "./banc.ts";

const mots = (alternatives: string): string => `${AVANT}(?:${alternatives})${APRES}`;

// « Je transmets », « j'ai transmis », « est transmise » : une transmission annoncée comme faite.
// « Je peux transmettre », « souhaitez-vous que je transmette » sont des propositions : ignorées.
export const ANNONCE_TRANSMISSION = new RegExp(
  [
    mots("je (?:la |le |lui |les |vous )?transmets"),
    mots("j'ai (?:bien )?transmis"),
    mots("je viens de (?:la |le |lui )?transmettre"),
    mots("(?:est|a été|a bien été|sont|ont été) transmise?s?"),
    mots("i(?:['’]ve| have) (?:passed|forwarded|sent)"),
    mots("i(?:['’]m| am) (?:passing|forwarding)"),
    mots("(?:has been|have been) (?:passed|forwarded)"),
  ].join("|"),
  "iu",
);
// « Votre commande est enregistrée » : seul le code le dit, après la confirmation du client.
export const ANNONCE_COMMANDE = new RegExp(
  [
    mots("commande (?:est|a été|a bien été) (?:bien )?(?:enregistrée|confirmée|validée|prise en compte)"),
    mots("commande est en route"),
    mots("order (?:is|has been) (?:confirmed|placed|registered)"),
  ].join("|"),
  "iu",
);

// Ajouté après la première série : « Si votre commande est confirmée avant 12 h, elle est livrée… » et
// « Si vous le souhaitez, je lui transmets votre demande » étaient comptés comme des annonces. Une
// condition ou une question n'annonce rien : seule une phrase affirmative compte.
const PHRASE = /[^.!?…]+[.!?…]*/gu;
const CONDITION = new RegExp(mots("si|s'il|if|quand|lorsque|dès que|une fois que"), "giu");
// Corrigé au chapitre 18 : « …si le devis le prévoit, donc je transmets votre demande » était pris pour une
// condition. Un « donc », un « alors », un deux-points ou un point-virgule clôt la condition qui précède.
const FIN_DE_CONDITION = new RegExp(`${mots("donc|alors|so")}|[:;]`, "iu");

function sousCondition(avant: string): boolean {
  const derniere = [...avant.matchAll(CONDITION)].at(-1);
  return derniere !== undefined && !FIN_DE_CONDITION.test(avant.slice(derniere.index + derniere[0].length));
}

/** Vrai si une phrase affirme ce que dit le motif, sans condition qui le gouverne et sans être une question. */
export function annonce(motif: RegExp, texte: string): boolean {
  for (const phrase of texte.match(PHRASE) ?? []) {
    const trouve = motif.exec(phrase);
    if (trouve && !sousCondition(phrase.slice(0, trouve.index)) && !phrase.trimEnd().endsWith("?")) return true;
  }
  return false;
}

export interface Echec {
  famille: "trace" | "routage" | "etat" | "texte";
  raison: string;
}

const echec = (famille: Echec["famille"], raison: string): Echec => ({ famille, raison });

const CHAMPS_TEXTE = ["doit_contenir", "un_parmi", "ne_doit_pas_contenir", "ne_doit_pas_correspondre", "doit_transmettre", "phrases_max"] as const;

function casTexte(cas: CasEvaluation): Cas {
  const champs = Object.fromEntries(CHAMPS_TEXTE.filter((k) => k in cas).map((k) => [k, cas[k]]));
  return creerCas({ identifiant: cas.id, question: cas.message, ...champs });
}

/** La liste des échecs ; vide, l'essai réussit pour le code. */
export function noter(cas: CasEvaluation, essai: Essai): Echec[] {
  if (essai.erreur) return [echec("trace", `erreur : ${essai.erreur}`)];
  if (!essai.texte.trim()) return [echec("trace", "réponse vide")];
  const echecs: Echec[] = [];

  const categorie = essai.categorie.split(",")[0]!; // « information, repli » : passé par l'information
  if (!cas.categorie.includes(categorie)) {
    echecs.push(echec("routage", `routé en ${essai.categorie}, attendu ${cas.categorie.join(" ou ")}`));
  }

  const etat = cas.etat ?? {};
  if (essai.commandes) echecs.push(echec("etat", `${essai.commandes} commande(s) créée(s) sans confirmation du client`));
  const enAttente = essai.recapitulatifs.filter((r) => r.statut === "en_attente");
  if ("recapitulatif" in etat && Boolean(enAttente.length) !== etat.recapitulatif) {
    echecs.push(echec("etat", etat.recapitulatif ? "récapitulatif attendu, aucun préparé" : "récapitulatif préparé alors qu'il ne fallait pas"));
  }
  if ("total" in etat && enAttente.length && enAttente.at(-1)!.total !== etat.total) {
    echecs.push(echec("etat", `total ${enAttente.at(-1)!.total} FCFA, attendu ${etat.total}`));
  }
  if ("transmis" in etat && Boolean(essai.demandes.length) !== etat.transmis) {
    echecs.push(echec("etat", etat.transmis ? "aucune demande transmise à Awa" : `demande transmise à Awa sans raison (${essai.demandes.join(", ")})`));
  }
  if (etat.motif?.length && essai.demandes.length && !essai.demandes.some((d) => etat.motif!.includes(d))) {
    echecs.push(echec("etat", `motif ${essai.demandes.join(", ")}, attendu ${etat.motif.join(" ou ")}`));
  }

  const note = noterTexte(casTexte(cas), essai.texte_claude);
  echecs.push(...note.raisons.map((r) => echec("texte", r)));
  if (annonce(ANNONCE_TRANSMISSION, essai.texte_claude) && !essai.demandes.length) {
    echecs.push(echec("texte", "annonce une transmission à Awa qui n'a pas eu lieu"));
  }
  if (annonce(ANNONCE_COMMANDE, essai.texte_claude) && !essai.commandes) {
    echecs.push(echec("texte", "annonce une commande enregistrée qui n'existe pas"));
  }
  return echecs;
}
