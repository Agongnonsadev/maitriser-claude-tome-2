// Préparer images et PDF, et prévoir leur coût en tokens, sans appel à l'API
// (python/tests/test_documents.py).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { HAUTE_RESOLUTION, STANDARD, blocDocument, blocFichier, blocImage, blocPdf, jetonsImage, jetonsPrevus, tailleVue } from "../comptoir/documents.ts";

// Le tableau de la page Vision d'Anthropic (20 octobre 2026) : taille vue et tokens.
const EXEMPLES_STANDARD: [[number, number], [number, number], number][] = [
  [[200, 200], [200, 200], 64],
  [[1000, 1000], [1000, 1000], 1296],
  [[1092, 1092], [1092, 1092], 1521],
  [[1920, 1080], [1456, 819], 1560],
  // Le tableau de la page indique 1269 × 952 ; l'implémentation de référence de la même documentation
  // donne 1270 × 952. Même coût : 1564 tokens.
  [[2000, 1500], [1270, 952], 1564],
  [[3840, 2160], [1456, 819], 1560],
];
const EXEMPLES_HAUTE_RESOLUTION: [[number, number], [number, number], number][] = [
  [[1920, 1080], [1920, 1080], 2691],
  [[2000, 1500], [2000, 1500], 3888],
  [[3840, 2160], [2576, 1449], 4784],
];

for (const [taille, vue, jetons] of EXEMPLES_STANDARD) {
  test(`le niveau standard suit le tableau d'Anthropic : ${taille.join(" × ")}`, () => {
    assert.deepEqual(tailleVue(...taille, ...STANDARD), vue);
    assert.equal(jetonsImage(...vue), jetons);
  });
}

for (const [taille, vue, jetons] of EXEMPLES_HAUTE_RESOLUTION) {
  test(`la haute résolution suit le tableau d'Anthropic : ${taille.join(" × ")}`, () => {
    assert.deepEqual(tailleVue(...taille, ...HAUTE_RESOLUTION), vue);
    assert.equal(jetonsImage(...vue), jetons);
  });
}

test("l'exemple de la page A4", () => {
  // Une page A4 scannée à 130 points par pouce : réduite en standard, pas en haute résolution.
  assert.deepEqual(tailleVue(1075, 1520, ...STANDARD), [924, 1307]);
  assert.deepEqual(tailleVue(1075, 1520, ...HAUTE_RESOLUTION), [1075, 1520]);
});

test("une photo de téléphone coûte au plus 4784 tokens avec Sonnet 5.5", () => {
  assert.ok(jetonsPrevus(3000, 4000, "claude-sonnet-5-5") <= 4784);
});

async function photo(largeur = 3000, hauteur = 4000, nom = "photo.jpg"): Promise<string> {
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), nom);
  await sharp({ create: { width: largeur, height: hauteur, channels: 3, background: { r: 200, g: 180, b: 160 } } }).jpeg({ quality: 80 }).toFile(chemin);
  return chemin;
}

test("un bloc image en base64", async () => {
  const bloc = await blocImage(await photo());
  assert.equal(bloc.type, "image");
  assert.ok(bloc.source.type === "base64");
  assert.equal(bloc.source.media_type, "image/jpeg");
  assert.deepEqual([...Buffer.from(bloc.source.data, "base64").subarray(0, 2)], [0xff, 0xd8]); // début d'un JPEG
});

test("réduire avant d'envoyer", async () => {
  const bloc = await blocImage(await photo(), 1000);
  assert.ok(bloc.source.type === "base64");
  const { width, height } = await sharp(Buffer.from(bloc.source.data, "base64")).metadata();
  assert.deepEqual([width, height], [750, 1000]);
});

test("une petite image n'est jamais agrandie", async () => {
  const bloc = await blocImage(await photo(400, 300), 1000);
  assert.ok(bloc.source.type === "base64");
  const { width, height } = await sharp(Buffer.from(bloc.source.data, "base64")).metadata();
  assert.deepEqual([width, height], [400, 300]);
});

test("un format refusé", async () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "scan.tiff");
  writeFileSync(chemin, Buffer.from("II*\x00", "latin1"));
  await assert.rejects(blocImage(chemin), /format non accepté/);
});

test("un bloc PDF avec titre et citations", async () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "f.pdf");
  writeFileSync(chemin, "%PDF-1.4\n");
  const bloc = blocPdf(chemin, "Facture", true);
  assert.ok(bloc.source.type === "base64");
  assert.equal(bloc.source.media_type, "application/pdf");
  assert.equal(bloc.title, "Facture");
  assert.deepEqual(bloc.citations, { enabled: true });
  assert.equal((await blocDocument(chemin)).type, "document");
});

test("un fichier de la Files API", () => {
  assert.deepEqual(blocFichier("file_abc", "document", true), {
    type: "document",
    source: { type: "file", file_id: "file_abc" },
    citations: { enabled: true },
  });
});
