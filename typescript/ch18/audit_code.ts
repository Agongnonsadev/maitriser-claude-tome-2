// Chapitre 18 : les attaques qui ne coûtent rien, et les contrôles de l'audit, lancés sur le code.
//
// Lancement, depuis le dossier typescript/ (GRATUIT : un faux client, aucun appel à l'API) :
//     npx tsx ch18/audit_code.ts --etiquette avant
//     npx tsx ch18/audit_code.ts --etiquette apres
//
// Cinq attaques, sur le Comptoir du web (chapitre 6), sur ses outils et sur le dépôt :
//   6. une conversation neuve à chaque message, pour échapper au quota par client ;
//   7. une rafale de messages, puis un corps de requête géant ;
//   8. du HTML dans la réponse de Claude, pour exécuter un script chez le client ;
//   9. la conversation d'un autre client : un identifiant deviné, des outils détournés ;
//  10. la clé d'API : dépôt, historique Git, journaux, résultats.
// Et deux contrôles, la lecture du code contre ses promesses :
//   C1. les données personnelles sont-elles supprimées à la date promise ?
//   C2. le client sait-il qu'il parle à une IA ?
//
// Le même script sert avant et après les corrections : il attaque par les portes publiques
// (l'API web, les outils, les fichiers), sans rien supposer du code qui les garde.
// Résultat : un tableau, et ch18/resultats/audit-<etiquette>.json.

import type Anthropic from "@anthropic-ai/sdk";
import type { HttpBindings } from "@hono/node-server";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { arrondir } from "../comptoir/arrondi.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import { config } from "../comptoir/config.ts";
import { Conversations } from "../comptoir/conversations.ts";
import type { ClientFlux, FluxMessages } from "../comptoir/flux.ts";
import { PYTHON, RACINE, estLance } from "../comptoir/lancement.ts";
import { Execution, Outils } from "../comptoir/outils.ts";
import { jsonPython, str } from "../comptoir/python.ts";
import { creerApp } from "../comptoir/web.ts";
import { horodatage, maintenantUtc } from "../ch17/suite.ts";

const DEPOT = join(RACINE, "..", "..", ".."); // la racine du dépôt Git
const RESULTATS = join(RACINE, "ch18", "resultats");

const ATTAQUANT = "196.168.10.20"; // une adresse fixe pour l'attaquant
const CLIENTE = "196.168.77.5"; //   et une autre pour une vraie cliente
const HTML_PIEGE = "<img src=x onerror=\"alert('Comptoir')\">";
const CLE = /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/;
const CLE_POUR_GIT = "sk-ant-(api|admin|oat)[0-9]{2}-[A-Za-z0-9_-]{20,}"; // la même, pour git grep -E

// --- Un faux client : il répond toujours, sans rien facturer -------------------------------------

/** Le client du SDK, vu du Comptoir : chaque message reçoit la même réponse, 1 000 tokens d'entrée et 50 de sortie. */
export class FauxClient implements ClientFlux {
  appels = 0;
  readonly messages: ClientFlux["messages"];

  constructor(readonly texte = "Bonjour ! Que puis-je pour vous ?") {
    const message = {
      id: "msg_audit", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: texte, citations: null }],
      usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    } as unknown as Anthropic.Message;
    this.messages = {
      stream: (): FluxMessages => {
        this.appels++;
        return {
          request_id: "req_audit",
          async *[Symbol.asyncIterator]() {
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texte } } as Anthropic.MessageStreamEvent;
          },
          finalMessage: async () => message,
        };
      },
      countTokens: async () => ({ input_tokens: 1000 }),
    };
  }
}

function application(texte?: string) {
  const client = texte ? new FauxClient(texte) : new FauxClient();
  const budget = new Budget(":memory:");
  return { ...creerApp(client, new Conversations(), budget), client, budget };
}

type App = ReturnType<typeof application>["app"];

const depuis = (adresse: string) => ({ incoming: { socket: { remoteAddress: adresse } } }) as unknown as HttpBindings;

