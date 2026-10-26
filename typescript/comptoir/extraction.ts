// Transformer une photo de bon de commande ou une facture en données validées (chapitre 7).
//
// Trois étages, et aucun ne fait confiance au précédent :
// 1. le schéma, imposé à Claude par les sorties structurées : la forme est garantie ;
// 2. la validation Zod, par le code : les contraintes que l'API ne vérifie pas ;
// 3. les contrôles métier, par le code : prix du catalogue, totaux, lignes douteuses.
// Puis un humain valide, avant tout enregistrement.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { type ClientMessages, texteDe } from "./client.ts";
import { config } from "./config.ts";
import { type Cout, cout } from "./couts.ts";
import { noter } from "./journal.ts";
import { PYTHON } from "./lancement.ts";
import { type Donnees, PromptSysteme, chargerDonnees, remplir, rendreCatalogue } from "./prompt.ts";
import { formatJson } from "./sorties.ts";

export const MAX_TOKENS = 4000; // réflexion comprise : un bon de vingt lignes doit tenir sans être coupé

const Lisibilite = z.enum(["lisible", "douteux", "illisible"]);

// --- Les schémas --------------------------------------------------------------------------
// Les descriptions font partie du prompt : Claude les lit. Les contraintes comme min(1), que l'API
// n'impose pas, passent dans la description (comptoir/sorties.ts) ; Zod les vérifie.

export const LigneDeCommande = z.object({
  libelle_lu: z.string().describe("Le produit tel qu'il est écrit sur le bon, recopié sans correction."),
  produit: z.string().nullable().describe("Le nom exact du catalogue qui correspond, seulement si la correspondance est certaine ; sinon null."),
  quantite: z.number().int().min(1).nullable().describe("Le nombre de bouteilles ou de flacons ; null si illisible ou absent."),
  prix_unitaire_lu: z.number().int().nullable().describe("Le prix unitaire écrit sur le bon, en FCFA ; null s'il n'est pas écrit ou illisible."),
  lisibilite: Lisibilite,
  remarque: z.string().nullable().describe("Ce qui pose problème sur cette ligne ; null sinon."),
});

export const BonDeCommande = z.object({
  type_document: z.enum(["bon_de_commande", "autre"]),
  client: z.string().nullable().describe("Le nom du client tel qu'il est écrit ; null s'il n'y en a pas."),
  quartier: z.string().nullable().describe("Le quartier ou l'adresse de livraison ; null s'il n'y en a pas."),
  date_livraison_lue: z.string().nullable().describe("La date de livraison telle qu'elle est écrite ; null sinon."),
  lignes: z.array(LigneDeCommande),
  total_lu: z.number().int().nullable().describe("Le total écrit sur le bon, en FCFA, recopié sans calcul ; null sinon."),
  remarques: z.array(z.string()).describe("Les passages illisibles, ambigus ou inhabituels du document."),
});
export type BonDeCommande = z.infer<typeof BonDeCommande>;

export const LigneDeFacture = z.object({
  designation: z.string().describe("La désignation telle qu'elle est écrite."),
  quantite: z.number().int().min(1).nullable().describe("La quantité facturée ; null si illisible."),
  prix_unitaire: z.number().int().nullable().describe("Le prix unitaire écrit, dans la devise de la facture ; null sinon."),
  montant: z.number().int().nullable().describe("Le montant de la ligne tel qu'il est écrit ; null sinon."),
  lisibilite: Lisibilite,
});

export const Facture = z.object({
  type_document: z.enum(["facture", "autre"]),
  fournisseur: z.string().nullable().describe("Le nom du fournisseur ; null s'il est illisible."),
  numero: z.string().nullable().describe("Le numéro de la facture ; null s'il n'y en a pas."),
  date_lue: z.string().nullable().describe("La date de la facture telle qu'elle est écrite ; null sinon."),
  lignes: z.array(LigneDeFacture),
  total_lu: z.number().int().nullable().describe("Le total à payer écrit sur la facture, sans calcul ; null sinon."),
  devise: z.string().nullable().describe("La devise écrite sur la facture (par exemple FCFA) ; null sinon."),
  remarques: z.array(z.string()).describe("Les passages illisibles, ambigus ou inhabituels du document."),
});
export type Facture = z.infer<typeof Facture>;

