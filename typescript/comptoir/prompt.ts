// Le prompt système du Comptoir : un fichier versionné, rempli par le code (chapitre 5).
//
// Les instructions vivent dans python/comptoir/prompts/systeme_vN.md ; les données (catalogue,
// conditions) dans python/comptoir/donnees/delices_awa.json. Les deux versions du Comptoir lisent les
// mêmes fichiers, et le code assemble les deux : un prix ne s'écrit qu'à un seul endroit.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "./lancement.ts";

const DOSSIER = join(PYTHON, "comptoir");
export const VERSION_PAR_DEFAUT = "v1";

export class PromptSysteme {
  constructor(
    readonly texte: string,
    readonly version: string,
  ) {}

  /** 8 caractères qui changent dès qu'un seul caractère du prompt change. */
  get empreinte(): string {
    return createHash("sha256").update(this.texte, "utf8").digest("hex").slice(0, 8);
  }

  get identifiant(): string {
    return `systeme-${this.version}@${this.empreinte}`;
  }
}

export interface Donnees {
  produits: { nom: string; format: string; prix_fcfa: number }[];
  conditions: string[];
}

export function chargerDonnees(chemin = join(DOSSIER, "donnees", "delices_awa.json")): Donnees {
  return JSON.parse(readFileSync(chemin, "utf8")) as Donnees;
}

/** 1000 -> « 1 000 FCFA », avec une espace insécable comme séparateur. */
const fcfa = (montant: number): string => `${montant.toLocaleString("en-US").replaceAll(",", " ")} FCFA`;

export function rendreCatalogue(donnees: Donnees): string {
  return donnees.produits.map((p) => `- ${p.nom} : ${fcfa(p.prix_fcfa)} par ${p.format}`).join("\n");
}

export function rendreConditions(donnees: Donnees): string {
  return donnees.conditions.map((c) => `- ${c}`).join("\n");
}

/**
 * Remplace $nom et ${nom} par leur valeur, $$ par $, comme string.Template.substitute en Python : un
 * emplacement sans valeur est une erreur, pas un trou dans le prompt.
 */
export function remplir(modele: string, valeurs: Record<string, string>): string {
  return modele.replace(/\$(?:(\$)|([_a-z][_a-z0-9]*)|\{([_a-z][_a-z0-9]*)\}|)/gi, (tout, dollar, nom, nomEntreAccolades) => {
    if (dollar) return "$";
    const cle = nom ?? nomEntreAccolades;
    if (cle === undefined) throw new Error(`Emplacement invalide dans le prompt : « ${tout} »`);
    const valeur = valeurs[cle];
    if (valeur === undefined) throw new Error(`Aucune valeur pour l'emplacement « $${cle} » du prompt.`);
    return valeur;
  });
}

export function charger(version = VERSION_PAR_DEFAUT, donnees?: Donnees): PromptSysteme {
  const modele = readFileSync(join(DOSSIER, "prompts", `systeme_${version}.md`), "utf8").replace(/\r\n/g, "\n");
  const d = donnees ?? chargerDonnees();
  const texte = remplir(modele, { catalogue: rendreCatalogue(d), conditions: rendreConditions(d) });
  return new PromptSysteme(texte.trim(), version);
}

// --- Le message du client : une donnée, jamais une instruction -----------------------

export const LONGUEUR_MAX = 2000;
const BALISE = /<\s*\/?\s*message_client\s*>/gi;
const CONTROLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Retire ce qui pourrait faire sortir le texte du client de sa balise, et le borne. */
export function assainir(texte: string, longueurMax = LONGUEUR_MAX): string {
  const propre = texte.replace(CONTROLE, "").replace(BALISE, "").trim();
  // Compté en caractères, comme en Python, et non en unités UTF-16 : un émoji n'est jamais coupé.
  return [...propre].slice(0, longueurMax).join("");
}

export function messageClient(texte: string): string {
  return `<message_client>\n${assainir(texte)}\n</message_client>`;
}
