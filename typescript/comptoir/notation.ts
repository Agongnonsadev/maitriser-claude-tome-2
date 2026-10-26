// Noter une réponse du Comptoir avec des critères écrits à l'avance (chapitre 3).
//
// Chaque cas dit ce que la réponse doit contenir, ce qu'elle ne doit pas contenir, et si elle doit
// proposer de transmettre la demande à Awa. Ce que le code ne sait pas juger est signalé pour une
// relecture humaine. Le chapitre 17 ira beaucoup plus loin.

// Espaces qu'on trouve entre les chiffres : normale, insécable, fine insécable.
const ESPACES_ENTRE_CHIFFRES = /(?<=\d)[   ](?=\d)/g;
const FIN_DE_PHRASE = /[.!?…]+(?=\s|$)/g;
// « Bonjour ! », « Bonsoir Madame ! », « Hello! » en tête de réponse : une politesse, pas une phrase.
// Ajouté au chapitre 5 : l'exemple du prompt v1 commence lui-même par « Bonjour ! ».
const SALUTATION = /^(bonjour|bonsoir|hello|hi|good (morning|afternoon|evening))\b[^.!?…]{0,25}[.!]\s+/i;

/** Minuscules, apostrophes droites, « 2 500 » et « 2500 » écrits pareil. */
export function normaliser(texte: string): string {
  return texte.normalize("NFC").toLowerCase().replaceAll("’", "'").replace(ESPACES_ENTRE_CHIFFRES, "");
}

export function compterPhrases(texte: string): number {
  const reste = texte.trim().replace(SALUTATION, "").trim();
  return reste ? Math.max(1, reste.match(FIN_DE_PHRASE)?.length ?? 0) : 0;
}

/**
 * Un cas d'évaluation. Les noms des champs sont ceux des fichiers de cas (ch03/cas.json), partagés avec
 * la version Python.
 */
export interface Cas {
  identifiant: string;
  question: string;
  doit_contenir: string[]; //              tous obligatoires
  un_parmi: string[]; //                   au moins un
  ne_doit_pas_contenir: string[];
  ne_doit_pas_correspondre: string[]; //   expressions régulières
  doit_transmettre: boolean;
  phrases_max: number;
  a_relire: string; //                     ce qu'un humain doit vérifier, si le code ne peut pas le juger
}

/** Un cas complété de ses valeurs par défaut, depuis un objet lu dans un fichier de cas. */
export function creerCas(d: Pick<Cas, "identifiant" | "question"> & Partial<Cas>): Cas {
  return {
    doit_contenir: [],
    un_parmi: [],
    ne_doit_pas_contenir: [],
    ne_doit_pas_correspondre: [],
    doit_transmettre: false,
    phrases_max: 3,
    a_relire: "",
    ...d,
  };
}

export interface Note {
  reussi: boolean;
  raisons: string[];
  aRelire: string;
}

export const MOTS_DE_TRANSMISSION = ["awa", "transmet", "transmettre", "transmis"];

export function noter(cas: Cas, reponse: string): Note {
  const texte = normaliser(reponse);
  const raisons: string[] = [];

  for (const attendu of cas.doit_contenir) {
    if (!texte.includes(normaliser(attendu))) raisons.push(`manque « ${attendu} »`);
  }
  if (cas.un_parmi.length && !cas.un_parmi.some((a) => texte.includes(normaliser(a)))) {
    raisons.push(`aucun de : ${cas.un_parmi.join(", ")}`);
  }
  for (const interdit of cas.ne_doit_pas_contenir) {
    if (texte.includes(normaliser(interdit))) raisons.push(`contient « ${interdit} »`);
  }
  for (const motif of cas.ne_doit_pas_correspondre) {
    if (new RegExp(motif).test(texte)) raisons.push(`correspond à ${motif}`);
  }
  if (cas.doit_transmettre && !MOTS_DE_TRANSMISSION.some((m) => texte.includes(m))) {
    raisons.push("ne propose pas de transmettre à Awa");
  }
  if (compterPhrases(reponse) > cas.phrases_max) raisons.push(`plus de ${cas.phrases_max} phrases`);

  return { reussi: raisons.length === 0, raisons, aRelire: cas.a_relire };
}
