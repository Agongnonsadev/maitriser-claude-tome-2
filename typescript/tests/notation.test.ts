// La notation automatique des réponses, sur des textes écrits pour le test (python/tests/test_notation.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { compterPhrases, creerCas, normaliser, noter } from "../comptoir/notation.ts";

test("les espaces dans les nombres ne comptent pas", () => {
  assert.equal(normaliser("2 500 FCFA"), normaliser("2500 FCFA"));
  assert.equal(normaliser("2 500 FCFA"), normaliser("2500 FCFA"));
  assert.equal(normaliser("2 500 FCFA"), normaliser("2500 FCFA"));
});

test("compter les phrases", () => {
  assert.equal(compterPhrases("Oui. Le sirop coûte 2 500 FCFA ! Autre chose ?"), 3);
  assert.equal(compterPhrases("Une seule phrase sans point"), 1);
  assert.equal(compterPhrases(""), 0);
});

test("une salutation en tête ne compte pas", () => {
  assert.equal(compterPhrases("Bonjour ! Le jus est à 1 000 FCFA. Autre chose ?"), 2);
  assert.equal(compterPhrases("Hello! Yes, we deliver today."), 1);
  assert.equal(compterPhrases("Bonsoir Madame ! Oui."), 1);
  // Seulement en tête, et seulement une salutation : le reste compte toujours.
  assert.equal(compterPhrases("Merci ! Bonjour ! Oui."), 3);
  assert.equal(compterPhrases("Félicitations pour votre mariage ! Awa prépare un devis."), 2);
  assert.equal(compterPhrases("Bonjour !"), 1);
});

test("réponse juste", () => {
  const cas = creerCas({ identifiant: "prix-sirop", question: "C'est combien ?", doit_contenir: ["2 500"] });
  assert.ok(noter(cas, "Le sirop coûte 2500 FCFA le flacon.").reussi);
});

test("prix faux", () => {
  const cas = creerCas({ identifiant: "prix-sirop", question: "C'est combien ?", doit_contenir: ["2 500"] });
  const note = noter(cas, "Le sirop coûte 3 000 FCFA le flacon.");
  assert.equal(note.reussi, false);
  assert.ok(note.raisons.includes("manque « 2 500 »"));
});

test("remise interdite et transmission exigée", () => {
  const cas = creerCas({ identifiant: "remise", question: "Un prix ?", ne_doit_pas_contenir: ["%"], doit_transmettre: true });
  assert.equal(noter(cas, "Je vous fais 10 % de remise.").reussi, false);
  assert.ok(noter(cas, "Je transmets votre demande à Awa, qui vous répondra.").reussi);
});

test("numéro inventé détecté", () => {
  const cas = creerCas({ identifiant: "numero", question: "Son numéro ?", ne_doit_pas_correspondre: ["\\d{8,}"] });
  assert.equal(noter(cas, "C'est le 01 97 00 00 00.").reussi, false);
  assert.ok(noter(cas, "Je ne peux pas donner ce numéro.").reussi);
});

test("trop long", () => {
  const cas = creerCas({ identifiant: "court", question: "?", phrases_max: 3 });
  assert.equal(noter(cas, "Un. Deux. Trois. Quatre.").reussi, false);
});

test("un cas à relire est signalé", () => {
  const cas = creerCas({ identifiant: "baobab", question: "Du baobab ?", a_relire: "Ne pas prétendre en vendre." });
  assert.equal(noter(cas, "Nous n'en avons pas.").aRelire, "Ne pas prétendre en vendre.");
});
