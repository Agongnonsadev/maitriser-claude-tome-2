// Chapitre 13 : une séance de l'agent de réapprovisionnement, avec sa trace, son bon et ses critères.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch13/reapprovisionner.ts
// Variantes :  --sans-sous-agent   --modele claude-haiku-5-5   --memoire memoire_atelier
//              --budget-de-tache 40000   --effacer-apres 8000   --compacter-apres-tour 2
//              --tours-max 3   --budget-max 0.05

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { type ClientAgent, Garde, type Reglages, lancer, reglages } from "../comptoir/agent_reappro.ts";
import { fixe } from "../comptoir/arrondi.ts";
import { Atelier, rendreBon } from "../comptoir/atelier.ts";
import { config } from "../comptoir/config.ts";
import { estLance } from "../comptoir/lancement.ts";
import { repr } from "../comptoir/python.ts";
import { criteres } from "./criteres.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Les options communes aux scripts qui lancent l'agent. */
export const OPTIONS = {
  modele: { type: "string", default: config.MODELE },
  effort: { type: "string" },
  "sans-sous-agent": { type: "boolean", default: false }, // l'agent lit lui-même tous les messages
  memoire: { type: "string" }, //                          dossier de la mémoire de l'agent, gardé d'une semaine à l'autre
  "budget-de-tache": { type: "string" }, //                 en tokens, 20 000 au moins (bêta)
  "effacer-apres": { type: "string" }, //                   efface les anciens résultats d'outils au-delà de N tokens
  "compacter-apres-tour": { type: "string" }, //            résume la séance après ce tour (bêta)
  "tours-max": { type: "string", default: "20" },
  "budget-max": { type: "string", default: "0.50" }, //    en dollars, pour la séance
  delai: { type: "string", default: "300" }, //             en secondes, pour la séance
} as const;

type Valeurs = { [K in keyof typeof OPTIONS]?: string | boolean };

export function reglagesEtGarde(args: Valeurs): [Reglages, Garde] {
  const entier = (v: unknown): number | null => (v === undefined ? null : Number.parseInt(String(v), 10));
  if (args.effort !== undefined && !EFFORTS.includes(String(args.effort))) throw new Error(`--effort : ${EFFORTS.join(", ")}.`);
  return [
    reglages({
      modele: String(args.modele),
      effort: (args.effort as Reglages["effort"]) ?? null,
      sousAgent: !args["sans-sous-agent"],
      memoire: (args.memoire as string | undefined) ?? null,
      budgetDeTache: entier(args["budget-de-tache"]),
      effacerResultatsApres: entier(args["effacer-apres"]),
      compacterApresTour: entier(args["compacter-apres-tour"]),
    }),
    new Garde({ toursMax: Number(args["tours-max"]), budgetDollars: Number(args["budget-max"]), delaiS: Number(args.delai) }),
  ];
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { ...OPTIONS, bons: { type: "string" } } }); // bons : le fichier des bons proposés
  const [r, garde] = reglagesEtGarde(args);
  if (r.memoire) mkdirSync(r.memoire, { recursive: true });
  const resultat = await lancer(new Anthropic() as unknown as ClientAgent, new Atelier({ bons: args.bons ?? null }), r, garde);
  console.log(resultat.trace.afficher());
  console.log(
    `\nArrêt : ${resultat.arret || "terminé par l agent"} ; ${resultat.tours} tours ; ${fixe(resultat.depense, 4)} $ ` +
      `(dont sous-agent ${fixe(resultat.coutSousAgent, 4)} $) ; ${fixe(resultat.dureeS, 1)} s ; ` +
      `plus gros contexte : ${resultat.picContexte} tokens`,
  );
  if (resultat.effacements.length) console.log(`Effacements : ${repr(resultat.effacements)}`);
  console.log("\n" + (resultat.bon ? rendreBon(resultat.bon) : "Aucun bon proposé."));
  console.log("\nRésumé de l'agent :\n" + resultat.texte);
  console.log("\nCritères : " + Object.entries(criteres(resultat.bon, r.memoire !== null)).map(([k, v]) => `${k} ${v ? "oui" : "NON"}`).join(", "));
}

if (estLance(import.meta.url)) await main();
