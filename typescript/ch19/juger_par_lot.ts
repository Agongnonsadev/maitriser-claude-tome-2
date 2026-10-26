// Chapitre 19 : le juge du chapitre 17, par la Batch API. La moitié du prix, et la même note ?
//
// Depuis le dossier typescript/ :
//     npx tsx ch19/juger_par_lot.ts <série> --estimer                        (gratuit)
//     npx tsx ch19/juger_par_lot.ts <série> --attente-max 3600               (PAYANT, un lot)
//     npx tsx ch19/juger_par_lot.ts <série> --relire <lot>                   (gratuit : relire un lot fini)
//     npx tsx ch19/juger_par_lot.ts <série> --comparer                       (gratuit : le fichier du lot, sans appel)
//
// Les jugements d'une série du chapitre 17 ne pressent pas : ils se font la nuit, ou pendant que Yao
// fait autre chose. Chaque jugement devient une requête du lot, identique à celle du juge en direct
// (ch17/juge.ts), documents en cache compris : la documentation prévient que le cache, dans un lot, ne
// sert qu'« au mieux », les requêtes passant dans n'importe quel ordre. Le script écrit les jugements à
// côté de ceux du juge en direct (jugements-<modèle>-<grille>-lot.jsonl) et compare : le coût, la durée,
// et l'accord entre les deux juges, puisque le même juge ne rend pas deux fois exactement la même note.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { parseArgs } from "node:util";
import { arrondir, fixe } from "../comptoir/arrondi.ts";
import { texteDe } from "../comptoir/client.ts";
import { cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { estLance } from "../comptoir/lancement.ts";
import { jsonPython, somme } from "../comptoir/python.ts";
import { identifiant } from "../ch17/banc.ts";
import * as juge from "../ch17/juge.ts";
import { type JugementEcrit, chargerCas, issue, ligneJson, lireJugements, lireSerie } from "../ch17/suite.ts";
import type { ClientLots } from "./resume_du_soir.ts";

const PRIX_SUPPOSE = 0.0002; // $ par jugement par lot, large (0,0004 $ en direct au chapitre 17)

/** custom_id : lettres, chiffres, tirets et soulignés, 64 caractères au plus. */
export const identifiantLot = (essai: string): string => essai.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);

