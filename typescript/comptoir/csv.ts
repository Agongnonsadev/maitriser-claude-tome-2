// Lire et écrire les fichiers de résultats (resultats/essais.csv) au format du module csv de Python :
// les fichiers des deux versions s'échangent. Un booléen s'écrit True ou False, une valeur absente
// reste vide, et un champ ne prend des guillemets que s'il contient une virgule, un guillemet ou un
// saut de ligne. Une colonne déclarée « à virgule » s'écrit comme un float de Python : 0.0, 5.72, 1e-05.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { flottant } from "./python.ts";

const champ = (valeur: unknown): string => {
  const texte = valeur === null || valeur === undefined ? "" : typeof valeur === "boolean" ? (valeur ? "True" : "False") : String(valeur);
  return /[",\r\n]/.test(texte) ? `"${texte.replaceAll('"', '""')}"` : texte;
};

export { flottant };

/** aVirgule : les colonnes qui sont des float dans la version Python (coûts, durées). */
export function ecrireCsv<T extends object>(lignes: T[], colonnes: (keyof T & string)[], chemin: string, aVirgule: (keyof T & string)[] = []): void {
  mkdirSync(dirname(chemin), { recursive: true });
  const valeur = (l: T, c: keyof T & string): unknown => (aVirgule.includes(c) && typeof l[c] === "number" ? flottant(l[c]) : l[c]);
  const texte = [colonnes.join(","), ...lignes.map((l) => colonnes.map((c) => champ(valeur(l, c))).join(","))];
  writeFileSync(chemin, texte.join("\r\n") + "\r\n", "utf8");
}

/** Les lignes d'un fichier CSV, chacune en objet { colonne: texte }. */
export function lireCsv(chemin: string): Record<string, string>[] {
  const texte = readFileSync(chemin, "utf8").replace(/^﻿/, "");
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let valeur = "";
  let entreGuillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (entreGuillemets) {
      if (c === '"' && texte[i + 1] === '"') {
        valeur += '"';
        i++;
      } else if (c === '"') {
        entreGuillemets = false;
      } else {
        valeur += c;
      }
    } else if (c === '"') {
      entreGuillemets = true;
    } else if (c === ",") {
      ligne.push(valeur);
      valeur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texte[i + 1] === "\n") i++;
      ligne.push(valeur);
      lignes.push(ligne);
      ligne = [];
      valeur = "";
    } else {
      valeur += c;
    }
  }
  if (valeur || ligne.length) lignes.push([...ligne, valeur]);
  const [entete, ...donnees] = lignes;
  if (!entete) return [];
  return donnees.map((l) => Object.fromEntries(entete.map((nom, i) => [nom, l[i] ?? ""])));
}
