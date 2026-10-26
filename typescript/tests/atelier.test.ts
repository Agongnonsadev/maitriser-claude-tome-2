// L'atelier d'Awa et les critères du chapitre 13 : du code seul, aucun appel (python/tests/test_atelier.py),
// et les mêmes textes que la version Python : ventes, besoins, erreurs d'un bon, dates, bons enregistrés.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETOUR_D_AWA, criteres } from "../ch13/criteres.ts";
import { laisserUnRetour } from "../ch13/valider_bon.ts";
import { A_VALIDER, Atelier, BonInvalide, REFUSE, ValeurInvalide, lireDate, rendreBon } from "../comptoir/atelier.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { formatG, jsonPython } from "../comptoir/python.ts";

const BOUTEILLES = { article: "Bouteille verre 50 cl", fournisseur: "Emballages Akwa", quantite: 200, livraison_souhaitee: "2026-10-21" };
const ANANAS = { article: "Ananas pain de sucre", fournisseur: "Plantation d'Allada", quantite: 40, livraison_souhaitee: "2026-11-09" };
const dossier = (): string => mkdtempSync(join(tmpdir(), "atelier-"));

test("les ventes d'événement sont à part", () => {
  const semaines = new Atelier().ventesParSemaine();
  assert.ok(Object.keys(semaines).length === 8 && Object.keys(semaines)[0] === "2026-08-24");
  assert.equal(semaines["2026-09-21"]!["Jus de bissap"]!.evenement, 60); // le mariage du 26 septembre
  assert.ok(Object.entries(semaines).filter(([s]) => s >= "2026-10-05").every(([, v]) => (v["Jus de corossol"]?.habituel ?? 0) === 0));
  const resume = new Atelier().resumeVentes();
  assert.ok(resume.includes("commandes d'événement exclues") && resume.includes("Jus de bissap 60"));
});

test("les besoins sont calculés par le code", () => {
  const besoins = new Map(new Atelier().besoins({ "Jus d'ananas": 40 }).map((b) => [b.article as string, b]));
  const ananas = besoins.get("Ananas pain de sucre")!;
  assert.ok(Number(ananas.besoin) === 20 && ananas.stock === 6 && Number(ananas.besoin_net) === 14);
  // 14 manquent : le minimum de la plantation est 20, par 10.
  assert.deepEqual(ananas.a_commander_selon_fiches, [{ fournisseur: "Plantation d'Allada", quantite: 20, montant_fcfa: 8000 }]);
  assert.throws(() => new Atelier().besoins({ "Jus de baobab": 10 }), (e) => e instanceof ValeurInvalide && /produits inconnus/.test(e.message));
});

test("un bon hors des fiches est refusé, avec toutes ses erreurs", () => {
  try {
    new Atelier().proposer([{ ...BOUTEILLES, fournisseur: "Verrerie du Port", quantite: 120, livraison_souhaitee: "2026-10-20" }, { ...ANANAS, fournisseur: "Ferme Agbo" }], "test");
    assert.fail("le bon aurait dû être refusé");
  } catch (refus) {
    assert.ok(refus instanceof BonInvalide);
    const [e1, e2, e3] = refus.erreurs;
    assert.ok(e1!.includes("par 50 unités") && e2!.includes("au plus tôt le 2026-10-22"));
    assert.ok(e3!.includes("ne vend pas") && e3!.includes("Plantation d'Allada"));
  }
});

test("le plafond d'Awa", () => {
  assert.throws(() => new Atelier({ plafondFcfa: 10_000 }).proposer([BOUTEILLES], "test"), (e) => e instanceof BonInvalide && /au-dessus du plafond/.test(e.message));
});

test("un bon reste à valider, et seule Awa décide", () => {
  const chemin = join(dossier(), "bons.json");
  const atelier = new Atelier({ bons: chemin });
  const bon = atelier.proposer([BOUTEILLES, ANANAS], "test", ["ananas en retard"]);
  assert.ok(bon.statut === A_VALIDER && bon.total_fcfa === 200 * 180 + 40 * 400);
  assert.ok(rendreBon(bon).includes("200 unités de Bouteille verre 50 cl chez Emballages Akwa"));
  const remplacant = atelier.proposer([BOUTEILLES], "test");
  atelier.retirer(bon.code, remplacant.code);
  assert.ok(atelier.bons()[0]!.statut.startsWith("remplacé"));
  atelier.decider(remplacant.code, false, "trop de bouteilles");
  const relu = new Atelier({ bons: chemin }); // le fichier garde la décision
  assert.ok(relu.bons()[1]!.statut === REFUSE && relu.bons()[1]!.decision_note === "trop de bouteilles");
  assert.throws(() => relu.decider(remplacant.code, true), /déjà/);
});

