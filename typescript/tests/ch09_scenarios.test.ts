// Les 10 scénarios du défi, et les vérifications faites par le code (python/tests/test_ch09_scenarios.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Scenario, annonceUneCommande, charger, remplacerCodes, verifier } from "../ch09/jouer_scenarios.ts";
import { Boutique } from "../comptoir/boutique.ts";

test("dix scénarios, dont les trois pièges", () => {
  const identifiants = charger().map((s) => s.id);
  assert.equal(identifiants.length, 10);
  assert.equal(new Set(identifiants).size, 10);
  for (const piege of ["piege-produit-inexistant", "piege-stock-insuffisant", "piege-changement-d-avis"]) assert.ok(identifiants.includes(piege));
});

test("une annonce de commande par Claude est détectée", () => {
  assert.ok(annonceUneCommande("Parfait, votre commande est bien enregistrée !"));
  assert.ok(annonceUneCommande("Votre commande a été confirmée."));
  assert.ok(!annonceUneCommande("Votre commande n'est pas encore enregistrée : répondez avec le code."));
  assert.ok(!annonceUneCommande("Vérifiez le récapitulatif avant de confirmer."));
});

test("la vérification d'un scénario", () => {
  const scenario: Scenario = { id: "essai", messages: [], attendu: { commandes: 1, outils_requis: ["commande_preparer"], transmis: null } };
  const boutique = new Boutique();
  const code = boutique.preparer("c1", [{ produit: "Jus de bissap", quantite: 6 }], "A", "B").code_de_confirmation;
  assert.deepEqual(verifier(scenario, boutique, "c1", ["commande_preparer"], ["Vérifiez."]), ["0 commande(s) créée(s), 1 attendue(s)"]);
  boutique.confirmer("c1", code);
  assert.deepEqual(verifier(scenario, boutique, "c1", ["commande_preparer"], ["Vérifiez."]), []);
});

test("les codes sont remplacés par ceux de la boutique", () => {
  const boutique = new Boutique();
  assert.equal(remplacerCodes("OUI {code}", boutique, "c1"), null); // pas encore de récapitulatif
  const code = boutique.preparer("c1", [{ produit: "Jus de bissap", quantite: 6 }], "A", "B").code_de_confirmation;
  assert.equal(remplacerCodes("OUI {code}", boutique, "c1"), `OUI ${code}`);
});
