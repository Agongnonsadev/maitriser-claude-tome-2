// Chapitre 17 : la suite d'évaluation du Comptoir, en ligne de commande.
//
// Depuis le dossier typescript/ :
//     npx tsx ch17/evaluer.ts estimer --jeu amelioration --essais 3              (gratuit)
//     npx tsx ch17/evaluer.ts lancer --variante reference --jeu amelioration --essais 3 --budget-max 1   (PAYANT)
//     npx tsx ch17/evaluer.ts juger <série> --modele claude-haiku-5-5 --budget-max 0.3                     (PAYANT)
//     npx tsx ch17/evaluer.ts resumer <série> [--modele-juge claude-haiku-5-5]                             (gratuit)
//     npx tsx ch17/evaluer.ts renoter <série> --raison "…"                                              (gratuit)
//     npx tsx ch17/evaluer.ts graduer <série>                                                           (gratuit)
//     npx tsx ch17/evaluer.ts regression --budget-max 0.3                    (PAYANT : la version livrée)
//
// Le jeu « verification » ne sert qu'à la fin, pour la version choisie : le script demande
// --je-livre pour le lancer, afin qu'on ne s'en serve pas, sans le vouloir, pour travailler.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { creerClient, requeteDeComptage } from "../comptoir/appel.ts";
import { fixe } from "../comptoir/arrondi.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { TARIFS } from "../comptoir/couts.ts";
import { lireCsv } from "../comptoir/csv.ts";
import { PYTHON, RACINE, estLance, plusieursValeurs } from "../comptoir/lancement.ts";
import { jsonPython, moyenne, somme } from "../comptoir/python.ts";
import { type CasEvaluation, type Essai, creerEssai, identifiant } from "./banc.ts";
import * as juge from "./juge.ts";
import { noter } from "./notation_code.ts";
import {
  VARIANTES, afficher, chargerCas, cheminJugements, ecrireSerie, emplacements, empreinteCas, empreinteNotation, entreeDeRegistre,
  horodatage, issue, lancer, ligneJson, lireJugements, lireSerie, maintenantUtc, noterAuRegistre, pourcent, resumer,
} from "./suite.ts";

const SORTIE_SUPPOSEE_JUGE = 600; // tokens de sortie supposés par jugement, réflexion comprise, pour l'estimation

/** SystemExit de Python : le message part sur la sortie d'erreur, et le script s'arrête avec le code 1. */
export class Arret extends Error {}

/** Ce que les tests remplacent, comme monkeypatch.setattr : le client, la base d'Awa, le lancement d'une série. */
export const dependances = {
  creerClient: (): ClientMessages => creerClient(),
  chargerBase,
  lancer,
};

/** Le coût moyen d'un message par catégorie, mesuré au chapitre 12 avec l'aiguilleur. */
export function coutsDuChapitre12(): Record<string, number> {
  // Les mesures de cette version si elles existent ; sinon celles du livre, faites avec la version Python.
  const chemin = [join(RACINE, "ch12", "resultats", "comptoir.csv"), join(PYTHON, "ch12", "resultats", "comptoir.csv")].find(existsSync)!;
  const lignes = lireCsv(chemin).filter((l) => l.mode === "aiguille");
  const categories = [...new Set(lignes.map((l) => l.attendu!))];
  return Object.fromEntries(categories.map((c) => [c, moyenne(lignes.filter((l) => l.attendu === c).map((l) => Number(l.cout_dollars)))]));
}

const essaiFictif = (cas: CasEvaluation): Essai => creerEssai("estimation", cas.id, 1, { texte: "Réponse d'exemple.", texte_claude: "Réponse d'exemple." });

