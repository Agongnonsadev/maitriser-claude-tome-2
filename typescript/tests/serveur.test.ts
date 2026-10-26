// Les outils serveur : définitions, reprise après une pause, sources, erreurs, fichiers, coût
// (python/tests/test_serveur.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { MessageRecu } from "../comptoir/client.ts";
import { cout } from "../comptoir/couts.ts";
import { appeler, erreursOutils, fichiersProduits, lectureWeb, rechercheWeb, sources, texte } from "../comptoir/serveur.ts";
import { fauxMessage, journalTemporaire, lignesDuJournal, presque } from "./faux_clients.ts";

let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
});

test("les définitions", () => {
  assert.equal(rechercheWeb().type, "web_search_20250305");
  assert.equal(rechercheWeb(3, null, true).type, "web_search_20260209");
  assert.deepEqual((rechercheWeb(3, ["gouv.bj"]) as Anthropic.WebSearchTool20250305).allowed_domains, ["gouv.bj"]);
  const lieu = (rechercheWeb() as Anthropic.WebSearchTool20250305).user_location!;
  assert.equal(lieu.city, "Cotonou");
  assert.ok(!("country" in lieu)); // « BJ » refusé par l'API (400)
  assert.ok(!("allowed_domains" in rechercheWeb()));
  const lecture = lectureWeb(2, 2000);
  assert.ok(lecture.type === "web_fetch_20250910" && lecture.max_content_tokens === 2000);
});

test("une recherche coûte un centime en plus des tokens", () => {
  const prix = cout("claude-sonnet-5-5", {
    input_tokens: 10_000,
    output_tokens: 500,
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
  } as Anthropic.Usage);
  assert.equal(prix.recherches, 2);
  presque(prix.dollars, (10_000 * 2) / 1e6 + (500 * 10) / 1e6 + 2 * 0.01);
});

const message = (raisonArret: Anthropic.StopReason, blocs: object[], recherches = 0): MessageRecu =>
  fauxMessage({
    contenu: blocs,
    raisonArret,
    identifiant: "req",
    usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: recherches, web_fetch_requests: 0 } as Anthropic.ServerToolUsage },
  });

class FauxClient {
  readonly requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly messages = this;
  constructor(private readonly reponses: MessageRecu[]) {}
  async create(requete: Anthropic.MessageCreateParamsNonStreaming): Promise<MessageRecu> {
    this.requetes.push(requete);
    return this.reponses.shift()!;
  }
  async countTokens(): Promise<Anthropic.MessageTokensCount> {
    throw new Error("non utilisé");
  }
}

const requete = (): Anthropic.MessageCreateParamsNonStreaming => ({
  model: "claude-sonnet-5-5",
  max_tokens: 100,
  tools: [rechercheWeb()],
  messages: [{ role: "user", content: "?" }],
});

test("une pause se reprend en renvoyant la réponse telle quelle", async () => {
  const pause = message("pause_turn", [{ type: "server_tool_use", id: "srv1" }], 1);
  const fin = message("end_turn", [{ type: "text", text: "Voici.", citations: null }], 1);
  const client = new FauxClient([pause, fin]);
  const premiere = requete();
  const resultat = await appeler(client, premiere);
  assert.ok(resultat.texte === "Voici." && resultat.reprises === 1 && resultat.recherches === 2);
  const deuxieme = client.requetes[1]!;
  assert.deepEqual(deuxieme.messages.at(-1), { role: "assistant", content: pause.content });
  assert.deepEqual(deuxieme.tools, premiere.tools); // les mêmes outils, sinon l'API refuse la reprise
  assert.equal(premiere.messages.length, 1); // la requête de départ n'est pas modifiée
  assert.deepEqual(lignesDuJournal(journal).map((l) => l.stop_reason), ["pause_turn", "end_turn"]);
});

test("une pause sans fin s'arrête après le nombre de reprises permis", async () => {
  const pauses = Array.from({ length: 3 }, () => message("pause_turn", [{ type: "server_tool_use", id: "srv1" }]));
  await assert.rejects(appeler(new FauxClient(pauses), requete(), 2), /Toujours en pause après 2 reprises/);
});

test("les sources, le texte et les erreurs", () => {
  const citation = { type: "web_search_result_location", url: "https://exemple.bj/feries", title: "Jours fériés" };
  const reponse = message("end_turn", [
    { type: "text", text: "Le 1er novembre ", citations: null },
    { type: "text", text: "est férié.", citations: [citation, citation] },
    { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  ]);
  assert.equal(texte(reponse), "Le 1er novembre est férié.");
  assert.deepEqual(sources(reponse), [{ source: "https://exemple.bj/feries", titre: "Jours fériés" }]);
  assert.deepEqual(erreursOutils(reponse), ["web_search_tool_result : max_uses_exceeded"]);
});

test("une citation de document se reconnaît à son titre", () => {
  const citation = { type: "char_location", document_title: "Conditions de vente", cited_text: "…" };
  const reponse = message("end_turn", [{ type: "text", text: "Oui.", citations: [citation] }]);
  assert.deepEqual(sources(reponse), [{ source: "Conditions de vente", titre: "Conditions de vente" }]);
});

test("les fichiers produits par le code", () => {
  const sortie = { type: "bash_code_execution_output", file_id: "file_123" };
  const bloc = { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: [sortie] } };
  assert.deepEqual(fichiersProduits(message("end_turn", [bloc])), ["file_123"]);
  const echec = { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_tool_result_error", error_code: "unavailable" } };
  assert.deepEqual(fichiersProduits(message("end_turn", [echec])), []);
  assert.deepEqual(erreursOutils(message("end_turn", [echec])), ["bash_code_execution_tool_result : unavailable"]);
});
