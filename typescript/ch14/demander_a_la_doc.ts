// Chapitre 14 : vérifier les prix du Comptoir dans la documentation d'Anthropic, par le connecteur MCP.
//
// Lancement, depuis le dossier typescript/ (APPEL PAYANT) :
//     npx tsx ch14/demander_a_la_doc.ts                    # liste blanche : search_docs et get_doc
//     npx tsx ch14/demander_a_la_doc.ts --epingler         # même chose, liste d'outils épinglée
//
// Le connecteur MCP de l'API (bêta) branche un serveur MCP distant sur une requête : c'est l'API qui se
// connecte au serveur, appelle ses outils et rend le tout dans une seule réponse. Ici, le serveur officiel de
// la documentation (https://platform.claude.com/docs/mcp, public, sans authentification). Claude cherche les
// prix et les rend en JSON ; le code les compare à comptoir/couts.ts. Claude ne décide pas si un prix a
// changé : il le lit, le code compare.
//
// --epingler : avec l'en-tête mcp-client-2026-09-15, la première réponse rend la liste d'outils du serveur ;
// le script l'enregistre dans ch14/outils_epingles/doc-claude.json. Les fois suivantes, il envoie cette
// liste : l'API n'interroge plus le serveur sur ses outils, et un serveur qui changerait ses descriptions ne
// changerait pas ce que Claude lit. Avant chaque appel, le script compare la liste épinglée à celle que le
// serveur annonce aujourd'hui (gratuit) et s'arrête si elle a changé. La liste épinglée par la version
// Python (python/ch14/outils_epingles/) sert tant que celle-ci n'a pas la sienne.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { creerClient } from "../comptoir/appel.ts";
import { fixe } from "../comptoir/arrondi.ts";
import { config } from "../comptoir/config.ts";
import { enBlocs } from "../comptoir/conversations.ts";
import { TARIFS, type Tarif, cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { egaux, flottant, jsonPython, lireJsonPython, nombre, str } from "../comptoir/python.ts";
import { DOC_CLAUDE, connecter } from "./serveurs.ts";

export const SERVEUR = "doc-claude";
export const BETA = "mcp-client-2025-11-20";
export const BETA_EPINGLE = "mcp-client-2026-09-15";
export const EPINGLE = join(RACINE, "ch14", "outils_epingles", `${SERVEUR}.json`);
const EPINGLE_PYTHON = join(PYTHON, "ch14", "outils_epingles", `${SERVEUR}.json`);
export const MODELES_VERIFIES = ["claude-sonnet-5-5", "claude-haiku-5-5"];
export const POSTES = ["entree", "ecriture_5m", "ecriture_1h", "lecture_cache", "sortie"] as const;
type Poste = (typeof POSTES)[number];
// Les postes du schéma (ceux de la version Python) et les champs de Tarif qui leur correspondent.
const CHAMP: Record<Poste, keyof Tarif> = { entree: "entree", ecriture_5m: "ecriture5m", ecriture_1h: "ecriture1h", lecture_cache: "lectureCache", sortie: "sortie" };

export const SYSTEME =
  "Tu vérifies des faits dans la documentation officielle de Claude, avec les outils du serveur MCP " +
  "doc-claude. Ne réponds jamais de mémoire : cherche, lis la page, puis recopie les chiffres tels que " +
  "la page les donne. Si un chiffre n'y est pas, mets le modèle dans non_trouve plutôt que de deviner.";

export const SCHEMA = {
  type: "object",
  properties: {
    prix: {
      type: "array",
      items: {
        type: "object",
        properties: {
          modele: { type: "string", description: "identifiant du modèle, par exemple claude-haiku-5-5" },
          ...Object.fromEntries(POSTES.map((p) => [p, { type: "number", description: "dollars par million de tokens" }])),
          source: { type: "string", description: "adresse de la page lue" },
        },
        required: ["modele", ...POSTES, "source"],
        additionalProperties: false,
      },
    },
    non_trouve: { type: "array", items: { type: "string" } },
  },
  required: ["prix", "non_trouve"],
  additionalProperties: false,
};

export const question = (): string =>
  "Donne, pour " + MODELES_VERIFIES.join(" et ") + ", les prix publiés par million de tokens : entrée, " +
  "écriture dans le cache de 5 minutes, écriture dans le cache d'une heure, lecture du cache, sortie. " +
  "Prends les prix de base de l'API (pas la Batch API, pas les prompts longs).";

export type OutilEpingle = { name: string; description?: string | null; input_schema: unknown };

/** La liste blanche : tous les outils désactivés par défaut, puis deux réactivés. */
export function toolset(epingle: OutilEpingle[] | null): Record<string, unknown> {
  const jeu: Record<string, unknown> = {
    type: "mcp_toolset",
    mcp_server_name: SERVEUR,
    default_config: { enabled: false },
    configs: { search_docs: { enabled: true }, get_doc: { enabled: true } },
  };
  if (epingle !== null) jeu.tools = epingle;
  return jeu;
}

export function requete(epingle: OutilEpingle[] | null, beta: string): Record<string, unknown> & { model: string; messages: Anthropic.Beta.BetaMessageParam[] } {
  return {
    model: config.MODELE_DOCUMENTS,
    max_tokens: 3000,
    system: SYSTEME,
    messages: [{ role: "user", content: question() }],
    mcp_servers: [{ type: "url", url: DOC_CLAUDE, name: SERVEUR }],
    tools: [toolset(epingle)],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    betas: [beta],
  };
}

type Bloc = Record<string, unknown> & { type: string };

/** Ce qui s'est passé dans la réponse, bloc par bloc : la trace d'un appel avec connecteur. */
export function trace(contenu: unknown[]): string[] {
  const lignes: string[] = [];
  for (const bloc of contenu as Bloc[]) {
    if (bloc.type === "mcp_tool_listing") lignes.push(`liste des outils de ${bloc.mcp_server_name} : ${(bloc.tools as unknown[]).length} outil(s)`);
    else if (bloc.type === "mcp_tool_use") lignes.push(`appel ${bloc.server_name}.${bloc.name} ${jsonPython(bloc.input)}`);
    else if (bloc.type === "mcp_tool_result") {
      const taille = ((bloc.content as { text?: string }[] | null) ?? []).reduce((s, c) => s + [...(c.text ?? "")].length, 0);
      lignes.push(`  résultat ${bloc.is_error ? "en erreur" : "reçu"} : ${taille} caractères`);
    } else if (bloc.type === "text") lignes.push(`texte : ${[...String(bloc.text)].length} caractères`);
  }
  return lignes;
}

type LignePrix = Record<Poste, unknown> & { modele: string; source: string };

/** Les écarts entre les prix lus dans la documentation et ceux de comptoir/couts.ts. */
export function comparer(reponse: { prix: LignePrix[]; non_trouve?: string[] }): string[] {
  const ecarts = (reponse.non_trouve ?? []).map((m) => `${m} : prix non trouvé dans la documentation`);
  const vus = new Set<string>();
  for (const ligne of reponse.prix) {
    const modele = ligne.modele;
    if (!MODELES_VERIFIES.includes(modele)) continue;
    vus.add(modele);
    const tarif = TARIFS[modele]!;
    for (const poste of POSTES) {
      // Les prix de couts.ts sont des float dans la version Python : « 10.0 $ ».
      if (Math.abs(tarif[CHAMP[poste]] - nombre(ligne[poste])) > 1e-9) {
        ecarts.push(`${modele} ${poste} : ${flottant(tarif[CHAMP[poste]])} $ dans couts.py, ${str(ligne[poste])} $ dans la documentation (${ligne.source})`);
      }
    }
  }
  ecarts.push(...MODELES_VERIFIES.filter((m) => !vus.has(m)).map((m) => `${m} : absent de la réponse`));
  return ecarts;
}

/** La liste d'outils que le serveur annonce aujourd'hui, au format du connecteur. Gratuit. */
export async function outilsAnnonces(): Promise<OutilEpingle[]> {
  const { client } = await connecter(DOC_CLAUDE);
  try {
    return (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? null, input_schema: t.inputSchema }));
  } finally {
    await client.close();
  }
}

