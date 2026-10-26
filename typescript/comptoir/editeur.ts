// L'outil éditeur de texte d'Anthropic, exécuté par votre code dans un dossier fermé (chapitre 10).
//
// Anthropic définit l'outil (text_editor_20250728, nommé str_replace_based_edit_tool) : son schéma, et la
// façon dont Claude s'en sert. Votre code l'exécute. Il a donc toutes les responsabilités d'un accès à des
// fichiers : rester dans son dossier, refuser un remplacement ambigu, sauvegarder avant de modifier.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decouperLignes } from "./difference.ts";

export const OUTIL: Anthropic.ToolTextEditor20250728 = { type: "text_editor_20250728", name: "str_replace_based_edit_tool", max_characters: 20000 };

export class RefusEditeur extends Error {}

export interface Entree {
  command?: string;
  path?: string;
  view_range?: [number, number] | null;
  old_str?: string;
  new_str?: string;
  file_text?: string;
  insert_line?: number;
  insert_text?: string;
}

/** Un fichier lu comme le fait read_text() en Python : UTF-8 strict, fins de ligne ramenées à « \n ». */
export function lireTexte(fichier: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fichier)).replace(/\r\n?/g, "\n");
  } catch (erreur) {
    if (erreur instanceof TypeError) throw new RefusEditeur("Error: File is not valid UTF-8.");
    throw erreur;
  }
}

/** Un chemin dont les liens symboliques sont résolus, même s'il n'existe pas encore (Path.resolve). */
function reel(chemin: string): string {
  let base = resolve(chemin);
  const reste: string[] = [];
  while (!existsSync(base) && dirname(base) !== base) {
    reste.unshift(basename(base));
    base = dirname(base);
  }
  return join(realpathSync.native(base), ...reste);
}

/** Un champ obligatoire de l'entrée. Absent, il donne le même message qu'un KeyError en Python. */
function champ<K extends keyof Entree>(entree: Entree, nom: K): NonNullable<Entree[K]> {
  const valeur = entree[nom];
  if (valeur === undefined || valeur === null) throw new RefusEditeur(`'${nom}'`);
  return valeur;
}

export class Editeur {
  readonly racine: string;

  constructor(racine: string) {
    this.racine = reel(racine);
  }

  /** Un chemin relatif, qui reste dans la racine. Pas de « .. », pas de chemin absolu. */
  private chemin(chemin: string): string {
    const candidat = reel(resolve(this.racine, chemin));
    const dedans = candidat === this.racine || candidat.startsWith(this.racine + sep);
    if (isAbsolute(chemin) || !dedans) throw new RefusEditeur(`Error: Path outside the allowed folder: ${chemin}`);
    return candidat;
  }

  private sauvegarder(fichier: string): void {
    if (existsSync(fichier)) writeFileSync(`${fichier}.backup`, lireTexte(fichier), "utf8");
  }

  executer(entree: Entree): string {
    const commande = entree.command;
    const fichier = this.chemin(champ(entree, "path"));
    if (commande === "view") {
      if (existsSync(fichier) && statSync(fichier).isDirectory()) {
        return readdirSync(fichier).map((nom) => relative(this.racine, join(fichier, nom)).split(sep).join("/")).sort().join("\n");
      }
      if (!existsSync(fichier)) throw new RefusEditeur("Error: File not found");
      const lignes = decouperLignes(lireTexte(fichier));
      const [debut, finDemandee] = entree.view_range || [1, -1];
      const fin = finDemandee === -1 ? lignes.length : finDemandee;
      // Des numéros de ligne, pour que Claude puisse viser une insertion.
      const sortie: string[] = [];
      for (let n = debut; n <= fin; n++) if (n > 0 && n <= lignes.length) sortie.push(`${n}: ${lignes[n - 1]}`);
      return sortie.join("\n");
    }
    if (commande === "str_replace") {
      if (!existsSync(fichier)) throw new RefusEditeur("Error: File not found");
      const contenu = lireTexte(fichier);
      const ancien = champ(entree, "old_str");
      // Comme str.count en Python : une chaîne vide se trouve entre chaque caractère.
      const nombre = ancien ? contenu.split(ancien).length - 1 : [...contenu].length + 1;
      if (nombre === 0) throw new RefusEditeur("Error: No match found for replacement. Please check your text and try again.");
      if (nombre > 1) throw new RefusEditeur(`Error: Found ${nombre} matches for replacement text. Please provide more context to make a unique match.`);
      const nouveau = champ(entree, "new_str");
      this.sauvegarder(fichier);
      writeFileSync(fichier, contenu.replace(ancien, () => nouveau), "utf8");
      return "Successfully replaced text at exactly one location.";
    }
    if (commande === "create") {
      if (existsSync(fichier)) throw new RefusEditeur("Error: File already exists. Use str_replace to modify it.");
      const texte = champ(entree, "file_text");
      mkdirSync(dirname(fichier), { recursive: true });
      writeFileSync(fichier, texte, "utf8");
      return `File created: ${entree.path}`;
    }
    if (commande === "insert") {
      if (!existsSync(fichier)) throw new RefusEditeur("Error: File not found");
      const lignes = decouperLignes(lireTexte(fichier), true);
      const position = champ(entree, "insert_line");
      if (!(position >= 0 && position <= lignes.length)) throw new RefusEditeur(`Error: insert_line must be between 0 and ${lignes.length}.`);
      const ajout = champ(entree, "insert_text");
      this.sauvegarder(fichier);
      const texte = ajout.endsWith("\n") ? ajout : `${ajout}\n`;
      writeFileSync(fichier, [...lignes.slice(0, position), texte, ...lignes.slice(position)].join(""), "utf8");
      return `Text inserted after line ${position}.`;
    }
    throw new RefusEditeur(`Error: Unknown command ${commande === undefined ? "None" : `'${commande}'`}.`);
  }

  /** Un bloc tool_use de l'éditeur en entrée, un tool_result en sortie. */
  resultat(appel: Pick<Anthropic.ToolUseBlock, "id" | "input">): Anthropic.ToolResultBlockParam {
    try {
      return { type: "tool_result", tool_use_id: appel.id, content: this.executer(appel.input as Entree) };
    } catch (erreur) {
      if (!(erreur instanceof RefusEditeur)) throw erreur;
      return { type: "tool_result", tool_use_id: appel.id, content: erreur.message, is_error: true };
    }
  }
}