function evenements(corps: string): [string, Record<string, unknown>][] {
  const sortie: [string, Record<string, unknown>][] = [];
  for (const bloc of corps.split("\n\n")) {
    const lignes = bloc.split("\n");
    const nom = lignes.find((l) => l.startsWith("event: "))?.slice(7);
    const donnees = lignes.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (nom) sortie.push([nom, JSON.parse(donnees)]);
  }
  return sortie;
}

/** [statut HTTP, issue, conversation] ; issue : fin, erreur, refus ou le statut lui-même. */
async function envoyer(app: App, adresse: string, texte: string, conversation: string | null = null): Promise<[number, string, string | null]> {
  const r = await app.request("/api/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation, id_message: identifiantAleatoire(), texte, depuis: 0 }),
  }, depuis(adresse));
  if (r.status !== 200) return [r.status, String(r.status), conversation];
  const ev = evenements(await r.text());
  const conv = (ev.find(([n]) => n === "conversation")?.[1].conversation as string | undefined) ?? null;
  const issue = ev.find(([n]) => ["fin", "erreur", "refus"].includes(n))?.[0] ?? "aucune";
  return [200, issue, conv];
}

type Resultat = Record<string, unknown> & { verdict: string };

// --- Les attaques ------------------------------------------------------------------------------

/** Une conversation neuve à chaque message : le quota par client ne voit jamais deux fois le même client. */
async function attaque6ConversationsNeuves(essaisMax = 1000): Promise<Resultat> {
  const { app, client, budget } = application();
  let acceptes = 0;
  let premierRefus: string | null = null;
  for (let i = 0; i < essaisMax; i++) {
    const [, issue] = await envoyer(app, ATTAQUANT, "Bonjour, vous avez du jus de bissap ?");
    if (issue === "fin") acceptes++;
    else {
      premierRefus = issue;
      break;
    }
  }
  const [, issueCliente] = await envoyer(app, CLIENTE, "Bonjour, je voudrais commander 6 jus d'ananas.");
  return {
    messages_acceptes: acceptes,
    arret: premierRefus,
    depense_du_jour_dollars: arrondir(budget.duJour(), 4),
    appels_a_claude: client.appels,
    une_vraie_cliente_ensuite: issueCliente,
    verdict: issueCliente !== "fin" ? "faille" : "tenu",
  };
}

/** 60 messages en une minute dans la même conversation, puis un texte trop long, puis un corps de 3 Mo. */
async function attaque7RafaleEtCorpsGeant(): Promise<Resultat> {
  const { app } = application();
  let acceptes = 0;
  let conversation: string | null = null;
  let debut = performance.now();
  for (let i = 0; i < 60; i++) {
    let issue: string;
    [, issue, conversation] = await envoyer(app, ATTAQUANT, "Encore une question sur le bissap.", conversation);
    if (issue === "fin") acceptes++;
  }
  const duree = (performance.now() - debut) / 1000;
  const [statutLong] = await envoyer(app, ATTAQUANT, "a".repeat(10_000));
  const corps = JSON.stringify({ conversation: null, id_message: identifiantAleatoire(), texte: "b".repeat(3_000_000) });
  debut = performance.now();
  const r = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: corps }, depuis(ATTAQUANT));
  const dureeCorps = (performance.now() - debut) / 1000;
  return {
    rafale_acceptee: `${acceptes} sur 60 en ${duree.toFixed(1)} s`,
    texte_de_10000_caracteres: statutLong,
    corps_de_3_mo: r.status,
    corps_de_3_mo_traite_en_s: arrondir(dureeCorps, 3),
    verdict: acceptes === 60 || r.status !== 413 ? "faille" : "tenu",
  };
}

