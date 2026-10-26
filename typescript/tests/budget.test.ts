// Le budget : réserver le maximum, régler le réel, ne jamais dépasser un plafond
// (python/tests/test_budget.py, et le quota par adresse de python/tests/test_ch18.py).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { Budget } from "../comptoir/budget.ts";
import { coutMaximal } from "../comptoir/couts.ts";
import { presque, regler, remettreLesReglages } from "./faux_clients.ts";

beforeEach(() => {
  regler({ QUOTA_CLIENT_JOUR: 0.15, QUOTA_RESEAU_JOUR: 0.4, BUDGET_JOUR: 1.3, BUDGET_MOIS: 26.0, SEUIL_ALERTE: 0.8 });
});
afterEach(remettreLesReglages);

test("le coût maximal d'un appel", () => {
  // 3 000 tokens d'entrée et 2 000 de sortie au plus, au prix de Sonnet 5.5 (2 $ et 10 $ le million).
  presque(coutMaximal("claude-sonnet-5-5", 3000, 2000), 0.026);
});

test("réserver puis régler le coût réel", () => {
  const budget = new Budget();
  const decision = budget.reserver("c1", 0.026);
  assert.ok(decision.accepte);
  presque(budget.duJour(), 0.026);
  budget.regler(decision.reservation!, 0.004);
  presque(budget.duJour(), 0.004);
  presque(budget.duClient("c1"), 0.004);
});

test("le quota d'un client ne bloque pas les autres", () => {
  const budget = new Budget();
  for (let i = 0; i < 5; i++) budget.regler(budget.reserver("bavard", 0.026).reservation!, 0.026);
  const decision = budget.reserver("bavard", 0.026);
  assert.equal(decision.accepte, false);
  assert.equal(decision.motif, "quota_client");
  assert.ok(budget.reserver("autre", 0.026).accepte);
});

test("les appels en cours comptent", () => {
  // Dix appels lancés ensemble ne peuvent pas dépasser le plafond à eux dix.
  const budget = new Budget();
  const acceptes = Array.from({ length: 10 }, (_, i) => budget.reserver(`client-${i}`, 0.14).accepte);
  assert.equal(acceptes.filter(Boolean).length, 9); // 9 × 0,14 = 1,26 $ ; le dixième dépasserait 1,30 $
});

test("libérer une réservation", () => {
  const budget = new Budget();
  budget.liberer(budget.reserver("c1", 0.1).reservation!);
  assert.equal(budget.duJour(), 0);
});

test("l'alerte avant le plafond", () => {
  const budget = new Budget();
  assert.equal(budget.reserver("c1", 0.1).alerte, false);
  for (let i = 0; i < 8; i++) budget.reserver(`c${i + 2}`, 0.13);
  assert.ok(budget.enAlerte()); // 1,14 $ engagés sur 1,30 $ : plus de 80 %
});

test("un nouveau jour repart de zéro, mais pas le mois", () => {
  regler({ BUDGET_MOIS: 1.5, QUOTA_CLIENT_JOUR: 2.0 });
  let instant = new Date("2026-10-20T23:00:00Z");
  const budget = new Budget(":memory:", () => instant);
  budget.reserver("c1", 0.1);
  budget.regler(budget.reserver("c2", 1.1).reservation!, 1.1);
  instant = new Date("2026-10-21T00:30:00Z");
  assert.equal(budget.duJour(), 0);
  presque(budget.duMois(), 1.2);
  const decision = budget.reserver("c3", 0.4);
  assert.equal(decision.accepte, false);
  assert.equal(decision.motif, "budget_mois");
});

// Chapitre 18 : le quota par adresse.

test("le quota par adresse ne repart pas à zéro avec une conversation neuve", () => {
  regler({ QUOTA_RESEAU_JOUR: 0.1 });
  const budget = new Budget();
  const acceptees = Array.from({ length: 5 }, () => budget.reserver(crypto.randomUUID(), 0.03, "adresse:196.168.10.20").accepte);
  assert.deepEqual(acceptees, [true, true, true, false, false]);
  assert.equal(budget.reserver(crypto.randomUUID(), 0.03, "adresse:196.168.10.20").motif, "quota_reseau");
  assert.ok(budget.reserver(crypto.randomUUID(), 0.03, "adresse:196.168.77.5").accepte); // une autre adresse
});

test("une ancienne base du budget reçoit la colonne", () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "budget.sqlite3");
  const ancienne = new DatabaseSync(chemin); // la table telle que le chapitre 8 l'a créée
  ancienne.exec(
    "CREATE TABLE depenses (id TEXT PRIMARY KEY, jour TEXT NOT NULL, mois TEXT NOT NULL, client TEXT NOT NULL, dollars REAL NOT NULL, reglee INTEGER NOT NULL)",
  );
  ancienne.close();
  assert.ok(new Budget(chemin).reserver("c1", 0.01, "adresse:1.2.3.4").accepte);
});
