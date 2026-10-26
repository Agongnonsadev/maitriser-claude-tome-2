// Mesurer l'exactitude : chaque champ juste, manqué, inventé ou erroné (python/tests/test_exactitude.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Ecart, comparer, resumer } from "../comptoir/exactitude.ts";

const ATTENDU = {
  client: "Mme Dossou",
  quartier: "Cadjèhoun",
  total_lu: null,
  lignes: [
    { produit: "Jus de corossol", quantite: null, prix_unitaire_lu: 1000 },
    { produit: "Jus de gingembre", quantite: 3, prix_unitaire_lu: 1000 },
  ],
};

test("les quatre issues", () => {
  assert.equal(new Ecart("d", "c", "Cadjèhoun", "cadjehoun").issue, "juste"); // casse et accents ignorés
  assert.equal(new Ecart("d", "c", 3, null).issue, "manquée");
  assert.equal(new Ecart("d", "c", null, 12).issue, "inventée");
  assert.equal(new Ecart("d", "c", 3, 8).issue, "erronée");
  assert.equal(new Ecart("d", "c", null, null).issue, "juste"); // « illisible » attendu, « illisible » rendu
});

test("une quantité tachée devinée est une valeur inventée", () => {
  const obtenu = { ...ATTENDU, lignes: [{ ...ATTENDU.lignes[0]!, quantite: 12 }, ATTENDU.lignes[1]!] };
  const issues = new Map(comparer("bon-03.jpg", ATTENDU, obtenu).map((e) => [e.champ, e.issue]));
  assert.equal(issues.get("lignes.0.quantite"), "inventée");
  assert.equal([...issues.values()].filter((i) => i === "juste").length, issues.size - 1);
});

test("une extraction en échec manque tout", () => {
  const r = resumer(comparer("bon-03.jpg", ATTENDU, null));
  // Les champs attendus à null sont « justes » : un échec ne les invente pas.
  assert.equal(r.manquée, 7);
  assert.equal(r.inventée, 0);
});

test("une ligne lue en trop est inventée", () => {
  const obtenu = { ...ATTENDU, lignes: [...ATTENDU.lignes, { produit: "Jus de bissap", quantite: 2 }] };
  assert.equal(comparer("bon-03.jpg", ATTENDU, obtenu).at(-1)!.issue, "inventée");
});
