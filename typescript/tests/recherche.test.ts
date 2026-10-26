// La recherche : BM25, embeddings, fusion des rangs, reclassement et contexte par Claude, sans appel
// payant (python/tests/test_recherche.py), et les mêmes classements que la version Python.

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, mock, test } from "node:test";
import type { MessageRecu } from "../comptoir/client.ts";
import { type Morceau, chargerBase, pourLaRecherche } from "../comptoir/connaissances.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import {
  IndexBM25,
  IndexVecteurs,
  contextualiser,
  fusionner,
  mots,
  plongeurVoyage,
  rappel,
  reclasser,
  requeteContexte,
  requeteReclassement,
} from "../comptoir/recherche.ts";
import { baseContextualisee, chargerQuestions } from "../ch11/outils_communs.ts";
import { fauxMessage, journalTemporaire, presque } from "./faux_clients.ts";

beforeEach(() => {
  journalTemporaire();
});

const morceau = (identifiant: string, texte: string): Morceau => ({ identifiant, document: "doc", titre: identifiant, texte, contexte: "" });

test("les mots d'une question", () => {
  assert.deepEqual(mots("Êtes-vous ouverts le dimanche ?"), ["ete", "ouvert", "dimanche"]);
  // « prix » devient « pri », au singulier comme au pluriel : seule compte la même forme des deux côtés.
  assert.deepEqual(mots("Les bouteilles et le prix"), ["bouteille", "pri"]);
  assert.deepEqual(mots("la bouteille, les prix"), ["bouteille", "pri"]);
  assert.deepEqual(mots("Œuf’s"), ["ufs"]); // hors ASCII, tout disparaît, comme encode("ascii", "ignore")
});

test("BM25 trouve le mot exact", () => {
  const resultats = new IndexBM25(chargerBase()).chercher("Vous livrez à Godomey ?", 3).map(([m]) => m.identifiant);
  // « Godomey » n'apparaît que dans la page des zones ; « livrez », mot pour mot, dans le titre d'une
  // question de la FAQ, plus courte : elle passe devant. Le bon morceau est dans les trois premiers.
  assert.deepEqual(resultats.slice(0, 2), ["kb://faq#livrez-vous-hors-de-cotonou", "kb://zones-de-livraison#hors-de-cotonou"]);
});

test("BM25 : un mot rare compte plus qu'un mot courant", () => {
  const index = new IndexBM25([morceau("a", "jus jus jus"), morceau("b", "jus corossol"), morceau("c", "jus ananas")]);
  assert.equal(index.chercher("jus corossol", 1)[0]![0].identifiant, "b");
  assert.deepEqual(index.chercher("le la les"), []); // que des mots vides : aucun résultat, plutôt qu'un hasard
});

test("les embeddings cherchent par le sens", async () => {
  const vecteurs: Record<string, number[]> = { livraison: [1, 0], paiement: [0, 1], "on livre quand": [0.9, 0.1] };
  const appels: string[] = [];
  const plonger = (textes: string[], typeEntree: string): number[][] => {
    appels.push(typeEntree);
    return textes.map((t) => vecteurs[t.split(" ").at(-1)!] ?? vecteurs[t]!);
  };
  const index = await IndexVecteurs.creer([morceau("l", "livraison"), morceau("p", "paiement")], plonger);
  assert.equal((await index.chercher("on livre quand", 1))[0]![0].identifiant, "l");
  assert.deepEqual(appels, ["document", "query"]); // Voyage distingue les documents des questions
});

test("le plongeur Voyage appelle l'API de MongoDB", async () => {
  const vu: { url?: string; entetes?: Record<string, string>; corps?: unknown } = {};
  const faux = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    Object.assign(vu, { url, entetes: init.headers, corps: JSON.parse(String(init.body)) });
    const reponse = { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] };
    return new Response(JSON.stringify(reponse), { status: 200 });
  });
  try {
    const vecteurs = await plongeurVoyage("voyage-4", "cle-de-test")(["a", "b"], "document");
    assert.deepEqual(vecteurs, [[1, 0], [0, 1]]); // remis dans l'ordre des textes
    assert.equal(vu.url, "https://ai.mongodb.com/v1/embeddings");
    assert.equal(vu.entetes!.Authorization, "Bearer cle-de-test");
    assert.deepEqual(vu.corps, { input: ["a", "b"], model: "voyage-4", input_type: "document" });
    faux.mock.mockImplementation(async () => new Response("{}", { status: 401 }));
    await assert.rejects(async () => plongeurVoyage("voyage-4", "mauvaise")(["a"], "query"), /HTTP 401/);
  } finally {
    faux.mock.restore();
  }
});

