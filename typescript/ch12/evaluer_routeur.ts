// Chapitre 12 : le routeur classe-t-il bien ? 30 messages, plusieurs réglages, plusieurs passes.
//
// Pour chaque réglage : la réussite, les réclamations manquées (le seul échec interdit), le coût et la
// durée par message. Le vote à trois est calculé à partir des trois passes, sans appel de plus. Les 30
// messages sont ceux de la version Python (python/ch12/messages.json).
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch12/evaluer_routeur.ts --repetitions 3 --budget-max 0.5

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { arrondir, fixe } from "../comptoir/arrondi.ts";
import { ecrireCsv } from "../comptoir/csv.ts";
import { PYTHON, RACINE, estLance, plusieursValeurs } from "../comptoir/lancement.ts";
import { type Decision, type OptionsClassement, RoutageImpossible, classer, parLeCode, voter } from "../comptoir/routeur.ts";

export interface MessageDeTest {
  id: string;
  message: string;
  attendu: string;
}

const REGLAGES: Record<string, OptionsClassement & { modele: string }> = {
  haiku: { modele: "claude-haiku-5-5" },
  "haiku-sans-reflexion": { modele: "claude-haiku-5-5", sansReflexion: true },
  "sonnet-low": { modele: "claude-sonnet-5-5", effort: "low" },
};

export function chargerMessages(): MessageDeTest[] {
  return JSON.parse(readFileSync(join(PYTHON, "ch12", "messages.json"), "utf8")) as MessageDeTest[];
}

/** Une ligne de resultats/routage.csv : les mêmes colonnes que dans la version Python. */
interface Ligne {
  reglage: string;
  id: string;
  passe: number;
  attendu: string;
  obtenu: string;
  raison: string;
  par: string;
  cout_dollars: number;
  duree_s: number;
}

const moyenne = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
const mediane = (valeurs: number[]): number => {
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 ? tries[milieu]! : (tries[milieu - 1]! + tries[milieu]!) / 2;
};

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: plusieursValeurs(["reglages"]),
    options: {
      reglages: { type: "string", multiple: true, default: Object.keys(REGLAGES) },
      repetitions: { type: "string", default: "3" },
      "budget-max": { type: "string", default: "0.5" },
    },
  });
  const inconnus = args.reglages.filter((r) => !(r in REGLAGES));
  if (inconnus.length) throw new Error(`--reglages : ${inconnus.join(", ")} ? Choix : ${Object.keys(REGLAGES).join(", ")}.`);
  const repetitions = Number(args.repetitions);
  const budgetMax = Number(args["budget-max"]);

  const client = new Anthropic();
  const messages = chargerMessages();
  const lignes: Ligne[] = [];
  let depense = 0;
  for (const nom of args.reglages) {
    for (const m of messages) {
      for (let passe = 1; passe <= repetitions; passe++) {
        if (depense >= budgetMax) {
          console.error(`Budget de ${budgetMax} $ atteint : arrêt.`); // SystemExit en Python : rien n'est écrit
          process.exit(1);
        }
        const debut = performance.now();
        let decision: Decision;
        try {
          decision = parLeCode(m.message) ?? (await classer(client, m.message, REGLAGES[nom]!));
        } catch (erreur) {
          if (!(erreur instanceof RoutageImpossible)) throw erreur;
          decision = { categorie: "erreur", raison: erreur.message, par: REGLAGES[nom]!.modele, cout: 0 }; // compté comme une erreur de classement
        }
        const duree = (performance.now() - debut) / 1000;
        depense += decision.cout;
        lignes.push({
          reglage: nom, id: m.id, passe, attendu: m.attendu, obtenu: decision.categorie, raison: decision.raison,
          par: decision.par, cout_dollars: arrondir(decision.cout, 6), duree_s: arrondir(duree, 2),
        });
      }
    }
  }

  const sortie = join(RACINE, "ch12", "resultats", "routage.csv");
  ecrireCsv(lignes, ["reglage", "id", "passe", "attendu", "obtenu", "raison", "par", "cout_dollars", "duree_s"], sortie, ["cout_dollars", "duree_s"]);

  console.log(
    `${"réglage".padEnd(22)} ${"réussite".padStart(9)} ${"vote à 3".padStart(9)} ${"récl. manquées".padStart(15)} ` +
      `${"coût/message".padStart(13)} ${"durée méd.".padStart(11)}`,
  );
  for (const nom of args.reglages) {
    const g = lignes.filter((l) => l.reglage === nom);
    const justes = g.filter((l) => l.obtenu === l.attendu).length;
    const votes = new Map<string, string>();
    for (const m of messages) {
      const passes = g.filter((l) => l.id === m.id && l.obtenu !== "erreur").map((l) => ({ categorie: l.obtenu }));
      votes.set(m.id, passes.length ? voter(passes) : "erreur");
    }
    const voteJuste = messages.filter((m) => votes.get(m.id) === m.attendu).length;
    const manquees = g.filter((l) => l.attendu === "reclamation" && l.obtenu !== "reclamation").length;
    const appels = g.filter((l) => l.par !== "code");
    console.log(
      `${nom.padEnd(22)} ${String(justes).padStart(4)}/${String(g.length).padEnd(4)} ${String(voteJuste).padStart(4)}/${String(messages.length).padEnd(4)} ` +
        `${String(manquees).padStart(15)} ${fixe(moyenne(appels.map((l) => l.cout_dollars)), 6).padStart(13)} ` +
        `${fixe(mediane(appels.map((l) => l.duree_s)), 1).padStart(10)}s`,
    );
    const erreurs = new Map<string, number>();
    for (const l of g) if (l.obtenu !== l.attendu) erreurs.set(JSON.stringify([l.id, l.attendu, l.obtenu]), (erreurs.get(JSON.stringify([l.id, l.attendu, l.obtenu])) ?? 0) + 1);
    const tries = [...erreurs].map(([cle, n]) => [JSON.parse(cle) as string[], n] as const).sort(([a], [b]) => (a.join("\0") < b.join("\0") ? -1 : 1));
    for (const [[identifiant, attendu, obtenu], n] of tries) console.log(`${"".padEnd(22)}   ${identifiant} : ${attendu} → ${obtenu} (${n} fois sur ${repetitions})`);
  }
  console.log(`\nDépense : ${depense.toFixed(4)} $ ; détail : ${sortie}`);
}

if (estLance(import.meta.url)) await main();
