// Les noms des feuilles d'un classeur Excel, lus dans son archive zip (ch10/rapport_excel.ts), et les
// mêmes que ceux que lit la version Python.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { feuilles, lireDansZip } from "../ch10/rapport_excel.ts";
import { PYTHON } from "../comptoir/lancement.ts";

const CLASSEUR = `<?xml version="1.0" encoding="UTF-8"?><workbook><sheets><sheet name="Ventes" sheetId="1"/><sheet name="Par produit" sheetId="2"/><sheet name="Par jour" sheetId="3"/></sheets></workbook>`;

/** Une archive zip minimale, écrite à la main : en-têtes locaux, répertoire central, fin de répertoire. */
function archive(fichiers: { nom: string; contenu: string; compresse: boolean }[]): Buffer {
  const locaux: Buffer[] = [];
  const central: Buffer[] = [];
  let position = 0;
  for (const { nom, contenu, compresse } of fichiers) {
    const brut = Buffer.from(contenu, "utf8");
    const donnees = compresse ? deflateRawSync(brut) : brut;
    const nomOctets = Buffer.from(nom, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(compresse ? 8 : 0, 8);
    local.writeUInt32LE(donnees.length, 18);
    local.writeUInt32LE(brut.length, 22);
    local.writeUInt16LE(nomOctets.length, 26);
    const entree = Buffer.alloc(46);
    entree.writeUInt32LE(0x02014b50, 0);
    entree.writeUInt16LE(compresse ? 8 : 0, 10);
    entree.writeUInt32LE(donnees.length, 20);
    entree.writeUInt32LE(brut.length, 24);
    entree.writeUInt16LE(nomOctets.length, 28);
    entree.writeUInt32LE(position, 42);
    locaux.push(local, nomOctets, donnees);
    central.push(entree, nomOctets);
    position += 30 + nomOctets.length + donnees.length;
  }
  const repertoire = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(fichiers.length, 8);
  fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(position, 16);
  return Buffer.concat([...locaux, repertoire, fin]);
}

test("lire un fichier stocké ou compressé dans une archive", () => {
  const zip = archive([
    { nom: "[Content_Types].xml", contenu: "<Types/>", compresse: false },
    { nom: "xl/workbook.xml", contenu: CLASSEUR, compresse: true },
  ]);
  assert.equal(lireDansZip(zip, "[Content_Types].xml").toString(), "<Types/>");
  assert.equal(lireDansZip(zip, "xl/workbook.xml").toString(), CLASSEUR);
  assert.throws(() => lireDansZip(zip, "xl/absent.xml"), /n'est pas dans l'archive/);
  assert.throws(() => lireDansZip(Buffer.from("pas un zip"), "xl/workbook.xml"), /pas une archive zip/);
});

test("les noms des feuilles d'un classeur", () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "classeur-")), "ventes.xlsx");
  writeFileSync(chemin, archive([{ nom: "xl/workbook.xml", contenu: CLASSEUR, compresse: true }]));
  assert.deepEqual(feuilles(chemin), ["Ventes", "Par produit", "Par jour"]);
});

// --- Les mêmes feuilles que la version Python ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
// Le classeur qu'a produit la Skill xlsx lors des mesures de la version Python, s'il est là (rapports/
// n'entre pas dans le dépôt).
const PRODUIT = join(PYTHON, "rapports", "semaine-2026-10-12", "ventes-semaine.xlsx");

test("les mêmes feuilles que la version Python, sur des archives de zipfile", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const dossier = mkdtempSync(join(tmpdir(), "classeurs-"));
  const script = `
import json, sys, zipfile
from pathlib import Path
from ch10.rapport_excel import feuilles
dossier = Path(sys.argv[1])
classeur = sys.argv[2]
chemins = []
for nom, methode in [("stocke", zipfile.ZIP_STORED), ("compresse", zipfile.ZIP_DEFLATED)]:
    chemin = dossier / f"{nom}.xlsx"
    with zipfile.ZipFile(chemin, "w", methode) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", classeur)
        archive.comment = b"fabrique pour le test"
    chemins.append(str(chemin))
if Path(sys.argv[3]).exists():
    chemins.append(sys.argv[3])
print(json.dumps({c: feuilles(Path(c)) for c in chemins}, ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, dossier, CLASSEUR.replace("Par jour", "Par jour & quartier".replace("&", "&amp;")), PRODUIT], {
      cwd: PYTHON,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  ) as Record<string, string[]>;
  assert.ok(Object.keys(python).length >= 2);
  for (const [chemin, noms] of Object.entries(python)) assert.deepEqual(feuilles(chemin), noms, chemin);
});
