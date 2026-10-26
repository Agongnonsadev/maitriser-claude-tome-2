// Chapitre 20 : ce que Claude Code ne modifie pas sans que Yao le voie (hook PreToolUse, Edit et Write).
//
// CLAUDE.md demande ces règles ; ce hook les fait respecter, à chaque fois, sans que Claude ait à s'en souvenir :
// - une version de prompt ne se modifie pas : on écrit la suivante, et on l'évalue (chapitres 5 et 17) ; les
//   prompts, communs aux deux versions, sont dans ../python/comptoir/prompts ;
// - un test n'appelle jamais l'API : pas de vrai client dans tests/, sauf vers un faux serveur local ;
// - les prix de comptoir/couts.ts viennent de la page Pricing d'Anthropic : Yao confirme chaque modification.
//
// Entrée : l'événement en JSON sur l'entrée standard. Sortie : rien (pas d'objection), ou une décision
// « deny » ou « ask » avec sa raison, que Claude lit. Un programme sans dépendance, lancé par Node seul.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROMPT_VERSIONNE = /^(?:\.\.\/python\/)?comptoir\/prompts\/[a-z_]+_v\d+\.md$/;
const CLIENT = /\bnew\s+Anthropic\s*\(|\bcreerClient\s*\(/g;
const SERVEUR_LOCAL = /baseURL\s*:\s*[`"']https?:\/\/(?:127\.0\.0\.1|localhost)/;

type Arguments = { file_path?: string; content?: string; new_string?: string; edits?: { new_string?: string }[] };

/** Le chemin du fichier par rapport au projet, avec des barres obliques, sous Windows aussi. */
function relatif(chemin: string, racine: string): string {
  if (!chemin) return "";
  const absolu = isAbsolute(chemin) ? chemin : resolve(racine, chemin);
  return relative(resolve(racine), absolu).replaceAll("\\", "/");
}

/** Ce que l'outil va écrire : le contenu de Write, le nouveau texte d'Edit (ou de chaque Edit groupé). */
function textesEcrits(args: Arguments): string[] {
  return [args.content ?? "", args.new_string ?? "", ...(args.edits ?? []).map((e) => e.new_string ?? "")].filter(Boolean);
}

/** Un vrai client, ou creerClient() : interdits dans un test. Un client vers 127.0.0.1 reste permis (un faux serveur). */
function appelleLApi(texte: string): boolean {
  for (const trouve of texte.matchAll(CLIENT)) {
    if (trouve[0].startsWith("creerClient")) return true;
    const fin = trouve.index + trouve[0].length;
    if (!SERVEUR_LOCAL.test(texte.slice(fin, fin + 400))) return true;
  }
  return false;
}

function examiner(entree: { tool_input?: Arguments }, racine: string): [string, string] | null {
  const args = entree.tool_input ?? {};
  const fichier = relatif(args.file_path ?? "", racine);
  if (PROMPT_VERSIONNE.test(fichier) && existsSync(join(racine, fichier))) {
    const version = Number(/_v(\d+)\.md$/.exec(fichier)![1]);
    const suivante = fichier.replace(/_v\d+\.md$/, `_v${version + 1}.md`);
    return ["deny", `${fichier} est une version publiée : des séries d'évaluation y renvoient par son empreinte. ` +
      `Écrivez la version suivante (${suivante}), puis évaluez-la comme une variante (chapitre 17).`];
  }
  if (fichier.startsWith("tests/") && textesEcrits(args).some(appelleLApi)) {
    return ["deny", "Un test n'appelle jamais l'API : chaque appel est payant. Utilisez un faux client " +
      "(voir FauxClient dans tests/faux_clients.ts), ou un faux serveur sur 127.0.0.1."];
  }
  if (fichier === "comptoir/couts.ts") {
    return ["ask", "Les prix de comptoir/couts.ts viennent de la page Pricing d'Anthropic. " +
      "La modification a-t-elle une source datée ? Yao confirme lui-même."];
  }
  return null;
}

function main(): void {
  const entree = JSON.parse(readFileSync(0, "utf8"));
  const racine = process.env.CLAUDE_PROJECT_DIR || entree.cwd || ".";
  const resultat = examiner(entree, racine);
  if (resultat) {
    const [decision, raison] = resultat;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: raison } }) + "\n");
  }
}

main();
