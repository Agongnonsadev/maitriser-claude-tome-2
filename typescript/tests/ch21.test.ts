// Chapitre 21 : la veille des modèles et du SDK, l'estimation d'un projet, l'effacement d'un numéro. Aucun appel
// à l'API. Les tests de python/tests/test_ch21.py, puis les mêmes textes que la version Python.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Boutique } from "../comptoir/boutique.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { PYTHON, RACINE } from "../comptoir/lancement.ts";
import * as whatsapp from "../comptoir/whatsapp.ts";
import * as donnees from "../ch18/donnees.ts";
import * as ep from "../ch21/estimer_projet.ts";
import * as veille from "../ch21/veille.ts";
import { journalTemporaire, presque, regler, remettreLesReglages } from "./faux_clients.ts";

beforeEach(() => journalTemporaire());
afterEach(remettreLesReglages);

const MAINTENANT = new Date(Date.UTC(2026, 9, 22));
// Trois lignes du tableau « Model status » de la page des retraits, telles que lues le 22 octobre 2026.
const PAGE = `| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-sonnet-5-5          | Active        | N/A                | Not sooner than September 28, 2027 |
| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026                  |
| claude-haiku-4-5-20251001  | Active        | N/A                | Not sooner than October 15, 2026   |
`;

const modele = (id: string, lifecycle = "active", retires_at: string | null = null): veille.ModeleVu => ({ id, lifecycle, retires_at });

test("la page des retraits se lit en états et en dates", () => {
  const etats = veille.etatsPublies(PAGE);
  assert.equal(etats["claude-sonnet-4-5-20250929"]!.etat, "Deprecated");
  assert.deepEqual(etats["claude-sonnet-4-5-20250929"]!.retrait, new Date(Date.UTC(2026, 10, 30)));
  assert.ok(etats["claude-sonnet-5-5"]!.auPlusTot && !etats["claude-sonnet-4-5-20250929"]!.auPlusTot);
});

test("un modèle déprécié sur la page alerte, même si l'API le dit actif", () => {
  // Constaté le 22 octobre 2026 : l'API Models disait « active » pour Claude Sonnet 4.5.
  const catalogue = { "claude-sonnet-4-5-20250929": modele("claude-sonnet-4-5-20250929") };
  const rapport = veille.examinerModeles(catalogue, veille.etatsPublies(PAGE), { MODELE: "claude-sonnet-4-5-20250929" }, 120, MAINTENANT);
  assert.ok(rapport.alertes.some((a) => a.includes("Deprecated") && a.includes("2026-11-30")));
  assert.ok(rapport.alertes.some((a) => a.includes("la page fait foi")));
});

test("un modèle actif donne sa date plancher, et aucun alias n'échappe", () => {
  const catalogue = { "claude-sonnet-5-5": modele("claude-sonnet-5-5"), "claude-haiku-4-5-20251001": modele("claude-haiku-4-5-20251001") };
  const rapport = veille.examinerModeles(catalogue, veille.etatsPublies(PAGE), { MODELE: "claude-sonnet-5-5", MODELE_ROUTEUR: "claude-haiku-4-5" }, 120, MAINTENANT);
  assert.deepEqual(rapport.alertes, []);
  assert.ok(rapport.infos.some((i) => i.includes("pas avant le 2027-09-28")));
  assert.ok(rapport.infos.some((i) => i.startsWith("claude-haiku-4-5 "))); // l'alias trouve la version datée
});

test("un retrait proche, ou un modèle absent, alerte", () => {
  const proche = modele("claude-x-1", "active", "2026-12-01T00:00:00Z");
  const rapport = veille.examinerModeles({ "claude-x-1": proche }, {}, { A: "claude-x-1", B: "claude-disparu-1" }, 120, MAINTENANT);
  assert.ok(rapport.alertes.some((a) => a.includes("retrait le 2026-12-01, dans 40 jours")));
  assert.ok(rapport.alertes.some((a) => a.includes("claude-disparu-1") && a.includes("absent")));
  assert.deepEqual(veille.examinerModeles({}, null, {}, 120, MAINTENANT).alertes, ["Page des retraits injoignable : seule l'API Models a été lue"]);
});

