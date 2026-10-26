// Les ventes de la semaine : un export fixe, et notre calcul de référence pour vérifier le rapport
// (python/tests/test_ventes.py), et le même calcul que la version Python.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PYTHON } from "../comptoir/lancement.ts";
import { type Totaux, comparer, lire, totaux } from "../comptoir/ventes.ts";

const VENTES = join(PYTHON, "ch10", "donnees", "ventes-2026-10-12.csv");

test("l'export est dans le dépôt", () => {
  const lignes = lire(VENTES);
  assert.equal(lignes.length, 77);
  assert.ok(lignes.every((l) => Number.isInteger(l.quantite) && Number.isInteger(l.prix_unitaire_fcfa)));
});

test("les totaux de référence", () => {
  const t = totaux(lire(VENTES));
  assert.ok(t.chiffre_affaires_fcfa === 394_000 && t.commandes === 37);
  assert.equal(t.panier_moyen_fcfa, 10_649);
  const somme = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0);
  assert.equal(somme(Object.values(t.par_jour)), t.chiffre_affaires_fcfa);
  assert.equal(somme(Object.values(t.par_quartier)), t.chiffre_affaires_fcfa);
  assert.equal(somme(Object.values(t.par_produit).map((p) => p.montant_fcfa)), t.chiffre_affaires_fcfa);
});

test("la comparaison trouve un écart et tolère un arrondi", () => {
  const t = totaux(lire(VENTES));
  assert.deepEqual(comparer(t, t), []);
  assert.deepEqual(comparer({ ...t, panier_moyen_fcfa: t.panier_moyen_fcfa + 1 }, t), []); // arrondi différent
  const faux = { ...t, par_jour: { ...t.par_jour, "2026-10-12": 1 } };
  assert.deepEqual(comparer(faux, t), [`par_jour[2026-10-12] : 1 au lieu de ${t.par_jour["2026-10-12"]}`]);
});

test("une clé en trop dans un produit est un écart, comme en Python", () => {
  const t = totaux(lire(VENTES));
  const [produit, valeurs] = Object.entries(t.par_produit)[0]!;
  const faux = { ...t, par_produit: { ...t.par_produit, [produit]: { ...valeurs, remise: 0 } } };
  assert.deepEqual(comparer(faux, t), [
    `par_produit[${produit}] : {'quantite': ${valeurs.quantite}, 'montant_fcfa': ${valeurs.montant_fcfa}, 'remise': 0} au lieu de {'quantite': ${valeurs.quantite}, 'montant_fcfa': ${valeurs.montant_fcfa}}`,
  ]);
});

test("le calcul sur un petit export", () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "ventes-")), "petit.csv");
  writeFileSync(
    chemin,
    "date,commande,produit,quantite,prix_unitaire_fcfa,quartier,canal\n" +
      "2026-10-12,C-1,Jus de bissap,2,1000,Zogbo,whatsapp\n2026-10-12,C-1,Sirop de bissap,1,2500,Zogbo,whatsapp\n",
    "utf8",
  );
  const t = totaux(lire(chemin));
  assert.ok(t.chiffre_affaires_fcfa === 4500 && t.commandes === 1);
});

// --- Le même calcul que la version Python --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("les mêmes totaux et les mêmes écarts que la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const t = totaux(lire(VENTES));
  const jours = Object.keys(t.par_jour);
  const produits = Object.keys(t.par_produit);
  // Un résumé faux de bien des façons : un texte à la place d'un nombre, un jour et un produit absents,
  // un quartier inventé, une quantité fausse, un panier hors tolérance.
  const faux: Record<string, unknown> = {
    chiffre_affaires_fcfa: String(t.chiffre_affaires_fcfa),
    commandes: t.commandes - 1,
    panier_moyen_fcfa: t.panier_moyen_fcfa + 2,
    par_jour: Object.fromEntries(jours.slice(1).map((j) => [j, t.par_jour[j]])),
    par_quartier: { ...t.par_quartier, "Quartier d'essai": 5 },
    par_produit: {
      ...Object.fromEntries(produits.slice(1).map((p) => [p, t.par_produit[p]])),
      [produits[1]!]: { quantite: 0, montant_fcfa: t.par_produit[produits[1]!]!.montant_fcfa },
    },
  };
  const script = `
import json, sys
from comptoir.ventes import comparer, lire, totaux
t = totaux(lire(sys.argv[1]))
print(json.dumps({"totaux": t, "ecarts": comparer(json.load(sys.stdin), t)}, ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, VENTES], { cwd: PYTHON, input: JSON.stringify(faux), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  ) as { totaux: Totaux; ecarts: string[] };
  assert.equal(JSON.stringify(t), JSON.stringify(python.totaux)); // les mêmes clés, dans le même ordre
  const ecarts = comparer(faux as Partial<Totaux>, t);
  assert.ok(ecarts.length >= 5);
  assert.deepEqual(ecarts, python.ecarts);
});
