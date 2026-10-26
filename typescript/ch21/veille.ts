// Chapitre 21 : la veille du Comptoir. Ce qui change chez Anthropic sans que le code du Comptoir bouge.
//
// Depuis le dossier typescript/ :
//     npx tsx ch21/veille.ts                   (gratuit : l'API Models ne génère rien et ne consomme aucun token)
//     npx tsx ch21/veille.ts --horizon 180     (alerte si un modèle utilisé est retiré dans les 180 jours)
//
// Trois questions, chaque semaine, dans la CI :
// 1. Les modèles que le Comptoir appelle sont-ils toujours actifs, et jusqu'à quand ? Deux sources, croisées :
//    la page Model deprecations (l'état publié, la date de retrait ou « pas avant… ») et l'API Models (ce que la
//    clé voit). Le 22 octobre 2026, l'API disait « active » pour un modèle que la page annonçait retiré le
//    30 novembre : une seule source n'aurait pas suffi. Anthropic prévient au moins 60 jours avant le retrait
//    d'un modèle publié.
// 2. Le SDK installé est-il à jour ? sdk-versions.json donne la dernière version de chaque SDK. Une version
//    majeure de plus veut dire une nouvelle version de l'API : la 1.0.0 du SDK TypeScript est passée à l'API
//    2026-10-21 (son journal des changements), comme la 2.0.0 du SDK Python.
// 3. Quelle version de l'API le Comptoir envoie-t-il (en-tête anthropic-version) ?
//
// Le code de sortie vaut 1 s'il y a une alerte : le job planifié de la CI échoue, et quelqu'un regarde.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { RACINE, estLance } from "../comptoir/lancement.ts";