export type SchemaDocument = typeof BonDeCommande | typeof Facture;

const CONSIGNES = new Map<SchemaDocument, string>([
  [BonDeCommande, "Voici la photo d'un bon de commande reçue sur WhatsApp. Extrais-en les données."],
  [Facture, "Voici une facture de fournisseur. Extrais-en les données."],
]);

// --- La requête ----------------------------------------------------------------------------

type Requete = Anthropic.MessageCreateParamsNonStreaming;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export function promptExtraction(version = "v1", donnees?: Donnees): PromptSysteme {
  const modele = readFileSync(join(PYTHON, "comptoir", "prompts", `extraction_${version}.md`), "utf8").replace(/\r\n/g, "\n");
  const texte = remplir(modele, { catalogue: rendreCatalogue(donnees ?? chargerDonnees()) });
  return new PromptSysteme(texte.trim(), `extraction-${version}`);
}

/** Citations et sorties structurées ne se combinent pas : l'API répondrait par une erreur 400. */
export function verifierCompatibilite(requete: Requete): void {
  const formatImpose = Boolean(requete.output_config?.format);
  const citations = requete.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => (b as { citations?: { enabled?: boolean } }).citations?.enabled),
  );
  if (formatImpose && citations) throw new Error("Citations et sorties structurées ne se combinent pas : choisissez l'une ou l'autre.");
}

export function requeteExtraction(blocs: Anthropic.ContentBlockParam[], schema: SchemaDocument, prompt = promptExtraction()): Requete {
  const outputConfig: Anthropic.OutputConfig = { format: formatJson(schema) as Anthropic.JSONOutputFormat };
  if (config.EFFORT) outputConfig.effort = config.EFFORT as Effort;
  const requete: Requete = {
    model: config.MODELE,
    max_tokens: MAX_TOKENS,
    system: prompt.texte,
    // Le document d'abord, la consigne ensuite : c'est l'ordre recommandé.
    messages: [{ role: "user", content: [...blocs, { type: "text", text: CONSIGNES.get(schema)! }] }],
    output_config: outputConfig,
  };
  verifierCompatibilite(requete);
  return requete;
}

// --- L'appel et ses issues -----------------------------------------------------------------

export interface Extraction<T> {
  donnees: T | null;
  erreur: string | null;
  stopReason: string | null;
  cout: Cout;
  identifiant: string | null;
}

/**
 * Appelle Claude et rend des données validées, ou une erreur explicite. Jamais une donnée douteuse sans
 * le dire.
 *
 * On n'utilise pas client.messages.parse() : en cas de refus ou de réponse coupée, il lève une
 * exception avant de rendre le message, et l'appel, pourtant payé, échappe au journal.
 */
export async function extraire<S extends SchemaDocument>(
  client: ClientMessages,
  blocs: Anthropic.ContentBlockParam[],
  schema: S,
  prompt = promptExtraction(),
): Promise<Extraction<z.infer<S>>> {
  const requete = requeteExtraction(blocs, schema, prompt);
  const message = await client.messages.create(requete);
  const prix = cout(requete.model, message.usage);
  const identifiant = message._request_id ?? null;
  noter(identifiant, requete.model, prix, { prompt: prompt.identifiant });

  const echec = (raison: string): Extraction<z.infer<S>> => ({ donnees: null, erreur: raison, stopReason: message.stop_reason, cout: prix, identifiant });

  // Le schéma n'est garanti que si la réponse est allée au bout normalement.
  if (message.stop_reason === "refusal") return echec("Claude a refusé de traiter ce document.");
  if (message.stop_reason === "max_tokens") return echec("Réponse coupée avant la fin : augmentez max_tokens ou découpez le document.");
  let json: unknown;
  try {
    json = JSON.parse(texteDe(message));
  } catch {
    return echec("Réponse refusée par la validation du code (JSON illisible).");
  }
  const lu = schema.safeParse(json);
  if (!lu.success) {
    const champs = lu.error.issues.map((i) => i.path.join(".")).join(", ");
    return echec(`Réponse refusée par la validation du code (${champs}).`);
  }
  return { donnees: lu.data as z.infer<S>, erreur: null, stopReason: message.stop_reason, cout: prix, identifiant };
}

