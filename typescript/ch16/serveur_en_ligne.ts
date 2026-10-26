// Chapitre 16 : « Comptoir pour Awa » en ligne, en Streamable HTTP, sans état, derrière OAuth.
//
// Lancement local, depuis le dossier typescript/ :
//     COMPTOIR_URL_PUBLIQUE=http://localhost:8016 COMPTOIR_BOUTIQUE=... COMPTOIR_MOT_DE_PASSE_HACHE=... \
//         npx tsx ch16/serveur_en_ligne.ts --port 8016
//
// C'est le serveur du chapitre 15, au caractère près : les outils, la ressource, le gabarit et les prompts
// sont ceux de ch15/comptoir_pour_awa.ts, déclarés par le même code (enregistrer). Ce qui change :
// - le transport : HTTP au lieu de stdio, pour être joint depuis le téléphone d'Awa ;
// - l'accès : un jeton OAuth (ch16/autorisation.ts), émis après le mot de passe d'Awa ; les adresses OAuth
//   sont celles du SDK MCP, servies par Express ;
// - un outil long, rapport_de_la_semaine, qui envoie des notifications de progression ;
// - appliquer_correction demande en plus une confirmation par formulaire au client qui sait l'afficher, et
//   s'en remet au jeton de préparation pour les autres, comme l'application Claude ;
// - sans état : aucune session, les jetons et les corrections sont dans des bases SQLite ; plusieurs
//   processus peuvent servir les mêmes clients. Chaque requête a son serveur MCP, neuf.
//
// Le SDK TypeScript 1.32.1 s'arrête à la révision 2025-11-25 du protocole : sans session, le serveur ne
// connaît pas les capacités du client, et le jeton suffit (le formulaire en plusieurs allers-retours de la
// révision 2026-07-28, que la version Python propose, n'existe pas ici). Le formulaire reste possible avec un
// client qui garde le même serveur, comme celui des tests, en mémoire.
//
// Configuration (variables d'environnement) :
//   COMPTOIR_URL_PUBLIQUE        l'adresse publique, en https:// en ligne (http://localhost:… en local)
//   COMPTOIR_BOUTIQUE            la base de la boutique (SQLite)
//   COMPTOIR_AUTORISATION        la base des jetons (par défaut donnees_clients/autorisation.sqlite3)
//   COMPTOIR_MOT_DE_PASSE_HACHE  sortie de « npx tsx ch16/autorisation.ts hacher »
//   COMPTOIR_HOTES_SUPPLEMENTAIRES  autres noms d'hôte acceptés, séparés par des virgules (facultatif)

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import * as awa from "../ch15/comptoir_pour_awa.ts";
import { INSTRUCTIONS as INSTRUCTIONS_DU_BUREAU, OUTILS } from "../ch15/schemas.ts";
import { ajouterJours, lireDate, lundiDe } from "../comptoir/dates.ts";
import { estLance } from "../comptoir/lancement.ts";
import { FournisseurAwa, PORTEE } from "./autorisation.ts";
import { CONFIRMATION, RAPPORT } from "./schemas.ts";

let journal: ((message: string) => void) | null = null;

export const INSTRUCTIONS =
  INSTRUCTIONS_DU_BUREAU +
  "\n5. Pour un rapport de semaine complet (jour par jour, quartiers, comparaison), utilise " +
  "rapport_de_la_semaine : il prend quelques secondes et signale sa progression.";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * « oui » si la correction peut se faire, sinon la raison du refus. Le formulaire, si le client sait
 * l'afficher ; sinon, le jeton suffit : l'accord a été donné dans la conversation, sur l'écart annoncé.
 */
async function confirmer(serveur: McpServer, jeton: string, extra: Extra): Promise<string> {
  const capacites = serveur.server.getClientCapabilities();
  const protocole = extra.requestInfo?.headers["mcp-protocol-version"] ?? "-";
  journal?.(`confirmation : protocole ${protocole}, formulaire possible : ${capacites?.elicitation ? "True" : "False"}`);
  if (!capacites?.elicitation) return "oui";
  const ligne = awa.avecLaBase((db) => {
    db.exec(awa.TABLE_CORRECTIONS);
    return db.prepare("SELECT produit, avant, apres FROM corrections_stock WHERE jeton = ?").get(jeton.trim()) as { produit: string; avant: number; apres: number } | undefined;
  });
  if (!ligne) return "oui"; // appliquer() refusera le jeton, avec son propre message
  const reponse = await extra.sendRequest(
    { method: "elicitation/create", params: { mode: "form", message: `Corriger le stock de ${ligne.produit} : ${ligne.avant} → ${ligne.apres} ?`, requestedSchema: CONFIRMATION as never } },
    ElicitResultSchema,
  );
  if (reponse.action === "decline") return "Correction refusée par Awa : le stock n'a pas changé.";
  if (reponse.action === "cancel") return "Correction annulée par Awa : le stock n'a pas changé.";
  if (reponse.content?.confirme !== true) return "Awa n'a pas coché la confirmation : le stock n'a pas changé.";
  return "oui";
}

