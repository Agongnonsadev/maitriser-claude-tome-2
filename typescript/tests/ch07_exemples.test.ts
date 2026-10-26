// Les documents d'exemple du chapitre 7 : présents, bien formés, cohérents avec les contrôles
// (python/tests/test_ch07_exemples.py). Ce sont ceux de la version Python, fabriqués une fois par
// python/ch07/fabriquer_exemples.py et lus sur place.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DOCUMENTS } from "../ch07/mesurer_exactitude.ts";
import { jetonsPrevus } from "../comptoir/documents.ts";
import { BonDeCommande, controlerBon } from "../comptoir/extraction.ts";

type LigneAttendue = { produit: string; quantite: number | null; prix_unitaire_lu: number };
const attendus = JSON.parse(readFileSync(join(DOCUMENTS, "attendus.json"), "utf8")) as Record<
  string,
  { client: string; quartier: string; total_lu: number | null; lignes: LigneAttendue[] }
>;

test("les documents et les attendus sont dans le dépôt", () => {
  assert.deepEqual(Object.keys(attendus), ["bon-01.jpg", "bon-02.jpg", "bon-03.jpg", "bon-04.jpg", "facture-01.pdf"]);
  for (const nom of Object.keys(attendus)) assert.ok(existsSync(join(DOCUMENTS, nom)), nom);
  assert.ok(existsSync(join(DOCUMENTS, "conditions-fournisseur.pdf")));
});

test("une photo d'exemple coûte quelques milliers de tokens", async () => {
  const { width, height } = await sharp(join(DOCUMENTS, "bon-01.jpg")).metadata();
  const jetons = jetonsPrevus(width!, height!, "claude-sonnet-5-5");
  assert.ok(jetons > 2000 && jetons <= 4784, String(jetons));
});

test("le PDF texte est bien formé", () => {
  const contenu = readFileSync(join(DOCUMENTS, "conditions-fournisseur.pdf"));
  const texte = contenu.toString("latin1");
  assert.ok(texte.startsWith("%PDF-1.4") && texte.trimEnd().endsWith("%%EOF"));
  // Chaque entrée de la table xref pointe bien sur le début de son objet.
  const xref = Number(/startxref\n(\d+)/.exec(texte)![1]);
  const entrees = [...texte.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  entrees.forEach((position, i) => assert.ok(texte.slice(position).startsWith(`${i + 1} 0 obj`), `objet ${i + 1}`));
  assert.ok(texte.includes("/Count 2")); // deux pages, pour des citations par page
});

/** Le bon tel qu'une lecture juste le rendrait, d'après les valeurs attendues. */
function bonAttendu(nom: string): BonDeCommande {
  const a = attendus[nom]!;
  return BonDeCommande.parse({
    type_document: "bon_de_commande",
    client: a.client,
    quartier: a.quartier,
    date_livraison_lue: null,
    lignes: a.lignes.map((l) => ({
      libelle_lu: l.produit, produit: l.produit, quantite: l.quantite, prix_unitaire_lu: l.prix_unitaire_lu,
      lisibilite: l.quantite === null ? "illisible" : "lisible", remarque: null,
    })),
    total_lu: a.total_lu,
    remarques: [],
  });
}

test("chaque bon d'exemple pose le problème prévu", () => {
  assert.deepEqual(controlerBon(bonAttendu("bon-01.jpg")).anomalies, []);
  assert.equal(controlerBon(bonAttendu("bon-02.jpg")).anomalies.length, 2); // prix et total
  assert.equal(controlerBon(bonAttendu("bon-03.jpg")).montantCalcule, null); // quantité tachée
  assert.equal(controlerBon(bonAttendu("bon-04.jpg")).montantCalcule, 5000);
});
