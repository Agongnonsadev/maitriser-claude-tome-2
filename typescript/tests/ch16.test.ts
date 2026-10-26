// Chapitre 16 : le Comptoir en ligne et son serveur d'autorisation (python/tests/test_ch16.py). Aucun appel à
// l'API : l'application écoute sur un port libre de cet ordinateur (127.0.0.1), et les tests lui parlent en
// HTTP, comme le ferait un client ; le serveur MCP est aussi interrogé en mémoire.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, request as requeteHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, before, beforeEach, test } from "node:test";
import { creerServeur, horloge } from "../ch15/comptoir_pour_awa.ts";
import { FournisseurAwa, RETOUR_CLAUDE, hacher, verifierMotDePasse } from "../ch16/autorisation.ts";
import { entetes as entetesBrutes, message as messageBrut } from "../ch16/client_brut.ts";
import { requete as requeteParLApi } from "../ch16/demander_par_l_api.ts";
import { ConnexionOAuth, StockageFichier, connecter as connecterCommeYao, navigateurSimule, type Navigateur } from "../ch16/se_connecter.ts";
import { application, construire } from "../ch16/serveur_en_ligne.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { annoncePython, annonceTypeScript } from "./annonce_mcp.ts";

const MOT_DE_PASSE = "mot-de-passe-des-tests-16"; // valeur de test, pour ce serveur local seulement
const RETOUR = "http://localhost:3030/callback";
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const DEMO = join(PYTHON, "donnees_clients", "boutique_demo.sqlite3");

let modele: string | null = null;
before(() => {
  if (existsSync(DEMO)) modele = DEMO;
  else if (PYTHON_VENV) {
    modele = join(mkdtempSync(join(tmpdir(), "ch16-")), "boutique.sqlite3");
    execFileSync(PYTHON_VENV, ["-c", "import sys; from pathlib import Path; from ch14.fabriquer_commandes import simuler; simuler(Path(sys.argv[1]))", modele], { cwd: PYTHON });
  }
});
const sansBase = (): { skip: string } | Record<string, never> => (existsSync(DEMO) || PYTHON_VENV ? {} : { skip: "ni base de démonstration ni environnement Python" });

interface Comptoir {
  url: string;
  port: number;
  boutique: string;
  autorisation: string;
  fournisseur: FournisseurAwa;
  http: Server;
}

let comptoir: Comptoir;
const avant = { ...process.env };
const horlogeDOrigine = horloge.maintenant;

beforeEach(async () => {
  const dossier = mkdtempSync(join(tmpdir(), "comptoir-en-ligne-"));
  const boutique = join(dossier, "boutique.sqlite3");
  if (modele) copyFileSync(modele, boutique);
  process.env.COMPTOIR_BOUTIQUE = boutique;
  process.env.COMPTOIR_AUJOURDHUI = "2026-10-17";
  // Le port n'est connu qu'une fois le serveur à l'écoute : l'application, et son adresse publique, viennent après.
  const http = createServer();
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  const port = (http.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  const autorisation = join(dossier, "auth.sqlite3");
  const { app, fournisseur } = application(url, autorisation, hacher(MOT_DE_PASSE));
  http.on("request", app);
  comptoir = { url, port, boutique, autorisation, fournisseur, http };
});

afterEach(async () => {
  comptoir.http.closeAllConnections();
  await new Promise((ok) => comptoir.http.close(ok));
  for (const cle of ["COMPTOIR_BOUTIQUE", "COMPTOIR_AUJOURDHUI"]) {
    if (avant[cle] === undefined) delete process.env[cle];
    else process.env[cle] = avant[cle];
  }
  horloge.maintenant = horlogeDOrigine;
});

const ACCEPTE = { Accept: "application/json, text/event-stream" };
const appeler = (chemin: string, init: RequestInit = {}): Promise<globalThis.Response> => fetch(new URL(chemin, comptoir.url), { redirect: "manual", ...init });
const formulaire = (donnees: Record<string, string>): RequestInit => ({ method: "POST", body: new URLSearchParams(donnees) });

function pkce(): [string, string] {
  const verificateur = randomBytes(48).toString("base64url");
  return [verificateur, createHash("sha256").update(verificateur).digest("base64url")];
}

const enregistrer = (retours = [RETOUR]): Promise<globalThis.Response> =>
  appeler("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Tests", redirect_uris: retours, token_endpoint_auth_method: "none", scope: "comptoir" }),
  });

function autoriser(clientId: string, defi: string, retour = RETOUR, ressource = `${comptoir.url}/mcp`): Promise<globalThis.Response> {
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: retour, code_challenge: defi, code_challenge_method: "S256", state: "etat-42", scope: "comptoir", resource: ressource });
  return appeler(`/authorize?${params}`);
}

/** Le parcours d'Awa jusqu'au jeton. Rend l'identifiant du client et la réponse du point de jeton. */
async function seConnecter(motDePasse = MOT_DE_PASSE): Promise<[string, globalThis.Response]> {
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const [verificateur, defi] = pkce();
  const page = (await autoriser(clientId, defi)).headers.get("location")!;
  const envoi = await appeler(page, formulaire({ mot_de_passe: motDePasse, decision: "autoriser" }));
  assert.equal(envoi.status, 302, await envoi.text());
  const retour = new URL(envoi.headers.get("location")!).searchParams;
  // RFC 9207 : l'émetteur, tel que les métadonnées l'annoncent (avec la barre finale de URL.href).
  assert.deepEqual([retour.get("state"), retour.get("iss")], ["etat-42", `${comptoir.url}/`]);
  const jetons = await appeler("/token", formulaire({ grant_type: "authorization_code", code: retour.get("code")!, redirect_uri: RETOUR, client_id: clientId, code_verifier: verificateur, resource: `${comptoir.url}/mcp` }));
  return [clientId, jetons];
}

type Jetons = { access_token: string; refresh_token: string; token_type: string; expires_in: number };

