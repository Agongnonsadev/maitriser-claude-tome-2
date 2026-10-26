// L'agent de réapprovisionnement : une boucle d'agent encadrée (chapitre 13).
//
// Claude lit les ventes, le stock, les événements, les fiches et les messages des fournisseurs, fait
// calculer les besoins par un outil, puis propose un bon de commande. Il choisit lui-même ce qu'il lit et
// dans quel ordre : c'est un agent. Le code l'encadre :
// - un nombre de tours, un budget en dollars et un délai, vérifiés entre deux appels ;
// - en option, un budget de tâche (en bêta), pour que Claude règle lui-même son effort ;
// - un seul outil qui écrit, et il n'écrit qu'un projet : le bon est vérifié par le code et reste « à
//   valider par Awa » ; rien n'est envoyé ;
// - une trace : chaque appel et chaque outil, avec sa durée et son coût ;
// - en option : la lecture des messages confiée à un sous-agent, une mémoire d'une semaine à l'autre,
//   l'effacement des anciens résultats d'outils.
//
// Les prompts sont ceux de la version Python (python/comptoir/prompts/reappro_v2.md et lecteur_v1.md), et
// les outils ont les mêmes noms, descriptions et schémas : Claude lit la même chose dans les deux versions.

import type Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { BetaLocalFilesystemMemoryTool, betaMemoryTool } from "@anthropic-ai/sdk/tools/memory/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arrondir, fixe } from "./arrondi.ts";
import { type Atelier, type Bon, BonInvalide, ValeurInvalide, rendreBon } from "./atelier.ts";
import { type ClientMessages, texteDe } from "./client.ts";
import { config } from "./config.ts";
import { Cout, cout } from "./couts.ts";
import { noter } from "./journal.ts";
import { PYTHON } from "./lancement.ts";
import { jsonPython, separerMots, somme } from "./python.ts";
import { Trace } from "./trace.ts";

const lirePrompt = (nom: string): string => readFileSync(join(PYTHON, "comptoir", "prompts", nom), "utf8").replace(/\r\n?/g, "\n").trim();

export const SYSTEME = lirePrompt("reappro_v2.md");
export const LECTEUR = lirePrompt("lecteur_v1.md");
export const CONSIGNE = "Nous sommes le lundi 19 octobre 2026, 7 h. Prépare le projet de bon de commande de la semaine.";
export const MODELE_LECTEUR = config.MODELE_AUXILIAIRE; // Claude Haiku 5.5 : lire et résumer, sans outils

export const BETA_BUDGET_DE_TACHE = "task-budgets-2026-03-13";
export const BETA_CONTEXTE = "context-management-2025-06-27";
export const BETA_COMPACTION = "compact-2026-09-04";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export interface Reglages {
  modele: string;
  effort: Effort | null;
  sousAgent: boolean; //                     la lecture des messages confiée à Claude Haiku 5.5
  memoire: string | null; //                 un dossier : l'outil mémoire, d'une semaine à l'autre
  budgetDeTache: number | null; //           en tokens, 20 000 au moins (bêta)
  effacerResultatsApres: number | null; //   tokens d'entrée au-delà desquels les vieux résultats s'effacent
  compacterApresTour: number | null; //      résumer la séance après ce tour (compaction à la demande, bêta)
  maxTokens: number;
}

// Comme les valeurs par défaut d'un dataclass, le modèle est lu une fois, au chargement du module.
const MODELE_PAR_DEFAUT = config.MODELE;

export const reglages = (r: Partial<Reglages> = {}): Reglages => ({
  modele: MODELE_PAR_DEFAUT,
  effort: null,
  sousAgent: true,
  memoire: null,
  budgetDeTache: null,
  effacerResultatsApres: null,
  compacterApresTour: null,
  maxTokens: 8000,
  ...r,
});

/** Les limites que le code vérifie entre deux appels : on s'arrête avant de payer le suivant. */
export class Garde {
  readonly toursMax: number;
  readonly budgetDollars: number;
  readonly delaiS: number;
  tours = 0;
  depense = 0;
  readonly debut = performance.now();

  constructor({ toursMax = 20, budgetDollars = 0.5, delaiS = 300 } = {}) {
    this.toursMax = toursMax;
    this.budgetDollars = budgetDollars;
    this.delaiS = delaiS;
  }

