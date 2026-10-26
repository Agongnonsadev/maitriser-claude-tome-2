// Chapitre 11 : les mêmes questions, sans cache puis avec, et ce que dit le champ usage.
//
// Trois expériences :
// 1. un prompt trop court pour le cache : aucune erreur, mais rien n'est mis en cache ;
// 2. cinq questions, toute la base dans la requête, sans cache ;
// 3. les mêmes, avec un point de cache après la base, précédées d'un préchauffage (max_tokens=0).
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch11/cache_avant_apres.ts --budget-max 0.5

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import type { ClientMessages } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { type Cout, cout } from "../comptoir/couts.ts";
import { chargerPrompt, construireRequete } from "../comptoir/documentaire.ts";
import { noter } from "../comptoir/journal.ts";
import { chargerQuestions } from "./outils_communs.ts";

const ENTETE =
  `${"série".padEnd(10)} ${"n°".padStart(3)} ${"entrée".padStart(7)} ${"écrit".padStart(7)} ${"lu".padStart(7)} ` +
  `${"sortie".padStart(7)} ${"coût ($)".padStart(9)} ${"durée".padStart(7)}`;

const ligne = (serie: string, numero: number, prix: Cout, duree: number): string =>
  `${serie.padEnd(10)} ${String(numero).padStart(3)} ${String(prix.entree).padStart(7)} ${String(prix.ecritureCache).padStart(7)} ` +
  `${String(prix.lectureCache).padStart(7)} ${String(prix.sortie).padStart(7)} ${prix.dollars.toFixed(5).padStart(9)} ${duree.toFixed(1).padStart(6)}s`;

async function appeler(client: ClientMessages, requete: Anthropic.MessageCreateParamsNonStreaming, etiquette: string): Promise<[Cout, number]> {
  const debut = performance.now();
  const message = await client.messages.create(requete);
  const duree = (performance.now() - debut) / 1000;
  const prix = cout(requete.model, message.usage);
  noter(message._request_id, requete.model, prix, { prompt: etiquette });
  return [prix, duree];
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { questions: { type: "string", default: "5" }, "budget-max": { type: "string", default: "0.5" } } });
  const budgetMax = Number(args["budget-max"]);
  const client = new Anthropic();
  const base = chargerBase();
  const prompt = chargerPrompt();
  const questions = chargerQuestions().slice(0, Number(args.questions)).map((c) => c.question);
  let depense = 0;

  console.log("1. Un prompt trop court pour le cache");
  const court: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODELE,
    max_tokens: 50,
    system: [{ type: "text", text: "Tu es le Comptoir de Délices d'Awa.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Bonjour" }],
  };
  let [prix, duree] = await appeler(client, court, "trop-court");
  depense += prix.dollars;
  console.log(
    `   écrit en cache : ${prix.ecritureCache}, lu dans le cache : ${prix.lectureCache}, entrée : ${prix.entree} ` +
      "(en dessous de la longueur minimale, le point de cache est ignoré, sans erreur)\n",
  );

  console.log(ENTETE);
  const totaux: Record<string, number> = {};
  for (const [serie, cache] of [["sans cache", false], ["avec cache", true]] as const) {
    let total = 0;
    if (cache) {
      // Préchauffage : la base est écrite dans le cache avant la première vraie question.
      const prechauffage = construireRequete("préchauffage", base, { prompt, cache: true });
      prechauffage.max_tokens = 0;
      [prix, duree] = await appeler(client, prechauffage, "prechauffage");
      console.log(ligne("préchauff.", 0, prix, duree));
      total += prix.dollars;
    }
    for (const [i, question] of questions.entries()) {
      if (depense + total >= budgetMax) {
        console.log(`Budget de ${budgetMax} $ atteint : arrêt.`);
        return;
      }
      [prix, duree] = await appeler(client, construireRequete(question, base, { prompt, cache }), `${prompt.identifiant}/${serie}`);
      console.log(ligne(serie, i + 1, prix, duree));
      total += prix.dollars;
    }
    totaux[serie] = total;
    depense += total;
  }
  console.log(
    `\nTotal sans cache : ${totaux["sans cache"]!.toFixed(4)} $ ; avec cache, préchauffage compris : ` +
      `${totaux["avec cache"]!.toFixed(4)} $ ; dépense du script : ${depense.toFixed(4)} $`,
  );
}

await main();
