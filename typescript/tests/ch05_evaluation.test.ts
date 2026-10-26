// La comparaison de deux versions de prompt, avec un faux client : aucun appel payant
// (python/tests/test_evaluation.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { VARIANTES, chargerCas, requeteV0, requeteV1 } from "../ch05/evaluer_prompt.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { type Essai, ecrireCsv, evaluer, lireCsv, regressions, renoter, resumer } from "../comptoir/evaluation.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { creerCas } from "../comptoir/notation.ts";
import { fauxMessage, journalTemporaire } from "./faux_clients.ts";

/** La version « v1 » répond juste au cas prix ; « v0 » au cas remise seulement. */
const fauxClient = (): ClientMessages => ({
  messages: {
    create: async (requete: Anthropic.MessageCreateParamsNonStreaming) => {
      const question = String(requete.messages.at(-1)?.content);
      const v1 = question.includes("message_client");
      const texte = question.includes("prix")
        ? v1 ? "C'est 2 500 FCFA." : "C'est 3 000 FCFA."
        : v1 ? "D'accord, 10 % pour vous." : "Je transmets à Awa.";
      return fauxMessage({ contenu: [{ type: "text", text: texte, citations: null }], usage: { input_tokens: 1000, output_tokens: 100 } });
    },
    countTokens: async () => ({ input_tokens: 0 }),
  },
});

const CAS = [
  creerCas({ identifiant: "prix", question: "Le prix du sirop ?", doit_contenir: ["2 500"] }),
  creerCas({ identifiant: "remise", question: "Une remise ?", doit_transmettre: true }),
];

const modeleInitial = config.MODELE;
beforeEach(() => {
  journalTemporaire();
  config.MODELE = "claude-sonnet-5-5";
});
afterEach(() => {
  config.MODELE = modeleInitial;
});

test("les deux versions et la régression", async () => {
  const essais = await evaluer(fauxClient(), CAS, VARIANTES, 2, 10);
  assert.equal(essais.length, 2 * 2 * 2);
  const resume = new Map(resumer(essais).map((l) => [l.variante, l]));
  assert.equal(resume.get("v0")!.reussite, 0.5);
  assert.equal(resume.get("v1")!.reussite, 0.5);
  // Même score global, mais v1 casse un cas que v0 réussissait : c'est une régression.
  assert.deepEqual(regressions(essais, "v0", "v1"), ["remise"]);
});

test("seul le prompt change entre les variantes", () => {
  const [v0, v1] = [requeteV0(CAS[0]!), requeteV1(CAS[0]!)];
  assert.equal(v0.model, v1.model);
  assert.equal(v0.max_tokens, v1.max_tokens);
  assert.deepEqual(v0.output_config, v1.output_config);
  assert.notEqual(v0.system, v1.system);
});

test("le budget arrête l'évaluation", async () => {
  // Un appel coûte 0,003 $ sur Sonnet 5.5 : avec 0,004 $, on s'arrête après le deuxième.
  const essais = await evaluer(fauxClient(), CAS, VARIANTES, 3, 0.004);
  assert.equal(essais.length, 2);
});

test("les vingt cas du chapitre", () => {
  const cas = chargerCas();
  assert.equal(cas.length, 20);
  assert.equal(new Set(cas.map((c) => c.identifiant)).size, 20);
});

test("renoter relit les réponses sans appel", () => {
  const cas = [creerCas({ identifiant: "court", question: "?", doit_contenir: ["1 000"] })];
  const texte = "Bonjour ! Le jus est à 1 000 FCFA. Il se commande sur WhatsApp. Autre chose ?";
  const ancien: Essai = {
    variante: "v1", cas: "court", repetition: 1, reussi: false, raisons: "plus de 3 phrases", a_relire: "",
    reponse: texte, latence_s: 1.2, tokens_entree: 1700, tokens_sortie: 60, cout_dollars: 0.004, raison_arret: "end_turn",
  };
  const coupe: Essai = {
    variante: "v1", cas: "court", repetition: 2, reussi: false, raisons: "", a_relire: "",
    reponse: "1 000 FCFA", latence_s: 1.0, tokens_entree: 1700, tokens_sortie: 2000, cout_dollars: 0.02, raison_arret: "max_tokens",
  };
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "essais.csv");
  ecrireCsv([ancien, coupe], chemin);
  const relus = lireCsv(chemin);
  assert.deepEqual(relus, [ancien, coupe]); // les types reviennent intacts : entiers, réels, booléens
  const renotes = renoter(relus, cas);
  assert.ok(renotes[0]!.reussi && renotes[0]!.raisons === ""); // « Bonjour ! » ne compte plus comme une phrase
  assert.ok(!renotes[1]!.reussi && renotes[1]!.raisons.includes("max_tokens")); // la règle de l'arrêt reste
  assert.equal(renotes[0]!.cout_dollars, 0.004); // le coût est celui de l'appel d'origine : rien n'est rappelé
});

test("renotées ici, les vraies réponses du chapitre donnent les mêmes notes qu'en Python", () => {
  // Les réponses obtenues lors des mesures du livre (20 octobre 2026), et leur nouvelle notation par
  // la version Python : la grille TypeScript doit rendre exactement les mêmes verdicts.
  const essais = lireCsv(join(PYTHON, "ch05", "resultats", "essais.csv"));
  const attendus = lireCsv(join(PYTHON, "ch05", "resultats", "essais-renotes.csv"));
  const renotes = renoter(essais, chargerCas());
  assert.equal(renotes.length, attendus.length);
  assert.deepEqual(
    renotes.map((e) => [e.variante, e.cas, e.repetition, e.reussi, e.raisons]),
    attendus.map((e) => [e.variante, e.cas, e.repetition, e.reussi, e.raisons]),
  );
});