async function clientMcp(acces: string, capacites = {}): Promise<[Client, StreamableHTTPClientTransport]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${comptoir.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${acces}` } } });
  const client = new Client({ name: "tests", version: "1.0.0" }, { capabilities: capacites });
  await client.connect(transport);
  return [client, transport];
}

test("sans jeton, le serveur dit où s'authentifier", async () => {
  const refus = await appeler("/mcp", { method: "POST", headers: { ...ACCEPTE, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const ressource = (await (await appeler("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string; authorization_servers: string[] };
  const serveur = (await (await appeler("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  assert.equal(refus.status, 401);
  assert.ok(refus.headers.get("www-authenticate")!.includes(`resource_metadata="${comptoir.url}/.well-known/oauth-protected-resource/mcp"`));
  assert.ok(ressource.resource === `${comptoir.url}/mcp` && ressource.authorization_servers[0]!.replace(/\/$/, "") === comptoir.url);
  assert.deepEqual([serveur.issuer, serveur.code_challenge_methods_supported, serveur.registration_endpoint], [`${comptoir.url}/`, ["S256"], `${comptoir.url}/register`]);
});

test("une adresse de retour étrangère est refusée", async () => {
  const etrangere = await enregistrer(["https://exemple.invalid/vol"]);
  const claude = await enregistrer([RETOUR_CLAUDE]);
  assert.ok(etrangere.status === 400 && ((await etrangere.json()) as { error: string }).error === "invalid_redirect_uri");
  assert.equal(claude.status, 201);
});

test("le parcours complet ouvre les outils", sansBase(), async () => {
  const jetons = (await (await seConnecter())[1].json()) as Jetons;
  assert.ok(jetons.token_type.toLowerCase() === "bearer" && jetons.expires_in === 3600 && jetons.refresh_token);
  const [client, transport] = await clientMcp(jetons.access_token);
  try {
    const outils = (await client.listTools()).tools.map((t) => t.name);
    const stock = (await client.callTool({ name: "stock", arguments: {} })).structuredContent as { resume: string };
    assert.ok(outils.at(-1) === "rapport_de_la_semaine" && outils.length === 6);
    assert.ok(stock.resume.startsWith("En rupture"));
    assert.equal(transport.protocolVersion, "2025-11-25"); // 2026-07-28 en Python
    assert.equal(transport.sessionId, undefined); // sans état : aucune session
  } finally {
    await client.close();
  }
});

test("la page montre qui demande et prévient pour un retour local", async () => {
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const page = await appeler((await autoriser(clientId, pkce()[1])).headers.get("location")!);
  const texte = await page.text();
  assert.ok(page.status === 200 && texte.includes("<strong>Tests</strong> demande l'accès"));
  assert.ok(texte.includes("<strong>localhost</strong>") && texte.includes("Le retour se fait sur cet ordinateur"));
  assert.ok(page.headers.get("cache-control") === "no-store" && page.headers.get("x-frame-options") === "DENY");
  // La redirection qui suit le formulaire doit être permise par la CSP, et seulement vers ce retour-là.
  assert.ok(page.headers.get("content-security-policy")!.endsWith("form-action 'self' http://localhost:3030"));
});

test("le port d'une adresse locale peut changer", async () => {
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const autrePort = await autoriser(clientId, pkce()[1], "http://localhost:51234/callback");
  const autreChemin = await autoriser(clientId, pkce()[1], "http://localhost:51234/ailleurs");
  assert.ok(autrePort.status === 302 && autrePort.headers.get("location")!.includes("/connexion?demande="));
  assert.equal(autreChemin.status, 400); // le chemin, lui, doit être le même
});

test("un formulaire renvoyé après succès rend la même redirection", async () => {
  // Constaté pendant l'essai de la version Python : sur une connexion qui se coupe, le navigateur renvoie le formulaire.
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const page = (await autoriser(clientId, pkce()[1])).headers.get("location")!;
  const premier = await appeler(page, formulaire({ mot_de_passe: MOT_DE_PASSE, decision: "autoriser" }));
  const second = await appeler(page, formulaire({ mot_de_passe: MOT_DE_PASSE, decision: "autoriser" }));
  assert.ok(premier.status === 302 && second.status === 302);
  assert.equal(premier.headers.get("location"), second.headers.get("location")); // le même code, pas un second
});

test("cinq mots de passe faux bloquent la connexion", async () => {
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const page = (await autoriser(clientId, pkce()[1])).headers.get("location")!;
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await appeler(page, formulaire({ mot_de_passe: "faux", decision: "autoriser" }))).status);
  const bloque = await appeler(page, formulaire({ mot_de_passe: MOT_DE_PASSE, decision: "autoriser" }));
  assert.deepEqual(codes, [401, 401, 401, 401, 401]);
  assert.ok(bloque.status === 429 && (await bloque.text()).includes("Trop d'essais"));
});

test("refuser renvoie access_denied", async () => {
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const page = (await autoriser(clientId, pkce()[1])).headers.get("location")!;
  const refus = await appeler(page, formulaire({ decision: "refuser" }));
  assert.ok(refus.status === 302 && refus.headers.get("location")!.includes("error=access_denied"));
});

test("une ressource étrangère est refusée", async () => {
  const clientId = ((await (await enregistrer()).json()) as { client_id: string }).client_id;
  const reponse = await autoriser(clientId, pkce()[1], RETOUR, "https://autre.invalid/mcp");
  assert.ok(reponse.status === 302 && reponse.headers.get("location")!.includes("error=invalid_target"));
});

test("rotation et vol d'un jeton de renouvellement", async () => {
  const [clientId, jetons] = await seConnecter();
  const premier = (await jetons.json()) as Jetons;
  const renouvele = await appeler("/token", formulaire({ grant_type: "refresh_token", client_id: clientId, refresh_token: premier.refresh_token }));
  const second = (await renouvele.json()) as Jetons;
  // L'ancien jeton de renouvellement revient : quelqu'un l'a copié. Tout est révoqué.
  const vol = await appeler("/token", formulaire({ grant_type: "refresh_token", client_id: clientId, refresh_token: premier.refresh_token }));
  const apres = await appeler("/mcp", {
    method: "POST",
    headers: { ...ACCEPTE, "Content-Type": "application/json", Authorization: `Bearer ${second.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.ok(renouvele.status === 200 && second.refresh_token !== premier.refresh_token);
  assert.ok(vol.status === 400 && ((await vol.json()) as { error: string }).error === "invalid_grant");
  assert.equal(apres.status, 401);
});

test("les jetons ne sont gardés qu'en empreinte", async () => {
  const jetons = (await (await seConnecter())[1].json()) as Jetons;
  const contenu = readFileSync(comptoir.autorisation);
  assert.ok(!contenu.includes(jetons.access_token) && !contenu.includes(jetons.refresh_token));
  assert.ok(contenu.includes(createHash("sha256").update(jetons.access_token).digest("hex")));
});

