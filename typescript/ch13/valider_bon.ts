// Chapitre 13 : Awa valide ou refuse un bon proposé par l'agent, et peut lui laisser un retour.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch13/valider_bon.ts --bons bons.json --lister
//     npx tsx ch13/valider_bon.ts --bons bons.json BC-1a2b3c --valider
//     npx tsx ch13/valider_bon.ts --bons bons.json BC-1a2b3c --refuser --note "..." --memoire memoire_atelier
//
// La décision ne passe par aucun modèle : c'est le seul chemin qui fasse sortir un bon de « à valider ».
// La note, si un dossier de mémoire est donné, est ajoutée au fichier que l'agent lira lundi prochain.
// C'est le code qui l'écrit, pas l'agent.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Atelier, rendreBon } from "../comptoir/atelier.ts";
import { estLance } from "../comptoir/lancement.ts";

export const FICHIER_RETOURS = "retours-awa.md";

export function laisserUnRetour(memoire: string, code: string, decision: string, note: string, jour: string): string {
  // L'outil mémoire du SDK sert le sous-dossier « memories » du dossier donné : c'est là qu'il faut écrire.
  const racine = join(memoire, "memories");
  mkdirSync(racine, { recursive: true });
  const chemin = join(racine, FICHIER_RETOURS);
  if (!existsSync(chemin)) writeFileSync(chemin, "# Retours d'Awa sur les bons de commande\n\n", "utf8");
  appendFileSync(chemin, `- ${jour}, bon ${code} ${decision} : ${note}\n`, "utf8");
  return chemin;
}

/** parser.error() d'argparse : le message, puis la sortie avec le code 2. */
function erreurDUsage(message: string): never {
  console.error(`usage : valider_bon --bons BONS [code] [--valider | --refuser | --lister] [--note NOTE] [--memoire MEMOIRE]\nerreur : ${message}`);
  process.exit(2);
}

function main(): void {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bons: { type: "string" },
      valider: { type: "boolean", default: false },
      refuser: { type: "boolean", default: false },
      lister: { type: "boolean", default: false },
      note: { type: "string" },
      memoire: { type: "string" }, // le dossier de mémoire de l'agent
    },
  });
  if (!args.bons) erreurDUsage("l'option --bons est obligatoire");
  if ([args.valider, args.refuser, args.lister].filter(Boolean).length > 1) erreurDUsage("--valider, --refuser et --lister s'excluent");
  const code = positionals[0];
  const atelier = new Atelier({ bons: args.bons });
  if (args.lister || !code) {
    for (const bon of atelier.bons()) console.log(rendreBon(bon) + "\n");
    return;
  }
  if (!(args.valider || args.refuser)) erreurDUsage("--valider ou --refuser");
  const bon = atelier.decider(code, args.valider, args.note ?? null);
  console.log(rendreBon(bon));
  if (args.note && args.memoire) console.log(`Retour laissé dans ${laisserUnRetour(args.memoire, bon.code, bon.statut, args.note, atelier.aujourdhui)}`);
}

if (estLance(import.meta.url)) main();
