// Le tableau de bord lit le journal : coûts par jour, modes d'échec, latences, conversations à reprendre
// (python/tests/test_tableau.py) ; coût par conversation, alertes et récidivistes (les tests du tableau
// dans python/tests/test_ch19.py) ; et les mêmes résultats que la version Python, sur un même journal.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { noterEvenement } from "../comptoir/journal.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import {
  type Ligne, aReprendre, alertes, centile, charger, coutParConversation, enHtml, evenements, latences,
  latencesMessages, modesDEchec, parConversation, parJour, tauxDErreur,
} from "../comptoir/tableau.ts";
import { journalTemporaire, presque, regler, remettreLesReglages } from "./faux_clients.ts";

const JOURNAL: Ligne[] = [
  { date: "2026-10-20T08:00:00+00:00", requete: "r1", cout_dollars: 0.004, tokens_entree: 1000, tokens_sortie: 100, stop_reason: "end_turn", duree_ms: 900, client: "c1" },
  { date: "2026-10-20T08:05:00+00:00", requete: "r2", cout_dollars: 0.006, tokens_entree: 1500, tokens_sortie: 150, stop_reason: "end_turn", duree_ms: 1500, client: "c1" },
  { date: "2026-10-20T09:00:00+00:00", requete: null, cout_dollars: null, interrompu: true, erreur: "surcharge", origine: "service", duree_ms: 30000, client: "c2" },
  { date: "2026-10-20T10:00:00+00:00", requete: "r4", cout_dollars: 0.001, stop_reason: "refusal", erreur: "refus", origine: "modele", client: "c3" },
  { date: "2026-10-21T07:00:00+00:00", evenement: "hors_budget", motif: "quota_client", client: "c4" },
];

let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
});
afterEach(remettreLesReglages);

test("les coûts par jour", () => {
  const jours = parJour(JOURNAL);
  assert.equal(jours.get("2026-10-20")!.appels, 4);
  presque(jours.get("2026-10-20")!.dollars, 0.011);
  assert.equal(jours.get("2026-10-20")!.echecs, 2);
  assert.equal(jours.get("2026-10-21")!.echecs, 1);
});

test("les modes d'échec, par origine", () => {
  assert.deepEqual(new Set(modesDEchec(JOURNAL).map((m) => `${m.origine}/${m.code}/${m.nombre}`)), new Set(["service/surcharge/1", "modele/refus/1", "compte/hors_budget/1"]));
});

test("les latences ignorent les échecs", () => {
  assert.deepEqual(latences(JOURNAL), [900, 1500]); // l'appel en surcharge (30 s) n'est pas compté
  assert.equal(centile([], 50), null);
});

test("les conversations à reprendre", () => {
  // Une surcharge se réessaie ; un refus ou un budget épuisé laissent le client sans réponse.
  assert.deepEqual(aReprendre(JOURNAL).map((r) => r.conversation), ["c3", "c4"]);
});

test("la page HTML échappe le contenu du journal", () => {
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "appels.jsonl");
  const piege = { date: "2026-10-20T11:00:00+00:00", evenement: "hors_budget", client: "<script>x</script>" };
  writeFileSync(chemin, [...JOURNAL, piege].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  const page = enHtml(charger(chemin));
  assert.ok(!page.includes("<script>x</script>"));
  assert.ok(page.includes("&lt;script&gt;"));
});

// --- Le Comptoir en ligne (chapitre 19) ----------------------------------------------------------

test("le coût par conversation, et les étapes ne sont pas des échecs", () => {
  for (const [conversation, cout] of [["c1", 0.001], ["c1", 0.002], ["c2", 0.004]] as const) {
    noterEvenement("message", { canal: "web", conversation, categorie: "commande", cout_dollars: cout, duree_ms: 5000 });
  }
  noterEvenement("etape", { trace: "t", etape: "routage" });
  const lignes = charger(journal);
  presque(parConversation(lignes).get("c1")!.dollars, 0.003);
  presque(coutParConversation(lignes).moyenne!, 0.0035);
  assert.equal(parJour(lignes).get(lignes[0]!.date.slice(0, 10))!.echecs, 0);
  const page = enHtml(lignes);
  assert.ok(page.includes("2 conversations ; coût moyen 0.0035 $"));
  assert.ok(page.includes("aucune durée d'appel")); // et non « 0 ms »
});

test("les alertes et les récidivistes", () => {
  regler({ BUDGET_JOUR: 0.01 });
  noterEvenement("message", { canal: "web", conversation: "c1", cout_dollars: 0.009, duree_ms: 4000 });
  for (let i = 0; i < 3; i++) noterEvenement("tentative_suspecte", { conversation: "c-suspecte-123", canal: "web" });
  const liste = alertes(charger(journal));
  assert.ok(liste.some((a) => a.includes("Dépense")));
  assert.ok(liste.some((a) => a.includes("signalée 3 fois")));
});