/** Une requête avec un en-tête Host choisi, que fetch ne permet pas de changer. */
function avecHote(hote: string, entetes: Record<string, string>): Promise<number> {
  return new Promise((ok, echec) => {
    const corps = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = requeteHttp({ host: "127.0.0.1", port: comptoir.port, path: "/mcp", method: "POST", headers: { Host: hote, "Content-Type": "application/json", ...ACCEPTE, ...entetes } }, (reponse) => {
      reponse.resume();
      ok(reponse.statusCode!);
    });
    r.on("error", echec);
    r.end(corps);
  });
}

test("un hôte inconnu est refusé", async () => {
  // Sans jeton, la requête s'arrête au 401. Avec un jeton valide, c'est la liste des hôtes qui l'arrête : la
  // protection contre la réaffectation DNS ne dépend pas de l'authentification.
  const acces = ((await (await seConnecter())[1].json()) as Jetons).access_token;
  assert.equal(await avecHote("comptoir.exemple.invalid", {}), 401);
  assert.equal(await avecHote("comptoir.exemple.invalid", { Authorization: `Bearer ${acces}` }), 421);
  assert.equal(await avecHote(`localhost:${comptoir.port}`, { Authorization: `Bearer ${acces}`, Origin: "https://ailleurs.invalid" }), 403);
});

test("la page de santé ne dit que l'état et la version", async () => {
  const sante = await appeler("/sante");
  assert.deepEqual([sante.status, await sante.text()], [200, '{"etat":"ok","version":"0.1.0"}']);
});

async function enMemoire(capacites = {}, formulaire?: (question: string) => ElicitResult): Promise<Client> {
  const [cote, autre] = InMemoryTransport.createLinkedPair();
  await construire().connect(cote);
  const client = new Client({ name: "tests", version: "1.0.0" }, { capabilities: capacites });
  if (formulaire) client.setRequestHandler(ElicitRequestSchema, async (r) => formulaire(r.params.message));
  await client.connect(autre);
  return client;
}

test("le serveur en ligne reprend le serveur de bureau", async () => {
  const [cote, autre] = InMemoryTransport.createLinkedPair();
  await creerServeur().connect(cote);
  const bureau = new Client({ name: "tests", version: "1.0.0" });
  await bureau.connect(autre);
  const enLigne = await enMemoire();
  const outilsDuBureau = (await bureau.listTools()).tools;
  const parNom = new Map((await enLigne.listTools()).tools.map((t) => [t.name, t]));
  const prompts = (await enLigne.listPrompts()).prompts.map((p) => p.name);
  const gabarits = (await enLigne.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  await Promise.all([bureau.close(), enLigne.close()]);
  for (const t of outilsDuBureau) {
    const { _meta: m1, outputSchema: _s1, ...a } = parNom.get(t.name)!;
    const { _meta: m2, outputSchema: _s2, ...b } = t;
    assert.deepEqual(a, b);
    assert.equal(m1?.["anthropic/requiresUserInteraction"], m2?.["anthropic/requiresUserInteraction"]);
  }
  assert.deepEqual([prompts, gabarits], [["bilan_du_soir", "inventaire"], ["comptoir://commande/{numero}"]]);
});

test("le rapport signale sa progression", sansBase(), async () => {
  const client = await enMemoire();
  const rapports: [number, number | undefined, string | undefined][] = [];
  const resultat = (await client.callTool({ name: "rapport_de_la_semaine", arguments: { un_jour_de_la_semaine: "2026-10-14" } }, undefined, { onprogress: (p) => void rapports.push([p.progress, p.total, p.message]) }))
    .structuredContent as { ventes: { total_fcfa: number }; par_jour: { total_fcfa: number }[] };
  await client.close();
  assert.deepEqual(rapports.map(([f]) => f), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(rapports.at(-1)![2] === "Rapport prêt" && rapports[0]![2]!.startsWith("lundi 12 octobre 2026 : "));
  assert.equal(resultat.ventes.total_fcfa, resultat.par_jour.reduce((t, j) => t + j.total_fcfa, 0));
});

const stockBissap = (): number => {
  const db = new DatabaseSync(comptoir.boutique, { readOnly: true });
  try {
    return (db.prepare("SELECT quantite FROM stock WHERE produit = 'Jus de bissap'").get() as { quantite: number }).quantite;
  } finally {
    db.close();
  }
};

for (const [reponse, attendu, message] of [
  [{ action: "accept", content: { confirme: true } }, 32, null],
  [{ action: "accept", content: { confirme: false } }, 40, "Awa n'a pas coché la confirmation : le stock n'a pas changé."],
  [{ action: "decline" }, 40, "Correction refusée par Awa : le stock n'a pas changé."],
  [{ action: "cancel" }, 40, "Correction annulée par Awa : le stock n'a pas changé."],
] as [ElicitResult, number, string | null][]) {
  test(`la correction demande confirmation au client qui sait le faire (${reponse.action}${reponse.content ? ` ${reponse.content.confirme}` : ""})`, sansBase(), async () => {
    const questions: string[] = [];
    const client = await enMemoire({ elicitation: { form: {} } }, (question) => (questions.push(question), reponse));
    const projet = (await client.callTool({ name: "preparer_correction", arguments: { produit: "Jus de bissap", quantite_comptee: 32 } })).structuredContent as { jeton: string };
    const resultat = (await client.callTool({ name: "appliquer_correction", arguments: { jeton: projet.jeton } })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    assert.deepEqual(questions, ["Corriger le stock de Jus de bissap : 40 → 32 ?"]);
    assert.equal(Boolean(resultat.isError), attendu === 40);
    if (message) assert.equal(resultat.content[0]!.text, `Error executing tool appliquer_correction: ${message}`);
    assert.equal(stockBissap(), attendu);
  });
}

test("sans formulaire possible, le jeton suffit", sansBase(), async () => {
  const client = await enMemoire(); // aucune capacité de formulaire : comme l'application Claude
  const projet = (await client.callTool({ name: "preparer_correction", arguments: { produit: "Jus de bissap", quantite_comptee: 32 } })).structuredContent as { jeton: string };
  const fait = (await client.callTool({ name: "appliquer_correction", arguments: { jeton: projet.jeton } })).structuredContent as { apres: number };
  await client.close();
  assert.equal(fait.apres, 32);
});

test("en HTTP sans état, un client qui sait afficher un formulaire n'en reçoit pas : le jeton suffit", sansBase(), async () => {
  // La troisième ligne du tableau du chapitre : sans session, ses capacités ne parviennent pas au serveur.
  const acces = ((await (await seConnecter())[1].json()) as Jetons).access_token;
  const [client] = await clientMcp(acces, { elicitation: { form: {} } });
  let questions = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => (questions++, { action: "decline" }));
  try {
    const projet = (await client.callTool({ name: "preparer_correction", arguments: { produit: "Jus de bissap", quantite_comptee: 32 } })).structuredContent as { jeton: string };
    const fait = (await client.callTool({ name: "appliquer_correction", arguments: { jeton: projet.jeton } })).structuredContent as { apres: number };
    assert.deepEqual([questions, fait.apres, stockBissap()], [0, 32, 32]);
  } finally {
    await client.close();
  }
});

test("deconnecterTout révoque chaque jeton valide", async () => {
  const acces = ((await (await seConnecter())[1].json()) as Jetons).access_token;
  assert.equal(comptoir.fournisseur.deconnecterTout(), 2); // l'accès et le renouvellement
  const apres = await appeler("/mcp", { method: "POST", headers: { ...ACCEPTE, "Content-Type": "application/json", Authorization: `Bearer ${acces}` }, body: "{}" });
  assert.equal(apres.status, 401);
});

test("le hachage du mot de passe", () => {
  const h = hacher(MOT_DE_PASSE, Buffer.alloc(16, 7));
  assert.ok(h.startsWith("scrypt:16384:8:1:BwcHBwcHBwcHBwcHBwcHBw:"));
  assert.ok(verifierMotDePasse(MOT_DE_PASSE, h) && !verifierMotDePasse("autre", h));
  assert.ok(!verifierMotDePasse(MOT_DE_PASSE, "scrypt:16384:8:1:sel") && !verifierMotDePasse(MOT_DE_PASSE, "n:importe:quoi:ici:et:la"));
});

// --- Le même serveur que la version Python -------------------------------------------------------

const sansPython = (): { skip: string } | Record<string, never> => (PYTHON_VENV ? {} : { skip: "environnement Python absent" });
const T0 = new Date("2026-10-21T07:00:00Z");

/** Le serveur en ligne de la version Python, en mémoire, comme le construisent ses tests. */
const PREAMBULE_PYTHON = `
import tempfile
from pathlib import Path
from ch16 import serveur_en_ligne
from ch16.autorisation import hacher
application = serveur_en_ligne.application("http://localhost:8016", str(Path(tempfile.mkdtemp()) / "auth.sqlite3"), hacher("${MOT_DE_PASSE}"))
serveur = application.state.serveur`;

const python = (script: string, entree: unknown, env: Record<string, string> = {}): any =>
  JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(entree), encoding: "utf8", stdio: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env } }));

