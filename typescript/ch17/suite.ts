// La suite d'évaluation du Comptoir (chapitre 17) : lancer, noter, résumer, garder la trace.
//
// - les cas vivent dans python/ch17/cas.json, communs aux deux versions, chacun dans un jeu :
//   « amelioration » pour travailler, « verification » pour vérifier, une seule fois, la version choisie ;
// - chaque série d'essais va dans son propre dossier de ch17/resultats/series/, avec toutes les
//   transcriptions ; une ligne entre dans ch17/resultats/registre.jsonl : la variante, les
//   versions des prompts, l'empreinte des cas et de la notation, les résultats et le coût.
//   Deux séries ne se comparent que si elles ont reçu les mêmes messages (empreinte des cas) ; leurs
//   réponses sont alors notées ensemble, par la notation du jour : celle du code, les attendus et la
//   grille du juge s'appliquent aux deux à la fois.
//
// Les fichiers ont la forme de ceux de la version Python, nombres à virgule compris (« 0.0 ») : une
// série faite par l'une se relit, se résume et se compare avec l'autre.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { arrondir, fixe } from "../comptoir/arrondi.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import type { Morceau } from "../comptoir/connaissances.ts";
import { chargerPrompt } from "../comptoir/documentaire.ts";
import { PYTHON, RACINE } from "../comptoir/lancement.ts";
import { charger } from "../comptoir/prompt.ts";
import { Flottant, flottant, jsonPython, mediane, moyenne, repr, somme } from "../comptoir/python.ts";
import { PROMPT as PROMPT_ROUTEUR } from "../comptoir/routeur.ts";
import { type CasEvaluation, CHAMPS_ESSAI, type Essai, type Variante, creerEssai, essayer, identifiant, variante } from "./banc.ts";
import { noter } from "./notation_code.ts";

export const DOSSIER = join(RACINE, "ch17");
/** Les données communes aux deux versions : les cas, la liste de non-régression, les grilles du juge. */
export const DONNEES = join(PYTHON, "ch17");

/** Où vont les résultats ; les tests les changent le temps d'un essai, comme monkeypatch.setattr. */
export const emplacements = {
  series: join(DOSSIER, "resultats", "series"),
  registre: join(DOSSIER, "resultats", "registre.jsonl"),
  // La liste des cas de non-régression est commune aux deux versions : une seule liste, comme les cas.
  regression: join(DONNEES, "regression.json"),
  // Le banc d'essai lui-même, que le test du budget remplace.
  essayer,
};

const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
export const VARIANTES: Record<string, Variante> = {
  // La version livrée avant ce chapitre : le Comptoir sur Claude Sonnet 5.5.
  reference: variante("reference", { modele_comptoir: SONNET }),
  // Une modification à la fois, chacune comparée à la référence.
  // Le prompt : la règle de longueur reçoit son moyen (systeme_v4.md, une phrase de plus).
  "prompt-v4": variante("prompt-v4", { modele_comptoir: SONNET, version_prompt: "v4" }),
  // Le modèle du Comptoir : Claude Haiku 5.5, vingt fois moins cher que Sonnet 5.5 (comptoir/couts.ts).
  haiku: variante("haiku", { modele_comptoir: HAIKU }),
  // Chapitre 18 : le prompt dit au Comptoir qu'il est une IA, et quoi répondre à « vous êtes Awa ? ».
  // Comparé à « haiku » (même modèle, prompt v3) : 5 cas gagnés, 3 perdus, p = 0,73 ; retenu.
  "prompt-v5": variante("prompt-v5", { version_prompt: "v5" }),
  // La version livrée : Haiku 5.5 (comptoir/config.ts) depuis le chapitre 17, prompt v5 depuis le chapitre 18.
  livree: variante("livree", { version_prompt: "v5" }),
  // Chapitre 19 : l'effort du Comptoir à low, que la documentation conseille pour le chat ; comparé à « livree ».
  "effort-low": variante("effort-low", { version_prompt: "v5", effort_comptoir: "low" }),
};

/** 8 caractères qui changent dès qu'un seul caractère change. */
export const empreinte = (texte: string): string => createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 8);

/** Un fichier texte lu comme read_text() en Python : les fins de ligne ramenées à \n. */
export const lireTexte = (chemin: string): string => readFileSync(chemin, "utf8").replace(/\r\n?/g, "\n");

