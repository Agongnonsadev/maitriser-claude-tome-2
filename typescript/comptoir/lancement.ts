// Ce qui sert à lancer les scripts des chapitres : où sont les fichiers, et si un module est le
// programme lancé ou un module importé (par les tests).

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Le dossier typescript/ du dépôt. */
export const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Le dossier python/, à côté. Les données communes aux deux langages (cas d'évaluation, catalogue,
 * prompts) y sont lues sur place : une seule source, que les deux versions du Comptoir partagent.
 */
export const PYTHON = join(RACINE, "..", "python");

/** Vrai si ce module est le script lancé (`npx tsx ch02/comptoir_cli.ts`), faux s'il est importé. */
export function estLance(urlDuModule: string): boolean {
  const lance = process.argv[1];
  if (!lance) return false;
  try {
    return realpathSync(fileURLToPath(urlDuModule)) === realpathSync(lance);
  } catch {
    return false;
  }
}

/**
 * Les arguments de la ligne de commande, où une option à plusieurs valeurs (nargs="+" en Python) prend
 * tous les mots qui la suivent : « --modes contexte rag » devient « --modes contexte --modes rag », la
 * forme que lit parseArgs (option `multiple: true`). Une telle option laissée sans valeur (nargs="*" :
 * « --traces » seul, pour une liste vide) devient « --traces= » : une valeur vide, que le script écarte.
 */
export function plusieursValeurs(options: string[], args = process.argv.slice(2)): string[] {
  const sortie: string[] = [];
  let ouverte: string | null = null;
  let valeurs = 0;
  const fermer = (): void => {
    if (ouverte && !valeurs) sortie[sortie.length - 1] = `${ouverte}=`;
  };
  for (const mot of args) {
    if (mot.startsWith("-")) {
      fermer();
      ouverte = options.includes(mot.replace(/^--?/, "")) ? mot : null;
      valeurs = 0;
      sortie.push(mot);
    } else {
      if (ouverte && valeurs) sortie.push(ouverte);
      if (ouverte) valeurs++;
      sortie.push(mot);
    }
  }
  fermer();
  return sortie;
}
