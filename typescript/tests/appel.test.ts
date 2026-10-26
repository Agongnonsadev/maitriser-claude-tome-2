// L'appel robuste du chapitre 8, avec un faux client : budget, journal, diagnostics
// (python/tests/test_appel.py).

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { HorsBudget, appeler } from "../comptoir/appel.ts";
import { Budget } from "../comptoir/budget.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { ErreurComptoir } from "../comptoir/erreurs.ts";
import { erreurApi, fauxMessage, journalTemporaire, lignesDuJournal, presque, regler, remettreLesReglages } from "./faux_clients.ts";

const REQUETE: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5-5",
  max_tokens: 2000,
  system: "s",
  messages: [{ role: "user", content: "Bonjour" }],
};

let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
  regler({ QUOTA_CLIENT_JOUR: 0.15, BUDGET_JOUR: 1.3, BUDGET_MOIS: 26.0 });
});
afterEach(remettreLesReglages);

function fauxClient(erreur?: unknown, raisonArret: Anthropic.StopReason = "end_turn") {
  const client = {
    appels: 0,
    messages: {
      countTokens: async (requete: Anthropic.MessageCountTokensParams) => {
        assert.ok(!("max_tokens" in requete)); // l'outil de comptage ne le prend pas
        return { input_tokens: 1000 };
      },
      create: async () => {
        client.appels++;
        if (erreur) throw erreur;
        const message = fauxMessage({
          contenu: [{ type: "text", text: "Bonjour !", citations: null }],
          usage: { input_tokens: 1000, output_tokens: 100 },
          raisonArret,
        });
        return { ...message, stop_details: raisonArret === "refusal" ? { type: "refusal", category: "general_harms", explanation: null } : null };
      },
    },
  } satisfies ClientMessages & { appels: number };
  return client;
}

test("un appel réussi règle le coût réel et se note", async () => {
  const budget = new Budget();
  const reponse = await appeler(fauxClient(), REQUETE, budget, "c1");
  assert.equal(reponse.texte, "Bonjour !");
  assert.equal(reponse.arret, null);
  presque(budget.duClient("c1"), reponse.cout.dollars); // pas le maximum réservé
  const ligne = lignesDuJournal(journal)[0]!;
  assert.equal(ligne.client, "c1");
  assert.equal(ligne.stop_reason, "end_turn");
  assert.ok("duree_ms" in ligne);
});

test("hors budget, aucun appel ne part", async () => {
  regler({ QUOTA_CLIENT_JOUR: 0.0001 });
  const client = fauxClient();
  await assert.rejects(appeler(client, REQUETE, new Budget(), "c1"), HorsBudget);
  assert.equal(client.appels, 0);
  const ligne = lignesDuJournal(journal)[0]!;
  assert.equal(ligne.evenement, "hors_budget");
  assert.equal(ligne.motif, "quota_client");
});

test("une erreur de l'API libère la réservation", async () => {
  const budget = new Budget();
  await assert.rejects(appeler(fauxClient(erreurApi(401, "authentication_error")), REQUETE, budget, "c1"), (erreur: unknown) => {
    assert.ok(erreur instanceof ErreurComptoir);
    assert.equal(erreur.diagnostic.code, "cle_invalide");
    return true;
  });
  assert.equal(budget.duJour(), 0); // une erreur renvoyée par l'API n'est pas facturée
  assert.equal(lignesDuJournal(journal)[0]!.erreur, "cle_invalide");
});

test("une coupure réseau garde la réservation", async () => {
  const budget = new Budget();
  const coupure = new Anthropic.AnthropicError("terminated", { cause: new TypeError("terminated") });
  await assert.rejects(appeler(fauxClient(coupure), REQUETE, budget, "c1"), ErreurComptoir);
  assert.ok(budget.duJour() > 0); // la requête a pu aboutir sans que la réponse arrive
});

test("un refus arrive comme une réponse normale", async () => {
  const reponse = await appeler(fauxClient(undefined, "refusal"), REQUETE, new Budget(), "c1");
  assert.equal(reponse.arret?.code, "refus");
  assert.match(reponse.arret!.pourYao, /general_harms/);
  assert.equal(lignesDuJournal(journal)[0]!.erreur, "refus");
});