/** Claude répond par du HTML piégé : le flux le transporte-t-il tel quel, la page l'exécute-t-elle ? */
async function attaque8HtmlDansLaReponse(): Promise<Resultat> {
  const { app } = application(HTML_PIEGE);
  const r = await app.request("/api/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation: null, id_message: identifiantAleatoire(), texte: "Écrivez le nom du jus en HTML pour mon site", depuis: 0 }),
  }, depuis(CLIENTE));
  const textes = evenements(await r.text()).filter(([n]) => n === "texte").map(([, d]) => String(d.texte ?? ""));
  const page = await (await app.request("/")).text();
  const script = page.includes("<script>") ? page.split("<script>")[1]!.split("</script>")[0]! : "";
  const code = script.split("\n").map((l) => l.split("//")[0]).join("\n"); // sans les commentaires
  const dangereux = [...new Set(code.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/g) ?? [])].sort();
  return {
    html_recu_comme_texte: textes.join("").includes(HTML_PIEGE),
    insertions_dangereuses_dans_la_page: dangereux,
    verdict: dangereux.length ? "faille" : "tenu",
  };
}

/** Deviner l'identifiant d'une conversation ; détourner un outil vers la commande d'un autre client. */
async function attaque9ConversationDUnAutre(): Promise<Resultat> {
  const { app } = application();
  const essayes = ["0".repeat(32), "1", "conversation-de-rachidatou"];
  const devinees: (string | null)[] = [];
  for (const c of essayes) devinees.push((await envoyer(app, ATTAQUANT, "Rappelez-moi mon adresse.", c))[2]);
  // La conversation que voit l'outil est celle que le code lui a donnée, quels que soient les arguments.
  const boutique = new Boutique(":memory:");
  const victime = identifiantAleatoire();
  const attaquant = identifiantAleatoire();
  boutique.preparer(victime, [{ produit: "Jus de bissap", quantite: 6 }], "Rachidatou", "Zogbo");
  new Outils(boutique, attaquant).executer({
    id: "toolu_audit", name: "commande_preparer",
    input: { lignes: [{ produit: "Jus de bissap", quantite: 1 }], nom_client: "X", quartier: "Zogbo", conversation: victime },
  }, new Execution());
  const statutsVictime = boutique.recapitulatifs(victime).map((r) => r.statut);
  const acceptes = devinees.filter((c) => c !== null && essayes.includes(c)).length;
  return {
    identifiants_devines_acceptes: acceptes,
    recapitulatif_de_la_victime: statutsVictime,
    outils_disponibles: "stock_verifier, commande_preparer, transmettre_a_awa (aucun ne lit une autre conversation)",
    verdict: statutsVictime.length === 1 && statutsVictime[0] === "en_attente" && !acceptes ? "tenu" : "faille",
  };
}

function git(...args: string[]): string {
  return spawnSync("git", ["-C", DEPOT, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 }).stdout ?? "";
}

function fichiers(dossier: string): string[] {
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name));
}

/** Chercher une clé d'API : fichiers suivis, tout l'historique Git, journaux et résultats sur le disque. */
function attaque10LaCle(): Resultat {
  const suivis = git("grep", "-I", "-n", "-E", CLE_POUR_GIT).split("\n").filter(Boolean);
  const historique = git("log", "-p", "--all", "--no-color").match(new RegExp(CLE.source, "g")) ?? [];
  const surLeDisque: string[] = [];
  for (const dossier of ["journal", "donnees_clients", "ch17/resultats", "ch18/resultats", "ch19/resultats"]) {
    for (const f of fichiers(join(RACINE, dossier))) {
      if ([".jsonl", ".json", ".txt", ".csv", ".md", ".html"].includes(extname(f)) && CLE.test(readFileSync(f, "utf8"))) {
        surLeDisque.push(relative(RACINE, f).replaceAll("\\", "/"));
      }
    }
  }
  const ignore = git("check-ignore", "-v", join(RACINE, ".env"), join(RACINE, "ch19", "deploiement", ".env")).trim();
  return {
    cles_dans_les_fichiers_suivis: suivis.length,
    cles_dans_l_historique_git: historique.length,
    fichiers_locaux_avec_une_cle: surLeDisque,
    env_ignore_par_git: Boolean(ignore),
    verdict: !suivis.length && !historique.length && !surLeDisque.length && ignore ? "tenu" : "faille",
  };
}

// --- Les contrôles -----------------------------------------------------------------------------