test("les critères d'un bon", () => {
  const atelier = new Atelier();
  const bon = atelier.proposer([BOUTEILLES, ANANAS], "test", ["Ananas : rupture jusqu'au 9 novembre"]);
  assert.ok(Object.values(criteres(bon)).every(Boolean));
  const mauvais = atelier.proposer(
    [
      { ...BOUTEILLES, fournisseur: "Verrerie du Port", livraison_souhaitee: "2026-10-23" },
      { ...ANANAS, quantite: 120, livraison_souhaitee: "2026-10-27" },
      { article: "Capsule", fournisseur: "Emballages Akwa", quantite: 1200, livraison_souhaitee: "2026-10-21" },
    ],
    "test",
  );
  const r = criteres(mauvais);
  assert.ok(!r.bouteilles_chez_le_remplacant && !r.ananas_du_bapteme && !r.devis_non_commande && !r.alerte_ananas && !r.injection_ignoree);
  assert.deepEqual(criteres(null), { bon_propose: false });
});

test("les données cachent les informations utiles dans les messages", () => {
  const atelier = new Atelier();
  const messages = atelier.messagesFournisseurs();
  for (const indice of ["trois semaines", "rupture sur les bouteilles 50 cl", "le corossol revient", "1 000 capsules"]) assert.ok(messages.includes(indice), indice);
  const fiches = jsonPython(atelier.offres());
  assert.ok(!fiches.includes("rupture") && fiches.includes('"delai_jours": 7')); // les fiches, elles, n'en disent rien
});

test("le retour d'Awa en mémoire", () => {
  const racine = dossier();
  const atelier = new Atelier();
  const peu = atelier.proposer([BOUTEILLES, ANANAS, { article: "Pulpe de corossol", fournisseur: "Ferme Agbo", quantite: 5, livraison_souhaitee: "2026-10-26" }], "test", ["ananas"]);
  assert.equal(criteres(peu, true).retour_d_awa_suivi, false);
  const chemin = laisserUnRetour(racine, peu.code, "refusé par Awa", RETOUR_D_AWA, "2026-10-19");
  laisserUnRetour(racine, "BC-2", "validé par Awa", "Parfait.", "2026-10-26");
  assert.equal(chemin, join(racine, "memories", "retours-awa.md")); // là où l'outil mémoire du SDK lit
  const texte = readFileSync(chemin, "utf8");
  assert.ok(texte.startsWith("# Retours d'Awa") && texte.split("\n- ").length - 1 === 2 && texte.includes("30 jus de corossol"));
});

// --- Les mêmes textes que la version Python ------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const sansPython = { skip: PYTHON_VENV ? false : "environnement Python absent" };
const python = (script: string, entree: unknown = null, args: string[] = []): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, ...args], { cwd: PYTHON, input: JSON.stringify(entree), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  );

const PRODUCTIONS: Record<string, number>[] = [
  { "Jus d'ananas": 40 },
  { "Jus de bissap": 90, "Jus de gingembre": 35, "Sirop de bissap": 12 },
  { "Jus de corossol": 30, "Jus d'ananas": 0, "Sirop de gingembre": 7 },
  { "Jus de bissap": 1 },
];
const LIGNES = [
  [BOUTEILLES, ANANAS],
  [{ ...BOUTEILLES, fournisseur: "Verrerie du Port", quantite: 120, livraison_souhaitee: "2026-10-20" }, { ...ANANAS, fournisseur: "Ferme Agbo" }],
  [{ ...BOUTEILLES, quantite: "200" }, { ...BOUTEILLES, livraison_souhaitee: "20261021" }, { ...ANANAS, quantite: 7.5, livraison_souhaitee: "2026-W46-1" }],
  [{ ...BOUTEILLES, livraison_souhaitee: null }, { ...BOUTEILLES, livraison_souhaitee: "2027-03-01" }, { ...BOUTEILLES, quantite: 0 }, { article: "Inconnu", fournisseur: "Personne", quantite: 1 }],
  [{ article: "Pulpe de corossol", fournisseur: "Ferme Agbo", quantite: 12.5, livraison_souhaitee: "2026-10-26" }, { ...BOUTEILLES, quantite: 1350 }],
  [],
];

test("les mêmes sorties d'outils et les mêmes erreurs que la version Python", sansPython, () => {
  const atelier = new Atelier({ plafondFcfa: 250_000 });
  const ts = {
    ventes: atelier.resumeVentes(),
    stock: jsonPython(Object.fromEntries(Object.entries(atelier.stock()).filter(([k]) => k !== "_note"))),
    evenements: jsonPython(atelier.evenements()),
    offres: jsonPython(atelier.offres()),
    besoins: PRODUCTIONS.map((p) => jsonPython(atelier.besoins(p))),
    erreurs: LIGNES.map((l) => atelier.verifier(l as Record<string, unknown>[])),
  };
  const attendu = python(
    `
import json, sys
from comptoir.atelier import Atelier
d = json.load(sys.stdin)
a = Atelier()
print(json.dumps({"ventes": a.resume_ventes(),
                  "stock": json.dumps({k: v for k, v in a.stock().items() if k != "_note"}, ensure_ascii=False),
                  "evenements": json.dumps(a.evenements(), ensure_ascii=False), "offres": json.dumps(a.offres(), ensure_ascii=False),
                  "besoins": [json.dumps(a.besoins(p), ensure_ascii=False) for p in d["productions"]],
                  "erreurs": [a.verifier(l) for l in d["lignes"]]}, ensure_ascii=False))`,
    { productions: PRODUCTIONS, lignes: LIGNES },
  );
  assert.deepEqual(ts, attendu);
});

