// L'atelier d'Awa : ventes, stock, recettes, fournisseurs, événements et bons de commande (chapitre 13).
//
// L'agent de réapprovisionnement lit ces données par ses outils et propose un bon de commande. Tout ce
// qui se calcule se calcule ici : les ventes par semaine, les besoins en articles, le contrôle et le total
// du bon. L'agent ne fait aucune addition qui compte, et il n'envoie rien : un bon reste « à valider » tant
// qu'Awa ne l'a pas validé elle-même. Les données sont celles de la version Python
// (python/comptoir/donnees/atelier/), fabriquées une fois par python/ch13/fabriquer_donnees.py.
//
// Les nombres des fichiers JSON gardent leur écriture (2.0 reste un Flottant) : ce que lisent les outils
// est le même texte que dans la version Python.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arrondir, fixe } from "./arrondi.ts";
import { identifiantAleatoire } from "./base.ts";
import { lireCsv } from "./csv.ts";
import { ajouterJours, lireDate, lundiDe } from "./dates.ts";
import { PYTHON } from "./lancement.ts";
import { Flottant, formatG, jsonPython, lireJsonPython, nombre, repr, str } from "./python.ts";

export const DONNEES = join(PYTHON, "comptoir", "donnees", "atelier");
export const AUJOURDHUI = "2026-10-19"; // le lundi du bon de commande, dans le récit
export const PLAFOND_FCFA = 250_000; //   ce qu'Awa engage au plus sur un bon, sans en parler d'abord à sa banque
export const HORIZON_JOURS = 60; //        une livraison souhaitée au-delà ne se commande pas aujourd'hui

export const A_VALIDER = "à valider par Awa";
export const VALIDE = "validé par Awa";
export const REFUSE = "refusé par Awa";
export const REMPLACE = "remplacé";

/** Une valeur refusée (le ValueError de Python) : un produit inconnu, un bon déjà décidé. */
export class ValeurInvalide extends Error {}

export class BonInvalide extends Error {
  constructor(readonly erreurs: string[]) {
    super(erreurs.join(" ; "));
  }
}

export interface LigneDuBon {
  article: string;
  fournisseur: string;
  quantite: Flottant;
  unite: string;
  livraison_souhaitee: string;
  prix_fcfa: number;
  montant_fcfa: number;
}

/** Un bon de commande, avec les champs de la version Python (le fichier des bons s'échange). */
export interface Bon {
  code: string;
  lignes: LigneDuBon[];
  total_fcfa: number;
  justification: string;
  alertes: string[];
  statut: string;
  cree_le: string;
  decision_note: string | null;
}

export interface Offre {
  article: string;
  fournisseur: string;
  delai_jours: number;
  minimum: number | Flottant;
  conditionnement: number | Flottant;
  prix_fcfa: number;
}

