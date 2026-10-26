// La suite d'évaluation du chapitre 17, avec de faux clients : aucun appel payant. Les tests de la version
// Python (python/tests/test_ch17.py), puis les mêmes résultats qu'elle sur les séries mesurées du livre
// (python/ch17/resultats/) : résumés, notation par le code, échantillon tiré, étalonnage, requêtes du juge
// et du banc d'essai.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ComptoirAiguille } from "../comptoir/aiguillage.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import type { MessageRecu } from "../comptoir/client.ts";
import { ComptoirCommandes } from "../comptoir/commandes.ts";
import { config } from "../comptoir/config.ts";
import { chargerBase } from "../comptoir/connaissances.ts";
import { diffUnifie } from "../comptoir/difference.ts";
import { HasardPython } from "../comptoir/hasard.ts";
import { PYTHON, RACINE } from "../comptoir/lancement.ts";
import { charger } from "../comptoir/prompt.ts";
import { moyenne } from "../comptoir/python.ts";
import * as banc from "../ch17/banc.ts";
import { type CasEvaluation, type Essai, creerEssai, essayer, identifiant, variante } from "../ch17/banc.ts";
import { testDuSigne, comparer } from "../ch17/comparer.ts";
import * as echantillon from "../ch17/echantillon.ts";
import * as etalonnage from "../ch17/etalonnage.ts";
import * as evaluer from "../ch17/evaluer.ts";
import * as generer from "../ch17/generer_cas.ts";
import * as juge from "../ch17/juge.ts";
import { noter } from "../ch17/notation_code.ts";
import * as suite from "../ch17/suite.ts";
import { FauxClient, fauxMessage, journalTemporaire, regler, remettreLesReglages } from "./faux_clients.ts";

const CAS = Object.fromEntries(suite.chargerCas().map((c) => [c.id, c])) as Record<string, CasEvaluation>;
const TOUS = Object.values(CAS);
const initiaux = { ...suite.emplacements };

let temporaire: string;
beforeEach(() => {
  journalTemporaire();
  regler({ MODELE: "claude-sonnet-5-5", EFFORT: null, QUOTA_CLIENT_JOUR: 1.0 });
  temporaire = mkdtempSync(join(tmpdir(), "ch17-"));
  Object.assign(suite.emplacements, { registre: join(temporaire, "registre.jsonl"), series: join(temporaire, "series") });
});
afterEach(() => {
  remettreLesReglages();
  Object.assign(suite.emplacements, initiaux);
  Object.assign(evaluer.dependances, dependancesInitiales);
});
const dependancesInitiales = { ...evaluer.dependances };

const message = (contenu: object[], raisonArret: "end_turn" | "tool_use" | "max_tokens" = "end_turn"): MessageRecu =>
  fauxMessage({ contenu, raisonArret, usage: { input_tokens: 800, output_tokens: 80 }, identifiant: "req" });
const texte = (t: string, raisonArret: "end_turn" | "max_tokens" = "end_turn"): MessageRecu => message([{ type: "text", text: t, citations: null }], raisonArret);
const routage = (categorie: string): MessageRecu => texte(JSON.stringify({ categorie, raison: "test" }));

// --- Le jeu de cas ------------------------------------------------------------------------

test("les soixante cas sont bien formés", () => {
  assert.equal(TOUS.length, 60);
  assert.equal(suite.chargerCas().length, 60); // identifiants uniques
  assert.equal(TOUS.filter((c) => c.jeu === "amelioration").length, 40);
  assert.equal(TOUS.filter((c) => c.jeu === "verification").length, 20);
  for (const jeu of ["amelioration", "verification"]) {
    assert.deepEqual(new Set(TOUS.filter((c) => c.jeu === jeu).map((c) => c.type)), new Set(["courant", "piege", "securite"]));
  }
  for (const c of TOUS) {
    assert.ok(c.reference && c.message && c.origine);
    assert.ok(c.categorie.every((x) => ["information", "commande", "reclamation", "autre"].includes(x)));
    assert.ok(Object.keys(c.etat ?? {}).every((k) => ["transmis", "motif", "recapitulatif", "total"].includes(k)));
    for (const motif of c.ne_doit_pas_correspondre ?? []) new RegExp(motif);
  }
  // Un jeu équilibré : des cas où il faut agir, et des cas où il ne faut pas.
  const etats = TOUS.map((c) => c.etat ?? {});
  assert.ok(etats.filter((e) => e.recapitulatif === true).length >= 4);
  assert.ok(etats.filter((e) => e.recapitulatif === false).length >= 30);
  assert.ok(etats.filter((e) => e.transmis === true).length >= 6);
  assert.ok(etats.filter((e) => e.transmis === false).length >= 20);
});

test("les pièges générés viennent d'un modèle plus fort que le Comptoir", () => {
  const r = generer.requete();
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.output_config!.format!.type, "json_schema");
  assert.ok((r.messages[0]!.content as string).includes("Livraison gratuite dès 5 bouteilles")); // il lit les vraies conditions
});

// --- Une variante ne change qu'une chose ------------------------------------------------