export function chargerCas(jeu: string | null = null, identifiants: string[] | null = null): CasEvaluation[] {
  let cas = JSON.parse(readFileSync(join(DONNEES, "cas.json"), "utf8")) as CasEvaluation[];
  if (jeu) cas = cas.filter((c) => c.jeu === jeu);
  if (identifiants?.length) cas = cas.filter((c) => identifiants.includes(c.id));
  return cas;
}

/**
 * Ce qui fait les réponses : les identifiants et les messages. Les critères et les attendus peuvent être
 * corrigés, ils s'appliquent ensuite à toutes les séries à la fois. La même empreinte qu'en Python.
 */
export const empreinteCas = (cas: CasEvaluation[]): string => empreinte(jsonPython(cas.map((c) => [c.id, c.message])));

/** L'empreinte de la notation de cette version (son code, et celui du chapitre 3 dont elle dépend). */
export function empreinteNotation(): string {
  const sources = [join(DOSSIER, "notation_code.ts"), join(RACINE, "comptoir", "notation.ts")];
  return empreinte(sources.map(lireTexte).join(""));
}

/** Tout ce qui fait la variante, avec l'empreinte de chaque prompt : de quoi la retrouver. */
export function versions(v: Variante): Record<string, string> {
  return {
    modele_comptoir: v.modele_comptoir || config.MODELE_COMPTOIR,
    effort_comptoir: v.effort_comptoir || config.EFFORT_COMPTOIR || "défaut du modèle",
    modele_routeur: config.MODELE_ROUTEUR,
    modele_documents: config.MODELE_DOCUMENTS,
    modele_reclamations: `${config.MODELE_AUXILIAIRE} et ${config.MODELE}`,
    prompt_comptoir: charger(v.version_prompt).identifiant,
    prompt_documents: chargerPrompt(v.version_documents).identifiant,
    prompt_routeur: `routeur-v1@${empreinte(PROMPT_ROUTEUR)}`,
  };
}

// --- Lancer ---------------------------------------------------------------------------

/**
 * Chaque cas, `essais` fois. Un premier essai par chemin (information, commande, réclamation, autre)
 * part seul : il écrit les caches que les suivants liront, au lieu de quatre écritures en parallèle.
 * Rend les essais et true si le budget a arrêté la série avant la fin.
 */
export async function lancer(
  client: ClientMessages | null,
  v: Variante,
  cas: CasEvaluation[],
  essais: number,
  budgetMax: number,
  base: Morceau[],
  paralleles = 4,
  auFil: (ligne: string) => void = console.log,
): Promise<[Essai[], boolean]> {
  type Tache = [CasEvaluation, number];
  let taches: Tache[] = [];
  for (let n = 1; n <= essais; n++) for (const c of cas) taches.push([c, n]);
  const ordre = new Map(taches.map(([c, n], rang) => [`${c.id}/${n}`, rang]));
  const chemins = new Set<string>();
  const seuls: Tache[] = [];
  for (const t of taches) {
    if (!chemins.has(t[0].categorie[0]!)) {
      chemins.add(t[0].categorie[0]!);
      seuls.push(t);
    }
  }
  taches = [...seuls, ...taches.filter((t) => !seuls.includes(t))];
  const resultats: Essai[] = [];
  let depense = 0;

  const un = async ([c, n]: Tache): Promise<Essai> => {
    const essai = await emplacements.essayer(client as ClientMessages, v, c, n, base);
    const echecs = noter(c, essai);
    auFil(
      `  ${identifiant(essai).padEnd(45)} ${echecs.length ? "ÉCHEC" : "ok"} ${fixe(essai.cout_dollars, 4)} $ ` +
        `${fixe(essai.latence_s, 1).padStart(5)} s ${[...echecs.map((e) => e.raison).join("; ")].slice(0, 90).join("")}`,
    );
    return essai;
  };

  if (!taches.length) return [[], false];
  for (const tache of seuls) {
    const essai = await un(tache);
    resultats.push(essai);
    depense += essai.cout_dollars;
  }
  let arrete = false;
  let reste = taches.slice(seuls.length);
  const enCours = new Set<Promise<[Promise<unknown>, Essai]>>();
  while (reste.length || enCours.size) {
    while (reste.length && enCours.size < paralleles) {
      if (depense >= budgetMax) {
        arrete = true;
        reste = [];
        break;
      }
      const promesse: Promise<[Promise<unknown>, Essai]> = un(reste.shift()!).then((e) => [promesse, e]);
      enCours.add(promesse);
    }
    if (!enCours.size) break;
    const [finie, essai] = await Promise.race(enCours);
    enCours.delete(finie as Promise<[Promise<unknown>, Essai]>);
    resultats.push(essai);
    depense += essai.cout_dollars;
  }
  resultats.sort((a, b) => ordre.get(`${a.cas}/${a.essai}`)! - ordre.get(`${b.cas}/${b.essai}`)!);
  return [resultats, arrete];
}

