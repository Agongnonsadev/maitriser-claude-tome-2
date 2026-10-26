// Le Comptoir du chapitre 5, avec un faux client : aucun appel payant (python/tests/test_assistant.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { construireRequete, repondre } from "../comptoir/assistant.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { charger } from "../comptoir/prompt.ts";
import { fauxMessage, journalTemporaire } from "./faux_clients.ts";

const effortInitial = config.EFFORT;
afterEach(() => {
  config.EFFORT = effortInitial;
});

function fauxClient() {
  const client = {
    requete: null as Anthropic.MessageCreateParamsNonStreaming | null,
    messages: {
      create: async (requete: Anthropic.MessageCreateParamsNonStreaming) => {
        client.requete = requete;
        return fauxMessage({
          contenu: [{ type: "text", text: "Le sirop coûte 2 500 FCFA.", citations: null }],
          usage: { input_tokens: 900, output_tokens: 60 },
        });
      },
      countTokens: async () => ({ input_tokens: 0 }),
    },
  } satisfies ClientMessages & { requete: unknown };
  return client;
}

test("la requête balise le message et utilise le prompt v1", () => {
  const requete = construireRequete("Combien coûte le sirop ?");
  assert.equal(requete.system, charger("v1").texte);
  assert.deepEqual(requete.messages, [{ role: "user", content: "<message_client>\nCombien coûte le sirop ?\n</message_client>" }]);
  assert.ok(!("temperature" in requete));
});

test("la consigne d'Awa suit le message du client", () => {
  const requete = construireRequete("3 corossols ce soir ?", { consignes: ["Corossol en rupture."] });
  assert.deepEqual(requete.messages.map((m) => m.role), ["user", "system"]);
  assert.equal(requete.messages.at(-1)?.content, "Corossol en rupture.");
  // Le prompt système, lui, n'a pas bougé : son cache reste valable.
  assert.equal(requete.system, construireRequete("autre chose").system);
});

test("l'historique est conservé tel quel", () => {
  const historique: Anthropic.MessageParam[] = [
    { role: "user", content: "<message_client>\nBonjour\n</message_client>" },
    { role: "assistant", content: "Bonjour ! Que puis-je pour vous ?" },
  ];
  const requete = construireRequete("Le bissap ?", { historique });
  assert.deepEqual(requete.messages.slice(0, 2), historique);
  assert.equal(requete.messages.length, 3);
});

test("l'effort vient de la configuration", () => {
  config.EFFORT = "low";
  assert.deepEqual(construireRequete("?").output_config, { effort: "low" });
  config.EFFORT = null;
  assert.ok(!("output_config" in construireRequete("?")));
});

test("un autre modèle, évalué, n'hérite pas de l'effort du Comptoir", () => {
  config.EFFORT = "low";
  const requete = construireRequete("?", { modele: "claude-haiku-5-5" });
  assert.equal(requete.model, "claude-haiku-5-5");
  assert.ok(!("output_config" in requete));
  assert.deepEqual(construireRequete("?", { modele: "claude-haiku-5-5", effort: "medium" }).output_config, { effort: "medium" });
});

test("cache automatique et documents d'Awa en tête du premier message", () => {
  const blocs: Anthropic.SearchResultBlockParam[] = [
    { type: "search_result", source: "faq.md", title: "FAQ", content: [{ type: "text", text: "Livraison à Cotonou." }] },
  ];
  const requete = construireRequete("Vous livrez ?", { cache: true, connaissances: blocs });
  assert.deepEqual(requete.cache_control, { type: "ephemeral" });
  const premier = requete.messages[0]!;
  assert.ok(Array.isArray(premier.content));
  assert.deepEqual(premier.content[0], blocs[0]);
  assert.deepEqual(premier.content[1], { type: "text", text: "<message_client>\nVous livrez ?\n</message_client>" });
});

test("le journal note la version du prompt", async () => {
  const journal = journalTemporaire();
  const { texte } = await repondre(fauxClient(), "Combien coûte le sirop ?");
  assert.equal(texte, "Le sirop coûte 2 500 FCFA.");
  const ligne = JSON.parse(readFileSync(journal, "utf8"));
  assert.equal(ligne.prompt, charger("v1").identifiant);
});
