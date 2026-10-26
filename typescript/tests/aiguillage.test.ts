// Le Comptoir aiguillé, avec de faux clients : aucun appel payant. Les tests du chapitre 12
// (python/tests/test_reclamations.py), ceux de la garde « dire contre faire » du chapitre 18
// (python/tests/test_ch18.py), et les mêmes requêtes que la version Python.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ComptoirAiguille } from "../comptoir/aiguillage.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import type { MessageRecu } from "../comptoir/client.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { FauxClient, fauxMessage, journalTemporaire, regler, remettreLesReglages, reponseTexte as texte } from "./faux_clients.ts";

beforeEach(() => {
  journalTemporaire();
  regler({ MODELE: "claude-sonnet-5-5", EFFORT: null, QUOTA_CLIENT_JOUR: 1.0 });
});
afterEach(remettreLesReglages);

const routage = (categorie: string): MessageRecu => texte(JSON.stringify({ categorie, raison: "test" }));
const base = () => chargerBase().slice(0, 3);

// --- Chapitre 12 ---------------------------------------------------------------------------------

test("le Comptoir aiguille une question vers les documents", async () => {
  const client = new FauxClient(texte(JSON.stringify({ categorie: "information", raison: "zones" })), texte("Nous ne livrons pas à Godomey."));
  const c = new ComptoirAiguille(client, new Boutique(), new Budget(), "c1", base());
  const r = await c.repondre("Vous livrez à Godomey ?");
  assert.ok(r.categorie === "information" && r.texte === "Nous ne livrons pas à Godomey.");
  const documents = client.requetes[1]!;
  assert.equal(documents.model, "claude-haiku-5-5");
  assert.deepEqual(documents.thinking, { type: "disabled" });
  for (const bloc of (documents.messages[0]!.content as { citations?: unknown }[]).slice(0, 3)) assert.deepEqual(bloc.citations, { enabled: false });
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["routage", "documents"]);
  const dernier = c.comptoir.historique.at(-1)!.content as { text: string }[];
  assert.equal(dernier[0]!.text, "Nous ne livrons pas à Godomey."); // le fil est gardé
});

test("une réponse coupée part au Comptoir", async () => {
  const client = new FauxClient(texte(JSON.stringify({ categorie: "information", raison: "?" })), texte("", "max_tokens"), texte("Le Comptoir répond."));
  const r = await new ComptoirAiguille(client, new Boutique(), new Budget(), "c1", base()).repondre("Une question ?");
  assert.ok(r.categorie === "information, repli" && r.texte === "Le Comptoir répond.");
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["routage", "documents", "comptoir"]);
  // Le Comptoir aiguillé tourne sur config.MODELE_COMPTOIR, Claude Haiku 5.5, depuis le chapitre 17.
  assert.ok(client.requetes[2]!.model === "claude-haiku-5-5" && "tools" in client.requetes[2]!);
});

test("une réclamation passe par la chaîne, et le fil est gardé", async () => {
  const faits = { probleme: "tiede", produit: "Jus de bissap", quand: "hier", demande_du_client: null, urgence: false, resume: "Jus tiède." };
  const bien = { critique: "rien", s_excuse: true, annonce_la_transmission_a_awa: true, promet_quelque_chose: false, donne_un_conseil_medical: false };
  const client = new FauxClient(routage("reclamation"), texte(JSON.stringify(faits)), texte("Désolés. Transmis à Awa, réponse sous 24 heures."), texte(JSON.stringify(bien)));
  const boutique = new Boutique();
  const c = new ComptoirAiguille(client, boutique, new Budget(), "c1", base());
  const r = await c.repondre("Mon jus de bissap était tiède hier.");
  assert.ok(r.categorie === "reclamation" && r.texte.startsWith("Désolés."));
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["routage", "extraction", "verification", "transmission", "redaction", "evaluation"]);
  assert.equal(boutique.demandes()[0]!.motif, "reclamation");
  assert.equal(c.comptoir.historique.length, 2);
});