export async function cmdEstimer(args: { jeu: string; essais: number; modeleJuge: string }): Promise<void> {
  const cas = chargerCas(args.jeu);
  const moyennes = coutsDuChapitre12();
  const total = somme(cas.map((c) => moyennes[c.categorie[0]!]!)) * args.essais;
  console.log(
    `${cas.length} cas × ${args.essais} essais avec la version livrée : environ ${fixe(total, 2)} $ ` +
      "(coûts moyens mesurés au chapitre 12 : " +
      Object.entries(moyennes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} ${fixe(v, 4)} $`).join(", ") + ")",
  );
  const client = dependances.creerClient();
  const exemple = juge.requete(cas[0]!, essaiFictif(cas[0]!), args.modeleJuge);
  const entree = (await client.messages.countTokens(requeteDeComptage(exemple))).input_tokens;
  const tarif = TARIFS[args.modeleJuge]!;
  const parJugement = (entree * tarif.entree + SORTIE_SUPPOSEE_JUGE * tarif.sortie) / 1_000_000;
  console.log(
    `Juge ${args.modeleJuge} : ${entree} tokens d'entrée par jugement (comptage gratuit), au plus ` +
      `${fixe(parJugement, 4)} $ sans le cache, soit ${fixe(parJugement * cas.length * args.essais, 2)} $ pour tous les essais`,
  );
}

export interface ArgsLancer {
  variante: string;
  jeu: string;
  cas: string[] | null;
  essais: number;
  budgetMax: number;
  paralleles: number;
  jeLivre: boolean;
}

export async function cmdLancer(args: ArgsLancer): Promise<void> {
  if (args.jeu === "verification" && !args.jeLivre) {
    throw new Arret("Le jeu de vérification se lance une fois, pour la version choisie : ajoutez --je-livre.");
  }
  const v = VARIANTES[args.variante]!;
  const cas = chargerCas(args.jeu, args.cas);
  const dossier = join(emplacements.series, `${horodatage()}-${v.nom}-${args.jeu}`);
  console.log(`Variante ${v.nom} · jeu ${args.jeu} (${cas.length} cas, empreinte ${empreinteCas(cas)}) · ${args.essais} essais · plafond ${args.budgetMax} $`);
  const [essais, arrete] = await dependances.lancer(dependances.creerClient(), v, cas, args.essais, args.budgetMax, dependances.chargerBase(), args.paralleles);
  ecrireSerie(dossier, essais);
  const resume = resumer(essais, cas);
  noterAuRegistre(entreeDeRegistre(dossier, v, args.jeu, cas, args.essais, resume, arrete));
  console.log((arrete ? "\nBUDGET ATTEINT : série incomplète.\n" : "\n") + afficher(resume));
  console.log(`Série : ${dossier}`);
}

export async function cmdJuger(args: { serie: string; modele: string; grille: string; echantillon: string | null; budgetMax: number; paralleles: number }): Promise<void> {
  let essais = lireSerie(args.serie);
  if (args.echantillon) {
    const retenus = new Set((JSON.parse(readFileSync(args.echantillon, "utf8")) as { essais: string[] }).essais);
    essais = essais.filter((e) => retenus.has(identifiant(e)));
  }
  const deja = lireJugements(args.serie, args.modele, args.grille);
  const aJuger = essais.filter((e) => !(identifiant(e) in deja));
  const cas = new Map(chargerCas().map((c) => [c.id, c]));
  const grille = juge.chargerGrille(args.grille);
  const client = dependances.creerClient();
  const chemin = cheminJugements(args.serie, args.modele, args.grille);
  let depense = 0;
  console.log(`${aJuger.length} essais à juger par ${args.modele} (${grille.identifiant}), ${Object.keys(deja).length} déjà jugés`);

  const un = async (essai: Essai): Promise<void> => {
    if (depense >= args.budgetMax) return;
    const j = await juge.juger(client, cas.get(essai.cas)!, essai, args.modele, grille);
    depense += j.cout_dollars;
    const resultat = issue(j);
    writeFileSync(chemin, ligneJson({ ...j, issue: resultat }) + "\n", { encoding: "utf8", flag: "a" });
    console.log(
      `  ${identifiant(essai).padEnd(45)} ${resultat.padEnd(9)} ${fixe(j.cout_dollars, 5)} $ ` +
        Object.entries(j.verdicts).map(([c, v]) => `${c}=${v}`).join(" ") + (j.erreur ? ` ${j.erreur}` : ""),
    );
  };

  if (aJuger.length) {
    await un(aJuger[0]!); // le premier seul : il écrit les documents dans le cache
    const file = aJuger.slice(1);
    await Promise.all(Array.from({ length: args.paralleles }, async () => {
      while (file.length) await un(file.shift()!);
    }));
  }
  console.log(`Dépense du juge : ${fixe(depense, 4)} $`);
  cmdResumer({ serie: args.serie, modeleJuge: args.modele, grille: args.grille });
}