/** Le rapport d'une semaine, en signalant sa progression : un jour, une notification. */
async function rapport(unJourDeLaSemaine: string | null | undefined, extra: Extra): Promise<Record<string, unknown>> {
  const signaler = async (fait: number, message: string): Promise<void> => {
    const jeton = extra._meta?.progressToken;
    if (jeton !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: jeton, progress: fait, total: 8, message } });
  };
  const unJour = unJourDeLaSemaine ? lireDate(unJourDeLaSemaine)! : awa.aujourdhui();
  const lundi = lundiDe(unJour);
  const { ventes, commandes } = awa.avecLaBase((db) => ({ ventes: awa.lireVentesSemaine(db, awa.catalogue(), unJour), commandes: awa.commandes(db) }));
  const parJour: { jour: string; commandes: number; total_fcfa: number }[] = [];
  const quartiers = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const jour = ajouterJours(lundi, i);
    const duJour = commandes.filter((c) => c.quand.jour === jour);
    for (const c of duJour) quartiers.set(c.quartier, (quartiers.get(c.quartier) ?? 0) + c.total);
    parJour.push({ jour, commandes: duJour.length, total_fcfa: duJour.reduce((t, c) => t + c.total, 0) });
    await signaler(i + 1, `${awa.jourEnToutesLettres(jour)} : ${duJour.length} commande${duJour.length > 1 ? "s" : ""}`);
  }
  // Du plus au moins rapporteur ; à égalité, l'ordre d'apparition (le tri est stable, comme en Python).
  const parQuartier = Object.fromEntries([...quartiers].sort((a, b) => b[1] - a[1]));
  await signaler(8, "Rapport prêt");
  const meilleur = parJour.reduce((m, j) => (j.total_fcfa > m.total_fcfa ? j : m)); // le premier des meilleurs, comme max()
  const resume =
    `${ventes.resume} Meilleur jour : ${awa.jourEnToutesLettres(meilleur.jour)} (${awa.fcfa(meilleur.total_fcfa)}). ` +
    `Premier quartier : ${Object.keys(parQuartier)[0] ?? "—"}.`;
  return { ventes, par_jour: parJour, par_quartier: parQuartier, resume };
}

/** Le serveur MCP en ligne : celui du chapitre 15, appliquer_correction avec confirmation, et le rapport. */
export function construire(): McpServer {
  const serveur = new McpServer({ name: "comptoir-pour-awa", title: "Comptoir pour Awa", version: awa.VERSION }, { instructions: INSTRUCTIONS });
  awa.enregistrer(serveur, ["appliquer_correction"]); // redéfini ici, avec la confirmation

  const appliquer = OUTILS.appliquer_correction;
  serveur.registerTool(
    "appliquer_correction",
    {
      title: appliquer.title,
      description: appliquer.description,
      inputSchema: z.fromJSONSchema(appliquer.entree as never) as z.ZodObject,
      outputSchema: z.fromJSONSchema(appliquer.sortie as never) as z.ZodObject,
      annotations: appliquer.annotations,
      _meta: appliquer._meta,
    },
    (async ({ jeton }: { jeton: string }, extra: Extra) =>
      awa.executer("appliquer_correction", async () => {
        const accord = await confirmer(serveur, jeton, extra);
        if (accord !== "oui") throw new awa.ErreurOutil(accord);
        return awa.avecLaBase((db) => awa.appliquer(db, jeton, awa.horloge.maintenant()));
      })) as never,
  );

  serveur.registerTool(
    "rapport_de_la_semaine",
    {
      title: RAPPORT.title,
      description: RAPPORT.description,
      inputSchema: z.fromJSONSchema(RAPPORT.entree as never) as z.ZodObject,
      outputSchema: z.fromJSONSchema(RAPPORT.sortie as never) as z.ZodObject,
      annotations: RAPPORT.annotations,
    },
    (async ({ un_jour_de_la_semaine }: { un_jour_de_la_semaine?: string | null }, extra: Extra) =>
      awa.executer("rapport_de_la_semaine", () => rapport(un_jour_de_la_semaine, extra))) as never,
  );
  return serveur;
}

// ---------- L'application HTTP -------------------------------------------------------------------

export interface Securite {
  hotes: string[];
  origines: string[];
}

