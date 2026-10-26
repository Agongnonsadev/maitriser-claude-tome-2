// La comparaison des modèles, avec un faux client qui imite deux modèles : aucun appel payant
// (python/tests/test_ch03_comparaison.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { type Configuration, chargerCas, comparer, estimer, resumer } from "../ch03/comparer_modeles.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { creerCas } from "../comptoir/notation.ts";
import { fauxMessage, journalTemporaire, presque } from "./faux_clients.ts";

/** Le « grand » modèle répond juste ; le « petit » se trompe sur le prix du sirop. */
function fauxClient() {
  const requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    requetes,
    messages: {
      create: async (requete: Anthropic.MessageCreateParamsNonStreaming) => {
        requetes.push(requete);
        const question = String(requete.messages[0]?.content);
        const bonPrix = requete.model === "claude-opus-5-5" || !question.includes("sirop");
        return fauxMessage({
          contenu: [{ type: "text", text: bonPrix ? "Le sirop coûte 2 500 FCFA." : "Le sirop coûte 3 000 FCFA.", citations: null }],
          usage: { input_tokens: 500, output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
          modele: requete.model,
        });
      },
      countTokens: async () => ({ input_tokens: 500 }),
    },
  } satisfies ClientMessages & { requetes: unknown };
  return client;
}

const CAS = [
  creerCas({ identifiant: "prix-sirop", question: "Combien coûte le sirop ?", doit_contenir: ["2 500"] }),
  creerCas({ identifiant: "autre", question: "Et le jus ?", doit_contenir: ["2 500"] }),
];
const CONFIGS: Configuration[] = [
  ["claude-opus-5-5", "medium"],
  ["claude-haiku-5-5", "low"],
];

beforeEach(() => {
  journalTemporaire();
});

test("chaque cas est répété pour chaque configuration", async () => {
  const client = fauxClient();
  const essais = await comparer(client, CAS, CONFIGS, 3, 10);
  assert.equal(essais.length, 2 * 2 * 3);
  assert.deepEqual(new Set(client.requetes.map((r) => r.output_config?.effort)), new Set(["medium", "low"]));
  assert.ok(client.requetes.every((r) => !("temperature" in r)));
});

test("coût par tâche réussie", async () => {
  const essais = await comparer(fauxClient(), CAS, CONFIGS, 2, 10);
  const resume = new Map(resumer(essais).map((l) => [`${l.modele} ${l.effort}`, l]));
  const opus = resume.get("claude-opus-5-5 medium")!;
  const haiku = resume.get("claude-haiku-5-5 low")!;
  assert.equal(opus.reussite, 1.0);
  assert.equal(haiku.reussite, 0.5);
  const coutHaiku = (500 * 0.1 + 100 * 0.5) / 1e6;
  // Le petit modèle ne réussit qu'une fois sur deux : sa réussite coûte deux appels.
  presque(haiku.coutParReussite!, 2 * coutHaiku);
  assert.equal(opus.reflexionMoyenne, 40);
});

test("le budget arrête la comparaison", async () => {
  // Un appel Opus coûte ici 0,004 $ : avec 0,005 $ de budget, on s'arrête après le deuxième.
  const essais = await comparer(fauxClient(), CAS, CONFIGS, 3, 0.005);
  assert.equal(essais.length, 2);
});

test("estimation gratuite", async () => {
  const total = await estimer(fauxClient(), CAS, CONFIGS, 1, 100);
  presque(total, (2 * (500 * 4 + 100 * 20)) / 1e6 + (2 * (500 * 0.1 + 100 * 0.5)) / 1e6);
});

test("les cas du livre se chargent", () => {
  const cas = chargerCas();
  assert.equal(cas.length, 15);
  assert.equal(new Set(cas.map((c) => c.identifiant)).size, 15);
});