  raisonDArret(): string | null {
    if (this.depense >= this.budgetDollars) return `budget de ${fixe(this.budgetDollars, 2)} $ atteint (${fixe(this.depense, 4)} $)`;
    if ((performance.now() - this.debut) / 1000 >= this.delaiS) return `délai de ${fixe(this.delaiS, 0)} s dépassé`;
    if (this.tours >= this.toursMax) return `${this.toursMax} tours atteints`;
    return null;
  }
}

export interface Resultat {
  texte: string;
  bon: Bon | null;
  arret: string | null; //  null : l'agent a terminé de lui-même
  tours: number;
  depense: number;
  dureeS: number;
  picContexte: number; //   la plus grosse requête de la séance, en tokens d'entrée
  outils: string[];
  coutSousAgent: number;
  effacements: unknown[];
  trace: Trace;
}

export class Contexte {
  bon: Bon | null = null;
  readonly outils: string[] = [];
  coutSousAgent = 0;

  constructor(
    readonly client: ClientMessages | null,
    readonly atelier: Atelier,
    readonly garde: Garde,
    readonly trace: Trace,
  ) {}
}

/**
 * Le sous-agent : Claude Haiku 5.5, sans outils, avec les messages et une question. Son contexte est à
 * lui : l'agent principal ne reçoit que la réponse, pas les milliers de mots qu'il a fallu lire.
 */
export async function lireParSousAgent(client: ClientMessages, messages: string, question: string): Promise<[string, number]> {
  const reponse = await client.messages.create({
    model: MODELE_LECTEUR,
    max_tokens: 1000,
    thinking: { type: "disabled" },
    system: LECTEUR,
    messages: [
      {
        role: "user",
        content: [
          // Les messages ne changent pas d'une question à l'autre : en cache.
          { type: "text", text: `<messages>\n${messages}\n</messages>`, cache_control: { type: "ephemeral" } },
          { type: "text", text: `<question>${question}</question>` },
        ],
      },
    ],
  });
  const prix = cout(MODELE_LECTEUR, reponse.usage);
  noter(reponse._request_id, MODELE_LECTEUR, prix, { prompt: "lecteur-v1", stop_reason: reponse.stop_reason });
  const texte = texteDe(reponse).trim();
  if (reponse.stop_reason !== "end_turn" || !texte) {
    throw new ToolError(`Lecture interrompue (arrêt : ${reponse.stop_reason ?? "None"}). Repose une question plus précise.`);
  }
  return [texte, prix.dollars];
}

// Les descriptions et les schémas que construit le SDK Python à partir des docstrings et des annotations
// (@beta_tool) : la première ligne de la docstring, une ligne vide, puis la suite.
const SANS_ARGUMENT = { additionalProperties: false, properties: {}, type: "object" } as const;

export const DESCRIPTIONS = {
  lire_ventes:
    "Renvoie les ventes habituelles des huit dernières semaines, produit par produit et semaine par semaine,\n\n" +
    "leurs moyennes calculées par le code, et à part les commandes d'événement passées. À lire pour prévoir la\n" +
    "production des deux semaines qui viennent.",
  lire_stock:
    "Renvoie le stock de ce matin : les produits finis (bouteilles et flacons prêts à vendre) et les articles\n\n" +
    "(ingrédients et emballages), dans l'unité de leurs fiches.",
  lire_evenements:
    "Renvoie les commandes d'événement à venir, avec leur date, leurs bouteilles et leur statut : confirmé\n\n" +
    "(acompte versé) ou simple devis.",
  lire_fournisseurs:
    "Renvoie les fiches des fournisseurs : pour chaque article, qui le vend, le délai habituel de livraison en\n\n" +
    "jours, le minimum de commande, le conditionnement et le prix unitaire en FCFA. Les fiches ne mentionnent ni\n" +
    "les ruptures, ni les retards exceptionnels, ni les hausses de prix annoncées : voir les messages.",
  calculer_besoins:
    "Calcule, pour une production de bouteilles et de flacons, les articles nécessaires (ingrédients et\n\n" +
    "emballages), le stock de chaque article, ce qui manque, et la quantité à commander chez chaque fournisseur\n" +
    "selon ses fiches (minimum et conditionnement). Ne tient compte ni des ruptures ni des délais : le choix du\n" +
    "fournisseur et de la date te revient.",
  deleguer_lecture_messages:
    "Confie la lecture des messages WhatsApp des fournisseurs (deux mois, plusieurs milliers de mots) à un\n\n" +
    "assistant de lecture, qui répond à ta question en quelques phrases datées. À utiliser pour connaître les\n" +
    "ruptures, retards, délais exceptionnels, hausses de prix et arrivages annoncés par les fournisseurs. Une\n" +
    "question précise donne une réponse précise ; tu peux en poser plusieurs.",
  lire_messages_fournisseurs:
    "Renvoie tous les messages WhatsApp des fournisseurs des deux derniers mois, du plus ancien au plus récent\n\n" +
    "(plusieurs milliers de mots). On y trouve les ruptures, retards, délais exceptionnels, hausses de prix et\n" +
    "arrivages, qui ne figurent pas dans les fiches.",
  proposer_bon_de_commande:
    "Enregistre le projet de bon de commande de la semaine, à valider par Awa. Rien n'est envoyé aux\n\n" +
    "fournisseurs. Le code vérifie chaque ligne avec les fiches (le fournisseur vend-il l'article, minimum,\n" +
    "conditionnement, délai) et le plafond d'Awa, puis calcule les montants. Si une règle n'est pas respectée,\n" +
    "le bon est refusé avec la liste des erreurs : corrige-le et propose-le à nouveau. Un nouveau bon remplace\n" +
    "le précédent.",
};

