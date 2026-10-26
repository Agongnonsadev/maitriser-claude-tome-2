// La base de connaissances d'Awa : des documents Markdown, découpés en sections citables (chapitre 11).
//
// Chaque section devient un « morceau » avec un identifiant stable, par exemple
// kb://faq#etes-vous-ouverts-le-dimanche. Ces identifiants reviennent dans les citations : on sait d'où
// vient chaque affirmation, et le test le vérifie.
//
// La même base sert deux usages : entière dans le contexte, mise en cache ; ou par morceaux choisis par
// une recherche, quand elle devient trop grande. Les documents sont ceux de la version Python
// (python/comptoir/connaissances/), lus sur place.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "./lancement.ts";

export const DOSSIER = join(PYTHON, "comptoir", "connaissances");
export const TAILLE_MAX = 1200; // caractères par morceau ; au-delà, une section est coupée entre deux paragraphes

export interface Morceau {
  identifiant: string; // kb://<document>#<section>, stable tant que le titre ne change pas
  document: string; //   le nom du fichier, sans extension
  titre: string; //      « Questions fréquentes — Êtes-vous ouverts le dimanche ? »
  texte: string;
  contexte: string; //   une phrase qui situe le morceau dans son document (Contextual Retrieval)
}

/** Ce que les index lisent : le contexte s'il existe, le titre, puis le texte. */
export const pourLaRecherche = (m: Morceau): string => [m.contexte, m.titre, m.texte].filter(Boolean).join(" ");

/** « Êtes-vous ouverts le dimanche ? » -> « etes-vous-ouverts-le-dimanche ». */
export function ancre(titre: string): string {
  const sansAccents = titre.normalize("NFD").replace(/[^\x00-\x7f]/g, "");
  return sansAccents.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const paragraphes = (texte: string): string[] => texte.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * Une section « ## » par morceau. Une section trop longue est coupée entre deux paragraphes, et chaque
 * partie reprend le dernier paragraphe de la précédente : une phrase coupée de son contexte se retrouve
 * mal.
 */
export function decouper(markdown: string, document: string, tailleMax = TAILLE_MAX): Morceau[] {
  const texte = markdown.replace(/\r\n/g, "\n");
  const titreDocument = /^# (.+)$/m.exec(texte)![1]!.trim();
  const morceaux: Morceau[] = [];
  for (const section of texte.split(/^## /m).slice(1)) {
    const fin = section.indexOf("\n");
    const titre = (fin < 0 ? section : section.slice(0, fin)).trim();
    const corps = fin < 0 ? "" : section.slice(fin + 1);
    const parties: string[][] = [];
    let courante: string[] = [];
    for (const p of paragraphes(corps)) {
      if (courante.length && [...courante, p].join("\n\n").length > tailleMax) {
        parties.push(courante);
        courante = [courante.at(-1)!]; // recouvrement d'un paragraphe
      }
      courante.push(p);
    }
    if (courante.length) parties.push(courante);
    parties.forEach((partie, i) => {
      const suffixe = parties.length > 1 ? `-${i + 1}` : "";
      morceaux.push({
        identifiant: `kb://${document}#${ancre(titre)}${suffixe}`,
        document,
        titre: `${titreDocument} — ${titre}`,
        texte: partie.join("\n\n"),
        contexte: "",
      });
    });
  }
  return morceaux;
}

/**
 * Tous les morceaux, dans un ordre stable : celui des noms de fichiers, puis des sections. L'ordre compte :
 * le cache exige un début de requête identique, octet pour octet.
 */
export function chargerBase(dossier = DOSSIER): Morceau[] {
  const morceaux = readdirSync(dossier)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => decouper(readFileSync(join(dossier, f), "utf8"), f.slice(0, -3)));
  const identifiants = morceaux.map((m) => m.identifiant);
  const doublons = [...new Set(identifiants.filter((id, i) => identifiants.indexOf(id) !== i))].sort();
  if (doublons.length) throw new Error(`Identifiants en double dans la base : ${doublons.join(", ")}`);
  return morceaux;
}

export function avecContextes(morceaux: Morceau[], contextes: Record<string, string>): Morceau[] {
  return morceaux.map((m) => ({ ...m, contexte: contextes[m.identifiant] ?? m.contexte }));
}

export type Cache = boolean | "5m" | "1h";

/** true ou "5m" : cache de 5 minutes ; "1h" : cache d'une heure, écrit deux fois plus cher. */
export function controleCache(cache: Cache): Anthropic.CacheControlEphemeral | null {
  if (!cache) return null;
  return cache === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** Un morceau en bloc search_result : Claude le cite avec notre source et notre titre. */
export function blocResultat(morceau: Morceau, cache: Cache = false, citations = true): Anthropic.SearchResultBlockParam {
  const bloc: Anthropic.SearchResultBlockParam = {
    type: "search_result",
    source: morceau.identifiant,
    title: morceau.titre,
    // Un bloc de texte par paragraphe : le paragraphe est la plus petite unité citable.
    content: paragraphes(morceau.texte).map((p) => ({ type: "text", text: p })),
    citations: { enabled: citations },
  };
  const controle = controleCache(cache);
  if (controle) bloc.cache_control = controle;
  return bloc;
}

/**
 * Les morceaux en blocs search_result. Avec un cache, le point est posé sur le dernier : tout ce qui
 * précède, outils et prompt système compris, est mis en cache ensemble.
 */
export function blocsResultats(morceaux: Morceau[], cache: Cache = false, citations = true): Anthropic.SearchResultBlockParam[] {
  const blocs = morceaux.map((m) => blocResultat(m, false, citations));
  const controle = controleCache(cache);
  if (blocs.length && controle) blocs.at(-1)!.cache_control = controle;
  return blocs;
}
