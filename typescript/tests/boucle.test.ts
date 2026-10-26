// La boucle d'outils et le Comptoir qui prend des commandes, avec un faux client : aucun appel payant
// (python/tests/test_boucle.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { converser } from "../comptoir/boucle.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import type { ClientMessages, MessageRecu } from "../comptoir/client.ts";
import { ComptoirCommandes, rendreRecapitulatif } from "../comptoir/commandes.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { ErreurComptoir, REFUS } from "../comptoir/erreurs.ts";
import { OUTILS, Outils } from "../comptoir/outils.ts";
import { fauxMessage, journalTemporaire, regler, remettreLesReglages } from "./faux_clients.ts";

beforeEach(() => {
  journalTemporaire();
  regler({ MODELE: "claude-sonnet-5-5", EFFORT: null, QUOTA_CLIENT_JOUR: 1.0 });
});
afterEach(remettreLesReglages);

const reponse = (blocs: object[], raisonArret: Anthropic.StopReason = "end_turn") =>
  fauxMessage({ contenu: blocs, usage: { input_tokens: 1500, output_tokens: 120 }, raisonArret });
const texte = (t: string) => ({ type: "text", text: t, citations: null });
const outil = (name: string, input: object, id: string) => ({ type: "tool_use", id, name, input, caller: { type: "direct" } });

/** Rend les réponses prévues, une par appel, et garde chaque requête reçue (copiée, telle qu'envoyée). */
class FauxClient implements ClientMessages {
  readonly requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly reponses: MessageRecu[];
  readonly messages: ClientMessages["messages"];
  constructor(...reponses: MessageRecu[]) {
    this.reponses = reponses;
    this.messages = {
      countTokens: async () => ({ input_tokens: 1500 }),
      create: async (requete) => {
        this.requetes.push(JSON.parse(JSON.stringify(requete)));
        return this.reponses.shift()!;
      },
    };
  }
}

const REQUETE: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5-5", max_tokens: 2000, system: "s", tools: OUTILS,
  messages: [{ role: "user", content: "Il vous reste de l'ananas et du gingembre ?" }],
};

test("deux appels en parallèle rendent leurs résultats dans un seul message", async () => {
  const client = new FauxClient(
    reponse([
      { type: "thinking", thinking: "", signature: "sig" },
      outil("stock_verifier", { produits: ["Jus d'ananas"] }, "t1"),
      outil("stock_verifier", { produits: ["Jus de gingembre"] }, "t2"),
    ], "tool_use"),
    reponse([texte("Oui : 12 ananas et 25 gingembres.")]),
  );
  const tour = await converser(client, REQUETE, new Outils(new Boutique(), "c1"), new Budget(), "c1");
  assert.equal(tour.texte, "Oui : 12 ananas et 25 gingembres.");
  const deuxieme = client.requetes[1]!.messages;
  assert.deepEqual((deuxieme[1]!.content as object[])[0], { type: "thinking", thinking: "", signature: "sig" }); // intacte
  const resultats = deuxieme[2]!.content as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(resultats.map((r) => r.tool_use_id), ["t1", "t2"]);
  assert.equal(deuxieme.length, 3);
  assert.deepEqual(tour.nouveauxMessages.map((m) => m.role), ["assistant", "user", "assistant"]);
});

test("une boucle qui tourne en rond est arrêtée", async () => {
  const boucle = [0, 1, 2].map((i) => reponse([outil("stock_verifier", { produits: ["Jus d'ananas"] }, `t${i}`)], "tool_use"));
  await assert.rejects(
    converser(new FauxClient(...boucle), REQUETE, new Outils(new Boutique(), "c1"), new Budget(), "c1", null, 3),
    (e: unknown) => e instanceof ErreurComptoir && e.diagnostic.code === "boucle_trop_longue",
  );
});

function comptoir(...reponses: MessageRecu[]) {
  const boutique = new Boutique(":memory:", { hasard: () => 4821 });
  return { c: new ComptoirCommandes(new FauxClient(...reponses), boutique, new Budget(), "c1"), boutique };
}

