// Ce que fait vraiment le SDK TypeScript quand un flux casse, contre un faux serveur local
// (python/tests/test_ch06_coupure.py).
//
// Aucun appel à l'API : le client du SDK parle à un petit serveur sur 127.0.0.1, qui commence une
// réponse en streaming puis la coupe de trois façons. De quoi vérifier, avec la version installée du
// SDK, ce que comptoir/flux.ts doit reconnaître. Le SDK TypeScript ne se comporte pas comme celui de
// Python : un flux fermé sans message_stop y lève une erreur, au lieu de rendre un message tronqué.

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { type Socket, createServer } from "node:net";
import { beforeEach, test } from "node:test";
import { Generation, diffuser, reprenable } from "../comptoir/flux.ts";
import { journalTemporaire } from "./faux_clients.ts";

type Fin = "coupure" | "erreur" | "fermeture_propre" | "complete";

const DEBUT: [string, object][] = [
  ["message_start", { type: "message_start", message: {
    id: "msg_local", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour, " } }],
];
const FIN_NORMALE: [string, object][] = [
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
  ["message_stop", { type: "message_stop" }],
];
const SURCHARGE: [string, object] = ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];

/** Un événement SSE, dans un morceau HTTP « chunked », comme l'envoie l'API. */
function morceau(nom: string, donnees: object): Buffer {
  const octets = Buffer.from(`event: ${nom}\ndata: ${JSON.stringify(donnees)}\n\n`);
  return Buffer.concat([Buffer.from(`${octets.length.toString(16)}\r\n`), octets, Buffer.from("\r\n")]);
}

/** Un serveur qui répond aux requêtes successives selon les fins données, dans l'ordre. */
async function serveur(...fins: Fin[]) {
  const s = createServer((socket: Socket) => {
    let recu = Buffer.alloc(0);
    socket.on("data", (donnees: Buffer) => {
      recu = Buffer.concat([recu, donnees]);
      const entetes = recu.indexOf("\r\n\r\n");
      if (entetes < 0) return;
      const longueur = Number(/content-length:\s*(\d+)/i.exec(recu.subarray(0, entetes).toString())?.[1] ?? 0);
      if (recu.length - entetes - 4 < longueur) return;
      recu = Buffer.alloc(0);
      const fin = fins.shift() ?? "complete";
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nrequest-id: req_local\r\ntransfer-encoding: chunked\r\n\r\n");
      for (const [nom, d] of DEBUT) socket.write(morceau(nom, d));
      if (fin === "erreur") socket.write(morceau(...SURCHARGE));
      if (fin === "complete") for (const [nom, d] of FIN_NORMALE) socket.write(morceau(nom, d));
      if (fin !== "coupure") socket.write("0\r\n\r\n"); // fin normale du corps HTTP
      // fin === "coupure" : on ferme sans terminer le corps, comme un réseau qui lâche
      setTimeout(() => socket.destroy(), 20);
    });
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address() as { port: number };
  const client = new Anthropic({ apiKey: "cle-factice-locale", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
  return { client, fermer: () => new Promise((ok) => s.close(ok)) };
}

async function essayer(fin: Fin): Promise<{ recu: string[]; message: Anthropic.Message | null; erreur: unknown }> {
  const { client, fermer } = await serveur(fin);
  const recu: string[] = [];
  try {
    const flux = client.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Bonjour" }] });
    for await (const e of flux) if (e.type === "content_block_delta" && e.delta.type === "text_delta") recu.push(e.delta.text);
    return { recu, message: await flux.finalMessage(), erreur: null };
  } catch (erreur) {
    return { recu, message: null, erreur };
  } finally {
    await fermer();
  }
}

beforeEach(() => {
  journalTemporaire();
});

test("une connexion coupée remonte comme une erreur du SDK, pas comme une erreur de l'API", async () => {
  const { recu, erreur } = await essayer("coupure");
  assert.deepEqual(recu, ["Bonjour, "]); // le début est bien arrivé
  assert.ok(erreur instanceof Anthropic.AnthropicError);
  assert.ok(!(erreur instanceof Anthropic.APIError)); // pas de statut
  assert.ok(erreur.cause !== undefined); // l'erreur du fetch de Node, « terminated »
  assert.ok(reprenable(erreur));
});

test("une erreur en plein flux n'a pas de statut, mais son type", async () => {
  const { recu, erreur } = await essayer("erreur");
  assert.deepEqual(recu, ["Bonjour, "]);
  assert.ok(erreur instanceof Anthropic.APIError);
  assert.equal(erreur.status, undefined);
  assert.equal(erreur.type, "overloaded_error");
  assert.ok(reprenable(erreur));
});

test("un flux fermé sans message_stop lève une erreur, sans cause", async () => {
  const { recu, erreur } = await essayer("fermeture_propre");
  assert.deepEqual(recu, ["Bonjour, "]);
  // Python rend ici un message tronqué, sans raison d'arrêt ; le SDK TypeScript lève une erreur.
  assert.ok(erreur instanceof Anthropic.AnthropicError && !(erreur instanceof Anthropic.APIError));
  assert.equal(erreur.cause, undefined);
});

test("avec le vrai SDK, une réponse coupée ou tronquée est reprise une fois", async () => {
  for (const fin of ["coupure", "fermeture_propre"] as const) {
    const { client, fermer } = await serveur(fin, "complete");
    try {
      const generation = new Generation("c1");
      const resultat = await diffuser(client, { model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Bonjour" }] }, generation);
      assert.ok(resultat.repris, fin);
      assert.equal(generation.texte, "Bonjour, Bonjour, ", fin); // le faux serveur répète son début
      assert.equal(resultat.message.stop_reason, "end_turn", fin);
    } finally {
      await fermer();
    }
  }
});
