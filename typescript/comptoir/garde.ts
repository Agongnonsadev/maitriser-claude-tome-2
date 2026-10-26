// Les gardes du Comptoir (chapitre 18) : ce que le code vérifie lui-même, quoi qu'écrive le modèle.
//
// - Ce qu'une réponse annonce, contre ce qui a été fait : l'assistant documentaire n'a aucun outil ; s'il
//   écrit « je transmets votre demande à Awa », c'est une promesse que personne ne tiendra.
// - Les champs écrits par le client et gardés par la boutique, le nom et le quartier : ils finissent dans
//   l'application Claude d'Awa, par le serveur MCP du chapitre 15. Un texte libre y deviendrait une
//   injection indirecte. Ce sont des données courtes ; le code refuse tout le reste, avant d'enregistrer.
//
// Les motifs sont ceux de la version Python (python/comptoir/garde.py). Le \b de JavaScript ne connaît que
// les lettres sans accent : les limites de mot s'écrivent ici avec les classes Unicode, comme en Python.

export const AVANT = "(?<![\\p{L}\\p{N}_])"; // une limite de mot, devant (le \b de Python)
export const APRES = "(?![\\p{L}\\p{N}_])"; //   et derrière
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
const PHRASE = /[^.!?…]+[.!?…]*/gu;
const CONDITION = new RegExp(mots("si|s'il|if|quand|lorsque|dès que|une fois que"), "giu");
// Ce qui clôt une condition : « si le devis le prévoit, donc je transmets » est une annonce.
const FIN_DE_CONDITION = new RegExp(`${mots("donc|alors|so")}|[:;]`, "iu");

/**
 * Vrai si une condition gouverne ce qui suit : un « si » sans « donc », « alors », deux-points ni
 * point-virgule entre lui et la suite. « Si vous le souhaitez, je lui transmets » reste une proposition.
 */
export function sousCondition(avant: string): boolean {
  const conditions = [...avant.matchAll(CONDITION)];
  const derniere = conditions.at(-1);
  return derniere !== undefined && !FIN_DE_CONDITION.test(avant.slice(derniere.index + derniere[0].length));
}

/** Vrai si une phrase affirme une transmission, sans condition qui la gouverne et sans être une question. */
export function annonceUneTransmission(texte: string): boolean {
  for (const phrase of texte.replaceAll("’", "'").match(PHRASE) ?? []) {
    const trouve = ANNONCE_TRANSMISSION.exec(phrase);
    if (trouve && !sousCondition(phrase.slice(0, trouve.index)) && !phrase.trimEnd().endsWith("?")) return true;
  }
  return false;
}

// --- Les champs du client -------------------------------------------------------------------

export const LONGUEUR_MAX_NOM = 60;
export const LONGUEUR_MAX_QUARTIER = 40;
// Des lettres (accents compris), séparées par une espace, un tiret, une apostrophe ou un point :
// « Larissa Noudéhou », « Mme Akpovi », « Jean-Marc », « N'Dah ». Ni chiffre, ni deux-points, ni crochet.
const NOM = /^\p{L}+(?:[ '’.-]+\p{L}+)*\.?$/u;
// Un quartier peut porter un numéro (« Zone 4 », « PK 10 ») : lettres et chiffres, mêmes séparateurs.
const QUARTIER = /^[\p{L}\p{N}]+(?:[ '’.-]+[\p{L}\p{N}]+)*$/u;
const MOTS_MAX = 6;

function probleme(valeur: string, motif: RegExp, longueurMax: number, quoi: string): string | null {
  const v = valeur.trim();
  if (!v) return `${quoi} est vide`;
  const longueur = [...v].length; // en caractères, comme len() en Python
  if (longueur > longueurMax || v.split(/\s+/).length > MOTS_MAX) return `${quoi} est trop long (${longueur} caractères)`;
  if (!motif.test(v)) return `${quoi} contient autre chose que des lettres${motif === QUARTIER ? " et des chiffres" : ""}`;
  return null;
}

/** null si le nom est acceptable ; sinon, ce qui ne va pas, pour le dire à Claude. */
export function problemeDeNom(nom: string): string | null {
  return probleme(nom, NOM, LONGUEUR_MAX_NOM, "le nom");
}

export function problemeDeQuartier(quartier: string): string | null {
  return probleme(quartier, QUARTIER, LONGUEUR_MAX_QUARTIER, "le quartier");
}