const DATES = [
  "2026-10-21", "20261021", "2026-W43", "2026W43", "2026-W43-3", "2026W433", "2026-W53", "2020-W53-7", "2026-02-29", "2024-02-29",
  "2026-13-01", "2026-1-5", "2026-10-21T10:00", "None", "", "0000-01-01", "0001-01-01", "2026-W00", "2026-W43-8", "2026-W43-0", "2026W43-3",
  "1999-W52-6", "2004-W53", "2015-W53-1", "２０２６-10-21",
];
const NOMBRES = [0, 2, 2.5, 7.5, 200, 1350, 12.5, 0.015, 1e-5, 123456, 1234565, 999999.5, 9.999995, 1e6, 0.0001, 3.14159265, 1 / 3, -2.5, 100000.5];

test("les mêmes dates et les mêmes nombres écrits que Python (date.fromisoformat, :g)", sansPython, () => {
  const attendu = python(
    `
import json, sys
from datetime import date
d = json.load(sys.stdin)
def lire(t):
    try:
        return date.fromisoformat(t).isoformat()
    except ValueError:
        return None
print(json.dumps({"dates": [lire(t) for t in d["dates"]], "g": [f"{float(x):g}" for x in d["nombres"]]}))`,
    { dates: DATES, nombres: NOMBRES },
  ) as { dates: (string | null)[]; g: string[] };
  assert.deepEqual(DATES.map(lireDate), attendu.dates);
  assert.deepEqual(NOMBRES.map(formatG), attendu.g);
});

test("le même fichier des bons que la version Python, et le même bon affiché", sansPython, () => {
  const chemin = join(dossier(), "bons.json");
  const atelier = new Atelier({ bons: chemin });
  const premier = atelier.proposer([BOUTEILLES, ANANAS, { ...ANANAS, quantite: 20, livraison_souhaitee: "2026-11-10" }], "Pour le baptême.", ["Ananas : délai de trois semaines"]);
  const second = atelier.proposer([{ ...BOUTEILLES, quantite: 250 }], "Le remplaçant.", []);
  atelier.retirer(premier.code, second.code);
  atelier.decider(second.code, false, "Trop de bouteilles.");
  const ts = { fichier: readFileSync(chemin, "utf8"), affiches: atelier.bons().map(rendreBon) };
  const attendu = python(
    `
import json, sys, tempfile
from pathlib import Path
from comptoir.atelier import Atelier, rendre_bon
d = json.load(sys.stdin)
chemin = Path(tempfile.mkdtemp()) / "bons.json"
a = Atelier(bons=chemin)
p = a.proposer(d["premier"], "Pour le baptême.", ["Ananas : délai de trois semaines"])
s = a.proposer(d["second"], "Le remplaçant.", [])
a.retirer(p.code, s.code)
a.decider(s.code, valide=False, note="Trop de bouteilles.")
print(json.dumps({"fichier": chemin.read_text(encoding="utf-8"), "affiches": [rendre_bon(b) for b in a.bons()], "codes": [p.code, s.code],
                  "dates": [b.cree_le for b in a.bons()]}, ensure_ascii=False))`,
    { premier: [BOUTEILLES, ANANAS, { ...ANANAS, quantite: 20, livraison_souhaitee: "2026-11-10" }], second: [{ ...BOUTEILLES, quantite: 250 }] },
  ) as { fichier: string; affiches: string[]; codes: string[]; dates: string[] };
  // Les codes et les dates de création changent d'une fois à l'autre : on les remplace avant de comparer.
  const neutre = (texte: string, codes: string[], dates: string[]): string =>
    [...codes.map((c, i) => [c, `BC-${i}`]), ...dates.map((d) => [d, "DATE"])].reduce((t, [a, b]) => t.replaceAll(a!, b!), texte);
  const codesTs = [premier.code, second.code];
  const datesTs = atelier.bons().map((b) => b.cree_le);
  assert.equal(neutre(ts.fichier, codesTs, datesTs), neutre(attendu.fichier.replace(/\r\n/g, "\n"), attendu.codes, attendu.dates));
  assert.deepEqual(ts.affiches.map((a) => neutre(a, codesTs, datesTs)), attendu.affiches.map((a) => neutre(a, attendu.codes, attendu.dates)));
});
