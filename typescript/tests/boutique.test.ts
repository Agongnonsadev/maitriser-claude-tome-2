// La boutique : prix et frais calculés par le code, stock vérifié, une commande créée une seule fois
// (python/tests/test_boutique.py), et ce qu'elle garde ou efface (python/tests/test_ch18.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Boutique, RefusBoutique, initiale } from "../comptoir/boutique.ts";

const MATIN = new Date("2026-10-20T08:00:00Z"); // 9 h à Cotonou
const HEURE = 3600 * 1000;

/** Des codes de confirmation tirés dans l'ordre, pour des tests reproductibles. */
const suite = (depart = 4242) => {
  let n = depart;
  return (max: number) => (n = (n * 7 + 13) % max);
};

const boutique = (horloge: () => Date = () => MATIN) => new Boutique(":memory:", { horloge, hasard: suite() });
const BISSAP_6 = [{ produit: "Jus de bissap", quantite: 6 }];

test("le stock initial, et un produit inconnu", () => {
  const b = boutique();
  assert.equal(b.disponible("Jus de bissap"), 40);
  assert.equal(b.disponible("Jus de corossol"), 0);
  assert.equal(b.disponible("Jus de mangue"), null);
});

test("le total vient du catalogue, et la livraison est offerte dès 5 bouteilles", () => {
  const recap = boutique().preparer("c1", BISSAP_6, "Mme Hounkpè", "Akpakpa");
  assert.equal(recap.total_fcfa, 6000);
  assert.equal(recap.frais_livraison, 0);
  assert.equal(recap.livraison_prevue, "aujourd'hui"); // commande passée avant midi, heure de Cotonou
});

test("sous 5 bouteilles, la livraison coûte 500 FCFA, et les sirops ne comptent pas", () => {
  const recap = boutique().preparer("c1", [{ produit: "Jus de bissap", quantite: 2 }, { produit: "Sirop de gingembre", quantite: 3 }], "M. Dossou", "Zogbo");
  assert.equal(recap.frais_livraison, 500);
  assert.equal(recap.total_fcfa, 2000 + 7500 + 500);
});

test("l'après-midi, la livraison est pour demain", () => {
  const apresMidi = boutique(() => new Date("2026-10-20T12:00:00Z")); // 13 h à Cotonou
  assert.equal(apresMidi.preparer("c1", [{ produit: "Jus d'ananas", quantite: 5 }], "A", "B").livraison_prevue, "demain");
});

const REFUS: [{ produit: string; quantite: number }[], RegExp][] = [
  [[{ produit: "Jus de mangue", quantite: 3 }], /absent du catalogue/],
  [[{ produit: "Jus d'ananas", quantite: 0 }], /au moins 1/],
  [[{ produit: "Jus d'ananas", quantite: 15 }], /Stock insuffisant : 12/],
  [[{ produit: "Jus de bissap", quantite: 40 }, { produit: "Jus de gingembre", quantite: 20 }], /devis/],
  [[], /vide/],
];
for (const [lignes, motif] of REFUS) {
  test(`les refus disent quoi faire : ${motif.source}`, () => {
    assert.throws(() => boutique().preparer("c1", lignes, "A", "B"), (e: unknown) => e instanceof RefusBoutique && motif.test(e.message));
  });
}

test("une commande n'est créée qu'une fois, et le stock baisse", () => {
  const b = boutique();
  const code = b.preparer("c1", BISSAP_6, "A", "B").code_de_confirmation;
  const premiere = b.confirmer("c1", code);
  const seconde = b.confirmer("c1", code); // le client renvoie son « OUI » : rien de plus
  assert.equal(premiere.commande, "C-0001");
  assert.equal(seconde.commande, "C-0001");
  assert.ok(seconde.deja_enregistree);
  assert.equal(b.commandes().length, 1);
  assert.equal(b.disponible("Jus de bissap"), 34);
});