const PREPARER = { lignes: [{ produit: "Jus de bissap", quantite: 6 }], nom_client: "Mme Hounkpè", quartier: "Akpakpa" };

test("de la commande à la confirmation", async () => {
  const { c, boutique } = comptoir(
    reponse([outil("commande_preparer", PREPARER, "t1")], "tool_use"),
    reponse([texte("Voici votre récapitulatif ; vérifiez-le avant de confirmer.")]),
  );
  const premiere = await c.repondre("6 bissap à Akpakpa, au nom de Mme Hounkpè");
  // Le total et le code affichés au client viennent du code, pas de Claude.
  const code = boutique.recapitulatifs("c1")[0]!.code;
  assert.ok(premiere.texte.includes("Total : 6 000 FCFA"));
  assert.ok(premiere.texte.includes(`OUI ${code}`));
  assert.deepEqual(boutique.commandes(), []); // rien n'est créé avant la confirmation

  const confirmation = await c.repondre(`oui ${code}`);
  assert.equal(confirmation.tour, null); // la confirmation n'est pas passée par Claude
  assert.ok(confirmation.texte.includes("C-0001"));
  assert.equal(boutique.commandes().length, 1);
  assert.ok(confirmation.texte.includes("est enregistrée, pour un total de 6 000 FCFA."));
  assert.equal((c.client as FauxClient).requetes.length, 2); // aucun appel de plus pour confirmer
  assert.deepEqual(c.historique.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
});

test("un faux code ne crée rien", async () => {
  const { c, boutique } = comptoir(reponse([outil("commande_preparer", PREPARER, "t1")], "tool_use"), reponse([texte("Vérifiez le récapitulatif.")]));
  await c.repondre("6 bissap");
  const code = boutique.recapitulatifs("c1")[0]!.code;
  const faux = code !== "0000" ? "0000" : "1111";
  assert.match((await c.repondre(`OUI ${faux}`)).texte, /pas pu confirmer/);
  assert.deepEqual(boutique.commandes(), []);
});

test("une réponse refusée n'entre pas dans l'historique", async () => {
  const refus = { ...reponse([], "refusal"), stop_details: { type: "refusal", category: "general_harms", explanation: null } } as unknown as MessageRecu;
  const { c } = comptoir(refus);
  assert.equal((await c.repondre("Une demande refusée")).texte, REFUS);
  assert.deepEqual(c.historique, []);
});

test("le récapitulatif officiel", () => {
  const recap = new Boutique().preparer("c1", [{ produit: "Jus de bissap", quantite: 2 }], "M. Dossou", "Zogbo");
  const t = rendreRecapitulatif(recap);
  assert.ok(t.includes("2 × Jus de bissap : 2 000 FCFA") && t.includes("Livraison (Zogbo") && t.includes(": 500 FCFA"));
  assert.ok(t.endsWith(`OUI ${recap.code_de_confirmation}`));
});

test("la base d'Awa est envoyée, mais jamais enregistrée", async () => {
  // Chapitre 11 : le Comptoir v3 joint la base au premier message de chaque requête, avec le cache.
  const client = new FauxClient(reponse([texte("Bonjour !")]), reponse([texte("Oui.")]));
  const c = new ComptoirCommandes(client, new Boutique(), new Budget(), "c1", { versionPrompt: "v3", connaissances: chargerBase().slice(0, 3), cache: true });
  await c.repondre("Bonjour");
  await c.repondre("Vous livrez le dimanche ?");
  const [premiere, deuxieme] = client.requetes;
  assert.deepEqual((premiere!.messages[0]!.content as { type: string }[]).slice(0, 3).map((b) => b.type), ["search_result", "search_result", "search_result"]);
  assert.deepEqual(deuxieme!.messages[0], premiere!.messages[0]); // même début de requête : lu dans le cache
  assert.deepEqual(premiere!.cache_control, { type: "ephemeral" });
  assert.deepEqual(premiere!.tools, OUTILS);
  assert.equal(typeof c.historique[0]!.content, "string"); // l'historique garde le message du client seul
});
