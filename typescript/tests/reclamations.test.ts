// La chaîne des réclamations, avec de faux clients : aucun appel payant (python/tests/test_reclamations.py),
// et la même chaîne que la version Python : mêmes schémas, mêmes requêtes, même résultat.
// Les tests du Comptoir aiguillé sont dans aiguillage.test.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Boutique } from "../comptoir/boutique.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import {
  type Faits,
  PRODUITS,
  PROMESSES,
  PROMPT_REPONSE,
  REPLI,
  SCHEMA_EVALUATION,
  SCHEMA_FAITS,
  SYSTEME_EVALUATION,
  manques,
  normaliser,
  traiter,
} from "../comptoir/reclamations.ts";
import { Trace } from "../comptoir/trace.ts";
import { FauxClient, journalTemporaire, regler, remettreLesReglages, reponseTexte as texte } from "./faux_clients.ts";

beforeEach(() => {
  journalTemporaire();
  regler({ MODELE: "claude-sonnet-5-5", EFFORT: null, QUOTA_CLIENT_JOUR: 1.0 });
});
afterEach(remettreLesReglages);

const FAITS: Faits = { probleme: "tiede", produit: "bissap", quand: "hier", demande_du_client: null, urgence: false, resume: "Trois bouteilles tièdes." };
const BIEN = { s_excuse: true, annonce_la_transmission_a_awa: true, promet_quelque_chose: false, donne_un_conseil_medical: false, critique: "rien" };
const contenu = (client: FauxClient, i: number): string => String(client.requetes[i]!.messages[0]!.content);

test("le point de contrôle demande ce qui manque", () => {
  assert.deepEqual(manques(FAITS), []);
  assert.deepEqual(manques({ ...FAITS, produit: null, quand: null }), ["le produit concerné", "le jour de la livraison"]);
  assert.deepEqual(manques({ ...FAITS, probleme: "retard", produit: null }), []); // un retard n'a pas de produit
});

test("le produit vient du catalogue", () => {
  const choix = SCHEMA_FAITS.properties.produit.anyOf;
  assert.deepEqual(choix[0], { type: "string", enum: PRODUITS });
  assert.ok(PRODUITS.includes("Jus de bissap"));
  assert.deepEqual(choix[1], { type: "null" }); // « bouteilles » n'est pas un produit : null, et le code le demande
});

test("l'évaluateur écrit sa critique avant de cocher", () => {
  assert.equal(Object.keys(SCHEMA_EVALUATION.properties)[0], "critique");
  assert.equal(SCHEMA_EVALUATION.required[0], "critique");
});

test("la casse d'un enum est corrigée", () => {
  const faits = normaliser({ ...FAITS, probleme: "Sante", produit: "Jus De Gingembre" });
  assert.ok(faits.probleme === "sante" && faits.produit === "Jus de gingembre");
});

test("une rédaction coupée est réécrite sans payer l'évaluateur", async () => {
  const client = new FauxClient(
    texte(JSON.stringify(FAITS)),
    texte("Désolés. Votre réclamation est transmise à A", "max_tokens"),
    texte("Désolés. Transmis à Awa, réponse sous 24 heures."),
    texte(JSON.stringify(BIEN)),
  );
  const resultat = await traiter(client, "Les bouteilles étaient tièdes.", new Boutique(), "c1");
  assert.ok(resultat.tentatives === 2 && !resultat.repli && client.requetes.length === 4);
  assert.deepEqual(resultat.critiques, ["réponse arrêtée par max_tokens"]);
  assert.ok(!contenu(client, 2).includes("<critique>")); // incomplet, pas fautif
  assert.equal(resultat.reponse, "Désolés. Transmis à Awa, réponse sous 24 heures.");
});

test("une extraction illisible n'arrête pas la chaîne", async () => {
  const client = new FauxClient(texte('{"probleme": "ti', "max_tokens"), texte("Désolés. Transmis à Awa, sous 24 heures."), texte(JSON.stringify(BIEN)));
  const boutique = new Boutique();
  const resultat = await traiter(client, "Les bouteilles étaient tièdes.", boutique, "c1");
  assert.deepEqual(resultat.manques, ["le produit concerné", "le jour de la livraison"]);
  assert.ok(boutique.demandes()[0]!.resume.startsWith("Extraction impossible")); // Awa reçoit quand même la réclamation
});