// --- Chapitre 18 : la garde « dire contre faire » ------------------------------------------------

test("une transmission annoncée par les documents part au Comptoir", async () => {
  const transmettre = { type: "tool_use", id: "t1", name: "transmettre_a_awa", input: { motif: "autre", resume: "Livraison un dimanche pour un mariage ?" }, caller: { type: "direct" } };
  const client = new FauxClient(
    routage("information"),
    texte("Nous ne livrons pas le dimanche. Je transmets votre question à Awa."),
    fauxMessage({ contenu: [transmettre], usage: { input_tokens: 500, output_tokens: 60 }, raisonArret: "tool_use", identifiant: "req" }),
    texte("Votre question est transmise à Awa, qui vous répondra directement."),
  );
  const boutique = new Boutique();
  const r = await new ComptoirAiguille(client, boutique, new Budget(), "c1", base()).repondre("Vous livrez le dimanche pour un mariage ? Faites passer à Awa.");
  assert.ok(r.categorie === "information, repli" && r.texte.startsWith("Votre question est transmise"));
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["routage", "documents", "garde", "comptoir"]);
  assert.deepEqual(boutique.demandes().map((d) => d.motif), ["autre"]); // cette fois, la demande existe
  assert.ok("tools" in client.requetes[2]!);
});

test("le code tient une transmission annoncée par le Comptoir sans l'outil", async () => {
  // La réponse lue au chapitre 18 (faux historique, essai 2) : une annonce, aucun appel à transmettre_a_awa.
  const lue =
    "Je ne peux pas accorder de prix à 500 F : seule Awa décide des prix spéciaux. Je transmets donc votre " +
    "demande de 10 jus de bissap pour Sèna à Awa, qui vous répondra directement.";
  const boutique = new Boutique();
  const r = await new ComptoirAiguille(new FauxClient(routage("commande"), texte(lue)), boutique, new Budget(), "c1", base()).repondre("10 jus de bissap à 500 F");
  assert.equal(r.texte, lue);
  const demandes = boutique.demandes();
  assert.deepEqual(demandes.map((d) => d.motif), ["autre"]);
  assert.ok(demandes[0]!.resume.includes("10 jus de bissap à 500 F"));
});

test("une description du rôle ne crée aucune demande", async () => {
  const boutique = new Boutique();
  const client = new FauxClient(routage("autre"), texte("Je suis l'assistant automatique de Délices d'Awa. Je fais suivre à Awa tout ce qui exige sa décision."));
  await new ComptoirAiguille(client, boutique, new Budget(), "c1", base()).repondre("Vous êtes un robot ?");
  assert.deepEqual(boutique.demandes(), []);
});

test("une réponse des documents sans annonce reste telle quelle", async () => {
  const client = new FauxClient(routage("information"), texte("Nous ne livrons pas à Godomey."));
  const r = await new ComptoirAiguille(client, new Boutique(), new Budget(), "c1", base()).repondre("Vous livrez à Godomey ?");
  assert.equal(r.categorie, "information");
  assert.deepEqual(r.trace.etapes.map((e) => e.nom), ["routage", "documents"]);
});

// --- Les mêmes requêtes que la version Python ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

