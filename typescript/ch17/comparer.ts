// Chapitre 17 : comparer deux séries d'essais, cas par cas, et dire si l'écart dépasse le hasard.
//
// Lancement, depuis le dossier typescript/ (gratuit : aucun appel) :
//     npx tsx ch17/comparer.ts <série A> <série B> [--modele-juge claude-haiku-5-5]
//
// Trois précautions :
// - les deux séries doivent avoir reçu les mêmes messages (empreinte des cas, au registre) ; elles
//   sont notées ici par la même notation, celle du jour ;
// - on compare cas par cas : un cas gagné, un cas perdu, et non une moyenne ;
// - le test du signe dit si une majorité de cas qui bougent dans le même sens peut venir du hasard.
//   Il ne prouve rien sur un ou deux cas : il faut alors plus d'essais, ou plus de cas.
//
// Une série de la version Python se compare aussi : les fichiers ont la même forme.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fixe } from "../comptoir/arrondi.ts";
import { estLance } from "../comptoir/lancement.ts";
import { diviserExactement, repr } from "../comptoir/python.ts";
import { GRILLE } from "./juge.ts";
import { afficher, chargerCas, emplacements, lireJugements, lireSerie, resumer, tauxParCas } from "./suite.ts";

/** Combinaisons de k parmi n, exactement. */
function combinaisons(n: number, k: number): bigint {
  let c = 1n;
  for (let i = 0; i < k; i++) c = (c * BigInt(n - i)) / BigInt(i + 1);
  return c;
}

/** Probabilité d'un écart au moins aussi net si les deux versions se valaient (bilatérale). */
export function testDuSigne(gagnes: number, perdus: number): number {
  const n = gagnes + perdus;
  if (n === 0) return 1;
  const k = Math.min(gagnes, perdus);
  let total = 0n;
  for (let i = 0; i <= k; i++) total += combinaisons(n, i);
  return Math.min(1, diviserExactement(2n * total, 2n ** BigInt(n))); // un entier divisé par un entier, comme en Python
}

/**
 * La ligne de la série au registre : celui qui est à côté de la série (resultats/registre.jsonl, pour
 * resultats/series/<série>), puis celui de cette version. Une série de la version Python garde ainsi ses versions.
 */
export function entree(serie: string): Record<string, unknown> | null {
  for (const registre of new Set([join(dirname(dirname(resolve(serie))), "registre.jsonl"), emplacements.registre])) {
    if (!existsSync(registre)) continue;
    const lignes = readFileSync(registre, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const ligne = lignes.reverse().find((l) => l.serie === basename(serie));
    if (ligne) return ligne;
  }
  return null;
}

/** Les cas mieux réussis par B, et ceux mieux réussis par A. */
export function comparer(a: Record<string, number>, b: Record<string, number>): [string[], string[]] {
  const communs = Object.keys(a).filter((c) => c in b).sort();
  return [communs.filter((c) => b[c]! > a[c]!), communs.filter((c) => b[c]! < a[c]!)];
}

function main(): void {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: { "modele-juge": { type: "string" }, grille: { type: "string", default: GRILLE } },
  });
  if (positionals.length !== 2) throw new Error("Deux séries à comparer : <série A> <série B>.");
  const cas = chargerCas();
  const series = positionals;
  const infos = series.map(entree);
  if (infos[0] && infos[1]) {
    for (const cle of ["empreinte_cas", "jeu"]) {
      if (infos[0][cle] !== infos[1][cle]) {
        console.error(`Séries incomparables : ${cle} différent (${infos[0][cle]} / ${infos[1][cle]}).`);
        process.exit(1);
      }
    }
  }
  const taux = series.map((s, i) => {
    const essais = lireSerie(s);
    const jugements = args["modele-juge"] ? lireJugements(s, args["modele-juge"], args.grille) : null;
    console.log(`\n${basename(s)}` + (infos[i] ? ` — ${repr(infos[i]!.versions)}` : ""));
    console.log(afficher(resumer(essais, cas, jugements)));
    return tauxParCas(essais, cas, jugements);
  });
  const [gagnes, perdus] = comparer(taux[0]!, taux[1]!);
  console.log(`\nCas mieux réussis par B : ${gagnes.length} ${repr(gagnes)}`);
  console.log(`Cas mieux réussis par A : ${perdus.length} ${repr(perdus)}`);
  console.log(`Test du signe : p = ${fixe(testDuSigne(gagnes.length, perdus.length), 2)} (sous 0,05, l'écart a peu de chances de venir du hasard)`);
}

if (estLance(import.meta.url)) main();
