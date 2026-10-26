// Les différences au format de difflib.unified_diff, et la même sortie que Python sur des cas variés.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decouperLignes, diffUnifie } from "../comptoir/difference.ts";
import { PYTHON } from "../comptoir/lancement.ts";

test("découper en lignes comme splitlines()", () => {
  assert.deepEqual(decouperLignes(""), []);
  assert.deepEqual(decouperLignes("a\nb"), ["a", "b"]);
  assert.deepEqual(decouperLignes("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(decouperLignes("a\r\nb\rc\n\n", true), ["a\r\n", "b\r", "c\n", "\n"]);
});

test("une différence unifiée", () => {
  const avant = ["Livraison gratuite dès 3 bouteilles.\n", "Paiement : Mobile Money.\n", "Fermé le dimanche.\n"];
  const apres = ["Livraison gratuite dès 5 bouteilles.\n", "Paiement : Mobile Money.\n", "Fermé le dimanche.\n"];
  assert.equal(
    diffUnifie(avant, apres, "faq.md (avant)", "faq.md (après)").join(""),
    "--- faq.md (avant)\n+++ faq.md (après)\n@@ -1,3 +1,3 @@\n" +
      "-Livraison gratuite dès 3 bouteilles.\n+Livraison gratuite dès 5 bouteilles.\n Paiement : Mobile Money.\n Fermé le dimanche.\n",
  );
  assert.deepEqual(diffUnifie(avant, avant), []); // rien de changé : aucune ligne
});

test("sans contexte ni fin de ligne, comme aux chapitres 17 et 18", () => {
  assert.deepEqual(diffUnifie(["a", "b", "c"], ["a", "B", "c", "d"], "", "", { n: 0, lineterm: "" }), [
    "--- ",
    "+++ ",
    "@@ -2 +2 @@",
    "-b",
    "+B",
    "@@ -3,0 +4 @@",
    "+d",
  ]);
});

// --- La même sortie que difflib ------------------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

/** Des textes tirés au hasard, mais toujours les mêmes : un générateur à graine fixe. */
function cas(): { a: string[]; b: string[]; n: number }[] {
  let graine = 20261023;
  const hasard = (max: number): number => {
    graine = (graine * 1103515245 + 12345) % 2 ** 31;
    return graine % max;
  };
  const mots = ["bissap", "gingembre", "baobab", "", "Livraison", "Paiement", "}", "  "];
  const liste: { a: string[]; b: string[]; n: number }[] = [];
  for (let k = 0; k < 60; k++) {
    // Quelques cas de plus de 200 lignes, où l'autojunk de difflib entre en jeu.
    const longueur = k % 10 === 9 ? 250 + hasard(50) : hasard(30);
    const a = Array.from({ length: longueur }, () => `${mots[hasard(mots.length)]}\n`);
    const b = [...a];
    for (let m = hasard(6); m > 0; m--) {
      const position = hasard(b.length + 1);
      const action = hasard(3);
      if (action === 0) b.splice(position, 1);
      else if (action === 1) b.splice(position, 0, `${mots[hasard(mots.length)]} ${k}\n`);
      else b[position] = `changé ${m}\n`;
    }
    liste.push({ a, b, n: [0, 1, 3, 5][hasard(4)]! });
  }
  return liste;
}

test("la même sortie que difflib.unified_diff, sur 60 cas", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const tous = cas();
  const script = `
import difflib, json, sys
print(json.dumps([list(difflib.unified_diff(c["a"], c["b"], "avant", "après", n=c["n"])) for c in json.load(sys.stdin)], ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], { input: JSON.stringify(tous), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  ) as string[][];
  tous.forEach((c, k) => assert.deepEqual(diffUnifie(c.a, c.b, "avant", "après", { n: c.n }), python[k], `cas ${k}`));
});
