// Ce qui imite Python pour que les deux versions donnent les mêmes fichiers : round(x, n), repr(float)
// dans les CSV, et les options à plusieurs valeurs d'argparse (nargs="+").

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { arrondir } from "../comptoir/arrondi.ts";
import { ecrireCsv, flottant } from "../comptoir/csv.ts";
import { PYTHON, plusieursValeurs } from "../comptoir/lancement.ts";

test("arrondir comme round : la moitié vers le pair, sur la valeur exacte", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -2.5].map((x) => arrondir(x)), [0, 2, 2, -2]);
  assert.equal(arrondir(2.675, 2), 2.67); //  2,67499999… en binaire
  assert.equal(arrondir(0.125, 2), 0.12); //  exact en binaire : la moitié va au pair
  assert.equal(arrondir(0.375, 2), 0.38);
  assert.equal(arrondir(5.72, 2), 5.72);
  assert.ok(Object.is(arrondir(-0.4), 0)); // round(x) rend un entier : pas de « -0 »
  // Des décimales négatives arrondissent aux dizaines, aux centaines…, comme round(1250, -2) en Python.
  assert.deepEqual([arrondir(1234, -2), arrondir(1250, -2), arrondir(1350, -2)], [1200, 1200, 1400]);
  assert.throws(() => arrondir(1, 0.5), RangeError);
});

test("un nombre à virgule écrit comme en Python", () => {
  assert.deepEqual([0, 5, 5.72, 0.0001, 0.00001, 2.5e-5, 1e16, 1234567890123456, -0].map(flottant), [
    "0.0", "5.0", "5.72", "0.0001", "1e-05", "2.5e-05", "1e+16", "1234567890123456.0", "-0.0",
  ]);
});

test("les colonnes à virgule d'un fichier de résultats", () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "csv-")), "essais.csv");
  ecrireCsv([{ cas: "a", tokens: 12, cout: 0, latence: 3 }], ["cas", "tokens", "cout", "latence"], chemin, ["cout", "latence"]);
  assert.equal(readFileSync(chemin, "utf8"), "cas,tokens,cout,latence\r\na,12,0.0,3.0\r\n");
});

test("une option à plusieurs valeurs, comme nargs=\"+\"", () => {
  assert.deepEqual(plusieursValeurs(["modes"], ["--modes", "contexte", "rag", "--budget-max", "0.3"]), [
    "--modes", "contexte", "--modes", "rag", "--budget-max", "0.3",
  ]);
  assert.deepEqual(plusieursValeurs(["modes"], ["--modes", "rag", "--sortie", "x.csv"]), ["--modes", "rag", "--sortie", "x.csv"]);
  // Sans valeur (nargs="*") : une valeur vide, au milieu ou à la fin.
  assert.deepEqual(plusieursValeurs(["traces"], ["--traces", "--budget-max", "1"]), ["--traces=", "--budget-max", "1"]);
  assert.deepEqual(plusieursValeurs(["traces"], ["--budget-max", "1", "--traces"]), ["--budget-max", "1", "--traces="]);
});

// --- Comparés à Python ---------------------------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("les mêmes arrondis et les mêmes écritures que Python, sur 3 000 nombres", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const script = `
import json, random
random.seed(11)
xs = [2.5, 0.125, 0.375, 2.675, 1.25e-05, 1e-07, 123.456, 1e16, 1e22, 0.1 + 0.2]
xs += [random.uniform(-100, 100) for _ in range(300)] + [random.randint(0, 10**6) / 10**random.randint(1, 7) for _ in range(300)]
print(json.dumps({"arrondis": [[x, n, round(x, n) if n else round(x)] for x in xs for n in (0, 1, 2, 4, 6)],
                  "reprs": [[x, repr(x)] for x in xs]}))`;
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { encoding: "utf8" })) as {
    arrondis: [number, number, number][];
    reprs: [number, string][];
  };
  assert.ok(python.arrondis.length >= 3000);
  for (const [x, n, attendu] of python.arrondis) assert.equal(arrondir(x, n), attendu, `round(${x}, ${n})`);
  for (const [x, attendu] of python.reprs) assert.equal(flottant(x), attendu, `repr(${x})`);
});