// --- Les contrôles métier ------------------------------------------------------------------

export class Controle {
  readonly anomalies: string[] = [];
  montantCalcule: number | null = null; // calculé par le code, jamais par le modèle

  get aRelire(): boolean {
    return this.anomalies.length > 0;
  }
}

export function controlerBon(bon: BonDeCommande, donnees?: Donnees): Controle {
  const prix = new Map((donnees ?? chargerDonnees()).produits.map((p) => [p.nom, p.prix_fcfa]));
  const controle = new Controle();
  if (bon.type_document !== "bon_de_commande") {
    controle.anomalies.push("Ce document n'est pas un bon de commande.");
    return controle;
  }
  if (!bon.lignes.length) controle.anomalies.push("Aucune ligne de commande lue.");

  let complet = bon.lignes.length > 0;
  let total = 0;
  bon.lignes.forEach((ligne, i) => {
    const nom = `Ligne ${i + 1} (« ${ligne.libelle_lu} »)`;
    if (ligne.lisibilite !== "lisible") controle.anomalies.push(`${nom} : lecture ${ligne.lisibilite}.`);
    const prixCatalogue = ligne.produit === null ? undefined : prix.get(ligne.produit);
    if (prixCatalogue === undefined) {
      controle.anomalies.push(`${nom} : produit absent du catalogue ou incertain.`);
      complet = false;
      return;
    }
    if (ligne.quantite === null) {
      controle.anomalies.push(`${nom} : quantité illisible.`);
      complet = false;
      return;
    }
    if (ligne.prix_unitaire_lu !== null && ligne.prix_unitaire_lu !== prixCatalogue) {
      controle.anomalies.push(`${nom} : prix écrit ${ligne.prix_unitaire_lu} FCFA, catalogue ${prixCatalogue} FCFA.`);
    }
    total += ligne.quantite * prixCatalogue;
  });

  if (complet) {
    controle.montantCalcule = total;
    if (bon.total_lu !== null && bon.total_lu !== total) controle.anomalies.push(`Total écrit ${bon.total_lu} FCFA, total calculé ${total} FCFA.`);
  }
  controle.anomalies.push(...bon.remarques.map((r) => `Remarque de lecture : ${r}`));
  return controle;
}

export function controlerFacture(facture: Facture): Controle {
  const controle = new Controle();
  if (facture.type_document !== "facture") {
    controle.anomalies.push("Ce document n'est pas une facture.");
    return controle;
  }
  if (facture.devise && !["FCFA", "XOF", "F CFA"].includes(facture.devise.toUpperCase())) {
    controle.anomalies.push(`Devise inhabituelle : ${facture.devise}.`);
  }

  let complet = facture.lignes.length > 0;
  let total = 0;
  facture.lignes.forEach((ligne, i) => {
    const nom = `Ligne ${i + 1} (« ${ligne.designation} »)`;
    if (ligne.lisibilite !== "lisible") controle.anomalies.push(`${nom} : lecture ${ligne.lisibilite}.`);
    if (ligne.quantite === null || ligne.prix_unitaire === null) {
      controle.anomalies.push(`${nom} : quantité ou prix illisible.`);
      complet = false;
      return;
    }
    const attendu = ligne.quantite * ligne.prix_unitaire;
    if (ligne.montant !== null && ligne.montant !== attendu) controle.anomalies.push(`${nom} : montant écrit ${ligne.montant}, calculé ${attendu}.`);
    total += attendu;
  });

  if (complet) {
    controle.montantCalcule = total;
    if (facture.total_lu !== null && facture.total_lu !== total) controle.anomalies.push(`Total écrit ${facture.total_lu}, total calculé ${total}.`);
  }
  controle.anomalies.push(...facture.remarques.map((r) => `Remarque de lecture : ${r}`));
  return controle;
}

/** Le Comptoir range ses exemples par nom : bon-*.jpg, facture-*.pdf. */
export function schemaPour(chemin: string): SchemaDocument {
  return basename(chemin).startsWith("facture") ? Facture : BonDeCommande;
}