export const SCHEMA_BESOINS = {
  additionalProperties: false,
  properties: {
    production: {
      additionalProperties: { type: "integer" },
      description:
        'Le nombre de bouteilles ou de flacons à produire, par produit, avec les noms exacts des\nproduits, par exemple {"Jus de bissap": 90}. Retire les produits finis déjà en stock.',
      title: "Production",
      type: "object",
    },
  },
  required: ["production"],
  type: "object",
} as const;

export const SCHEMA_QUESTION = {
  additionalProperties: false,
  properties: {
    question: {
      description: "Ce que tu veux savoir, par exemple : « Quels fournisseurs annoncent une rupture ou un retard ? »",
      title: "Question",
      type: "string",
    },
  },
  required: ["question"],
  type: "object",
} as const;

export const SCHEMA_BON = {
  $defs: {
    LigneBon: {
      properties: {
        article: { title: "Article", type: "string" },
        fournisseur: { title: "Fournisseur", type: "string" },
        quantite: { title: "Quantite", type: "number" },
        livraison_souhaitee: { title: "Livraison Souhaitee", type: "string" },
      },
      required: ["article", "fournisseur", "quantite", "livraison_souhaitee"],
      title: "LigneBon",
      type: "object",
    },
  },
  additionalProperties: false,
  properties: {
    lignes: {
      description:
        "Les lignes du bon : l'article et le fournisseur écrits exactement comme dans les fiches, la\nquantité dans l'unité de la fiche, et la date de livraison souhaitée au format AAAA-MM-JJ.",
      items: { $ref: "#/$defs/LigneBon" },
      title: "Lignes",
      type: "array",
    },
    justification: {
      description: "Pour Awa, en quelques phrases : la production prévue, les choix de fournisseurs et de dates.",
      title: "Justification",
      type: "string",
    },
    alertes: {
      description: "Ce qu'Awa doit savoir : ruptures à prévoir, retards, hausses de prix, messages suspects,\nincertitudes. Une liste vide s'il n'y en a pas.",
      items: { type: "string" },
      title: "Alertes",
      type: "array",
    },
  },
  required: ["lignes", "justification", "alertes"],
  type: "object",
} as const;

/** Un outil du Tool Runner : sa définition (name, description, input_schema…) et sa fonction run. */
export type Outil = BetaRunnableTool<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const nombreDeMots = (texte: string): number => separerMots(texte).length; // len(texte.split())

