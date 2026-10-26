// Ce que la version TypeScript imite de Python pour donner les mêmes résultats et les mêmes messages :
// repr() pour écrire une valeur, == pour comparer deux valeurs JSON, sum() pour additionner des nombres
// à virgule, json.dumps et json.loads, et les formats :g et repr d'un float. L'arrondi (round) est dans
// arrondi.ts.

import { unitesArrondies } from "./arrondi.ts";

/**
 * Un float de Python, là où son écriture compte : 2.0 s'écrit « 2.0 » en Python, « 2 » en JavaScript.
 * Il se calcule comme un nombre (Number(x), ou x.valeur) ; jsonPython et repr l'écrivent comme Python.
 */
export class Flottant {
  constructor(readonly valeur: number) {}

  valueOf(): number {
    return this.valeur;
  }

  toString(): string {
    return flottant(this.valeur);
  }
}

/** Un nombre lu dans un fichier JSON ou calculé : sa valeur, qu'il soit un Flottant ou non. */
export const nombre = (x: unknown): number => Number(x);

/**
 * Un nombre écrit comme repr(float) en Python : les mêmes chiffres que JavaScript (le plus court qui
 * relise le même nombre), mais « 0.0 » pour zéro, « 5.0 » pour un entier, et la notation scientifique
 * sous 0,0001 (« 1e-05 ») ou à partir de 10^16 (« 1e+16 »).
 */
export function flottant(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantisse, puissance] = x.toExponential().split("e") as [string, string];
  const exposant = Number(puissance);
  if (exposant < -4 || exposant >= 16) return `${mantisse}e${exposant < 0 ? "-" : "+"}${String(Math.abs(exposant)).padStart(2, "0")}`;
  const texte = String(x);
  return texte.includes(".") ? texte : `${texte}.0`;
}

/**
 * f"{x:g}" en Python : six chiffres significatifs au plus, sans zéros inutiles (2.0 -> « 2 », 2.5 ->
 * « 2.5 »), la notation scientifique sous 0,0001 ou à partir d'un million. L'arrondi est celui de
 * Python (la moitié au pair, sur la valeur exacte) tant que le nombre s'écrit sans exposant.
 */
export function formatG(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  // Six chiffres significatifs, arrondis sur la valeur exacte ; l'exposant se lit après l'arrondi, comme
  // en Python : 999 999,5 s'écrit « 1e+06 », 1 234 565 « 1.23456e+06 » (la moitié au pair).
  let exposant = Number(x.toExponential(5).split("e")[1]);
  let chiffres = unitesArrondies(x, 5 - exposant);
  if (chiffres >= 1_000_000n) chiffres = unitesArrondies(x, 5 - ++exposant);
  else if (chiffres < 100_000n) chiffres = unitesArrondies(x, 5 - --exposant);
  const signe = x < 0 ? "-" : "";
  const sansZeros = (t: string): string => (t.includes(".") ? t.replace(/\.?0+$/, "") : t);
  if (exposant >= -4 && exposant < 6) {
    const decimales = 5 - exposant;
    const texte = chiffres.toString().padStart(decimales + 1, "0");
    return signe + sansZeros(decimales ? `${texte.slice(0, -decimales)}.${texte.slice(-decimales)}` : texte);
  }
  const texte = chiffres.toString();
  return `${signe}${sansZeros(`${texte[0]}.${texte.slice(1)}`)}e${exposant < 0 ? "-" : "+"}${String(Math.abs(exposant)).padStart(2, "0")}`;
}

