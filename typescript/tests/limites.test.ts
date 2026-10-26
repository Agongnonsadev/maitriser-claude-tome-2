// Les limites par adresse réseau (chapitre 18 ; python/tests/test_ch18.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiteur, adresseDuClient } from "../comptoir/limites.ts";

test("le limiteur compte sur une fenêtre glissante", () => {
  let instant = 0;
  const limiteur = new Limiteur(3, 60, () => instant);
  assert.deepEqual([limiteur.accepter("a"), limiteur.accepter("a"), limiteur.accepter("a")], [null, null, null]);
  assert.equal(limiteur.accepter("a"), 60);
  assert.equal(limiteur.accepter("b"), null);
  instant = 61;
  assert.equal(limiteur.accepter("a"), null);
});

test("X-Forwarded-For n'est cru que d'un relais de confiance", () => {
  assert.equal(adresseDuClient("203.0.113.9", "1.2.3.4", []), "203.0.113.9"); // n'importe qui peut l'écrire
  assert.equal(adresseDuClient("127.0.0.1", "9.9.9.9, 1.2.3.4", ["127.0.0.1"]), "1.2.3.4"); // la dernière, ajoutée par Caddy
  assert.equal(adresseDuClient(null, null, []), "inconnue");
});
