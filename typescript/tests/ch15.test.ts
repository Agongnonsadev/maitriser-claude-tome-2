// Chapitre 15 : le serveur MCP « Comptoir pour Awa » (python/tests/test_ch15.py). Aucun appel à l'API, aucun
// réseau. Le serveur est interrogé par un vrai client MCP, en mémoire, et une fois lancé en stdio ; puis
// comparé au serveur de la version Python, sur la même base, à la même heure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, before, beforeEach, test } from "node:test";
import { connecter } from "../ch14/serveurs.ts";
import { clientDiscret, creerServeur, fcfa, horloge, jourEnToutesLettres } from "../ch15/comptoir_pour_awa.ts";
import { REGLAGES, inventaire, manifeste } from "../ch15/construire_extension.ts";
import { PYTHON, RACINE } from "../comptoir/lancement.ts";
import { annoncePython, annonceTypeScript } from "./annonce_mcp.ts";

const T0 = new Date("2026-10-21T07:00:00Z");
const FINE = String.fromCodePoint(0x202f);
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const DEMO = join(PYTHON, "donnees_clients", "boutique_demo.sqlite3");

/** La base de démonstration de la version Python, ou une base fabriquée par son générateur, le même tirage. */
let modele: string | null = null;
before(() => {
  if (existsSync(DEMO)) modele = DEMO;
  else if (PYTHON_VENV) {
    modele = join(mkdtempSync(join(tmpdir(), "ch15-")), "boutique.sqlite3");
    execFileSync(PYTHON_VENV, ["-c", "import sys; from pathlib import Path; from ch14.fabriquer_commandes import simuler; simuler(Path(sys.argv[1]))", modele], { cwd: PYTHON });
  }
});
const sansBase = (): { skip: string } | Record<string, never> => (existsSync(DEMO) || PYTHON_VENV ? {} : { skip: "ni base de démonstration ni environnement Python" });

let base: string;
const avant = { ...process.env };
const horlogeDOrigine = horloge.maintenant;
beforeEach(() => {
  if (!modele) return;
  // Une copie neuve de la boutique pour chaque test : les corrections y écrivent.
  base = join(mkdtempSync(join(tmpdir(), "comptoir-awa-")), "boutique.sqlite3");
  copyFileSync(modele, base);
  process.env.COMPTOIR_BOUTIQUE = base;
  process.env.COMPTOIR_AUJOURDHUI = "2026-10-17";
  horloge.maintenant = () => T0;
});
afterEach(() => {
  for (const cle of ["COMPTOIR_BOUTIQUE", "COMPTOIR_AUJOURDHUI"]) {
    if (avant[cle] === undefined) delete process.env[cle];
    else process.env[cle] = avant[cle];
  }
  horloge.maintenant = horlogeDOrigine;
});

async function client(): Promise<Client> {
  const [cote, autre] = InMemoryTransport.createLinkedPair();
  await creerServeur().connect(cote);
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(autre);
  return c;
}

type Resultat = { structuredContent?: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean };
async function appeler(outil: string, args: Record<string, unknown> = {}): Promise<Resultat> {
  const c = await client();
  try {
    return (await c.callTool({ name: outil, arguments: args })) as Resultat;
  } finally {
    await c.close();
  }
}
const sortie = async (outil: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await appeler(outil, args)).structuredContent!;

function lire<T>(sql: string): T {
  const db = new DatabaseSync(base, { readOnly: true });
  try {
    return db.prepare(sql).all() as T;
  } finally {
    db.close();
  }
}
const stockDe = (produit: string): number => lire<{ quantite: number }[]>(`SELECT quantite FROM stock WHERE produit = '${produit.replaceAll("'", "''")}'`)[0]!.quantite;

test("le serveur annonce cinq outils, dont un seul destructeur", async () => {
  const c = await client();
  const outils = new Map((await c.listTools()).tools.map((t) => [t.name, t]));
  await c.close();
  assert.deepEqual(new Set(outils.keys()), new Set(["commandes_du_jour", "stock", "ventes_de_la_semaine", "preparer_correction", "appliquer_correction"]));
  assert.deepEqual([...outils].filter(([, t]) => t.annotations?.destructiveHint).map(([n]) => n), ["appliquer_correction"]);
  assert.deepEqual(outils.get("appliquer_correction")!._meta, { "anthropic/requiresUserInteraction": true });
  assert.ok(["commandes_du_jour", "stock", "ventes_de_la_semaine"].every((n) => outils.get(n)!.annotations?.readOnlyHint));
  assert.equal(outils.get("preparer_correction")!.annotations?.readOnlyHint, false); // il écrit un projet, pas le stock
});

