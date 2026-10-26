// Chapitre 12 : Claude Haiku 5.5 réfléchit-il quand on le lui interdit ? Sept requêtes, une question.
//
// La même question, posée sept fois à Claude Haiku 5.5 avec max_tokens 1 000 : sans document, avec la base
// d'Awa en blocs search_result (citations activées ou non), puis en texte brut. On relève les tokens de
// réflexion et la raison de l'arrêt. Coût : moins d'un centime.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch12/reflexion_et_citations.ts

import Anthropic from "@anthropic-ai/sdk";
import { type Morceau, chargerBase } from "../comptoir/connaissances.ts";
import { cout } from "../comptoir/couts.ts";
import { chargerPrompt, construireRequete } from "../comptoir/documentaire.ts";
import { noter } from "../comptoir/journal.ts";
import { estLance } from "../comptoir/lancement.ts";
import { messageClient } from "../comptoir/prompt.ts";

const MODELE = "claude-haiku-5-5";
const QUESTION = "Je confirme ma commande samedi à 15 h : je suis livré quand ?";
type Requete = Anthropic.MessageCreateParamsNonStreaming;

export function cas(base: Morceau[]): [string, Requete][] {
  const documents = (citations: boolean, effort: "low" | null = null, desactivee = true): Requete => {
    const r = construireRequete(QUESTION, base, { cache: "1h", modele: MODELE, maxTokens: 1000, sansReflexion: desactivee, avecCitations: citations });
    if (effort) r.output_config = { effort };
    return r;
  };
  const seule: Requete = {
    model: MODELE,
    max_tokens: 1000,
    system: chargerPrompt().texte,
    messages: [{ role: "user", content: messageClient(QUESTION) }],
  };
  const texte = base.map((m) => `## ${m.titre}\n${m.texte}`).join("\n\n");
  const brut: Requete = { ...seule, messages: [{ role: "user", content: `<documents>\n${texte}\n</documents>\n\n` + messageClient(QUESTION) }] };
  return [
    ["sans document, réflexion désactivée", { ...seule, thinking: { type: "disabled" } }],
    ["sans document, effort low", { ...seule, output_config: { effort: "low" } }],
    ["search_result avec citations, désactivée", documents(true)],
    ["search_result avec citations, effort low", documents(true, "low", false)],
    ["search_result avec citations, désactivée et low", documents(true, "low")],
    ["search_result sans citations, désactivée", documents(false)],
    ["base en texte brut, désactivée", { ...brut, thinking: { type: "disabled" } }],
  ];
}

async function main(): Promise<void> {
  const client = new Anthropic();
  let total = 0;
  for (const [nom, requete] of cas(chargerBase())) {
    const reponse = await client.messages.create(requete);
    const prix = cout(MODELE, reponse.usage);
    total += prix.dollars;
    noter(reponse._request_id, MODELE, prix, { prompt: "ch12-reflexion", stop_reason: reponse.stop_reason });
    const reflexion = reponse.usage.output_tokens_details?.thinking_tokens || 0;
    console.log(`${nom.padEnd(50)} réflexion ${String(reflexion).padStart(4)} tokens  sortie ${String(reponse.usage.output_tokens).padStart(4)}  arrêt ${reponse.stop_reason}`);
  }
  console.log(`\nCoût : ${total.toFixed(4)} $`);
}

if (estLance(import.meta.url)) await main();
