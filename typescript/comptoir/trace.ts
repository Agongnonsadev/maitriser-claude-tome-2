// Suivre chaque étape d'un traitement : modèle, durée, coût, résultat (chapitre 12).
//
// Une trace par message du client. Chaque étape (routage, extraction, réponse…) y note ce qu'elle a fait,
// et une ligne entre dans le journal, avec l'identifiant de la trace : on retrouve, après coup, pourquoi
// un message a pris tel chemin et ce qu'il a coûté.
//
// Comme le journal, la trace ne contient jamais le texte du client : seulement des catégories, des codes
// et des nombres.

import { arrondir, fixe } from "./arrondi.ts";
import { identifiantAleatoire } from "./base.ts";
import { noterEvenement } from "./journal.ts";
import { somme } from "./python.ts";

export interface Etape {
  nom: string;
  modele: string; //        « code » quand aucun modèle n'est appelé
  dureeMs: number;
  coutDollars: number;
  resultat: string; //      une catégorie, un code, un nombre : jamais le texte du client
  erreur: string | null;
}

/** Ce que l'étape en cours remplit : son coût et son résultat. */
export class Enregistreur {
  constructor(readonly etape: Etape) {}

  noter(cout = 0, resultat = ""): void {
    this.etape.coutDollars += cout;
    if (resultat) this.etape.resultat = resultat;
  }
}

export class Trace {
  readonly identifiant = identifiantAleatoire().slice(0, 12);
  readonly etapes: Etape[] = [];

  /**
   * Une étape mesurée : travail() reçoit l'enregistreur, et sa durée est prise quoi qu'il arrive. Une
   * erreur est notée par son nom, puis relancée (le with trace.etape(…) de la version Python).
   */
  async etape<T>(nom: string, modele: string, travail: (e: Enregistreur) => T | Promise<T>): Promise<T> {
    const etape: Etape = { nom, modele, dureeMs: 0, coutDollars: 0, resultat: "", erreur: null };
    const debut = performance.now();
    try {
      return await travail(new Enregistreur(etape));
    } catch (erreur) {
      etape.erreur = (erreur as object | null)?.constructor?.name ?? typeof erreur;
      throw erreur;
    } finally {
      etape.dureeMs = arrondir(performance.now() - debut);
      this.garder(etape);
    }
  }

  /** Une étape déjà mesurée ailleurs, par exemple un appel fait par le Tool Runner (chapitre 13). */
  ajouter(nom: string, modele: string, dureeMs: number, coutDollars: number, resultat = ""): void {
    this.garder({ nom, modele, dureeMs, coutDollars, resultat, erreur: null });
  }

  private garder(etape: Etape): void {
    this.etapes.push(etape);
    noterEvenement("etape", {
      trace: this.identifiant,
      etape: etape.nom,
      modele: etape.modele,
      duree_ms: etape.dureeMs,
      cout_dollars: arrondir(etape.coutDollars, 6),
      resultat: etape.resultat || null,
      erreur: etape.erreur,
    });
  }

  get cout(): number {
    return somme(this.etapes.map((e) => e.coutDollars));
  }

  get dureeMs(): number {
    return this.etapes.reduce((total, e) => total + e.dureeMs, 0);
  }

  afficher(): string {
    const lignes = [`trace ${this.identifiant} : ${this.etapes.length} étapes, ${fixe(this.dureeMs / 1000, 1)} s, ${fixe(this.cout, 4)} $`];
    for (const e of this.etapes) {
      lignes.push(
        `  ${e.nom.padEnd(13)} ${e.modele.padEnd(18)} ${fixe(e.dureeMs / 1000, 1).padStart(5)} s  ${fixe(e.coutDollars, 5)} $  ` +
          `${e.resultat}${e.erreur ? `  ERREUR ${e.erreur}` : ""}`,
      );
    }
    return lignes.join("\n");
  }
}
