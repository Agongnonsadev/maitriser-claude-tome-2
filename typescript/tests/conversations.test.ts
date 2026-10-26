// L'historique des conversations : en ajout seul, blocs gardés tels quels, clôture et purge
// (python/tests/test_conversations.py).

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Conversations } from "../comptoir/conversations.ts";
import { regler, remettreLesReglages } from "./faux_clients.ts";

const QUESTION = { role: "user", content: "<message_client>\nBonjour\n</message_client>" };
// Les blocs tels que le SDK les rend : citations: null compris.
const REPONSE = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Bonjour ! Que puis-je pour vous ?", citations: null },
  ],
};
const HEURE = 3600 * 1000;
const JOUR = 24 * HEURE;

afterEach(remettreLesReglages);

test("les blocs de Claude sont gardés tels quels", () => {
  const conversations = new Conversations();
  const c = conversations.creer();
  conversations.ajouterTour(c, [QUESTION, REPONSE], 1200);
  const historique = conversations.historique(c);
  assert.deepEqual(historique[0], QUESTION);
  // La réflexion et sa signature sont là, et aucun champ vide (citations: null) n'est resté.
  assert.deepEqual(historique[1]!.content, [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Bonjour ! Que puis-je pour vous ?" },
  ]);
});

test("les arguments d'un outil restent tels quels, même nuls", () => {
  const conversations = new Conversations();
  const c = conversations.creer();
  const appel = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "stock", input: { produit: "bissap", taille: null } }] };
  conversations.ajouterTour(c, [QUESTION, appel], 100);
  assert.deepEqual(conversations.historique(c)[1], appel);
});

test("l'historique ne fait que s'allonger", () => {
  const conversations = new Conversations();
  const c = conversations.creer();
  conversations.ajouterTour(c, [QUESTION, REPONSE], 1200);
  const avant = conversations.historique(c);
  conversations.ajouterTour(c, [QUESTION, { role: "assistant", content: "Avec plaisir." }], 1500);
  const apres = conversations.historique(c);
  // Le début est identique, au caractère près : le cache et la réflexion préservée restent valables.
  assert.deepEqual(apres.slice(0, avant.length), avant);
  assert.deepEqual(apres.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
});

test("une conversation se clôt après 24 heures, ou quand elle est trop longue", () => {
  regler({ EXPIRATION_H: 24, CONTEXTE_MAX: 40_000 });
  const conversations = new Conversations();
  const c = conversations.creer();
  conversations.ajouterTour(c, [QUESTION, REPONSE], 1200);
  const maintenant = new Date();
  assert.equal(conversations.motifDeCloture(c, null, maintenant), null);
  assert.equal(conversations.motifDeCloture(c, null, new Date(maintenant.getTime() + 25 * HEURE)), "expiree");
  conversations.ajouterTour(c, [QUESTION, REPONSE], 41_000);
  assert.equal(conversations.motifDeCloture(c, null, maintenant), "trop_longue");
});

test("un nouveau prompt clôt la conversation", () => {
  const conversations = new Conversations();
  const c = conversations.creer("systeme-v1@aaaa1111");
  assert.equal(conversations.motifDeCloture(c, "systeme-v1@aaaa1111"), null);
  // Awa a changé un prix : le prompt rendu change d'empreinte, la conversation est close.
  assert.equal(conversations.motifDeCloture(c, "systeme-v1@bbbb2222"), "nouveau_prompt");
});

test("la purge supprime les vieilles conversations et leurs messages", () => {
  regler({ CONSERVATION_J: 30 });
  const conversations = new Conversations();
  const c = conversations.creer();
  conversations.ajouterTour(c, [QUESTION, REPONSE], 1200);
  assert.equal(conversations.purger(new Date(Date.now() + 29 * JOUR)), 0);
  assert.equal(conversations.purger(new Date(Date.now() + 31 * JOUR)), 1);
  assert.equal(conversations.existe(c), false);
  assert.deepEqual(conversations.historique(c), []);
});

test("effacer à la demande du client", () => {
  const conversations = new Conversations();
  const c = conversations.creer();
  conversations.ajouterTour(c, [QUESTION, REPONSE], 1200);
  assert.ok(conversations.effacer(c));
  assert.deepEqual(conversations.historique(c), []);
  assert.equal(conversations.effacer(c), false);
});