// --- Écrire et relire -------------------------------------------------------------------

// Les nombres à virgule de la version Python : écrits « 0.0 », et non « 0 », dans les fichiers.
const FLOTTANTS = new Set([
  "cout_dollars", "latence_s", "duree_s", // un essai, ses appels, ses étapes ; un jugement
  "reussite_code", "reussite_juge", "reussite", "cout_juge", "cout_total", "cout_moyen", "cout_par_reussite",
  "latence_mediane_s", "latence_p90_s", "courant", "piege", "securite", // un résumé (par type : courant, piège, sécurité)
]);

function commePython(valeur: unknown, cle: string | null = null): unknown {
  if (typeof valeur === "number" && cle !== null && FLOTTANTS.has(cle)) return new Flottant(valeur);
  if (Array.isArray(valeur)) return valeur.map((v) => commePython(v));
  if (valeur !== null && typeof valeur === "object" && !(valeur instanceof Flottant)) {
    // L'entrée d'un outil appartient à Claude : ses nombres restent tels quels.
    if (cle === "input") return valeur;
    return Object.fromEntries(Object.entries(valeur).map(([k, v]) => [k, commePython(v, k)]));
  }
  return valeur;
}

/** Une ligne JSON comme json.dumps(…, ensure_ascii=False) l'écrit en Python. */
export const ligneJson = (valeur: unknown): string => jsonPython(commePython(valeur));

export function ecrireSerie(dossier: string, essais: Essai[]): void {
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "essais.jsonl"), essais.map((e) => ligneJson(e) + "\n").join(""), "utf8");
}