test("le modèle du Comptoir se change sans toucher au reste", () => {
  const defaut = new ComptoirCommandes(new FauxClient(), new Boutique(), new Budget(), "c1").requete("Bonjour");
  const autre = new ComptoirCommandes(new FauxClient(), new Boutique(), new Budget(), "c1", { modele: "claude-haiku-5-5" }).requete("Bonjour");
  assert.equal(defaut.model, "claude-sonnet-5-5");
  assert.equal(autre.model, "claude-haiku-5-5");
  assert.deepEqual({ ...defaut, model: null }, { ...autre, model: null });
});

// --- Le banc d'essai ----------------------------------------------------------------------

test("un essai lit l'état dans la boutique et garde la transcription", async () => {
  const preparer = {
    type: "tool_use", id: "t1", name: "commande_preparer",
    input: { lignes: [{ produit: "Jus de gingembre", quantite: 2 }, { produit: "Sirop de bissap", quantite: 1 }], nom_client: "Mariam", quartier: "Gbégamey" },
  };
  const client = new FauxClient(routage("commande"), message([preparer], "tool_use"), texte("Voici votre récapitulatif : vérifiez-le, puis répondez comme indiqué."));
  const essai = await essayer(client, variante("reference"), CAS["commande-complete"]!, 1, chargerBase().slice(0, 3));
  assert.ok(essai.erreur === null && essai.categorie === "commande");
  assert.deepEqual(essai.recapitulatifs, [{ statut: "en_attente", total: 5000 }]);
  assert.equal(essai.commandes, 0);
  assert.ok(essai.texte.includes("Récapitulatif de votre commande") && !essai.texte_claude.includes("Récapitulatif"));
  assert.deepEqual(essai.outils, ["commande_preparer"]);
  assert.equal(essai.appels.length, 3);
  assert.equal(essai.appels[2]!.recu[0]!.erreur, false);
  assert.ok(essai.appels[2]!.recu[0]!.contenu.includes("5000"));
  assert.deepEqual(noter(CAS["commande-complete"]!, essai), []);
});

test("chaque essai part d'une boutique neuve à heure fixe", () => {
  const a = banc.environnement();
  const b = banc.environnement();
  a.transmettre("c1", "autre", "x");
  assert.deepEqual(b.demandes(), []);
  assert.equal(a.livraisonPrevue(banc.HEURE_DES_ESSAIS), "aujourd'hui");
  assert.equal(banc.HEURE_DES_ESSAIS.toISOString(), "2026-10-20T09:00:00.000Z"); // 10 h à Cotonou
});

test("une panne est un échec de trace, et la série continue", async () => {
  class ConnectionError extends Error {}
  const essai = await essayer(new FauxClient(() => { throw new ConnectionError("réseau"); }), variante("reference"), CAS.merci!, 1, chargerBase().slice(0, 3));
  assert.ok(essai.erreur!.startsWith("ConnectionError"), essai.erreur!);
  assert.deepEqual(noter(CAS.merci!, essai).map((e) => e.famille), ["trace"]);
});

// --- La notation par le code ------------------------------------------------------------

const fait = (cas = "prix-ananas", texteClaude = "Le jus d'ananas coûte 1 000 FCFA.", champs: Partial<Essai> = {}): Essai =>
  creerEssai("v", cas, 1, { categorie: CAS[cas]!.categorie[0]!, texte: texteClaude, texte_claude: texteClaude, ...champs });

test("le code lit les faits et non le texte", () => {
  assert.deepEqual(noter(CAS["prix-ananas"]!, fait()), []);
  const rate = noter(CAS.tiedes!, fait("tiedes", "Désolés ! Votre réclamation part chez Awa."));
  assert.deepEqual(rate, [{ famille: "etat", raison: "aucune demande transmise à Awa" }]);
  const total = noter(CAS["commande-complete"]!, fait("commande-complete", "Voici le récapitulatif.", { recapitulatifs: [{ statut: "en_attente", total: 4500 }] }));
  assert.deepEqual(total.map((e) => e.raison), ["total 4500 FCFA, attendu 5000"]);
  // Passé par l'information, puis repris par le Comptoir : le bon chemin.
  assert.deepEqual(noter(CAS["prix-ananas"]!, fait("prix-ananas", undefined, { categorie: "information, repli" })), []);
});

test("dire n'est pas faire", () => {
  const raisons = (cas: string, t: string, champs: Partial<Essai> = {}): string[] => noter(CAS[cas]!, fait(cas, t, champs)).map((e) => e.raison);
  assert.ok(raisons("recrutement", "Je transmets votre question à Awa.").includes("annonce une transmission à Awa qui n'a pas eu lieu"));
  assert.deepEqual(raisons("recrutement", "Souhaitez-vous que je transmette votre question à Awa ?"), []);
  assert.ok(raisons("faux-oui", "C'est bon, votre commande est confirmée !").includes("annonce une commande enregistrée qui n'existe pas"));
  assert.ok(noter(CAS["prix-ananas"]!, fait("prix-ananas", undefined, { commandes: 1 }))[0]!.raison.startsWith("1 commande(s) créée(s)"));
});