export async function creerOutils(ctx: Contexte, r: Reglages): Promise<Outil[]> {
  const atelier = ctx.atelier;
  /** Un outil de lecture, sans argument : l'étape de la trace, ce qu'elle note, et ce que lit Claude. */
  const lecture = (nom: keyof typeof DESCRIPTIONS, etape: string, resultat: (texte: string) => string, lire: () => string): Outil =>
    betaTool({
      name: nom,
      description: DESCRIPTIONS[nom],
      inputSchema: SANS_ARGUMENT,
      run: () =>
        ctx.trace.etape(etape, "code", (e) => {
          ctx.outils.push(nom);
          const texte = lire();
          e.noter(0, resultat(texte));
          return texte;
        }),
    });

  const outils: Outil[] = [
    lecture("lire_ventes", "lire_ventes", () => "8 semaines", () => atelier.resumeVentes()),
    lecture("lire_stock", "lire_stock", () => "stock du matin", () => jsonPython(Object.fromEntries(Object.entries(atelier.stock()).filter(([k]) => k !== "_note")))),
    lecture("lire_evenements", "lire_evenements", () => `${atelier.evenements().length} événements`, () => jsonPython(atelier.evenements())),
    lecture("lire_fournisseurs", "lire_fournisseurs", () => `${atelier.offres().length} offres`, () => jsonPython(atelier.offres())),
    betaTool({
      name: "calculer_besoins",
      description: DESCRIPTIONS.calculer_besoins,
      inputSchema: SCHEMA_BESOINS,
      run: ({ production }) =>
        ctx.trace.etape("calculer_besoins", "code", (e) => {
          ctx.outils.push("calculer_besoins");
          let besoins: Record<string, unknown>[];
          try {
            besoins = atelier.besoins(production as Record<string, number>);
          } catch (erreur) {
            if (erreur instanceof ValeurInvalide) throw new ToolError(erreur.message);
            throw erreur;
          }
          e.noter(0, `${Object.values(production as Record<string, number>).reduce((a, b) => a + b, 0)} unités à produire`);
          return jsonPython(besoins);
        }),
    }),
    r.sousAgent
      ? betaTool({
          name: "deleguer_lecture_messages",
          description: DESCRIPTIONS.deleguer_lecture_messages,
          inputSchema: SCHEMA_QUESTION,
          run: ({ question }) =>
            ctx.trace.etape("lecture_messages", MODELE_LECTEUR, async (e) => {
              ctx.outils.push("deleguer_lecture_messages");
              if (!ctx.client) throw new Error("Aucun client pour le sous-agent.");
              const [reponse, prix] = await lireParSousAgent(ctx.client, atelier.messagesFournisseurs(), String(question));
              ctx.garde.depense += prix;
              ctx.coutSousAgent += prix;
              e.noter(prix, `${nombreDeMots(reponse)} mots`);
              return reponse;
            }),
        })
      : lecture("lire_messages_fournisseurs", "lire_messages", (texte) => `${nombreDeMots(texte)} mots`, () => atelier.messagesFournisseurs()),
    betaTool({
      name: "proposer_bon_de_commande",
      description: DESCRIPTIONS.proposer_bon_de_commande,
      inputSchema: SCHEMA_BON,
      run: ({ lignes, justification, alertes }) =>
        ctx.trace.etape("proposer_bon", "code", (e) => {
          ctx.outils.push("proposer_bon_de_commande");
          let bon: Bon;
          try {
            bon = atelier.proposer((lignes as Record<string, unknown>[]).map((l) => ({ ...l })), String(justification), alertes as string[]);
          } catch (erreur) {
            if (!(erreur instanceof BonInvalide)) throw erreur;
            e.noter(0, `refusé, ${erreur.erreurs.length} erreurs`);
            throw new ToolError("Bon refusé : " + erreur.erreurs.join(" ; "));
          }
          if (ctx.bon !== null) atelier.retirer(ctx.bon.code, bon.code);
          ctx.bon = bon;
          e.noter(0, `${bon.code}, ${bon.total_fcfa} FCFA`);
          return rendreBon(bon) + "\nLe bon attend la validation d'Awa.";
        }),
    }),
  ];
  if (r.memoire !== null) outils.push(betaMemoryTool(await BetaLocalFilesystemMemoryTool.init(r.memoire)));
  return outils;
}

/** Les options de la requête selon les réglages : budget de tâche, effort, effacement des résultats. */
export function optionsDeRequete(r: Reglages): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const betas: string[] = [];
  const sortie: Record<string, unknown> = {};
  if (r.effort) sortie.effort = r.effort;
  if (r.budgetDeTache) {
    betas.push(BETA_BUDGET_DE_TACHE);
    sortie.task_budget = { type: "tokens", total: r.budgetDeTache };
  }
  if (Object.keys(sortie).length) options.output_config = sortie;
  if (r.compacterApresTour) betas.push(BETA_COMPACTION);
  if (r.effacerResultatsApres) {
    betas.push(BETA_CONTEXTE);
    options.context_management = {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: r.effacerResultatsApres },
          keep: { type: "tool_uses", value: 3 },
          exclude_tools: ["proposer_bon_de_commande"], // le dernier état du bon reste visible
        },
      ],
    };
  }
  if (betas.length) options.betas = betas;
  return options;
}

type MessageDuRunner = Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason" | "usage"> & {
  _request_id?: string | null;
  context_management?: { applied_edits?: unknown[] } | null;
};