test("une version majeure de plus du SDK alerte", () => {
  assert.ok(veille.examinerSdk("0.137.0", "1.1.0", "2023-06-01").alertes.length);
  const mineure = veille.examinerSdk("1.1.0", "1.3.0", "2026-10-21");
  assert.ok(!mineure.alertes.length && mineure.infos[0]!.includes("même version majeure"));
  assert.ok(veille.examinerSdk("1.1.0", "1.1.0", "2026-10-21").infos[0]!.includes("à jour"));
  assert.ok(veille.examinerSdk("1.1.0", null, "2026-10-21").alertes.length);
});

test("la version de l'API se lit sans qu'aucune requête parte", async () => {
  // Le SDK 1.0.0 est passé à l'API 2026-10-21 (son journal des changements) ; aucun réseau ici.
  assert.equal(await veille.versionApiEnvoyee(), "2026-10-21");
  assert.equal(veille.versionInstallee().split(".")[0], "1");
});

test("les modèles écrits dans le dépôt sont inventoriés", () => {
  const dossier = mkdtempSync(join(tmpdir(), "ch21-"));
  mkdirSync(join(dossier, "comptoir"));
  writeFileSync(join(dossier, "comptoir", "appel.ts"), 'export const MODELE = "claude-sonnet-4-5-20250929";\n', "utf8");
  mkdirSync(join(dossier, "tests"));
  writeFileSync(join(dossier, "tests", "x.test.ts"), '"claude-haiku-4-5"\n', "utf8"); // les tests ne comptent pas
  mkdirSync(join(dossier, "node_modules", "paquet"), { recursive: true });
  writeFileSync(join(dossier, "node_modules", "paquet", "index.ts"), '"claude-opus-4-1"\n', "utf8"); // ni les dépendances
  assert.deepEqual(veille.modelesDuDepot(dossier), { "claude-sonnet-4-5-20250929": new Set(["comptoir/appel.ts"]) });
});

// --- L'effacement à la demande, avec WhatsApp ---------------------------------------------------------

test("effacer une conversation efface aussi le numéro WhatsApp", () => {
  // Trouvé en écrivant la procédure d'exploitation : le numéro restait dans l'annuaire du chapitre 19.
  regler({ SEL_PSEUDONYMES: "sel-de-test" });
  const boutique = new Boutique();
  const conversations = new Conversations();
  const annuaire = new whatsapp.Annuaire();
  const conversation = conversations.creer("systeme-v5");
  annuaire.lier(whatsapp.pseudonyme("22997000000", "sel-de-test"), "22997000000", conversation);
  const resultat = donnees.effacerNumero(boutique, conversations, annuaire, "22997000000");
  assert.ok(resultat.conversation_trouvee && resultat.conversation_effacee && resultat.numero_efface);
  assert.equal(annuaire.conversation(whatsapp.pseudonyme("22997000000", "sel-de-test")), null);
  assert.deepEqual(donnees.effacerNumero(boutique, conversations, annuaire, "22997000000"), { conversation_trouvee: false });
});

test("la purge quotidienne oublie aussi les numéros anciens", () => {
  assert.equal(donnees.purger(new Boutique(), new Conversations(), new whatsapp.Annuaire()).clients_whatsapp_oublies, 0);
});

// --- L'estimation d'un projet, et le job de veille ---------------------------------------------------

test("l'estimation part des prix mesurés, et compte les messages gratuits", () => {
  const e = ep.estimer(1500, { whatsapp: true, hebergement: 7.0 });
  presque(e.claude, 1500 * 0.00075);
  presque(e.claudeAvecMarge, 1500 * 0.00075 * 1.5);
  presque(e.whatsapp, 500 * 0.004); // 1 000 messages de service gratuits par mois
  presque(e.total!, 1.6875 + 2.0 + 7.0);
  assert.equal(ep.estimer(800, { whatsapp: true }).whatsapp, 0);
  const sansHebergement = ep.estimer(1500);
  assert.ok(sansHebergement.total === null && ep.enTexte(sansHebergement, 1500).includes("[à mesurer]"));
});