export function requetes(dossier: string, modele: string): [{ custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[], Record<string, string>] {
  const cas = new Map(chargerCas().map((c) => [c.id, c]));
  const grille = juge.chargerGrille();
  const demandes: { custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[] = [];
  const correspondance: Record<string, string> = {};
  for (const essai of lireSerie(dossier)) {
    if (essai.erreur) continue;
    const cle = identifiantLot(identifiant(essai));
    // Deux essais réduits au même custom_id : leurs résultats se mélangeraient.
    if (cle in correspondance) throw new Error(`custom_id en double : ${cle}`);
    correspondance[cle] = identifiant(essai);
    demandes.push({ custom_id: cle, params: juge.requete(cas.get(essai.cas)!, essai, modele, grille) });
  }
  return [demandes, correspondance];
}

export async function lireResultats(client: ClientLots, lot: string, correspondance: Record<string, string>, modele: string): Promise<juge.Jugement[]> {
  const grille = juge.chargerGrille();
  const jugements: juge.Jugement[] = [];
  for await (const entree of await client.messages.batches.results(lot)) {
    const j: juge.Jugement = { essai: correspondance[entree.custom_id]!, modele, grille: grille.identifiant, verdicts: {}, constats: {}, cout_dollars: 0, erreur: null };
    if (entree.result.type !== "succeeded") {
      j.erreur = `lot : ${entree.result.type}`;
      jugements.push(j);
      continue;
    }
    const message = entree.result.message!;
    const prix = cout(modele, message.usage, true);
    noter(message.id, modele, prix, { prompt: grille.identifiant, stop_reason: message.stop_reason, lot });
    j.cout_dollars = arrondir(prix.dollars, 6);
    if (message.stop_reason !== "end_turn") {
      j.erreur = `jugement arrêté par ${message.stop_reason}`;
    } else {
      const donnees = JSON.parse(texteDe(message)) as Record<string, { constat: string; verdict: string }>;
      for (const c of juge.CRITERES) {
        j.verdicts[c] = donnees[c]!.verdict;
        j.constats[c] = donnees[c]!.constat;
      }
    }
    jugements.push(j);
  }
  return jugements;
}

/** Un jugement relu d'un fichier, sans les champs calculés qu'on y a écrits (« issue »). */
export function jugement(donnees: Partial<juge.Jugement> & { essai: string }): juge.Jugement {
  return { modele: "", grille: "", verdicts: {}, constats: {}, cout_dollars: 0, erreur: null, ...donnees };
}

export function comparer(parLot: juge.Jugement[], enDirect: Record<string, JugementEcrit>): Record<string, unknown> {
  const communs = parLot.filter((j) => j.essai in enDirect && !j.erreur);
  const memeIssue = communs.filter((j) => issue(j) === issue(jugement(enDirect[j.essai]!))).length;
  // Comme verdicts.get(c) == …get(c) en Python : deux verdicts absents comptent comme le même.
  const criteres = communs.reduce((n, j) => n + juge.CRITERES.filter((c) => (j.verdicts[c] ?? null) === (enDirect[j.essai]!.verdicts[c] ?? null)).length, 0);
  return {
    jugements_compares: communs.length,
    meme_issue: memeIssue,
    memes_verdicts: `${criteres} sur ${communs.length * juge.CRITERES.length}`,
    cout_par_lot: arrondir(somme(parLot.map((j) => j.cout_dollars)), 4),
    cout_en_direct: arrondir(somme(communs.map((j) => enDirect[j.essai]!.cout_dollars)), 4),
    erreurs_par_lot: parLot.filter((j) => j.erreur).map((j) => j.erreur),
  };
}

function ecrireBilan(dossier: string, modele: string, entete: Record<string, unknown>, jugements: juge.Jugement[]): number {
  const bilan = { ...entete, ...comparer(jugements, lireJugements(dossier, modele, juge.GRILLE)) };
  console.log(jsonPython(bilan, 1));
  writeFileSync(join(dossier, `lot-${modele}-${juge.GRILLE}.json`), jsonPython(bilan, 1), "utf8");
  return 0;
}

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      modele: { type: "string", default: "claude-haiku-5-5" },
      estimer: { type: "boolean", default: false },
      "attente-max": { type: "string", default: "3600" },
      relire: { type: "string" }, //                      un lot déjà lancé
      comparer: { type: "boolean", default: false }, //   le fichier du lot déjà lu, sans appel
    },
  });
  const dossier = positionals[0];
  if (!dossier) throw new Error("La série à juger : npx tsx ch19/juger_par_lot.ts <série>.");
  const [demandes, correspondance] = requetes(dossier, args.modele);
  console.log(`${demandes.length} jugements ; estimation large : ${fixe(demandes.length * PRIX_SUPPOSE, 3)} $`);
  if (args.estimer) return 0;
  const sortie = join(dossier, `jugements-${args.modele}-${juge.GRILLE}-lot.jsonl`);
  if (args.comparer) {
    if (!existsSync(sortie)) throw new Error(`Aucun fichier du lot : ${sortie}`);
    const jugements = readFileSync(sortie, "utf8").split("\n").filter((l) => l.trim()).map((l) => jugement(JSON.parse(l)));
    return ecrireBilan(dossier, args.modele, { lot: null, duree_s: null }, jugements);
  }

  const { creerClient } = await import("../comptoir/appel.ts");
  const client = creerClient() as unknown as ClientLots;
  const debut = performance.now();
  let lot = args.relire;
  if (!lot) {
    lot = (await client.messages.batches.create({ requests: demandes })).id;
    console.log(`Lot ${lot} créé.`);
    for (let etat = await client.messages.batches.retrieve(lot); etat.processing_status !== "ended"; etat = await client.messages.batches.retrieve(lot)) {
      const ecoule = (performance.now() - debut) / 1000;
      if (ecoule > Number(args["attente-max"])) {
        console.log(`Pas fini après ${Number(args["attente-max"]).toFixed(0)} s ; relancez avec --relire ${lot}`);
        return 1;
      }
      console.log(`  ${ecoule.toFixed(0).padStart(5)} s : ${JSON.stringify(etat.request_counts)}`);
      await attendre(30_000);
    }
  }
  const duree = arrondir((performance.now() - debut) / 1000, 1);
  const jugements = await lireResultats(client, lot, correspondance, args.modele);
  writeFileSync(sortie, jugements.map((j) => ligneJson(j) + "\n").join(""), "utf8");
  return ecrireBilan(dossier, args.modele, { lot, duree_s: args.relire ? null : duree }, jugements);
}

if (estLance(import.meta.url)) process.exitCode = await main();