test("le motif des promesses", () => {
  assert.ok(PROMESSES.test("Nous vous rembourserons") && PROMESSES.test("un avoir de 1 000 FCFA"));
  assert.ok(!PROMESSES.test("après avoir bu votre jus")); // le verbe, pas l'avoir : faux positif corrigé
  assert.ok(!PROMESSES.test("Nous allons déremboursé") && PROMESSES.test("Nous allons DÉDOMMAGER")); // limites de mot et casse, comme en Python
});

test("une réclamation conforme du premier coup", async () => {
  const client = new FauxClient(texte(JSON.stringify(FAITS)), texte("Désolés. Transmis à Awa, réponse sous 24 heures."), texte(JSON.stringify(BIEN)));
  const boutique = new Boutique();
  const trace = new Trace();
  const resultat = await traiter(client, "Les bouteilles étaient tièdes.", boutique, "c1", { trace });
  assert.ok(resultat.tentatives === 1 && !resultat.repli);
  assert.deepEqual(resultat.versions, [resultat.reponse]);
  assert.deepEqual(trace.etapes.map((e) => e.nom), ["extraction", "verification", "transmission", "redaction", "evaluation"]);
  assert.equal(boutique.demandes()[0]!.motif, "reclamation"); // toujours transmise à Awa
});

test("une promesse est refusée, puis le texte de repli", async () => {
  const promesse = "Désolés, nous vous rembourserons. Transmis à Awa.";
  const client = new FauxClient(
    texte(JSON.stringify({ ...FAITS, urgence: true })),
    texte(promesse),
    texte(JSON.stringify(BIEN)),
    texte(promesse),
    texte(JSON.stringify(BIEN)),
  );
  const boutique = new Boutique();
  const resultat = await traiter(client, "Mon fils a été malade.", boutique, "c1");
  assert.ok(resultat.repli && resultat.reponse.startsWith(REPLI) && resultat.reponse.includes("professionnel de santé"));
  assert.ok(resultat.critiques.length === 2 && resultat.critiques[0]!.includes("rembours"));
  assert.ok(contenu(client, 3).includes("<critique>")); // la 2e rédaction reçoit la critique
  assert.equal(boutique.demandes()[0]!.motif, "reclamation-urgente");
});

test("une panne pendant la rédaction ne perd pas la réclamation", async () => {
  const boutique = new Boutique();
  const panne = (): never => {
    throw new Error("panne du réseau");
  };
  await assert.rejects(traiter(new FauxClient(texte(JSON.stringify(FAITS)), panne), "Les bouteilles étaient tièdes.", boutique, "c1"), /panne du réseau/);
  assert.equal(boutique.demandes().length, 1); // transmise avant la rédaction
});

// --- La même chaîne que la version Python --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const sansPython = { skip: PYTHON_VENV ? false : "environnement Python absent" };
const python = (script: string, entree: unknown = null): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON,
      input: JSON.stringify(entree),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );

const TEXTES = [
  "Nous vous rembourserons la bouteille.", "un avoir de 1 000 FCFA", "après avoir bu votre jus", "Votre avoir est prêt",
  "d'un avoir", "La livraison est gratuite", "un geste commercial", "Nous allons compenser", "Remplacement prévu",
  "nous remplacerons", "Un cadeau vous attend", "dédommagement", "Nous allons DÉDOMMAGER", "réoffert", "offert",
  "Désolés. Transmis à Awa, réponse sous 24 heures.", "Elle est remplaçante", "irremplaçable", "un avoirs",
];
const FAITS_LUS = [
  { probleme: "Sante", produit: "Jus De Gingembre", quand: null, demande_du_client: null, urgence: true, resume: "x" },
  { probleme: "inconnu", produit: "bouteilles", quand: "hier", demande_du_client: "rembourser", urgence: false, resume: "y" },
  { probleme: "RETARD", produit: null, quand: null, demande_du_client: null, urgence: false, resume: "z" },
  { probleme: null, produit: "", quand: "", demande_du_client: null, urgence: false, resume: "" },
];

