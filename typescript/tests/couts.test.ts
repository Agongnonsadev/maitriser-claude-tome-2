// Tests du calculateur de coût, sans aucun appel à l'API : ceux de python/tests/test_couts.py, plus la
// recherche web, le coût maximal et la durée de cache, que la version Python teste avec leurs chapitres.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cout, coutMaximal, dureeCache } from "../comptoir/couts.ts";
import { presque } from "./faux_clients.ts";

test("exemple du livre sur Sonnet", () => {
  // Chapitre 1 : 2 000 tokens d'entrée et 300 de sortie sur Sonnet 5.5 = 0,007 $.
  presque(cout("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300 }).dollars, 0.007);
});

test("conversion en FCFA et en euros", () => {
  const prix = cout("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 });
  presque(prix.dollars, 2.0);
  presque(prix.fcfa, 1140.0);
  presque(prix.euros, 1.74);
});

test("affichage en français", () => {
  const prix = cout("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300 });
  assert.equal(String(prix), "0,0070 $ (≈ 4,0 FCFA ; 0,0061 €)");
});

test("accepte un usage relu dans un JSON, avec des champs nuls", () => {
  presque(cout("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: null }).dollars, 0.007);
});

const AVEC_CACHE = {
  input_tokens: 50,
  output_tokens: 100,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 3_000,
  cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
};
const PRIX_AVEC_CACHE = (50 * 2 + 100 * 10 + 10_000 * 0.1 + 2_000 * 2.5 + 1_000 * 4.0) / 1_000_000;

test("cache : lecture et écritures", () => {
  presque(cout("claude-sonnet-5-5", AVEC_CACHE).dollars, PRIX_AVEC_CACHE);
});

test("une écriture sans détail est comptée en cinq minutes", () => {
  presque(cout("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }).dollars, 5.0);
});

test("Haiku change de tarif au-delà de 100 000 tokens", () => {
  presque(cout("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 1_000 }).dollars, (100_000 * 0.1 + 1_000 * 0.5) / 1e6);
  presque(cout("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1_000 }).dollars, (100_001 * 0.5 + 1_000 * 2.5) / 1e6);
});

test("le cache compte dans la longueur du prompt de Haiku", () => {
  // 1 000 tokens hors cache + 150 000 lus dans le cache : le prompt dépasse 100 000 tokens.
  const usage = { input_tokens: 1_000, output_tokens: 0, cache_read_input_tokens: 150_000 };
  presque(cout("claude-haiku-5-5", usage).dollars, (1_000 * 0.5 + 150_000 * 0.05) / 1e6);
});

test("modèle inconnu", () => {
  assert.throws(() => cout("claude-modele-imaginaire", { input_tokens: 1, output_tokens: 1 }), /Prix inconnu/);
});

// Chapitre 4 : la remise de la Batch API.

test("un lot divise l'exemple du livre par deux", () => {
  presque(cout("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300 }, true).dollars, 0.0035);
});

test("la remise de lot se cumule avec le cache", () => {
  presque(cout("claude-sonnet-5-5", AVEC_CACHE, true).dollars, PRIX_AVEC_CACHE * 0.5);
});

test("lot et long prompt de Haiku : le seuil porte sur les tokens bruts", () => {
  presque(cout("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1_000 }, true).dollars, ((100_001 * 0.5 + 1_000 * 2.5) / 1e6) * 0.5);
});

test("pas de lot par défaut, et un lot garde les compteurs de tokens", () => {
  const usage = { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 500 };
  assert.deepEqual(cout("claude-sonnet-5-5", usage), cout("claude-sonnet-5-5", usage, false));
  const parLot = cout("claude-sonnet-5-5", usage, true);
  assert.deepEqual([parLot.entree, parLot.lectureCache, parLot.sortie], [2000, 500, 300]);
});

// Chapitre 10 : les recherches web, facturées à part, sans remise de lot.

test("une recherche web coûte un centime, en plus des tokens", () => {
  const usage = { input_tokens: 2000, output_tokens: 300, server_tool_use: { web_search_requests: 3 } };
  presque(cout("claude-sonnet-5-5", usage).dollars, 0.007 + 0.03);
  presque(cout("claude-sonnet-5-5", usage, true).dollars, 0.0035 + 0.03);
});

// Chapitre 8 : le pire cas, avant l'appel ; chapitre 11 : avec un point de cache.

test("coût maximal d'un appel, avec ou sans écriture dans le cache", () => {
  presque(coutMaximal("claude-sonnet-5-5", 2000, 1000), (2000 * 2 + 1000 * 10) / 1e6);
  presque(coutMaximal("claude-sonnet-5-5", 2000, 1000, "5m"), (2000 * 2.5 + 1000 * 10) / 1e6);
  presque(coutMaximal("claude-sonnet-5-5", 2000, 1000, "1h"), (2000 * 4 + 1000 * 10) / 1e6);
  presque(coutMaximal("claude-haiku-5-5", 100_001, 0), (100_001 * 0.5) / 1e6);
});

test("la durée de cache la plus chère d'une requête", () => {
  assert.equal(dureeCache({ messages: [{ role: "user", content: "Bonjour" }] }), null);
  assert.equal(dureeCache({ system: [{ type: "text", text: "…", cache_control: { type: "ephemeral" } }] }), "5m");
  assert.equal(
    dureeCache({
      tools: [{ name: "stock", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "…", cache_control: { type: "ephemeral" } }] }],
    }),
    "1h",
  );
});
