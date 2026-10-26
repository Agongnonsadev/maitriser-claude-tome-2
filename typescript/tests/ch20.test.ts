// Chapitre 20 : les hooks, les Skills, les sous-agents et le workflow de la version TypeScript. Aucun appel à
// l'API : les hooks tournent sur des événements fabriqués, dans des dépôts Git temporaires. Les tests de
// python/tests/test_ch20.py, pour la configuration de ce dossier (.claude/, CLAUDE.md).

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { RACINE } from "../comptoir/lancement.ts";

const HOOKS = join(RACINE, ".claude", "hooks");
const DEPOT = join(RACINE, ".."); // tome-2/code, le futur dépôt d'accompagnement
// Une clé au format réel, construite à l'exécution : écrite d'un bloc ici, elle bloquerait le commit de ce fichier.
const CLE = "sk-ant-" + "api03-" + "Zx9".repeat(12);

/** Le hook, lancé comme Claude Code le lance (par Node seul, sans tsx), sur un événement fabriqué. */
function hook(nom: string, evenement: object, racine = RACINE, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(HOOKS, `${nom}.ts`)], {
    input: JSON.stringify(evenement), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: racine, ...env },
  });
}

function decision(r: SpawnSyncReturns<string>): [string, string] | null {
  const sortie = r.stdout.trim();
  if (!sortie) return null;
  const d = JSON.parse(sortie).hookSpecificOutput;
  return [d.permissionDecision, d.permissionDecisionReason];
}

const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

function depotGit(): string {
  const dossier = mkdtempSync(join(tmpdir(), "ch20-"));
  for (const args of [["init", "-q"], ["config", "user.email", "yao@exemple.test"], ["config", "user.name", "Yao"], ["config", "core.autocrlf", "false"]]) git(dossier, ...args);
  writeFileSync(join(dossier, "comptoir.ts"), "export const total = (): number => 1;\n", "utf8");
  git(dossier, "add", "-A");
  git(dossier, "commit", "-q", "-m", "départ");
  return dossier;
}

const commit = (depot: string, commande = "git commit -m essai"): SpawnSyncReturns<string> =>
  hook("garde_secrets", { tool_name: "Bash", tool_input: { command: commande }, cwd: depot });

// --- Le garde des fichiers -----------------------------------------------------------------------------

test("une version publiée de prompt ne se modifie pas, mais la suivante s'écrit", () => {
  // Les prompts sont communs aux deux versions : ils vivent dans ../python/comptoir/prompts.
  const existante = { tool_name: "Edit", tool_input: { file_path: join(RACINE, "..", "python", "comptoir", "prompts", "systeme_v5.md"), old_string: "a", new_string: "b" } };
  const [nature, raison] = decision(hook("garde_fichiers", existante))!;
  assert.ok(nature === "deny" && raison.includes("systeme_v6.md"), raison);
  const neuve = { tool_name: "Write", tool_input: { file_path: join(RACINE, "..", "python", "comptoir", "prompts", "systeme_v99.md"), content: "Nouvelle version" } };
  assert.equal(decision(hook("garde_fichiers", neuve)), null);
});

test("un test n'appelle jamais l'API", () => {
  const cas: [string, boolean][] = [
    ["const client = new Anthropic();", true],
    ["const client = creerClient();", true],
    ['new Anthropic({ apiKey: "x", baseURL: "https://api.anthropic.com" })', true],
    ["new Anthropic({ apiKey: \"cle-factice\", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })", false], // un faux serveur local
    ['const client = new FauxClient(texte("Bonjour"));', false],
  ];
  for (const [contenu, refuse] of cas) {
    const evenement = { tool_name: "Write", tool_input: { file_path: join(RACINE, "tests", "nouveau.test.ts"), content: contenu } };
    const r = decision(hook("garde_fichiers", evenement));
    assert.equal(r !== null && r[0] === "deny", refuse, contenu);
    // Hors de tests/, le même code est permis : c'est le Comptoir.
    evenement.tool_input.file_path = join(RACINE, "comptoir", "appel.ts");
    assert.equal(decision(hook("garde_fichiers", evenement)), null, contenu);
  }
});

test("une modification des prix est confirmée par Yao", () => {
  const evenement = { tool_name: "Edit", tool_input: { file_path: join(RACINE, "comptoir", "couts.ts"), old_string: "0.1", new_string: "0.12" } };
  const [nature, raison] = decision(hook("garde_fichiers", evenement))!;
  assert.ok(nature === "ask" && raison.includes("source datée"));
});

