// Chapitre 9 : parler au Comptoir dans le terminal, et lui passer commande.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch09/comptoir_commandes.ts
// Tapez vos messages comme un client ; une ligne vide pour quitter. Pour confirmer un récapitulatif,
// répondez « OUI » suivi du code affiché.
//
// La boutique (stock, récapitulatifs, commandes) vit dans donnees_clients/boutique.sqlite3.

import { createInterface } from "node:readline/promises";
import { creerClient } from "../comptoir/appel.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import { ComptoirCommandes } from "../comptoir/commandes.ts";
import { config } from "../comptoir/config.ts";
import { ErreurComptoir } from "../comptoir/erreurs.ts";

const BOUTIQUE = "donnees_clients/boutique.sqlite3";

const comptoir = new ComptoirCommandes(creerClient(), new Boutique(BOUTIQUE), new Budget(config.BUDGET), identifiantAleatoire());
const clavier = createInterface({ input: process.stdin, output: process.stdout });
console.log("Le Comptoir d'Awa — une ligne vide pour quitter.\n");
for (let texte = (await clavier.question("Vous : ")).trim(); texte; texte = (await clavier.question("Vous : ")).trim()) {
  try {
    const reponse = await comptoir.repondre(texte);
    console.log(`Comptoir : ${reponse.texte}\n`);
    if (reponse.tour?.execution.appels.length) console.log(`  (outils appelés : ${reponse.tour.execution.appels.join(", ")})\n`);
  } catch (erreur) {
    if (!(erreur instanceof ErreurComptoir)) throw erreur;
    console.log(`Comptoir : ${erreur.diagnostic.pourLeClient}\n  (pour Yao : ${erreur.diagnostic.pourYao})\n`);
  }
}
clavier.close();
