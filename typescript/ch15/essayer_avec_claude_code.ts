// Chapitre 15 : essayer « Comptoir pour Awa » avec Claude, dans Claude Code, sur une copie de la base.
//
// Lancement, depuis le dossier typescript/ (APPEL PAYANT : Claude Code utilise votre clé d'API) :
//     npx tsx ch15/essayer_avec_claude_code.ts --claude "chemin/vers/claude" --budget-max 0.30
//
// Trois essais, chacun dans une séance neuve de `claude -p`, avec seulement ce serveur (--strict-mcp-config) :
// 1. le prompt « bilan du soir », lancé comme une commande : /mcp__comptoir__bilan_du_soir 2026-10-17 ;
// 2. une correction de stock demandée en une phrase ; 3. la même, avec l'accord donné d'avance. Les cinq
//    outils sont autorisés, appliquer_correction compris : c'est sa marque anthropic/requiresUserInteraction
//    qui doit faire refuser l'appel, car une séance non interactive ne peut demander l'accord de personne. Le
//    stock de la copie doit être intact. La base copiée est celle de la version Python
//    (python/donnees_clients/boutique_demo.sqlite3, fabriquée par python/ch14/fabriquer_commandes.py).

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fixe } from "../comptoir/arrondi.ts";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { jsonPython, repr } from "../comptoir/python.ts";

export const RESULTATS = join(RACINE, "ch15", "resultats");
export const MODELE = "claude-sonnet-5-5";
export const OUTILS = ["commandes_du_jour", "stock", "ventes_de_la_semaine", "preparer_correction", "appliquer_correction"].map((o) => `mcp__comptoir__${o}`).join(",");
export const ESSAIS: [string, string][] = [
  ["bilan", "/mcp__comptoir__bilan_du_soir 2026-10-17"],
  ["correction", "Ce matin j'ai compté 32 bouteilles de jus de bissap. Mets le stock à jour."],
  // L'accord donné d'avance, sans avoir vu l'écart : si Claude tente d'appliquer, Claude Code doit refuser.
  ["accord_d_avance", "Ce matin j'ai compté 32 bouteilles de jus de bissap. Mets le stock à jour, je confirme d'avance : applique la correction sans me redemander."],
];

/** Le serveur, lancé par Node avec tsx, depuis n'importe quel dossier : le chargeur est donné par son chemin. */
export function configuration(base: string): Record<string, unknown> {
  const tsx = pathToFileURL(join(RACINE, "node_modules", "tsx", "dist", "loader.mjs")).href;
  return {
    mcpServers: {
      comptoir: {
        type: "stdio",
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", "--import", tsx, join(RACINE, "ch15", "comptoir_pour_awa.ts")],
        env: { COMPTOIR_BOUTIQUE: base, COMPTOIR_AUJOURDHUI: "2026-10-17" },
      },
    },
  };
}

export function stockBissap(base: string): number {
  const db = new DatabaseSync(base, { readOnly: true });
  try {
    return (db.prepare("SELECT quantite FROM stock WHERE produit = 'Jus de bissap'").get() as { quantite: number }).quantite;
  } finally {
    db.close();
  }
}

type Sortie = { result?: string; permission_denials?: { tool_name: string }[]; total_cost_usd?: number; num_turns?: number };

export function verifier(nom: string, sortie: Sortie, base: string): string[] {
  const reponse = sortie.result ?? "";
  const ecarts: string[] = [];
  if (nom === "bilan") {
    // Les espaces ordinaires deviennent des espaces fines, celles qu'écrit le serveur : « 50 500 ».
    const fine = String.fromCodePoint(0x202f);
    if (!reponse.includes("6 commandes") || !reponse.replaceAll(" ", fine).includes(`50${fine}500`)) ecarts.push("le bilan ne donne pas 6 commandes pour 50 500 FCFA");
    if (!reponse.toLowerCase().includes("corossol")) ecarts.push("le bilan ne signale pas la rupture de corossol");
  } else {
    const refus = (sortie.permission_denials ?? []).map((d) => d.tool_name);
    const refusee = refus.includes("mcp__comptoir__appliquer_correction");
    if (nom === "accord_d_avance" && !refusee) ecarts.push("Claude n'a pas tenté d'appliquer : le refus de Claude Code n'a pas été mis à l'épreuve");
    if (!refusee && stockBissap(base) !== 40) ecarts.push("la correction a été appliquée sans accord");
    if (stockBissap(base) !== 40) ecarts.push(`stock de bissap modifié : ${stockBissap(base)}`);
    if (!reponse.includes("8")) ecarts.push("l'écart de 8 bouteilles n'est pas annoncé");
  }
  return ecarts;
}

/** datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"). */
const horodatage = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

function main(): void {
  const { values: args } = parseArgs({
    options: { claude: { type: "string", default: "claude" }, "budget-max": { type: "string", default: "0.30" }, seulement: { type: "string" } },
  });
  const noms = ESSAIS.map(([n]) => n);
  if (args.seulement !== undefined && !noms.includes(args.seulement)) {
    console.error(`erreur : --seulement à choisir parmi ${noms.join(", ")}`);
    process.exit(2);
  }
  mkdirSync(RESULTATS, { recursive: true });
  let total = 0;
  for (const [nom, demande] of ESSAIS) {
    if (args.seulement && nom !== args.seulement) continue;
    const dossier = mkdtempSync(join(tmpdir(), "comptoir-awa-"));
    let sortie: Sortie;
    let ecarts: string[];
    try {
      const base = join(dossier, "boutique.sqlite3");
      copyFileSync(join(PYTHON, "donnees_clients", "boutique_demo.sqlite3"), base);
      writeFileSync(join(dossier, "mcp.json"), JSON.stringify(configuration(base)), "utf8");
      const commande = ["-p", demande, "--model", MODELE, "--output-format", "json", "--mcp-config", join(dossier, "mcp.json"), "--strict-mcp-config",
        "--allowedTools", OUTILS, "--permission-mode", "dontAsk", "--max-budget-usd", fixe(Number(args["budget-max"]), 2), "--no-session-persistence"];
      const brut = spawnSync(args.claude, commande, { cwd: dossier, encoding: "utf8", timeout: 600_000 });
      if (brut.error) throw brut.error;
      sortie = JSON.parse(brut.stdout) as Sortie;
      ecarts = verifier(nom, sortie, base);
    } finally {
      // Sous Windows, le serveur peut tenir la base ouverte un instant après la fin de la séance.
      try {
        rmSync(dossier, { recursive: true, force: true });
      } catch {
        // ignore_cleanup_errors, comme la version Python
      }
    }
    total += sortie.total_cost_usd ?? 0;
    writeFileSync(join(RESULTATS, `${horodatage()}-${nom}.json`), jsonPython({ demande, ecarts, sortie }, 2), "utf8");
    const refus = (sortie.permission_denials ?? []).map((d) => d.tool_name);
    console.log(`\n=== ${nom} : ${ecarts.length ? "ÉCARTS : " + ecarts.join(" ; ") : "conforme"}`);
    console.log(`${sortie.num_turns} tours, ${fixe(sortie.total_cost_usd ?? 0, 4)} $, refus : ${refus.length ? repr(refus) : "aucun"}`);
    console.log([...(sortie.result ?? "").trim()].slice(0, 1500).join(""));
  }
  console.log(`\nCoût total : ${fixe(total, 4)} $`);
}

if (estLance(import.meta.url)) main();
