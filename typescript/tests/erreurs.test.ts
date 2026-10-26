// Chaque erreur reçoit le bon diagnostic : réessayer ou corriger, et d'où elle vient
// (python/tests/test_erreurs.py, avec les classes d'erreur du SDK TypeScript).

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FluxIncomplet, INDISPONIBLE, PASSAGERE, REFUS, diagnostiquer, diagnostiquerArret } from "../comptoir/erreurs.ts";
import { erreurApi } from "./faux_clients.ts";

const CAS: [string, unknown, string, boolean, string][] = [
  ["401", erreurApi(401, "authentication_error"), "cle_invalide", false, "compte"],
  ["402", erreurApi(402, "billing_error"), "facturation", false, "compte"],
  ["403", erreurApi(403, "permission_error"), "permission", false, "compte"],
  ["404", erreurApi(404, "not_found_error"), "introuvable", false, "integration"],
  ["413", erreurApi(413, "request_too_large"), "requete_trop_lourde", false, "integration"],
  ["400", erreurApi(400, "invalid_request_error", "messages.0: bad"), "requete_invalide", false, "integration"],
  ["529", erreurApi(529, "overloaded_error"), "surcharge", true, "service"],
  ["500", erreurApi(500, "api_error"), "erreur_interne", true, "service"],
  ["504", erreurApi(504, "timeout_error"), "delai_api", true, "service"],
  ["délai", new Anthropic.APIConnectionTimeoutError(), "delai_depasse", true, "reseau"],
  ["connexion", new Anthropic.APIConnectionError({ message: "Connection error." }), "connexion", true, "reseau"],
  ["coupure en plein flux", new Anthropic.AnthropicError("terminated", { cause: new TypeError("terminated") }), "connexion", true, "reseau"],
  ["flux incomplet", new FluxIncomplet(), "flux_incomplet", true, "reseau"],
  ["bogue", new TypeError("bogue"), "inconnue", false, "integration"],
];

for (const [nom, erreur, code, reessayer, origine] of CAS) {
  test(`chaque erreur a son diagnostic : ${nom}`, () => {
    const d = diagnostiquer(erreur);
    assert.deepEqual([d.code, d.reessayer, d.origine], [code, reessayer, origine]);
    assert.ok([PASSAGERE, INDISPONIBLE].includes(d.pourLeClient));
  });
}

test("une limite de débit se réessaie après le délai demandé", () => {
  const d = diagnostiquer(erreurApi(429, "rate_limit_error", "", undefined, { "retry-after": "12" }));
  assert.equal(d.code, "limite_de_debit");
  assert.ok(d.reessayer);
  assert.equal(d.attenteS, 12);
});

test("le plafond du palier ne se réessaie pas", () => {
  // Même statut et même type qu'une limite de débit, mais un code qui change tout.
  const erreur = erreurApi(429, "rate_limit_error", "You have reached your API usage limits: ...", { error_code: "enforced_spend_limit_reached" });
  const d = diagnostiquer(erreur);
  assert.equal(d.code, "plafond_du_palier");
  assert.equal(d.reessayer, false);
});

test("la limite de dépense que vous avez fixée", () => {
  const erreur = erreurApi(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01.");
  assert.equal(diagnostiquer(erreur).code, "limite_de_depense");
});

test("une erreur annoncée en plein flux, sans statut, se lit à son type", () => {
  const corps = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  const erreur = new Anthropic.APIError(undefined, corps, JSON.stringify(corps), undefined, "overloaded_error");
  assert.equal(diagnostiquer(erreur).code, "surcharge");
});

test("les raisons d'arrêt", () => {
  const d = diagnostiquerArret({ stop_reason: "refusal", stop_details: { category: "cyber" } });
  assert.equal(d?.code, "refus");
  assert.match(d!.pourYao, /cyber/);
  assert.equal(d!.pourLeClient, REFUS);
  assert.equal(diagnostiquerArret({ stop_reason: "max_tokens" })?.code, "reponse_coupee");
  assert.equal(diagnostiquerArret({ stop_reason: "model_context_window_exceeded" })?.code, "contexte_plein");
  assert.equal(diagnostiquerArret({ stop_reason: "end_turn" }), null);
});