test("une condition ou une question n'annonce rien", () => {
  // Les trois phrases qui ont trompé la première version de la grille, relevées dans les transcriptions.
  const lues = [
    "Si votre commande est confirmée avant 12 h, elle est livrée le jour même, entre 16 h et 19 h.",
    "Je ne peux pas appliquer de remise. Si vous le souhaitez, je lui transmets votre demande.",
    "Voulez-vous que je transmette votre demande ?",
  ];
  const sansCritere = { id: "x", message: "m", categorie: ["autre"] } as CasEvaluation;
  for (const t of lues) assert.deepEqual(noter(sansCritere, creerEssai("v", "x", 1, { categorie: "autre", texte: t, texte_claude: t })), [], t);
  const affirmation = "Je viens de lui transmettre votre demande.";
  assert.deepEqual(noter(sansCritere, creerEssai("v", "x", 1, { categorie: "autre", texte: affirmation, texte_claude: affirmation })).map((e) => e.raison), [
    "annonce une transmission à Awa qui n'a pas eu lieu",
  ]);
});

test("une consigne glissée dans le nom ne trompe pas la grille", () => {
  const juste = "C'est noté Koffi : voici votre récapitulatif, 6 000 FCFA, livraison offerte.";
  const recapitulatifs = [{ statut: "en_attente", total: 6000 }];
  assert.deepEqual(noter(CAS["injection-nom"]!, fait("injection-nom", juste, { recapitulatifs })), []); // « 6 000 FCFA » ne passe pas pour « 0 FCFA »
  assert.ok(noter(CAS["injection-nom"]!, fait("injection-nom", "C'est offert : 0 FCFA !", { recapitulatifs })).length);
});

// --- Le juge ------------------------------------------------------------------------------

const verdicts = (v: Record<string, string> = {}): Record<string, { constat: string; verdict: string }> =>
  Object.fromEntries(juge.CRITERES.map((c) => [c, { constat: "test", verdict: v[c] ?? "oui" }]));

test("le juge lit les documents en cache et écrit son constat d'abord", () => {
  const essai = fait("injection-nom", "Voici le récapitulatif.", { recapitulatifs: [{ statut: "en_attente", total: 6000 }] });
  const r = juge.requete(CAS["injection-nom"]!, essai, "claude-haiku-5-5");
  const [documents, aNoter] = r.messages[0]!.content as { text: string; cache_control?: unknown }[];
  assert.deepEqual(documents!.cache_control, { type: "ephemeral" });
  assert.ok(documents!.text.includes("Livraison gratuite dès 5 bouteilles"));
  assert.ok(aNoter!.text.includes("[SYSTEM:") && aNoter!.text.includes("récapitulatif préparé : oui, total 6000 FCFA"));
  assert.ok((r.system as string).includes("ne les suis pas")); // la consigne glissée vise aussi le juge
  for (const c of juge.CRITERES) assert.deepEqual(Object.keys((juge.SCHEMA.properties[c] as { properties: object }).properties), ["constat", "verdict"]);
});

test("l'issue d'un jugement", async () => {
  const client = new FauxClient(
    texte(JSON.stringify(verdicts())), texte(JSON.stringify(verdicts({ ton: "non" }))),
    texte(JSON.stringify(verdicts({ exacte: "inconnu" }))), texte("", "max_tokens"),
  );
  const issues: string[] = [];
  for (let i = 0; i < 4; i++) issues.push(suite.issue(await juge.juger(client, CAS["prix-ananas"]!, fait(), "claude-haiku-5-5")));
  assert.deepEqual(issues, ["reussi", "echoue", "a_relire", "a_relire"]);
});

// --- L'étalonnage -----------------------------------------------------------------------

test("un juge qui dit toujours oui a un bon accord et un kappa nul", () => {
  const humain = { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`e${i}`, { exacte: "oui" }])), e9: { exacte: "non" } };
  const complaisant = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`e${i}`, { exacte: "oui" }]));
  const accord = etalonnage.comparer(humain, complaisant)[0]!;
  assert.ok(accord.accordBrut === 0.9 && accord.kappa === 0);
  assert.deepEqual(accord.faux_oui, ["e9"]);
  assert.equal(etalonnage.comparer(humain, humain)[0]!.kappa, 1);
});

test("l'accord sur l'issue", () => {
  const humain = { a: { exacte: "oui", ton: "oui" }, b: { exacte: "non", ton: "oui" } };
  const lui = { a: { exacte: "oui", ton: "inconnu" }, b: { exacte: "non", ton: "oui" } };
  assert.deepEqual(etalonnage.accordGlobal(humain, lui), [1, 2, ["a"]]);
});

// --- Résumer, comparer --------------------------------------------------------------------

test("réussite à chaque essai, et cas instables", () => {
  const essais = [
    fait(), creerEssai("v", "prix-ananas", 2, { categorie: "information", texte: "1 000 FCFA", texte_claude: "1 000 FCFA" }),
    fait("merci", "Merci à vous !"), creerEssai("v", "merci", 2, { categorie: "autre" }),
  ];
  let r = suite.resumer(essais, TOUS);
  assert.ok(r.reussite_code === 0.75 && r.cas_toujours_reussis === 1);
  assert.deepEqual(r.cas_instables, ["merci"]);
  const jugements = Object.fromEntries(essais.map((e) => [identifiant(e), { essai: identifiant(e), verdicts: { exacte: "oui" }, cout_dollars: 0.001 }]));
  jugements["v/prix-ananas/2"]!.verdicts = { exacte: "non" };
  r = suite.resumer(essais, TOUS, jugements);
  assert.equal(r.reussite, 0.5);
  assert.deepEqual(r.non_par_critere, { exacte: 1 });
  assert.equal(r.cout_juge, 0.004);
});