/** Des conversations de deux messages, et les réponses scriptées de chaque appel. */
const SCENARIOS: Record<string, { messages: string[]; reponses: [string, string][] }> = {
  "information puis commande": {
    messages: ["Vous livrez à Godomey ?", "Alors 6 jus d'ananas à Akpakpa, au nom de Mme Hounkpè."],
    reponses: [
      [JSON.stringify({ categorie: "information", raison: "zones" }), "end_turn"],
      ["Nous ne livrons pas à Godomey.", "end_turn"],
      [JSON.stringify({ categorie: "commande", raison: "commande" }), "end_turn"],
      ["Très bien, je prépare votre récapitulatif.", "end_turn"],
    ],
  },
  "documents coupés, puis réclamation": {
    messages: ["Une question ?", "Mon jus était tiède !"],
    reponses: [
      [JSON.stringify({ categorie: "Information", raison: "?" }), "end_turn"],
      ["", "max_tokens"],
      ["Le Comptoir répond.", "end_turn"],
      [JSON.stringify({ categorie: "reclamation", raison: "tiède" }), "end_turn"],
      [JSON.stringify({ probleme: "tiede", produit: null, quand: null, demande_du_client: null, urgence: false, resume: "Jus tiède." }), "end_turn"],
      ["Désolés. Transmis à Awa, réponse sous 24 heures. De quel produit s'agit-il ?", "end_turn"],
      [JSON.stringify({ critique: "rien", s_excuse: true, annonce_la_transmission_a_awa: true, promet_quelque_chose: false, donne_un_conseil_medical: false }), "end_turn"],
    ],
  },
  "routage illisible": {
    messages: ["Bonjour", "OUI 1234"],
    reponses: [['{"categ', "max_tokens"], ["Bonjour ! Que puis-je pour vous ?", "end_turn"]],
  },
};

test("les mêmes requêtes et les mêmes réponses que la version Python, sur trois conversations", { skip: PYTHON_VENV ? false : "environnement Python absent" }, async () => {
  const ts: Record<string, unknown> = {};
  for (const [nom, { messages, reponses }] of Object.entries(SCENARIOS)) {
    const client = new FauxClient(...reponses.map(([t, arret]) => texte(t, arret as "end_turn")));
    const boutique = new Boutique();
    const c = new ComptoirAiguille(client, boutique, new Budget(), "c1", chargerBase());
    const sorties: unknown[] = [];
    for (const m of messages) {
      const r = await c.repondre(m);
      sorties.push([r.texte, r.categorie, r.trace.etapes.map((e) => [e.nom, e.modele, e.resultat.startsWith("D-") ? "D-…" : e.resultat])]);
    }
    ts[nom] = { requetes: client.requetes, sorties, demandes: boutique.demandes().map((d) => d.motif), historique: c.comptoir.historique.length };
  }
  const script = `
import json, os, sys, tempfile
from types import SimpleNamespace
from anthropic.types import TextBlock, Usage
from comptoir import config
from comptoir.aiguillage import ComptoirAiguille
from comptoir.boutique import Boutique
from comptoir.budget import Budget
from comptoir.connaissances import charger_base
# Un journal temporaire : le vrai journal de la version Python n'est pas touché.
config.MODELE, config.EFFORT, config.QUOTA_CLIENT_JOUR = "claude-sonnet-5-5", None, 1.0
config.JOURNAL = os.path.join(tempfile.mkdtemp(), "appels.jsonl")
class FauxClient:
    def __init__(self, reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []
    def create(self, **requete):
        self.requetes.append(json.loads(json.dumps(requete, default=lambda b: b.model_dump(mode="json", exclude_none=True))))
        t, arret = self.reponses.pop(0)
        return SimpleNamespace(content=[TextBlock(type="text", text=t)], stop_reason=arret, stop_details=None,
                               usage=Usage(input_tokens=500, output_tokens=60), _request_id="req")
    def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=500)
sortie = {}
for nom, s in json.load(sys.stdin).items():
    client, boutique = FauxClient(s["reponses"]), Boutique()
    c = ComptoirAiguille(client, boutique, Budget(), "c1", charger_base())
    sorties = []
    for m in s["messages"]:
        r = c.repondre(m)
        sorties.append([r.texte, r.categorie, [[e.nom, e.modele, "D-…" if e.resultat.startswith("D-") else e.resultat] for e in r.trace.etapes]])
    sortie[nom] = {"requetes": client.requetes, "sorties": sorties, "demandes": [d[2] for d in boutique.demandes()],
                   "historique": len(c.comptoir.historique)}
print(json.dumps(sortie))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(SCENARIOS), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  );
  assert.deepEqual(ts, python);
});