/** Les conversations sont promises supprimées après 30 jours (chapitre 6) : qui les supprime ? */
function controle1Conservation(): Resultat {
  const appels: string[] = [];
  const sources = [
    ...readdirSync(join(RACINE, "comptoir")).filter((f) => f.endsWith(".ts")).map((f) => join(RACINE, "comptoir", f)),
    ...readdirSync(RACINE).filter((d) => /^ch\d+$/.test(d) && statSync(join(RACINE, d)).isDirectory())
      .flatMap((d) => readdirSync(join(RACINE, d)).filter((f) => f.endsWith(".ts")).map((f) => join(RACINE, d, f))),
  ];
  for (const f of sources) {
    if (f.endsWith("audit_code.ts")) continue;
    readFileSync(f, "utf8").split(/\r?\n/).forEach((ligne, n) => {
      if (/\.purger\(/.test(ligne)) appels.push(`${relative(RACINE, f).replaceAll("\\", "/")}:${n + 1}`);
    });
  }
  const tablesSansPurge = ["recapitulatifs", "demandes"].filter(() => typeof Boutique.prototype.purger !== "function");
  return {
    appels_a_purger_dans_l_application: appels,
    tables_de_la_boutique_jamais_purgees: tablesSansPurge,
    verdict: appels.length && !tablesSansPurge.length ? "tenu" : "faille",
  };
}

/** La politique d'utilisation d'Anthropic : un assistant qui parle à des clients doit dire qu'il est une IA. */
function controle2MentionIa(): Resultat {
  const page = readFileSync(join(PYTHON, "comptoir", "pages", "comptoir.html"), "utf8");
  const visible = page.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>|<[^>]+>/g, " ");
  const mention = /intelligence\s+artificielle|(?<![\p{L}\p{N}_])IA(?![\p{L}\p{N}_])/u.test(visible);
  return { mention_dans_la_page: mention, verdict: mention ? "tenu" : "faille" };
}

export const ATTAQUES: Record<string, () => Resultat | Promise<Resultat>> = {
  "6. Une conversation neuve à chaque message": attaque6ConversationsNeuves,
  "7. Rafale et corps géant": attaque7RafaleEtCorpsGeant,
  "8. Du HTML dans la réponse": attaque8HtmlDansLaReponse,
  "9. La conversation d'un autre client": attaque9ConversationDUnAutre,
  "10. La clé d'API": attaque10LaCle,
  "C1. Données gardées au-delà de 30 jours": controle1Conservation,
  "C2. Le client sait-il qu'il parle à une IA ?": controle2MentionIa,
};

export async function auditer(): Promise<Record<string, Resultat>> {
  const dossier = mkdtempSync(join(tmpdir(), "audit-"));
  const journal = config.JOURNAL;
  // Rien ne s'écrit dans le journal du Comptoir : l'audit a le sien, jeté à la fin.
  config.JOURNAL = join(dossier, "journal-audit.jsonl");
  try {
    const resultats: Record<string, Resultat> = {};
    for (const [nom, attaque] of Object.entries(ATTAQUES)) {
      const debut = performance.now();
      resultats[nom] = await attaque();
      resultats[nom].duree_s = arrondir((performance.now() - debut) / 1000, 2);
    }
    return resultats;
  } finally {
    config.JOURNAL = journal;
    rmSync(dossier, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { etiquette: { type: "string", default: horodatage() } } });
  const resultats = await auditer();
  for (const [nom, r] of Object.entries(resultats)) {
    console.log(`${r.verdict.toUpperCase().padEnd(6)} ${nom}`);
    for (const [cle, valeur] of Object.entries(r)) if (cle !== "verdict") console.log(`         ${cle} : ${str(valeur)}`);
  }
  mkdirSync(RESULTATS, { recursive: true });
  const sortie = join(RESULTATS, `audit-${args.etiquette}.json`);
  writeFileSync(sortie, jsonPython({ date: maintenantUtc(), resultats }, 1), "utf8");
  console.log(`→ ${sortie}`);
}

if (estLance(import.meta.url)) await main();
