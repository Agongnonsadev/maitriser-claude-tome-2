// Les différences entre deux textes, comme difflib.unified_diff en Python (chapitres 10, 17, 18).
//
// Le même algorithme que SequenceMatcher (sans fonction isjunk, avec l'autojunk par défaut) : le plus
// long bloc identique d'abord, puis la même chose à gauche et à droite. La sortie est donc celle de
// Python, ligne pour ligne : en-têtes « --- » et « +++ », blocs « @@ -1,5 +1,5 @@ », n lignes de contexte.

// Les fins de ligne que reconnaît splitlines() en Python.
const FIN = "\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029";
const LIGNE = new RegExp(`[^${FIN}]*(?:\\r\\n|[${FIN}])|[^${FIN}]+$`, "g");
const FIN_DE_LIGNE = new RegExp(`(?:\\r\\n|[${FIN}])$`);

/** Les lignes d'un texte, comme texte.splitlines(keepends) en Python : avec ou sans leurs fins de ligne. */
export function decouperLignes(texte: string, avecFins = false): string[] {
  const lignes = texte.match(LIGNE) ?? [];
  return avecFins ? lignes : lignes.map((l) => l.replace(FIN_DE_LIGNE, ""));
}

type Bloc = [number, number, number]; // début dans a, début dans b, longueur
type Code = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

/** Les blocs identiques de a et b, dans l'ordre, comme SequenceMatcher(None, a, b).get_matching_blocks(). */
function blocsIdentiques(a: string[], b: string[]): Bloc[] {
  const positions = new Map<string, number[]>();
  b.forEach((ligne, j) => {
    const liste = positions.get(ligne);
    if (liste) liste.push(j);
    else positions.set(ligne, [j]);
  });
  // L'autojunk : au-delà de 200 lignes, une ligne trop fréquente (plus de 1 %) ne sert pas d'ancre.
  if (b.length >= 200) {
    const seuil = Math.floor(b.length / 100) + 1;
    for (const [ligne, liste] of positions) if (liste.length > seuil) positions.delete(ligne);
  }

  const plusLong = (alo: number, ahi: number, blo: number, bhi: number): Bloc => {
    let [bi, bj, taille] = [alo, blo, 0];
    let longueurs = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const suivantes = new Map<number, number>();
      for (const j of positions.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (longueurs.get(j - 1) ?? 0) + 1;
        suivantes.set(j, k);
        if (k > taille) [bi, bj, taille] = [i - k + 1, j - k + 1, k];
      }
      longueurs = suivantes;
    }
    while (bi > alo && bj > blo && a[bi - 1] === b[bj - 1]) [bi, bj, taille] = [bi - 1, bj - 1, taille + 1];
    while (bi + taille < ahi && bj + taille < bhi && a[bi + taille] === b[bj + taille]) taille++;
    return [bi, bj, taille];
  };

  const trouves: Bloc[] = [];
  const file: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (file.length) {
    const [alo, ahi, blo, bhi] = file.pop()!;
    const [i, j, k] = plusLong(alo, ahi, blo, bhi);
    if (!k) continue;
    trouves.push([i, j, k]);
    if (alo < i && blo < j) file.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) file.push([i + k, ahi, j + k, bhi]);
  }
  trouves.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  // Deux blocs qui se touchent n'en font qu'un.
  const blocs: Bloc[] = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of trouves) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) blocs.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) blocs.push([i1, j1, k1]);
  blocs.push([a.length, b.length, 0]);
  return blocs;
}

/** Les opérations qui changent a en b, comme get_opcodes(). */
function operations(a: string[], b: string[]): Code[] {
  const codes: Code[] = [];
  let [i, j] = [0, 0];
  for (const [ai, bj, taille] of blocsIdentiques(a, b)) {
    if (i < ai && j < bj) codes.push(["replace", i, ai, j, bj]);
    else if (i < ai) codes.push(["delete", i, ai, j, bj]);
    else if (j < bj) codes.push(["insert", i, ai, j, bj]);
    [i, j] = [ai + taille, bj + taille];
    if (taille) codes.push(["equal", ai, i, bj, j]);
  }
  return codes;
}

/** Les opérations regroupées en blocs, avec n lignes de contexte, comme get_grouped_opcodes(n). */
function* groupes(a: string[], b: string[], n: number): Generator<Code[]> {
  const codes = operations(a, b);
  if (!codes.length) codes.push(["equal", 0, 1, 0, 1]);
  const premier = codes[0]!;
  if (premier[0] === "equal") codes[0] = ["equal", Math.max(premier[1], premier[2] - n), premier[2], Math.max(premier[3], premier[4] - n), premier[4]];
  const dernier = codes.at(-1)!;
  if (dernier[0] === "equal") codes[codes.length - 1] = ["equal", dernier[1], Math.min(dernier[2], dernier[1] + n), dernier[3], Math.min(dernier[4], dernier[3] + n)];
  let groupe: Code[] = [];
  for (const code of codes) {
    let [type, i1, i2, j1, j2] = code;
    // Un long passage sans changement termine le groupe en cours.
    if (type === "equal" && i2 - i1 > 2 * n) {
      groupe.push([type, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      yield groupe;
      groupe = [];
      [i1, j1] = [Math.max(i1, i2 - n), Math.max(j1, j2 - n)];
    }
    groupe.push([type, i1, i2, j1, j2]);
  }
  if (groupe.length && !(groupe.length === 1 && groupe[0]![0] === "equal")) yield groupe;
}

function plage(debut: number, fin: number): string {
  const longueur = fin - debut;
  if (longueur === 1) return `${debut + 1}`;
  return `${longueur ? debut + 1 : debut},${longueur}`;
}

/**
 * Les lignes de la différence unifiée de a à b, comme difflib.unified_diff(a, b, de, vers, n=n,
 * lineterm=lineterm). Les lignes de a et b gardent leur fin de ligne, s'il y en a une.
 */
export function diffUnifie(a: string[], b: string[], de = "", vers = "", { n = 3, lineterm = "\n" } = {}): string[] {
  const sortie: string[] = [];
  for (const groupe of groupes(a, b, n)) {
    if (!sortie.length) sortie.push(`--- ${de}${lineterm}`, `+++ ${vers}${lineterm}`);
    const premier = groupe[0]!;
    const dernier = groupe.at(-1)!;
    sortie.push(`@@ -${plage(premier[1], dernier[2])} +${plage(premier[3], dernier[4])} @@${lineterm}`);
    for (const [type, i1, i2, j1, j2] of groupe) {
      if (type === "equal") {
        for (const ligne of a.slice(i1, i2)) sortie.push(` ${ligne}`);
        continue;
      }
      if (type === "replace" || type === "delete") for (const ligne of a.slice(i1, i2)) sortie.push(`-${ligne}`);
      if (type === "replace" || type === "insert") for (const ligne of b.slice(j1, j2)) sortie.push(`+${ligne}`);
    }
  }
  return sortie;
}