test("le même serveur que la version Python : annonce, outils, ressources et prompts", sansPython(), async () => {
  const c = await enMemoire();
  const ts = await annonceTypeScript(c);
  await c.close();
  assert.deepEqual(ts, annoncePython(PYTHON_VENV!, PREAMBULE_PYTHON, "serveur"));
});

test("les mêmes réponses que la version Python : rapport, progression, formulaire de confirmation", sansPython(), async () => {
  horloge.maintenant = () => T0;
  // [outil, arguments, réponse au formulaire s'il est posé]. Les jetons sont tirés au hasard : le n-ième rendu
  // remplace JETON-n, des deux côtés.
  const appels: [string, Record<string, unknown>, ElicitResult | null][] = [
    ["rapport_de_la_semaine", { un_jour_de_la_semaine: "2026-10-14" }, null],
    ["rapport_de_la_semaine", {}, null],
    ["rapport_de_la_semaine", { un_jour_de_la_semaine: "2026-07-20" }, null],
    ["preparer_correction", { produit: "Jus de bissap", quantite_comptee: 32 }, null],
    ["appliquer_correction", { jeton: "JETON-0" }, { action: "accept", content: { confirme: true } }],
    ["preparer_correction", { produit: "Jus d'ananas", quantite_comptee: 10 }, null],
    ["appliquer_correction", { jeton: "JETON-1" }, { action: "accept", content: { confirme: false } }],
    ["preparer_correction", { produit: "Jus de bissap", quantite_comptee: 30 }, null],
    ["appliquer_correction", { jeton: "JETON-2" }, { action: "decline" }],
    ["preparer_correction", { produit: "Jus de bissap", quantite_comptee: 29 }, null],
    ["appliquer_correction", { jeton: "JETON-3" }, { action: "cancel" }],
    ["appliquer_correction", { jeton: "inconnu" }, null],
  ];
  const demandes: unknown[] = [];
  let prochaine: ElicitResult | null = null;
  const client = await enMemoire({ elicitation: { form: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => (demandes.push(JSON.parse(JSON.stringify(r.params))), prochaine!));
  const jetons: string[] = [];
  const ts: unknown[] = [];
  for (const [nom, args, reponse] of appels) {
    prochaine = reponse;
    const reels = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.startsWith("JETON-") ? jetons[Number(v.slice(6))] : v]));
    const progression: unknown[] = [];
    const r = (await client.callTool({ name: nom, arguments: reels }, undefined, { onprogress: (p) => void progression.push([p.progress, p.total, p.message]) })) as {
      structuredContent?: Record<string, unknown>;
      content: { text: string }[];
      isError?: boolean;
    };
    if (r.structuredContent?.jeton) jetons.push(String(r.structuredContent.jeton));
    ts.push(r.isError ? { erreur: r.content[0]!.text } : { sortie: r.structuredContent, texte: r.content[0]!.text, progression });
  }
  await client.close();
  const sansFormulaire = await enMemoire();
  const projet = (await sansFormulaire.callTool({ name: "preparer_correction", arguments: { produit: "Jus d'ananas", quantite_comptee: 11 } })).structuredContent as { jeton: string };
  jetons.push(String(projet.jeton));
  ts.push((await sansFormulaire.callTool({ name: "appliquer_correction", arguments: { jeton: projet.jeton } })).structuredContent);
  await sansFormulaire.close();
  const db = new DatabaseSync(comptoir.boutique, { readOnly: true });
  const stock = db.prepare("SELECT produit, quantite FROM stock WHERE produit IN ('Jus de bissap', 'Jus d''ananas') ORDER BY produit").all().map((l) => ({ ...l }));
  db.close();

  const copie = join(mkdtempSync(join(tmpdir(), "comptoir-en-ligne-python-")), "boutique.sqlite3");
  copyFileSync(modele!, copie);
  const py = python(
    `
import asyncio, json, os, sqlite3, sys
from datetime import datetime, timezone
from mcp import Client
from mcp.types import ElicitResult
${PREAMBULE_PYTHON}
from ch15 import comptoir_pour_awa as awa
awa._maintenant = lambda: datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)
appels = json.load(sys.stdin)
async def main():
    sorties, jetons, demandes, prochaine = [], [], [], [None]
    async def formulaire(_contexte, params):
        demandes.append(params.model_dump(mode="json", by_alias=True, exclude_none=True))
        return ElicitResult(**prochaine[0])
    async with Client(serveur, elicitation_callback=formulaire) as c:
        for nom, args, reponse in appels:
            prochaine[0] = reponse
            args = {k: (jetons[int(v[6:])] if isinstance(v, str) and v.startswith("JETON-") else v) for k, v in args.items()}
            progression = []
            async def noter(fait, total, message):
                progression.append([fait, total, message])
            r = await c.call_tool(nom, args, progress_callback=noter)
            if r.structured_content and r.structured_content.get("jeton"):
                jetons.append(r.structured_content["jeton"])
            sorties.append({"erreur": r.content[0].text} if r.is_error else {"sortie": r.structured_content, "texte": r.content[0].text, "progression": progression})
    async with Client(serveur) as c:
        projet = (await c.call_tool("preparer_correction", {"produit": "Jus d'ananas", "quantite_comptee": 11})).structured_content
        jetons.append(projet["jeton"])
        sorties.append((await c.call_tool("appliquer_correction", {"jeton": projet["jeton"]})).structured_content)
    db = sqlite3.connect(os.environ["COMPTOIR_BOUTIQUE"])
    db.row_factory = sqlite3.Row
    stock = [dict(l) for l in db.execute("SELECT produit, quantite FROM stock WHERE produit IN ('Jus de bissap', 'Jus d''ananas') ORDER BY produit")]
    print(json.dumps({"appels": sorties, "demandes": demandes, "stock": stock, "jetons": jetons}, ensure_ascii=False))
asyncio.run(main())`,
    appels,
    { COMPTOIR_BOUTIQUE: copie, COMPTOIR_AUJOURDHUI: "2026-10-17" },
  );
  const masquer = (valeur: unknown, liste: string[]): unknown => JSON.parse(liste.reduce((t, j, i) => t.replaceAll(j, `JETON-${i}`), JSON.stringify(valeur)));
  // Un refus et une annulation : le message de l'outil, dans les deux versions (corrigé côté Python le 23 octobre
  // 2026 ; son SDK arrêtait l'appel avant l'outil, avec son propre message).
  assert.deepEqual([ts[8], ts[10]], [
    { erreur: "Error executing tool appliquer_correction: Correction refusée par Awa : le stock n'a pas changé." },
    { erreur: "Error executing tool appliquer_correction: Correction annulée par Awa : le stock n'a pas changé." },
  ]);
  assert.deepEqual(masquer({ appels: ts, demandes, stock }, jetons), masquer({ appels: py.appels, demandes: py.demandes, stock: py.stock }, py.jetons));
});

