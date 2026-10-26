// Les définitions des outils, et leur exécution sans exception vers la boucle (python/tests/test_outils.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Boutique } from "../comptoir/boutique.ts";
import { Execution, OUTILS, Outils, versJson } from "../comptoir/outils.ts";

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; required?: string[]; additionalProperties?: boolean };

/** Tous les objets d'un schéma, imbriqués compris. */
function* objets(schema: Schema): Generator<Schema> {
  if (schema.type === "object") {
    yield schema;
    for (const propriete of Object.values(schema.properties ?? {})) yield* objets(propriete);
  }
  if (schema.type === "array" && schema.items) yield* objets(schema.items);
}

test("des définitions strictes et bien décrites", () => {
  for (const outil of OUTILS) {
    assert.match(outil.name, /^[a-zA-Z0-9_-]{1,128}$/);
    assert.equal(outil.strict, true);
    // Anthropic conseille au moins trois ou quatre phrases par description.
    assert.ok(outil.description!.split(". ").length >= 3, outil.name);
    for (const o of objets(outil.input_schema as Schema)) {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual(new Set(o.required), new Set(Object.keys(o.properties ?? {})));
    }
  }
});

const appel = (name: string, input: unknown, id = "toolu_1") => ({ id, name, input });

test("le stock de plusieurs produits", () => {
  const resultat = new Outils(new Boutique(), "c1").executer(appel("stock_verifier", { produits: ["Jus d'ananas", "Jus de mangue"] }), new Execution());
  assert.deepEqual(JSON.parse(String(resultat.content)), { "Jus d'ananas": 12, "Jus de mangue": "absent du catalogue" });
  assert.ok(!("is_error" in resultat));
});

test("une erreur de la boutique devient un résultat en erreur", () => {
  const entree = { lignes: [{ produit: "Jus de mangue", quantite: 3 }], nom_client: "A", quartier: "B" };
  const resultat = new Outils(new Boutique(), "c1").executer(appel("commande_preparer", entree), new Execution());
  assert.equal(resultat.is_error, true);
  assert.match(String(resultat.content), /absent du catalogue/);
});

test("Claude ne reçoit pas le code de confirmation", () => {
  const execution = new Execution();
  const entree = { lignes: [{ produit: "Jus de bissap", quantite: 6 }], nom_client: "A", quartier: "B" };
  const resultat = JSON.parse(String(new Outils(new Boutique(), "c1").executer(appel("commande_preparer", entree), execution).content));
  assert.ok(!("code_de_confirmation" in resultat));
  assert.equal(resultat.total_fcfa, 6000);
  assert.ok(execution.recapitulatif?.code_de_confirmation); // le code, lui, le garde pour l'afficher
});

test("un outil inconnu", () => {
  const resultat = new Outils(new Boutique(), "c1").executer(appel("commande_creer", {}), new Execution());
  assert.ok(resultat.is_error);
  assert.match(String(resultat.content), /inconnu/);
});

test("la transmission à Awa", () => {
  const boutique = new Boutique();
  const execution = new Execution();
  new Outils(boutique, "c1").executer(appel("transmettre_a_awa", { motif: "remise", resume: "20 % pour 10 bouteilles" }), execution);
  assert.deepEqual([boutique.demandes()[0]!.conversation, boutique.demandes()[0]!.motif], ["c1", "remise"]);
  assert.equal(execution.transmissions.length, 1);
});

test("un résultat d'outil s'écrit comme json.dumps de Python", () => {
  assert.equal(versJson({ "Jus d'ananas": 12, liste: [1, "été"], vide: null }), '{"Jus d\'ananas": 12, "liste": [1, "été"], "vide": null}');
});
