// Chapitre 6 : trois clients écrivent en même temps. L'un après l'autre, puis ensemble.
//
// Le SDK est asynchrone : le serveur n'attend pas la réponse de Claude les bras croisés ; pendant
// qu'une réponse arrive, il en lance une autre. La limite borne le nombre d'appels simultanés, pour
// rester sous les limites de débit de l'organisation.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch06/trois_clients.ts
// Coût : six appels courts (trois questions, deux fois).

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { construireRequete } from "../comptoir/assistant.ts";
import { config } from "../comptoir/config.ts";
import { cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { type PromptSysteme, charger } from "../comptoir/prompt.ts";

const QUESTIONS = [
  "Bonjour, livrez-vous à Akpakpa ?",
  "Combien coûtent 6 bouteilles de bissap ?",
  "Le sirop de gingembre se garde combien de temps ?",
];

const APPELS_SIMULTANES_MAX = 2;

/** Au plus `maximum` tâches à la fois, comme asyncio.Semaphore en Python. */
function limite(maximum: number) {
  let enCours = 0;
  const attente: (() => void)[] = [];
  return async <T>(tache: () => Promise<T>): Promise<T> => {
    if (enCours >= maximum) await new Promise<void>((ok) => attente.push(ok));
    enCours++;
    try {
      return await tache();
    } finally {
      enCours--;
      attente.shift()?.();
    }
  };
}

async function repondre(client: Anthropic, question: string, prompt: PromptSysteme): Promise<number> {
  const requete = construireRequete(question, { prompt });
  const message = await client.messages.create(requete);
  const prix = cout(requete.model, message.usage);
  noter(message._request_id, requete.model, prix, { prompt: prompt.identifiant });
  return prix.dollars;
}

const client = new Anthropic({ timeout: config.DELAI_S * 1000 });
const prompt = charger();
const somme = (couts: number[]) => couts.reduce((a, b) => a + b, 0).toFixed(4);

let depart = performance.now();
const uneAUne = limite(1);
let couts: number[] = [];
for (const q of QUESTIONS) couts.push(await uneAUne(() => repondre(client, q, prompt)));
console.log(`L'une après l'autre : ${((performance.now() - depart) / 1000).toFixed(1)} s, ${somme(couts)} $`);

depart = performance.now();
const ensemble = limite(APPELS_SIMULTANES_MAX);
couts = await Promise.all(QUESTIONS.map((q) => ensemble(() => repondre(client, q, prompt))));
console.log(`Ensemble (au plus ${APPELS_SIMULTANES_MAX} à la fois) : ${((performance.now() - depart) / 1000).toFixed(1)} s, ${somme(couts)} $`);