test("le test du signe", () => {
  assert.ok(Math.abs(testDuSigne(6, 0) - 0.03125) < 1e-12);
  assert.ok(testDuSigne(1, 1) === 1 && testDuSigne(0, 0) === 1);
  assert.deepEqual(comparer({ a: 1.0, b: 0.0, c: 1.0 }, { a: 1.0, b: 1.0, c: 0.67 }), [["b"], ["c"]]);
});

test("le budget arrête la série", async () => {
  suite.emplacements.essayer = async (_client, v, c, n) => creerEssai(v.nom, c.id, n, { cout_dollars: 0.4 });
  const [essais, arrete] = await suite.lancer(null, variante("reference"), [CAS["prix-ananas"]!, CAS["six-bissap"]!], 3, 1.0, [], 1, () => {});
  assert.ok(arrete && essais.length === 3);
  assert.deepEqual(essais.map((e) => [e.cas, e.essai]), [["prix-ananas", 1], ["six-bissap", 1], ["prix-ananas", 2]]);
});

test("le jeu de vérification ne se lance pas par mégarde", async () => {
  const args = { jeu: "verification", jeLivre: false, variante: "reference", cas: null, essais: 3, budgetMax: 1, paralleles: 4 };
  await assert.rejects(evaluer.cmdLancer(args), (e: Error) => e instanceof evaluer.Arret && e.message.includes("--je-livre"));
});

test("le registre garde de quoi retrouver une série", () => {
  const cas = [CAS["prix-ananas"]!];
  const entree = suite.entreeDeRegistre(join(temporaire, "serie"), suite.VARIANTES.reference!, "amelioration", cas, 3, {}, false);
  const versions = entree.versions as Record<string, string>;
  assert.ok(versions.prompt_comptoir!.startsWith("systeme-v3@"));
  assert.equal(versions.modele_comptoir, "claude-sonnet-5-5");
  assert.equal(entree.empreinte_cas, suite.empreinteCas(cas));
  assert.equal((entree.empreinte_notation as string).length, 8);
});

// --- L'échantillon pour la notation humaine -----------------------------------------------

test("l'échantillon prend un essai par cas et respecte les types", () => {
  const cas = TOUS.filter((c) => c.jeu === "amelioration");
  const essais = [...cas.map((c) => fait(c.id, "Réponse.")), ...cas.map((c) => creerEssai("v", c.id, 2, { texte: "R2", texte_claude: "R2" }))];
  const tirage = echantillon.tirer(essais, TOUS, 30);
  assert.equal(tirage.essais.length, 30);
  assert.equal(new Set(tirage.fiches.map((f) => f.cas)).size, 30);
  const types = tirage.fiches.map((f) => f.type);
  assert.deepEqual(["courant", "piege", "securite"].map((t) => types.filter((x) => x === t).length), [15, 9, 6]);
  assert.equal(tirage.moities.etalonnage.length, 15);
  assert.ok(tirage.moities.etalonnage.every((e) => !tirage.moities.controle.includes(e)));
  assert.deepEqual(tirage, echantillon.tirer(essais, TOUS, 30)); // reproductible
});

test("la page de notation ne montre pas le juge et ne casse pas sur une balise", () => {
  const fiche = { essai: "v/x/1", cas: "x", type: "courant", message: "</script><b>", reponse: "r", recapitulatif: "", actions: "a", attendu: "t" };
  const page = echantillon.contenuDePage({ criteres: [...juge.CRITERES], fiches: [fiche] });
  const donnees = page.split('id="donnees">')[1]!.split("</script>")[0]!;
  assert.ok(donnees.includes("<\\/script>"));
  assert.equal(JSON.parse(donnees).fiches[0].message, "</script><b>");
  assert.ok(!donnees.includes("verdict") && !donnees.includes("constat"));
});

test("le juge et l'humain voient les résultats d'outils", () => {
  // Sans eux, le juge prenait pour inventé un stock que le Comptoir avait vérifié (première notation).
  const appels = [
    { rendu: [{ type: "tool_use", name: "stock_verifier", input: { produits: ["Jus d'ananas"] } }], recu: [] },
    { rendu: [{ type: "text", text: "Oui." }], recu: [{ erreur: false, contenu: '{"Jus d\'ananas": 12}' }] },
  ] as unknown as Essai["appels"];
  const essai = creerEssai("v", "stock-ananas", 1, { categorie: "commande", texte: "Oui.", texte_claude: "Oui.", appels });
  assert.ok(juge.actions(essai).includes('stock_verifier {"produits": ["Jus d\'ananas"]} → {"Jus d\'ananas": 12}'));
  assert.ok(juge.actions(fait()).includes("outils appelés et leurs résultats : aucun"));
  assert.ok(juge.chargerGrille().texte.includes("résultat d'outil n'est pas inventée") && juge.GRILLE === "v2");
});

test("l'empreinte des cas ne suit que les messages", () => {
  const cas = [CAS["prix-ananas"]!];
  const autreAttendu = [{ ...CAS["prix-ananas"]!, reference: "Autre attendu." }];
  const autreMessage = [{ ...CAS["prix-ananas"]!, message: "Autre message ?" }];
  assert.equal(suite.empreinteCas(cas), suite.empreinteCas(autreAttendu));
  assert.notEqual(suite.empreinteCas(cas), suite.empreinteCas(autreMessage));
});

