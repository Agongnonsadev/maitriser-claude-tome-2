// Chapitre 8 : le Comptoir en ligne de commande, avec son budget et ses diagnostics.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch08/comptoir_robuste.ts "Combien coûtent 6 bouteilles de bissap ?" --client essai-1

import { parseArgs } from "node:util";
import { appeler, creerClient } from "../comptoir/appel.ts";
import { construireRequete } from "../comptoir/assistant.ts";
import { Budget } from "../comptoir/budget.ts";
import { config } from "../comptoir/config.ts";
import { ErreurComptoir } from "../comptoir/erreurs.ts";
import { charger } from "../comptoir/prompt.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { client: { type: "string", default: "essai" } }, // l'identifiant du client, pour son quota du jour
});
const question = positionals.join(" ");
if (!question) throw new Error("Posez une question.");

const budget = new Budget(config.BUDGET);
const prompt = charger();
const requete = construireRequete(question, { prompt });
try {
  const reponse = await appeler(creerClient(), requete, budget, args.client, prompt.identifiant);
  // Un refus : un éventuel début de réponse est à jeter.
  console.log(reponse.arret?.code === "refus" ? reponse.arret.pourLeClient : reponse.texte);
  if (reponse.arret) console.log(`Pour Yao  : ${reponse.arret.pourYao}`);
  console.log(`\n[${reponse.cout}] ; dépensé aujourd'hui : ${budget.duJour().toFixed(4)} $ sur ${config.BUDGET_JOUR.toFixed(2)} $`);
  if (reponse.alerte) console.log("⚠ Seuil d'alerte franchi : le budget du jour ou du mois approche de son plafond.");
} catch (erreur) {
  if (!(erreur instanceof ErreurComptoir)) throw erreur;
  console.log(`Au client : ${erreur.diagnostic.pourLeClient}`);
  console.log(`Pour Yao  : ${erreur.diagnostic.pourYao}`);
}
