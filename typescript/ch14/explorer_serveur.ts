// Chapitre 14 : regarder un serveur MCP avant de le confier à Claude. Aucun appel à l'API Claude.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch14/explorer_serveur.ts commandes                 # DBHub sur la copie d'exploration
//     npx tsx ch14/explorer_serveur.ts commandes --essayer-d-ecrire
//     npx tsx ch14/explorer_serveur.ts everything                # outils, ressources et prompts d'exemple
//     npx tsx ch14/explorer_serveur.ts doc                       # la documentation d'Anthropic
//
// Le script se comporte comme un client MCP : il se connecte, affiche la version du protocole négociée, les
// instructions du serveur et la description complète de chaque outil, ressource et prompt. C'est ce texte
// que Claude lira comme des consignes : il faut le lire avant lui.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { APRES } from "../comptoir/garde.ts";
import { estLance } from "../comptoir/lancement.ts";
import { repr, separerMots } from "../comptoir/python.ts";
import { RACINE, SERVEURS, connecter } from "./serveurs.ts";

// Des tournures qui n'ont rien à faire dans la description d'un outil : un serveur qui les emploie essaie
// peut-être de diriger Claude (empoisonnement des outils). Ce n'est qu'une alerte : rien ne remplace la
// lecture. La limite de mot après « .env » est celle de Python, qui suit les lettres accentuées.
export const SUSPECT = new RegExp(
  "ignore (all|any|previous|the above)|ignorez|instead of|au lieu de|do not tell|ne (le )?dites pas" +
    "|system prompt|prompt système|<important>|before using any other tool|avant tout autre outil" +
    `|send .{0,40}(to|vers) https?://|~/\\.ssh|\\.env${APRES}|api[_ -]?key|mot de passe|password`,
  "giu",
);

/** Les passages d'une description qui méritent une relecture attentive. */
export const alertes = (texte: string | null | undefined): string[] => [...new Set([...(texte ?? "").matchAll(SUSPECT)].map((m) => m[0]))].sort();

/** Le texte sur une ligne, coupé à largeur caractères (comptés comme Python les compte). */
export function court(texte: string | null | undefined, largeur = 400): string {
  const ligne = [...separerMots(texte ?? "").join(" ")];
  return ligne.length <= largeur ? ligne.join("") : ligne.slice(0, largeur - 1).join("") + "…";
}

/** snake_case : les noms de champs que montre la version Python (model_dump du SDK MCP Python 2). */
const enSerpent = (objet: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(objet).map(([k, v]) => [k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`), v]));

export async function explorer(nom: string): Promise<number> {
  let signalements = 0;
  const { client, protocole } = await connecter(SERVEURS[nom]!());
  try {
    const info = client.getServerVersion();
    console.log(`Serveur : ${info?.name ?? "?"} ${info?.version ?? ""}`);
    console.log(`Protocole négocié : ${protocole}`);
    const instructions = client.getInstructions();
    if (instructions) console.log(`Instructions du serveur : ${court(instructions)}`);
    const capacites = client.getServerCapabilities();

    const { tools: outils } = await client.listTools();
    console.log(`\n${outils.length} outil(s)`);
    for (const outil of outils) {
      const proprietes = Object.keys(outil.inputSchema?.properties ?? {});
      const annotations = outil.annotations ? enSerpent(outil.annotations) : {};
      console.log(`- ${outil.name}(${proprietes.join(", ")}) ${Object.keys(annotations).length ? repr(annotations) : ""}`);
      console.log(`    ${court(outil.description, 600)}`);
      for (const passage of alertes(outil.description)) {
        signalements++;
        console.log(`    ⚠ à relire : « ${passage} »`);
      }
    }

    if (capacites?.resources) {
      const { resources: ressources } = await client.listResources();
      console.log(`\n${ressources.length} ressource(s)`);
      for (const r of ressources.slice(0, 10)) console.log(`- ${r.uri}  (${r.mimeType || "?"}) ${court(r.name, 80)}`);
      if (ressources.length > 10) console.log(`  … et ${ressources.length - 10} autres`);
    }
    if (capacites?.prompts) {
      const { prompts } = await client.listPrompts();
      console.log(`\n${prompts.length} prompt(s)`);
      for (const p of prompts) console.log(`- ${p.name}(${(p.arguments ?? []).map((a) => a.name).join(", ")}) : ${court(p.description, 200)}`);
    }
  } finally {
    await client.close();
  }
  console.log(signalements ? `\n${signalements} passage(s) à relire.` : "\nAucune tournure suspecte repérée.");
  return signalements;
}

export function compterCommandes(): number {
  const db = new DatabaseSync(join(RACINE, "donnees_clients", "commandes_exploration.sqlite3"), { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM commandes").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

type Resultat = { content: { type: string; text?: string }[]; isError?: boolean };
const textes = (r: Resultat): string => r.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");

/** Demande au serveur des commandes d'effacer une commande. Rend true si l'écriture est refusée. */
export async function essayerDEcrire(): Promise<boolean> {
  const avant = compterCommandes();
  const { client } = await connecter(SERVEURS.commandes!());
  let ecriture: Resultat;
  try {
    const lecture = (await client.callTool({ name: "execute_sql", arguments: { sql: "SELECT COUNT(*) AS commandes FROM commandes" } })) as Resultat;
    console.log("Lecture :", court(textes(lecture), 200));
    ecriture = (await client.callTool({ name: "execute_sql", arguments: { sql: "DELETE FROM commandes WHERE id = 'C-0001'" } })) as Resultat;
    console.log("Écriture :", ecriture.isError ? "refusée" : "ACCEPTÉE", "—", court(textes(ecriture), 300));
  } finally {
    await client.close();
  }
  const apres = compterCommandes();
  console.log(`Commandes dans la copie : ${avant} avant, ${apres} après.`);
  return Boolean(ecriture.isError) && avant === apres;
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: { "essayer-d-ecrire": { type: "boolean", default: false } }, // vérifier que le serveur des commandes refuse une écriture
  });
  const serveur = positionals[0];
  const choix = Object.keys(SERVEURS).sort();
  if (!serveur || !choix.includes(serveur)) {
    console.error(`erreur : serveur à choisir parmi ${choix.join(", ")}`);
    process.exit(2);
  }
  if (args["essayer-d-ecrire"]) {
    if (serveur !== "commandes") {
      console.error("erreur : --essayer-d-ecrire ne vaut que pour le serveur des commandes");
      process.exit(2);
    }
    process.exit((await essayerDEcrire()) ? 0 : 1);
  }
  await explorer(serveur);
}

if (estLance(import.meta.url)) await main();
