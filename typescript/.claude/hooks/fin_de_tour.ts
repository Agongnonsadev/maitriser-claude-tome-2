// Chapitre 20 : Claude ne rend pas la main sur des tests rouges (hook Stop).
//
// Quand Claude a fini de répondre, le hook regarde si du code TypeScript a changé depuis le dernier passage
// au vert. Si oui, la suite de tests tourne (sans appel payant : un faux client partout). Rouge : le hook
// renvoie la fin du rapport avec « decision: block », et Claude continue pour corriger, ou explique pourquoi
// l'échec est attendu. Vert : l'empreinte des changements est notée, pour ne pas relancer la même suite.
//
// Claude Code arrête lui-même la boucle après huit relances de suite (documentation des hooks).
// COMPTOIR_HOOK_TESTS remplace la commande de test (pour les tests du hook). Un programme sans dépendance.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ETAT = join(".claude", ".dernier-vert"); // ignoré par Git (.claude/.gitignore)

const git = (racine: string, ...args: string[]): string =>
  spawnSync("git", args, { cwd: racine, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";

/** L'état du code TypeScript par rapport au dernier commit : modifié, ajouté ou nouveau. Vide si rien n'a changé. */
function empreinte(racine: string): string {
  const diff = git(racine, "diff", "HEAD", "--no-color", "--", "*.ts");
  const nouveaux = git(racine, "ls-files", "--others", "--exclude-standard", "--", "*.ts").split(/\s+/).filter(Boolean);
  if (!diff && !nouveaux.length) return "";
  const h = createHash("sha256").update(diff, "utf8");
  for (const nom of nouveaux.sort()) {
    h.update(nom, "utf8");
    h.update(readFileSync(join(racine, nom)));
  }
  return h.digest("hex");
}

/**
 * shlex.split de Python, en plus simple : des mots séparés par des espaces, entre guillemets s'il le faut. Entre
 * guillemets doubles, une barre oblique inverse n'échappe que \ " $ et ` : un chemin Windows reste intact.
 */
function mots(commande: string): string[] {
  return [...commande.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\([\\"$`])/g, "$1") : (m[2] ?? m[3]!)));
}

function main(): void {
  readFileSync(0, "utf8"); // l'événement Stop : rien à y lire
  const racine = process.env.CLAUDE_PROJECT_DIR || ".";
  const actuelle = empreinte(racine);
  const etat = join(racine, ETAT);
  if (!actuelle || (existsSync(etat) && readFileSync(etat, "utf8") === actuelle)) return;
  const remplacee = mots(process.env.COMPTOIR_HOOK_TESTS ?? "");
  const [commande, ...args] = remplacee.length
    ? remplacee
    : [process.execPath, "--disable-warning=ExperimentalWarning", "--import", "tsx", "--test", "--test-reporter=dot", "tests/**/*.test.ts"];
  const resultat = spawnSync(commande!, args, { cwd: racine, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (resultat.status === 0) {
    mkdirSync(dirname(etat), { recursive: true });
    writeFileSync(etat, actuelle, "utf8");
    return;
  }
  const fin = ((resultat.stdout ?? "") + (resultat.stderr ?? "")).trim().split(/\r?\n/).slice(-25).join("\n");
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "La suite de tests échoue après vos modifications. Corrigez avant de rendre la main, ou expliquez à Yao " +
      "pourquoi l'échec est attendu. Fin du rapport :\n" + fin,
  }) + "\n");
}

main();
