// Chapitre 17 : tirer les réponses qu'un humain va noter, puis étalonner le juge sur ses notes.
//
// Depuis le dossier typescript/ (gratuit : aucun appel) :
//     npx tsx ch17/echantillon.ts tirer <série> --taille 30
//     npx tsx ch17/echantillon.ts page [--complement resultats/echantillon-haiku.json]   (resultats/a_noter.html)
//     npx tsx ch17/echantillon.ts etalonner <série> --modele claude-haiku-5-5 [--moitie etalonnage]
//
// La page garde les notes dans le navigateur ; un bouton les télécharge en notes_humaines.json,
// à poser dans ch17/resultats/.
//
// L'échantillon prend un seul essai par cas, pour voir le plus de cas possible, et respecte la
// part de chaque type (courant, piège, sécurité). Il est coupé en deux moitiés : on corrige la
// grille du juge en regardant la moitié « etalonnage », et on vérifie la grille corrigée sur la
// moitié « controle », qu'on n'a pas regardée. Sinon, on ajuste la grille à ces réponses-là.
//
// L'humain note à l'aveugle, sans voir les verdicts du juge, avec les mêmes informations que lui :
// le message, la réponse, le récapitulatif, ce que le système a fait, l'attendu, et les documents.
// Ses notes vont dans resultats/notes_humaines.json : {essai : {critère : verdict}}.
//
// Le tirage est celui de la version Python (le même générateur, la même graine) : sur une même série,
// les deux versions tirent les mêmes réponses. La page de notation est celle de python/ch17/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { arrondir } from "../comptoir/arrondi.ts";
import { HasardPython } from "../comptoir/hasard.ts";
import { estLance } from "../comptoir/lancement.ts";
import { jsonPython } from "../comptoir/python.ts";
import { type CasEvaluation, type Essai, identifiant } from "./banc.ts";
import * as etalonnage from "./etalonnage.ts";
import { CRITERES, GRILLE, actions, documents } from "./juge.ts";
import { DONNEES, DOSSIER as DOSSIER_CHAPITRE, chargerCas, lireJugements, lireSerie, lireTexte } from "./suite.ts";

export const DOSSIER = join(DOSSIER_CHAPITRE, "resultats");
export const ECHANTILLON = join(DOSSIER, "echantillon.json");
export const NOTES = join(DOSSIER, "notes_humaines.json");
export const PAGE = join(DONNEES, "page_notation.html");

export interface Fiche {
  essai: string;
  cas: string;
  type: string;
  message: string;
  reponse: string;
  recapitulatif: string;
  actions: string;
  attendu: string;
}

export interface Echantillon {
  essais: string[];
  moities: { etalonnage: string[]; controle: string[] };
  criteres: string[];
  fiches: Fiche[];
  serie?: string;
  complement?: string[];
}

export function tirer(essais: Essai[], cas: CasEvaluation[], taille: number, graine = 17): Echantillon {
  const hasard = new HasardPython(graine);
  const parId = new Map(cas.map((c) => [c.id, c]));
  const parCas = new Map<string, Essai[]>();
  for (const e of essais) parCas.set(e.cas, [...(parCas.get(e.cas) ?? []), e]);
  const retenus: Essai[] = [];
  for (const type of ["courant", "piege", "securite"]) {
    const candidats = [...parCas.keys()].filter((c) => parId.get(c)!.type === type).sort();
    const part = arrondir((taille * candidats.length) / parCas.size);
    for (const c of hasard.sample(candidats, Math.min(part, candidats.length))) retenus.push(hasard.choice(parCas.get(c)!));
  }
  hasard.shuffle(retenus);
  const moitie = Math.floor(retenus.length / 2);
  const fiches = retenus.map((e): Fiche => ({
    essai: identifiant(e),
    cas: e.cas,
    type: parId.get(e.cas)!.type,
    message: parId.get(e.cas)!.message,
    reponse: e.texte_claude,
    recapitulatif: e.texte.slice(e.texte_claude.length).trim(),
    actions: actions(e),
    attendu: parId.get(e.cas)!.reference,
  }));
  return {
    essais: retenus.map(identifiant),
    moities: { etalonnage: retenus.slice(0, moitie).map(identifiant), controle: retenus.slice(moitie).map(identifiant) },
    criteres: [...CRITERES],
    fiches,
  };
}

