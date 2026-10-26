// Le Comptoir sur le web, avec un faux client : flux SSE, reprise, une réponse à la fois ; budget, refus
// et erreurs (chapitre 8) ; limites, taille maximale et purge (chapitre 18). Les tests de
// python/tests/test_web.py et ceux du serveur dans python/tests/test_ch18.py.

import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocketServer } from "ws";
import { Budget } from "../comptoir/budget.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { INDISPONIBLE, REFUS } from "../comptoir/erreurs.ts";
import { Generation } from "../comptoir/flux.ts";
import { isoformat } from "../comptoir/base.ts";
import { charger, chargerDonnees } from "../comptoir/prompt.ts";
import { type Serveur, creerApp } from "../comptoir/web.ts";
import { FauxClientFlux, FauxFlux, erreurApi, journalTemporaire, messageFinal, regler, remettreLesReglages } from "./faux_clients.ts";

beforeEach(() => {
  journalTemporaire();
  // BUDGET : jamais de fichier pendant les tests.
  regler({ MODELE: "claude-sonnet-5-5", EFFORT: null, BUDGET: ":memory:", QUOTA_CLIENT_JOUR: 0.15, QUOTA_RESEAU_JOUR: 0.4 });
});
afterEach(remettreLesReglages);

/** Découpe un flux SSE en [nom, données]. Les commentaires (signes de vie) sont ignorés. */
function lireSse(corps: string): [string, Record<string, unknown>][] {
  const evenements: [string, Record<string, unknown>][] = [];
  for (const bloc of corps.split("\n\n")) {
    const lignes = bloc.split("\n");
    const nom = lignes.find((l) => l.startsWith("event: "))?.slice(7);
    const donnees = lignes.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (nom) evenements.push([nom, JSON.parse(donnees)]);
  }
  return evenements;
}

/** Une connexion vue du serveur Node : l'adresse d'où elle vient (comme TestClient(client=...) en Python). */
const depuis = (adresse: string) => ({ incoming: { socket: { remoteAddress: adresse } } }) as unknown as HttpBindings;

async function envoyer(s: Serveur, texte: string, idMessage: string, conversation: string | null = null, recus = 0, adresse = "127.0.0.1") {
  const r = await s.app.request(
    "/api/messages",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation, id_message: idMessage, texte, depuis: recus }) },
    depuis(adresse),
  );
  const corps = await r.text();
  return { r, evenements: r.status === 200 ? lireSse(corps) : [] };
}

const conversationDe = (evenements: [string, Record<string, unknown>][]) => String(evenements[0]![1].conversation);