test("la dépense du jour compte aussi la surveillance", () => {
  regler({ BUDGET_JOUR: 0.01 });
  noterEvenement("message", { canal: "web", conversation: "c1", cout_dollars: 0.007, duree_ms: 4000 });
  assert.ok(!alertes(charger(journal)).some((a) => a.includes("Dépense")));
  noterEvenement("surveillance", { canal: "web", conversation: "c1", cout_dollars: 0.002 });
  assert.ok(alertes(charger(journal)).some((a) => a.includes("Dépense")));
});

test("les événements de sécurité et le taux d'erreur", () => {
  noterEvenement("message", { canal: "web", conversation: "c1", cout_dollars: 0.001, duree_ms: 3000 });
  noterEvenement("message", { canal: "whatsapp", conversation: "c2", erreur: "cle_invalide", origine: "compte" });
  noterEvenement("whatsapp_signature_invalide", {});
  noterEvenement("whatsapp_signature_invalide", {});
  const lignes = charger(journal);
  assert.equal(evenements(lignes).get("whatsapp_signature_invalide"), 2);
  assert.equal(tauxDErreur(lignes), 0.5);
  assert.deepEqual(latencesMessages(lignes), [3000, 3000]);
  assert.equal(modesDEchec(lignes).find((m) => m.code === "cle_invalide")?.nombre, 1);
});

// --- Les mêmes résultats que la version Python ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("sur un même journal, les mêmes chiffres que le tableau de la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const lignes: Ligne[] = [
    ...JOURNAL,
    { date: "2026-10-21T08:00:00+00:00", evenement: "message", canal: "web", conversation: "c5", cout_dollars: 0.002, duree_ms: 2500 },
    { date: "2026-10-21T08:01:00+00:00", evenement: "message", canal: "web", conversation: "c5", cout_dollars: 0.003, duree_ms: 3500 },
    { date: "2026-10-21T08:02:00+00:00", evenement: "message", canal: "whatsapp", conversation: "c6", erreur: "surcharge", origine: "service" },
    { date: "2026-10-21T08:03:00+00:00", evenement: "surveillance", conversation: "c5", cout_dollars: 0.0001 },
    { date: "2026-10-21T08:04:00+00:00", evenement: "limite", motif: "messages_par_minute", adresse: "1.2.3.4" },
    { date: "2026-10-21T08:05:00+00:00", evenement: "etape", trace: "t", etape: "routage", erreur: "surcharge" },
  ];
  const chemin = join(mkdtempSync(join(tmpdir(), "comptoir-")), "appels.jsonl");
  writeFileSync(chemin, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  const script = `
import json, sys
from datetime import datetime, timezone
from comptoir import tableau
l = tableau.charger(sys.argv[1])
print(json.dumps({
  "jours": tableau.par_jour(l),
  "modes": sorted([o, c, n] for (o, c), n in tableau.modes_d_echec(l).items()),
  "latences": tableau.latences(l),
  "reprendre": tableau.a_reprendre(l),
  "conversations": tableau.cout_par_conversation(l),
  "messages": tableau.latences_messages(l),
  "taux": tableau.taux_d_erreur(l),
  "evenements": dict(tableau.evenements(l)),
  "alertes": tableau.alertes(l, datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)),
}))`;
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script, chemin], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  const l = charger(chemin);
  const jours = Object.fromEntries([...parJour(l)].map(([j, v]) => [j, { ...v, dollars: Math.round(v.dollars * 1e9) / 1e9 }]));
  for (const v of Object.values(python.jours) as { dollars: number }[]) v.dollars = Math.round(v.dollars * 1e9) / 1e9;
  assert.deepEqual(jours, python.jours);
  assert.deepEqual(modesDEchec(l).map((m) => [m.origine, m.code, m.nombre]).sort(), python.modes);
  assert.deepEqual(latences(l), python.latences);
  assert.deepEqual(aReprendre(l), python.reprendre);
  const conversations = coutParConversation(l);
  assert.equal(conversations.conversations, python.conversations.conversations);
  presque(conversations.moyenne!, python.conversations.moyenne);
  assert.deepEqual(latencesMessages(l), python.messages);
  presque(tauxDErreur(l)!, python.taux);
  assert.deepEqual(Object.fromEntries(evenements(l)), python.evenements);
  assert.deepEqual(alertes(l, new Date("2026-10-21T12:00:00Z")), python.alertes);
});
