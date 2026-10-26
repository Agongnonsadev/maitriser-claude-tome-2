// Chapitre 5 : comparer la version 0 du prompt (chapitre 2) et la version 1, sur 20 cas.
//
// Une seule chose change entre les deux variantes : le prompt système (et la balise autour du message
// du client, qui va avec). Le modèle, l'effort et max_tokens sont les mêmes.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch05/evaluer_prompt.ts --estimer
//     npx tsx ch05/evaluer_prompt.ts --repetitions 3 --budget-max 1
//     npx tsx ch05/evaluer_prompt.ts --renoter     (gratuit : la grille actuelle, sur les réponses déjà obtenues)
//     npx tsx ch05/evaluer_prompt.ts --renoter --essais ../python/ch05/resultats/essais.csv

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROMPT_SYSTEME as PROMPT_V0 } from "../ch02/comptoir_cli.ts";
import { MAX_TOKENS, construireRequete } from "../comptoir/assistant.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { TARIFS } from "../comptoir/couts.ts";
import { type Essai, type Variante, ecrireCsv, evaluer, lireCsv, regressions, renoter, resumer } from "../comptoir/evaluation.ts";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { type Cas, creerCas } from "../comptoir/notation.ts";
import { charger } from "../comptoir/prompt.ts";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export function requeteV0(cas: Cas): Anthropic.MessageCreateParamsNonStreaming {
  const requete: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODELE,
    max_tokens: MAX_TOKENS,
    system: PROMPT_V0,
    messages: [{ role: "user", content: cas.question }],
  };
  if (config.EFFORT) requete.output_config = { effort: config.EFFORT as Effort };
  return requete;
}

export function requeteV1(cas: Cas): Anthropic.MessageCreateParamsNonStreaming {
  return construireRequete(cas.question, { prompt: charger("v1") });
}

export const VARIANTES: Record<string, Variante> = { v0: requeteV0, v1: requeteV1 };

/** Les 20 cas du chapitre, ceux de la version Python (python/ch05/cas.json). */
export function chargerCas(): Cas[] {
  return (JSON.parse(readFileSync(join(PYTHON, "ch05", "cas.json"), "utf8")) as Parameters<typeof creerCas>[0][]).map(creerCas);
}

export async function estimer(client: ClientMessages, cas: Cas[], repetitions: number, sortieSupposee: number): Promise<number> {
  const tarif = TARIFS[config.MODELE];
  if (!tarif) throw new Error(`Prix inconnu pour le modèle « ${config.MODELE} » : ajoutez-le dans TARIFS.`);
  let total = 0;
  for (const construire of Object.values(VARIANTES)) {
    for (const c of cas) {
      const { model, system, messages } = construire(c);
      const { input_tokens: entree } = await client.messages.countTokens({ model, system, messages });
      total += (repetitions * (entree * tarif.entree + sortieSupposee * tarif.sortie)) / 1_000_000;
    }
  }
  return total;
}

export function afficher(essais: Essai[]): void {
  for (const ligne of resumer(essais)) {
    const parReussite = ligne.coutParReussite ? `${ligne.coutParReussite.toFixed(5)} $` : "—";
    console.log(
      `${ligne.variante} : réussite ${Math.round(ligne.reussite * 100)}% · ${parReussite} par réussite · ` +
        `latence médiane ${ligne.latenceMedianeS.toFixed(1)} s`,
    );
  }
  const perdus = regressions(essais, "v0", "v1");
  console.log("Régressions de v1 par rapport à v0 :", perdus.length ? perdus.join(", ") : "aucune");
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      repetitions: { type: "string", default: "3" },
      "budget-max": { type: "string", default: "1.0" },
      estimer: { type: "boolean", default: false },
      "sortie-supposee": { type: "string", default: "250" },
      renoter: { type: "boolean", default: false },
      // Les réponses à renoter : celles de cette version par défaut ; on peut renoter celles de Python.
      essais: { type: "string", default: join(RACINE, "ch05", "resultats", "essais.csv") },
    },
  });
  const repetitions = Number(args.repetitions);

  if (args.renoter) {
    const source = resolve(args.essais);
    const essais = renoter(lireCsv(source), chargerCas());
    ecrireCsv(essais, join(RACINE, "ch05", "resultats", "essais-renotes.csv"));
    console.log(`Réponses relues dans ${source}`);
    afficher(essais);
    return;
  }

  const client = new Anthropic();
  const cas = chargerCas();
  console.log(`Modèle : ${config.MODELE} · effort : ${config.EFFORT ?? "défaut"} · prompt v1 : ${charger("v1").identifiant}`);
  if (args.estimer) {
    const total = await estimer(client, cas, repetitions, Number(args["sortie-supposee"]));
    console.log(`Coût estimé : ${total.toFixed(2)} $ (${cas.length} cas × 2 versions × ${repetitions} répétitions)`);
    return;
  }

  const essais = await evaluer(client, cas, VARIANTES, repetitions, Number(args["budget-max"]));
  ecrireCsv(essais, join(RACINE, "ch05", "resultats", "essais.csv"));
  afficher(essais);
}

if (estLance(import.meta.url)) await main();
