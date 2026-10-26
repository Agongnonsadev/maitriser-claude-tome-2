// Chapitre 16 : se connecter au Comptoir en ligne comme le fait un client MCP, OAuth compris.
//
// Lancement, depuis le dossier typescript/, le serveur tournant (voir serveur_en_ligne.ts) :
//     npx tsx ch16/se_connecter.ts http://localhost:8016/mcp                 # avec votre navigateur
//     npx tsx ch16/se_connecter.ts http://localhost:8016/mcp --automatique   # essai local, sans navigateur
//
// Ce que fait le client, dans l'ordre : il appelle /mcp sans jeton et reçoit un 401 qui pointe vers les
// métadonnées de la ressource ; il y lit l'adresse du serveur d'autorisation ; il s'enregistre (enregistrement
// dynamique) ; il ouvre la page de connexion, avec un défi PKCE ; il reçoit un code sur son adresse de retour ;
// il l'échange contre un jeton ; il rappelle /mcp avec ce jeton. Le SDK fait tout cela : ce script fournit le
// navigateur, l'adresse de retour et le fichier des jetons. Le SDK TypeScript rend la main entre la page et
// l'échange (UnauthorizedError, puis finishAuth avec le code) ; il ne vérifie ni l'état ni l'émetteur rendus
// avec le code, que le SDK Python vérifie : ce script le fait.
//
// --automatique remplace le navigateur par une requête qui remplit la page de connexion avec le mot de passe
// de COMPTOIR_MOT_DE_PASSE_ESSAI : pour un serveur d'essai, sur votre ordinateur, seulement. Les jetons sont
// gardés dans donnees_clients/jetons_client.json (exclu de Git).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { RACINE, estLance } from "../comptoir/lancement.ts";
import { PORTEE } from "./autorisation.ts";

export const JETONS = join(RACINE, "donnees_clients", "jetons_client.json");
export const PORT_RETOUR = 3030;

/** Les jetons et l'enregistrement du client, dans un fichier : la connexion suivante est silencieuse. */
export class StockageFichier {
  constructor(readonly chemin = JETONS) {}

  private lire(): Record<string, unknown> {
    return existsSync(this.chemin) ? (JSON.parse(readFileSync(this.chemin, "utf8")) as Record<string, unknown>) : {};
  }

  private ecrire(cle: string, valeur: unknown): void {
    const donnees = { ...this.lire(), [cle]: valeur };
    mkdirSync(dirname(this.chemin), { recursive: true });
    writeFileSync(this.chemin, JSON.stringify(donnees, null, 2), "utf8");
  }

  jetons = (): OAuthTokens | undefined => this.lire().jetons as OAuthTokens | undefined;
  garderJetons = (jetons: OAuthTokens): void => this.ecrire("jetons", jetons);
  client = (): OAuthClientInformationMixed | undefined => this.lire().client as OAuthClientInformationMixed | undefined;
  garderClient = (client: OAuthClientInformationMixed): void => this.ecrire("client", client);
}

/** Ce que l'adresse de retour reçoit : le code, l'état et l'émetteur (RFC 9207). */
export interface Retour {
  code: string;
  state: string | null;
  iss: string | null;
}

export function resultatDuRetour(adresse: string): Retour {
  const params = new URL(adresse, "http://localhost").searchParams;
  if (params.has("error")) arreter(`Connexion refusée : ${params.get("error")}`);
  return { code: params.get("code")!, state: params.get("state"), iss: params.get("iss") };
}

export interface Navigateur {
  ouvrir: (adresse: URL) => Promise<void>;
  attendre: () => Promise<Retour>;
}