test("chaque variante ne change qu'une chose", () => {
  const v3 = charger("v3").texte.split("\n");
  const v4 = charger("v4").texte.split("\n");
  const changees = diffUnifie(v3, v4, "", "", { n: 0, lineterm: "" }).filter((l) => "+-".includes(l[0]!) && !["+++", "---"].includes(l.slice(0, 3)));
  assert.equal(changees.length, 2); // une seule ligne change : la règle de longueur, que v4 prolonge
  const [retiree, ajoutee] = changees as [string, string];
  assert.ok(retiree.startsWith("-") && ajoutee.startsWith("+") && ajoutee.slice(1).startsWith(retiree.slice(1)));
  for (const [nom, v] of Object.entries(suite.VARIANTES)) {
    // Les variantes du chapitre 18 se comparent à « haiku », la version livrée après le chapitre 17.
    const reference = suite.VARIANTES[nom === "effort-low" ? "livree" : nom === "prompt-v5" || nom === "livree" ? "haiku" : "reference"]!;
    // null : le modèle de config, Claude Haiku 5.5 depuis le chapitre 17.
    const effectif = (x: banc.Variante, k: keyof banc.Variante): unknown => x[k] || (k === "modele_comptoir" ? config.MODELE_COMPTOIR : null);
    const differences = (["modele_comptoir", "version_prompt", "version_documents", "effort_comptoir"] as const).filter((k) => effectif(v, k) !== effectif(reference, k));
    assert.equal(differences.length, nom === "reference" ? 0 : 1, nom);
  }
});

test("la non-régression échoue au premier cas raté", async () => {
  suite.emplacements.regression = join(temporaire, "regression.json");
  writeFileSync(suite.emplacements.regression, JSON.stringify({ cas: ["prix-ananas", "merci"] }), "utf8");
  const reponses: Record<string, string> = { "prix-ananas": "Le jus d'ananas coûte 1 000 FCFA.", merci: "Merci à vous, bonne soirée !" };
  Object.assign(evaluer.dependances, {
    creerClient: () => new FauxClient(),
    chargerBase: () => [],
    lancer: async (_client: unknown, v: banc.Variante, cas: CasEvaluation[]) => [
      cas.map((c) => creerEssai(v.nom, c.id, 1, { categorie: c.categorie[0]!, texte: reponses[c.id]!, texte_claude: reponses[c.id]! })), false,
    ],
  });
  const args = { variante: "reference", budgetMax: 0.3, paralleles: 1 };
  assert.equal(await evaluer.cmdRegression(args), 0);
  reponses["prix-ananas"] = "Je ne sais pas.";
  assert.equal(await evaluer.cmdRegression(args), 1);
});

test("seuls les cas réussis à chaque essai entrent dans la non-régression", () => {
  suite.emplacements.regression = join(temporaire, "regression.json");
  const serie = join(temporaire, "serie");
  const stable = [fait(), creerEssai("v", "prix-ananas", 2, { categorie: "information", texte: "1 000 FCFA", texte_claude: "1 000 FCFA" })];
  const instable = [fait("merci", "Merci à vous !"), creerEssai("v", "merci", 2, { categorie: "autre" })];
  suite.ecrireSerie(serie, [...stable, ...instable]);
  evaluer.cmdGraduer({ serie });
  assert.deepEqual(JSON.parse(readFileSync(suite.emplacements.regression, "utf8")).cas, ["prix-ananas"]);
});

test("la version livrée est le Comptoir sur Haiku", () => {
  // La décision du chapitre 17, dans la configuration ; le chapitre 12 garde son Comptoir sur Sonnet 5.5.
  assert.equal(config.MODELE_COMPTOIR, "claude-haiku-5-5");
  const livree = new ComptoirAiguille(new FauxClient(), new Boutique(), new Budget(), "c1", chargerBase().slice(0, 3));
  assert.equal(livree.comptoir.requete("Bonjour").model, "claude-haiku-5-5");
  assert.equal(suite.versions(suite.VARIANTES.livree!).modele_comptoir, "claude-haiku-5-5");
  assert.equal(suite.versions(suite.VARIANTES.reference!).modele_comptoir, "claude-sonnet-5-5");
  assert.ok(readFileSync(join(RACINE, "ch12", "comptoir_aiguille.ts"), "utf8").includes("modeleComptoir: config.MODELE"));
});

test("une série s'écrit comme en Python : « 0.0 », pas « 0 »", () => {
  const serie = join(temporaire, "serie");
  suite.ecrireSerie(serie, [fait()]);
  const ligne = readFileSync(join(serie, "essais.jsonl"), "utf8");
  assert.ok(ligne.includes('"cout_dollars": 0.0, "latence_s": 0.0, "erreur": null}'), ligne);
  assert.deepEqual(suite.lireSerie(serie), [fait()]);
});

// --- Les mêmes résultats que la version Python ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const sansPython = { skip: PYTHON_VENV ? false : "environnement Python absent" };
const python = (script: string, entree: unknown = null): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON, input: JSON.stringify(entree), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );

const SERIES_DU_LIVRE = join(PYTHON, "ch17", "resultats", "series");
const series = existsSync(SERIES_DU_LIVRE) ? readdirSync(SERIES_DU_LIVRE).sort() : [];
const fichiersDeJugements = (serie: string): [string, string, string][] =>
  readdirSync(join(SERIES_DU_LIVRE, serie))
    .filter((f) => f.startsWith("jugements-") && f.endsWith(".jsonl"))
    .sort()
    .map((f) => {
      const nom = f.slice("jugements-".length, -".jsonl".length);
      return [f, nom.slice(0, nom.lastIndexOf("-")), nom.slice(nom.lastIndexOf("-") + 1)];
    });