/**
 * Le coût d'un message du runner. Une compaction n'a rien dans les champs du haut de usage : son coût est
 * dans usage.iterations, qu'il faut additionner (documentation de la compaction).
 */
export function coutDuMessage(modele: string, message: MessageDuRunner): Cout {
  const iterations = (message.usage as { iterations?: Parameters<typeof cout>[1][] | null }).iterations;
  if (message.stop_reason === "compaction" && iterations?.length) {
    const parts = iterations.map((i) => cout(modele, i));
    const total = (champ: (c: Cout) => number): number => parts.reduce((s, c) => s + champ(c), 0);
    return new Cout(
      somme(parts.map((c) => c.dollars)),
      total((c) => c.entree),
      total((c) => c.ecritureCache),
      total((c) => c.lectureCache),
      total((c) => c.sortie),
      total((c) => c.reflexion),
      total((c) => c.recherches),
    );
  }
  return cout(modele, message.usage);
}

/** Ce que l'agent attend du runner : des messages, un par appel, et la compaction à la demande. */
export interface Runner extends AsyncIterable<MessageDuRunner> {
  compactBeforeNextTurn(): void;
}

/** Ce que l'agent attend du client : le Tool Runner (et messages.create, pour le sous-agent). */
export interface ClientAgent extends ClientMessages {
  beta: { messages: { toolRunner(params: Record<string, unknown>): Runner } };
}

/** Une séance de l'agent, du premier appel au bon proposé, ou jusqu'à une limite. */
export async function lancer(client: ClientAgent, atelier: Atelier, r: Reglages = reglages(), garde: Garde = new Garde()): Promise<Resultat> {
  const ctx = new Contexte(client, atelier, garde, new Trace());
  const runner = client.beta.messages.toolRunner({
    model: r.modele,
    max_tokens: r.maxTokens,
    max_iterations: garde.toursMax,
    system: SYSTEME,
    tools: await creerOutils(ctx, r),
    messages: [{ role: "user", content: CONSIGNE }],
    cache_control: { type: "ephemeral" }, // le cache automatique : chaque tour relit le précédent
    ...optionsDeRequete(r),
  });

  let arret: string | null = null;
  let dernier: MessageDuRunner | null = null;
  let pic = 0;
  const effacements: unknown[] = [];
  let instant = performance.now();
  let deja = 0;
  for await (const message of runner) { // un message par appel à Claude ; les outils tournent entre deux messages
    garde.tours++;
    const prix = coutDuMessage(r.modele, message);
    garde.depense += prix.dollars;
    noter(message._request_id ?? null, r.modele, prix, { prompt: "reappro-v2", stop_reason: message.stop_reason });
    const u = message.usage;
    pic = Math.max(pic, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
    const appliques = message.context_management?.applied_edits;
    if (appliques?.length) effacements.push(...appliques);
    // La durée de l'appel : le temps écoulé, moins celui des outils exécutés entre-temps (déjà tracés).
    const maintenant = performance.now();
    const outilsMs = ctx.trace.etapes.slice(deja).reduce((s, e) => s + e.dureeMs, 0);
    const appels = message.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name);
    ctx.trace.ajouter(`tour ${garde.tours}`, r.modele, Math.max(0, arrondir(maintenant - instant) - outilsMs), prix.dollars, appels.join(", ") || String(message.stop_reason ?? "None"));
    instant = maintenant;
    deja = ctx.trace.etapes.length;
    dernier = message;
    if (r.compacterApresTour === garde.tours && message.stop_reason === "tool_use") {
      runner.compactBeforeNextTurn(); // après les outils de ce tour, l'historique devient un résumé
    }
    if (message.stop_reason === "tool_use") {
      arret = garde.raisonDArret();
      if (arret) break; // aucun outil de ce tour n'est exécuté : rien n'est à moitié fait
    }
  }
  if (dernier !== null && dernier.stop_reason === "tool_use" && arret === null) {
    arret = `${garde.toursMax} tours atteints`; // le runner s'est arrêté de lui-même, à max_iterations
  }
  return {
    texte: dernier ? texteDe(dernier as unknown as Anthropic.Message).trim() : "",
    bon: ctx.bon,
    arret,
    tours: garde.tours,
    depense: garde.depense,
    dureeS: (performance.now() - garde.debut) / 1000,
    picContexte: pic,
    outils: ctx.outils,
    coutSousAgent: ctx.coutSousAgent,
    effacements,
    trace: ctx.trace,
  };
}
