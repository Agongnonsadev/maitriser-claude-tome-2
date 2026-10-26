// La boutique d'Awa vue par le code : stock, récapitulatifs, commandes, demandes (chapitre 9).
//
// C'est ici, et non dans le modèle, que vivent les règles qui engagent de l'argent : les prix, les frais
// de livraison, le stock, et surtout la création d'une commande. Claude prépare un récapitulatif ; seul
// le client, par un code de confirmation que le code vérifie, le transforme en commande. Et une commande
// ne se crée qu'une fois.

import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { identifiantAleatoire, isoformat, ouvrirBase, transaction } from "./base.ts";
import { problemeDeNom, problemeDeQuartier } from "./garde.ts";
import { PYTHON } from "./lancement.ts";
import { type Donnees, chargerDonnees } from "./prompt.ts";

export const FRAIS_LIVRAISON = 500; //            FCFA, sous le seuil (conditions d'Awa)
export const SEUIL_LIVRAISON_GRATUITE = 5; //     bouteilles
export const MAXIMUM_SANS_DEVIS = 50; //          bouteilles : au-delà, Awa fait un devis
export const VALIDITE_RECAPITULATIF_MS = 2 * 3600 * 1000;
const HEURE_DE_COTONOU = 1; // le Bénin est à UTC+1, sans heure d'été
const JOUR_MS = 24 * 3600 * 1000;

/** Une demande que la boutique refuse, avec un message qui dit quoi faire. */
export class RefusBoutique extends Error {}

/** « Larissa Noudéhou » -> « Larissa N. » : assez pour une commande passée, sans le nom complet. */
export function initiale(nom: string): string {
  const morceaux = nom.split(/\s+/).filter(Boolean);
  return morceaux.length < 2 ? nom : `${morceaux[0]} ${morceaux.at(-1)![0]}.`;
}

export interface LigneDemandee {
  produit: string;
  quantite: number;
}

interface Ligne {
  produit: string;
  quantite: number;
  prix_unitaire: number;
}

export interface Recapitulatif {
  recapitulatif: string;
  lignes: (Ligne & { montant: number })[];
  frais_livraison: number;
  total_fcfa: number;
  livraison_prevue: string;
  nom_client: string;
  quartier: string;
  code_de_confirmation: string;
  a_dire_au_client: string;
}

export interface Options {
  donnees?: Donnees;
  stock?: Record<string, number>;
  horloge?: () => Date;
  /** Un entier tiré au hasard entre 0 et n − 1 : celui du système, sauf dans les tests. */
  hasard?: (n: number) => number;
}

export class Boutique {
  readonly db: DatabaseSync;
  readonly catalogue: Map<string, Donnees["produits"][number]>;
  private readonly horloge: () => Date;
  private readonly hasard: (n: number) => number;