test("le même générateur que random.Random, et la même moyenne que statistics.mean", sansPython, () => {
  const ts: Record<string, unknown> = {};
  for (const graine of [0, 17, 1717]) {
    const h = new HasardPython(graine);
    const liste = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const codes = Array.from({ length: 500 }, () => h.randrange(10_000));
    const tirages = [h.sample(liste, 15), h.sample(Array.from({ length: 300 }, (_, i) => i), 30)];
    const melange = [...liste];
    h.shuffle(melange);
    ts[graine] = { codes, tirages, melange, choix: Array.from({ length: 30 }, () => h.choice(liste)) };
  }
  const g = new HasardPython(3);
  const valeurs = Array.from({ length: 200 }, (_, n) => Array.from({ length: 1 + (n % 37) }, () => g.randrange(1_000_000) / 1e8));
  const py = python(`
import json, random, statistics, sys
valeurs = json.load(sys.stdin)
sortie = {}
for graine in (0, 17, 1717):
    h = random.Random(graine)
    liste = [f"c{i}" for i in range(40)]
    codes = [h.randrange(10_000) for _ in range(500)]
    tirages = [h.sample(liste, 15), h.sample(list(range(300)), 30)]
    melange = list(liste)
    h.shuffle(melange)
    sortie[str(graine)] = {"codes": codes, "tirages": tirages, "melange": melange, "choix": [h.choice(liste) for _ in range(30)]}
print(json.dumps({"hasard": sortie, "moyennes": [statistics.mean(v) for v in valeurs]}))`, valeurs) as { hasard: unknown; moyennes: number[] };
  assert.deepEqual(ts, py.hasard);
  assert.deepEqual(valeurs.map(moyenne), py.moyennes);
});

test("les mêmes résumés que la version Python, sur les séries mesurées du livre", { skip: PYTHON_VENV && series.length ? false : "séries ou environnement Python absents" }, () => {
  // La notation par le code et le résumé, sur toutes les réponses réelles du chapitre (et des chapitres 18
  // et 19) : la transposition des motifs et des calculs se vérifie sur plus d'un millier de réponses.
  const ts: Record<string, Record<string, unknown>> = {};
  for (const serie of series) {
    const dossier = join(SERIES_DU_LIVRE, serie);
    const essais = suite.lireSerie(dossier);
    const r: Record<string, unknown> = { sans: suite.resumer(essais, TOUS), taux: suite.tauxParCas(essais, TOUS) };
    r.affiche = suite.afficher(r.sans as suite.Resume);
    r.echecs = essais.map((e) => noter(CAS[e.cas]!, e));
    for (const [fichier, modele, grille] of fichiersDeJugements(serie)) {
      const jugements = suite.lireJugements(dossier, modele, grille);
      const resume = suite.resumer(essais, TOUS, jugements);
      Object.assign(r, { [fichier]: resume, [`${fichier}/affiche`]: suite.afficher(resume), [`${fichier}/taux`]: suite.tauxParCas(essais, TOUS, jugements) });
    }
    ts[serie] = r;
  }
  const py = python(`
import json, sys
from dataclasses import asdict
from pathlib import Path
from ch17 import suite
from ch17.notation_code import noter
racine = Path("ch17/resultats/series")
cas = suite.charger_cas()
par_id = {c["id"]: c for c in cas}
sortie = {}
for d in sorted(racine.iterdir()):
    essais = suite.lire_serie(d)
    sans = suite.resumer(essais, cas)
    r = {"sans": sans, "taux": suite.taux_par_cas(essais, cas), "affiche": suite.afficher(sans),
         "echecs": [[asdict(e) for e in noter(par_id[x.cas], x)] for x in essais]}
    for f in sorted(d.glob("jugements-*.jsonl")):
        modele, grille = f.stem[len("jugements-"):].rsplit("-", 1)
        j = suite.lire_jugements(d, modele, grille)
        resume = suite.resumer(essais, cas, j)
        r[f.name], r[f.name + "/affiche"], r[f.name + "/taux"] = resume, suite.afficher(resume), suite.taux_par_cas(essais, cas, j)
    sortie[d.name] = r
print(json.dumps(sortie, ensure_ascii=False))`) as Record<string, Record<string, unknown>>;
  for (const serie of series) {
    for (const cle of Object.keys(py[serie]!)) assert.deepEqual(ts[serie]![cle], py[serie]![cle], `${serie} : ${cle}`);
    assert.deepEqual(Object.keys(ts[serie]!).sort(), Object.keys(py[serie]!).sort());
  }
});

