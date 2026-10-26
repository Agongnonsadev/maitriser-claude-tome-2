// Comptoir pour Awa : le serveur MCP de Délices d'Awa (chapitre 15).
//
// Awa le branche dans son application Claude, comme extension de bureau ; Yao, dans Claude Code. Ce que
// Claude peut faire avec :
// - lire : les commandes d'un jour, le stock, les ventes d'une semaine, une commande, le catalogue ;
// - préparer : un bilan du soir, un inventaire (deux prompts qu'Awa choisit) ;
// - écrire, une seule chose : corriger le stock après un inventaire, en deux temps. preparer_correction
//   montre l'écart et rend un jeton ; appliquer_correction n'accepte que ce jeton, une seule fois, dans les
//   dix minutes, et seulement si le stock n'a pas bougé entre-temps. Entre les deux, Awa dit oui.
//
// Le module ne dépend que de Node, du SDK MCP et de Zod : ch15/construire_extension.ts en fait un seul
// fichier, que l'application lance avec son propre Node. Configuration, par l'environnement :
//   COMPTOIR_BOUTIQUE    chemin de la base SQLite de la boutique (obligatoire)
//   COMPTOIR_CATALOGUE   chemin du catalogue JSON (par défaut : catalogue.json à côté de ce fichier, sinon
//                        python/comptoir/donnees/delices_awa.json du dépôt)
//   COMPTOIR_AUJOURDHUI  date du jour, AAAA-MM-JJ, pour les démonstrations (facultatif)
//
// Lancement : npx tsx ch15/comptoir_pour_awa.ts  (stdio). Rien n'est écrit sur la sortie standard, qui
// appartient au protocole : le journal va sur la sortie d'erreur. Les textes et les schémas annoncés sont ceux
// de la version Python (ch15/schemas.ts).

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { arrondir } from "../comptoir/arrondi.ts";
import { ajouterJours, jourDeLaSemaine, lireDate, lundiDe } from "../comptoir/dates.ts";
import { estLance } from "../comptoir/lancement.ts";
import { jsonPython, separerMots } from "../comptoir/python.ts";
import { INSTRUCTIONS, MODELES_DE_RESSOURCES, OUTILS, PROMPTS, RESSOURCES } from "./schemas.ts";

export const VERSION = "0.1.0";
const DECALAGE_COTONOU = 3600_000; // le Bénin est à UTC+1, sans heure d'été
export const DUREE_JETON_MS = 10 * 60_000;
export const ECART_MAXIMUM = 200; // au-delà, ce n'est plus une correction d'inventaire : Awa le fait elle-même
const SEUILS_BAS: Record<string, number> = { bouteille: 10, flacon: 5 };
const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const ESPACE_FINE = String.fromCodePoint(0x202f); // espace insécable fine, comme en français

/** Une erreur pour Claude : son message lui dit quoi faire (le ToolError de la version Python). */
export class ErreurOutil extends Error {}

/** L'heure qu'il est, en UTC ; les tests la fixent. */
export const horloge = { maintenant: (): Date => new Date() };

/** Le journal, sur la sortie d'erreur, quand le serveur tourne pour de vrai (main). */
let journal: ((message: string) => void) | null = null;

// ---------- Configuration et base -----------------------------------------------------------

function cheminBase(): string {
  const brut = (process.env.COMPTOIR_BOUTIQUE ?? "").trim();
  if (!brut || brut.includes("${")) {
    throw new ErreurOutil("Aucune base de la boutique n'est réglée. Dans les réglages de l'extension Comptoir pour Awa, choisissez le fichier « Base de la boutique ».");
  }
  if (!existsSync(brut) || !statSync(brut).isFile()) {
    throw new ErreurOutil(`La base de la boutique est introuvable : ${brut}. Vérifiez le réglage « Base de la boutique » de l'extension, ou demandez le bon fichier à Yao.`);
  }
  return brut;
}