const ecrireJson = (chemin: string, valeur: unknown): void => {
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, jsonPython(valeur, 1), "utf8"); // json.dumps(…, ensure_ascii=False, indent=1)
};

function cmdTirer(serie: string, taille: number, sortie: string | undefined): void {
  const echantillon = tirer(lireSerie(serie), chargerCas(), taille);
  echantillon.serie = basename(serie);
  const chemin = sortie ?? ECHANTILLON;
  ecrireJson(chemin, echantillon);
  const types = echantillon.fiches.map((f) => f.type);
  console.log(
    `${types.length} réponses : ` + ["courant", "piege", "securite"].map((t) => `${t} ${types.filter((x) => x === t).length}`).join(", ") + ` → ${chemin}`,
  );
}

/** La page de notation, remplie : les fiches dans l'ordre du tirage, sans aucun verdict du juge. */
export function contenuDePage(echantillon: Pick<Echantillon, "criteres" | "fiches">): string {
  const donnees = {
    criteres: echantillon.criteres,
    fiches: echantillon.fiches,
    documents: documents().replaceAll("<documents>", "").replaceAll("</documents>", "").trim(),
  };
  // « </ » fermerait la balise <script> qui porte les données.
  const json = jsonPython(donnees).replaceAll("</", "<\\/");
  return lireTexte(PAGE).replaceAll("__DONNEES__", () => json);
}

/**
 * Quelques réponses d'une autre variante, sur les mêmes cas, pour qu'un humain la juge aussi.
 * Même part de chaque type que l'échantillon ; rien sur la fiche ne dit quel modèle a répondu.
 */
export function complement(fiches: Fiche[], nombre: number, graine = 1717): Fiche[] {
  const hasard = new HasardPython(graine);
  const parType = new Map<string, Fiche[]>();
  for (const f of fiches) parType.set(f.type, [...(parType.get(f.type) ?? []), f]);
  const retenues: Fiche[] = [];
  for (const type of ["courant", "piege", "securite"]) {
    const groupe = parType.get(type) ?? [];
    const part = arrondir((nombre * groupe.length) / fiches.length);
    retenues.push(...hasard.sample([...groupe].sort((a, b) => (a.essai < b.essai ? -1 : a.essai > b.essai ? 1 : 0)), part));
  }
  hasard.shuffle(retenues);
  return retenues;
}

function cmdPage(sansSquelette: string | undefined, complementDe: string | undefined, nombre: number): void {
  let echantillon = JSON.parse(readFileSync(ECHANTILLON, "utf8")) as Echantillon;
  if (complementDe) {
    const ajout = complement((JSON.parse(readFileSync(complementDe, "utf8")) as Echantillon).fiches, nombre);
    echantillon.complement = ajout.map((f) => f.essai);
    ecrireJson(ECHANTILLON, echantillon);
    echantillon = { ...echantillon, fiches: [...echantillon.fiches, ...ajout] };
  }
  const contenu = contenuDePage(echantillon);
  const sortie = join(DOSSIER, "a_noter.html");
  writeFileSync(
    sortie,
    '<!doctype html>\n<html lang="fr"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head>' +
      `<body>\n${contenu}\n</body></html>\n`,
    "utf8",
  );
  if (sansSquelette) writeFileSync(sansSquelette, contenu, "utf8");
  console.log(`Page de notation : ${sortie}`);
}