// Le même parcours HTTP, joué contre les deux serveurs : celui-ci sur son port, celui de la version Python en
// mémoire (ASGI, comme ses tests). Les variables (« {client} ») prennent les valeurs des réponses précédentes.
interface Etape {
  nom: string;
  methode: string;
  chemin: string;
  json?: unknown;
  formulaire?: Record<string, string>;
  texte?: string;
  requete?: Record<string, string>;
  entetes?: Record<string, string>;
  hote?: string;
  garder?: Record<string, string>;
}

const PARCOURS: Etape[] = [
  { nom: "sans jeton", methode: "POST", chemin: "/mcp", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { nom: "ressource protégée", methode: "GET", chemin: "/.well-known/oauth-protected-resource/mcp" },
  { nom: "serveur d'autorisation", methode: "GET", chemin: "/.well-known/oauth-authorization-server" },
  { nom: "retour étranger", methode: "POST", chemin: "/register", json: { client_name: "Tests", redirect_uris: ["https://exemple.invalid/vol"], token_endpoint_auth_method: "none", scope: "comptoir" } },
  { nom: "portée étrangère", methode: "POST", chemin: "/register", json: { client_name: "Tests", redirect_uris: ["http://localhost:3030/callback"], token_endpoint_auth_method: "none", scope: "comptoir admin" } },
  { nom: "retour Claude", methode: "POST", chemin: "/register", json: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" } },
  { nom: "enregistrer", methode: "POST", chemin: "/register", json: { client_name: "Tests <&>", redirect_uris: ["http://localhost:3030/callback"], token_endpoint_auth_method: "none", scope: "comptoir" }, garder: { client: "json:client_id" } },
  { nom: "autoriser", methode: "GET", chemin: "/authorize", requete: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:3030/callback", code_challenge: "{defi}", code_challenge_method: "S256", state: "etat-42", scope: "comptoir", resource: "{url}/mcp" }, garder: { page: "location" } },
  { nom: "page", methode: "GET", chemin: "{page}" },
  { nom: "mot de passe faux", methode: "POST", chemin: "{page}", formulaire: { mot_de_passe: "faux", decision: "autoriser" } },
  { nom: "autre port", methode: "GET", chemin: "/authorize", requete: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:51234/callback", code_challenge: "{defi}", code_challenge_method: "S256", state: "etat-43", scope: "comptoir" }, garder: { page2: "location" } },
  { nom: "refuser", methode: "POST", chemin: "{page2}", formulaire: { decision: "refuser" } },
  { nom: "autre chemin", methode: "GET", chemin: "/authorize", requete: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:51234/ailleurs", code_challenge: "{defi}", code_challenge_method: "S256", state: "etat-44" } },
  { nom: "ressource étrangère", methode: "GET", chemin: "/authorize", requete: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:3030/callback", code_challenge: "{defi}", code_challenge_method: "S256", state: "etat-45", resource: "https://autre.invalid/mcp" } },
  { nom: "portée non enregistrée", methode: "GET", chemin: "/authorize", requete: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:3030/callback", code_challenge: "{defi}", code_challenge_method: "S256", state: "etat-46", scope: "admin" } },
  { nom: "client inconnu", methode: "GET", chemin: "/authorize", requete: { response_type: "code", client_id: "inconnu", redirect_uri: "http://localhost:3030/callback", code_challenge: "{defi}", code_challenge_method: "S256" } },
  { nom: "mot de passe juste", methode: "POST", chemin: "{page}", formulaire: { mot_de_passe: "mot-de-passe-des-tests-16", decision: "autoriser" }, garder: { retour: "location" } },
  { nom: "formulaire renvoyé", methode: "POST", chemin: "{page}", formulaire: { mot_de_passe: "mot-de-passe-des-tests-16", decision: "autoriser" } },
  { nom: "demande inconnue", methode: "GET", chemin: "/connexion?demande=inconnue" },
  { nom: "mauvais vérificateur", methode: "POST", chemin: "/token", formulaire: { grant_type: "authorization_code", code: "{retour.code}", redirect_uri: "http://localhost:3030/callback", client_id: "{client}", code_verifier: "un-autre-verificateur-un-autre-verificateur-0123456789" } },
  { nom: "sans adresse de retour", methode: "POST", chemin: "/token", formulaire: { grant_type: "authorization_code", code: "{retour.code}", client_id: "{client}", code_verifier: "{verificateur}" } },
  { nom: "jeton", methode: "POST", chemin: "/token", formulaire: { grant_type: "authorization_code", code: "{retour.code}", redirect_uri: "http://localhost:3030/callback", client_id: "{client}", code_verifier: "{verificateur}", resource: "{url}/mcp" }, garder: { acces: "json:access_token", renouvellement: "json:refresh_token" } },
  { nom: "code réutilisé", methode: "POST", chemin: "/token", formulaire: { grant_type: "authorization_code", code: "{retour.code}", redirect_uri: "http://localhost:3030/callback", client_id: "{client}", code_verifier: "{verificateur}" } },
  { nom: "hôte inconnu sans jeton", methode: "POST", chemin: "/mcp", hote: "comptoir.exemple.invalid", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { nom: "hôte inconnu", methode: "POST", chemin: "/mcp", hote: "comptoir.exemple.invalid", entetes: { Authorization: "Bearer {acces}" }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { nom: "origine inconnue", methode: "POST", chemin: "/mcp", entetes: { Authorization: "Bearer {acces}", Origin: "https://ailleurs.invalid" }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { nom: "mauvais type", methode: "POST", chemin: "/mcp", entetes: { Authorization: "Bearer {acces}", "Content-Type": "text/plain" }, texte: "{}" },
  { nom: "portée de renouvellement", methode: "POST", chemin: "/token", formulaire: { grant_type: "refresh_token", client_id: "{client}", refresh_token: "{renouvellement}", scope: "admin" } },
  { nom: "renouveler", methode: "POST", chemin: "/token", formulaire: { grant_type: "refresh_token", client_id: "{client}", refresh_token: "{renouvellement}" }, garder: { acces2: "json:access_token" } },
  { nom: "renouvellement volé", methode: "POST", chemin: "/token", formulaire: { grant_type: "refresh_token", client_id: "{client}", refresh_token: "{renouvellement}" } },
  { nom: "après le vol", methode: "POST", chemin: "/mcp", entetes: { Authorization: "Bearer {acces2}" }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { nom: "santé", methode: "GET", chemin: "/sante" },
];

const VERIFICATEUR = "verificateur-des-essais-du-chapitre-16-0123456789abcdef";
const ENTETES_GARDES = ["location", "content-type", "cache-control", "x-frame-options", "content-security-policy", "www-authenticate"];
type Reponse = { nom: string; statut: number; entetes: Record<string, string>; corps: string };

async function jouer(etapes: Etape[], variables: Record<string, string>): Promise<Reponse[]> {
  const remplir = <T>(v: T): T => {
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remplir(x)])) as T;
    if (typeof v !== "string") return v;
    return v.replace(/\{([a-z0-9]+)(?:\.([a-z_]+))?\}/g, (_, nom: string, champ?: string) => (champ ? new URL(variables[nom]!).searchParams.get(champ)! : variables[nom]!)) as T;
  };
  const sortie: Reponse[] = [];
  for (const e of etapes) {
    const entetes: Record<string, string> = e.chemin === "/mcp" ? { ...ACCEPTE } : {};
    let corps: string | undefined;
    if (e.json) [corps, entetes["Content-Type"]] = [JSON.stringify(e.json), "application/json"];
    if (e.formulaire) [corps, entetes["Content-Type"]] = [new URLSearchParams(remplir(e.formulaire)).toString(), "application/x-www-form-urlencoded"];
    if (e.texte !== undefined) corps = e.texte;
    Object.assign(entetes, remplir(e.entetes ?? {}), { Host: e.hote ?? `localhost:${comptoir.port}` });
    const cible = new URL(remplir(e.chemin), comptoir.url);
    for (const [k, v] of Object.entries(remplir(e.requete ?? {}))) cible.searchParams.append(k, v);
    const r = await new Promise<Reponse>((ok, echec) => {
      const q = requeteHttp({ host: "127.0.0.1", port: comptoir.port, path: cible.pathname + cible.search, method: e.methode, headers: entetes }, (rep) => {
        const morceaux: Buffer[] = [];
        rep.on("data", (m: Buffer) => morceaux.push(m));
        rep.on("end", () => {
          const gardes = Object.fromEntries(ENTETES_GARDES.filter((k) => k in rep.headers).map((k) => [k, String(rep.headers[k])]));
          ok({ nom: e.nom, statut: rep.statusCode!, entetes: gardes, corps: Buffer.concat(morceaux).toString("utf8") });
        });
      });
      q.on("error", echec);
      q.end(corps);
    });
    sortie.push(r);
    for (const [nom, source] of Object.entries(e.garder ?? {})) variables[nom] = source === "location" ? r.entetes.location! : (JSON.parse(r.corps) as Record<string, string>)[source.slice(5)]!;
  }
  return sortie;
}

/** Les textes d'erreur que chaque SDK écrit lui-même, et non le fournisseur d'Awa : ils diffèrent. */
const TEXTES_DES_SDK = new Set(["sans jeton", "hôte inconnu sans jeton", "après le vol", "autre chemin", "client inconnu", "mauvais vérificateur"]);

/**
 * Ce qui doit être identique d'un serveur à l'autre : le statut, la redirection, la page (et ses en-têtes de
 * sécurité), le texte d'un refus du transport, le code d'erreur OAuth. Les valeurs tirées au hasard sont
 * masquées ; l'émetteur est comparé sans sa barre finale (le SDK TypeScript l'annonce avec, URL.href).
 */
function comparable(reponses: Reponse[], variables: Record<string, string>): unknown[] {
  const url = variables.url!;
  const hasards = Object.entries(variables).flatMap(([k, v]): [string, string][] => {
    if (["url", "verificateur", "defi"].includes(k)) return [];
    const brut = ["page", "page2", "retour"].includes(k) ? new URL(v).searchParams.get(k === "retour" ? "code" : "demande")! : v;
    return [[k, brut]];
  });
  const sous = (t: string): string => hasards.reduce((s, [k, v]) => s.replaceAll(v, `<${k}>`), t.replaceAll(url, "{url}").replaceAll(encodeURIComponent(url), "{url}"));
  return reponses.map((r) => {
    const sortie: Record<string, unknown> = { nom: r.nom, statut: r.statut };
    if (r.entetes.location) {
      const u = new URL(sous(r.entetes.location).replace("{url}", "http://comptoir"));
      const requete = Object.fromEntries([...u.searchParams].sort().map(([k, v]) => [k, k === "iss" ? v.replace(/\/$/, "") : v]));
      sortie.location = { adresse: u.origin + u.pathname, requete };
    }
    const type = (r.entetes["content-type"] ?? "").split(";")[0];
    if (type === "text/html") Object.assign(sortie, { page: sous(r.corps), ...Object.fromEntries(["cache-control", "x-frame-options", "content-security-policy"].map((k) => [k, r.entetes[k]])) });
    else if (r.statut >= 400 && type === "application/json") {
      const { error, error_description } = JSON.parse(r.corps) as { error: string; error_description: string };
      sortie.erreur = TEXTES_DES_SDK.has(r.nom) ? (r.nom === "client inconnu" ? "(code propre à chaque SDK)" : error) : [error, sous(error_description)];
    } else if (r.statut >= 400) sortie.texte = r.corps;
    else if (type === "application/json") {
      const corps = JSON.parse(sous(r.corps)) as Record<string, unknown>;
      const garder = (cles: string[]): Record<string, unknown> => Object.fromEntries(cles.filter((k) => k in corps).map((k) => [k, corps[k]]));
      if ("access_token" in corps) sortie.corps = { ...garder(["token_type", "expires_in", "scope"]), access_token: /^<acces2?>$/.test(String(corps.access_token)) };
      else if ("issuer" in corps) {
        const champs = ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint", "scopes_supported", "response_types_supported", "grant_types_supported", "code_challenge_methods_supported"];
        sortie.corps = { ...garder(champs), issuer: String(corps.issuer).replace(/\/$/, "") };
      } else if ("resource" in corps) sortie.corps = { ...garder(["resource", "scopes_supported"]), authorization_servers: (corps.authorization_servers as string[]).map((s) => s.replace(/\/$/, "")) };
      else if ("redirect_uris" in corps) sortie.corps = garder(["client_name", "redirect_uris", "token_endpoint_auth_method", "scope"]);
      else sortie.corps = corps;
    }
    return sortie;
  });
}

test("le même parcours OAuth que la version Python, réponse par réponse", sansPython(), async () => {
  const defi = createHash("sha256").update(VERIFICATEUR).digest("base64url");
  const variablesTs: Record<string, string> = { url: comptoir.url, verificateur: VERIFICATEUR, defi };
  const ts = comparable(await jouer(PARCOURS, variablesTs), variablesTs);
  const py = python(
    `
import asyncio, json, re, sys
from urllib.parse import parse_qs, urlsplit
import httpx2
${PREAMBULE_PYTHON}
entree = json.load(sys.stdin)
variables = {"url": "http://localhost:8016", **entree["variables"]}
GARDES = ${JSON.stringify(ENTETES_GARDES)}
def remplir(v):
    if isinstance(v, dict):
        return {k: remplir(x) for k, x in v.items()}
    if not isinstance(v, str):
        return v
    def un(m):
        valeur = variables[m.group(1)]
        return parse_qs(urlsplit(valeur).query)[m.group(2)][0] if m.group(2) else valeur
    return re.sub(r"\\{([a-z0-9]+)(?:\\.([a-z_]+))?\\}", un, v)
async def main():
    sortie = []
    async with application.router.lifespan_context(application):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=application), base_url=variables["url"]) as http:
            for e in entree["etapes"]:
                entetes = {"Accept": "application/json, text/event-stream"} if e["chemin"] == "/mcp" else {}
                entetes |= remplir(e.get("entetes", {}))
                if "hote" in e:
                    entetes["Host"] = e["hote"]
                options = {}
                if "json" in e: options["json"] = e["json"]
                if "formulaire" in e: options["data"] = remplir(e["formulaire"])
                if "texte" in e: options["content"] = e["texte"]
                if "requete" in e: options["params"] = remplir(e["requete"])
                r = await http.request(e["methode"], remplir(e["chemin"]), headers=entetes, **options)
                sortie.append({"nom": e["nom"], "statut": r.status_code, "entetes": {k: r.headers[k] for k in GARDES if k in r.headers}, "corps": r.text})
                for nom, source in e.get("garder", {}).items():
                    variables[nom] = r.headers["location"] if source == "location" else r.json()[source[5:]]
    print(json.dumps({"reponses": sortie, "variables": variables}, ensure_ascii=False))
asyncio.run(main())`,
    { variables: { verificateur: VERIFICATEUR, defi }, etapes: PARCOURS },
  );
  assert.deepEqual(ts, comparable(py.reponses, py.variables));
});

// --- Les scripts de Yao, contre les deux serveurs ----------------------------------------------------

/** Le navigateur simulé, qui compte les pages ouvertes. */
function compteur(): Navigateur & { pages: number } {
  const n = navigateurSimule(MOT_DE_PASSE);
  const c = { pages: 0, ouvrir: async (a: URL) => (c.pages++, n.ouvrir(a)), attendre: n.attendre };
  return c;
}

const stockageTemporaire = (): StockageFichier => new StockageFichier(join(mkdtempSync(join(tmpdir(), "jetons-")), "jetons_client.json"));

/** Une requête de client_brut : le message et les en-têtes du script, envoyés tels quels. */
async function brut(adresse: string, jeton: string, id: number, methode: string, params?: Record<string, unknown>, nom?: string, revision?: string) {
  const reponse = await fetch(adresse, { method: "POST", headers: entetesBrutes(jeton, methode, nom, revision), body: JSON.stringify(messageBrut(id, methode, params, revision)) });
  const texte = await reponse.text();
  const type = reponse.headers.get("content-type") ?? "";
  const donnees = type.startsWith("text/event-stream") ? texte.split(/\r?\n/).filter((l) => l.startsWith("data:")).at(-1)!.slice(5) : texte;
  return { statut: reponse.status, session: reponse.headers.get("mcp-session-id"), corps: JSON.parse(donnees) as { result?: Record<string, unknown>; error?: unknown } };
}

test("se_connecter : le parcours du SDK, puis une connexion silencieuse avec les jetons gardés", sansBase(), async () => {
  const stockage = stockageTemporaire();
  const premier = compteur();
  const [client, transport] = await connecterCommeYao(`${comptoir.url}/mcp`, new ConnexionOAuth(stockage, premier));
  const progression: number[] = [];
  const rapport = await client.callTool({ name: "rapport_de_la_semaine", arguments: { un_jour_de_la_semaine: "2026-10-14" } }, undefined, { onprogress: (p) => void progression.push(p.progress) });
  assert.deepEqual([premier.pages, transport.protocolVersion, client.getServerVersion()!.name], [1, "2025-11-25", "comptoir-pour-awa"]);
  assert.ok(String((rapport.structuredContent as { resume: string }).resume).includes("Meilleur jour"));
  assert.deepEqual(progression, [1, 2, 3, 4, 5, 6, 7, 8]); // les notifications passent par le flux de la réponse
  await client.close();
  const second = compteur();
  const [encore] = await connecterCommeYao(`${comptoir.url}/mcp`, new ConnexionOAuth(stockage, second));
  assert.equal((await encore.listTools()).tools.length, 6);
  await encore.close();
  assert.equal(second.pages, 0); // aucune page : le jeton du fichier suffit
});

test("client_brut : ce serveur parle la révision 2025-11-25, sans session, et refuse 2026-07-28", sansBase(), async () => {
  const acces = ((await (await seConnecter())[1].json()) as Jetons).access_token;
  const adresse = `${comptoir.url}/mcp`;
  const r = "2025-11-25";
  const accueil = await brut(adresse, acces, 1, "initialize", { protocolVersion: r, capabilities: {}, clientInfo: { name: "client-brut-de-yao", version: "0.1" } }, undefined, r);
  const outils = await brut(adresse, acces, 2, "tools/list", undefined, undefined, r);
  const stock = await brut(adresse, acces, 3, "tools/call", { name: "stock", arguments: {} }, "stock", r);
  assert.deepEqual([accueil.statut, accueil.session, (accueil.corps.result!.serverInfo as { name: string }).name], [200, null, "comptoir-pour-awa"]);
  assert.equal((outils.corps.result!.tools as unknown[]).length, 6);
  assert.ok(String((stock.corps.result!.structuredContent as { resume: string }).resume).startsWith("En rupture"));
  assert.equal((await brut(adresse, acces, 4, "server/discover")).statut, 400);
});

async function portLibre(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise((ok) => s.close(ok));
  return port;
}

test("les scripts de Yao contre le serveur de la version Python, lancé par uvicorn sur cet ordinateur", sansPython(), async () => {
  const port = await portLibre();
  const url = `http://localhost:${port}`;
  const dossier = mkdtempSync(join(tmpdir(), "comptoir-python-"));
  copyFileSync(modele!, join(dossier, "boutique.sqlite3"));
  const env = {
    ...process.env,
    COMPTOIR_URL_PUBLIQUE: url,
    COMPTOIR_BOUTIQUE: join(dossier, "boutique.sqlite3"),
    COMPTOIR_AUJOURDHUI: "2026-10-17",
    COMPTOIR_AUTORISATION: join(dossier, "auth.sqlite3"),
    COMPTOIR_MOT_DE_PASSE_HACHE: hacher(MOT_DE_PASSE), // haché par la version TypeScript, vérifié par la version Python
  };
  const uvicorn = spawn(PYTHON_VENV!, ["-m", "uvicorn", "ch16.serveur_en_ligne:app", "--port", String(port)], { cwd: PYTHON, env, stdio: "ignore" });
  try {
    for (let i = 0; !(await fetch(`${url}/sante`).then((r) => r.ok, () => false)); i++) {
      if (i > 150) throw new Error("le serveur Python ne répond pas");
      await new Promise((ok) => setTimeout(ok, 200));
    }
    const stockage = stockageTemporaire();
    const navigateur = compteur();
    const [client, transport] = await connecterCommeYao(`${url}/mcp`, new ConnexionOAuth(stockage, navigateur));
    const projet = (await client.callTool({ name: "preparer_correction", arguments: { produit: "Jus de bissap", quantite_comptee: 32 } })).structuredContent as { jeton: string };
    const fait = (await client.callTool({ name: "appliquer_correction", arguments: { jeton: projet.jeton } })).structuredContent as { apres: number };
    await client.close();
    // L'émetteur rendu avec le code (sans barre finale) est celui des métadonnées du serveur Python : vérifié.
    assert.deepEqual([navigateur.pages, transport.protocolVersion, fait.apres], [1, "2025-11-25", 32]);
    const acces = (stockage.jetons() as { access_token: string }).access_token;
    const decouverte = await brut(`${url}/mcp`, acces, 1, "server/discover");
    const outils = await brut(`${url}/mcp`, acces, 2, "tools/list");
    const stock = await brut(`${url}/mcp`, acces, 3, "tools/call", { name: "stock", arguments: {} }, "stock");
    assert.deepEqual([decouverte.statut, decouverte.session, outils.statut, (outils.corps.result!.tools as unknown[]).length], [200, null, 200, 6]);
    assert.ok(String((stock.corps.result!.structuredContent as { resume: string }).resume).startsWith("En rupture"));
  } finally {
    uvicorn.kill();
  }
});

test("demander_par_l_api : la même requête que la version Python, liste noire comprise", sansPython(), () => {
  const adresse = "https://comptoir.exemple.invalid/mcp";
  const script = ["import json, sys", "from ch16.demander_par_l_api import requete", "print(json.dumps(requete(*json.load(sys.stdin)), ensure_ascii=False))"];
  const py = python(script.join("\n"), [adresse, "jeton-fictif"]);
  assert.deepEqual(requeteParLApi(adresse, "jeton-fictif"), py);
});