test("l'ancien code ne vaut plus après un changement d'avis", () => {
  let instant = MATIN;
  const b = boutique(() => instant);
  const ancien = b.preparer("c1", [{ produit: "Jus de bissap", quantite: 4 }], "A", "B").code_de_confirmation;
  instant = new Date(MATIN.getTime() + 60_000);
  const nouveau = b.preparer("c1", BISSAP_6, "A", "B").code_de_confirmation;
  assert.throws(() => b.confirmer("c1", ancien), /remplacé/);
  assert.equal(b.confirmer("c1", nouveau).total_fcfa, 6000);
});

test("un code ne sert que dans sa conversation", () => {
  const b = boutique();
  const code = b.preparer("c1", BISSAP_6, "A", "B").code_de_confirmation;
  assert.throws(() => b.confirmer("autre-conversation", code), /aucun récapitulatif/);
});

test("un récapitulatif expire", () => {
  let instant = MATIN;
  const b = boutique(() => instant);
  const code = b.preparer("c1", BISSAP_6, "A", "B").code_de_confirmation;
  instant = new Date(MATIN.getTime() + 3 * HEURE);
  assert.throws(() => b.confirmer("c1", code), /expiré/);
});

test("le stock est revérifié au moment de créer", () => {
  const b = boutique();
  const codeC1 = b.preparer("c1", [{ produit: "Jus d'ananas", quantite: 10 }], "A", "B").code_de_confirmation;
  b.confirmer("c2", b.preparer("c2", [{ produit: "Jus d'ananas", quantite: 5 }], "C", "D").code_de_confirmation);
  assert.throws(() => b.confirmer("c1", codeC1), /stock/); // il ne reste que 7 ananas
});

// --- Garder le temps promis, effacer à la demande (chapitre 18) -----------------------------

function boutiqueAvecHistorique() {
  let instant = new Date("2026-06-01T09:00:00Z"); // 10 h à Cotonou
  const b = new Boutique(":memory:", { horloge: () => instant, hasard: suite() });
  const recap = b.preparer("ancienne", BISSAP_6, "Larissa Noudéhou", "Fidjrossè");
  b.confirmer("ancienne", recap.code_de_confirmation);
  b.preparer("abandon", [{ produit: "Jus d'ananas", quantite: 2 }], "Koffi Agbo", "Akpakpa");
  b.transmettre("ancienne", "remise", "Larissa Noudéhou demande une remise.");
  instant = new Date("2026-10-20T09:00:00Z");
  const recente = b.preparer("recente", BISSAP_6, "Mariam Sossou", "Gbégamey");
  b.confirmer("recente", recente.code_de_confirmation);
  return b;
}

test("la purge applique les durées d'Awa", () => {
  const b = boutiqueAvecHistorique();
  assert.deepEqual(b.purger(90, 90, 2), { demandes_effacees: 1, recapitulatifs_effaces: 1, noms_reduits: 1 });
  const noms = Object.fromEntries(b.db.prepare("SELECT conversation, nom_client FROM recapitulatifs").all().map((l) => [l.conversation, l.nom_client]));
  assert.deepEqual(noms, { ancienne: "Larissa N.", recente: "Mariam Sossou" });
  assert.equal(b.commandes().length, 2); // les commandes restent, pour la comptabilité
  assert.deepEqual(b.purger(90, 90, 2), { demandes_effacees: 0, recapitulatifs_effaces: 0, noms_reduits: 0 });
});

test("effacer à la demande d'un client, sauf ce que la comptabilité exige", () => {
  const b = boutiqueAvecHistorique();
  assert.deepEqual(b.effacer("ancienne"), { demandes_effacees: 1, recapitulatifs_effaces: 0 });
  const nom = b.db.prepare("SELECT nom_client FROM recapitulatifs WHERE conversation = 'ancienne'").get()!.nom_client;
  assert.equal(nom, "Larissa N.");
  assert.equal(initiale("Koffi"), "Koffi");
  assert.equal(initiale("Larissa N."), "Larissa N.");
});