test("les mêmes schémas, prompts, promesses et faits que la version Python", sansPython, () => {
  const ts = {
    schemas: [SCHEMA_FAITS, SCHEMA_EVALUATION],
    textes: [PROMPT_REPONSE, SYSTEME_EVALUATION, REPLI],
    promesses: TEXTES.map((t) => PROMESSES.exec(t)?.[0] ?? null),
    faits: FAITS_LUS.map((f) => {
      const n = normaliser(f);
      return [n, manques(n)];
    }),
  };
  const attendu = python(
    `
import json, sys
from comptoir import reclamations as r
d = json.load(sys.stdin)
print(json.dumps({"schemas": [r.SCHEMA_FAITS, r.SCHEMA_EVALUATION], "textes": [r.PROMPT_REPONSE, r.SYSTEME_EVALUATION, r.REPLI],
                  "promesses": [m.group(0) if (m := r.PROMESSES.search(t)) else None for t in d["textes"]],
                  "faits": [[n, r.manques(n)] for n in (r.normaliser(f) for f in d["faits"])]}))`,
    { textes: TEXTES, faits: FAITS_LUS },
  );
  assert.deepEqual(ts, attendu);
});

/** Les réponses scriptées d'un scénario : du texte, et sa raison d'arrêt. */
const SCENARIOS: Record<string, [string, string][]> = {
  "coupée puis conforme": [[JSON.stringify(FAITS), "end_turn"], ["Désolés. Transmise à A", "max_tokens"], ["Désolés. Transmis à Awa, réponse sous 24 heures.", "end_turn"], [JSON.stringify(BIEN), "end_turn"]],
  "promesse puis repli": [
    [JSON.stringify({ ...FAITS, produit: "Jus De Bissap", urgence: true }), "end_turn"],
    ["Désolés, nous vous rembourserons. Transmis à Awa.", "end_turn"],
    [JSON.stringify({ ...BIEN, promet_quelque_chose: true, critique: "Elle promet un remboursement." }), "end_turn"],
    ["Désolés. Transmis à Awa, un avoir vous attend.", "end_turn"],
    ['{"critique": "illis', "max_tokens"],
  ],
  "extraction illisible": [["pas du JSON", "end_turn"], ["Désolés. Transmis à Awa.", "end_turn"], [JSON.stringify({ ...BIEN, s_excuse: false }), "end_turn"], ["Désolés. Transmis à Awa.", "end_turn"], [JSON.stringify(BIEN), "end_turn"]],
};

test("la même chaîne que la version Python : requêtes envoyées et résultat, dans trois scénarios", sansPython, async () => {
  const ts: Record<string, unknown> = {};
  for (const [nom, reponses] of Object.entries(SCENARIOS)) {
    const client = new FauxClient(...reponses.map(([t, arret]) => texte(t, arret as "end_turn")));
    const boutique = new Boutique();
    const { demande, ...resultat } = await traiter(client, "Mes 3 bouteilles de bissap étaient tièdes, hier.", boutique, "c1");
    ts[nom] = { requetes: client.requetes, resultat, demande: demande === boutique.demandes()[0]!.id, motif: boutique.demandes()[0]!.motif };
  }
  const attendu = python(
    `
import json, os, sys, tempfile
from dataclasses import asdict
from types import SimpleNamespace
from anthropic.types import Usage
from comptoir import config, reclamations
from comptoir.boutique import Boutique
# Un journal temporaire : le vrai journal de la version Python n'est pas touché.
config.MODELE, config.EFFORT, config.JOURNAL = "claude-sonnet-5-5", None, os.path.join(tempfile.mkdtemp(), "appels.jsonl")
class FauxClient:
    def __init__(self, reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []
    def create(self, **requete):
        self.requetes.append(json.loads(json.dumps(requete)))
        t, arret = self.reponses.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=t)], stop_reason=arret,
                               usage=Usage(input_tokens=500, output_tokens=60), _request_id="req")
sortie = {}
for nom, reponses in json.load(sys.stdin).items():
    client, boutique = FauxClient(reponses), Boutique()
    r = asdict(reclamations.traiter(client, "Mes 3 bouteilles de bissap étaient tièdes, hier.", boutique, "c1"))
    demande = r.pop("demande")
    sortie[nom] = {"requetes": client.requetes, "resultat": r, "demande": demande == boutique.demandes()[0][0], "motif": boutique.demandes()[0][2]}
print(json.dumps(sortie))`,
    SCENARIOS,
  );
  assert.deepEqual(ts, attendu);
});