function cmdEtalonner(serie: string, modele: string, grille: string, moitie: string): void {
  const echantillon = JSON.parse(readFileSync(ECHANTILLON, "utf8")) as Echantillon;
  const notes = JSON.parse(readFileSync(NOTES, "utf8")) as Record<string, Record<string, string>>;
  const retenus = new Set(
    moitie === "complement"
      ? (echantillon.complement ?? []) // les réponses de l'autre variante : passer sa série
      : moitie === "tout"
        ? echantillon.essais
        : echantillon.moities[moitie as "etalonnage" | "controle"],
  );
  const humain: etalonnage.Notes = Object.fromEntries(
    Object.entries(notes)
      .filter(([e]) => retenus.has(e))
      .map(([e, n]) => [e, Object.fromEntries(Object.entries(n).filter(([c]) => (CRITERES as readonly string[]).includes(c)))]),
  );
  const jugements = lireJugements(serie, modele, grille);
  const juge: etalonnage.Notes = Object.fromEntries(
    Object.entries(jugements).filter(([e, j]) => retenus.has(e) && j.verdicts && Object.keys(j.verdicts).length).map(([e, j]) => [e, j.verdicts]),
  );
  const resultats = etalonnage.comparer(humain, juge);
  console.log(`Juge ${modele} (grille ${grille}), moitié « ${moitie} » : ${Object.keys(humain).filter((e) => e in juge).length} réponses notées des deux côtés\n`);
  console.log(etalonnage.afficher(resultats));
  const [accords, total] = etalonnage.accordGlobal(humain, juge);
  console.log(`\nMême issue (réussie, échouée, à relire) : ${accords} sur ${total}`);
  let fiches = new Map(echantillon.fiches.map((f) => [f.essai, f]));
  if (moitie === "complement") {
    // « haiku » dans 20261021-184109-haiku-amelioration
    const nom = basename(serie).split("-").slice(2).join("-");
    const autre = nom.slice(0, nom.lastIndexOf("-") === -1 ? undefined : nom.lastIndexOf("-"));
    const chemin = join(DOSSIER, `echantillon-${autre}.json`);
    if (existsSync(chemin)) {
      fiches = new Map([...fiches, ...(JSON.parse(readFileSync(chemin, "utf8")) as Echantillon).fiches.map((f): [string, Fiche] => [f.essai, f])]);
    }
  }
  for (const a of resultats) {
    for (const essai of [...a.faux_oui, ...a.faux_non, ...a.autres]) {
      console.log(`\n[${a.critere}] ${essai} : humain ${humain[essai]![a.critere]}, juge ${juge[essai]![a.critere]}`);
      console.log(`  message : ${fiches.get(essai)!.message}\n  réponse : ${fiches.get(essai)!.reponse}`);
      console.log(`  constat du juge : ${jugements[essai]!.constats![a.critere]}`);
    }
  }
}

function main(): void {
  const [commande, ...reste] = process.argv.slice(2);
  const { values: args, positionals } = parseArgs({
    args: reste,
    allowPositionals: true,
    options: {
      taille: { type: "string", default: "30" },
      sortie: { type: "string" }, //          un autre fichier que resultats/echantillon.json (même tirage)
      "sans-squelette": { type: "string" }, // écrire aussi la page sans <html> ni <head>, pour la publier
      complement: { type: "string" }, //       un échantillon d'une autre variante, dont ajouter quelques réponses
      nombre: { type: "string", default: "10" },
      modele: { type: "string", default: "claude-haiku-5-5" },
      grille: { type: "string", default: GRILLE },
      moitie: { type: "string", default: "etalonnage" },
    },
  });
  if (commande === "tirer") cmdTirer(positionals[0]!, Number(args.taille), args.sortie);
  else if (commande === "page") cmdPage(args["sans-squelette"], args.complement, Number(args.nombre));
  else if (commande === "etalonner") {
    if (!["etalonnage", "controle", "tout", "complement"].includes(args.moitie)) throw new Error(`--moitie : etalonnage, controle, tout ou complement`);
    cmdEtalonner(positionals[0]!, args.modele, args.grille, args.moitie);
  } else throw new Error("Commande : tirer, page ou etalonner.");
}

if (estLance(import.meta.url)) main();