/** datetime.now().isoformat(timespec="seconds") : l'heure locale, sans fuseau. */
function maintenant(): string {
  const d = new Date();
  const deux = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}T${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`;
}

// --- Les écritures ----------------------------------------------------------------------------

/** 136500 -> « 136 500 FCFA », comme f"{round(montant):,}" en remplaçant les virgules. */
export const fcfa = (montant: number): string => `${String(arrondir(montant)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} FCFA`;

/** « unité » -> « unités » au pluriel ; « kg » ne change pas. */
export const unites = (unite: string, quantite: number): string => (quantite >= 2 && (unite === "unité" || unite === "pièce") ? `${unite}s` : unite);

/** 2.0 -> « 2 », 2.5 -> « 2.5 » : des quantités lisibles, sans fausses décimales (f"{valeur:g}"). */
const enNombre = (valeur: number): string => formatG(valeur);

/** float() de Python : un nombre, ou un texte qui en écrit un ; le reste est refusé, avec le même message. */
function enFlottant(valeur: unknown): number {
  if (typeof valeur === "number" || valeur instanceof Flottant) return nombre(valeur);
  if (typeof valeur === "boolean") return valeur ? 1 : 0;
  if (typeof valeur === "string" && /^\s*[+-]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?\s*$/.test(valeur)) return Number(valeur.replaceAll("_", ""));
  if (typeof valeur === "string") throw new ValeurInvalide(`could not convert string to float: ${repr(valeur)}`);
  throw new TypeError("float() argument must be a string or a real number");
}

// --- L'atelier --------------------------------------------------------------------------------

export class Atelier {
  readonly dossier: string;
  readonly aujourdhui: string;
  readonly plafondFcfa: number;
  readonly cheminBons: string | null; // null : les bons restent en mémoire (tests, mesures)
  private readonly lesBons = new Map<string, Bon>();

  constructor({ dossier = DONNEES, aujourdhui = AUJOURDHUI, plafondFcfa = PLAFOND_FCFA, bons = null as string | null } = {}) {
    this.dossier = dossier;
    this.aujourdhui = aujourdhui;
    this.plafondFcfa = plafondFcfa;
    this.cheminBons = bons;
    if (bons && existsSync(bons)) for (const b of lireJsonPython(readFileSync(bons, "utf8")) as Bon[]) this.lesBons.set(b.code, b);
  }

  private lireJson(nom: string): Record<string, unknown> {
    return lireJsonPython(readFileSync(join(this.dossier, nom), "utf8")) as Record<string, unknown>;
  }

  // --- Lecture --------------------------------------------------------------------------------

  /** {lundi : {produit : {habituel, evenement}}}, calculé sur le fichier des ventes. */
  ventesParSemaine(): Record<string, Record<string, { habituel: number; evenement: number }>> {
    const semaines = new Map<string, Map<string, { habituel: number; evenement: number }>>();
    for (const ligne of lireCsv(join(this.dossier, "ventes.csv"))) {
      const jour = lireDate(ligne.date!);
      if (!jour) throw new ValeurInvalide(`Invalid isoformat string: ${repr(ligne.date)}`);
      const lundi = lundiDe(jour);
      const genre = ligne.canal === "evenement" ? "evenement" : "habituel";
      if (!semaines.has(lundi)) semaines.set(lundi, new Map());
      const produits = semaines.get(lundi)!;
      if (!produits.has(ligne.produit!)) produits.set(ligne.produit!, { habituel: 0, evenement: 0 });
      produits.get(ligne.produit!)![genre] += Number.parseInt(ligne.quantite!, 10);
    }
    return Object.fromEntries([...semaines].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, p]) => [s, Object.fromEntries(p)]));
  }

  produits(): string[] {
    return Object.keys(this.recettes().recettes as object);
  }

  /** Le tableau que lit l'agent : ventes habituelles par semaine, moyennes et commandes d'événement à part. */
  resumeVentes(): string {
    const semaines = this.ventesParSemaine();
    const produits = this.produits();
    const habituel = (v: Record<string, { habituel: number }>, p: string): number => v[p]?.habituel ?? 0;
    const lignes = ["Ventes habituelles par semaine (bouteilles ou flacons), commandes d'événement exclues :"];
    for (const [lundi, ventes] of Object.entries(semaines)) lignes.push(`- semaine du ${lundi} : ` + produits.map((p) => `${p} ${habituel(ventes, p)}`).join(", "));
    const toutes = Object.values(semaines);
    const dernieres = toutes.slice(-4);
    lignes.push("Moyennes par semaine (calculées par le code) :");
    for (const p of produits) {
      const sur8 = toutes.reduce((s, v) => s + habituel(v, p), 0) / toutes.length;
      const sur4 = dernieres.reduce((s, v) => s + habituel(v, p), 0) / dernieres.length;
      lignes.push(`- ${p} : ${fixe(sur8, 1)} sur 8 semaines, ${fixe(sur4, 1)} sur les 4 dernières`);
    }
    const evenements = Object.entries(semaines).flatMap(([lundi, v]) => Object.entries(v).filter(([, n]) => n.evenement).map(([p, n]) => `semaine du ${lundi}, ${p} ${n.evenement}`));
    lignes.push("Commandes d'événement passées (ponctuelles) : " + (evenements.join("; ") || "aucune"));
    return lignes.join("\n");
  }

  stock(): Record<string, unknown> {
    return this.lireJson("stock.json");
  }

  recettes(): Record<string, unknown> {
    return this.lireJson("recettes.json");
  }

  offres(): Offre[] {
    return this.lireJson("fournisseurs.json").offres as Offre[];
  }

  evenements(): unknown[] {
    return this.lireJson("evenements.json").evenements as unknown[];
  }

  messagesFournisseurs(): string {
    return readFileSync(join(this.dossier, "messages-fournisseurs.md"), "utf8").replace(/\r\n?/g, "\n");
  }

  unite(article: string): string {
    return ((this.recettes().unites as Record<string, string>)[article]) ?? "unité";
  }

  // --- Calculs --------------------------------------------------------------------------------

  /**
   * Ce que demande une production (bouteilles ou flacons par produit), moins le stock d'articles, et, pour
   * chaque offre, la quantité à commander qui respecte le minimum et le conditionnement.
   */
  besoins(production: Record<string, number>): Record<string, unknown>[] {
    const recettes = this.recettes().recettes as Record<string, Record<string, number | Flottant>>;
    const inconnus = Object.keys(production).filter((p) => !(p in recettes));
    if (inconnus.length) throw new ValeurInvalide(`produits inconnus : ${inconnus.join(", ")} ; produits connus : ${this.produits().join(", ")}`);
    const brut = new Map<string, number>(); // des float en Python : 0.0 + 90 vaut 90.0
    for (const [produit, nombreProduit] of Object.entries(production)) {
      for (const [article, parUnite] of Object.entries(recettes[produit]!)) brut.set(article, (brut.get(article) ?? 0) + nombre(parUnite) * nombreProduit);
    }
    const enStock = this.stock().articles as Record<string, number | Flottant>;
    const offres = this.offres();
    return [...brut].map(([article, besoin]) => {
      const stock = enStock[article] ?? 0;
      const net = Math.max(0, besoin - nombre(stock));
      const suggestions = offres
        .filter((o) => o.article === article)
        .map((o) => {
          let quantite: number | Flottant = 0;
          if (net !== 0) {
            // max(minimum, ceil(...) × conditionnement) : le second, s'il est plus grand ; un float si le
            // conditionnement en est un.
            const produit = Math.ceil(net / nombre(o.conditionnement) - 1e-9) * nombre(o.conditionnement);
            quantite = produit > nombre(o.minimum) ? (o.conditionnement instanceof Flottant ? new Flottant(produit) : produit) : o.minimum;
          }
          return { fournisseur: o.fournisseur, quantite, montant_fcfa: arrondir(nombre(quantite) * o.prix_fcfa) };
        });
      return {
        article,
        unite: this.unite(article),
        besoin: new Flottant(arrondir(besoin, 3)),
        stock,
        besoin_net: new Flottant(arrondir(net, 3)),
        a_commander_selon_fiches: suggestions,
      };
    });
  }

  /** Les erreurs d'un projet de bon ; une liste vide s'il respecte les fiches et le plafond. */
  verifier(lignes: Record<string, unknown>[]): string[] {
    if (!lignes.length) return ["le bon ne contient aucune ligne"];
    const erreurs: string[] = [];
    const vues = new Set<string>();
    const offres = this.offres();
    let total = 0;
    lignes.forEach((ligne, rang) => {
      const i = rang + 1;
      const { article, fournisseur } = ligne;
      const offre = offres.find((o) => o.article === article && o.fournisseur === fournisseur);
      if (!offre) {
        const vendeurs = offres.filter((o) => o.article === article).map((o) => o.fournisseur);
        erreurs.push(
          `ligne ${i} : ${repr(fournisseur)} ne vend pas ${repr(article)}` +
            (vendeurs.length ? ` (fournisseurs de cet article : ${vendeurs.join(", ")})` : " (article inconnu)"),
        );
        return;
      }
      const quantite = enFlottant(ligne.quantite || 0);
      const conditionnement = nombre(offre.conditionnement);
      if (quantite < nombre(offre.minimum)) {
        erreurs.push(`ligne ${i} : ${enNombre(quantite)} ${str(article)}, en dessous du minimum de ${str(offre.minimum)} chez ${str(fournisseur)}`);
      } else if (Math.abs(quantite / conditionnement - arrondir(quantite / conditionnement)) > 1e-9) {
        erreurs.push(`ligne ${i} : ${str(fournisseur)} vend ${str(article)} par ${str(offre.conditionnement)} ${unites(this.unite(String(article)), conditionnement)}`);
      }
      const livraison = lireDate(str(ligne.livraison_souhaitee ?? null));
      if (livraison === null) {
        erreurs.push(`ligne ${i} : date de livraison illisible (${repr(ligne.livraison_souhaitee)}), format attendu AAAA-MM-JJ`);
      } else {
        const auPlusTot = ajouterJours(this.aujourdhui, offre.delai_jours);
        if (livraison < auPlusTot) {
          erreurs.push(`ligne ${i} : livraison le ${livraison} impossible, le délai de ${str(fournisseur)} est de ${offre.delai_jours} jours (au plus tôt le ${auPlusTot})`);
        } else if (livraison > ajouterJours(this.aujourdhui, HORIZON_JOURS)) {
          erreurs.push(`ligne ${i} : livraison le ${livraison}, trop loin pour la commander aujourd'hui`);
        }
        const cle = JSON.stringify([article, fournisseur, livraison]);
        if (vues.has(cle)) erreurs.push(`ligne ${i} : doublon (${str(article)}, ${str(fournisseur)}, ${livraison})`);
        vues.add(cle);
      }
      total += quantite * offre.prix_fcfa;
    });
    if (total > this.plafondFcfa) erreurs.push(`total de ${fcfa(total)}, au-dessus du plafond de ${fcfa(this.plafondFcfa)} fixé par Awa`);
    return erreurs;
  }

  // --- Le bon de commande ---------------------------------------------------------------------

  /**
   * Enregistre un projet de bon, à valider par Awa. Lève BonInvalide si les fiches ne sont pas respectées.
   * Rien n'est envoyé à un fournisseur : c'est Awa qui envoie un bon validé.
   */
  proposer(lignes: Record<string, unknown>[], justification: string, alertes: string[] | null = null): Bon {
    const erreurs = this.verifier(lignes);
    if (erreurs.length) throw new BonInvalide(erreurs);
    const offres = this.offres();
    const detail: LigneDuBon[] = lignes.map((ligne) => {
      const offre = offres.find((o) => o.article === ligne.article && o.fournisseur === ligne.fournisseur)!;
      const quantite = enFlottant(ligne.quantite);
      return {
        article: String(ligne.article),
        fournisseur: String(ligne.fournisseur),
        quantite: new Flottant(quantite),
        unite: this.unite(String(ligne.article)),
        livraison_souhaitee: str(ligne.livraison_souhaitee),
        prix_fcfa: offre.prix_fcfa,
        montant_fcfa: arrondir(quantite * offre.prix_fcfa),
      };
    });
    const bon: Bon = {
      code: `BC-${identifiantAleatoire().slice(0, 6)}`,
      lignes: detail,
      total_fcfa: detail.reduce((s, l) => s + l.montant_fcfa, 0),
      justification,
      alertes: [...(alertes ?? [])],
      statut: A_VALIDER,
      cree_le: maintenant(),
      decision_note: null,
    };
    this.lesBons.set(bon.code, bon);
    this.enregistrer();
    return bon;
  }

  /** Un projet de bon que l'agent remplace par un autre, dans la même séance : il n'est plus à valider. */
  retirer(code: string, remplacePar: string): void {
    const bon = this.bonDe(code);
    if (bon.statut === A_VALIDER) {
      bon.statut = `${REMPLACE} par ${remplacePar}`;
      this.enregistrer();
    }
  }

  /** La décision d'Awa, hors de l'agent : la seule façon de faire sortir un bon de « à valider ». */
  decider(code: string, valide: boolean, note: string | null = null): Bon {
    const bon = this.bonDe(code);
    if (bon.statut !== A_VALIDER) throw new ValeurInvalide(`le bon ${code} est déjà ${bon.statut}`);
    bon.statut = valide ? VALIDE : REFUSE;
    bon.decision_note = note;
    this.enregistrer();
    return bon;
  }

  bons(): Bon[] {
    return [...this.lesBons.values()];
  }

  private bonDe(code: string): Bon {
    const bon = this.lesBons.get(code);
    if (!bon) throw new Error(repr(code)); // un KeyError en Python
    return bon;
  }

  private enregistrer(): void {
    if (!this.cheminBons) return;
    mkdirSync(dirname(this.cheminBons), { recursive: true });
    writeFileSync(this.cheminBons, jsonPython(this.bons(), 2), "utf8"); // json.dumps(…, indent=2)
  }
}

export function rendreBon(bon: Bon): string {
  const lignes = [`Bon ${bon.code} — ${bon.statut} — total ${fcfa(bon.total_fcfa)}`];
  for (const l of bon.lignes) {
    const q = nombre(l.quantite);
    lignes.push(`- ${enNombre(q)} ${unites(l.unite, q)} de ${l.article} chez ${l.fournisseur}, livraison le ${l.livraison_souhaitee} : ${fcfa(l.montant_fcfa)}`);
  }
  if (bon.alertes.length) lignes.push("Alertes : " + bon.alertes.join(" | "));
  return lignes.join("\n");
}

// Les dates restent aussi exportées d'ici, où les scripts du chapitre 13 les prennent.
export { ajouterJours, lireDate, lundiDe } from "./dates.ts";
