// Chapitre 11 : un cache qui ne sert jamais, et l'API qui dit pourquoi (diagnostic du cache).
//
// Erreur volontaire : l'heure est écrite dans le prompt système. Le début de la requête change donc à
// chaque appel, et le cache est réécrit à chaque fois. Le diagnostic du cache le signale
// (system_changed). Puis la correction : l'heure passe après le point de cache, dans le message.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch11/diagnostiquer_cache.ts
// Coût : quatre appels avec toute la base, dont trois écritures dans le cache.

import Anthropic from "@anthropic-ai/sdk";
import { setTimeout as attendre } from "node:timers/promises";
import { config } from "../comptoir/config.ts";
import { type Morceau, blocsResultats, chargerBase } from "../comptoir/connaissances.ts";
import { cout } from "../comptoir/couts.ts";
import { chargerPrompt } from "../comptoir/documentaire.ts";
import { noter } from "../comptoir/journal.ts";
import { messageClient } from "../comptoir/prompt.ts";

type Requete = Anthropic.Beta.MessageCreateParamsNonStreaming;

function requete(promptSysteme: string, question: string, base: Morceau[], precedent: string | null): Requete {
  return {
    model: config.MODELE,
    max_tokens: 300,
    system: promptSysteme,
    messages: [{ role: "user", content: [...blocsResultats(base, true), { type: "text", text: messageClient(question) }] }],
    diagnostics: { previous_message_id: precedent },
  };
}

async function lancer(client: Anthropic, etiquette: string, req: Requete): Promise<Anthropic.Beta.BetaMessage> {
  const message = await client.beta.messages.create(req);
  const prix = cout(req.model, message.usage);
  noter(message._request_id, req.model, prix, { prompt: etiquette });
  const raison = message.diagnostics ? message.diagnostics.cache_miss_reason : null;
  let detail = raison === null ? "aucune divergence" : raison.type;
  if (raison && "cache_missed_input_tokens" in raison && raison.cache_missed_input_tokens != null) {
    detail += ` (${raison.cache_missed_input_tokens} tokens perdus, estimation)`;
  }
  console.log(
    `${etiquette.padEnd(28)} écrit ${String(prix.ecritureCache).padStart(6)}  lu ${String(prix.lectureCache).padStart(6)}  ` +
      `${prix.dollars.toFixed(4)} $  diagnostic : ${detail}`,
  );
  return message;
}

/** L'heure locale, comme datetime.now().strftime("%d/%m/%Y %H:%M:%S"). */
function maintenant(): string {
  const d = new Date();
  const deux = (n: number): string => String(n).padStart(2, "0");
  return `${deux(d.getDate())}/${deux(d.getMonth() + 1)}/${d.getFullYear()} ${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`;
}

const client = new Anthropic();
const base = chargerBase();
const prompt = chargerPrompt().texte;
const question = "Vous livrez le dimanche ?";

console.log("L'erreur : l'heure dans le prompt système");
const m1 = await lancer(client, "1. heure dans le système", requete(`${prompt}\n\nNous sommes le ${maintenant()}.`, question, base, null));
await attendre(2000);
const m2 = await lancer(client, "2. même erreur", requete(`${prompt}\n\nNous sommes le ${maintenant()}.`, question, base, m1.id));

console.log("\nLa correction : l'heure après le point de cache, dans le message du client");
const m3 = await lancer(client, "3. système stable", requete(prompt, `(Nous sommes le ${maintenant()}.) ${question}`, base, m2.id));
await attendre(2000);
await lancer(client, "4. système stable, à nouveau", requete(prompt, `(Nous sommes le ${maintenant()}.) ${question}`, base, m3.id));
