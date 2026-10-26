// La base d'Awa : découpage, identifiants stables, blocs search_result et point de cache
// (python/tests/test_connaissances.py), et la même base que la version Python.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ancre, avecContextes, blocResultat, blocsResultats, chargerBase, decouper, pourLaRecherche } from "../comptoir/connaissances.ts";
import { PYTHON } from "../comptoir/lancement.ts";

const DOCUMENT = `# Questions fréquentes

Document fictif.

## Êtes-vous ouverts le dimanche ?

Non. Le dimanche, l'atelier est fermé.

## Comment payer ?

Par Mobile Money.

En espèces aussi.
`;

test("l'ancre d'un titre", () => {
  assert.equal(ancre("Êtes-vous ouverts le dimanche ?"), "etes-vous-ouverts-le-dimanche");
  assert.equal(ancre("Quand parler d'événement ?"), "quand-parler-d-evenement");
});

test("une section par morceau", () => {
  const morceaux = decouper(DOCUMENT, "faq");
  assert.deepEqual(morceaux.map((m) => m.identifiant), ["kb://faq#etes-vous-ouverts-le-dimanche", "kb://faq#comment-payer"]);
  assert.equal(morceaux[0]!.titre, "Questions fréquentes — Êtes-vous ouverts le dimanche ?");
  assert.equal(morceaux[1]!.texte, "Par Mobile Money.\n\nEn espèces aussi.");
});

test("une section trop longue est coupée, avec recouvrement", () => {
  const paragraphes = Array.from({ length: 6 }, (_, i) => `Paragraphe ${i} ${"x".repeat(80)}`);
  const morceaux = decouper(`# Doc\n\n## Longue\n\n${paragraphes.join("\n\n")}`, "doc", 250);
  assert.ok(morceaux.length > 1);
  assert.equal(morceaux[0]!.identifiant, "kb://doc#longue-1");
  // Chaque partie reprend le dernier paragraphe de la précédente.
  for (let i = 1; i < morceaux.length; i++) assert.ok(morceaux[i]!.texte.startsWith(morceaux[i - 1]!.texte.split("\n\n").at(-1)!));
});

test("la base d'Awa", () => {
  const base = chargerBase();
  const identifiants = base.map((m) => m.identifiant);
  assert.equal(base.length, 41);
  assert.equal(new Set(identifiants).size, 41);
  assert.deepEqual(identifiants, chargerBase().map((m) => m.identifiant)); // ordre stable, condition du cache
  assert.ok(identifiants.includes("kb://zones-de-livraison#hors-de-cotonou"));
});

test("les sources attendues des questions existent", () => {
  const questions = JSON.parse(readFileSync(join(PYTHON, "ch11", "questions.json"), "utf8")) as { sources?: string[] }[];
  const identifiants = new Set(chargerBase().map((m) => m.identifiant));
  const manquantes = questions.flatMap((q) => q.sources ?? []).filter((s) => !identifiants.has(s));
  assert.deepEqual(manquantes, []);
});

test("un bloc search_result", () => {
  const bloc = blocResultat(decouper(DOCUMENT, "faq")[1]!);
  assert.equal(bloc.type, "search_result");
  assert.equal(bloc.source, "kb://faq#comment-payer");
  assert.deepEqual(bloc.citations, { enabled: true });
  assert.deepEqual(bloc.content, [{ type: "text", text: "Par Mobile Money." }, { type: "text", text: "En espèces aussi." }]);
  assert.ok(!("cache_control" in bloc));
});

test("le point de cache est sur le dernier bloc seulement", () => {
  assert.deepEqual(blocsResultats(decouper(DOCUMENT, "faq"), true).map((b) => "cache_control" in b), [false, true]);
  assert.ok(blocsResultats(decouper(DOCUMENT, "faq")).every((b) => !("cache_control" in b)));
});

test("les contextes s'ajoutent à la recherche", () => {
  const morceau = decouper(DOCUMENT, "faq")[0]!;
  const situe = avecContextes([morceau], { [morceau.identifiant]: "Horaires de la boutique." })[0]!;
  assert.ok(pourLaRecherche(situe).startsWith("Horaires de la boutique."));
  assert.deepEqual(blocResultat(situe).content, blocResultat(morceau).content); // Claude lit le texte, pas le contexte
});

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("la même base que la version Python, morceau par morceau", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const script = "import json\nfrom comptoir.connaissances import charger_base\nprint(json.dumps([[m.identifiant, m.titre, m.texte] for m in charger_base()], ensure_ascii=False))";
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  assert.deepEqual(chargerBase().map((m) => [m.identifiant, m.titre, m.texte]), python);
});
