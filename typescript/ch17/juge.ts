// La notation par Claude, avec une grille (chapitre 17).
//
// Le juge lit ce que le code ne sait pas juger : une affirmation exacte ou inventée, une promesse
// tournée autrement, une réponse à côté, le ton. Il travaille dans son propre contexte : il ne voit
// ni le prompt du Comptoir ni sa réflexion, seulement les documents d'Awa, le message, la réponse,
// les actions du système et l'attendu. Il écrit son constat avant son verdict (l'ordre du schéma
// est respecté, et un verdict posé avant le constat se trompe plus souvent, chapitre 12), et il a
// droit à « inconnu » plutôt que d'inventer.
//
// Un juge se vérifie avant de servir : ch17/etalonnage.ts compare ses verdicts à des notes humaines.
// Les grilles sont celles de la version Python (python/ch17/grilles/).

import type Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { arrondir } from "../comptoir/arrondi.ts";
import { type ClientMessages, texteDe } from "../comptoir/client.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { cout } from "../comptoir/couts.ts";
import { noter as noterAuJournal } from "../comptoir/journal.ts";
import { PromptSysteme, chargerDonnees, rendreCatalogue, rendreConditions } from "../comptoir/prompt.ts";
import { jsonPython } from "../comptoir/python.ts";
import { type CasEvaluation, type Essai, identifiant } from "./banc.ts";
import { DONNEES, issue, lireTexte } from "./suite.ts";

export const CRITERES = ["exacte", "sans_promesse", "repond", "ton"] as const;
export const GRILLE = "v2"; // v1 : sans les résultats d'outils ; v2 : avec (voir actions)
export const VERDICTS = ["oui", "non", "inconnu"] as const;
export const MAX_TOKENS = 3000;

export const SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    CRITERES.map((c) => [
      c,
      {
        type: "object",
        properties: { constat: { type: "string" }, verdict: { type: "string", enum: [...VERDICTS] } },
        required: ["constat", "verdict"],
        additionalProperties: false,
      },
    ]),
  ),
  required: [...CRITERES],
  additionalProperties: false,
};

export function chargerGrille(version = GRILLE): PromptSysteme {
  return new PromptSysteme(lireTexte(join(DONNEES, "grilles", `juge_${version}.md`)).trim(), `juge-${version}`);
}

/** Les mêmes faits que ceux du Comptoir : catalogue, conditions et base d'Awa. */
export function documents(): string {
  const donnees = chargerDonnees();
  const base = chargerBase().map((m) => `## ${m.titre}\n${m.texte}`).join("\n\n");
  return (
    `<documents>\n<catalogue>\n${rendreCatalogue(donnees)}\n</catalogue>\n<conditions>\n` +
    `${rendreConditions(donnees)}\n</conditions>\n${base}\n</documents>`
  );
}

/** Les n premiers caractères, comme texte[:n] en Python (et non les n premières unités UTF-16). */
const debut = (texte: string, n: number): string => [...texte].slice(0, n).join("");

/** Chaque outil appelé, avec ce qu'il a répondu : le résultat d'un appel arrive avec l'appel suivant. */
export function outilsEtResultats(essai: Pick<Essai, "appels">): string[] {
  const lignes: string[] = [];
  essai.appels.forEach((appel, rang) => {
    const demandes = appel.rendu.filter((b) => b.type === "tool_use");
    const recus = rang + 1 < essai.appels.length ? essai.appels[rang + 1]!.recu : [];
    demandes.forEach((bloc, i) => {
      const resultat = recus[i];
      const reponse = resultat === undefined ? "(pas de résultat)" : (resultat.erreur ? "ERREUR : " : "") + debut(resultat.contenu, 220);
      lignes.push(`- ${bloc.name} ${debut(jsonPython(bloc.input), 160)} → ${reponse}`);
    });
  });
  return lignes;
}

/**
 * Ce que le système a fait, lu dans la boutique et dans la transcription : le juge vérifie le texte
 * contre les faits. Ajouté après la première notation : sans les résultats d'outils, le juge prenait
 * pour inventé un stock que le Comptoir avait bel et bien vérifié.
 */
export function actions(essai: Essai): string {
  const enAttente = essai.recapitulatifs.filter((r) => r.statut === "en_attente");
  const lignes = [
    `récapitulatif préparé : ${enAttente.length ? `oui, total ${enAttente.at(-1)!.total} FCFA` : "non"}`,
    `demandes transmises à Awa : ${essai.demandes.length ? essai.demandes.join(", ") : "aucune"}`,
    `commandes créées : ${essai.commandes}`,
  ];
  const outils = outilsEtResultats(essai);
  lignes.push("outils appelés et leurs résultats :" + (outils.length ? "\n" + outils.join("\n") : " aucun"));
  return lignes.join("\n");
}

export function requete(cas: CasEvaluation, essai: Essai, modele: string, grille: PromptSysteme | null = null): Anthropic.MessageCreateParamsNonStreaming {
  const g = grille ?? chargerGrille();
  const recapitulatif = essai.texte.slice(essai.texte_claude.length).trim() || "aucun";
  const aNoter =
    `<message_client>\n${cas.message}\n</message_client>\n` +
    `<reponse_du_comptoir>\n${essai.texte_claude}\n</reponse_du_comptoir>\n` +
    `<recapitulatif_officiel>\n${recapitulatif}\n</recapitulatif_officiel>\n` +
    `<actions_du_systeme>\n${actions(essai)}\n</actions_du_systeme>\n` +
    `<attendu>\n${cas.reference}\n</attendu>`;
  return {
    model: modele,
    max_tokens: MAX_TOKENS,
    system: g.texte,
    messages: [
      {
        role: "user",
        content: [
          // Les documents ne changent pas d'un jugement à l'autre : ils sont lus dans le cache.
          { type: "text", text: documents(), cache_control: { type: "ephemeral" } },
          { type: "text", text: aNoter },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  };
}

export interface Jugement {
  essai: string; //            l'identifiant de l'essai jugé
  modele: string;
  grille: string;
  verdicts: Record<string, string>;
  constats: Record<string, string>;
  cout_dollars: number;
  erreur: string | null;
}

/** « reussi » si tout est oui, « echoue » au premier non, sinon « a_relire ». */
export const issueDe = (j: Jugement): string => issue(j);

export async function juger(client: ClientMessages, cas: CasEvaluation, essai: Essai, modele: string, grille: PromptSysteme | null = null): Promise<Jugement> {
  const g = grille ?? chargerGrille();
  const message = await client.messages.create(requete(cas, essai, modele, g));
  const prix = cout(modele, message.usage);
  noterAuJournal(message._request_id, modele, prix, { prompt: g.identifiant, stop_reason: message.stop_reason });
  const jugement: Jugement = { essai: identifiant(essai), modele, grille: g.identifiant, verdicts: {}, constats: {}, cout_dollars: arrondir(prix.dollars, 6), erreur: null };
  if (message.stop_reason !== "end_turn") {
    jugement.erreur = `jugement arrêté par ${message.stop_reason}`;
    return jugement;
  }
  const donnees = JSON.parse(texteDe(message)) as Record<string, { constat: string; verdict: string }>;
  for (const c of CRITERES) {
    jugement.verdicts[c] = donnees[c]!.verdict;
    jugement.constats[c] = donnees[c]!.constat;
  }
  return jugement;
}