test("la page s'affiche", async () => {
  const r = await creerApp(new FauxClientFlux(), new Conversations()).app.request("/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Le Comptoir d'Awa/);
});

test("la réponse arrive en morceaux, puis est rangée", async () => {
  const conversations = new Conversations();
  const s = creerApp(new FauxClientFlux(new FauxFlux(["Nous avons ", "du bissap."])), conversations);
  const { r, evenements } = await envoyer(s, "Vos jus ?", "message-0001");
  assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.deepEqual(evenements.map(([nom]) => nom), ["conversation", "texte", "texte", "fin"]);
  const historique = conversations.historique(conversationDe(evenements));
  assert.deepEqual(historique[0], { role: "user", content: "<message_client>\nVos jus ?\n</message_client>" });
  // La réponse est rangée telle quelle, réflexion comprise.
  assert.deepEqual((historique[1]!.content as { type: string }[]).map((b) => b.type), ["thinking", "text"]);
});

test("le tour suivant renvoie l'historique sans le réécrire", async () => {
  const client = new FauxClientFlux(new FauxFlux(["Oui, le bissap."]), new FauxFlux(["Six bouteilles : 6 000 FCFA."]));
  const s = creerApp(client, new Conversations());
  const { evenements } = await envoyer(s, "Vous avez du bissap ?", "message-0001");
  await envoyer(s, "Et pour six bouteilles ?", "message-0002", conversationDe(evenements));
  const [premiere, deuxieme] = client.requetes;
  assert.deepEqual(deuxieme!.messages.slice(0, 1), premiere!.messages); // même début, au caractère près
  assert.equal(deuxieme!.messages[1]!.role, "assistant");
  assert.equal((deuxieme!.messages[1]!.content as { signature?: string }[])[0]!.signature, "signature-de-test");
});

test("le même message renvoyé après une coupure n'appelle pas Claude deux fois", async () => {
  const client = new FauxClientFlux(new FauxFlux(["Nous avons ", "du bissap", "."]));
  const s = creerApp(client, new Conversations());
  const premier = await envoyer(s, "Vos jus ?", "message-0001");
  // Le navigateur avait reçu 2 morceaux avant la coupure : il redemande la suite.
  const reprise = await envoyer(s, "Vos jus ?", "message-0001", conversationDe(premier.evenements), 2);
  assert.equal(client.requetes.length, 1);
  assert.deepEqual(reprise.evenements.filter(([nom]) => nom === "texte").map(([, d]) => d), [{ texte: "." }]);
  assert.equal(reprise.evenements.at(-1)![0], "fin");
});

test("une réponse à la fois par conversation", async () => {
  const conversations = new Conversations();
  const s = creerApp(new FauxClientFlux(), conversations);
  const conversation = conversations.creer(charger().identifiant);
  s.comptoir.generations.set("message-en-cours", new Generation(conversation)); // pas encore terminée
  const { r } = await envoyer(s, "Et le gingembre ?", "message-0002", conversation);
  assert.equal(r.status, 409);
});

test("une conversation expirée repart à zéro", async () => {
  const conversations = new Conversations();
  const ancienne = conversations.creer(charger().identifiant);
  conversations.db.prepare("UPDATE conversations SET derniere_activite = ?").run(isoformat(new Date(Date.now() - 2 * 24 * 3600 * 1000)));
  const client = new FauxClientFlux(new FauxFlux(["Bonjour !"]));
  const { evenements } = await envoyer(creerApp(client, conversations), "Bonjour", "message-0001", ancienne);
  assert.equal(evenements[0]![1].renouvelee, "expiree");
  assert.notEqual(evenements[0]![1].conversation, ancienne);
  assert.deepEqual(client.requetes[0]!.messages.slice(0, -1), []); // rien de l'ancienne conversation
});

test("un catalogue modifié ouvre une nouvelle conversation", async () => {
  const client = new FauxClientFlux(new FauxFlux(["Le bissap est à 1 000 FCFA."]), new FauxFlux(["Le bissap est à 1 100 FCFA."]));
  const donnees = chargerDonnees();
  const s = creerApp(client, new Conversations(), undefined, () => charger("v1", donnees));
  const premier = await envoyer(s, "Le prix du bissap ?", "message-0001");
  const conversation = conversationDe(premier.evenements);
  // Awa change un prix : le prompt système rendu change, son empreinte aussi.
  donnees.produits[0]!.prix_fcfa += 100;
  const second = await envoyer(s, "Et maintenant ?", "message-0002", conversation);
  assert.equal(second.evenements[0]![1].renouvelee, "nouveau_prompt");
  assert.notEqual(second.evenements[0]![1].conversation, conversation);
  // L'ancien historique, et ses blocs de réflexion, ne sont pas renvoyés avec le nouveau prompt.
  assert.equal(client.requetes[1]!.messages.length, 1);
});

test("une erreur est dite au client, et rien n'est rangé", async () => {
  const conversations = new Conversations();
  const client = new FauxClientFlux(new FauxFlux(["x"], { coupure: 0, erreur: erreurApi(400, "invalid_request_error") }));
  const { evenements } = await envoyer(creerApp(client, conversations), "Bonjour", "message-0001");
  assert.deepEqual(evenements.at(-1), ["erreur", { type: "erreur", message: INDISPONIBLE }]);
  assert.deepEqual(conversations.historique(conversationDe(evenements)), []);
});

test("la même conversation par WebSocket", async () => {
  const { app } = creerApp(new FauxClientFlux(new FauxFlux(["Nous livrons ", "à Cotonou."])), new Conversations());
  const websockets = new WebSocketServer({ noServer: true });
  const serveur = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: websockets } });
  await new Promise((ok) => serveur.once("listening", ok));
  const { port } = serveur.address() as { port: number };
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const recus: Record<string, unknown>[] = [];
    await new Promise<void>((ok, echec) => {
      ws.onerror = () => echec(new Error("WebSocket en erreur"));
      ws.onopen = () => ws.send(JSON.stringify({ id_message: "message-0001", texte: "Livrez-vous à Akpakpa ?" }));
      ws.onmessage = (e) => {
        recus.push(JSON.parse(String(e.data)));
        if (recus.length === 4) ok();
      };
    });
    ws.close();
    assert.deepEqual(recus.map((e) => e.type), ["conversation", "texte", "texte", "fin"]);
    assert.equal(recus.filter((e) => e.type === "texte").map((e) => e.texte).join(""), "Nous livrons à Cotonou.");
  } finally {
    websockets.close();
    await new Promise((ok) => serveur.close(ok));
  }
});

// --- Chapitre 8 : budget, refus, erreurs ---------------------------------------------------

test("hors budget, le client est prévenu et Claude n'est pas appelé", async () => {
  regler({ QUOTA_CLIENT_JOUR: 0.0001 });
  const client = new FauxClientFlux(new FauxFlux(["Bonjour !"]));
  const { evenements } = await envoyer(creerApp(client, new Conversations(), new Budget()), "Bonjour", "message-0001");
  assert.deepEqual(evenements.at(-1), ["erreur", { type: "erreur", message: INDISPONIBLE }]);
  assert.deepEqual(client.requetes, []); // le comptage a eu lieu, pas l'appel
  assert.equal(client.comptages, 1);
});

