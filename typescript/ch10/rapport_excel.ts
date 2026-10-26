// Chapitre 10 : le même rapport, en classeur Excel, avec la Skill « xlsx » d'Anthropic.
//
// Une Skill est un dossier d'instructions et de scripts que Claude charge dans le conteneur quand il en a
// besoin. Les Skills d'Anthropic (xlsx, pptx, docx, pdf) s'ajoutent par le paramètre container, avec
// l'outil d'exécution de code.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch10/rapport_excel.ts

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { config } from "../comptoir/config.ts";
import { PYTHON, estLance } from "../comptoir/lancement.ts";
import { EXECUTION_CODE, appeler, erreursOutils, fichiersProduits } from "../comptoir/serveur.ts";

const VENTES = join(PYTHON, "ch10", "donnees", "ventes-2026-10-12.csv");
const SORTIE = join("rapports", "semaine-2026-10-12");

const CONSIGNE = `Voici l'export des ventes de la semaine du 12 au 18 octobre 2026 de Délices d'Awa (CSV).
Produis ventes-semaine.xlsx, en français, avec trois feuilles : « Ventes » (les données brutes),
« Par produit » (quantités et montants calculés par des formules Excel à partir de la feuille Ventes)
et « Par jour » (montants par date, par formules). Mets les montants au format nombre sans décimale.
Copie le fichier dans $OUTPUT_DIR et liste ce dossier dans la même commande.`;

/** Un fichier d'une archive zip, lu par son répertoire central. Assez pour un .xlsx (ni ZIP64 ni chiffrement). */
export function lireDansZip(archive: Buffer, nom: string): Buffer {
  const debut = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // fin du répertoire central
  if (debut < 0) throw new Error("Ce fichier n'est pas une archive zip.");
  const entrees = archive.readUInt16LE(debut + 10);
  let position = archive.readUInt32LE(debut + 16);
  for (let n = 0; n < entrees; n++) {
    const methode = archive.readUInt16LE(position + 10);
    const taille = archive.readUInt32LE(position + 20);
    const longueurNom = archive.readUInt16LE(position + 28);
    const suite = longueurNom + archive.readUInt16LE(position + 30) + archive.readUInt16LE(position + 32);
    const local = archive.readUInt32LE(position + 42);
    if (archive.toString("utf8", position + 46, position + 46 + longueurNom) === nom) {
      const donnees = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const brut = archive.subarray(donnees, donnees + taille);
      if (methode === 0) return brut; //        stocké tel quel
      if (methode === 8) return inflateRawSync(brut); // compressé (deflate)
      throw new Error(`Méthode de compression ${methode} non prise en charge.`);
    }
    position += 46 + suite;
  }
  throw new Error(`« ${nom} » n'est pas dans l'archive.`);
}

/** Les noms des feuilles d'un .xlsx, lus sans bibliothèque : c'est une archive zip. */
export function feuilles(classeur: string): string[] {
  const contenu = lireDansZip(readFileSync(classeur), "xl/workbook.xml").toString("utf8");
  return contenu.split('<sheet name="').slice(1).map((morceau) => morceau.split('"')[0]!);
}

async function main(): Promise<void> {
  const client = new Anthropic();
  const envoye = await client.files.upload({ file: await toFile(readFileSync(VENTES), basename(VENTES), { type: "text/csv" }) });
  const produits: string[] = [];
  try {
    const resultat = await appeler(client, {
      model: config.MODELE,
      max_tokens: 16000,
      tools: [EXECUTION_CODE],
      container: { skills: [{ type: "anthropic", skill_id: "xlsx", version: "latest" }] },
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
      const detail = nom.endsWith(".xlsx") ? ` — feuilles : ${JSON.stringify(feuilles(join(SORTIE, nom)))}` : "";
      console.log(`  fichier reçu : ${join(SORTIE, nom)}${detail}`);
    }
    const usage = resultat.message.usage;
    console.log(
      `\n${resultat.appels} appel(s) ; dernier appel : entrée ${usage.input_tokens} tokens, sortie ${usage.output_tokens} ; ` +
        `coût en tokens ${resultat.cout.toFixed(4)} $ (≈ ${(resultat.cout * config.TAUX_FCFA).toFixed(0)} FCFA)`,
    );
  } finally {
    for (const identifiant of [envoye.id, ...produits]) await client.files.delete(identifiant);
    console.log("Fichiers supprimés de la Files API.");
  }
}

if (estLance(import.meta.url)) await main();
