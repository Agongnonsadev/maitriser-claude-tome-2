// Chapitre 16 : le serveur d'autorisation OAuth du Comptoir, pour une seule personne, Awa.
//
// Le serveur MCP en ligne n'ouvre ses outils qu'avec un jeton d'accès. Ce module émet ces jetons : il
// implémente le « fournisseur » que le SDK MCP attend (OAuthServerProvider) ; le SDK, lui, sert les adresses
// du protocole OAuth (métadonnées, /authorize, /token, /register, /revoke), avec Express, et vérifie PKCE. Ce
// que ce module ajoute :
// - une page de connexion, en français, où Awa tape son mot de passe et voit qui demande l'accès ;
// - une liste blanche des adresses de retour : l'application Claude, et Claude Code sur cet ordinateur ;
// - des jetons opaques, dont seule l'empreinte est gardée, dans une base SQLite (rien en mémoire : plusieurs
//   processus peuvent servir les mêmes jetons) ;
// - la rotation des jetons de renouvellement, et la révocation de tout s'il en revient un usagé ;
// - un blocage après cinq mots de passe faux en quinze minutes.
//
// Le SDK TypeScript laisse au fournisseur des vérifications que le SDK Python fait lui-même : l'expiration du
// code, l'adresse de retour à l'échange, les portées demandées. Elles sont ici, avec les messages du SDK Python.
// Il compare déjà une adresse de retour locale sans son port (RFC 8252, § 7.3) : la version Python l'ajoutait.
//
// Pour plusieurs personnes ou une entreprise, préférez un fournisseur d'identité (Keycloak, Auth0, Entra…) :
// le SDK vérifie alors ses jetons, et ce module n'a plus lieu d'être.
//
// Hacher le mot de passe d'Awa, à mettre dans COMPTOIR_MOT_DE_PASSE_HACHE ; tout révoquer :
//     npx tsx ch16/autorisation.ts hacher
//     npx tsx ch16/autorisation.ts deconnecter-tout donnees_clients/autorisation.sqlite3

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  CustomOAuthError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { estLance } from "../comptoir/lancement.ts";

export const PORTEE = "comptoir";
export const RETOUR_CLAUDE = "https://claude.ai/api/mcp/auth_callback"; // claude.ai, application de bureau et mobile
export const DUREE_DEMANDE = 10 * 60;
export const DUREE_CODE = 5 * 60;
export const DUREE_ACCES = 60 * 60;
export const DUREE_RENOUVELLEMENT = 30 * 24 * 60 * 60;
export const ESSAIS_MAX = 5;
export const FENETRE_ESSAIS = 15 * 60;

/** secrets.token_urlsafe(n) : n octets au hasard, en base64 pour adresses, sans « = ». */
const auHasard = (octets: number): string => randomBytes(octets).toString("base64url");

// ---------- Mot de passe -----------------------------------------------------------------------

/**
 * scrypt, avec un sel aléatoire : « scrypt:16384:8:1:sel:empreinte », la même forme qu'en Python (un hachage
 * fait par l'une des versions se vérifie avec l'autre). Des deux-points et non des « $ » : Docker Compose lirait
 * « $… » comme une variable dans un fichier .env.
 */
export function hacher(motDePasse: string, sel: Buffer = randomBytes(16)): string {
  const empreinte = scryptSync(motDePasse, sel, 32, { N: 2 ** 14, r: 8, p: 1 });
  return `scrypt:16384:8:1:${sel.toString("base64url")}:${empreinte.toString("base64url")}`;
}

export function verifierMotDePasse(motDePasse: string, attendu: string): boolean {
  const morceaux = attendu.split(":");
  if (morceaux.length !== 6) return false;
  const [, n, r, p, sel, empreinte] = morceaux as [string, string, string, string, string, string];
  const entier = (s: string): number => (/^\s*[+-]?\d+\s*$/.test(s) ? Number(s) : Number.NaN); // int() de Python
  let calcule: Buffer;
  try {
    calcule = scryptSync(motDePasse, Buffer.from(sel, "base64url"), 32, { N: entier(n), r: entier(r), p: entier(p) });
  } catch {
    return false;
  }
  const voulu = Buffer.from(empreinte, "base64url");
  return voulu.length === calcule.length && timingSafeEqual(calcule, voulu);
}