// --- Le garde des secrets ------------------------------------------------------------------------------

test("une clé indexée bloque le commit, sans être recopiée", () => {
  const depot = depotGit();
  writeFileSync(join(depot, "reglages.ts"), `export const CLE = "${CLE}";\n`, "utf8");
  git(depot, "add", "reglages.ts");
  const r = commit(depot);
  assert.ok(r.status === 2 && r.stderr.includes("reglages.ts:1") && r.stderr.includes("clé d'API Anthropic"), r.stderr);
  assert.ok(!r.stderr.includes(CLE)); // le message montre le début, jamais la clé
});

test("un fichier .env bloque le commit, mais pas l'exemple", () => {
  const depot = depotGit();
  writeFileSync(join(depot, ".env.exemple"), "ANTHROPIC_API_KEY=remplacez-moi\n", "utf8");
  git(depot, "add", ".env.exemple");
  assert.equal(commit(depot).status, 0);
  writeFileSync(join(depot, ".env"), "ANTHROPIC_API_KEY=une-vraie-valeur-de-cle\n", "utf8");
  git(depot, "add", ".env");
  const r = commit(depot);
  assert.ok(r.status === 2 && r.stderr.includes("fichier de secrets"));
});

test("les fichiers que la commande ajoute elle-même sont lus", () => {
  const depot = depotGit();
  writeFileSync(join(depot, "notes.txt"), `ma cle : ${CLE}\n`, "utf8"); // pas encore indexé
  assert.equal(commit(depot, "git commit -m seul").status, 0); //        ce commit ne l'emporte pas
  assert.equal(commit(depot, "git add -A && git commit -m tout").status, 2);
  assert.equal(commit(depot, `git commit -m '${CLE}'`).status, 2); //   ni dans le message
});

test("le code ordinaire ne bloque rien", () => {
  for (const ligne of [
    'const TABLEAU_JETON = process.env.COMPTOIR_TABLEAU_JETON ?? "";', //       une lecture, pas une valeur
    'const [SECRET, VERIFICATION, SEL, JETON] = ["secret-de-test", "verif", "sel", "j"];', // valeurs de test
    'const r = await poster(s, charge, "un-autre-secret");', //                   un argument, pas une constante
    'regler({ ANTHROPIC_API_KEY: "sk-ant-cle-de-test" });', //                     pas le format d'une vraie clé
  ]) {
    const depot = depotGit();
    writeFileSync(join(depot, "module.ts"), ligne + "\n", "utf8");
    git(depot, "add", "module.ts");
    assert.equal(commit(depot).status, 0, ligne);
  }
});

test("une autre commande que git commit passe", () => {
  const depot = depotGit();
  writeFileSync(join(depot, "notes.txt"), `${CLE}\n`, "utf8");
  git(depot, "add", "notes.txt");
  assert.equal(commit(depot, "git status").status, 0);
});

// --- Le hook de fin de tour ----------------------------------------------------------------------------

const finDeTour = (depot: string, code: number): SpawnSyncReturns<string> =>
  hook("fin_de_tour", { hook_event_name: "Stop", stop_hook_active: false }, depot, {
    COMPTOIR_HOOK_TESTS: `"${process.execPath}" -e "console.log('1 failed'); process.exit(${code})"`,
  });

test("des tests rouges empêchent Claude de rendre la main", () => {
  const depot = depotGit();
  assert.equal(finDeTour(depot, 1).stdout, ""); //                rien n'a changé : pas de tests
  writeFileSync(join(depot, "comptoir.ts"), "export const total = (): number => 2;\n", "utf8");
  const sortie = JSON.parse(finDeTour(depot, 1).stdout);
  assert.ok(sortie.decision === "block" && sortie.reason.includes("1 failed"));
  assert.equal(finDeTour(depot, 0).stdout, ""); //                vert : l'empreinte est notée
  assert.equal(finDeTour(depot, 1).stdout, ""); //                même état : la suite ne repasse pas
  writeFileSync(join(depot, "nouveau.ts"), "export const x = 1;\n", "utf8");
  assert.equal(JSON.parse(finDeTour(depot, 1).stdout).decision, "block");
});

