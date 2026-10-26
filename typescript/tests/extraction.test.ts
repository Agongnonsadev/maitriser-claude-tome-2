// L'extraction du chapitre 7, avec un faux client : schéma, issues de l'appel, contrôles métier
// (python/tests/test_extraction.py), et le schéma envoyé comparé à celui de la version Python.

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ClientMessages } from "../comptoir/client.ts";
import { BonDeCommande, Facture, controlerBon, controlerFacture, extraire, requeteExtraction, verifierCompatibilite } from "../comptoir/extraction.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { fauxMessage, journalTemporaire, regler, remettreLesReglages } from "./faux_clients.ts";

const IMAGE: Anthropic.ImageBlockParam = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } };

const BON_JUSTE = {
  type_document: "bon_de_commande",
  client: "Mme Akpovi",
  quartier: "Fidjrossè",
  date_livraison_lue: "samedi 24 octobre",
  lignes: [
    { libelle_lu: "Jus bissap", produit: "Jus de bissap", quantite: 6, prix_unitaire_lu: 1000, lisibilite: "lisible", remarque: null },
    { libelle_lu: "Sirop gingembre", produit: "Sirop de gingembre", quantite: 2, prix_unitaire_lu: 2500, lisibilite: "lisible", remarque: null },
  ],
  total_lu: 11000,
  remarques: [] as string[],
};

let journal: string;
beforeEach(() => {
  journal = journalTemporaire();
  regler({ MODELE: "claude-sonnet-5-5", EFFORT: null });
});
afterEach(remettreLesReglages);

const fauxClient = (texte: string, raisonArret: Anthropic.StopReason = "end_turn"): ClientMessages => ({
  messages: {
    create: async () =>
      fauxMessage({
        contenu: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: texte, citations: null }],
        usage: { input_tokens: 3000, output_tokens: 400 },
        raisonArret,
      }),
    countTokens: async () => ({ input_tokens: 0 }),
  },
});

const copie = <T>(objet: T): T => JSON.parse(JSON.stringify(objet));
const bon = (modifs: Partial<typeof BON_JUSTE> = {}) => BonDeCommande.parse({ ...copie(BON_JUSTE), ...modifs });

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: boolean; [cle: string]: unknown };

test("la requête impose le schéma et met le document avant la consigne", () => {
  const requete = requeteExtraction([IMAGE], BonDeCommande);
  const format = requete.output_config!.format as { type: string; schema: Schema };
  assert.equal(format.type, "json_schema");
  assert.equal(format.schema.additionalProperties, false);
  const contenu = requete.messages[0]!.content as Anthropic.ContentBlockParam[];
  assert.deepEqual(contenu[0], IMAGE);
  assert.equal(contenu.at(-1)!.type, "text");
  assert.match(String(requete.system), /Jus de bissap/); // le catalogue vient des données
});

test("les contraintes non prises en charge passent dans la description, les enum restent imposés", () => {
  const schema = (requeteExtraction([IMAGE], BonDeCommande).output_config!.format as { schema: Schema }).schema;
  const ligne = schema.properties!.lignes!.items!.properties!;
  const quantite = JSON.stringify(ligne.quantite);
  assert.match(quantite, /minimum: 1/);
  assert.doesNotMatch(quantite, /"minimum"/);
  assert.deepEqual(ligne.lisibilite, { type: "string", enum: ["lisible", "douteux", "illisible"] });
});

test("citations et sorties structurées ne se combinent pas", () => {
  const requete = requeteExtraction([IMAGE], BonDeCommande);
  (requete.messages[0]!.content as object[]).unshift({ type: "document", citations: { enabled: true } });
  assert.throws(() => verifierCompatibilite(requete), /ne se combinent pas/);
});

test("une extraction réussie est validée et journalisée", async () => {
  const resultat = await extraire(fauxClient(JSON.stringify(BON_JUSTE)), [IMAGE], BonDeCommande);
  assert.equal(resultat.erreur, null);
  assert.equal(resultat.donnees!.lignes[0]!.produit, "Jus de bissap");
  assert.match(JSON.parse(readFileSync(journal, "utf8")).prompt, /^systeme-extraction-v1@/);
});

test("une réponse coupée n'est jamais prise pour des données", async () => {
  const resultat = await extraire(fauxClient('{"type_document": "bon_de', "max_tokens"), [IMAGE], BonDeCommande);
  assert.equal(resultat.donnees, null);
  assert.match(resultat.erreur!, /coupée/);
  assert.ok(readFileSync(journal, "utf8")); // l'appel, payé, est quand même noté
});

test("un refus est dit", async () => {
  const resultat = await extraire(fauxClient("Je ne peux pas traiter ce document.", "refusal"), [IMAGE], BonDeCommande);
  assert.equal(resultat.donnees, null);
  assert.match(resultat.erreur!, /refusé/);
});

