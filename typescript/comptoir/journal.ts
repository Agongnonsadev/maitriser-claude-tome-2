// Noter chaque appel dans un journal : de quoi retrouver une requête et suivre les coûts (chapitre 2).
//
// Une ligne JSON par appel, au même format que la version Python : un même tableau de bord lit les
// deux. On y met l'identifiant de la requête (à donner au support d'Anthropic en cas de problème), le
// modèle, les tokens et le coût. Jamais la clé d'API, jamais le contenu des messages des clients.
//
// Depuis le chapitre 8, chaque ligne peut aussi porter de quoi analyser les échecs : la raison de
// l'arrêt, la durée, le code de l'erreur et son origine, la conversation.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { arrondir } from "./arrondi.ts";
import { config } from "./config.ts";
import type { Cout } from "./couts.ts";

/** Ce qu'une ligne peut porter en plus ; les valeurs nulles ou absentes ne sont pas écrites. */
export type Details = Record<string, unknown>;

/** La date en UTC, à la seconde, comme Python l'écrit : 2026-10-22T08:15:00+00:00. */
const maintenant = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

function ecrire(ligne: Record<string, unknown>, chemin?: string): Record<string, unknown> {
  const fichier = chemin ?? config.JOURNAL;
  mkdirSync(dirname(fichier), { recursive: true });
  appendFileSync(fichier, JSON.stringify(ligne) + "\n", "utf8");
  return ligne;
}

function ajouter(ligne: Record<string, unknown>, details: Details): Record<string, unknown> {
  for (const [cle, valeur] of Object.entries(details)) if (valeur !== null && valeur !== undefined) ligne[cle] = valeur;
  return ligne;
}

/**
 * Note un appel. cout=null : l'appel n'est pas allé au bout (flux coupé, erreur). Son coût réel n'est
 * pas connu du code ; la Console fait foi.
 *
 * details : prompt (version et empreinte du prompt système, chapitre 5), et depuis le chapitre 8
 * stop_reason, duree_ms, erreur, origine, client…
 */
export function noter(
  identifiant: string | null | undefined,
  modele: string,
  cout: Cout | null,
  { prompt, ...details }: Details = {},
  chemin?: string,
): Record<string, unknown> {
  const ligne: Record<string, unknown> = {
    date: maintenant(),
    requete: identifiant ?? null,
    modele,
    prompt: prompt ?? null,
    tokens_entree: cout ? cout.entree : null,
    tokens_ecriture_cache: cout ? cout.ecritureCache : null,
    tokens_lecture_cache: cout ? cout.lectureCache : null,
    tokens_sortie: cout ? cout.sortie : null,
    tokens_reflexion: cout ? cout.reflexion : null,
    cout_dollars: cout ? arrondir(cout.dollars, 6) : null,
  };
  if (cout?.recherches) ligne.recherches_web = cout.recherches; // chapitre 10
  if (!cout) ligne.interrompu = true;
  return ecrire(ajouter(ligne, details), chemin);
}

/** Un événement sans appel à l'API : un message refusé par le budget, par exemple. */
export function noterEvenement(evenement: string, details: Details = {}, chemin?: string): Record<string, unknown> {
  return ecrire(ajouter({ date: maintenant(), evenement }, details), chemin);
}