export function cmdResumer(args: { serie: string; modeleJuge: string | null; grille: string }): void {
  const essais = lireSerie(args.serie);
  const jugements = args.modeleJuge ? lireJugements(args.serie, args.modeleJuge, args.grille) : null;
  console.log(afficher(resumer(essais, chargerCas(), jugements)));
}

/**
 * La notation actuelle, appliquée aux réponses déjà obtenues : aucun appel, aucun coût. Une nouvelle ligne
 * entre au registre, avec la nouvelle empreinte de la notation ; l'ancienne reste.
 */
export function cmdRenoter(args: { serie: string; raison: string }): void {
  const lignes = readFileSync(emplacements.registre, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const avant = lignes.reverse().find((l) => l.serie === basename(args.serie));
  if (!avant) throw new Arret(`La série ${basename(args.serie)} n'est pas au registre ${emplacements.registre}.`);
  const essais = lireSerie(args.serie);
  const cas = chargerCas(null, [...new Set(essais.map((e) => e.cas))].sort());
  const resume = resumer(essais, cas);
  const entree = {
    ...avant, resume, empreinte_notation: empreinteNotation(), empreinte_cas: empreinteCas(cas), renotation: true, date: maintenantUtc(), raison: args.raison,
  };
  noterAuRegistre(entree);
  console.log(`Notation ${avant.empreinte_notation} : réussite (code) ${pourcent((avant.resume as { reussite_code: number }).reussite_code)}`);
  console.log(`Notation ${entree.empreinte_notation} : réussite (code) ${pourcent(resume.reussite_code)}`);
  console.log(afficher(resume));
}

/**
 * Les cas réussis par le code à chaque essai d'une série entrent dans la non-régression : de « sait-on le
 * faire ? », ils passent à « le fait-on toujours ? ».
 */
export function cmdGraduer(args: { serie: string }): void {
  const essais = lireSerie(args.serie);
  const cas = new Map(chargerCas().map((c) => [c.id, c]));
  const parCas = new Map<string, boolean[]>();
  for (const e of essais) parCas.set(e.cas, [...(parCas.get(e.cas) ?? []), !noter(cas.get(e.cas)!, e).length]);
  const retenus = [...parCas].filter(([, v]) => v.every(Boolean)).map(([c]) => c).sort();
  writeFileSync(emplacements.regression, jsonPython({ serie: basename(args.serie), empreinte_notation: empreinteNotation(), cas: retenus }, 1), "utf8");
  console.log(`${retenus.length} cas sur ${parCas.size} entrent dans la non-régression → ${emplacements.regression}`);
}

/**
 * Les cas que la version livrée réussit à chaque essai : un seul essai chacun, notés par le code. Rend 1
 * au premier échec : de quoi bloquer une modification, à la main ou dans la CI (chapitre 20).
 */
export async function cmdRegression(args: { variante: string; budgetMax: number; paralleles: number }): Promise<number> {
  const identifiants = (JSON.parse(readFileSync(emplacements.regression, "utf8")) as { cas: string[] }).cas;
  const cas = chargerCas(null, identifiants);
  const v = VARIANTES[args.variante]!;
  const [essais, arrete] = await dependances.lancer(dependances.creerClient(), v, cas, 1, args.budgetMax, dependances.chargerBase(), args.paralleles);
  const parId = new Map(cas.map((c) => [c.id, c]));
  const rates = essais.filter((e) => noter(parId.get(e.cas)!, e).length).map((e) => e.cas).sort();
  const dossier = join(emplacements.series, `${horodatage()}-${v.nom}-regression`);
  ecrireSerie(dossier, essais);
  const resume = resumer(essais, cas);
  noterAuRegistre(entreeDeRegistre(dossier, v, "regression", cas, 1, resume, arrete));
  console.log(afficher(resume));
  if (arrete || rates.length) {
    console.log(`NON-RÉGRESSION : ${arrete ? "série incomplète ; " : ""}${rates.length} cas en échec : ${rates.join(", ")}`);
    return 1;
  }
  console.log(`Non-régression : ${cas.length} cas sur ${cas.length}.`);
  return 0;
}

const choix = (valeur: string, permis: string[], option: string): string => {
  if (!permis.includes(valeur)) throw new Arret(`${option} : ${valeur} ? Choix : ${permis.join(", ")}.`);
  return valeur;
};

async function main(): Promise<number> {
  const [commande, ...reste] = process.argv.slice(2);
  const { values: a, positionals } = parseArgs({
    args: plusieursValeurs(["cas"], reste),
    allowPositionals: true,
    options: {
      jeu: { type: "string", default: "amelioration" },
      essais: { type: "string", default: "3" },
      "modele-juge": { type: "string" },
      variante: { type: "string" },
      cas: { type: "string", multiple: true }, //   seulement ces cas
      "budget-max": { type: "string" },
      paralleles: { type: "string", default: "4" },
      "je-livre": { type: "boolean", default: false },
      modele: { type: "string", default: "claude-haiku-5-5" },
      grille: { type: "string", default: juge.GRILLE },
      echantillon: { type: "string" },
      raison: { type: "string" }, //               pourquoi la notation a changé, écrit au registre
    },
  });
  const variantes = Object.keys(VARIANTES).sort();
  switch (commande) {
    case "estimer":
      await cmdEstimer({ jeu: a.jeu, essais: Number(a.essais), modeleJuge: a["modele-juge"] ?? "claude-haiku-5-5" });
      return 0;
    case "lancer":
      await cmdLancer({
        variante: choix(a.variante ?? "reference", variantes, "--variante"), jeu: choix(a.jeu, ["amelioration", "verification"], "--jeu"),
        cas: (a.cas ?? []).filter(Boolean), essais: Number(a.essais), budgetMax: Number(a["budget-max"] ?? "1"), paralleles: Number(a.paralleles), jeLivre: a["je-livre"],
      });
      return 0;
    case "juger":
      await cmdJuger({ serie: positionals[0]!, modele: a.modele, grille: a.grille, echantillon: a.echantillon ?? null, budgetMax: Number(a["budget-max"] ?? "0.3"), paralleles: Number(a.paralleles) });
      return 0;
    case "resumer":
      cmdResumer({ serie: positionals[0]!, modeleJuge: a["modele-juge"] ?? null, grille: a.grille });
      return 0;
    case "renoter":
      if (!a.raison) throw new Arret("--raison est obligatoire : pourquoi la notation a changé, écrit au registre.");
      cmdRenoter({ serie: positionals[0]!, raison: a.raison });
      return 0;
    case "graduer":
      cmdGraduer({ serie: positionals[0]! });
      return 0;
    case "regression":
      return cmdRegression({ variante: choix(a.variante ?? "livree", variantes, "--variante"), budgetMax: Number(a["budget-max"] ?? "0.3"), paralleles: Number(a.paralleles) });
    default:
      throw new Arret("Commande : estimer, lancer, juger, resumer, renoter, graduer ou regression.");
  }
}

if (estLance(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (erreur: unknown) => {
      if (!(erreur instanceof Arret)) throw erreur;
      console.error(erreur.message);
      process.exitCode = 1;
    },
  );
}