test("le journal des outils note la commande, mais jamais le contenu", () => {
  const dossier = mkdtempSync(join(tmpdir(), "ch20-"));
  hook("journal_outils", { session_id: "s1", tool_name: "Write", tool_input: { file_path: "notes.md", content: "un contenu privé" } }, dossier);
  hook("journal_outils", { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "452 passed" } }, dossier);
  const lignes = readFileSync(join(dossier, ".claude", "journal-outils.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lignes.map((l) => [l.outil, l.cible]), [["Write", "notes.md"], ["Bash", "npm test"]]);
  assert.ok(!JSON.stringify(lignes).includes("privé") && !JSON.stringify(lignes).includes("452"));
});

// --- La configuration : réglages, Skills, sous-agents --------------------------------------------------

/** Les champs simples de l'en-tête YAML d'un fichier Markdown (clé: valeur). */
function entete(chemin: string): Record<string, string> {
  const texte = readFileSync(chemin, "utf8").replace(/\r\n/g, "\n");
  assert.ok(texte.startsWith("---\n"), chemin);
  const bloc = texte.split("---\n")[1]!;
  return Object.fromEntries([...bloc.matchAll(/^([a-zA-Z-]+):\s*(.*)$/gm)].map((m) => [m[1], m[2]!.trim().replace(/^"|"$/g, "")]));
}

test("chaque hook des réglages pointe vers un script qui existe", () => {
  const reglages = JSON.parse(readFileSync(join(RACINE, ".claude", "settings.json"), "utf8"));
  const commandes = Object.values(reglages.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap((groupes) => groupes.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(commandes.length);
  for (const commande of commandes) {
    const nom = /lancer\.sh" (\w+)$/.exec(commande)![1]!;
    assert.ok(existsSync(join(HOOKS, `${nom}.ts`)), nom);
  }
  assert.ok(existsSync(join(HOOKS, "lancer.sh")));
  assert.ok(reglages.permissions.ask.includes("Bash(npx tsx ch*)")); // les scripts payants demandent toujours
});

test("les Skills et les sous-agents sont complets", () => {
  const dossierSkills = join(RACINE, ".claude", "skills");
  const skills = Object.fromEntries(readdirSync(dossierSkills).map((d) => [d, entete(join(dossierSkills, d, "SKILL.md"))]));
  const dossierAgents = join(RACINE, ".claude", "agents");
  const agents = Object.fromEntries(readdirSync(dossierAgents).filter((f) => f.endsWith(".md")).map((f) => [basename(f, ".md"), entete(join(dossierAgents, f))]));
  assert.deepEqual(new Set(Object.keys(skills)), new Set(["verify", "relecture", "nouvelle-variante", "non-regression"]));
  assert.ok(Object.values(skills).every((s) => s.description));
  // Les Skills qui coûtent, ou qui ont un effet, ne se lancent que sur demande.
  assert.equal(skills["non-regression"]!["disable-model-invocation"], "true");
  assert.equal(skills["nouvelle-variante"]!["disable-model-invocation"], "true");
  assert.ok(skills.relecture!.context === "fork" && skills.relecture!.agent! in agents);
  assert.ok(Object.values(agents).every((a) => a.name && a.description && a.tools));
  assert.ok(!agents.relecteur!.tools!.includes("Edit") && !agents.relecteur!.tools!.includes("Write"));
});

test("les règles par dossier visent des fichiers qui existent", () => {
  const dossier = join(RACINE, ".claude", "rules");
  for (const regle of readdirSync(dossier).filter((f) => f.endsWith(".md"))) {
    const motifs = [...readFileSync(join(dossier, regle), "utf8").matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]!);
    assert.ok(motifs.length, regle);
    for (const motif of motifs) assert.ok(globSync(motif, { cwd: RACINE }).length, `${regle} : ${motif}`);
  }
});

test("le workflow de la version TypeScript n'a aucun accès à Claude, et une durée maximale", () => {
  const tests = readFileSync(join(DEPOT, ".github", "workflows", "tests-typescript.yml"), "utf8");
  assert.ok(!tests.includes("secrets.") && !tests.includes("id-token") && !tests.toLowerCase().includes("anthropic"));
  assert.equal((tests.match(/timeout-minutes:/g) ?? []).length, 1);
  for (const etape of ["npm ci", "npm test", "npm run typecheck", "ch18/audit_code.ts"]) assert.ok(tests.includes(etape), etape);
});

test("CLAUDE.md dit les règles et les commandes de cette version", () => {
  const memoire = readFileSync(join(RACINE, "CLAUDE.md"), "utf8");
  for (const attendu of ["npm test", "npm run typecheck", "npx tsx", "ANTHROPIC_API_KEY", "/verify", "../python/"]) assert.ok(memoire.includes(attendu), attendu);
});