/** Ce que ferait le navigateur d'Awa : suivre /authorize, remplir la page, rapporter l'adresse de retour. */
export function navigateurSimule(motDePasse: string): Navigateur {
  let rendre: (r: Retour) => void = () => {};
  const retour = new Promise<Retour>((ok) => (rendre = ok));
  return {
    ouvrir: async (adresse) => {
      const lire = (url: string, init: RequestInit = {}): Promise<Response> => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
      let url = adresse.href;
      let reponse = await lire(url);
      while ((reponse.status === 302 || reponse.status === 307) && !url.includes("/connexion")) {
        url = new URL(reponse.headers.get("location")!, url).href;
        reponse = await lire(url);
      }
      if (!(await reponse.text()).includes("Comptoir pour Awa")) throw new Error("page de connexion attendue");
      const envoi = await lire(url, { method: "POST", body: new URLSearchParams({ mot_de_passe: motDePasse, decision: "autoriser" }) });
      if (envoi.status !== 302) arreter(`Connexion refusée par la page (${envoi.status}) : ` + [...(await envoi.text()).replace(/<[^>]+>/g, " ")].slice(-200).join(""));
      rendre(resultatDuRetour(envoi.headers.get("location")!));
    },
    attendre: () => retour,
  };
}

/** Ouvre une adresse dans le navigateur de l'ordinateur (webbrowser.open de Python). */
function ouvrirDansLeNavigateur(adresse: string): void {
  const [commande, args] = process.platform === "win32" ? ["explorer.exe", [adresse]] : process.platform === "darwin" ? ["open", [adresse]] : ["xdg-open", [adresse]];
  spawn(commande, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

/** Ouvre le navigateur, et attend le retour sur http://localhost:3030/callback. */
export function vraiNavigateur(): Navigateur {
  let rendre: (r: Retour) => void = () => {};
  const retour = new Promise<Retour>((ok) => (rendre = ok));
  const serveur = createServer((requete, reponse) => {
    reponse.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    reponse.end("<p>C'est fait : vous pouvez fermer cette page.</p>");
    serveur.close();
    rendre(resultatDuRetour(requete.url ?? "/"));
  });
  return {
    ouvrir: async (adresse) => {
      await new Promise<void>((ok) => serveur.listen(PORT_RETOUR, "127.0.0.1", ok));
      console.log(`Ouvrez cette page si le navigateur ne s'ouvre pas : ${adresse.href}`);
      ouvrirDansLeNavigateur(adresse.href);
    },
    attendre: () => retour,
  };
}

/** Ce que le SDK demande au client : son identité, où garder ses jetons, comment ouvrir la page. */
export class ConnexionOAuth implements OAuthClientProvider {
  private verificateur = "";
  readonly etat = randomBytes(16).toString("base64url");
  emetteur: string | null = null;

  constructor(
    readonly stockage: StockageFichier,
    readonly navigateur: Navigateur,
  ) {}

  get redirectUrl(): string {
    return `http://localhost:${PORT_RETOUR}/callback`;
  }

  get clientMetadata() {
    return { client_name: "Script de Yao", scope: PORTEE, redirect_uris: [this.redirectUrl], token_endpoint_auth_method: "none" };
  }

  state = (): string => this.etat;
  clientInformation = (): OAuthClientInformationMixed | undefined => this.stockage.client();
  saveClientInformation = (client: OAuthClientInformationMixed): void => this.stockage.garderClient(client);
  tokens = (): OAuthTokens | undefined => this.stockage.jetons();
  saveTokens = (jetons: OAuthTokens): void => this.stockage.garderJetons(jetons);
  redirectToAuthorization = (adresse: URL): Promise<void> => this.navigateur.ouvrir(adresse);
  saveCodeVerifier = (verificateur: string): void => void (this.verificateur = verificateur);
  codeVerifier = (): string => this.verificateur;
  saveDiscoveryState = (decouverte: { authorizationServerMetadata?: { issuer: string } }): void => void (this.emetteur = decouverte.authorizationServerMetadata?.issuer ?? null);

  /** Le code, après avoir vérifié l'état (le même que celui envoyé) et l'émetteur (celui des métadonnées). */
  async code(): Promise<string> {
    const retour = await this.navigateur.attendre();
    if (retour.state !== this.etat) arreter("Connexion refusée : l'état rendu n'est pas celui de la demande.");
    if (retour.iss !== null && retour.iss !== this.emetteur) arreter(`Connexion refusée : émetteur inattendu (${retour.iss}).`);
    return retour.code;
  }
}

/** Le formulaire de confirmation, dans la console : c'est ici qu'Awa dirait oui. */
async function accepter(message: string): Promise<ElicitResult> {
  console.log(`\n[formulaire du serveur] ${message}`);
  let reponse = process.env.COMPTOIR_REPONSE_FORMULAIRE;
  if (!reponse) {
    const console_ = createInterface({ input: process.stdin, output: process.stdout });
    reponse = (await console_.question("Confirmer ? (o/n) ")).trim().toLowerCase();
    console_.close();
  }
  console.log(`[réponse] ${reponse}`);
  return { action: "accept", content: { confirme: reponse === "o" } };
}

function arreter(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Se connecte, en passant par la page de connexion si le fichier n'a pas (ou plus) de jeton valable. */
export async function connecter(adresse: string, oauth: ConnexionOAuth): Promise<[Client, StreamableHTTPClientTransport]> {
  // Le formulaire, annoncé au serveur ; sans session, celui-ci ne le saura pas (voir serveur_en_ligne.ts).
  const client = new Client({ name: "script-de-yao", version: "0.1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => accepter(r.params.message));
  for (let essai = 0; ; essai++) {
    const transport = new StreamableHTTPClientTransport(new URL(adresse), { authProvider: oauth });
    try {
      await client.connect(transport);
      return [client, transport];
    } catch (erreur) {
      if (!(erreur instanceof UnauthorizedError) || essai > 0) throw erreur;
      await transport.finishAuth(await oauth.code());
    }
  }
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      automatique: { type: "boolean", default: false },
      produit: { type: "string", default: "Jus de bissap" },
      compte: { type: "string", default: "38" },
    },
  });
  const adresse = positionals[0];
  if (positionals.length !== 1 || !adresse) arreter("Usage : npx tsx ch16/se_connecter.ts <adresse>/mcp [--automatique] [--produit P] [--compte N]");
  let navigateur: Navigateur;
  if (args.automatique) {
    const motDePasse = process.env.COMPTOIR_MOT_DE_PASSE_ESSAI ?? "";
    // Un serveur d'essai seulement : votre ordinateur, ou l'hôte d'essai que vous nommez (un tunnel).
    const hotes = new Set(["localhost", "127.0.0.1", process.env.COMPTOIR_HOTE_D_ESSAI ?? ""].filter(Boolean));
    if (!motDePasse || !hotes.has(new URL(adresse).hostname)) arreter("--automatique : seulement sur un serveur d'essai, avec COMPTOIR_MOT_DE_PASSE_ESSAI.");
    navigateur = navigateurSimule(motDePasse);
  } else navigateur = vraiNavigateur();

  const [client, transport] = await connecter(adresse, new ConnexionOAuth(new StockageFichier(), navigateur));
  try {
    const serveur = client.getServerVersion()!;
    console.log(`Connecté : ${serveur.name} ${serveur.version}, protocole ${transport.protocolVersion}`);
    console.log("Outils :", (await client.listTools()).tools.map((t) => t.name).join(", "));
    console.log("Stock :", ((await client.callTool({ name: "stock", arguments: {} })).structuredContent as { resume: string }).resume);
    console.log("Rapport de la semaine :");
    const rapport = await client.callTool({ name: "rapport_de_la_semaine", arguments: { un_jour_de_la_semaine: "2026-10-14" } }, undefined, {
      onprogress: (p) => console.log(`  [${Math.trunc(p.progress)}/${Math.trunc(p.total ?? 0)}] ${p.message}`),
    });
    console.log(" ", (rapport.structuredContent as { resume: string }).resume);
    const projet = (await client.callTool({ name: "preparer_correction", arguments: { produit: args.produit, quantite_comptee: Number(args.compte) } })).structuredContent as {
      a_dire_a_awa: string;
      jeton: string;
    };
    console.log("Préparation :", projet.a_dire_a_awa);
    const fait = (await client.callTool({ name: "appliquer_correction", arguments: { jeton: projet.jeton } })) as { isError?: boolean; structuredContent?: { resume: string }; content: { text: string }[] };
    console.log("Application :", fait.isError ? fait.content[0]!.text : fait.structuredContent!.resume);
  } finally {
    await client.close();
  }
}

if (estLance(import.meta.url)) await main();
