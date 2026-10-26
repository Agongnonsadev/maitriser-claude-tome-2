// Étalonner le juge : comparer ses verdicts à ceux d'un humain, sur les mêmes réponses (chapitre 17).
//
// Trois chiffres par critère :
// - l'accord brut : la part des réponses où le juge et l'humain disent la même chose ;
// - le kappa de Cohen : le même accord, une fois retiré celui que le hasard donnerait. Quand
//   presque toutes les réponses sont bonnes, un juge qui dit toujours « oui » a un excellent
//   accord brut et un kappa nul : il ne voit rien ;
// - les faux « oui » : le juge laisse passer une réponse que l'humain refuse. C'est l'erreur qui
//   coûte, puisqu'un juge sert à attraper les mauvaises réponses.
//
// L'humain peut se tromper aussi : chaque désaccord se relit, et se tranche, avant de corriger
// la grille.

import { fixe } from "../comptoir/arrondi.ts";
import { CRITERES } from "./juge.ts";
import { pourcent } from "./suite.ts";

export type Notes = Record<string, Record<string, string>>; // {identifiant de l'essai : {critère : verdict}}

export class Accord {
  n = 0;
  accords = 0;
  kappa: number | null = null;
  readonly faux_oui: string[] = []; //  juge oui, humain non
  readonly faux_non: string[] = []; //  juge non, humain oui
  readonly autres: string[] = []; //    un « inconnu » d'un côté seulement

  constructor(readonly critere: string) {}

  get accordBrut(): number {
    return this.n ? this.accords / this.n : 0;
  }
}

function compter(valeurs: string[]): Map<string, number> {
  const comptes = new Map<string, number>();
  for (const v of valeurs) comptes.set(v, (comptes.get(v) ?? 0) + 1);
  return comptes;
}

/** Kappa de Cohen pour deux notateurs. null si le hasard suffit à tout expliquer (une seule valeur). */
export function kappa(paires: [string, string][]): number | null {
  const n = paires.length;
  if (!n) return null;
  const observe = paires.filter(([a, b]) => a === b).length / n;
  const gauche = compter(paires.map(([a]) => a));
  const droite = compter(paires.map(([, b]) => b));
  let produits = 0;
  for (const v of new Set([...gauche.keys(), ...droite.keys()])) produits += (gauche.get(v) ?? 0) * (droite.get(v) ?? 0);
  const attendu = produits / (n * n);
  if (attendu === 1) return null;
  return (observe - attendu) / (1 - attendu);
}

/** Seuls les essais notés des deux côtés comptent. */
export function comparer(humain: Notes, juge: Notes): Accord[] {
  const communs = Object.keys(humain).filter((e) => e in juge).sort();
  return CRITERES.map((critere) => {
    const accord = new Accord(critere);
    const paires: [string, string][] = [];
    for (const essai of communs) {
      const h = humain[essai]![critere];
      const j = juge[essai]![critere];
      if (h === undefined || j === undefined) continue;
      paires.push([h, j]);
      accord.n++;
      if (h === j) accord.accords++;
      else if (j === "oui" && h === "non") accord.faux_oui.push(essai);
      else if (j === "non" && h === "oui") accord.faux_non.push(essai);
      else accord.autres.push(essai);
    }
    accord.kappa = kappa(paires);
    return accord;
  });
}

export function issue(verdicts: Record<string, string>): "reussi" | "echoue" | "a_relire" {
  const v = Object.values(verdicts);
  if (v.includes("non")) return "echoue";
  return v.length && v.every((x) => x === "oui") ? "reussi" : "a_relire";
}

/** Sur l'issue de chaque réponse (réussie, échouée, à relire) : accords, total, désaccords. */
export function accordGlobal(humain: Notes, juge: Notes): [number, number, string[]] {
  const communs = Object.keys(humain).filter((e) => e in juge).sort();
  const desaccords = communs.filter((e) => issue(humain[e]!) !== issue(juge[e]!));
  return [communs.length - desaccords.length, communs.length, desaccords];
}

export function afficher(resultats: Accord[]): string {
  const lignes = [`${"critère".padEnd(14)} ${"notés".padStart(5)} ${"accord".padStart(7)} ${"kappa".padStart(6)} ${"faux oui".padStart(9)} ${"faux non".padStart(9)}`];
  for (const a of resultats) {
    const k = a.kappa !== null ? fixe(a.kappa, 2) : "—";
    lignes.push(
      `${a.critere.padEnd(14)} ${String(a.n).padStart(5)} ${pourcent(a.accordBrut).padStart(7)} ${k.padStart(6)} ` +
        `${String(a.faux_oui.length).padStart(9)} ${String(a.faux_non.length).padStart(9)}`,
    );
  }
  return lignes.join("\n");
}