test("les commandes du jour sont celles de la base", sansBase(), async () => {
  const r = await sortie("commandes_du_jour");
  const [attendu] = lire<{ n: number; total: number }[]>("SELECT COUNT(*) AS n, SUM(total) AS total FROM commandes WHERE substr(cree_le, 1, 10) = '2026-10-17'");
  assert.deepEqual([r.nombre, r.total_fcfa], [attendu!.n, attendu!.total]);
  assert.equal(r.resume, `${attendu!.n} commandes le samedi 17 octobre 2026, pour ${fcfa(attendu!.total)}.`);
  // Prénom et initiale seulement : assez pour livrer, sans le nom complet.
  assert.ok((r.commandes as { client: string }[]).every((c) => c.client.split(" ").length === 2 && c.client.endsWith(".")));
});

test("le stock signale la rupture", sansBase(), async () => {
  const r = await sortie("stock");
  const corossol = (r.produits as { produit: string; etat: string }[]).find((p) => p.produit === "Jus de corossol")!;
  assert.ok(corossol.etat === "rupture" && String(r.resume).includes("En rupture : Jus de corossol."));
});

test("les ventes de la semaine vont du lundi au dimanche", sansBase(), async () => {
  const r = await sortie("ventes_de_la_semaine", { un_jour_de_la_semaine: "2026-10-14" });
  assert.deepEqual([r.du, r.au], ["2026-10-12", "2026-10-18"]);
  assert.equal((r.par_produit as { produit: string; quantite: number }[]).find((p) => p.produit === "Jus de bissap")!.quantite, 129); // le chiffre vérifié au chapitre 14
});

test("une correction se fait en deux temps", sansBase(), async () => {
  const projet = await sortie("preparer_correction", { produit: "Jus de bissap", quantite_comptee: 32 });
  assert.deepEqual([projet.stock_actuel, projet.ecart], [40, -8]);
  assert.ok(String(projet.a_dire_a_awa).includes("soit 8 de moins"));
  assert.equal(stockDe("Jus de bissap"), 40); // inchangé
  const fait = await sortie("appliquer_correction", { jeton: projet.jeton });
  assert.deepEqual([fait.avant, fait.apres], [40, 32]);
  assert.equal(stockDe("Jus de bissap"), 32);
  assert.deepEqual(lire<{ statut: string }[]>("SELECT statut FROM corrections_stock").map((l) => l.statut), ["appliquee"]);
  // Un jeton ne sert qu'une fois.
  const encore = await appeler("appliquer_correction", { jeton: projet.jeton });
  assert.ok(encore.isError && encore.content[0]!.text.includes("déjà servi"));
});

test("un jeton expire après dix minutes", sansBase(), async () => {
  const projet = await sortie("preparer_correction", { produit: "Jus d'ananas", quantite_comptee: 10 });
  horloge.maintenant = () => new Date(T0.getTime() + 11 * 60_000);
  const r = await appeler("appliquer_correction", { jeton: projet.jeton });
  assert.ok(r.isError && r.content[0]!.text.includes("expiré"));
  assert.equal(stockDe("Jus d'ananas"), 12);
  assert.deepEqual(lire<{ statut: string }[]>("SELECT statut FROM corrections_stock").map((l) => l.statut), ["expiree"]);
});

test("un stock qui a bougé entre-temps annule la correction, sans rien écrire", sansBase(), async () => {
  const projet = await sortie("preparer_correction", { produit: "Jus de bissap", quantite_comptee: 32 });
  const db = new DatabaseSync(base);
  db.exec("UPDATE stock SET quantite = 37 WHERE produit = 'Jus de bissap'"); // une vente pendant ce temps
  db.close();
  const r = await appeler("appliquer_correction", { jeton: projet.jeton });
  assert.ok(r.isError && r.content[0]!.text.includes("a changé depuis la préparation (40 → 37"));
  assert.equal(stockDe("Jus de bissap"), 37);
  // Comme le with db: de Python, l'erreur annule tout le bloc : la correction reste « preparee ».
  assert.deepEqual(lire<{ statut: string }[]>("SELECT statut FROM corrections_stock").map((l) => l.statut), ["preparee"]);
});

test("les arguments sont vérifiés avant le code", sansBase(), async () => {
  assert.ok((await appeler("preparer_correction", { produit: "Jus de mangue", quantite_comptee: 3 })).isError);
  assert.ok((await appeler("preparer_correction", { produit: "Jus de bissap", quantite_comptee: -1 })).isError);
  const trop = await appeler("preparer_correction", { produit: "Jus de bissap", quantite_comptee: 900 });
  assert.ok(trop.isError && trop.content[0]!.text.includes("trop pour une correction d'inventaire"));
});