export function ouvrir(): DatabaseSync {
  const db = new DatabaseSync(cheminBase());
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

/** Les écritures d'un bloc, ensemble ou pas du tout (le with db: de Python). */
function enTransaction<T>(db: DatabaseSync, travail: () => T): T {
  db.exec("BEGIN");
  try {
    const resultat = travail();
    db.exec("COMMIT");
    return resultat;
  } catch (erreur) {
    db.exec("ROLLBACK");
    throw erreur;
  }
}

export interface Produit {
  nom: string;
  format: string;
  prix_fcfa: number;
}
export interface Catalogue {
  produits: Produit[];
  conditions: string[];
}

const ICI = dirname(fileURLToPath(import.meta.url));

export function catalogue(): Catalogue {
  const candidats = [(process.env.COMPTOIR_CATALOGUE ?? "").trim(), join(ICI, "catalogue.json"), join(ICI, "..", "..", "python", "comptoir", "donnees", "delices_awa.json")];
  for (const c of candidats) if (c && existsSync(c) && statSync(c).isFile()) return JSON.parse(readFileSync(c, "utf8")) as Catalogue;
  throw new ErreurOutil("Le catalogue de Délices d'Awa est introuvable : réinstallez l'extension.");
}

/** Une heure, comme Cotonou la lit : le jour (AAAA-MM-JJ) et l'heure (« 09 h 15 »). */
export interface HeureLocale {
  jour: string;
  heure: string;
}

function local(instant: Date): HeureLocale {
  const d = new Date(instant.getTime() + DECALAGE_COTONOU);
  const deux = (n: number): string => String(n).padStart(2, "0");
  return { jour: d.toISOString().slice(0, 10), heure: `${deux(d.getUTCHours())} h ${deux(d.getUTCMinutes())}` };
}

export function aujourdhui(): string {
  const forcee = (process.env.COMPTOIR_AUJOURDHUI ?? "").trim();
  if (forcee && !forcee.includes("${")) {
    const jour = lireDate(forcee);
    if (jour === null) throw new Error(`Invalid isoformat string: '${forcee}'`);
    return jour;
  }
  return local(horloge.maintenant()).jour;
}

// ---------- Mise en forme pour Awa ----------------------------------------------------------

/** 12500 -> « 12 500 FCFA » (espace insécable fine, comme en français). */
export const fcfa = (montant: number): string => `${String(montant).replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE_FINE)} FCFA`;

export function jourEnToutesLettres(jour: string): string {
  const [annee, mois, quantieme] = jour.split("-").map(Number) as [number, number, number];
  return `${JOURS[jourDeLaSemaine(jour)]} ${quantieme}${quantieme === 1 ? "er" : ""} ${MOIS[mois - 1]} ${annee}`;
}

/** « Larissa Noudéhou » -> « Larissa N. » : assez pour livrer, sans le nom complet. */
export function clientDiscret(nom: string): string {
  const morceaux = separerMots(nom);
  return morceaux.length === 1 ? morceaux[0]! : `${morceaux[0]} ${[...morceaux.at(-1)!][0]}.`;
}

// ---------- Lectures ------------------------------------------------------------------------

export interface LigneDeCommande {
  produit: string;
  quantite: number;
  prix_unitaire: number;
}

export interface Commande {
  numero: string;
  quand: HeureLocale;
  client: string;
  quartier: string;
  lignes: LigneDeCommande[];
  frais: number;
  total: number;
}

export function commandes(db: DatabaseSync): Commande[] {
  const lignes = db
    .prepare(
      "SELECT c.id, c.cree_le, c.total, r.nom_client, r.quartier, r.lignes, r.frais_livraison " +
        "FROM commandes c JOIN recapitulatifs r ON r.id = c.recapitulatif ORDER BY c.cree_le",
    )
    .all() as { id: string; cree_le: string; total: number; nom_client: string; quartier: string; lignes: string; frais_livraison: number }[];
  // Les dates de la base, en heure de Cotonou, quel que soit le fuseau où elles ont été écrites.
  return lignes.map((l) => ({
    numero: l.id,
    quand: local(new Date(l.cree_le)),
    client: clientDiscret(l.nom_client),
    quartier: l.quartier,
    lignes: JSON.parse(l.lignes) as LigneDeCommande[],
    frais: l.frais_livraison,
    total: l.total,
  }));
}

const produits = (c: Catalogue): Map<string, Produit> => new Map(c.produits.map((p) => [p.nom, p]));
const unite = (p: Produit): string => (p.format.includes("bouteille") ? "bouteille" : "flacon");
const somme = (valeurs: number[]): number => valeurs.reduce((a, b) => a + b, 0);

export function lireCommandesDuJour(db: DatabaseSync, jour: string) {
  const duJour = commandes(db).filter((c) => c.quand.jour === jour);
  const liste = duJour.map((c) => ({
    numero: c.numero,
    heure: c.quand.heure,
    client: c.client,
    quartier: c.quartier,
    produits: c.lignes.map((l) => `${l.quantite} × ${l.produit}`).join(", "),
    total_fcfa: c.total,
  }));
  const total = somme(duJour.map((c) => c.total));
  const quand = jourEnToutesLettres(jour);
  const resume = duJour.length ? `${duJour.length} commande${duJour.length > 1 ? "s" : ""} le ${quand}, pour ${fcfa(total)}.` : `Aucune commande le ${quand}.`;
  return { jour, nombre: duJour.length, total_fcfa: total, commandes: liste, resume };
}

export function lireStock(db: DatabaseSync, c: Catalogue) {
  const quantites = new Map((db.prepare("SELECT produit, quantite FROM stock").all() as { produit: string; quantite: number }[]).map((l) => [l.produit, l.quantite]));
  const lignes = [...produits(c)].map(([nom, produit]) => {
    const quantite = quantites.get(nom) ?? 0;
    const etat = quantite === 0 ? "rupture" : quantite < SEUILS_BAS[unite(produit)]! ? "bas" : "suffisant";
    return { produit: nom, format: produit.format, quantite, etat };
  });
  const ruptures = lignes.filter((l) => l.etat === "rupture").map((l) => l.produit);
  const bas = lignes.filter((l) => l.etat === "bas").map((l) => `${l.produit} (${l.quantite})`);
  const morceaux: string[] = [];
  if (ruptures.length) morceaux.push("En rupture : " + ruptures.join(", ") + ".");
  if (bas.length) morceaux.push("Stock bas : " + bas.join(", ") + ".");
  return { produits: lignes, resume: morceaux.join(" ") || "Tous les produits sont en stock." };
}

export function lireVentesSemaine(db: DatabaseSync, _c: Catalogue, unJour: string) {
  const lundi = lundiDe(unJour);
  const dimanche = ajouterJours(lundi, 6);
  const toutes = commandes(db);
  const semaine = toutes.filter((c) => lundi <= c.quand.jour && c.quand.jour <= dimanche);
  const precedente = toutes.filter((c) => ajouterJours(lundi, -7) <= c.quand.jour && c.quand.jour < lundi);
  const quantites = new Map<string, number>();
  const montants = new Map<string, number>();
  for (const c of semaine) {
    for (const l of c.lignes) {
      quantites.set(l.produit, (quantites.get(l.produit) ?? 0) + l.quantite);
      montants.set(l.produit, (montants.get(l.produit) ?? 0) + l.quantite * l.prix_unitaire);
    }
  }
  // Par quantité décroissante ; à quantité égale, l'ordre d'apparition (le tri est stable, comme en Python).
  const parProduit = [...quantites.keys()].sort((a, b) => quantites.get(b)! - quantites.get(a)!).map((p) => ({ produit: p, quantite: quantites.get(p)!, montant_fcfa: montants.get(p)! }));
  const total = somme(semaine.map((c) => c.total));
  const avant = somme(precedente.map((c) => c.total));
  let evolution = "";
  if (avant) {
    const variation = arrondir((100 * (total - avant)) / avant);
    evolution = ` (${variation >= 0 ? "+" : ""}${variation} % par rapport à la semaine précédente)`;
  }
  const meilleur = parProduit.length ? ` Le plus vendu : ${parProduit[0]!.produit}, ${parProduit[0]!.quantite}.` : "";
  const resume = `Du ${jourEnToutesLettres(lundi)} au ${jourEnToutesLettres(dimanche)} : ${semaine.length} commandes, ${fcfa(total)}${evolution}.${meilleur}`;
  return { du: lundi, au: dimanche, commandes: semaine.length, total_fcfa: total, par_produit: parProduit, semaine_precedente_fcfa: avant, resume };
}

// ---------- La seule écriture : corriger le stock -------------------------------------------

export const TABLE_CORRECTIONS = `CREATE TABLE IF NOT EXISTS corrections_stock (
    jeton TEXT PRIMARY KEY, produit TEXT NOT NULL, avant INTEGER NOT NULL, apres INTEGER NOT NULL,
    preparee_le TEXT NOT NULL, statut TEXT NOT NULL, appliquee_le TEXT)`;

/** datetime.isoformat() d'un instant UTC : « 2026-10-21T07:00:00+00:00 ». */
function isoformat(instant: Date): string {
  const ms = instant.getUTCMilliseconds();
  return instant.toISOString().replace(/\.\d{3}Z$/, ms ? `.${String(ms).padStart(3, "0")}000+00:00` : "+00:00");
}

const stockDe = (db: DatabaseSync, produit: string): number =>
  ((db.prepare("SELECT quantite FROM stock WHERE produit = ?").get(produit) as { quantite: number } | undefined) ?? { quantite: 0 }).quantite;

export function preparer(db: DatabaseSync, c: Catalogue, produit: string, quantiteComptee: number, maintenant: Date) {
  if (!produits(c).has(produit)) throw new ErreurOutil(`« ${produit} » n'est pas au catalogue. Produits : ${[...produits(c).keys()].join(", ")}.`);
  const actuel = stockDe(db, produit);
  const ecart = quantiteComptee - actuel;
  if (Math.abs(ecart) > ECART_MAXIMUM) {
    throw new ErreurOutil(`L'écart serait de ${ecart} pour ${produit} : c'est trop pour une correction d'inventaire. Vérifiez le comptage ; pour un réassort, Awa passe par l'écran du Comptoir.`);
  }
  // Le jeton est enregistré dans la base, pas en mémoire : il survit à un redémarrage du serveur, et un
  // serveur distant sans état (chapitre 16) le retrouvera de la même façon.
  const jeton = randomBytes(4).toString("hex");
  enTransaction(db, () => {
    db.exec(TABLE_CORRECTIONS);
    db.prepare("INSERT INTO corrections_stock VALUES (?, ?, ?, ?, ?, 'preparee', NULL)").run(jeton, produit, actuel, quantiteComptee, isoformat(maintenant));
  });
  const fin = local(new Date(maintenant.getTime() + DUREE_JETON_MS));
  let dire: string;
  if (ecart === 0) dire = `Le stock de ${produit} est déjà de ${actuel} : rien à corriger.`;
  else {
    const sens = ecart > 0 ? "de plus" : "de moins";
    dire = `Le Comptoir compte ${actuel} pour ${produit} ; vous en avez compté ${quantiteComptee}, soit ${Math.abs(ecart)} ${sens}. Voulez-vous que le stock passe à ${quantiteComptee} ?`;
  }
  return { produit, stock_actuel: actuel, quantite_comptee: quantiteComptee, ecart, jeton, valable_jusqu_a: fin.heure, a_dire_a_awa: dire };
}

export function appliquer(db: DatabaseSync, jeton: string, maintenant: Date) {
  db.exec(TABLE_CORRECTIONS);
  const ligne = db.prepare("SELECT * FROM corrections_stock WHERE jeton = ?").get(jeton.trim()) as
    | { jeton: string; produit: string; avant: number; apres: number; preparee_le: string; statut: string }
    | undefined;
  if (!ligne || ligne.statut !== "preparee") {
    throw new ErreurOutil("Ce jeton est inconnu ou a déjà servi. Préparez une nouvelle correction avec preparer_correction et montrez l'écart à Awa.");
  }
  if (maintenant.getTime() - new Date(ligne.preparee_le).getTime() > DUREE_JETON_MS) {
    enTransaction(db, () => db.prepare("UPDATE corrections_stock SET statut = 'expiree' WHERE jeton = ?").run(ligne.jeton));
    throw new ErreurOutil("Ce jeton a expiré (10 minutes). Préparez à nouveau la correction et redemandez l'accord d'Awa.");
  }
  // Comme le with db: de Python : une erreur dans le bloc annule tout ce qu'il a écrit, la marque
  // « perimee » comprise.
  enTransaction(db, () => {
    const actuel = stockDe(db, ligne.produit);
    if (actuel !== ligne.avant) {
      db.prepare("UPDATE corrections_stock SET statut = 'perimee' WHERE jeton = ?").run(ligne.jeton);
      throw new ErreurOutil(`Le stock de ${ligne.produit} a changé depuis la préparation (${ligne.avant} → ${actuel}, une vente sans doute). Préparez une nouvelle correction.`);
    }
    db.prepare("INSERT OR REPLACE INTO stock VALUES (?, ?)").run(ligne.produit, ligne.apres);
    db.prepare("UPDATE corrections_stock SET statut = 'appliquee', appliquee_le = ? WHERE jeton = ?").run(isoformat(maintenant), ligne.jeton);
  });
  journal?.(`correction appliquée : ${ligne.produit} ${ligne.avant} -> ${ligne.apres}`);
  return { produit: ligne.produit, avant: ligne.avant, apres: ligne.apres, resume: `C'est fait : le stock de ${ligne.produit} est passé de ${ligne.avant} à ${ligne.apres}.` };
}

// ---------- Le serveur MCP ------------------------------------------------------------------

export type Resultat = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Le résultat d'un outil comme le rend la version Python : la sortie structurée, et la même en JSON. */
export async function executer(nom: string, travail: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<Resultat> {
  try {
    const sortie = await travail();
    return { content: [{ type: "text", text: jsonPython(sortie, 2) }], structuredContent: sortie };
  } catch (erreur) {
    return { content: [{ type: "text", text: `Error executing tool ${nom}: ${erreur instanceof Error ? erreur.message : String(erreur)}` }], isError: true };
  }
}

/** Ouvre la base le temps d'un appel, et la referme quoi qu'il arrive. */
export function avecLaBase<T>(travail: (db: DatabaseSync) => T): T {
  const db = ouvrir();
  try {
    return travail(db);
  } finally {
    db.close();
  }
}

const jourDonne = (jour: string | null | undefined): string => (jour ? lireDate(jour)! : aujourdhui());
const ressource = (nom: string) => RESSOURCES.find((r) => r.name === nom) ?? MODELES_DE_RESSOURCES.find((r) => r.name === nom)!;
const prompt = (nom: string) => PROMPTS.find((p) => p.name === nom)!;

/** Un serveur neuf, avec ses cinq outils, ses deux ressources et ses deux prompts. */
export function creerServeur(): McpServer {
  const serveur = new McpServer({ name: "comptoir-pour-awa", title: "Comptoir pour Awa", version: VERSION }, { instructions: INSTRUCTIONS });
  enregistrer(serveur);
  return serveur;
}

/**
 * Déclare sur un serveur les outils, les ressources et les prompts du Comptoir, sauf ceux de `sauf` : le
 * serveur en ligne du chapitre 16 reprend tout, au caractère près, et redéfinit appliquer_correction.
 */
export function enregistrer(serveur: McpServer, sauf: string[] = []): void {
  const declarer = <A extends Record<string, unknown>>(nom: keyof typeof OUTILS, travail: (args: A) => Record<string, unknown>): void => {
    if (sauf.includes(nom)) return;
    const o = OUTILS[nom];
    serveur.registerTool(
      nom,
      {
        title: o.title,
        description: o.description,
        inputSchema: z.fromJSONSchema(o.entree as never) as z.ZodObject,
        outputSchema: z.fromJSONSchema(o.sortie as never) as z.ZodObject,
        annotations: o.annotations,
        ...("_meta" in o ? { _meta: o._meta } : {}),
      },
      (async (args: A) => executer(nom, () => travail(args))) as never,
    );
  };

  declarer<{ jour?: string | null }>("commandes_du_jour", ({ jour }) => avecLaBase((db) => lireCommandesDuJour(db, jourDonne(jour))));
  declarer("stock", () => avecLaBase((db) => lireStock(db, catalogue())));
  declarer<{ un_jour_de_la_semaine?: string | null }>("ventes_de_la_semaine", ({ un_jour_de_la_semaine: jour }) =>
    avecLaBase((db) => lireVentesSemaine(db, catalogue(), jourDonne(jour))),
  );
  // preparer_correction écrit un projet de correction (le jeton), jamais le stock : elle n'est donc pas « en
  // lecture seule », mais elle ne détruit rien.
  declarer<{ produit: string; quantite_comptee: number }>("preparer_correction", ({ produit, quantite_comptee }) =>
    avecLaBase((db) => preparer(db, catalogue(), produit, quantite_comptee, horloge.maintenant())),
  );
  // Claude Code demande l'accord de la personne à chaque appel, quel que soit le mode de permission
  // (_meta « anthropic/requiresUserInteraction », dans ch15/schemas.ts).
  declarer<{ jeton: string }>("appliquer_correction", ({ jeton }) => avecLaBase((db) => appliquer(db, jeton, horloge.maintenant())));

  const r = ressource("catalogue");
  serveur.registerResource("catalogue", "comptoir://catalogue", { title: r.title, description: r.description, mimeType: r.mimeType }, async (uri) => {
    const c = catalogue();
    const lignes = ["# Délices d'Awa : catalogue", "", ...c.produits.map((p) => `- ${p.nom} (${p.format}) : ${fcfa(p.prix_fcfa)}`), "", "## Conditions", "", ...c.conditions.map((condition) => `- ${condition}`)];
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: lignes.join("\n") }] };
  });

  const m = ressource("une_commande");
  serveur.registerResource(
    "une_commande",
    new ResourceTemplate("comptoir://commande/{numero}", { list: undefined }),
    { title: m.title, description: m.description, mimeType: m.mimeType },
    async (uri, { numero }) =>
      avecLaBase((db) => {
        const c = commandes(db).find((x) => x.numero === numero);
        if (!c) throw new ErreurOutil(`Aucune commande ne porte le numéro ${numero}.`);
        const lignes = [
          `# Commande ${c.numero}`,
          "",
          `- Date : ${jourEnToutesLettres(c.quand.jour)}, ${c.quand.heure}`,
          `- Client : ${c.client}, ${c.quartier}`,
          ...c.lignes.map((l) => `- ${l.quantite} × ${l.produit} à ${fcfa(l.prix_unitaire)}`),
          `- Livraison : ${c.frais ? fcfa(c.frais) : "offerte"}`,
          `- Total : ${fcfa(c.total)}`,
        ];
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: lignes.join("\n") }] };
      }),
  );

  const bilan = prompt("bilan_du_soir");
  serveur.registerPrompt("bilan_du_soir", { title: bilan.title, description: bilan.description, argsSchema: { jour: z.string().optional() } }, ({ jour }) => {
    const quand = jour ? `du ${jour}` : "d'aujourd'hui";
    const texte =
      `Fais-moi le bilan du soir ${quand}, en cinq lignes au plus : le nombre de commandes et le total ` +
      "(outil commandes_du_jour), les produits en rupture ou en stock bas (outil stock), et ce que je " +
      "dois préparer ou commander pour demain. Donne les chiffres tels que les outils les rendent. Ne " +
      "modifie rien.";
    return { description: bilan.description, messages: [{ role: "user", content: { type: "text", text: texte } }] };
  });

  const inventaire = prompt("inventaire");
  serveur.registerPrompt("inventaire", { title: inventaire.title, description: inventaire.description }, () => ({
    description: inventaire.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Je fais mon inventaire. Pour chaque produit que je te donne avec la quantité comptée, prépare la " +
            "correction (preparer_correction), dis-moi l'écart, et attends que je réponde oui avant de " +
            "l'appliquer. Un produit à la fois. À la fin, résume ce qui a changé.",
        },
      },
    ],
  }));
}

/** Un journal sur la sortie d'erreur, au format de la version Python (logging : date, nom, message). */
export function journalSurLaSortieDErreur(nom: string): (message: string) => void {
  return (message) => {
    const t = new Date();
    const date = new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ",$1");
    console.error(`${date} ${nom} ${message}`);
  };
}

/** Branche le journal du Comptoir (les corrections appliquées) : le serveur en ligne le fait aussi. */
export function brancherJournal(j: ((message: string) => void) | null): void {
  journal = j;
}

async function main(): Promise<void> {
  brancherJournal(journalSurLaSortieDErreur("comptoir_pour_awa"));
  await creerServeur().connect(new StdioServerTransport());
}

// Lancé directement (par tsx, ou une fois empaqueté par l'application), et non importé par un test.
if (estLance(import.meta.url)) await main();
