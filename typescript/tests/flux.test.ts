// Le streaming du Comptoir, avec un faux client : reprise après coupure, rien en double
// (python/tests/test_flux.py).

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { FluxIncomplet, Generation, diffuser, reprenable, requeteDeReprise } from "../comptoir/flux.ts";
import { FauxClientFlux, FauxFlux, erreurApi, journalTemporaire, lignesDuJournal, messageFinal } from "./faux_clients.ts";

const REQUETE: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5-5",
  max_tokens: 2000,
  system: "prompt",
  messages: [{ role: "user", content: "<message_client>\nVos jus ?\n</message_client>" }],
};

let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
});

const coupure = () => new Anthropic.AnthropicError("terminated", { cause: new TypeError("terminated") });

test("la reprise ajoute un message sans toucher aux précédents", () => {
  const suite = requeteDeReprise(REQUETE, "Nous avons du bissap, du gin");
  assert.deepEqual(suite.messages.slice(0, 1), REQUETE.messages);
  assert.equal(REQUETE.messages.length, 1); // la requête d'origine n'a pas bougé
  assert.equal(suite.messages.at(-1)!.role, "user");
  assert.match(String(suite.messages.at(-1)!.content), /Nous avons du bissap, du gin/);
  assert.equal(suite.system, REQUETE.system);
});

test("la reprise se place avant les consignes d'Awa", () => {
  const avecConsigne = { ...REQUETE, messages: [...REQUETE.messages, { role: "system" as const, content: "Corossol en rupture." }] };
  // Un message système doit rester le dernier ou être suivi d'une réponse.
  assert.deepEqual(requeteDeReprise(avecConsigne, "début").messages.map((m) => m.role), ["user", "user", "system"]);
});

test("ce qui se reprend et ce qui ne se reprend pas", () => {
  const corps = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  assert.ok(reprenable(new Anthropic.APIError(undefined, corps, "Overloaded", undefined, "overloaded_error"))); // en plein flux
  assert.ok(reprenable(coupure()));
  assert.ok(reprenable(new FluxIncomplet()));
  assert.ok(reprenable(erreurApi(500)));
  assert.ok(reprenable(new Anthropic.APIConnectionError({ message: "Connection error." })));
  assert.equal(reprenable(erreurApi(400, "invalid_request_error")), false);
  assert.equal(reprenable(erreurApi(401, "authentication_error")), false);
});

test("une connexion qui revient reprend au bon morceau", async () => {
  const generation = new Generation("c1");
  for (const morceau of ["Bon", "jour", " !"]) generation.ajouter(morceau);
  generation.terminer({ type: "fin" });
  const recus = [];
  for await (const e of generation.suivre(1)) recus.push(e);
  assert.deepEqual(recus, [["texte", 1, "jour"], ["texte", 2, " !"], ["fin", 3, { type: "fin" }]]);
});

test("un signe de vie quand rien n'arrive", async () => {
  const generation = new Generation("c1");
  const lecteur = generation.suivre(0, 0.01);
  const premier = (await lecteur.next()).value;
  generation.ajouter("Oui");
  generation.terminer({ type: "fin" });
  const suite = [];
  for await (const e of lecteur) suite.push(e);
  assert.deepEqual([premier, ...suite], [["silence", 0, null], ["texte", 0, "Oui"], ["fin", 1, { type: "fin" }]]);
});

test("un flux sans incident", async () => {
  const client = new FauxClientFlux(new FauxFlux(["Bissap, ", "gingembre."]));
  const generation = new Generation("c1");
  const resultat = await diffuser(client, REQUETE, generation, "systeme-v1@test");
  assert.equal(generation.texte, "Bissap, gingembre.");
  assert.equal(resultat.repris, false);
  assert.equal(client.requetes.length, 1);
  const ligne = lignesDuJournal(journal)[0]!;
  assert.equal(ligne.requete, "req_test");
  assert.ok(Number(ligne.cout_dollars) > 0);
});

test("une coupure en plein flux est reprise sans doublon", async () => {
  const coupe = new FauxFlux(["Nous avons ", "du bissap", " et"], { coupure: 2, erreur: coupure() });
  const suite = new FauxFlux([" du gingembre."], { message: messageFinal(" du gingembre.") });
  const client = new FauxClientFlux(coupe, suite);
  const generation = new Generation("c1");
  const resultat = await diffuser(client, REQUETE, generation);
  assert.ok(resultat.repris);
  assert.equal(generation.texte, "Nous avons du bissap du gingembre.");
  // La deuxième requête contient la réponse partielle, pas la première requête en entier deux fois.
  assert.match(String(client.requetes[1]!.messages.at(-1)!.content), /Nous avons du bissap/);
  assert.deepEqual(lignesDuJournal(journal).map((l) => l.interrompu ?? false), [true, false]);
});

test("un flux fermé sans message_stop est repris", async () => {
  const tronque = new FauxFlux(["Nous avons "], { message: messageFinal("Nous avons ", { raisonArret: null }) });
  const client = new FauxClientFlux(tronque, new FauxFlux(["du bissap."]));
  const generation = new Generation("c1");
  assert.ok((await diffuser(client, REQUETE, generation)).repris);
  assert.equal(generation.texte, "Nous avons du bissap.");
});

test("une erreur avant le premier morceau renvoie la même requête", async () => {
  const client = new FauxClientFlux(new FauxFlux(["x"], { coupure: 0, erreur: erreurApi(500) }), new FauxFlux(["Bonjour."]));
  const resultat = await diffuser(client, REQUETE, new Generation("c1"));
  assert.equal(resultat.repris, false);
  assert.deepEqual(client.requetes[1], REQUETE);
});

test("une requête refusée n'est pas reprise", async () => {
  const client = new FauxClientFlux(new FauxFlux(["x"], { coupure: 0, erreur: erreurApi(400, "invalid_request_error") }));
  await assert.rejects(diffuser(client, REQUETE, new Generation("c1")), Anthropic.BadRequestError);
  assert.equal(client.requetes.length, 1);
});