const lignesJson = (chemin: string): Record<string, unknown>[] =>
  readFileSync(chemin, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export function lireSerie(dossier: string): Essai[] {
  return lignesJson(join(dossier, "essais.jsonl")).map((l) => {
    const champs = Object.fromEntries(CHAMPS_ESSAI.filter((k) => k in l).map((k) => [k, l[k]])) as Partial<Essai>;
    return creerEssai(champs.variante!, champs.cas!, champs.essai!, champs);
  });
}

/** Un jugement tel qu'il est écrit : celui de ch17/juge.ts, avec son issue. */
export interface JugementEcrit {
  essai: string;
  modele?: string;
  grille?: string;
  verdicts: Record<string, string>;
  constats?: Record<string, string>;
  cout_dollars: number;
  erreur?: string | null;
  issue?: string;
}

/** Un fichier par juge et par version de la grille : une grille corrigée ne mélange pas ses notes aux anciennes. */
export const cheminJugements = (dossier: string, modele: string, grille = "v1"): string => join(dossier, `jugements-${modele}-${grille}.jsonl`);

export function lireJugements(dossier: string, modele: string, grille = "v1"): Record<string, JugementEcrit> {
  const chemin = cheminJugements(dossier, modele, grille);
  if (!existsSync(chemin)) return {};
  return Object.fromEntries((lignesJson(chemin) as unknown as JugementEcrit[]).map((j) => [j.essai, j]));
}

export function noterAuRegistre(entree: Record<string, unknown>): void {
  mkdirSync(dirname(emplacements.registre), { recursive: true });
  appendFileSync(emplacements.registre, ligneJson(entree) + "\n", "utf8");
}

// --- Résumer ----------------------------------------------------------------------------

function p90(valeurs: number[]): number {
  const tries = [...valeurs].sort((a, b) => a - b);
  return tries.length ? tries[Math.min(tries.length - 1, arrondir(0.9 * (tries.length - 1)))]! : 0;
}

/** Counter de Python, rendu en objet : chaque valeur avec son nombre, dans l'ordre de première apparition. */
function compter(valeurs: Iterable<string>): Record<string, number> {
  const comptes: Record<string, number> = {};
  for (const v of valeurs) comptes[v] = (comptes[v] ?? 0) + 1;
  return comptes;
}

export function issue(jugement: Pick<JugementEcrit, "verdicts" | "erreur">): "reussi" | "echoue" | "a_relire" {
  const verdicts = Object.values(jugement.verdicts ?? {});
  if (jugement.erreur || !verdicts.length) return "a_relire";
  return verdicts.includes("non") ? "echoue" : verdicts.every((x) => x === "oui") ? "reussi" : "a_relire";
}

/** Le résumé d'une série, aux noms de la version Python ; les champs du juge n'y sont que s'il est passé. */
export interface Resume {
  essais: number;
  cas: number;
  reussite_code: number;
  echecs_par_famille: Record<string, number>;
  juges?: number;
  reussite_juge?: number;
  a_relire?: number;
  non_par_critere?: Record<string, number>;
  reussite?: number;
  cout_juge?: number;
  cas_toujours_reussis: number;
  cas_jamais_reussis: number;
  cas_instables: string[];
  par_type: Record<string, number>;
  cout_total: number;
  cout_moyen: number;
  cout_par_reussite: number | null;
  latence_mediane_s: number | null;
  latence_p90_s: number | null;
  appels_moyens: number;
}

/**
 * Qualité, coût et latence, ensemble. Un essai réussit si le code ne trouve rien à redire, et, quand le
 * juge est passé, s'il dit « oui » à tous les critères. Si le juge n'a lu qu'un échantillon, le résumé ne
 * porte que sur les essais jugés.
 */
export function resumer(essais: Essai[], cas: CasEvaluation[], jugements: Record<string, JugementEcrit> | null = null): Resume {
  const parId = new Map(cas.map((c) => [c.id, c]));
  const juge = jugements !== null && Object.keys(jugements).length > 0; // `if jugements:` en Python
  if (juge) essais = essais.filter((e) => identifiant(e) in jugements!);
  const notes = new Map(essais.map((e) => [identifiant(e), noter(parId.get(e.cas)!, e)]));
  const reussisCode = new Set([...notes].filter(([, echecs]) => !echecs.length).map(([i]) => i));
  const resume: Record<string, unknown> = {
    essais: essais.length,
    cas: new Set(essais.map((e) => e.cas)).size,
    reussite_code: essais.length ? reussisCode.size / essais.length : 0,
    echecs_par_famille: compter([...notes.values()].flatMap((echecs) => echecs.map((e) => e.famille))),
  };
  let reussis = new Set(reussisCode);
  if (juge) {
    const retenus = Object.values(jugements!).filter((j) => notes.has(j.essai));
    const issues = new Map(Object.entries(jugements!).filter(([i]) => notes.has(i)).map(([i, j]) => [i, issue(j)]));
    resume.juges = issues.size;
    resume.reussite_juge = issues.size ? [...issues.values()].filter((v) => v === "reussi").length / issues.size : 0;
    resume.a_relire = [...issues.values()].filter((v) => v === "a_relire").length;
    resume.non_par_critere = compter(retenus.flatMap((j) => Object.entries(j.verdicts).filter(([, v]) => v === "non").map(([c]) => c)));
    reussis = new Set([...reussisCode].filter((i) => issues.get(i) === "reussi"));
    resume.reussite = essais.length ? reussis.size / essais.length : 0;
    resume.cout_juge = arrondir(somme(retenus.map((j) => j.cout_dollars)), 4);
  }
  const parCas = new Map<string, boolean[]>();
  for (const e of essais) parCas.set(e.cas, [...(parCas.get(e.cas) ?? []), reussis.has(identifiant(e))]);
  const listes = [...parCas.values()];
  resume.cas_toujours_reussis = listes.filter((v) => v.every(Boolean)).length;
  resume.cas_jamais_reussis = listes.filter((v) => !v.some(Boolean)).length;
  resume.cas_instables = [...parCas].filter(([, v]) => v.some(Boolean) && !v.every(Boolean)).map(([c]) => c).sort();
  const parType: Record<string, number> = {};
  for (const t of ["courant", "piege", "securite"]) {
    const groupe = essais.filter((e) => parId.get(e.cas)!.type === t);
    if (groupe.length) parType[t] = groupe.filter((e) => reussis.has(identifiant(e))).length / groupe.length;
  }
  resume.par_type = parType;
  const couts = essais.map((e) => e.cout_dollars);
  const latences = essais.filter((e) => !e.erreur).map((e) => e.latence_s);
  Object.assign(resume, {
    cout_total: arrondir(somme(couts), 4),
    cout_moyen: couts.length ? arrondir(moyenne(couts), 5) : 0,
    cout_par_reussite: reussis.size ? arrondir(somme(couts) / reussis.size, 5) : null,
    latence_mediane_s: latences.length ? arrondir(mediane(latences), 1) : null,
    latence_p90_s: latences.length ? arrondir(p90(latences), 1) : null,
    appels_moyens: essais.length ? arrondir(moyenne(essais.map((e) => e.appels.length)), 2) : 0,
  });
  return resume as unknown as Resume;
}

export function tauxParCas(essais: Essai[], cas: CasEvaluation[], jugements: Record<string, JugementEcrit> | null = null): Record<string, number> {
  const parId = new Map(cas.map((c) => [c.id, c]));
  const parCas = new Map<string, boolean[]>();
  for (const e of essais) {
    let ok = !noter(parId.get(e.cas)!, e).length;
    if (jugements !== null) ok &&= identifiant(e) in jugements && issue(jugements[identifiant(e)]!) === "reussi";
    parCas.set(e.cas, [...(parCas.get(e.cas) ?? []), ok]);
  }
  return Object.fromEntries([...parCas].map(([c, v]) => [c, v.filter(Boolean).length / v.length]));
}

/** f"{x:.0%}" en Python : 0,875 s'écrit « 88% » (la moitié au pair, sur x × 100). */
export const pourcent = (x: number): string => `${fixe(x * 100, 0)}%`;

/** str() d'une valeur du résumé : None, un entier, ou un nombre à virgule écrit comme Python. */
const ecrit = (x: unknown): string => (typeof x === "number" ? (Number.isInteger(x) && !String(x).includes("e") ? String(x) : flottant(x)) : repr(x));

export function afficher(r: Resume): string {
  const lignes = [`${r.essais} essais sur ${r.cas} cas`];
  lignes.push(`  réussite (code) : ${pourcent(r.reussite_code)}  échecs par famille : ${repr(r.echecs_par_famille)}`);
  if (r.reussite_juge !== undefined) {
    lignes.push(`  réussite (juge) : ${pourcent(r.reussite_juge)}  à relire : ${r.a_relire}  « non » par critère : ${repr(r.non_par_critere)}`);
    lignes.push(`  réussite (code et juge) : ${pourcent(r.reussite!)}`);
  }
  lignes.push(`  cas réussis à tous les essais : ${r.cas_toujours_reussis} ; jamais : ${r.cas_jamais_reussis} ; instables : ${r.cas_instables.length}`);
  lignes.push("  par type : " + Object.entries(r.par_type).map(([t, v]) => `${t} ${pourcent(v)}`).join(", "));
  const par = r.cout_par_reussite ? `${fixe(r.cout_par_reussite, 4)} $` : "—";
  lignes.push(
    `  coût : ${fixe(r.cout_total, 4)} $ au total, ${fixe(r.cout_moyen, 4)} $ par essai, ${par} par réussite` +
      (r.cout_juge !== undefined ? ` ; juge : ${fixe(r.cout_juge, 4)} $` : ""),
  );
  // Les latences sont des nombres à virgule en Python : « 2.0 » et non « 2 ».
  const latence = (x: number | null): string => (x === null ? "None" : flottant(x));
  lignes.push(`  latence : médiane ${latence(r.latence_mediane_s)} s, 90 % sous ${latence(r.latence_p90_s)} s ; ${ecrit(r.appels_moyens)} appels par essai`);
  return lignes.join("\n");
}

/** La date en UTC, à la seconde, comme datetime.now(timezone.utc).isoformat(timespec="seconds"). */
export const maintenantUtc = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

export function entreeDeRegistre(dossier: string, v: Variante, jeu: string, cas: CasEvaluation[], essais: number, resume: Resume | Record<string, never>, arrete: boolean): Record<string, unknown> {
  return {
    date: maintenantUtc(),
    serie: basename(dossier),
    variante: { ...v },
    versions: versions(v),
    jeu,
    empreinte_cas: empreinteCas(cas),
    empreinte_notation: empreinteNotation(),
    essais_par_cas: essais,
    arretee_par_le_budget: arrete,
    resume,
  };
}

/** Le nom d'une série, comme f"{datetime.now():%Y%m%d-%H%M%S}" (l'heure locale). */
export function horodatage(d = new Date()): string {
  const deux = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`;
}
