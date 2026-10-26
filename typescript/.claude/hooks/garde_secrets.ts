// Chapitre 20 : aucun secret ne part dans un commit (hook PreToolUse, sur « git commit »).
//
// Avant que Claude lance un commit, le hook lit ce qui va être enregistré : les changements indexés, et
// aussi les fichiers modifiés ou nouveaux quand la commande les ajoute elle-même (git add … && git commit,
// git commit -a). Une clé d'API Anthropic, un jeton de Meta, une clé privée, un secret écrit en clair
// (MA_CLE_API=…, JETON = "…"), ou un fichier .env : le commit est bloqué (code 2), et Claude lit pourquoi.
// Les valeurs de démonstration (« remplacez-moi », « …-de-test », « factice ») passent.
//
// Les motifs sont ceux du hook de la version Python (python/.claude/hooks/garde_secrets.py), qui sert aussi
// dans le plugin garde-secrets (tome-2/code/outils-claude). Une clé qui a quitté la machine se change, même
// si le commit est annulé : il le rappelle. Un programme sans dépendance, lancé par Node seul.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Des noms en capitales : variables d'environnement et constantes. L'argument secret="…" d'un test n'en est pas.
const NOM_SECRET = String.raw`\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|JETON|PASSWORD|_SEL)[A-Z0-9_]*`;
const FACTICE = String.raw`(?![^"'\s]*(?:remplacez|exemple|example|test|factice|fausse|faux|fake|dummy|local|essai|xxxx))`;
const MOTIFS: [string, RegExp][] = [
  ["une clé d'API Anthropic", /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/],
  ["un jeton d'accès Meta", /\bEAA[A-Za-z0-9]{60,}/],
  ["une clé privée", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // NOM=valeur, seul sur sa ligne (fichier .env, shell), ou NOM = "valeur" (code) ; pas NOM = process.env…
  ["un secret écrit en clair", new RegExp(
    String.raw`^\s*(?:export\s+)?${NOM_SECRET}\s*=\s*${FACTICE}[^\s"'$<{#]{8,}\s*$` +
      String.raw`|\b${NOM_SECRET}\s*[=:]\s*["']${FACTICE}[^"'\s$<{]{8,}["']`,
  )],
];
// .env.exemple et .env.example ne contiennent que des valeurs factices : permis. Les autres .env, non.
const FICHIER_INTERDIT = /(?:^|\/)\.env(?:\.(?!exemple$|example$)[^/]+)?$|\.pem$|(?:^|\/)\.env\.txt$/;
const AJOUTE_LUI_MEME = /\bgit\s+add\b|\bgit\s+commit\b[^&|;]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b/;

// Pas de vérification du code de retour : « git diff --no-index » rend 1 quand il trouve une différence.
const git = (cwd: string, ...args: string[]): string => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";

/** [fichier, numéro de ligne, texte] pour chaque ligne ajoutée d'un diff unifié sans contexte. */
function* lignesAjoutees(diff: string): Generator<[string, number, string]> {
  let fichier = "";
  let numero = 0;
  for (const ligne of diff.split(/\r?\n/)) {
    if (ligne.startsWith("+++ ")) fichier = ligne.startsWith("+++ b/") ? ligne.slice(6) : "";
    else if (ligne.startsWith("@@")) numero = Number(/\+(\d+)/.exec(ligne)![1]);
    else if (ligne.startsWith("+") && fichier) yield [fichier, numero++, ligne.slice(1)];
  }
}

const masquer = (secret: string): string => (secret.length > 6 ? secret.slice(0, 6) + "…" : "…");

function trouver(cwd: string, commande: string): string[] {
  const tout = AJOUTE_LUI_MEME.test(commande);
  const diffs = [git(cwd, "diff", "--cached", "-U0", "--no-color")];
  const noms = git(cwd, "diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean);
  if (tout) {
    diffs.push(git(cwd, "diff", "-U0", "--no-color"));
    noms.push(...git(cwd, "diff", "--name-only").split(/\r?\n/).filter(Boolean));
    const nouveaux = git(cwd, "ls-files", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean);
    noms.push(...nouveaux);
    for (const nom of nouveaux) diffs.push(git(cwd, "diff", "--no-index", "-U0", "--no-color", "/dev/null", nom));
  }
  const trouvailles = [...new Set(noms)].filter((nom) => FICHIER_INTERDIT.test(nom)).map((nom) => `${nom} : un fichier de secrets ne va jamais dans Git`);
  for (const diff of diffs) {
    for (const [fichier, numero, texte] of lignesAjoutees(diff)) {
      for (const [nature, motif] of MOTIFS) {
        const trouve = motif.exec(texte);
        if (trouve) trouvailles.push(`${fichier}:${numero} : ${nature} (${masquer(trouve[0].trim())})`);
      }
    }
  }
  for (const [nature, motif] of MOTIFS.slice(0, 3)) { // le message du commit, aussi
    const trouve = motif.exec(commande);
    if (trouve) trouvailles.push(`le message du commit : ${nature} (${masquer(trouve[0])})`);
  }
  return trouvailles;
}

function main(): number {
  const entree = JSON.parse(readFileSync(0, "utf8"));
  const commande: string = entree.tool_input?.command ?? "";
  if (!/\bgit\s+commit\b/.test(commande)) return 0;
  const trouvailles = trouver(entree.cwd || ".", commande);
  if (!trouvailles.length) return 0;
  process.stderr.write(
    "Commit bloqué par le garde des secrets :\n- " + trouvailles.join("\n- ") +
      "\nRetirez ces lignes ou ces fichiers du commit (git restore --staged <fichier>), mettez le secret dans " +
      "l'environnement, et prévenez la personne responsable : un secret qui a pu quitter la machine se change.\n",
  );
  return 2;
}

process.exitCode = main();
