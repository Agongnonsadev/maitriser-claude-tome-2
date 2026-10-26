// Chapitre 10 : le rapport hebdomadaire des ventes d'Awa, calculé et mis en page par l'exécution de code.
//
// 1. L'export CSV part dans le conteneur, par la Files API.
// 2. Claude écrit et exécute le code : totaux, graphique PNG, rapport PDF, résumé JSON.
// 3. Le script télécharge les fichiers, puis compare le résumé à notre propre calcul.
// 4. Il supprime de la Files API le fichier envoyé et les fichiers produits.
//
// L'export est celui de la version Python (python/ch10/donnees/), fabriqué une fois par
// python/ch10/fabriquer_ventes.py.
// Lancement, depuis le dossier typescript/ :  npx tsx ch10/rapport_hebdo.ts

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../comptoir/config.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { EXECUTION_CODE, appeler, erreursOutils, fichiersProduits } from "../comptoir/serveur.ts";
import { comparer, lire, totaux } from "../comptoir/ventes.ts";

const VENTES = join(PYTHON, "ch10", "donnees", "ventes-2026-10-12.csv");
const SORTIE = join("rapports", "semaine-2026-10-12");

const CONSIGNE = `Voici l'export des ventes de la semaine du 12 au 18 octobre 2026 de Délices d'Awa, un fichier CSV.
Avec du code, et seulement avec du code (aucun chiffre de tête) :
1. calcule le chiffre d'affaires total en FCFA (quantite × prix_unitaire_fcfa), le nombre de commandes distinctes,
   le panier moyen arrondi à l'unité, et le chiffre d'affaires par produit (quantité et montant), par jour et par quartier ;
2. trace le chiffre d'affaires par produit en barres horizontales, lisible sur un téléphone, dans graphique.png ;
3. produis rapport.pdf, une page en français : titre, chiffres clés, tableau par produit, le graphique ;
4. écris resume.json avec exactement ces clés : chiffre_affaires_fcfa, commandes, panier_moyen_fcfa,
   par_produit (produit -> {"quantite", "montant_fcfa"}), par_jour (date ISO -> montant), par_quartier (quartier -> montant).
Copie graphique.png, rapport.pdf et resume.json dans $OUTPUT_DIR, puis liste ce dossier dans la même commande.
Termine par trois phrases pour Awa sur la semaine.`;

const client = new Anthropic();
const envoye = await client.files.upload({ file: await toFile(readFileSync(VENTES), basename(VENTES), { type: "text/csv" }) });
const produits: string[] = [];
try {
  const resultat = await appeler(client, {
    model: config.MODELE,
    max_tokens: 16000,
    tools: [EXECUTION_CODE],
    messages: [{ role: "user", content: [{ type: "container_upload", file_id: envoye.id }, { type: "text", text: CONSIGNE }] }],
  });
  console.log(resultat.texte);
  for (const erreur of erreursOutils(resultat.message)) console.log(`  ⚠ ${erreur}`);

  mkdirSync(SORTIE, { recursive: true });
  for (const message of resultat.messages) produits.push(...fichiersProduits(message));
  for (const identifiant of produits) {
    const nom = (await client.files.retrieveMetadata(identifiant)).filename;
    const reponse = await client.files.download(identifiant);
    writeFileSync(join(SORTIE, nom), Buffer.from(await reponse.arrayBuffer()));
    console.log(`  fichier reçu : ${join(SORTIE, nom)}`);
  }

  const resume = join(SORTIE, "resume.json");
  if (existsSync(resume)) {
    const ecarts = comparer(JSON.parse(readFileSync(resume, "utf8")), totaux(lire(VENTES)));
    console.log("\nVérification par notre code : " + (ecarts.length ? "ÉCARTS" : "tous les chiffres concordent."));
    for (const ecart of ecarts) console.log(`  - ${ecart}`);
  } else {
    console.log("\nPas de resume.json : le rapport ne peut pas être vérifié, donc pas envoyé.");
  }

  const usage = resultat.message.usage;
  console.log(
    `\n${resultat.appels} appel(s), ${resultat.reprises} reprise(s) ; dernier appel : entrée ${usage.input_tokens} ` +
      `tokens, sortie ${usage.output_tokens} ; coût en tokens ${resultat.cout.toFixed(4)} $ ` +
      `(≈ ${(resultat.cout * config.TAUX_FCFA).toFixed(0)} FCFA) ; conteneur ${resultat.message.container?.id ?? "?"}`,
  );
} finally {
  // Un fichier envoyé ou produit reste stocké tant qu'on ne le supprime pas.
  for (const identifiant of [envoye.id, ...produits]) await client.files.delete(identifiant);
  console.log("Fichiers supprimés de la Files API.");
}
