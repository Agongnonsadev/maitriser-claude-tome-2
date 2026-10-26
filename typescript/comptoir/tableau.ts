// Lire le journal : coûts, modes d'échec, latences, conversations à reprendre (chapitre 8).
//
// Le journal est la trace de chaque appel. Bien lu, il répond aux questions de Yao : combien a coûté la
// journée, qu'est-ce qui échoue et d'où ça vient, qui attend encore une réponse d'Awa. Il a le même
// format que celui de la version Python : ce tableau lit l'un comme l'autre.
//
// Chapitre 19 : le Comptoir en ligne laisse un événement « message » par message, avec le coût de toutes
// ses étapes et sa durée. Le tableau en tire le coût par conversation, la latence vue par le client, le
// taux d'erreur, les événements de sécurité du chapitre 18 et des alertes.

import { existsSync, readFileSync } from "node:fs";
import { arrondir } from "./arrondi.ts";
import { config } from "./config.ts";

/** Une ligne du journal : un appel, ou un événement. */
export type Ligne = Record<string, unknown> & { date: string };

// Ce qui laisse un client sans réponse : Awa doit reprendre la conversation à la main.
export const SANS_REPONSE = new Set(["refus", "hors_budget", "comptage_impossible", "cle_invalide", "facturation", "permission",
  "introuvable", "requete_invalide", "limite_de_depense", "plafond_du_palier", "contexte_plein"]);

// Les événements qui ne sont pas des échecs d'appel : ils ont leur propre rubrique (chapitres 18 et 19).
export const INFORMATIFS = new Set(["message", "etape", "purge", "garde", "limite", "tentative_suspecte", "whatsapp_envoi",
  "whatsapp_signature_invalide", "surveillance"]);

export function charger(chemin: string = config.JOURNAL): Ligne[] {
  if (!existsSync(chemin)) return [];
  return readFileSync(chemin, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Ligne);
}

const nombre = (valeur: unknown): number => (typeof valeur === "number" ? valeur : 0);
const texte = (valeur: unknown): string | null => (typeof valeur === "string" && valeur ? valeur : null);

/** Les entrées d'un compteur, de la plus fréquente à la moins fréquente, comme Counter.most_common(). */
export function plusFrequents<K>(compte: Map<K, number>): [K, number][] {
  return [...compte.entries()].sort((a, b) => b[1] - a[1]);
}

function compter<K>(cles: K[]): Map<K, number> {
  const compte = new Map<K, number>();
  for (const cle of cles) compte.set(cle, (compte.get(cle) ?? 0) + 1);
  return compte;
}

/**
 * Un appel ou un message en erreur, un envoi refusé, ou un événement qui n'est pas une information. Une
 * étape en erreur appartient à un message : elle est comptée avec lui, pas deux fois.
 */
export function estUnEchec(ligne: Ligne): boolean {
  const evenement = texte(ligne.evenement);
  if (evenement === null || evenement === "message" || evenement === "whatsapp_envoi") return Boolean(ligne.erreur);
  return !INFORMATIFS.has(evenement);
}

export interface Jour {
  appels: number;
  dollars: number;
  entree: number;
  sortie: number;
  echecs: number;
}