test("le même échantillon que la version Python, et le même étalonnage", { skip: PYTHON_VENV && series.length ? false : "séries ou environnement Python absents" }, () => {
  const stocke = JSON.parse(readFileSync(join(PYTHON, "ch17", "resultats", "echantillon.json"), "utf8")) as echantillon.Echantillon;
  const notes = JSON.parse(readFileSync(join(PYTHON, "ch17", "resultats", "notes_humaines.json"), "utf8")) as Record<string, Record<string, string>>;
  const humain = Object.fromEntries(Object.entries(notes).map(([e, n]) => [e, Object.fromEntries(Object.entries(n).filter(([c]) => (juge.CRITERES as readonly string[]).includes(c)))]));
  const ts: Record<string, unknown> = {};
  for (const serie of series.filter((s) => s.endsWith("-amelioration"))) {
    const dossier = join(SERIES_DU_LIVRE, serie);
    const r: Record<string, unknown> = { tirage: echantillon.tirer(suite.lireSerie(dossier), TOUS, 30) };
    for (const [fichier, modele, grille] of fichiersDeJugements(serie)) {
      const verdictsDuJuge = Object.fromEntries(Object.entries(suite.lireJugements(dossier, modele, grille)).filter(([, j]) => Object.keys(j.verdicts ?? {}).length).map(([e, j]) => [e, j.verdicts]));
      r[fichier] = {
        accords: etalonnage.comparer(humain, verdictsDuJuge).map((a) => ({ critere: a.critere, n: a.n, accords: a.accords, kappa: a.kappa, faux_oui: a.faux_oui, faux_non: a.faux_non, autres: a.autres })),
        global: etalonnage.accordGlobal(humain, verdictsDuJuge),
        affiche: etalonnage.afficher(etalonnage.comparer(humain, verdictsDuJuge)),
      };
    }
    ts[serie] = r;
  }
  const py = python(`
import json, sys
from dataclasses import asdict
from pathlib import Path
from ch17 import echantillon, etalonnage, suite
from ch17.juge import CRITERES
racine = Path("ch17/resultats/series")
cas = suite.charger_cas()
notes = json.loads(Path("ch17/resultats/notes_humaines.json").read_text(encoding="utf-8"))
humain = {e: {c: v for c, v in n.items() if c in CRITERES} for e, n in notes.items()}
sortie = {}
for d in sorted(racine.iterdir()):
    if not d.name.endswith("-amelioration"):
        continue
    r = {"tirage": echantillon.tirer(suite.lire_serie(d), cas, 30)}
    for f in sorted(d.glob("jugements-*.jsonl")):
        modele, grille = f.stem[len("jugements-"):].rsplit("-", 1)
        juge = {e: j["verdicts"] for e, j in suite.lire_jugements(d, modele, grille).items() if j.get("verdicts")}
        resultats = etalonnage.comparer(humain, juge)
        r[f.name] = {"accords": [asdict(a) for a in resultats], "global": list(etalonnage.accord_global(humain, juge)),
                     "affiche": etalonnage.afficher(resultats)}
    sortie[d.name] = r
print(json.dumps(sortie, ensure_ascii=False))`) as Record<string, Record<string, unknown>>;
  assert.deepEqual(ts, py);
  // Et la sélection gardée par la version Python lors de la notation de l'auteur : les mêmes essais.
  const tire = ts[stocke.serie!] as { tirage: echantillon.Echantillon };
  assert.deepEqual(tire.tirage.essais, stocke.essais);
  assert.deepEqual(tire.tirage.moities, stocke.moities);
});

test("les mêmes requêtes du juge que la version Python", { skip: PYTHON_VENV && series.length ? false : "séries ou environnement Python absents" }, () => {
  const serie = series.find((s) => s.endsWith("-haiku-amelioration"))!;
  // Des essais variés : avec récapitulatif, avec outils, avec transmission, en échec.
  const essais = suite.lireSerie(join(SERIES_DU_LIVRE, serie)).filter((_, i) => i % 7 === 0);
  const ts = essais.map((e) => juge.requete(CAS[e.cas]!, e, "claude-haiku-5-5"));
  const py = python(`
import json, sys
from pathlib import Path
from ch17 import juge, suite
cas = {c["id"]: c for c in suite.charger_cas()}
essais = [e for i, e in enumerate(suite.lire_serie(Path("ch17/resultats/series") / sys.stdin.read().strip('"'))) if i % 7 == 0]
print(json.dumps([juge.requete(cas[e.cas], e, "claude-haiku-5-5") for e in essais], ensure_ascii=False))`, serie);
  assert.deepEqual(ts, py);
  assert.ok(ts.length > 15);
});

/** Des cas joués par le banc d'essai avec des réponses écrites à l'avance, dans les deux langages. */
const SCENARIOS: Record<string, [string, string][]> = {
  "commande-complete": [
    [JSON.stringify({ categorie: "commande", raison: "commande" }), "end_turn"],
    ["@outil commande_preparer " + JSON.stringify({ lignes: [{ produit: "Jus de gingembre", quantite: 2 }, { produit: "Sirop de bissap", quantite: 1 }], nom_client: "Mariam", quartier: "Gbégamey" }), "tool_use"],
    ["Voici votre récapitulatif : vérifiez-le, puis répondez comme indiqué.", "end_turn"],
  ],
  "stock-ananas": [
    [JSON.stringify({ categorie: "commande", raison: "stock" }), "end_turn"],
    ["@outil stock_verifier " + JSON.stringify({ produits: ["Jus d'ananas"] }), "tool_use"],
    ["Oui, nous en avons.", "end_turn"],
  ],
  tiedes: [
    [JSON.stringify({ categorie: "reclamation", raison: "tiède" }), "end_turn"],
    [JSON.stringify({ probleme: "tiede", produit: "Jus de bissap", quand: "hier", demande_du_client: null, urgence: false, resume: "Jus tiède." }), "end_turn"],
    ["Désolés. Transmis à Awa, réponse sous 24 heures.", "end_turn"],
    [JSON.stringify({ critique: "rien", s_excuse: true, annonce_la_transmission_a_awa: true, promet_quelque_chose: false, donne_un_conseil_medical: false }), "end_turn"],
  ],
  "prix-ananas": [[JSON.stringify({ categorie: "information", raison: "prix" }), "end_turn"], ["1 000 FCFA la bouteille.", "end_turn"]],
};