test("une base absente donne un message qui dit quoi faire", async () => {
  process.env.COMPTOIR_BOUTIQUE = join(tmpdir(), "absente-ch15.sqlite3");
  const r = await appeler("stock");
  assert.ok(r.isError && r.content[0]!.text.includes("Vérifiez le réglage « Base de la boutique »"));
});

test("ressources et prompts", sansBase(), async () => {
  const c = await client();
  const catalogue = (await c.readResource({ uri: "comptoir://catalogue" })).contents[0] as { text: string };
  const commande = (await c.readResource({ uri: "comptoir://commande/C-0042" })).contents[0] as { text: string };
  const modeles = (await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  const bilan = await c.getPrompt({ name: "bilan_du_soir", arguments: { jour: "samedi 17 octobre" } });
  await c.close();
  assert.ok(catalogue.text.includes(`- Jus de bissap (bouteille de 50 cl) : 1${FINE}000 FCFA`));
  assert.ok(commande.text.startsWith("# Commande C-0042"));
  assert.deepEqual(modeles, ["comptoir://commande/{numero}"]);
  const texte = (bilan.messages[0]!.content as { text: string }).text;
  assert.ok(bilan.messages[0]!.role === "user" && texte.includes("du samedi 17 octobre") && texte.includes("Ne modifie rien"));
});

test("le serveur démarre en stdio et n'écrit rien sur la sortie standard", sansBase(), async () => {
  // Le client lit la sortie standard comme du JSON-RPC : un console.log la casserait.
  const tsx = pathToFileURL(join(RACINE, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const { client: c, protocole } = await connecter({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", "--import", tsx, join(RACINE, "ch15", "comptoir_pour_awa.ts")],
    cwd: RACINE,
    env: { COMPTOIR_BOUTIQUE: base, COMPTOIR_AUJOURDHUI: "2026-10-17" },
  });
  try {
    const r = (await c.callTool({ name: "stock", arguments: {} })) as Resultat;
    assert.equal(protocole, LATEST_PROTOCOL_VERSION); // 2025-11-25 avec le SDK 1.32.1 ; 2026-07-28 en Python
    assert.ok(String(r.structuredContent!.resume).startsWith("En rupture"));
  } finally {
    await c.close();
  }
});

test("le manifeste annonce exactement ce que le serveur expose", async () => {
  const [outils, prompts] = await inventaire();
  const m = manifeste(outils, prompts) as { manifest_version: string; server: { type: string; mcp_config: { env: unknown } }; tools: { name: string }[]; prompts: { name: string; arguments: string[]; text: string }[]; user_config: object };
  assert.ok(m.manifest_version === "0.4" && m.server.type === "node");
  assert.deepEqual(m.tools.map((o) => o.name), ["commandes_du_jour", "stock", "ventes_de_la_semaine", "preparer_correction", "appliquer_correction"]);
  const bilan = m.prompts.find((p) => p.name === "bilan_du_soir")!;
  assert.deepEqual(bilan.arguments, ["jour"]);
  assert.ok(bilan.text.includes("${arguments.jour}"));
  // Chaque réglage est transmis au serveur, et seulement par l'environnement.
  assert.deepEqual(m.server.mcp_config.env, { COMPTOIR_BOUTIQUE: "${user_config.base_boutique}" });
  assert.deepEqual(Object.keys(m.user_config), Object.keys(REGLAGES));
});

test("mise en forme pour Awa", () => {
  assert.equal(fcfa(329500), `329${FINE}500 FCFA`);
  assert.equal(jourEnToutesLettres("2026-11-01"), "dimanche 1er novembre 2026");
  assert.equal(clientDiscret("Larissa Noudéhou"), "Larissa N.");
  assert.equal(clientDiscret("Awa"), "Awa");
});

// --- Le même serveur que la version Python -------------------------------------------------------

const sansPython = (): { skip: string } | Record<string, never> => (PYTHON_VENV && (existsSync(DEMO) || PYTHON_VENV) ? {} : { skip: "environnement Python absent" });

test("le même serveur que la version Python : annonce, outils, ressources et prompts", sansPython(), async () => {
  const c = await client();
  const ts = await annonceTypeScript(c);
  await c.close();
  assert.deepEqual(ts, annoncePython(PYTHON_VENV!, "from ch15 import comptoir_pour_awa as awa", "awa.serveur"));
});

test("les mêmes réponses que la version Python, sur la même base, à la même heure", sansPython(), async () => {
  const appels: [string, Record<string, unknown>][] = [
    ["commandes_du_jour", {}],
    ["commandes_du_jour", { jour: "2026-10-01" }],
    ["commandes_du_jour", { jour: "2026-12-25" }],
    ["stock", {}],
    ["ventes_de_la_semaine", { un_jour_de_la_semaine: "2026-10-14" }],
    ["ventes_de_la_semaine", {}],
    ["ventes_de_la_semaine", { un_jour_de_la_semaine: "2026-07-20" }],
    ["preparer_correction", { produit: "Jus de bissap", quantite_comptee: 32 }],
    ["preparer_correction", { produit: "Sirop de gingembre", quantite_comptee: 5 }],
    ["preparer_correction", { produit: "Jus d'ananas", quantite_comptee: 900 }],
    ["appliquer_correction", { jeton: "JETON-0" }],
    ["appliquer_correction", { jeton: "JETON-0" }],
    ["appliquer_correction", { jeton: "inconnu" }],
  ];
  // Les jetons sont tirés au hasard : le n-ième jeton rendu remplace JETON-n, des deux côtés.
  const ts: unknown[] = [];
  const jetons: string[] = [];
  for (const [nom, args] of appels) {
    const reels = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.startsWith("JETON-") ? jetons[Number(v.slice(6))] : v]));
    const r = await appeler(nom, reels);
    if (r.structuredContent?.jeton) jetons.push(String(r.structuredContent.jeton));
    ts.push(r.isError ? { erreur: r.content[0]!.text } : { sortie: r.structuredContent, texte: r.content[0]!.text });
  }
  const c = await client();
  const ressources = [(await c.readResource({ uri: "comptoir://catalogue" })).contents[0], (await c.readResource({ uri: "comptoir://commande/C-0042" })).contents[0]];
  const prompts = [await c.getPrompt({ name: "bilan_du_soir", arguments: {} }), await c.getPrompt({ name: "bilan_du_soir", arguments: { jour: "samedi" } }), await c.getPrompt({ name: "inventaire", arguments: {} })];
  await c.close();
  const corrections = lire<unknown[]>("SELECT produit, avant, apres, preparee_le, statut, appliquee_le FROM corrections_stock ORDER BY preparee_le, produit");
  const masquer = (texte: string, liste: string[]): string => liste.reduce((t, j, i) => t.replaceAll(j, `JETON-${i}`), texte);
  const tsTexte = masquer(JSON.stringify({ appels: ts, ressources, prompts: prompts.map((p) => p.messages), corrections }), jetons);

  const copie = join(mkdtempSync(join(tmpdir(), "comptoir-awa-python-")), "boutique.sqlite3");
  copyFileSync(modele!, copie);
  const script = `
import asyncio, json, os, sqlite3, sys
from datetime import datetime, timezone
from mcp import Client
from ch15 import comptoir_pour_awa as awa
awa._maintenant = lambda: datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)
appels = json.load(sys.stdin)
async def main():
    sorties, jetons = [], []
    async with Client(awa.serveur) as c:
        for nom, args in appels:
            args = {k: (jetons[int(v[6:])] if isinstance(v, str) and v.startswith("JETON-") else v) for k, v in args.items()}
            r = await c.call_tool(nom, args)
            if r.structured_content and r.structured_content.get("jeton"):
                jetons.append(r.structured_content["jeton"])
            sorties.append({"erreur": r.content[0].text} if r.is_error else {"sortie": r.structured_content, "texte": r.content[0].text})
        d = lambda x: x.model_dump(mode="json", by_alias=True, exclude_none=True)
        ressources = [d((await c.read_resource(u)).contents[0]) for u in ("comptoir://catalogue", "comptoir://commande/C-0042")]
        prompts = [[d(m) for m in (await c.get_prompt(n, a)).messages] for n, a in (("bilan_du_soir", {}), ("bilan_du_soir", {"jour": "samedi"}), ("inventaire", {}))]
    db = sqlite3.connect(os.environ["COMPTOIR_BOUTIQUE"])
    db.row_factory = sqlite3.Row
    corrections = [dict(l) for l in db.execute("SELECT produit, avant, apres, preparee_le, statut, appliquee_le FROM corrections_stock ORDER BY preparee_le, produit")]
    print(json.dumps({"appels": sorties, "ressources": ressources, "prompts": prompts, "corrections": corrections, "jetons": jetons}, ensure_ascii=False))
asyncio.run(main())`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON,
      input: JSON.stringify(appels),
      encoding: "utf8",
      stdio: "pipe", // le journal du serveur Python reste hors de la sortie des tests
      env: { ...process.env, PYTHONIOENCODING: "utf-8", COMPTOIR_BOUTIQUE: copie, COMPTOIR_AUJOURDHUI: "2026-10-17" },
    }),
  ) as { jetons: string[] } & Record<string, unknown>;
  const { jetons: jetonsPython, ...reste } = python;
  assert.equal(jetons.length, jetonsPython.length);
  assert.deepEqual(JSON.parse(tsTexte), JSON.parse(masquer(JSON.stringify(reste), jetonsPython)));
});
