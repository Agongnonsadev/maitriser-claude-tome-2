// L'outil éditeur de texte, exécuté par notre code : un dossier fermé, des remplacements sans ambiguïté
// (python/tests/test_editeur.py), et les mêmes réponses que la version Python.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { beforeEach, test } from "node:test";
import { Editeur, type Entree, OUTIL, RefusEditeur } from "../comptoir/editeur.ts";
import { PYTHON } from "../comptoir/lancement.ts";

let dossier: string;
let editeur: Editeur;
beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "editeur-"));
  writeFileSync(join(dossier, "faq.md"), "Livraison gratuite dès 3 bouteilles.\nPaiement : Mobile Money.\n", "utf8");
  editeur = new Editeur(dossier);
});

const lire = (nom: string): string => readFileSync(join(dossier, nom), "utf8");

test("l'outil d'Anthropic", () => {
  assert.ok(OUTIL.type === "text_editor_20250728" && OUTIL.name === "str_replace_based_edit_tool");
});

for (const chemin of ["../secret.txt", "/etc/passwd", "sous/../../evasion.md"]) {
  test(`on ne sort pas du dossier : ${chemin}`, () => {
    assert.throws(() => editeur.executer({ command: "view", path: chemin }), (e) => e instanceof RefusEditeur && /outside/.test(e.message));
  });
}

test("un lien vers un autre dossier ne fait pas sortir non plus", () => {
  const ailleurs = mkdtempSync(join(tmpdir(), "ailleurs-"));
  writeFileSync(join(ailleurs, "secret.txt"), "à ne pas lire", "utf8");
  symlinkSync(ailleurs, join(dossier, "lien"), "junction"); // une jonction : sans droits d'administrateur sous Windows
  assert.throws(() => editeur.executer({ command: "view", path: "lien/secret.txt" }), /outside/);
  assert.throws(() => editeur.executer({ command: "create", path: "lien/nouveau.md", file_text: "x" }), /outside/);
});

test("voir avec les numéros de ligne", () => {
  assert.equal(editeur.executer({ command: "view", path: "faq.md" }).split("\n")[1], "2: Paiement : Mobile Money.");
  assert.equal(editeur.executer({ command: "view", path: "faq.md", view_range: [2, -1] }), "2: Paiement : Mobile Money.");
  assert.equal(editeur.executer({ command: "view", path: "." }), "faq.md");
});

test("remplacer une seule occurrence et garder une sauvegarde", () => {
  editeur.executer({ command: "str_replace", path: "faq.md", old_str: "dès 3 bouteilles", new_str: "dès 5 bouteilles" });
  assert.ok(lire("faq.md").includes("dès 5 bouteilles"));
  assert.ok(lire("faq.md.backup").includes("dès 3 bouteilles"));
});

test("le texte de remplacement est pris tel quel, « $& » compris", () => {
  editeur.executer({ command: "str_replace", path: "faq.md", old_str: "Mobile Money", new_str: "Mobile Money ($& et $1)" });
  assert.ok(lire("faq.md").includes("Mobile Money ($& et $1)"));
});

test("un remplacement ambigu ou introuvable est refusé", () => {
  assert.throws(() => editeur.executer({ command: "str_replace", path: "faq.md", old_str: "Mo", new_str: "MO" }), /Found 2 matches/);
  assert.throws(() => editeur.executer({ command: "str_replace", path: "faq.md", old_str: "Porto-Novo", new_str: "x" }), /No match/);
  assert.ok(!existsSync(join(dossier, "faq.md.backup"))); // rien n'a été modifié
});

test("créer sans écraser et insérer", () => {
  assert.throws(() => editeur.executer({ command: "create", path: "faq.md", file_text: "x" }), /already exists/);
  editeur.executer({ command: "insert", path: "faq.md", insert_line: 0, insert_text: "# FAQ" });
  assert.ok(lire("faq.md").startsWith("# FAQ\nLivraison"));
  assert.throws(() => editeur.executer({ command: "insert", path: "faq.md", insert_line: 9, insert_text: "x" }), /between 0 and 3/);
  assert.equal(editeur.executer({ command: "create", path: "sous/nouveau.md", file_text: "Bonjour" }), "File created: sous/nouveau.md");
  assert.equal(lire("sous/nouveau.md"), "Bonjour");
});

