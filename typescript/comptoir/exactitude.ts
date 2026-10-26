// Mesurer l'exactitude d'un extracteur, champ par champ, en classant les erreurs (chapitre 7).
//
// Quatre issues pour un champ attendu :
// - « juste » : la bonne valeur ;
// - « manquée » : null alors qu'une valeur était lisible. Gênant, mais visible : Yao vérifie ;
// - « inventée » : une valeur alors qu'on attendait null (illisible ou absent). La plus grave : elle
//   ne se voit pas ;
// - « erronée » : une autre valeur que la bonne. Grave aussi, sauf si un contrôle la rattrape.

// Les champs comparés. Le texte libre (remarques, libellés) n'est pas noté par le code : il se relit.
export const CHAMPS_BON = ["client", "quartier", "total_lu"];
export const CHAMPS_LIGNE_BON = ["produit", "quantite", "prix_unitaire_lu"];
export const CHAMPS_FACTURE = ["fournisseur", "numero", "total_lu", "devise"];
export const CHAMPS_LIGNE_FACTURE = ["quantite", "prix_unitaire", "montant"];

export type Issue = "juste" | "manquée" | "inventée" | "erronée";
type Valeur = unknown;
type Document = Record<string, unknown> & { lignes?: Record<string, unknown>[] };

/** Casse, accents et espaces en trop ignorés, comme casefold() et NFKD en Python. */
function normaliser(valeur: Valeur): Valeur {
  if (typeof valeur !== "string") return valeur;
  return valeur.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/\s+/).filter(Boolean).join(" ");
}

const egal = (a: Valeur, b: Valeur): boolean => {
  const [x, y] = [normaliser(a), normaliser(b)];
  return x === y || (typeof x === "object" && x !== null && JSON.stringify(x) === JSON.stringify(y));
};

export class Ecart {
  constructor(
    readonly document: string,
    readonly champ: string,
    readonly attendu: Valeur,
    readonly obtenu: Valeur,
  ) {}

  get issue(): Issue {
    if (egal(this.attendu, this.obtenu)) return "juste";
    if (this.obtenu === null || this.obtenu === undefined) return "manquée";
    if (this.attendu === null || this.attendu === undefined) return "inventée";
    return "erronée";
  }
}

const valeur = (objet: Record<string, unknown> | undefined, champ: string): Valeur => objet?.[champ] ?? null;

/** Un écart par champ attendu. Une extraction en échec (obtenu null) manque tout. */
export function comparer(document: string, attendu: Document, obtenu: Document | null, facture = false): Ecart[] {
  const lu: Document = obtenu ?? {};
  const [champs, champsLigne] = facture ? [CHAMPS_FACTURE, CHAMPS_LIGNE_FACTURE] : [CHAMPS_BON, CHAMPS_LIGNE_BON];
  const ecarts = champs.map((c) => new Ecart(document, c, valeur(attendu, c), valeur(lu, c)));
  const lignesAttendues = attendu.lignes ?? [];
  const lignesObtenues = lu.lignes ?? [];
  lignesAttendues.forEach((ligne, rang) => {
    const lue = lignesObtenues[rang] ?? {};
    for (const c of champsLigne) ecarts.push(new Ecart(document, `lignes.${rang}.${c}`, valeur(ligne, c), valeur(lue, c)));
  });
  // Une ligne lue en trop est une ligne inventée.
  for (let rang = lignesAttendues.length; rang < lignesObtenues.length; rang++) {
    ecarts.push(new Ecart(document, `lignes.${rang}`, null, lignesObtenues[rang]));
  }
  return ecarts;
}

export interface Resume {
  champs: number;
  exactitude: number;
  juste: number;
  manquée: number;
  inventée: number;
  erronée: number;
}

export function resumer(ecarts: Ecart[]): Resume {
  const compte = (issue: Issue) => ecarts.filter((e) => e.issue === issue).length;
  const total = ecarts.length;
  return {
    champs: total,
    exactitude: total ? compte("juste") / total : 0,
    juste: compte("juste"),
    manquée: compte("manquée"),
    inventée: compte("inventée"),
    erronée: compte("erronée"),
  };
}