test("la fusion des rangs", () => {
  const [a, b, c] = [morceau("a", ""), morceau("b", ""), morceau("c", "")];
  const lexical: [Morceau, number][] = [[a, 12], [b, 3]];
  const semantique: [Morceau, number][] = [[b, 0.91], [c, 0.9]];
  const fusion = fusionner([lexical, semantique], { garder: 3 });
  assert.deepEqual(fusion.map(([m]) => m.identifiant), ["b", "a", "c"]); // b, bien placé deux fois, passe devant
});

test("le rappel", () => {
  assert.ok(rappel([[morceau("a", ""), 1]], ["x", "a"]) && !rappel([], ["a"]));
});

class FauxClient {
  readonly requetes: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly messages = this;
  constructor(private readonly textes: string[]) {}
  async create(requete: Anthropic.MessageCreateParamsNonStreaming): Promise<MessageRecu> {
    this.requetes.push(requete);
    return fauxMessage({ contenu: [{ type: "text", text: this.textes.shift()!, citations: null }], usage: { input_tokens: 100, output_tokens: 20 }, identifiant: "req" });
  }
  async countTokens(): Promise<Anthropic.MessageTokensCount> {
    throw new Error("non utilisé");
  }
}

test("le reclassement écarte les identifiants inconnus", async () => {
  const candidats = [morceau("a", "un"), morceau("b", "deux"), morceau("c", "trois")];
  const client = new FauxClient([JSON.stringify({ pertinents: ["c", "inconnu", "a", "c"] })]);
  const [choisis, prix] = await reclasser(client, "?", candidats, 3);
  assert.deepEqual(choisis.map((m) => m.identifiant), ["c", "a"]);
  presque(prix, (100 * 0.1 + 20 * 0.5) / 1e6); // Haiku 5.5
  assert.equal((client.requetes[0]!.output_config!.format as { type: string }).type, "json_schema");
  assert.deepEqual(await reclasser(new FauxClient([]), "?", []), [[], 0]);
});

test("la requête de reclassement ne demande pas de réponse", () => {
  const requete = requeteReclassement("Vous livrez ?", [morceau("a", "texte")], 3);
  assert.equal(requete.model, "claude-haiku-5-5");
  assert.ok(String(requete.messages[0]!.content).includes('<passage id="a">'));
});

test("le document à contextualiser est mis en cache", () => {
  const requete = requeteContexte("Le document entier.", morceau("a", "Un passage."));
  const [document, consigne] = requete.messages[0]!.content as Anthropic.TextBlockParam[];
  assert.deepEqual(document!.cache_control, { type: "ephemeral" });
  assert.ok(document!.text.includes("Le document entier."));
  assert.ok(!("cache_control" in consigne!) && consigne!.text.includes("Un passage."));
});

test("contextualiser : un appel par morceau", async () => {
  const client = new FauxClient([" Situe a. ", "Situe b."]);
  const [contextes, usages] = await contextualiser(client, "doc", [morceau("a", "x"), morceau("b", "y")]);
  assert.deepEqual(contextes, { a: "Situe a.", b: "Situe b." });
  assert.equal(usages.length, 2);
  // Le même document, à l'identique, dans chaque requête : c'est ce qui permet la lecture du cache.
  const premier = (r: Anthropic.MessageCreateParamsNonStreaming): unknown => (r.messages[0]!.content as unknown[])[0];
  assert.deepEqual(premier(client.requetes[0]!), premier(client.requetes[1]!));
});

// --- Les mêmes classements que la version Python -------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const sansPython = { skip: PYTHON_VENV ? false : "environnement Python absent" };
const python = (script: string, entree: unknown = null): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON,
      input: JSON.stringify(entree),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );

