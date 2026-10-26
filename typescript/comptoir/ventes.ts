// Les ventes d'une semaine, calculées par notre code : la référence du rapport (chapitre 10).
//
// Claude calcule le rapport dans son conteneur ; ce module refait les mêmes calculs, ici, pour vérifier
// chaque chiffre avant qu'Awa ne le lise.

import { arrondir } from "./arrondi.ts";
import { lireCsv } from "./csv.ts";
import { egaux, repr } from "./python.ts";

export interface Vente {
  date: string;
  commande: string;
  produit: string;
  quantite: number;
  prix_unitaire_fcfa: number;
  quartier: string;
  canal: string;
}

export function lire(chemin: string): Vente[] {
  return lireCsv(chemin).map((l) => ({ ...l, quantite: Number(l.quantite), prix_unitaire_fcfa: Number(l.prix_unitaire_fcfa) }) as Vente);
}

export interface Totaux {
  chiffre_affaires_fcfa: number;
  commandes: number;
  panier_moyen_fcfa: number;
  par_produit: Record<string, { quantite: number; montant_fcfa: number }>;
  par_jour: Record<string, number>;
  par_quartier: Record<string, number>;
}

/** Les clés d'un objet dans l'ordre alphabétique, comme dict(sorted(...)) en Python. */
const trie = <T>(objet: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(objet).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function totaux(lignes: Vente[]): Totaux {
  const parProduit: Totaux["par_produit"] = {};
  const parJour: Record<string, number> = {};
  const parQuartier: Record<string, number> = {};
  for (const l of lignes) {
    const montant = l.quantite * l.prix_unitaire_fcfa;
    const p = (parProduit[l.produit] ??= { quantite: 0, montant_fcfa: 0 });
    p.quantite += l.quantite;
    p.montant_fcfa += montant;
    parJour[l.date] = (parJour[l.date] ?? 0) + montant;
    parQuartier[l.quartier] = (parQuartier[l.quartier] ?? 0) + montant;
  }
  const total = Object.values(parJour).reduce((a, b) => a + b, 0);
  const commandes = new Set(lignes.map((l) => l.commande)).size;
  return {
    chiffre_affaires_fcfa: total,
    commandes,
    panier_moyen_fcfa: commandes ? arrondir(total / commandes) : 0,
    par_produit: trie(parProduit),
    par_jour: trie(parJour),
    par_quartier: trie(parQuartier),
  };
}

/** Les écarts entre le résumé produit par Claude et notre calcul. Liste vide : tout concorde. */
export function comparer(lu: Partial<Totaux> | Record<string, unknown>, attendu: Totaux): string[] {
  const resume = lu as Record<string, unknown>; // lu dans resume.json : rien n'y est garanti
  const ecarts: string[] = [];
  for (const cle of ["chiffre_affaires_fcfa", "commandes"] as const) {
    if (!egaux(resume[cle], attendu[cle])) ecarts.push(`${cle} : ${repr(resume[cle])} au lieu de ${attendu[cle]}`);
  }
  if (Math.abs(((resume.panier_moyen_fcfa as number) || 0) - attendu.panier_moyen_fcfa) > 1) { // l'arrondi peut différer
    ecarts.push(`panier_moyen_fcfa : ${repr(resume.panier_moyen_fcfa)} au lieu de ${attendu.panier_moyen_fcfa}`);
  }
  for (const cle of ["par_jour", "par_quartier"] as const) {
    const obtenu = (resume[cle] || {}) as Record<string, unknown>;
    for (const [nom, valeur] of Object.entries(attendu[cle])) {
      if (!egaux(obtenu[nom], valeur)) ecarts.push(`${cle}[${nom}] : ${repr(obtenu[nom])} au lieu de ${valeur}`);
    }
  }
  const obtenu = (resume.par_produit || {}) as Record<string, unknown>;
  for (const [produit, valeurs] of Object.entries(attendu.par_produit)) {
    if (!egaux(obtenu[produit], valeurs)) ecarts.push(`par_produit[${produit}] : ${repr(obtenu[produit])} au lieu de ${repr(valeurs)}`);
  }
  return ecarts;
}
