// Chapitre 20 : ce que Claude a lancé ou modifié, dans un journal local (hook PostToolUse).
//
// Une ligne JSON par commande ou par fichier : la date, la séance, l'outil, la commande ou le chemin. Jamais
// le contenu d'un fichier ni la sortie d'une commande : le journal dit ce qui s'est passé, pas ce qui a été lu.
// Il sert à relire une séance longue ou sans surveillance, comme le journal des appels du Comptoir
// (chapitre 2). Il reste sur le poste (.claude/.gitignore). Un programme sans dépendance, lancé par Node seul.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const JOURNAL = join(".claude", "journal-outils.jsonl");

const entree = JSON.parse(readFileSync(0, "utf8"));
const args = entree.tool_input ?? {};
const ligne = {
  date: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  seance: entree.session_id ?? null,
  outil: entree.tool_name ?? null,
  cible: [...String(args.command || args.file_path || "")].slice(0, 500).join(""),
};
const chemin = join(process.env.CLAUDE_PROJECT_DIR || ".", JOURNAL);
mkdirSync(dirname(chemin), { recursive: true });
appendFileSync(chemin, JSON.stringify(ligne) + "\n", "utf8");