test("les mêmes mots et les mêmes scores BM25 que la version Python, sur les 20 questions", sansPython, () => {
  const questions = chargerQuestions().map((c) => c.question);
  const contextualisee = baseContextualisee();
  assert.ok(contextualisee, "les contextes de la version Python sont dans le dépôt");
  const classements = (base: Morceau[]): [string, number][][] => {
    const index = new IndexBM25(base);
    return questions.map((q) => index.chercher(q, 10).map(([m, s]): [string, number] => [m.identifiant, s]));
  };
  const attendu = python(
    `
import json, sys
from ch11.outils_communs import base_contextualisee
from comptoir.connaissances import charger_base
from comptoir.recherche import IndexBM25, mots
questions = json.load(sys.stdin)
def classements(base):
    index = IndexBM25(base)
    return [[[m.identifiant, s] for m, s in index.chercher(q, 10)] for q in questions]
print(json.dumps({"mots": [mots(q) for q in questions] + [mots(m.pour_la_recherche()) for m in charger_base()],
                  "brut": classements(charger_base()), "contextuel": classements(base_contextualisee())}))`,
    questions,
  ) as { mots: string[][]; brut: [string, number][][]; contextuel: [string, number][][] };
  assert.deepEqual([...questions.map(mots), ...chargerBase().map((m) => mots(pourLaRecherche(m)))], attendu.mots);
  // Les mêmes morceaux, dans le même ordre ; les scores à 10^-12 près : Math.log de V8 et celui de
  // Python diffèrent parfois au dernier bit (72 logarithmes sur 1 141 essayés le 23 octobre 2026).
  for (const [obtenus, attendus] of [[classements(chargerBase()), attendu.brut], [classements(contextualisee), attendu.contextuel]] as const) {
    assert.deepEqual(obtenus.map((c) => c.map(([id]) => id)), attendus.map((c) => c.map(([id]) => id)));
    obtenus.forEach((c, i) => c.forEach(([, s], j) => assert.ok(Math.abs(s - attendus[i]![j]![1]) <= 1e-12 * s, `${s} ≠ ${attendus[i]![j]![1]}`)));
  }
});

test("les mêmes scores cosinus et la même fusion que la version Python", sansPython, async () => {
  // Des vecteurs tirés d'une graine fixe, les mêmes des deux côtés.
  let graine = 7;
  const hasard = (): number => ((graine = (graine * 48271) % 2147483647) / 2147483647) * 2 - 1;
  const base = chargerBase();
  const vecteurs = base.map(() => Array.from({ length: 64 }, hasard));
  const question = Array.from({ length: 64 }, hasard);
  const plonger = (textes: string[], type: string): number[][] => (type === "query" ? [question] : vecteurs);
  const index = await IndexVecteurs.creer(base, plonger);
  const semantique = await index.chercher("?", 41);
  const lexical = new IndexBM25(base).chercher("Vous livrez le dimanche à Godomey ?", 20);
  const fusion = fusionner([lexical, semantique.slice(0, 20)], { garder: 8 });
  const attendu = python(
    `
import json, sys
from comptoir.connaissances import charger_base
from comptoir.recherche import IndexBM25, IndexVecteurs, fusionner
d = json.load(sys.stdin)
base = charger_base()
index = IndexVecteurs(base, lambda textes, t: [d["question"]] if t == "query" else d["vecteurs"])
semantique = index.chercher("?", 41)
lexical = IndexBM25(base).chercher("Vous livrez le dimanche à Godomey ?", 20)
fusion = fusionner(lexical, semantique[:20], garder=8)
print(json.dumps({"semantique": [[m.identifiant, s] for m, s in semantique], "fusion": [[m.identifiant, s] for m, s in fusion]}))`,
    { vecteurs, question },
  ) as { semantique: [string, number][]; fusion: [string, number][] };
  assert.deepEqual(semantique.map(([m, s]) => [m.identifiant, s]), attendu.semantique);
  assert.deepEqual(fusion.map(([m, s]) => [m.identifiant, s]), attendu.fusion);
});

test("les mêmes requêtes de reclassement et de contexte que la version Python", sansPython, () => {
  const base = chargerBase();
  const document = readFileSync(join(PYTHON, "comptoir", "connaissances", "faq.md"), "utf8").replace(/\r\n?/g, "\n");
  const attendu = python(`
import json
from pathlib import Path
from comptoir.connaissances import DOSSIER, charger_base
from comptoir.recherche import requete_contexte, requete_reclassement
base = charger_base()
print(json.dumps([requete_reclassement("Vous livrez à Godomey ?", base[:6], 3), requete_contexte((DOSSIER / "faq.md").read_text(encoding="utf-8"), base[2])]))`);
  assert.deepEqual([requeteReclassement("Vous livrez à Godomey ?", base.slice(0, 6), 3), requeteContexte(document, base[2]!)], attendu);
});
