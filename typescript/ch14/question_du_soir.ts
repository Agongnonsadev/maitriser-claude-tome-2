// Chapitre 14 : la question du soir d'Awa, posée au Comptoir, qui lit la base par un serveur MCP local.
//
// Lancement, depuis le dossier typescript/ (APPEL PAYANT) :
//     npx tsx ch14/question_du_soir.ts
//     npx tsx ch14/question_du_soir.ts "Quel jus s'est le mieux vendu à Fidjrossè en septembre ?"
//
// Le connecteur MCP de l'API ne joint que des serveurs distants, en HTTP. Pour un serveur local, qui parle
// par stdio, c'est votre code qui est le client MCP : il lance DBHub, lui demande ses outils, et le SDK les
// convertit pour le Tool Runner (mcpTools, de @anthropic-ai/sdk/helpers/beta/mcp). Claude écrit les requêtes
// SQL ; la base fait les comptes ; DBHub refuse toute écriture.

import Anthropic from "@anthropic-ai/sdk";
import { type MCPClientLike, mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { parseArgs } from "node:util";
import { fixe } from "../comptoir/arrondi.ts";
import { config } from "../comptoir/config.ts";
import { cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { estLance } from "../comptoir/lancement.ts";
import { jsonPython } from "../comptoir/python.ts";
import { commandes, connecter } from "./serveurs.ts";

export const QUESTION =
  "Combien de bouteilles de jus de bissap avons-nous vendues la semaine dernière, du lundi 12 au " +
  "dimanche 18 octobre, et dans quels quartiers surtout ?";

// Ce que Yao a appris en explorant la base avec Claude Code devient le contexte du Comptoir : moins de tours
// pour retrouver le schéma, donc moins de tokens.
export const SYSTEME = `Tu es le Comptoir, l'assistant de Délices d'Awa. Awa te pose une question sur ses ventes ; tu y réponds avec l'outil execute_sql, sur une base SQLite en lecture seule.

La base :
- une commande (table commandes) est un récapitulatif confirmé (table recapitulatifs, colonne statut = 'confirme') ; commandes.recapitulatif = recapitulatifs.id ;
- les produits d'un récapitulatif sont dans recapitulatifs.lignes, du JSON : [{"produit": ..., "quantite": ..., "prix_unitaire": ...}] ; lis-les avec json_each ;
- le quartier du client est recapitulatifs.quartier ; les dates (cree_le) sont en heure de Cotonou (+01:00) ;
- les montants sont en FCFA.

Règles :
- les chiffres viennent de la base : fais faire les sommes et les comptes par SQL, jamais de tête ;
- réponds à Awa en français, en la vouvoyant, en quatre phrases au plus, avec les chiffres exacts ;
- si la base ne permet pas de répondre, dis-le.
Nous sommes le mercredi 21 octobre 2026.`;

export async function demander(question: string, budgetMax: number, iterationsMax = 8): Promise<[string, number, number]> {
  const client = new Anthropic({ timeout: config.DELAI_S * 1000, maxRetries: config.REESSAIS });
  let depense = 0;
  let tours = 0;
  let texte = "";
  const { client: clientMcp } = await connecter(commandes());
  try {
    const { tools: outils } = await clientMcp.listTools();
    const runner = client.beta.messages.toolRunner({
      model: config.MODELE,
      max_tokens: 2000,
      system: SYSTEME,
      messages: [{ role: "user", content: question }],
      // Le client MCP convient : son callTool peut aussi rendre l'ancienne forme { toolResult }, que le type
      // du SDK ne prévoit pas, mais DBHub répond avec content.
      tools: mcpTools(outils, clientMcp as unknown as MCPClientLike),
      max_iterations: iterationsMax,
    });
    for await (const message of runner) {
      tours++;
      const prix = cout(config.MODELE, message.usage);
      depense += prix.dollars;
      noter((message as { _request_id?: string | null })._request_id, config.MODELE, prix, { client: "ch14-soir", stop_reason: message.stop_reason, origine: "mcp-local" });
      for (const bloc of message.content) {
        if (bloc.type === "tool_use") console.log(`SQL : ${jsonPython(bloc.input)}`);
        else if (bloc.type === "text") texte = bloc.text;
      }
      if (depense >= budgetMax && message.stop_reason === "tool_use") {
        console.log(`Arrêt : ${fixe(depense, 4)} $ dépensés, plafond de ${budgetMax} $ atteint.`);
        break;
      }
    }
  } finally {
    await clientMcp.close();
  }
  return [texte, depense, tours];
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { "budget-max": { type: "string", default: "0.10" } } });
  const [texte, depense, tours] = await demander(positionals[0] ?? QUESTION, Number(args["budget-max"]));
  console.log(`\n${texte}\n\n${tours} tour(s), ${fixe(depense, 4)} $`);
}

if (estLance(import.meta.url)) await main();