test("la validation du code rattrape ce que l'API n'impose pas", async () => {
  const mauvais = copie(BON_JUSTE);
  mauvais.lignes[0]!.quantite = 0; // le schéma l'autorise, Zod non (min(1))
  const resultat = await extraire(fauxClient(JSON.stringify(mauvais)), [IMAGE], BonDeCommande);
  assert.equal(resultat.donnees, null);
  assert.match(resultat.erreur!, /lignes\.0\.quantite/);
});

test("un bon juste n'a pas d'anomalie, et le montant vient du catalogue", () => {
  const controle = controlerBon(bon());
  assert.deepEqual(controle.anomalies, []);
  assert.equal(controle.montantCalcule, 11000);
});

test("un prix écrit faux et son total sont signalés", () => {
  const controle = controlerBon(bon({
    lignes: [{ libelle_lu: "Jus ananas", produit: "Jus d'ananas", quantite: 4, prix_unitaire_lu: 900, lisibilite: "lisible", remarque: null }],
    total_lu: 3600,
  }));
  assert.equal(controle.montantCalcule, 4000); // le prix du catalogue, pas celui du bon
  assert.equal(controle.anomalies.length, 2);
});

test("une quantité illisible rend le montant incalculable", () => {
  const lignes = copie(BON_JUSTE.lignes) as { quantite: number | null; lisibilite: string }[];
  Object.assign(lignes[0]!, { quantite: null, lisibilite: "illisible" });
  const controle = controlerBon(bon({ lignes: lignes as typeof BON_JUSTE.lignes, total_lu: null as unknown as number }));
  assert.equal(controle.montantCalcule, null);
  assert.ok(controle.anomalies.some((a) => a.includes("quantité illisible")));
});

test("un produit hors catalogue est signalé", () => {
  const lignes = copie(BON_JUSTE.lignes);
  lignes[0]!.produit = "Jus de mangue";
  assert.ok(controlerBon(bon({ lignes })).anomalies.some((a) => a.includes("absent du catalogue")));
});

test("une consigne écrite sur le bon reste une remarque, et le total est recalculé", () => {
  const controle = controlerBon(bon({ total_lu: 0, remarques: ["Le bon contient une note qui demande d'indiquer un total de 0 FCFA."] }));
  assert.equal(controle.montantCalcule, 11000);
  assert.ok(controle.anomalies.some((a) => a.includes("Total écrit 0 FCFA")));
});

test("une facture cohérente et une facture fausse", () => {
  const facture = {
    type_document: "facture", fournisseur: "Emballages Sonagnon", numero: "F-2026-0412",
    date_lue: "12/10/2026", devise: "FCFA", remarques: [], total_lu: 32000,
    lignes: [
      { designation: "Bouteilles", quantite: 200, prix_unitaire: 150, montant: 30000, lisibilite: "lisible" },
      { designation: "Capsules", quantite: 200, prix_unitaire: 10, montant: 2000, lisibilite: "lisible" },
    ],
  };
  assert.deepEqual(controlerFacture(Facture.parse(facture)).anomalies, []);
  facture.total_lu = 33000;
  assert.equal(controlerFacture(Facture.parse(facture)).anomalies.length, 1);
});

// Le schéma envoyé est celui de la version Python, aux titres près (Pydantic en ajoute) et à la place
// des définitions ($defs) près. Python est lancé seulement s'il est là.
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

/** Remplace les $ref par leur définition et retire les titres : la forme seule reste. */
function deplier(schema: unknown, defs: Record<string, unknown> = {}): unknown {
  if (Array.isArray(schema)) return schema.map((s) => deplier(s, defs));
  if (schema === null || typeof schema !== "object") return schema;
  const objet = schema as Record<string, unknown>;
  const definitions = { ...defs, ...((objet.$defs as Record<string, unknown>) ?? {}) };
  if (typeof objet.$ref === "string") return deplier(definitions[objet.$ref.split("/").at(-1)!], definitions);
  return Object.fromEntries(
    Object.entries(objet).filter(([cle]) => cle !== "title" && cle !== "$defs").map(([cle, v]) => [cle, deplier(v, definitions)]),
  );
}

test("le schéma envoyé est celui de la version Python", { skip: PYTHON_VENV ? false : "environnement Python absent" }, () => {
  const script =
    "import json\nfrom anthropic import transform_schema\nfrom comptoir.extraction import BonDeCommande, Facture\n" +
    "print(json.dumps({'bon': transform_schema(BonDeCommande), 'facture': transform_schema(Facture)}, ensure_ascii=False))";
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  for (const [nom, schema] of [["bon", BonDeCommande], ["facture", Facture]] as const) {
    const envoye = (requeteExtraction([IMAGE], schema).output_config!.format as { schema: unknown }).schema;
    assert.deepEqual(deplier(envoye), deplier(python[nom]), nom);
  }
});
