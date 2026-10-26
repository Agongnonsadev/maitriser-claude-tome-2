// L'arrondi de Python : au plus proche, la moitié vers le pair (round(2.5) vaut 2). Math.round de
// JavaScript arrondit la moitié vers le haut ; les calculs qui doivent donner les mêmes résultats que la
// version Python (taille d'image vue par Claude, centiles du tableau de bord, colonnes des fichiers de
// résultats) passent donc par ici.

/**
 * |x| arrondi à 10^-decimales près, la moitié au pair, sur la valeur exacte du nombre en binaire : le
 * nombre d'unités de 10^-decimales (decimales peut être négatif : des dizaines, des centaines…).
 */
export function unitesArrondies(x: number, decimales: number): bigint {
  // |x| = mantisse × 2^exposant, exactement, lu dans les 64 bits du nombre.
  const vue = new DataView(new ArrayBuffer(8));
  vue.setFloat64(0, x);
  const bits = vue.getBigUint64(0);
  const brut = Number((bits >> 52n) & 0x7ffn);
  const mantisse = brut ? (bits & 0xfffffffffffffn) | (1n << 52n) : bits & 0xfffffffffffffn;
  const exposant = brut ? brut - 1075 : -1074;
  let numerateur = exposant >= 0 ? mantisse << BigInt(exposant) : mantisse;
  let denominateur = exposant >= 0 ? 1n : 1n << BigInt(-exposant);
  if (decimales >= 0) numerateur *= 10n ** BigInt(decimales);
  else denominateur *= 10n ** BigInt(-decimales);
  let quotient = numerateur / denominateur;
  const reste = numerateur % denominateur;
  if (2n * reste > denominateur || (2n * reste === denominateur && quotient % 2n === 1n)) quotient += 1n;
  return quotient;
}

/**
 * round(x, decimales) de Python. L'arrondi porte sur la valeur exacte du nombre en binaire : 2.675 vaut
 * en réalité 2,67499999…, donc arrondir(2.675, 2) donne 2,67, comme en Python, et 0.125 (exact en
 * binaire) donne 0,12, la moitié allant au pair.
 */
export function arrondir(x: number, decimales = 0): number {
  if (!Number.isInteger(decimales)) throw new RangeError(`arrondir : ${decimales} décimales`);
  if (!Number.isFinite(x) || (decimales >= 0 && Number.isInteger(x))) return decimales ? x : x + 0;
  const unites = unitesArrondies(x, decimales);
  let texte: string;
  if (decimales > 0) {
    const chiffres = unites.toString().padStart(decimales + 1, "0");
    texte = `${chiffres.slice(0, -decimales)}.${chiffres.slice(-decimales)}`;
  } else {
    texte = (unites * 10n ** BigInt(-decimales)).toString();
  }
  const resultat = x < 0 || Object.is(x, -0) ? -Number(texte) : Number(texte);
  return decimales ? resultat : resultat + 0; // round(x) rend un entier, sans « -0 »
}

/**
 * Un nombre écrit avec n décimales, comme f"{x:.nf}" en Python : 1.25 donne « 1.2 », la moitié allant
 * au pair, quand toFixed(1) donne « 1.3 ». Pour les durées en secondes, souvent des moitiés exactes.
 */
export const fixe = (x: number, decimales: number): string => arrondir(x, decimales).toFixed(decimales);