  constructor(chemin = ":memory:", { donnees, stock, horloge, hasard }: Options = {}) {
    this.db = ouvrirBase(chemin);
    this.horloge = horloge ?? (() => new Date());
    this.hasard = hasard ?? ((n) => randomInt(n));
    this.catalogue = new Map((donnees ?? chargerDonnees()).produits.map((p) => [p.nom, p]));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stock (produit TEXT PRIMARY KEY, quantite INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recapitulatifs (
          id TEXT PRIMARY KEY, conversation TEXT NOT NULL, code TEXT NOT NULL, lignes TEXT NOT NULL,
          nom_client TEXT NOT NULL, quartier TEXT NOT NULL, frais_livraison INTEGER NOT NULL,
          total INTEGER NOT NULL, statut TEXT NOT NULL, cree_le TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commandes (
          id TEXT PRIMARY KEY, recapitulatif TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
          total INTEGER NOT NULL, cree_le TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS demandes (
          id TEXT PRIMARY KEY, conversation TEXT NOT NULL, motif TEXT NOT NULL, resume TEXT NOT NULL,
          cree_le TEXT NOT NULL);
    `);
    let initial = stock;
    if (initial === undefined && !this.db.prepare("SELECT 1 FROM stock").get()) {
      initial = JSON.parse(readFileSync(join(PYTHON, "comptoir", "donnees", "stock_initial.json"), "utf8")).stock;
    }
    if (initial !== undefined) {
      const inserer = this.db.prepare("INSERT OR REPLACE INTO stock VALUES (?, ?)");
      transaction(this.db, () => Object.entries(initial!).forEach(([produit, quantite]) => inserer.run(produit, quantite)));
    }
  }

  private maintenant(): Date {
    return this.horloge();
  }

  // --- Lire -------------------------------------------------------------------------------

  /** La quantité en stock, ou null si le produit n'est pas au catalogue. */
  disponible(produit: string): number | null {
    if (!this.catalogue.has(produit)) return null;
    const ligne = this.db.prepare("SELECT quantite FROM stock WHERE produit = ?").get(produit);
    return ligne ? Number(ligne.quantite) : 0;
  }

  private estUneBouteille(produit: string): boolean {
    return this.catalogue.get(produit)!.format.includes("bouteille");
  }

  /** Le jour même pour une commande passée avant 12 h (heure de Cotonou), sinon le lendemain. */
  livraisonPrevue(instant: Date): string {
    return (instant.getUTCHours() + HEURE_DE_COTONOU) % 24 < 12 ? "aujourd'hui" : "demain";
  }

  // --- Préparer un récapitulatif (ce que Claude peut faire) --------------------------------

  preparer(conversation: string, lignes: LigneDemandee[], nomClient: string, quartier: string): Recapitulatif {
    if (!lignes.length) throw new RefusBoutique("La commande est vide : demande au client ce qu'il souhaite.");
    // Chapitre 18 : le nom et le quartier finissent dans l'application Claude d'Awa. Une donnée courte,
    // rien d'autre : le reste du message du client n'a rien à faire dans la boutique.
    for (const probleme of [problemeDeNom(nomClient), problemeDeQuartier(quartier)]) {
      if (probleme) {
        throw new RefusBoutique(
          `Récapitulatif refusé : ${probleme}. Indique seulement le nom donné pour la livraison et le nom ` +
            "du quartier, sans adresse, sans commentaire ni consigne ; demande-les au client s'il le faut.",
        );
      }
    }
    const nom = nomClient.trim();
    const lieu = quartier.trim();
    const retenues: Ligne[] = [];
    for (const { produit, quantite } of lignes) {
      const fiche = this.catalogue.get(produit);
      if (!fiche) {
        throw new RefusBoutique(
          `Produit « ${produit} » absent du catalogue. Produits disponibles : ${[...this.catalogue.keys()].join(", ")}. ` +
            "Propose au client de choisir parmi eux.",
        );
      }
      if (quantite < 1) throw new RefusBoutique(`Quantité ${quantite} invalide pour ${produit} : il en faut au moins 1.`);
      const stock = this.disponible(produit)!;
      if (quantite > stock) {
        throw new RefusBoutique(
          `Stock insuffisant : ${stock} disponible(s) pour ${produit}, ${quantite} demandé(s). ` +
            "Propose une quantité possible ou un autre produit ; ne prépare rien sans l'accord du client.",
        );
      }
      retenues.push({ produit, quantite, prix_unitaire: fiche.prix_fcfa });
    }

    const bouteilles = retenues.filter((l) => this.estUneBouteille(l.produit)).reduce((s, l) => s + l.quantite, 0);
    if (bouteilles > MAXIMUM_SANS_DEVIS) {
      throw new RefusBoutique(
        `${bouteilles} bouteilles : au-delà de ${MAXIMUM_SANS_DEVIS}, le tarif est sur devis. Utilise transmettre_a_awa avec le motif devis.`,
      );
    }
    const frais = bouteilles >= SEUIL_LIVRAISON_GRATUITE ? 0 : FRAIS_LIVRAISON;
    const total = retenues.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0) + frais;
    const maintenant = this.maintenant();
    const code = String(this.hasard(10_000)).padStart(4, "0");
    const identifiant = identifiantAleatoire();
    transaction(this.db, () => {
      // Un nouveau récapitulatif annule le précédent de la même conversation : le client a changé d'avis,
      // et l'ancien code ne doit plus rien créer.
      this.db.prepare("UPDATE recapitulatifs SET statut = 'remplace' WHERE conversation = ? AND statut = 'en_attente'").run(conversation);
      this.db
        .prepare("INSERT INTO recapitulatifs VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en_attente', ?)")
        .run(identifiant, conversation, code, JSON.stringify(retenues), nom, lieu, frais, total, isoformat(maintenant));
    });
    return {
      recapitulatif: identifiant.slice(0, 8),
      lignes: retenues.map((l) => ({ ...l, montant: l.quantite * l.prix_unitaire })),
      frais_livraison: frais,
      total_fcfa: total,
      livraison_prevue: this.livraisonPrevue(maintenant),
      nom_client: nom,
      quartier: lieu,
      code_de_confirmation: code,
      a_dire_au_client: `Pour confirmer, le client répond exactement : OUI ${code}`,
    };
  }

  // --- Confirmer (ce que seul le client peut faire, par son code) ---------------------------

  /** Crée la commande, une seule fois. Rappeler avec le même code rend la même commande. */
  confirmer(conversation: string, code: string): { commande: string; total_fcfa: number; deja_enregistree: boolean } {
    return transaction(this.db, () => {
      const recap = this.db
        .prepare("SELECT id, lignes, total, statut, cree_le FROM recapitulatifs WHERE conversation = ? AND code = ? ORDER BY cree_le DESC LIMIT 1")
        .get(conversation, code);
      if (!recap) throw new RefusBoutique("Ce code ne correspond à aucun récapitulatif de cette conversation.");
      const total = Number(recap.total);
      if (recap.statut === "confirme") {
        const commande = this.db.prepare("SELECT id FROM commandes WHERE recapitulatif = ?").get(recap.id as string);
        return { commande: String(commande!.id), total_fcfa: total, deja_enregistree: true };
      }
      if (recap.statut === "remplace") throw new RefusBoutique("Ce récapitulatif a été remplacé par un plus récent : utilisez le dernier code reçu.");
      if (this.maintenant().getTime() - new Date(String(recap.cree_le)).getTime() > VALIDITE_RECAPITULATIF_MS) {
        throw new RefusBoutique("Ce récapitulatif a expiré : demandez-en un nouveau.");
      }
      const lignes = JSON.parse(String(recap.lignes)) as Ligne[];
      // Le stock a pu changer depuis le récapitulatif : on le revérifie au moment de créer.
      for (const l of lignes) {
        if (l.quantite > (this.disponible(l.produit) ?? 0)) throw new RefusBoutique(`Le stock de ${l.produit} a changé : demandez un nouveau récapitulatif.`);
      }
      const retirer = this.db.prepare("UPDATE stock SET quantite = quantite - ? WHERE produit = ?");
      for (const l of lignes) retirer.run(l.quantite, l.produit);
      const rang = Number(this.db.prepare("SELECT COUNT(*) + 1 AS rang FROM commandes").get()!.rang);
      const numero = `C-${String(rang).padStart(4, "0")}`;
      // La contrainte UNIQUE sur le récapitulatif interdit, en dernier recours, toute double commande.
      this.db.prepare("INSERT INTO commandes VALUES (?, ?, ?, ?, ?)").run(numero, recap.id as string, conversation, total, isoformat(this.maintenant()));
      this.db.prepare("UPDATE recapitulatifs SET statut = 'confirme' WHERE id = ?").run(recap.id as string);
      return { commande: numero, total_fcfa: total, deja_enregistree: false };
    });
  }

  // --- Transmettre à Awa -----------------------------------------------------------------

  transmettre(conversation: string, motif: string, resume: string): { demande: string; transmise: true } {
    const identifiant = `D-${identifiantAleatoire().slice(0, 6)}`;
    this.db.prepare("INSERT INTO demandes VALUES (?, ?, ?, ?, ?)").run(identifiant, conversation, motif, resume, isoformat(this.maintenant()));
    return { demande: identifiant, transmise: true };
  }

  // --- Ne garder que le nécessaire (chapitre 18) -----------------------------------------

  /** Applique les durées de conservation d'Awa. Renvoie ce qui a été effacé ou réduit. */
  purger(demandesJ: number, nomsJ: number, recapitulatifsJ: number, maintenant = this.maintenant()) {
    const avant = (jours: number) => isoformat(new Date(maintenant.getTime() - jours * JOUR_MS));
    return transaction(this.db, () => {
      const demandes = Number(this.db.prepare("DELETE FROM demandes WHERE cree_le < ?").run(avant(demandesJ)).changes);
      const recaps = Number(this.db.prepare("DELETE FROM recapitulatifs WHERE statut != 'confirme' AND cree_le < ?").run(avant(recapitulatifsJ)).changes);
      let noms = 0;
      const anciens = this.db.prepare("SELECT id, nom_client FROM recapitulatifs WHERE statut = 'confirme' AND cree_le < ?").all(avant(nomsJ));
      for (const { id, nom_client } of anciens) {
        const nom = String(nom_client);
        if (initiale(nom) !== nom) {
          this.db.prepare("UPDATE recapitulatifs SET nom_client = ? WHERE id = ?").run(initiale(nom), id as string);
          noms++;
        }
      }
      return { demandes_effacees: demandes, recapitulatifs_effaces: recaps, noms_reduits: noms };
    });
  }

  /**
   * À la demande d'un client : tout ce qui vient de sa conversation, sauf ce que la comptabilité exige. Ses
   * commandes restent (produits, total, date, quartier), sous son seul prénom et son initiale.
   */
  effacer(conversation: string): { demandes_effacees: number; recapitulatifs_effaces: number } {
    return transaction(this.db, () => {
      const demandes = Number(this.db.prepare("DELETE FROM demandes WHERE conversation = ?").run(conversation).changes);
      const recaps = Number(this.db.prepare("DELETE FROM recapitulatifs WHERE conversation = ? AND statut != 'confirme'").run(conversation).changes);
      for (const { id, nom_client } of this.db.prepare("SELECT id, nom_client FROM recapitulatifs WHERE conversation = ?").all(conversation)) {
        this.db.prepare("UPDATE recapitulatifs SET nom_client = ? WHERE id = ?").run(initiale(String(nom_client)), id as string);
      }
      return { demandes_effacees: demandes, recapitulatifs_effaces: recaps };
    });
  }

  // --- Pour les tests et le tableau de bord -----------------------------------------------

  commandes(): { id: string; recapitulatif: string; conversation: string; total: number }[] {
    return this.db.prepare("SELECT id, recapitulatif, conversation, total FROM commandes").all() as never;
  }

  demandes(): { id: string; conversation: string; motif: string; resume: string }[] {
    return this.db.prepare("SELECT id, conversation, motif, resume FROM demandes").all() as never;
  }

  recapitulatifs(conversation: string): { code: string; statut: string; total: number; lignes: string }[] {
    return this.db.prepare("SELECT code, statut, total, lignes FROM recapitulatifs WHERE conversation = ? ORDER BY cree_le").all(conversation) as never;
  }
}