/** Les noms d'hôte acceptés : celui de l'adresse publique, et ceux qu'on ajoute (un tunnel d'essai). */
export function securite(urlPublique: string): Securite {
  const supplementaires = (process.env.COMPTOIR_HOTES_SUPPLEMENTAIRES ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const hotes = [new URL(urlPublique).hostname, ...supplementaires];
  return { hotes: hotes.flatMap((h) => [h, `${h}:*`]), origines: ["https://claude.ai"] };
}

/** Un nom permis, au port près s'il finit par « :* » (TransportSecuritySettings du SDK Python). */
function permis(valeur: string, permises: string[]): boolean {
  return permises.some((p) => valeur === p || (p.endsWith(":*") && valeur.startsWith(`${p.slice(0, -2)}:`)));
}

/**
 * La protection contre la réaffectation DNS, sur /mcp, après l'authentification : mêmes contrôles et mêmes
 * réponses que le transport du SDK Python (le SDK TypeScript laisse ce contrôle à l'application).
 */
function controleDuTransport({ hotes, origines }: Securite) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // La raison n'apparaît que dans le journal du serveur, comme en Python.
    const refuser = (statut: number, message: string, valeur: string): void => {
      journal?.(`${message}: ${valeur}`);
      res.status(statut).type("text/plain").send(message);
    };
    const type = req.headers["content-type"] ?? "";
    if (req.method === "POST" && !type.toLowerCase().startsWith("application/json")) return refuser(400, "Invalid Content-Type header", type);
    const hote = req.headers.host ?? "";
    if (!permis(hote, hotes)) return refuser(421, "Invalid Host header", hote);
    const origine = req.headers.origin;
    if (origine && !permis(origine, origines)) return refuser(403, "Invalid Origin header", origine);
    next();
  };
}

/** Une ligne par requête MCP : la méthode, la révision du protocole, le client. Jamais le jeton. */
function journalDesAcces(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/mcp") {
    res.on("finish", () => {
      const client = String(req.headers["user-agent"] ?? "-").slice(0, 60);
      journal?.(`mcp ${req.method} ${req.headers["mcp-method"] ?? "-"} protocole=${req.headers["mcp-protocol-version"] ?? "-"} client=${client} -> ${res.statusCode}`);
    });
  }
  next();
}

export function application(urlPublique: string, cheminAutorisation: string, motDePasseHache: string): { app: Express; fournisseur: FournisseurAwa } {
  const url = urlPublique.replace(/\/+$/, "");
  const ressource = `${url}/mcp`;
  const fournisseur = new FournisseurAwa(cheminAutorisation, url, ressource, motDePasseHache);
  const app = express();
  app.disable("x-powered-by");
  app.use(journalDesAcces);
  // Les adresses OAuth du SDK : métadonnées (RFC 8414 et RFC 9728), /authorize, /token, /register, /revoke.
  app.use(mcpAuthRouter({ provider: fournisseur, issuerUrl: new URL(url), resourceServerUrl: new URL(ressource), scopesSupported: [PORTEE] }));
  app.all("/connexion", express.urlencoded({ extended: false }), async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") res.status(405).set("Allow", "GET, POST").send("Method Not Allowed");
    else await fournisseur.pageDeConnexion(req, res);
  });
  // Jamais authentifiée : ne rien dire ici qui ne soit public.
  app.get("/sante", (_req, res) => {
    res.json({ etat: "ok", version: awa.VERSION });
  });
  const authentification = requireBearerAuth({
    verifier: fournisseur,
    requiredScopes: [PORTEE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(ressource)),
    expectedResource: new URL(ressource), // validate_token_resource de la version Python
  });
  app.all("/mcp", authentification, controleDuTransport(securite(url)), express.json({ limit: "4mb" }), async (req, res) => {
    // Sans état : un serveur et un transport neufs pour chaque requête, comme stateless_http=True en Python.
    const serveur = construire();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void serveur.close();
    });
    await serveur.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return { app, fournisseur };
}

function arreter(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      hote: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8016" },
      // Derrière Caddy, qui termine le HTTPS : faire confiance à son en-tête X-Forwarded-For (un relais).
      "derriere-un-relais": { type: "boolean", default: false },
    },
  });
  const url = (process.env.COMPTOIR_URL_PUBLIQUE ?? "").trim();
  const hache = (process.env.COMPTOIR_MOT_DE_PASSE_HACHE ?? "").trim();
  if (!url || !hache) arreter("Réglez COMPTOIR_URL_PUBLIQUE et COMPTOIR_MOT_DE_PASSE_HACHE (voir l'en-tête de ch16/serveur_en_ligne.ts).");
  journal = awa.journalSurLaSortieDErreur("comptoir_en_ligne");
  awa.brancherJournal(awa.journalSurLaSortieDErreur("comptoir_pour_awa"));
  const autorisation = process.env.COMPTOIR_AUTORISATION ?? "donnees_clients/autorisation.sqlite3";
  mkdirSync(dirname(autorisation), { recursive: true });
  const { app } = application(url, autorisation, hache);
  if (args["derriere-un-relais"]) app.set("trust proxy", 1);
  const port = Number(args.port);
  app.listen(port, args.hote, () => journal?.(`à l'écoute sur http://${args.hote}:${port} (adresse publique : ${url})`));
}

if (estLance(import.meta.url)) await main();