const empreinteDe = (jeton: string): string => createHash("sha256").update(jeton).digest("hex");

// ---------- Adresses de retour -------------------------------------------------------------------

function analyser(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function locale(uri: string): boolean {
  const u = analyser(uri);
  return u !== null && u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
}

/** L'application Claude, ou un client sur cet ordinateur (Claude Code, nos scripts), port libre. */
export function retourAutorise(uri: string): boolean {
  return uri === RETOUR_CLAUDE || (locale(uri) && analyser(uri)!.pathname === "/callback");
}

/** construct_redirect_uri du SDK Python : l'adresse de retour, avec ses paramètres en plus (sans les absents). */
function construireRetour(base: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(base);
  for (const [cle, valeur] of Object.entries(params)) if (valeur !== null && valeur !== undefined) u.searchParams.append(cle, valeur);
  return u.href;
}

// ---------- Le fournisseur ---------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL, cree_le REAL NOT NULL);
CREATE TABLE IF NOT EXISTS demandes (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expire REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes (empreinte TEXT PRIMARY KEY, donnees TEXT NOT NULL, expire REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jetons (empreinte TEXT PRIMARY KEY, sorte TEXT NOT NULL, client_id TEXT NOT NULL,
    portees TEXT NOT NULL, ressource TEXT, expire REAL NOT NULL, etat TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS echecs (quand REAL NOT NULL);
CREATE TABLE IF NOT EXISTS accords (demande TEXT PRIMARY KEY, retour TEXT NOT NULL, expire REAL NOT NULL);
`;

/** Une demande d'autorisation en attente du mot de passe (les champs d'AuthorizationParams en Python). */
interface Demande {
  state: string | null;
  scopes: string[] | null;
  code_challenge: string;
  redirect_uri: string;
  redirect_uri_provided_explicitly: boolean;
  resource: string | null;
}

/** Un code d'autorisation (les champs d'AuthorizationCode en Python). */
interface Code {
  code: string;
  scopes: string[];
  expires_at: number;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  redirect_uri_provided_explicitly: boolean;
  resource: string | null;
  subject: string;
}

interface Jeton {
  empreinte: string;
  sorte: string;
  client_id: string;
  portees: string;
  ressource: string | null;
  expire: number;
  etat: string;
}

/** Le serveur d'autorisation d'Awa, branché sur le SDK MCP (mcpAuthRouter et requireBearerAuth). */
export class FournisseurAwa implements OAuthServerProvider {
  readonly chemin: string;
  readonly url: string;
  /** L'émetteur tel que le SDK l'annonce dans ses métadonnées (URL.href : une barre finale pour une origine). */
  readonly emetteur: string;

  constructor(
    base: string,
    urlPublique: string,
    readonly ressource: string,
    readonly motDePasseHache: string,
    readonly horloge: () => number = () => Date.now() / 1000, // en secondes, comme time.time
  ) {
    this.chemin = base;
    this.url = urlPublique.replace(/\/+$/, "");
    this.emetteur = new URL(this.url).href;
    this.avec((db) => db.exec(SCHEMA));
  }

  /** Une connexion, le temps d'un bloc : ses écritures ensemble ou pas du tout (le with db: de Python). */
  private avec<T>(travail: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.chemin);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      db.exec("BEGIN");
      try {
        const resultat = travail(db);
        db.exec("COMMIT");
        return resultat;
      } catch (erreur) {
        db.exec("ROLLBACK");
        throw erreur;
      }
    } finally {
      db.close();
    }
  }

  // --- Clients (enregistrement dynamique, RFC 7591) ---

  private lireClient(db: DatabaseSync, clientId: string): OAuthClientInformationFull | undefined {
    const ligne = db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as { info: string } | undefined;
    return ligne ? (JSON.parse(ligne.info) as OAuthClientInformationFull) : undefined;
  }

  private client(clientId: string): OAuthClientInformationFull | undefined {
    return this.avec((db) => this.lireClient(db, clientId));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => this.client(clientId),
      registerClient: async (client) => this.enregistrer(client as OAuthClientInformationFull),
    };
  }

  private enregistrer(client: OAuthClientInformationFull): OAuthClientInformationFull {
    // Ce que le SDK Python vérifie lui-même (ClientRegistrationOptions : portées permises et par défaut).
    const info = { ...client };
    if (info.scope === undefined) info.scope = PORTEE;
    else {
      const refusees = [...new Set(info.scope.split(/\s+/).filter(Boolean))].filter((p) => p !== PORTEE);
      if (refusees.length) throw new InvalidClientMetadataError(`Requested scopes are not valid: ${refusees.join(", ")}`);
    }
    if (info.grant_types && !info.grant_types.includes("authorization_code")) throw new InvalidClientMetadataError("grant_types must include 'authorization_code'");
    if (info.response_types && !info.response_types.includes("code")) throw new InvalidClientMetadataError("response_types must include 'code' for authorization_code grant");
    const refusees = info.redirect_uris.filter((u) => !retourAutorise(u));
    if (refusees.length) throw new CustomOAuthError("invalid_redirect_uri", `Adresse de retour refusée par ce serveur : ${refusees.join(", ")}`);
    this.avec((db) => db.prepare("INSERT INTO clients VALUES (?, ?, ?)").run(info.client_id, JSON.stringify(info), this.horloge()));
    return info;
  }

  // --- Autorisation : la page de connexion ---

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Le SDK TypeScript ne dit pas au fournisseur si l'adresse de retour était dans la demande : la requête, si.
    const brut = (res.req.method === "POST" ? res.req.body : res.req.query) as Record<string, unknown>;
    const permises = (client.scope ?? "").split(" ");
    const demandees = params.scopes?.length ? params.scopes : null;
    for (const p of demandees ?? []) if (!permises.includes(p)) throw new InvalidScopeError(`Client was not registered with scope ${p}`);
    if (params.resource && params.resource.href.replace(/\/+$/, "") !== this.ressource.replace(/\/+$/, "")) {
      throw new InvalidTargetError("Ce serveur ne délivre des jetons que pour le Comptoir.");
    }
    const demande: Demande = {
      state: params.state ?? null,
      scopes: demandees,
      code_challenge: params.codeChallenge,
      redirect_uri: params.redirectUri,
      redirect_uri_provided_explicitly: brut.redirect_uri !== undefined,
      resource: params.resource?.href ?? null,
    };
    const identifiant = auHasard(24);
    this.avec((db) => {
      db.prepare("DELETE FROM demandes WHERE expire < ?").run(this.horloge());
      db.prepare("INSERT INTO demandes VALUES (?, ?, ?, ?)").run(identifiant, client.client_id, JSON.stringify(demande), this.horloge() + DUREE_DEMANDE);
    });
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, `${this.url}/connexion?demande=${identifiant}`);
  }

  private bloque(db: DatabaseSync): boolean {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM echecs WHERE quand > ?").get(this.horloge() - FENETRE_ESSAIS) as { n: number };
    return n >= ESSAIS_MAX;
  }

  /** GET : la page ; POST : la réponse d'Awa (corps déjà lu par express.urlencoded). */
  async pageDeConnexion(requete: Request, reponse: Response): Promise<void> {
    const identifiant = typeof requete.query.demande === "string" ? requete.query.demande : "";
    const page = this.avec((db): Page => {
      const ligne = db.prepare("SELECT * FROM demandes WHERE id = ? AND expire > ?").get(identifiant, this.horloge()) as { client_id: string; params: string } | undefined;
      if (!ligne) {
        // Sur une connexion qui se coupe, la réponse au premier envoi peut se perdre et le navigateur renvoie le
        // formulaire : on rend la même redirection, sans nouveau code. Sans danger : le code ne sert qu'une fois,
        // et seulement au client qui détient le vérificateur PKCE.
        const accord = db.prepare("SELECT retour FROM accords WHERE demande = ? AND expire > ?").get(identifiant, this.horloge()) as { retour: string } | undefined;
        if (accord) return { redirection: accord.retour };
        return pageHtml("Cette demande a expiré", "<p>Retournez dans Claude et relancez la connexion.</p>", 400);
      }
      const params = JSON.parse(ligne.params) as Demande;
      const client = this.lireClient(db, ligne.client_id);
      if (requete.method === "GET") return pageAccord(identifiant, client, params);
      const formulaire = (requete.body ?? {}) as Record<string, unknown>;
      if (formulaire.decision === "refuser") {
        db.prepare("DELETE FROM demandes WHERE id = ?").run(identifiant);
        return { redirection: construireRetour(params.redirect_uri, { error: "access_denied", state: params.state, iss: this.emetteur }) };
      }
      if (this.bloque(db)) return pageAccord(identifiant, client, params, "Trop d'essais : attendez quinze minutes.", 429);
      if (!verifierMotDePasse(String(formulaire.mot_de_passe ?? ""), this.motDePasseHache)) {
        db.prepare("INSERT INTO echecs VALUES (?)").run(this.horloge());
        return pageAccord(identifiant, client, params, "Mot de passe incorrect.", 401);
      }
      const code = auHasard(32);
      const donnees: Code = {
        code,
        scopes: params.scopes ?? [PORTEE],
        expires_at: this.horloge() + DUREE_CODE,
        client_id: client!.client_id,
        code_challenge: params.code_challenge,
        redirect_uri: params.redirect_uri,
        redirect_uri_provided_explicitly: params.redirect_uri_provided_explicitly,
        resource: params.resource ?? this.ressource,
        subject: "awa",
      };
      // RFC 9207 : l'émetteur accompagne le code, et le client le vérifie.
      const retour = construireRetour(params.redirect_uri, { code, state: params.state, iss: this.emetteur });
      db.prepare("DELETE FROM demandes WHERE id = ?").run(identifiant);
      db.prepare("INSERT INTO codes VALUES (?, ?, ?)").run(empreinteDe(code), JSON.stringify(donnees), donnees.expires_at);
      db.prepare("INSERT INTO accords VALUES (?, ?, ?)").run(identifiant, retour, donnees.expires_at);
      return { redirection: retour };
    });
    if ("redirection" in page) reponse.redirect(302, page.redirection);
    else reponse.status(page.statut).set(page.entetes).type("html").send(page.html);
  }

  // --- Codes et jetons ---

  /** Le code, s'il existe pour ce client et n'a pas expiré (vérifié par le SDK Python, ici par le fournisseur). */
  private code(client: OAuthClientInformationFull, code: string): Code {
    const ligne = this.avec((db) => db.prepare("SELECT donnees FROM codes WHERE empreinte = ?").get(empreinteDe(code))) as { donnees: string } | undefined;
    const donnees = ligne ? (JSON.parse(ligne.donnees) as Code) : null;
    if (!donnees || donnees.client_id !== client.client_id) throw new InvalidGrantError("authorization code does not exist");
    if (donnees.expires_at < Date.now() / 1000) throw new InvalidGrantError("authorization code has expired");
    return donnees;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client, code).code_challenge;
  }

  private emettre(db: DatabaseSync, clientId: string, portees: string[], ressource: string | null): OAuthTokens {
    const acces = auHasard(32);
    const renouvellement = auHasard(32);
    const maintenant = this.horloge();
    for (const [jeton, sorte, duree] of [[acces, "acces", DUREE_ACCES], [renouvellement, "renouvellement", DUREE_RENOUVELLEMENT]] as const) {
      db.prepare("INSERT INTO jetons VALUES (?, ?, ?, ?, ?, ?, 'valide')").run(empreinteDe(jeton), sorte, clientId, portees.join(" "), ressource, maintenant + duree);
    }
    return { access_token: acces, token_type: "Bearer", expires_in: DUREE_ACCES, scope: portees.join(" "), refresh_token: renouvellement };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verificateur?: string, redirectUri?: string): Promise<OAuthTokens> {
    const donnees = this.code(client, code);
    const attendu = donnees.redirect_uri_provided_explicitly ? donnees.redirect_uri : undefined;
    if (redirectUri !== attendu) throw new InvalidRequestError("redirect_uri did not match the one used when creating auth code");
    return this.avec((db) => {
      const supprime = db.prepare("DELETE FROM codes WHERE empreinte = ?").run(empreinteDe(code));
      if (supprime.changes !== 1) throw new InvalidGrantError("Ce code a déjà servi."); // un code ne sert qu'une fois
      return this.emettre(db, client.client_id, donnees.scopes, donnees.resource);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, jeton: string, portees?: string[]): Promise<OAuthTokens> {
    const verdict = this.avec((db) => {
      const ligne = db.prepare("SELECT * FROM jetons WHERE empreinte = ? AND sorte = 'renouvellement'").get(empreinteDe(jeton)) as Jeton | undefined;
      if (!ligne || ligne.client_id !== client.client_id) return null;
      if (ligne.etat === "utilise") {
        // Un jeton de renouvellement déjà échangé qui revient : il a été volé, ou copié. On révoque tout ce que
        // ce client détient (OAuth 2.1, rotation des jetons). Écrit avant de refuser.
        db.prepare("UPDATE jetons SET etat = 'revoque' WHERE client_id = ?").run(client.client_id);
        return null;
      }
      if (ligne.etat !== "valide" || ligne.expire < this.horloge()) return null;
      return ligne;
    });
    if (!verdict) throw new InvalidGrantError("refresh token does not exist");
    const siennes = verdict.portees.split(" ");
    const voulues = portees?.length ? portees : siennes;
    for (const p of voulues) if (!siennes.includes(p)) throw new InvalidScopeError(`cannot request scope \`${p}\` not provided by refresh token`);
    return this.avec((db) => {
      db.prepare("UPDATE jetons SET etat = 'utilise' WHERE empreinte = ?").run(verdict.empreinte);
      return this.emettre(db, client.client_id, voulues, verdict.ressource);
    });
  }

  async verifyAccessToken(jeton: string): Promise<AuthInfo> {
    const ligne = this.avec((db) => db.prepare("SELECT * FROM jetons WHERE empreinte = ? AND sorte = 'acces'").get(empreinteDe(jeton))) as Jeton | undefined;
    if (!ligne || ligne.etat !== "valide" || ligne.expire < this.horloge()) throw new InvalidTokenError("Invalid token");
    return {
      token: jeton,
      clientId: ligne.client_id,
      scopes: ligne.portees.split(" "),
      expiresAt: Math.trunc(ligne.expire),
      ...(ligne.ressource ? { resource: new URL(ligne.ressource) } : {}),
      extra: { iss: this.emetteur, subject: "awa" },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, demande: OAuthTokenRevocationRequest): Promise<void> {
    this.avec((db) => db.prepare("UPDATE jetons SET etat = 'revoque' WHERE empreinte = ? AND client_id = ?").run(empreinteDe(demande.token), client.client_id));
  }

  /** Révoque tous les jetons : à faire si le téléphone d'Awa est perdu. Rend le nombre révoqué. */
  deconnecterTout(): number {
    return Number(this.avec((db) => db.prepare("UPDATE jetons SET etat = 'revoque' WHERE etat = 'valide'").run().changes));
  }
}

// ---------- Les pages ----------------------------------------------------------------------------

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem;line-height:1.5}" +
  "button{font-size:1rem;padding:.6rem 1rem;margin:.3rem .3rem 0 0}input{font-size:1rem;padding:.5rem;width:100%}" +
  ".alerte{background:#fde8e8;padding:.6rem;border-radius:.4rem}.note{background:#fff6dd;padding:.6rem;border-radius:.4rem}";

type Page = { redirection: string } | { html: string; statut: number; entetes: Record<string, string> };

/** html.escape de Python : avec les guillemets (attributs), ou sans (un texte entre deux balises). */
function echapper(texte: string, guillemets = true): string {
  const s = texte.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return guillemets ? s.replaceAll('"', "&quot;").replaceAll("'", "&#x27;") : s;
}

function origine(uri: string): string {
  const u = new URL(uri);
  return `${u.protocol}//${u.host}`;
}

function pageHtml(titre: string, corps: string, statut = 200, retour?: string): Page {
  // form-action s'applique aussi à la redirection qui suit l'envoi du formulaire : sans l'origine de l'adresse
  // de retour, le navigateur bloquerait le retour vers Claude (constaté pendant l'essai de la version Python).
  const action = "'self'" + (retour ? ` ${origine(retour)}` : "");
  const html =
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" ` +
    `content="width=device-width,initial-scale=1"><title>${echapper(titre)}</title><style>${STYLE}</style>` +
    `</head><body><h1>${echapper(titre)}</h1>${corps}</body></html>`;
  return {
    html,
    statut,
    entetes: { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${action}` },
  };
}

function pageAccord(identifiant: string, client: OAuthClientInformationFull | undefined, params: Demande, erreur = "", statut = 200): Page {
  const texte = (s: string): string => echapper(s, false); // un texte entre deux balises : < > & suffisent
  const nom = texte(client?.client_name || "Une application");
  let corps =
    `<p><strong>${nom}</strong> demande l'accès à votre Comptoir : lire vos commandes, votre stock et vos ` +
    `ventes, et corriger le stock avec votre accord.</p><p>Après votre réponse, vous reviendrez sur ` +
    `<strong>${texte(analyser(params.redirect_uri)?.hostname ?? "")}</strong>.</p>`;
  if (locale(params.redirect_uri)) {
    corps += '<p class="note">Le retour se fait sur cet ordinateur. N\'acceptez que si vous venez de lancer vous-même la connexion, par exemple depuis Claude Code.</p>';
  }
  if (erreur) corps += `<p class="alerte">${texte(erreur)}</p>`;
  corps +=
    `<form method="post"><input type="hidden" name="demande" value="${echapper(identifiant)}">` +
    '<label>Votre mot de passe du Comptoir<input type="password" name="mot_de_passe" ' +
    'autocomplete="current-password" autofocus></label>' +
    '<button name="decision" value="autoriser">Autoriser</button>' +
    '<button name="decision" value="refuser">Refuser</button></form>';
  return pageHtml("Comptoir pour Awa", corps, statut, params.redirect_uri);
}

// ---------- Administration -------------------------------------------------------------------------

/** getpass.getpass : lit une ligne sans l'afficher (au clavier ; d'un tube, telle quelle). */
async function lireSansEcho(question: string): Promise<string> {
  process.stderr.write(question);
  const entree = process.stdin;
  if (!entree.isTTY) {
    const morceaux: Buffer[] = [];
    for await (const m of entree) morceaux.push(m as Buffer);
    return Buffer.concat(morceaux).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  entree.setRawMode(true);
  return new Promise((resoudre) => {
    let saisi = "";
    const lire = (morceau: Buffer): void => {
      for (const c of morceau.toString("utf8")) {
        if (c === "\r" || c === "\n") {
          entree.setRawMode(false);
          entree.off("data", lire);
          entree.pause();
          process.stderr.write("\n");
          resoudre(saisi);
          return;
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        saisi = c === "\u007f" || c === "\b" ? saisi.slice(0, -1) : saisi + c;
      }
    };
    entree.on("data", lire);
    entree.resume();
  });
}

function arreter(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "hacher") {
    const motDePasse = await lireSansEcho("Mot de passe d'Awa (il ne s'affiche pas) : ");
    if ([...motDePasse].length < 12) arreter("Au moins 12 caractères.");
    console.log(hacher(motDePasse));
  } else if (args[0] === "deconnecter-tout" && args.length === 2) {
    // Téléphone perdu, mot de passe changé : toutes les applications devront se reconnecter.
    const base = args[1]!;
    if (!existsSync(base) || !statSync(base).isFile()) arreter(`Base introuvable : ${base}`);
    const db = new DatabaseSync(base);
    try {
      const n = db.prepare("UPDATE jetons SET etat = 'revoque' WHERE etat = 'valide'").run().changes;
      console.log(`${n} jeton(s) révoqué(s).`);
    } finally {
      db.close();
    }
  } else {
    arreter("Usage : npx tsx ch16/autorisation.ts hacher\n        npx tsx ch16/autorisation.ts deconnecter-tout <base des jetons>");
  }
}

if (estLance(import.meta.url)) await main();
