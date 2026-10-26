// Le routeur du Comptoir : un message, une catégorie, un service (chapitre 12).
//
// Le code décide d'abord ce qu'il sait : une confirmation « OUI 1234 », une commande en cours. Le modèle
// classe le reste, avec une sortie structurée qui ne peut prendre que quatre valeurs. Il ne voit que le
// message : ni les outils, ni la base, ni l'historique. Un message piégé ne peut donc rien lui faire faire
// d'autre que choisir une catégorie. Le prompt est celui de la version Python
// (python/comptoir/prompts/routeur_v1.md).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ClientMessages, texteDe } from "./client.ts";
import { CONFIRMATION } from "./commandes.ts";
import { config } from "./config.ts";
import { cout } from "./couts.ts";
import { noter } from "./journal.ts";
import { PYTHON } from "./lancement.ts";
import { messageClient } from "./prompt.ts";
import { repr } from "./python.ts";

export const CATEGORIES = ["reclamation", "commande", "information", "autre"]; // par ordre de priorité
export const MODELE_ROUTEUR = config.MODELE_ROUTEUR;
export const PROMPT = readFileSync(join(PYTHON, "comptoir", "prompts", "routeur_v1.md"), "utf8").replace(/\r\n?/g, "\n").trim();

export const SCHEMA = {
  type: "object",
  properties: {
    categorie: { type: "string", enum: [...CATEGORIES] },
    raison: { type: "string" },
  },
  required: ["categorie", "raison"],
  additionalProperties: false,
};

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** Une réponse coupée ou illisible : le message part au Comptoir, qui sait tout traiter. */
export class RoutageImpossible extends Error {}

export interface Decision {
  categorie: string;
  raison: string;
  par: string; // « code » ou le nom du modèle
  cout: number;
}

export interface OptionsClassement {
  modele?: string;
  effort?: Effort | null;
  sansReflexion?: boolean;
}

export function requeteRoutage(message: string, { modele = MODELE_ROUTEUR, effort = null, sansReflexion = false }: OptionsClassement = {}): Anthropic.MessageCreateParamsNonStreaming {
  const outputConfig: Anthropic.OutputConfig = { format: { type: "json_schema", schema: SCHEMA } };
  if (effort) outputConfig.effort = effort;
  const requete: Anthropic.MessageCreateParamsNonStreaming = {
    model: modele,
    // Assez de place pour la réflexion et le JSON : un plafond trop bas coupe la réponse.
    max_tokens: 1000,
    system: PROMPT,
    messages: [{ role: "user", content: messageClient(message) }],
    output_config: outputConfig,
  };
  if (sansReflexion) requete.thinking = { type: "disabled" }; // accepté par Claude Haiku 5.5 (chapitre 3)
  return requete;
}

/** Un appel au modèle. La catégorie est validée par le code : hors des quatre, c'est une erreur. */
export async function classer(client: ClientMessages, message: string, options: OptionsClassement = {}): Promise<Decision> {
  const requete = requeteRoutage(message, options);
  const reponse = await client.messages.create(requete);
  const prix = cout(requete.model, reponse.usage);
  noter(reponse._request_id, requete.model, prix, { prompt: "routeur-v1", stop_reason: reponse.stop_reason });
  if (reponse.stop_reason !== "end_turn") throw new RoutageImpossible(`réponse arrêtée par ${reponse.stop_reason}`);
  let donnees: Record<string, unknown>;
  try {
    donnees = JSON.parse(texteDe(reponse)) as Record<string, unknown>;
  } catch (erreur) {
    throw new RoutageImpossible("réponse illisible", { cause: erreur });
  }
  // La casse d'une valeur d'enum n'est pas garantie : « Information » est une information.
  const categorie = String(donnees.categorie ?? "").toLowerCase();
  if (!CATEGORIES.includes(categorie)) throw new RoutageImpossible(`catégorie inconnue : ${repr(donnees.categorie)}`);
  if (!("raison" in donnees)) throw new Error("'raison'"); // un KeyError en Python : la sortie structurée la garantit
  return { categorie, raison: String(donnees.raison), par: requete.model, cout: prix.dollars };
}

/** Ce que le code sait sans demander : la confirmation d'un récapitulatif. */
export function parLeCode(message: string): Decision | null {
  if (CONFIRMATION.test(message)) return { categorie: "commande", raison: "confirmation d'un récapitulatif", par: "code", cout: 0 };
  return null;
}

export async function router(client: ClientMessages, message: string, { commandeEnCours = false, ...options }: OptionsClassement & { commandeEnCours?: boolean } = {}): Promise<Decision> {
  let decision: Decision;
  try {
    decision = parLeCode(message) ?? (await classer(client, message, options));
  } catch (erreur) {
    if (!(erreur instanceof RoutageImpossible)) throw erreur;
    // Le service le plus général : le Comptoir, dont les règles transmettent les réclamations à Awa.
    return { categorie: "autre", raison: `classement impossible (${erreur.message})`, par: "repli", cout: 0 };
  }
  // Pendant une commande, la suite va au Comptoir, qui a l'historique et les outils. Une réclamation, elle,
  // reste une réclamation.
  if (commandeEnCours && (decision.categorie === "information" || decision.categorie === "autre")) {
    return { ...decision, categorie: "commande", raison: `commande en cours (${decision.categorie})` };
  }
  return decision;
}

/**
 * La catégorie la plus votée ; à égalité, la plus prioritaire : dans le doute, une réclamation va chez Awa
 * plutôt que de se perdre.
 */
export function voter(decisions: Pick<Decision, "categorie">[]): string {
  const compte = new Map<string, number>();
  for (const d of decisions) compte.set(d.categorie, (compte.get(d.categorie) ?? 0) + 1);
  const meilleur = Math.max(...compte.values());
  const gagnante = CATEGORIES.find((c) => compte.get(c) === meilleur);
  if (gagnante === undefined) throw new Error("Aucune des quatre catégories n'a le plus de voix."); // StopIteration en Python
  return gagnante;
}

/** Le même classement, plusieurs fois en parallèle (parallélisation par vote). */
export async function routerParVote(client: ClientMessages, message: string, votes = 3, options: OptionsClassement = {}): Promise<[string, Decision[]]> {
  const decisions = await Promise.all(Array.from({ length: votes }, () => classer(client, message, options)));
  return [voter(decisions), decisions];
}
