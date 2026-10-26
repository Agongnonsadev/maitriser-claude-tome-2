// La validation humaine du chapitre 7 : rien n'est enregistré sans un « o » tapé par Yao
// (python/tests/test_ch07_validation.py).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DOCUMENTS } from "../ch07/mesurer_exactitude.ts";
import { valider } from "../ch07/valider_commandes.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { fauxMessage, journalTemporaire, regler, remettreLesReglages } from "./faux_clients.ts";

const BON = {
  type_document: "bon_de_commande", client: "Mme Akpovi", quartier: "Fidjrossè",
  date_livraison_lue: "samedi 24 octobre", total_lu: 6000, remarques: [],
  lignes: [{ libelle_lu: "Jus bissap", produit: "Jus de bissap", quantite: 6 as number | null, prix_unitaire_lu: 1000,
    lisibilite: "lisible", remarque: null }],
};

const fauxClient = (bon: object): ClientMessages => ({
  messages: {
    create: async () => fauxMessage({ contenu: [{ type: "text", text: JSON.stringify(bon), citations: null }], usage: { input_tokens: 3000, output_tokens: 300 } }),
    countTokens: async () => ({ input_tokens: 0 }),
  },
});

let registre: string;
beforeEach(() => {
  journalTemporaire();
  regler({ MODELE: "claude-sonnet-5-5" });
  registre = join(mkdtempSync(join(tmpdir(), "comptoir-")), "commandes.jsonl");
});
afterEach(remettreLesReglages);

test("sans accord, rien n'est enregistré", async () => {
  const commande = await valider(fauxClient(BON), join(DOCUMENTS, "bon-01.jpg"), () => "", registre);
  assert.equal(commande, null);
  assert.equal(existsSync(registre), false);
});

test("avec accord, la commande et son montant calculé sont enregistrés", async () => {
  const commande = await valider(fauxClient(BON), join(DOCUMENTS, "bon-01.jpg"), () => "o", registre);
  assert.equal(commande?.montant_fcfa, 6000);
  assert.equal(commande?.validee_par_un_humain, true);
  assert.equal(JSON.parse(readFileSync(registre, "utf8")).document, "bon-01.jpg");
});

test("un montant incalculable n'est même pas proposé", async () => {
  const illisible = JSON.parse(JSON.stringify(BON));
  Object.assign(illisible.lignes[0], { quantite: null, lisibilite: "illisible" });
  const questionsPosees: string[] = [];
  const commande = await valider(fauxClient(illisible), join(DOCUMENTS, "bon-03.jpg"), (q) => (questionsPosees.push(q), "o"), registre);
  assert.equal(commande, null);
  assert.deepEqual(questionsPosees, []);
  assert.equal(existsSync(registre), false);
});
