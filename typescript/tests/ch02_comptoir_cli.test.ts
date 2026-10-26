// Le Comptoir en ligne de commande, testé avec un faux client : aucun appel payant
// (python/tests/test_ch02_comptoir_cli.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROMPT_SYSTEME, repondre } from "../ch02/comptoir_cli.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { fauxMessage, journalTemporaire, presque } from "./faux_clients.ts";

/** Imite client.messages.create et garde la dernière requête pour l'inspecter. */
function fauxClient() {
  const client = {
    derniereRequete: null as Anthropic.MessageCreateParamsNonStreaming | null,
    messages: {
      create: async (requete: Anthropic.MessageCreateParamsNonStreaming) => {
        client.derniereRequete = requete;
        return fauxMessage({
          contenu: [
            { type: "thinking", thinking: "", signature: "" }, // réflexion masquée par défaut
            { type: "text", text: "Le sirop de gingembre coûte 2 500 FCFA le flacon.", citations: null },
          ],
          usage: { input_tokens: 420, output_tokens: 80, output_tokens_details: { thinking_tokens: 30 } },
          identifiant: "req_test_0001",
        });
      },
      countTokens: async () => ({ input_tokens: 0 }),
    },
  } satisfies ClientMessages & { derniereRequete: unknown };
  return client;
}

test("répond et ignore les blocs de réflexion", async () => {
  journalTemporaire();
  const { texte, prix } = await repondre(fauxClient(), "Combien coûte le sirop de gingembre ?", "claude-sonnet-5-5");
  assert.equal(texte, "Le sirop de gingembre coûte 2 500 FCFA le flacon.");
  assert.equal(prix.reflexion, 30);
  presque(prix.dollars, (420 * 2 + 80 * 10) / 1_000_000);
});

test("envoie le prompt système et la question, sans temperature", async () => {
  journalTemporaire();
  const client = fauxClient();
  await repondre(client, "Livrez-vous à Calavi ?", "claude-sonnet-5-5");
  const requete = client.derniereRequete!;
  assert.equal(requete.model, "claude-sonnet-5-5");
  assert.match(String(requete.system), /Délices d'Awa/);
  assert.deepEqual(requete.messages, [{ role: "user", content: "Livrez-vous à Calavi ?" }]);
  assert.ok(!("temperature" in requete)); // retiré par l'API 2026-10-21
});

test("le journal ne contient ni clé ni message", async () => {
  const journal = journalTemporaire();
  const avant = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-cle-de-test";
  try {
    await repondre(fauxClient(), "Mon numéro est le 0197000000", "claude-sonnet-5-5");
  } finally {
    if (avant === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = avant;
  }
  const contenu = readFileSync(journal, "utf8");
  const ligne = JSON.parse(contenu);
  assert.equal(ligne.requete, "req_test_0001");
  assert.equal(ligne.tokens_entree, 420);
  assert.ok(!contenu.includes("sk-ant"));
  assert.ok(!contenu.includes("0197000000"));
});

test("le prompt système est celui de la version Python, mot pour mot", () => {
  const source = readFileSync(join(PYTHON, "ch02", "comptoir_cli.py"), "utf8").replace(/\r\n/g, "\n");
  const prompt = /PROMPT_SYSTEME = """([\s\S]*?)"""/.exec(source)?.[1];
  assert.equal(PROMPT_SYSTEME, prompt);
});