test("un refus efface le début et n'entre pas dans l'historique", async () => {
  const conversations = new Conversations();
  const refus = new FauxFlux(["Je vais "], { message: messageFinal("Je vais ", { raisonArret: "refusal" }) });
  const { evenements } = await envoyer(creerApp(new FauxClientFlux(refus), conversations), "Une demande refusée", "message-0001");
  assert.deepEqual(evenements.at(-1), ["refus", { type: "refus", message: REFUS }]);
  assert.deepEqual(conversations.historique(conversationDe(evenements)), []);
});

test("une erreur de l'API avant tout texte libère le budget", async () => {
  const budget = new Budget();
  const client = new FauxClientFlux(new FauxFlux(["x"], { coupure: 0, erreur: erreurApi(400, "invalid_request_error") }));
  await envoyer(creerApp(client, new Conversations(), budget), "Bonjour", "message-0001");
  assert.equal(budget.duJour(), 0);
});

// --- Chapitre 18 : limites par adresse, taille maximale, purge ------------------------------

/** Un client qui répond toujours, pour les tests de limites. */
const toujours = () => {
  const client = new FauxClientFlux();
  client.messages.stream = (requete) => {
    client.requetes.push(requete);
    return new FauxFlux(["Bonjour !"]);
  };
  return client;
};

test("une adresse ne peut pas ouvrir une conversation à chaque message", async () => {
  regler({ LIMITE_CONVERSATIONS_HEURE: 3 });
  const s = creerApp(toujours(), new Conversations(), new Budget());
  const statuts = [];
  for (let i = 0; i < 5; i++) statuts.push((await envoyer(s, "Bonjour", crypto.randomUUID(), null, 0, "196.168.10.20")).r.status);
  assert.deepEqual(statuts, [200, 200, 200, 429, 429]);
  // Une vraie cliente, ailleurs, n'est pas gênée.
  assert.equal((await envoyer(s, "Bonjour", crypto.randomUUID(), null, 0, "196.168.77.5")).r.status, 200);
});

test("une rafale s'arrête, et le navigateur sait quand revenir", async () => {
  regler({ LIMITE_MESSAGES_MINUTE: 4 });
  const s = creerApp(toujours(), new Conversations(), new Budget());
  const reponses = [];
  for (let i = 0; i < 6; i++) reponses.push((await envoyer(s, "Bonjour", crypto.randomUUID(), null, 0, "196.168.10.20")).r);
  assert.deepEqual(reponses.map((r) => r.status), [200, 200, 200, 200, 429, 429]);
  assert.ok(Number(reponses.at(-1)!.headers.get("retry-after")) >= 1);
});

test("un corps géant est refusé avant d'être lu, même envoyé en morceaux", async () => {
  const { app } = creerApp(toujours(), new Conversations(), new Budget());
  const corps = JSON.stringify({ conversation: null, id_message: crypto.randomUUID(), texte: "b".repeat(3_000_000) });
  const avecLongueur = await app.request("/api/messages", {
    method: "POST", body: corps, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(corps)) },
  });
  // Le même corps en morceaux, sans Content-Length.
  const morceaux = new ReadableStream<Uint8Array>({
    start(controleur) {
      for (let i = 0; i < corps.length; i += 10_000) controleur.enqueue(new TextEncoder().encode(corps.slice(i, i + 10_000)));
      controleur.close();
    },
  });
  const enMorceaux = await app.request("/api/messages", {
    method: "POST", body: morceaux, headers: { "content-type": "application/json" }, duplex: "half",
  } as RequestInit);
  assert.equal(avecLongueur.status, 413);
  assert.equal(enMorceaux.status, 413);
});

test("la page dit qu'on parle à une IA et n'insère jamais de HTML", async () => {
  const page = await (await creerApp(toujours(), new Conversations()).app.request("/")).text();
  assert.match(page.replaceAll("\n", " "), /intelligence artificielle/);
  const script = page.split("<script>")[1]!;
  const code = script.split("\n").map((l) => l.split("//")[0]).join("\n");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("les conversations anciennes sont purgées au démarrage", () => {
  const conversations = new Conversations();
  const ancienne = conversations.creer("p");
  conversations.ajouterTour(ancienne, [
    { role: "user", content: "Je suis Koffi, 97 00 00 00" },
    { role: "assistant", content: "Bonjour Koffi" },
  ], 10);
  conversations.db.prepare("UPDATE conversations SET derniere_activite = ?").run(isoformat(new Date(Date.now() - 31 * 24 * 3600 * 1000)));
  const arreter = creerApp(toujours(), conversations, new Budget()).demarrer();
  arreter();
  assert.equal(conversations.existe(ancienne), false);
});