export const PAGE_DES_RETRAITS = "https://platform.claude.com/docs/en/about-claude/model-deprecations.md";
export const VERSIONS_DES_SDK = "https://platform.claude.com/docs/sdk-versions.json";
const AGENT = { "User-Agent": "comptoir-veille/1.0" }; // le site refuse certains clients par défaut (403)
const MODELE = /\bclaude-(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?\b/g;
const REGLAGES = ["MODELE", "MODELE_ROUTEUR", "MODELE_DOCUMENTS", "MODELE_AUXILIAIRE", "MODELE_COMPTOIR"] as const;
const LIGNE_DU_TABLEAU = /^\|\s*(claude-[a-z0-9-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/gm;
const JOUR_MS = 86_400_000;

/** Ce que dit la page des retraits pour un modèle. */
export interface Etat {
  etat: string; //               Active, Legacy, Deprecated, Retired
  deprecieLe: string | null;
  retrait: Date | null; //        la date fixée, ou celle avant laquelle il n'y aura pas de retrait
  auPlusTot: boolean; //          « Not sooner than » : une date plancher, pas une date fixée
}

/** Ce que l'API Models rend d'un modèle, dont la veille se sert. */
export interface ModeleVu {
  id: string;
  lifecycle: string;
  retires_at?: string | null;
}

export class Rapport {
  readonly alertes: string[] = [];
  readonly infos: string[] = [];

  texte(): string {
    return [...this.alertes.map((a) => `ALERTE  ${a}`), ...this.infos.map((i) => `        ${i}`)].join("\n") || "Rien à signaler.";
  }
}

const MOIS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** « November 30, 2026 » (strptime "%B %d, %Y"), en UTC ; null si la date ne se lit pas. */
export function lireDate(texte: string): Date | null {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(texte.trim());
  const mois = m ? MOIS.indexOf(m[1]!.toLowerCase()) : -1;
  if (!m || mois < 0) return null;
  const date = new Date(Date.UTC(Number(m[3]), mois, Number(m[2])));
  return date.getUTCDate() === Number(m[2]) ? date : null;
}

/** Le tableau « Model status » de la page des retraits, en Markdown. */
export function etatsPublies(page: string): Record<string, Etat> {
  const etats: Record<string, Etat> = {};
  for (const [, identifiant, etat, deprecie, retrait] of page.replace(/\r\n/g, "\n").matchAll(LIGNE_DU_TABLEAU)) {
    const plancher = retrait!.toLowerCase().startsWith("not sooner than");
    etats[identifiant!] = {
      etat: etat!, deprecieLe: deprecie === "N/A" || deprecie === "" ? null : deprecie!,
      retrait: lireDate(retrait!.replace(/^not sooner than\s+/i, "")), auPlusTot: plancher,
    };
  }
  return etats;
}

export async function telecharger(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(20_000) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** Réglage -> modèle, tels que comptoir/config.ts les lit (variables d'environnement comprises). */
export const modelesEnProduction = (): Record<string, string> => Object.fromEntries(REGLAGES.map((nom) => [nom, config[nom]]));

/** Modèle -> fichiers où il est écrit, hors dépendances, résultats, tests, paquets construits et ce fichier. */
export function modelesDuDepot(racine = RACINE): Record<string, Set<string>> {
  const trouves: Record<string, Set<string>> = {};
  const ici = fileURLToPath(import.meta.url);
  for (const f of readdirSync(racine, { recursive: true, withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".ts")) continue;
    const chemin = join(f.parentPath, f.name);
    const relatif = relative(racine, chemin).replaceAll("\\", "/");
    if (/^(node_modules|tests)\//.test(relatif) || relatif.includes("/node_modules/") || relatif.includes("/resultats/") || relatif.includes("/build/") || chemin === ici) continue;
    for (const modele of new Set(readFileSync(chemin, "utf8").match(MODELE) ?? [])) (trouves[modele] ??= new Set()).add(relatif);
  }
  return trouves;
}

/** Le modèle exact, ou la version datée dont l'identifiant est un alias (…-4-5 -> …-4-5-20251001). */
export function chercher<T>(modeles: Record<string, T>, identifiant: string): T | null {
  if (identifiant in modeles) return modeles[identifiant]!;
  const datees = Object.entries(modeles).filter(([i]) => i.startsWith(identifiant + "-"));
  return datees.length === 1 ? datees[0]![1] : null;
}

const jour = (d: Date): string => d.toISOString().slice(0, 10);

/** catalogue : identifiant -> modèle de l'API Models ; publies : la page des retraits (null si injoignable). */
export function examinerModeles(catalogue: Record<string, ModeleVu>, publies: Record<string, Etat> | null, utilises: Record<string, string>, horizonJ: number, maintenant: Date): Rapport {
  const rapport = new Rapport();
  if (publies === null) rapport.alertes.push("Page des retraits injoignable : seule l'API Models a été lue");
  for (const identifiant of [...new Set(Object.values(utilises))].sort()) {
    const ou = Object.keys(utilises).filter((k) => utilises[k] === identifiant).sort().join(", ");
    const api = chercher(catalogue, identifiant);
    const page = chercher(publies ?? {}, identifiant);
    if (api === null) rapport.alertes.push(`${identifiant} (${ou}) : absent de l'API Models — retiré, ou pas accessible avec cette clé`);
    if (page !== null && page.etat !== "Active") {
      const quand = page.retrait && !page.auPlusTot ? `, retrait le ${jour(page.retrait)}` : "";
      rapport.alertes.push(`${identifiant} (${ou}) : « ${page.etat} » selon la page des retraits${quand}`);
      if (api !== null && api.lifecycle === "active") rapport.alertes.push(`${identifiant} : l'API Models dit encore « active » ; la page fait foi`);
      continue;
    }
    if (api !== null && api.lifecycle !== "active") {
      rapport.alertes.push(`${identifiant} (${ou}) : « ${api.lifecycle} » selon l'API Models`);
      continue;
    }
    const retrait = api?.retires_at ? new Date(api.retires_at) : page && !page.auPlusTot ? page.retrait : null;
    if (retrait && retrait.getTime() - maintenant.getTime() <= horizonJ * JOUR_MS) {
      rapport.alertes.push(`${identifiant} (${ou}) : retrait le ${jour(retrait)}, dans ${Math.floor((retrait.getTime() - maintenant.getTime()) / JOUR_MS)} jours`);
    } else if (api !== null) {
      const plancher = page && page.auPlusTot && page.retrait ? `, pas avant le ${jour(page.retrait)}` : "";
      rapport.infos.push(`${identifiant} (${ou}) : actif${plancher}`);
    }
  }
  return rapport;
}

export const majeure = (version: string): number => Number(version.split(".")[0]);

export function examinerSdk(installee: string, derniere: string | null, versionApi: string): Rapport {
  const rapport = new Rapport();
  if (derniere === null) {
    rapport.alertes.push("Dernière version du SDK inconnue : sdk-versions.json injoignable");
  } else if (majeure(derniere) > majeure(installee)) {
    rapport.alertes.push(
      `SDK @anthropic-ai/sdk ${installee} installé, ${derniere} disponible : une version majeure de plus, ` +
        "donc une nouvelle version de l'API. Lire le guide de migration avant de changer.",
    );
  } else if (derniere !== installee) {
    rapport.infos.push(`SDK @anthropic-ai/sdk ${installee} installé, ${derniere} disponible (même version majeure)`);
  } else {
    rapport.infos.push(`SDK @anthropic-ai/sdk ${installee} : à jour`);
  }
  rapport.infos.push(`Version de l'API envoyée : ${versionApi}`);
  return rapport;
}

/** La version du SDK installée, lue dans son package.json. */
export const versionInstallee = (): string =>
  (JSON.parse(readFileSync(join(RACINE, "node_modules", "@anthropic-ai", "sdk", "package.json"), "utf8")) as { version: string }).version;

/**
 * L'en-tête anthropic-version que le SDK installé envoie par défaut. Aucune requête ne part : le client reçoit
 * un fetch local, qui note les en-têtes et répond lui-même.
 */
export async function versionApiEnvoyee(): Promise<string> {
  let version = "?";
  const client = new Anthropic({
    apiKey: "aucune", maxRetries: 0,
    fetch: async (_url, options) => {
      version = new Headers(options?.headers).get("anthropic-version") ?? "?";
      return Response.json({ data: [], has_more: false, first_id: null, last_id: null });
    },
  });
  await client.models.list();
  return version;
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({ options: { horizon: { type: "string", default: "120" } } }); // jours avant un retrait pour lever une alerte
  const maintenant = new Date();
  const { creerClient } = await import("../comptoir/appel.ts");
  const page = await telecharger(PAGE_DES_RETRAITS);
  const publies = page ? etatsPublies(page) : null;
  const production = modelesEnProduction();
  const catalogue: Record<string, ModeleVu> = {};
  for await (const m of creerClient().models.list()) catalogue[m.id] = m;
  const rapport = examinerModeles(catalogue, publies, production, Number(args.horizon), maintenant);
  const versions = await telecharger(VERSIONS_DES_SDK);
  const sdk = examinerSdk(versionInstallee(), versions ? ((JSON.parse(versions) as Record<string, string>).typescript ?? null) : null, await versionApiEnvoyee());
  const date = jour(maintenant).split("-").reverse().join("/"); // 22/10/2026, en UTC
  console.log(`Veille du ${date}\n\nModèles du Comptoir en production :\n${rapport.texte()}\n`);
  console.log("SDK et API :\n" + sdk.texte() + "\n");
  const enProduction = new Set(Object.values(production));
  const autres = Object.entries(modelesDuDepot()).filter(([m]) => !enProduction.has(m)).sort(([a], [b]) => (a < b ? -1 : 1));
  if (autres.length) {
    console.log("Autres modèles écrits dans le dépôt (scripts des chapitres, comparaisons) :");
    for (const [modele, fichiers] of autres) {
      const etat = chercher(publies ?? {}, modele);
      console.log(`        ${modele} (${etat ? etat.etat : "état inconnu"}) : ${[...fichiers].sort().join(", ")}`);
    }
  }
  return rapport.alertes.length || sdk.alertes.length ? 1 : 0;
}

if (estLance(import.meta.url)) process.exitCode = await main();