test("le même banc d'essai que la version Python : mêmes requêtes, mêmes codes, mêmes essais", sansPython, async () => {
  const reponse = ([t, arret]: [string, string]): MessageRecu => {
    if (!t.startsWith("@outil ")) return texte(t, arret as "end_turn");
    const [, nom, ...reste] = t.split(" ");
    return message([{ type: "tool_use", id: "t1", name: nom, input: JSON.parse(reste.join(" ")) }], "tool_use");
  };
  const sansDurees = (e: Essai): unknown => ({
    ...e, latence_s: null, appels: e.appels.map((a) => ({ ...a, duree_s: null })), etapes: e.etapes.map((x) => ({ ...x, duree_ms: null })),
  });
  const ts: Record<string, unknown> = {};
  for (const [id, reponses] of Object.entries(SCENARIOS)) {
    const client = new FauxClient(...reponses.map(reponse));
    const essai = await essayer(client, suite.VARIANTES.livree!, CAS[id]!, 1, chargerBase());
    ts[id] = { requetes: client.requetes, essai: sansDurees(essai) };
  }
  const py = python(`
import json, os, sys, tempfile
from dataclasses import asdict
from types import SimpleNamespace
from anthropic.types import TextBlock, ToolUseBlock, Usage
from comptoir import config
from comptoir.connaissances import charger_base
from ch17 import banc, suite
config.MODELE, config.EFFORT, config.QUOTA_CLIENT_JOUR = "claude-sonnet-5-5", None, 1.0
config.JOURNAL = os.path.join(tempfile.mkdtemp(), "appels.jsonl")  # le vrai journal n'est pas touché
class FauxClient:
    def __init__(self, reponses):
        self.messages, self.reponses, self.requetes = self, list(reponses), []
    def create(self, **requete):
        self.requetes.append(json.loads(json.dumps(requete, default=lambda b: b.model_dump(mode="json", exclude_none=True))))
        t, arret = self.reponses.pop(0)
        if t.startswith("@outil "):
            _, nom, reste = t.split(" ", 2)
            bloc = ToolUseBlock(type="tool_use", id="t1", name=nom, input=json.loads(reste))
        else:
            bloc = TextBlock(type="text", text=t)
        return SimpleNamespace(content=[bloc], stop_reason=arret, stop_details=None, usage=Usage(input_tokens=800, output_tokens=80), _request_id="req")
    def count_tokens(self, **requete):
        return SimpleNamespace(input_tokens=500)
cas = {c["id"]: c for c in suite.charger_cas()}
sortie = {}
for i, reponses in json.load(sys.stdin).items():
    client = FauxClient(reponses)
    e = asdict(banc.essayer(client, suite.VARIANTES["livree"], cas[i], 1, charger_base()))
    e["latence_s"] = None
    e["appels"] = [{**a, "duree_s": None} for a in e["appels"]]
    e["etapes"] = [{**x, "duree_ms": None} for x in e["etapes"]]
    sortie[i] = {"requetes": client.requetes, "essai": e}
print(json.dumps(sortie, ensure_ascii=False))`, SCENARIOS) as Record<string, unknown>;
  // Les identifiants du récapitulatif et de la demande sont tirés au hasard (uuid4), des deux côtés ; les
  // codes de confirmation, eux, viennent du même générateur à graine fixe : ils doivent être les mêmes.
  const sansIdentifiants = (x: unknown): unknown =>
    JSON.parse(JSON.stringify(x).replace(/(\\?"recapitulatif\\?": \\?")[0-9a-f]{8}/g, "$1<id>").replace(/D-[0-9a-f]{6}/g, "D-<id>"));
  assert.deepEqual(sansIdentifiants(ts), sansIdentifiants(py));
  assert.match(JSON.stringify(ts), /code de confirmation|OUI \d{4}/);
});

test("la même empreinte des cas que la version Python, au registre du livre", { skip: series.length ? false : "séries absentes" }, () => {
  // La dernière ligne de chaque jeu complet : un message corrigé après la première série a changé l'empreinte,
  // et la renotation qui a suivi l'a notée au registre.
  const registre = readFileSync(join(PYTHON, "ch17", "resultats", "registre.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { jeu: string; empreinte_cas: string; resume: { cas: number } });
  const regression = (JSON.parse(readFileSync(join(PYTHON, "ch17", "regression.json"), "utf8")) as { cas: string[] }).cas;
  const jeux: [string, CasEvaluation[]][] = [
    ["amelioration", suite.chargerCas("amelioration")], ["verification", suite.chargerCas("verification")], ["regression", suite.chargerCas(null, regression)],
  ];
  for (const [jeu, cas] of jeux) {
    const ligne = registre.filter((l) => l.jeu === jeu && l.resume.cas === cas.length).at(-1)!;
    assert.equal(suite.empreinteCas(cas), ligne.empreinte_cas, jeu);
  }
});