/** Une valeur écrite comme Python l'écrit (repr) : None, True, 'texte', 2.0, [1, 2], {'clé': 'valeur'}. */
export function repr(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v instanceof Flottant) return flottant(v.valeur);
  if (typeof v === "string") {
    // Des guillemets doubles quand le texte contient une apostrophe (« Sirop d'hibiscus »), simples sinon.
    const guillemet = v.includes("'") && !v.includes('"') ? '"' : "'";
    const corps = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return guillemet + (guillemet === "'" ? corps.replace(/'/g, "\\'") : corps) + guillemet;
  }
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(", ")}}`;
  return String(v);
}

/** str() de Python : le texte tel quel, le reste comme repr (un float : « 2.0 »). */
export const str = (v: unknown): string => (typeof v === "string" ? v : repr(v));

/** L'égalité de deux valeurs JSON, comme == en Python : mêmes clés, mêmes valeurs, dans n'importe quel ordre. */
export function egaux(a: unknown, b: unknown): boolean {
  if (a instanceof Flottant || b instanceof Flottant) return Number(a) === Number(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ca = Object.keys(a);
  const cb = Object.keys(b);
  return ca.length === cb.length && ca.every((k) => Object.hasOwn(b, k) && egaux((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** sum() de Python sur des nombres à virgule : une somme compensée (Neumaier), depuis Python 3.12. */
export function somme(valeurs: Iterable<number>): number {
  let haut = 0;
  let bas = 0;
  for (const x of valeurs) {
    const t = haut + x;
    bas += Math.abs(haut) >= Math.abs(x) ? haut - t + x : x - t + haut;
    haut = t;
  }
  return bas && Number.isFinite(bas) ? haut + bas : haut;
}

/** Les blancs de str.split() en Python (str.isspace) : un peu plus que le \s de JavaScript, sans le BOM. */
export const BLANCS = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** texte.split() en Python : les mots, séparés par des blancs. */
export const separerMots = (texte: string): string[] => texte.split(BLANCS).filter(Boolean);

type Contexte = { source?: string };

/** json.loads de Python : un nombre écrit avec une virgule ou un exposant (« 2.0 », « 1e3 ») reste un Flottant. */
export const lireJsonPython = (texte: string): unknown =>
  JSON.parse(texte, (_cle, valeur: unknown, contexte?: Contexte) =>
    typeof valeur === "number" && /[.eE]/.test(contexte?.source ?? "") ? new Flottant(valeur) : valeur,
  );

/**
 * json.dumps(valeur, ensure_ascii=False) de Python, et avec indent : « , » et « : » suivis d'une espace,
 * ou une valeur par ligne ; un Flottant s'écrit « 2.0 ». Un résultat d'outil est le même texte, donc le
 * même nombre de tokens, dans les deux versions.
 */
export function jsonPython(valeur: unknown, indent: number | null = null, niveau = 0): string {
  if (valeur instanceof Flottant) {
    const v = valeur.valeur;
    return Number.isNaN(v) ? "NaN" : Number.isFinite(v) ? flottant(v) : v > 0 ? "Infinity" : "-Infinity";
  }
  const entrees: [string | null, unknown][] | null = Array.isArray(valeur)
    ? valeur.map((v) => [null, v])
    : valeur !== null && typeof valeur === "object"
      ? Object.entries(valeur)
      : null;
  if (entrees === null) return JSON.stringify(valeur ?? null);
  const [ouvre, ferme] = Array.isArray(valeur) ? ["[", "]"] : ["{", "}"];
  if (!entrees.length) return ouvre + ferme;
  const element = ([cle, v]: [string | null, unknown]): string =>
    (cle === null ? "" : `${JSON.stringify(cle)}: `) + jsonPython(v, indent, niveau + 1);
  if (indent === null) return ouvre + entrees.map(element).join(", ") + ferme;
  const marge = "\n" + " ".repeat(indent * (niveau + 1));
  return ouvre + marge + entrees.map(element).join("," + marge) + "\n" + " ".repeat(indent * niveau) + ferme;
}

/** x = mantisse × 2^exposant, exactement, lu dans les 64 bits du nombre (x fini). */
function decomposer(x: number): [bigint, number] {
  const vue = new DataView(new ArrayBuffer(8));
  vue.setFloat64(0, x);
  const bits = vue.getBigUint64(0);
  const brut = Number((bits >> 52n) & 0x7ffn);
  const mantisse = brut ? (bits & 0xfffffffffffffn) | (1n << 52n) : bits & 0xfffffffffffffn;
  return [bits >> 63n ? -mantisse : mantisse, brut ? brut - 1075 : -1074];
}

const nombreDeBits = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);

/**
 * p / q × 2^exposant, arrondi une seule fois au nombre le plus proche (la moitié au pair) : la division de
 * deux entiers de Python (int / int), exacte puis arrondie, quand Number(p) / Number(q) arrondirait deux fois.
 */
export function diviserExactement(p: bigint, q: bigint, exposant = 0): number {
  if (q === 0n) throw new RangeError("division par zéro");
  if (p === 0n) return 0;
  const negatif = p < 0n !== q < 0n;
  let num = p < 0n ? -p : p;
  let den = q < 0n ? -q : q;
  // Un quotient d'au moins 55 bits : 53 à garder, un pour l'arrondi, le reste dit s'il y a un écart.
  const decalage = 55 - (nombreDeBits(num) - nombreDeBits(den));
  if (decalage > 0) num <<= BigInt(decalage);
  else den <<= BigInt(-decalage);
  const quotient = num / den;
  const exact = num % den === 0n;
  let puissance = exposant - decalage;
  let enTrop = nombreDeBits(quotient) - 53;
  if (puissance + enTrop < -1074) enTrop = -1074 - puissance; // un nombre sous-normal garde moins de bits
  let garde = quotient >> BigInt(enTrop);
  const reste = quotient & ((1n << BigInt(enTrop)) - 1n);
  const moitie = 1n << BigInt(enTrop - 1);
  if (reste > moitie || (reste === moitie && (!exact || garde % 2n === 1n))) garde += 1n;
  puissance += enTrop;
  // garde × 2^puissance est représentable : deux multiplications exactes, sans dépasser ni s'annuler en route.
  const moitiePuissance = Math.trunc(puissance / 2);
  const resultat = Number(garde) * 2 ** moitiePuissance * 2 ** (puissance - moitiePuissance);
  return negatif ? -resultat : resultat;
}

/**
 * statistics.mean de Python : la somme exacte des nombres, divisée par leur nombre, arrondie une seule fois.
 * La somme de JavaScript arrondit à chaque addition : la moyenne peut alors différer au dernier chiffre, et
 * l'arrondi qui suit (round(…, 5)) tomber de l'autre côté.
 */
export function moyenne(valeurs: readonly number[]): number {
  if (!valeurs.length) throw new RangeError("moyenne d'une liste vide");
  const parties = valeurs.filter((x) => x !== 0).map(decomposer);
  if (!parties.length) return 0;
  const plusPetit = Math.min(...parties.map(([, e]) => e));
  let total = 0n;
  for (const [m, e] of parties) total += m << BigInt(e - plusPetit);
  return diviserExactement(total, BigInt(valeurs.length), plusPetit);
}

/** statistics.median de Python : la valeur du milieu, ou la moyenne des deux du milieu. */
export function mediane(valeurs: readonly number[]): number {
  if (!valeurs.length) throw new RangeError("médiane d'une liste vide");
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries[milieu]! : (tries[milieu - 1]! + tries[milieu]!) / 2;
}
