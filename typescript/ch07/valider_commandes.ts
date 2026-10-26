// Chapitre 7 : Yao valide les commandes extraites des photos, une par une, avant tout enregistrement.
//
// Rien n'est enregistré sans un « o » tapé par un humain, même quand aucune anomalie n'est signalée :
// une commande engage un montant, une livraison et la parole d'Awa.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch07/valider_commandes.ts ../python/ch07/documents/bon-01.jpg ../python/ch07/documents/bon-02.jpg

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ClientMessages } from "../comptoir/client.ts";
import { blocImage } from "../comptoir/documents.ts";
import { BonDeCommande, controlerBon, extraire } from "../comptoir/extraction.ts";
import { estLance } from "../comptoir/lancement.ts";

export const REGISTRE = "donnees_clients/commandes.jsonl"; // données de clients : hors de Git

export function resume(bon: BonDeCommande): string {
  const lignes = [`${bon.client ?? "?"} — ${bon.quartier ?? "?"} — livraison : ${bon.date_livraison_lue ?? "?"}`];
  for (const ligne of bon.lignes) lignes.push(`  ${ligne.quantite ?? "?"} × ${ligne.produit ?? ligne.libelle_lu}`);
  return lignes.join("\n");
}

export async function valider(
  client: ClientMessages,
  chemin: string,
  demander: (question: string) => Promise<string> | string,
  registre = REGISTRE,
): Promise<Record<string, unknown> | null> {
  const resultat = await extraire(client, [await blocImage(chemin)], BonDeCommande);
  console.log(`\n=== ${basename(chemin)}  (${resultat.cout})`);
  if (resultat.erreur || !resultat.donnees) {
    console.log(`Échec de l'extraction : ${resultat.erreur} — à saisir à la main.`);
    return null;
  }
  const controle = controlerBon(resultat.donnees);
  console.log(resume(resultat.donnees));
  console.log(`Montant calculé par le code : ${controle.montantCalcule ?? "?"} FCFA`);
  for (const anomalie of controle.anomalies) console.log(`  ⚠ ${anomalie}`);
  if (controle.montantCalcule === null) {
    console.log("Montant incalculable : corrigez le bon avec le client avant d'enregistrer.");
    return null;
  }
  if ((await demander("Enregistrer cette commande ? [o/N] ")).trim().toLowerCase() !== "o") {
    console.log("Non enregistrée.");
    return null;
  }
  const commande = {
    date: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    document: basename(chemin),
    requete: resultat.identifiant,
    commande: resultat.donnees,
    montant_fcfa: controle.montantCalcule,
    anomalies_acceptees: controle.anomalies,
    validee_par_un_humain: true,
  };
  mkdirSync(dirname(registre), { recursive: true });
  appendFileSync(registre, JSON.stringify(commande) + "\n", "utf8");
  console.log("Enregistrée.");
  return commande;
}

if (estLance(import.meta.url)) {
  const client = new Anthropic();
  const clavier = createInterface({ input: process.stdin, output: process.stdout });
  for (const nom of process.argv.slice(2)) await valider(client, nom, (q) => clavier.question(q));
  clavier.close();
}
