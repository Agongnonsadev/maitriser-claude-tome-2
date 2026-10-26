// Chapitre 9 : jouer les 10 scénarios de commande, et vérifier par le code ce qui doit l'être.
//
// Chaque scénario part d'une boutique neuve, en mémoire. Le code vérifie : le nombre de commandes créées,
// les outils appelés, les demandes transmises à Awa, l'absence de produit inventé, et qu'aucun message de
// Claude n'annonce une commande enregistrée. Le reste se relit : le script affiche chaque échange. Les
// scénarios sont ceux de la version Python (python/ch09/scenarios.json).
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch09/jouer_scenarios.ts --budget-max 0.5
//     npx tsx ch09/jouer_scenarios.ts --seulement remise devis

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { creerClient } from "../comptoir/appel.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import type { ClientMessages } from "../comptoir/client.ts";
import { ComptoirCommandes } from "../comptoir/commandes.ts";
import { config } from "../comptoir/config.ts";
import { ErreurComptoir } from "../comptoir/erreurs.ts";
import { PYTHON, estLance, plusieursValeurs } from "../comptoir/lancement.ts";

export interface Scenario {
  id: string;
  messages: string[];
  attendu: {
    commandes?: number;
    outils_requis?: string[];
    produits_interdits?: string[];
    transmis?: string | null;
    premier_recapitulatif_remplace?: boolean;
  };
}

// Claude ne doit jamais annoncer une commande comme faite : seul le code le fait, après le code du client.
const ANNONCE_INTERDITE = /commande\s+(?:\S+\s+){0,3}?(?:est|a été|bien)?\s*(?:enregistrée|confirmée|validée|créée)/giu;

export function charger(): Scenario[] {
  return JSON.parse(readFileSync(join(PYTHON, "ch09", "scenarios.json"), "utf8")) as Scenario[];
}

export function remplacerCodes(message: string, boutique: Boutique, conversation: string): string | null {
  const recaps = boutique.recapitulatifs(conversation);
  if (message.includes("{code}") || message.includes("{premier_code}")) {
    if (!recaps.length) return null;
    return message.replaceAll("{code}", recaps.at(-1)!.code).replaceAll("{premier_code}", recaps[0]!.code);
  }
  return message;
}

/** « Votre commande est enregistrée » : oui. « Elle n'est pas encore enregistrée » : non. */
export function annonceUneCommande(texte: string): boolean {
  return [...texte.matchAll(ANNONCE_INTERDITE)].some((m) => !m[0].toLowerCase().includes("pas"));
}

/** Les écarts entre ce qui s'est passé et ce qui était attendu. Liste vide : réussi. */
export function verifier(scenario: Scenario, boutique: Boutique, conversation: string, appels: string[], textesClaude: string[]): string[] {
  const attendu = scenario.attendu;
  const ecarts: string[] = [];
  const commandes = boutique.commandes().filter((c) => c.conversation === conversation);
  if (commandes.length !== (attendu.commandes ?? 0)) ecarts.push(`${commandes.length} commande(s) créée(s), ${attendu.commandes ?? 0} attendue(s)`);
  for (const outil of attendu.outils_requis ?? []) if (!appels.includes(outil)) ecarts.push(`outil ${outil} jamais appelé`);
  const produits = new Set(
    boutique.recapitulatifs(conversation).flatMap((r) => (JSON.parse(r.lignes) as { produit: string }[]).map((l) => l.produit)),
  );
  for (const interdit of attendu.produits_interdits ?? []) if (produits.has(interdit)) ecarts.push(`produit inventé dans un récapitulatif : ${interdit}`);
  if ("transmis" in attendu) {
    const motifs = boutique.demandes().filter((d) => d.conversation === conversation).map((d) => d.motif);
    if (attendu.transmis === null && motifs.length) ecarts.push(`transmis à Awa sans raison : ${JSON.stringify(motifs)}`);
    if (attendu.transmis && !motifs.includes(attendu.transmis)) ecarts.push(`demande « ${attendu.transmis} » non transmise (transmis : ${JSON.stringify(motifs)})`);
  }
  if (attendu.premier_recapitulatif_remplace) {
    const recaps = boutique.recapitulatifs(conversation);
    if (recaps.length < 2 || recaps[0]!.statut !== "remplace") ecarts.push("le premier récapitulatif n'a pas été remplacé");
  }
  for (const texte of textesClaude) {
    if (annonceUneCommande(texte)) ecarts.push(`Claude annonce une commande enregistrée : « ${texte.slice(0, 80)} »`);
  }
  return ecarts;
}

export async function jouer(client: ClientMessages, scenario: Scenario, budget: Budget): Promise<string[]> {
  const boutique = new Boutique();
  const conversation = identifiantAleatoire();
  const comptoir = new ComptoirCommandes(client, boutique, budget, conversation);
  const appels: string[] = [];
  const textesClaude: string[] = [];
  console.log(`\n=== ${scenario.id}`);
  for (const brut of scenario.messages) {
    const message = remplacerCodes(brut, boutique, conversation);
    if (message === null) return ["aucun récapitulatif : le code de confirmation n'existe pas"];
    console.log(`Client   : ${message}`);
    let reponse;
    try {
      reponse = await comptoir.repondre(message);
    } catch (erreur) {
      if (erreur instanceof ErreurComptoir) return [`erreur : ${erreur.diagnostic.code}`];
      throw erreur;
    }
    console.log(`Comptoir : ${reponse.texte}`);
    if (reponse.tour) {
      appels.push(...reponse.tour.execution.appels);
      textesClaude.push(reponse.tour.texte); // le récapitulatif ajouté par le code n'en fait pas partie
    }
  }
  return verifier(scenario, boutique, conversation, appels, textesClaude);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: plusieursValeurs(["seulement"]),
    options: {
      "budget-max": { type: "string", default: "0.5" }, // dépense maximale de la série, en dollars
      seulement: { type: "string", multiple: true }, //     identifiants des scénarios à jouer
    },
  });
  // Un budget dédié à la série : plafonds du jour et du client = budget-max.
  config.BUDGET_JOUR = config.QUOTA_CLIENT_JOUR = Number(args["budget-max"]);
  const budget = new Budget();
  const client = creerClient();
  const bilan = new Map<string, string[]>();
  for (const scenario of charger()) {
    if (args.seulement?.length && !args.seulement.includes(scenario.id)) continue;
    bilan.set(scenario.id, await jouer(client, scenario, budget));
  }
  console.log(`\n=== Bilan (dépense : ${budget.duJour().toFixed(4)} $)`);
  for (const [id, ecarts] of bilan) console.log(`${ecarts.length ? "ÉCHEC " : "réussi"}  ${id}${ecarts.map((e) => `\n         - ${e}`).join("")}`);
}

if (estLance(import.meta.url)) await main();