test("un fichier aux fins de ligne Windows se lit et se modifie comme les autres", () => {
  writeFileSync(join(dossier, "windows.md"), "Ligne un\r\nLigne deux\r\n", "utf8");
  assert.equal(editeur.executer({ command: "view", path: "windows.md" }), "1: Ligne un\n2: Ligne deux");
  editeur.executer({ command: "str_replace", path: "windows.md", old_str: "un\nLigne", new_str: "1\nLigne" });
  assert.equal(lire("windows.md"), "Ligne 1\nLigne deux\n");
});

test("une erreur devient un résultat en erreur", () => {
  const resultat = editeur.resultat({ id: "t1", input: { command: "view", path: "absent.md" } });
  assert.ok(resultat.is_error && String(resultat.content).includes("File not found"));
  // Un champ manquant : le même message qu'un KeyError en Python.
  assert.deepEqual(editeur.resultat({ id: "t2", input: { command: "str_replace", path: "faq.md" } }), {
    type: "tool_result",
    tool_use_id: "t2",
    content: "'old_str'",
    is_error: true,
  });
});

// --- Les mêmes réponses que la version Python ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

const SEQUENCE: Entree[] = [
  { command: "view", path: "." },
  { command: "view", path: "faq.md", view_range: [1, 2] },
  { command: "view", path: "windows.md" },
  { command: "str_replace", path: "faq.md", old_str: "Mo", new_str: "MO" },
  { command: "str_replace", path: "faq.md", old_str: "", new_str: "x" },
  { command: "str_replace", path: "faq.md", old_str: "dès 3", new_str: "dès 5" },
  { command: "str_replace", path: "windows.md", old_str: "un\nLigne", new_str: "1\nLigne" },
  { command: "str_replace", path: "faq.md" },
  { command: "insert", path: "faq.md", insert_line: 1, insert_text: "Horaires : 8 h – 18 h." },
  { command: "insert", path: "faq.md", insert_line: 7, insert_text: "x" },
  { command: "create", path: "faq.md", file_text: "x" },
  { command: "create", path: "sous/nouveau.md", file_text: "Bonjour\n" },
  { command: "view", path: "sous" },
  { command: "view", path: "faq.md" },
  { command: "view", path: "absent.md" },
  { command: "view", path: "../faq.md" },
  { command: "delete", path: "faq.md" },
  { path: "faq.md" },
];

test("les mêmes réponses et les mêmes fichiers que la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  writeFileSync(join(dossier, "windows.md"), "Ligne un\r\nLigne deux\r\n", "utf8");
  const copie = mkdtempSync(join(tmpdir(), "editeur-python-"));
  cpSync(dossier, copie, { recursive: true });
  const ts = SEQUENCE.map((entree, n) => editeur.resultat({ id: `t${n}`, input: entree }));
  const script = `
import json, sys
from pathlib import Path
from types import SimpleNamespace
from comptoir.editeur import Editeur
editeur = Editeur(sys.argv[1])
sequence = json.load(sys.stdin)
resultats = [editeur.resultat(SimpleNamespace(id=f"t{n}", input=e)) for n, e in enumerate(sequence)]
fichiers = {p.relative_to(sys.argv[1]).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted(Path(sys.argv[1]).rglob("*")) if p.is_file()}
print(json.dumps({"resultats": resultats, "fichiers": fichiers}))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, copie], {
      cwd: PYTHON,
      input: JSON.stringify(SEQUENCE),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );
  assert.deepEqual(ts, python.resultats);
  // Python écrit les fins de ligne du système (\r\n sous Windows), TypeScript toujours \n : on compare
  // le texte, lu des deux côtés en ramenant les fins de ligne à \n.
  const fichiers = Object.fromEntries(
    (readdirSync(dossier, { recursive: true }) as string[])
      .filter((nom) => statSync(join(dossier, nom)).isFile())
      .map((nom) => [nom.split(sep).join("/"), readFileSync(join(dossier, nom), "utf8").replace(/\r\n/g, "\n")]),
  );
  assert.deepEqual(fichiers, python.fichiers);
});