export function parJour(lignes: Ligne[]): Map<string, Jour> {
  const jours = new Map<string, Jour>();
  for (const ligne of lignes) {
    const cle = ligne.date.slice(0, 10);
    const jour = jours.get(cle) ?? { appels: 0, dollars: 0, entree: 0, sortie: 0, echecs: 0 };
    jours.set(cle, jour);
    if ("evenement" in ligne) {
      jour.echecs += estUnEchec(ligne) ? 1 : 0;
      continue;
    }
    jour.appels += 1;
    jour.dollars += nombre(ligne.cout_dollars);
    jour.entree += nombre(ligne.tokens_entree) + nombre(ligne.tokens_lecture_cache);
    jour.sortie += nombre(ligne.tokens_sortie);
    jour.echecs += ligne.erreur ? 1 : 0;
  }
  return new Map([...jours.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export interface ModeDEchec {
  origine: string; // qui doit agir : le réseau, le service, notre code…
  code: string;
  nombre: number;
}

/** Les échecs par origine et par code, du plus fréquent au moins fréquent. */
export function modesDEchec(lignes: Ligne[]): ModeDEchec[] {
  const compte = compter(
    lignes.filter(estUnEchec).map((l) => `${texte(l.origine) ?? "compte"}\u0000${texte(l.erreur) ?? texte(l.evenement)}`),
  );
  return plusFrequents(compte).map(([cle, n]) => {
    const [origine, code] = cle.split("\u0000") as [string, string];
    return { origine, code, nombre: n };
  });
}

export function centile(valeurs: number[], rang: number): number | null {
  if (!valeurs.length) return null;
  const ordonnees = [...valeurs].sort((a, b) => a - b);
  return ordonnees[Math.min(ordonnees.length - 1, arrondir((rang / 100) * (ordonnees.length - 1)))]!;
}

/** Médiane et 95e centile de la durée des appels réussis, en millisecondes. */
export function latences(lignes: Ligne[]): [number | null, number | null] {
  const durees = lignes.filter((l) => "duree_ms" in l && !l.erreur && !("evenement" in l)).map((l) => nombre(l.duree_ms));
  return [centile(durees, 50), centile(durees, 95)];
}

export interface AReprendre {
  date: string;
  conversation: string | null;
  motif: string;
}

/** Les conversations restées sans réponse, que Awa doit reprendre elle-même. */
export function aReprendre(lignes: Ligne[]): AReprendre[] {
  return lignes
    .filter((l) => SANS_REPONSE.has(texte(l.erreur) ?? texte(l.evenement) ?? ""))
    .map((l) => ({
      date: l.date,
      conversation: texte(l.client) ?? texte(l.conversation),
      motif: (texte(l.erreur) ?? texte(l.evenement))!,
    }));
}

// --- Le Comptoir en ligne (chapitre 19) ----------------------------------------------------------

export const messages = (lignes: Ligne[]): Ligne[] => lignes.filter((l) => l.evenement === "message");

export interface Conversation {
  canal: string;
  messages: number;
  dollars: number;
}

/**
 * conversation -> canal, nombre de messages, coût total. Toutes étapes comprises, d'après la trace, et la
 * surveillance du chapitre 18 quand elle est activée (chapitre 20).
 */
export function parConversation(lignes: Ligne[]): Map<string, Conversation> {
  const conversations = new Map<string, Conversation>();
  for (const l of messages(lignes)) {
    const cle = texte(l.conversation) ?? "?";
    const c = conversations.get(cle) ?? { canal: "", messages: 0, dollars: 0 };
    conversations.set(cle, c);
    c.canal = texte(l.canal) ?? "";
    c.messages += 1;
    c.dollars += nombre(l.cout_dollars);
  }
  for (const l of lignes) {
    const c = l.evenement === "surveillance" ? conversations.get(texte(l.conversation) ?? "") : undefined;
    if (c) c.dollars += nombre(l.cout_dollars);
  }
  return conversations;
}

export function coutParConversation(lignes: Ligne[]): { conversations: number; moyenne: number | null; mediane: number | null } {
  const totaux = [...parConversation(lignes).values()].map((c) => c.dollars);
  if (!totaux.length) return { conversations: 0, moyenne: null, mediane: null };
  return { conversations: totaux.length, moyenne: totaux.reduce((a, b) => a + b, 0) / totaux.length, mediane: centile(totaux, 50) };
}

/** Médiane et 90e centile de la durée d'un message, toutes étapes comprises : ce que le client attend. */
export function latencesMessages(lignes: Ligne[]): [number | null, number | null] {
  const durees = messages(lignes).filter((l) => "duree_ms" in l && !l.erreur).map((l) => nombre(l.duree_ms));
  return [centile(durees, 50), centile(durees, 90)];
}

export function tauxDErreur(lignes: Ligne[]): number | null {
  const tous = messages(lignes);
  return tous.length ? tous.filter((l) => l.erreur).length / tous.length : null;
}

const SECURITE = new Set(["garde", "limite", "tentative_suspecte", "hors_budget", "purge", "whatsapp_signature_invalide"]);

/** Les événements de sécurité et d'exploitation, par nom (chapitres 18 et 19). */
export function evenements(lignes: Ligne[]): Map<string, number> {
  return compter(
    lignes
      .filter((l) => SECURITE.has(texte(l.evenement) ?? "") || (l.evenement === "whatsapp_envoi" && l.erreur))
      .map((l) => String(l.evenement)),
  );
}

/** Les conversations signalées au moins `seuil` fois par la surveillance : à regarder de près. */
export function recidivistes(lignes: Ligne[], seuil = 3): [string, number][] {
  const compte = compter(lignes.filter((l) => l.evenement === "tentative_suspecte").map((l) => String(l.conversation)));
  return plusFrequents(compte).filter(([, n]) => n >= seuil);
}

/** La date en UTC, à la seconde, au format du journal : 2026-10-22T08:15:00+00:00. */
const aLaSeconde = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** Ce qui doit faire réagir Awa ou Yao, sur les dernières 24 heures. */
export function alertes(lignes: Ligne[], maintenant = new Date()): string[] {
  const depuis = aLaSeconde(new Date(maintenant.getTime() - 24 * 3600 * 1000));
  const recentes = lignes.filter((l) => (l.date ?? "") >= depuis);
  const sortie: string[] = [];
  const depense = recentes.filter((l) => l.evenement === "message" || l.evenement === "surveillance").reduce((s, l) => s + nombre(l.cout_dollars), 0);
  if (depense >= config.SEUIL_ALERTE * config.BUDGET_JOUR) {
    sortie.push(`Dépense des dernières 24 heures : ${depense.toFixed(2)} $, pour un plafond du jour de ${config.BUDGET_JOUR.toFixed(2)} $.`);
  }
  const taux = tauxDErreur(recentes);
  if (taux !== null && messages(recentes).length >= 10 && taux > 0.05) sortie.push(`${Math.round(taux * 100)}% des messages des dernières 24 heures ont échoué.`);
  if (recentes.some((l) => l.evenement === "hors_budget")) sortie.push("Des clients ont reçu « le Comptoir ne peut pas répondre » faute de budget.");
  for (const [conversation, n] of recidivistes(recentes)) sortie.push(`La conversation ${conversation.slice(0, 8)}… a été signalée ${n} fois par la surveillance.`);
  if (recentes.some((l) => l.evenement === "whatsapp_non_configure")) {
    sortie.push("WhatsApp n'est pas configuré (le sel des empreintes manque) : les messages attendent chez Meta.");
  }
  if (recentes.some((l) => (l.evenement === "whatsapp_envoi" || l.evenement === "whatsapp_traitement") && l.erreur)) {
    sortie.push("Des messages WhatsApp sont restés sans réponse : envoi refusé ou traitement impossible.");
  }
  return sortie;
}

/** Comme html.escape de Python : le contenu du journal ne devient jamais du code de la page. */
export const echapper = (t: string): string =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

/** Une page autonome, sans bibliothèque ni appel réseau, à ouvrir dans un navigateur. */
export function enHtml(lignes: Ligne[]): string {
  const jours = parJour(lignes);
  const plusCher = Math.max(0, ...[...jours.values()].map((j) => j.dollars)) || 1;
  const rangees = [...jours.entries()]
    .map(([jour, j]) =>
      `<tr><td>${jour}</td><td>${j.appels}</td><td>${j.dollars.toFixed(4)} $</td>` +
      `<td>${(j.dollars * config.TAUX_FCFA).toFixed(0)} FCFA</td><td>${j.echecs}</td>` +
      `<td><div class='barre' style='width:${((100 * j.dollars) / plusCher).toFixed(0)}%'></div></td></tr>`)
    .join("");
  const echecs = modesDEchec(lignes).map((m) => `<tr><td>${echapper(m.origine)}</td><td>${echapper(m.code)}</td><td>${m.nombre}</td></tr>`).join("");
  const reprendre = aReprendre(lignes)
    .map((r) => `<tr><td>${echapper(r.date)}</td><td>${echapper(String(r.conversation))}</td><td>${echapper(r.motif)}</td></tr>`)
    .join("");
  const [mediane, p95] = latences(lignes);
  const conv = coutParConversation(lignes);
  const [medMsg, p90Msg] = latencesMessages(lignes);
  const taux = tauxDErreur(lignes);
  const dureeMsg = medMsg !== null ? `médiane ${medMsg.toFixed(0)} ms, 90e centile ${p90Msg!.toFixed(0)} ms` : "aucun message réussi";
  const enLigne = conv.conversations
    ? `<p>${conv.conversations} conversation${conv.conversations > 1 ? "s" : ""} ; coût moyen ${conv.moyenne!.toFixed(4)} $, médian ` +
      `${conv.mediane!.toFixed(4)} $ ; un message : ${dureeMsg} ; erreurs : ${((taux ?? 0) * 100).toFixed(1)}%.</p>`
    : "<p>Aucun message en ligne pour l'instant.</p>";
  // Les appels du Comptoir aiguillé n'ont pas de durée dans le journal (elle est sur les étapes) : rien à afficher.
  const latenceAppels = mediane !== null ? `médiane ${mediane.toFixed(0)} ms, 95e centile ${p95!.toFixed(0)} ms` : "aucune durée d'appel dans le journal";
  const alarmes = alertes(lignes).map((a) => `<li>${echapper(a)}</li>`).join("") || "<li>Aucune.</li>";
  const securite = plusFrequents(evenements(lignes)).map(([nom, n]) => `<tr><td>${echapper(nom)}</td><td>${n}</td></tr>`).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Le Comptoir : tableau de bord</title>
<style>body{font-family:system-ui,sans-serif;max-width:56rem;margin:0 auto;padding:1rem;color:#2b2118;background:#fdf8f3}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}td,th{border-bottom:1px solid #ead9c8;padding:.35rem;text-align:left}
.barre{background:#d9772b;height:.8rem;border-radius:.2rem}</style></head><body>
<h1>Le Comptoir : tableau de bord</h1>
<h2>Alertes (24 heures)</h2><ul>${alarmes}</ul>
<h2>En ligne</h2>${enLigne}
<h2>Sécurité et exploitation</h2><table><tr><th>Événement</th><th>Nombre</th></tr>${securite}</table>
<p>Latence des appels réussis : ${latenceAppels}.</p>
<h2>Par jour</h2><table><tr><th>Jour</th><th>Appels</th><th>Coût</th><th></th><th>Échecs</th><th></th></tr>${rangees}</table>
<h2>Modes d'échec</h2><table><tr><th>Origine</th><th>Code</th><th>Nombre</th></tr>${echecs}</table>
<h2>Conversations à reprendre par Awa</h2><table><tr><th>Date</th><th>Conversation</th><th>Motif</th></tr>${reprendre}</table>
</body></html>`;
}