test("le job de veille de la version TypeScript est planifié sans clé", () => {
  const texte = readFileSync(join(RACINE, "..", ".github", "workflows", "veille.yml"), "utf8");
  assert.ok(!texte.includes("secrets.") && texte.includes("id-token: write") && texte.includes("cron:"));
  assert.ok(texte.includes("npx tsx ch21/veille.ts") && texte.includes("timeout-minutes:"));
});

// --- Les mêmes textes que la version Python ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("les mêmes rapports de veille et les mêmes estimations que la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const catalogue: Record<string, veille.ModeleVu> = {
    "claude-sonnet-5-5": modele("claude-sonnet-5-5"), "claude-sonnet-4-5-20250929": modele("claude-sonnet-4-5-20250929"),
    "claude-haiku-4-5-20251001": modele("claude-haiku-4-5-20251001"), "claude-x-1": modele("claude-x-1", "active", "2026-12-01T00:00:00Z"),
    "claude-y-1": modele("claude-y-1", "deprecated"),
  };
  const utilises = { MODELE: "claude-sonnet-5-5", MODELE_ROUTEUR: "claude-haiku-4-5", MODELE_DOCUMENTS: "claude-sonnet-4-5-20250929", A: "claude-x-1", B: "claude-y-1", C: "claude-disparu-1" };
  const estimations: [number, Record<string, unknown>][] = [
    [1500, { whatsapp: true, hebergement: 7 }], [1500, {}], [800, { whatsapp: true, hebergement: 12.5 }], [0, { hebergement: 7 }], [40000, { whatsapp: true, coutMessage: 0.0009, tarifWhatsapp: 0.0113, hebergement: 30 }],
  ];
  const ts = {
    modeles: [120, 30].map((h) => veille.examinerModeles(catalogue, veille.etatsPublies(PAGE), utilises, h, MAINTENANT).texte()),
    sdk: [["0.137.0", "1.1.0"], ["1.1.0", "1.3.0"], ["1.1.0", "1.1.0"], ["1.1.0", null]].map(([i, d]) => veille.examinerSdk(i!, d ?? null, "2026-10-21").texte()),
    estimations: estimations.map(([n, o]) => ep.enTexte(ep.estimer(n, o), n)),
  };
  const script = `
import json, sys
from datetime import datetime, timezone
from types import SimpleNamespace
from ch21 import estimer_projet as ep, veille
e = json.load(sys.stdin)
def modele(m):
    retrait = datetime.fromisoformat(m["retires_at"].replace("Z", "+00:00")) if m["retires_at"] else None
    return SimpleNamespace(id=m["id"], lifecycle=m["lifecycle"], retires_at=retrait)
catalogue = {k: modele(v) for k, v in e["catalogue"].items()}
maintenant = datetime(2026, 10, 22, tzinfo=timezone.utc)
remplace = lambda t: t.replace("SDK anthropic", "SDK @anthropic-ai/sdk")
print(json.dumps({
    "modeles": [veille.examiner_modeles(catalogue, veille.etats_publies(e["page"]), e["utilises"], h, maintenant).texte() for h in (120, 30)],
    "sdk": [remplace(veille.examiner_sdk(i, d, "2026-10-21").texte()) for i, d in e["sdk"]],
    "estimations": [ep.en_texte(ep.estimer(n, o.get("coutMessage", ep.COUT_PAR_MESSAGE), o.get("whatsapp", False),
                                          o.get("tarifWhatsapp", ep.TARIF_WHATSAPP), o.get("hebergement")), n) for n, o in e["estimations"]],
}, ensure_ascii=False))`;
  const py = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], {
    cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    input: JSON.stringify({ catalogue, page: PAGE, utilises, sdk: [["0.137.0", "1.1.0"], ["1.1.0", "1.3.0"], ["1.1.0", "1.1.0"], ["1.1.0", null]], estimations }),
  }));
  assert.deepEqual(ts, py);
});