/** Les outils dont la définition a changé depuis l'épinglage (ou apparus, ou disparus). */
export function epingleAJour(epingle: OutilEpingle[], annonces: OutilEpingle[]): string[] {
  const avant = new Map(epingle.map((t) => [t.name, t]));
  const maintenant = new Map(annonces.map((t) => [t.name, t]));
  const changes = [...avant.keys()].filter((n) => maintenant.has(n) && !egaux(avant.get(n), maintenant.get(n)));
  const apparus = [...maintenant.keys()].filter((n) => !avant.has(n)).map((n) => `+${n}`);
  const disparus = [...avant.keys()].filter((n) => !maintenant.has(n)).map((n) => `-${n}`);
  return [...changes, ...apparus, ...disparus].sort();
}

/** SystemExit de Python : le message sur la sortie d'erreur, et le code 1. */
function arreter(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      epingler: { type: "boolean", default: false }, //            épingler la liste d'outils du serveur
      "budget-max": { type: "string", default: "0.10" }, //       plafond de la séance, en dollars
    },
  });
  const budgetMax = Number(args["budget-max"]);
  let epingle: OutilEpingle[] | null = null;
  let beta = BETA;
  if (args.epingler) {
    beta = BETA_EPINGLE;
    const lue = [EPINGLE, EPINGLE_PYTHON].find(existsSync);
    if (lue) {
      epingle = JSON.parse(readFileSync(lue, "utf8")) as OutilEpingle[];
      const changes = epingleAJour(epingle, await outilsAnnonces());
      if (changes.length) {
        arreter(
          `Le serveur a changé ses outils depuis l'épinglage : ${changes.join(", ")}. Relisez-les ` +
            `(npx tsx ch14/explorer_serveur.ts doc), puis supprimez ${lue} pour épingler la nouvelle liste.`,
        );
      }
      console.log(`Liste d'outils épinglée : ${epingle.length} outil(s), identique à celle du serveur.`);
    }
  }

  const client = creerClient();
  const { messages: debut, ...params } = requete(epingle, beta);
  const messages = [...debut];
  let depense = 0;
  let appels = 0;
  let message: Anthropic.Beta.BetaMessage;
  while (true) {
    // Pas de comptage préalable : l'endpoint count_tokens refuse mcp_servers, et les résultats des outils
    // entrent pendant l'appel. Le plafond se vérifie donc après chaque appel.
    message = await client.beta.messages.create({ ...params, messages } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    appels++;
    const prix = cout(params.model, message.usage);
    depense += prix.dollars;
    noter((message as { _request_id?: string | null })._request_id, params.model, prix, { client: "ch14-doc", stop_reason: message.stop_reason, origine: "connecteur-mcp" });
    for (const ligne of trace(message.content)) console.log(ligne);
    if (args.epingler && epingle === null) {
      for (const bloc of message.content as unknown as Bloc[]) {
        if (bloc.type === "mcp_tool_listing" && bloc.mcp_server_name === SERVEUR) {
          mkdirSync(dirname(EPINGLE), { recursive: true });
          writeFileSync(EPINGLE, jsonPython(enBlocs(bloc.tools), 2), "utf8");
          console.log(`Liste d'outils épinglée dans ${relative(RACINE, EPINGLE)}`);
          epingle = bloc.tools as OutilEpingle[];
        }
      }
    }
    if (message.stop_reason !== "pause_turn") break;
    if (depense >= budgetMax || appels >= 4) arreter(`Arrêt : ${fixe(depense, 4)} $ dépensés en ${appels} appels, plafond atteint.`);
    // pause_turn : l'API a interrompu un long tour d'outils ; on renvoie sa réponse telle quelle.
    messages.push({ role: "assistant", content: enBlocs(message.content) as Anthropic.Beta.BetaContentBlockParam[] });
  }

  const texte = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const reponse = lireJsonPython(texte) as { prix: LignePrix[]; non_trouve: string[] };
  const ecarts = comparer(reponse);
  console.log();
  for (const ligne of reponse.prix) console.log(`${ligne.modele} : ` + POSTES.map((p) => `${p} ${str(ligne[p])}`).join(", ") + `  (${ligne.source})`);
  console.log("\nPrix de comptoir/couts.ts :", ecarts.length ? "ÉCARTS" : "à jour.");
  for (const e of ecarts) console.log(" -", e);
  console.log(`\n${appels} appel(s), ${message.usage.input_tokens} tokens d'entrée au dernier, coût : ${fixe(depense, 4)} $`);
  if (depense > budgetMax) console.log(`Attention : le plafond de ${budgetMax} $ est dépassé ; il ne peut être vérifié qu'après l'appel.`);
}

if (estLance(import.meta.url)) await main();
