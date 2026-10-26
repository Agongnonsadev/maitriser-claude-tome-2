// Chapitre 11 : le Comptoir du chapitre 9, avec les documents d'Awa, sans cache puis avec.
//
// La même conversation, plusieurs fois, avec une boutique neuve à chaque fois : une question sur les
// documents, une question de stock, une commande, la confirmation. On compte les appels, les tokens lus
// et écrits dans le cache, et le coût de chaque message.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch11/comptoir_avec_base.ts                    (sans cache, puis cache de 5 minutes)
//     npx tsx ch11/comptoir_avec_base.ts --variantes 1h     (début commun gardé une heure)

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { creerClient } from "../comptoir/appel.ts";
import { identifiantAleatoire } from "../comptoir/base.ts";
import { Boutique } from "../comptoir/boutique.ts";
import { Budget } from "../comptoir/budget.ts";
import { ComptoirCommandes } from "../comptoir/commandes.ts";
import { config } from "../comptoir/config.ts";
import { type Cache, chargerBase } from "../comptoir/connaissances.ts";
import { plusieursValeurs } from "../comptoir/lancement.ts";

const MESSAGES = [
  "Bonjour, combien de temps se garde un jus une fois ouvert ?",
  "Il vous reste du jus d'ananas et du jus de corossol ?",
  "Alors 6 bouteilles d'ananas, livrées à Akpakpa, au nom de Mme Hounkpè.",
  "OUI {code}",
];
const VARIANTES: Record<string, [Cache, string]> = {
  sans: [false, "sans cache"],
  "5m": [true, "cache de 5 minutes"],
  "1h": ["1h", "début commun gardé une heure"],
};

function lignesDuJournal(depuis: number): Record<string, unknown>[] {
  try {
    return readFileSync(config.JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(depuis);
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw erreur;
  }
}

async function jouer(cache: Cache, nom: string): Promise<number> {
  const comptoir = new ComptoirCommandes(creerClient(), new Boutique(":memory:"), new Budget(":memory:"), identifiantAleatoire(), {
    versionPrompt: "v3",
    connaissances: chargerBase(),
    cache,
  });
  console.log(`\n=== ${nom} ===`);
  let code: string | null = null;
  let total = 0;
  for (const modeleMessage of MESSAGES) {
    const texte = modeleMessage.replace("{code}", code ?? "None"); // comme format(code=None) en Python
    const avant = lignesDuJournal(0).length;
    const reponse = await comptoir.repondre(texte);
    const appels = lignesDuJournal(avant).filter((l) => "requete" in l);
    const cout = appels.reduce((s, l) => s + (l.cout_dollars as number), 0);
    total += cout;
    console.log(`\nClient   : ${texte}\nComptoir : ${reponse.texte}`);
    if (reponse.tour?.execution.appels.length) console.log(`  outils : ${reponse.tour.execution.appels.join(", ")}`);
    for (const l of appels) {
      console.log(
        `  appel : entrée ${String(l.tokens_entree).padStart(6)}  écrit ${String(l.tokens_ecriture_cache).padStart(6)}  ` +
          `lu ${String(l.tokens_lecture_cache).padStart(6)}  sortie ${String(l.tokens_sortie).padStart(5)}  ${(l.cout_dollars as number).toFixed(5)} $`,
      );
    }
    code = /OUI (\d{4})/.exec(reponse.texte)?.[1] ?? code;
  }
  console.log(`\nTotal, ${nom} : ${total.toFixed(4)} $`);
  return total;
}

const { values: args } = parseArgs({
  args: plusieursValeurs(["variantes"]),
  options: { variantes: { type: "string", multiple: true, default: ["sans", "5m"] } },
});
const inconnues = args.variantes.filter((v) => !(v in VARIANTES));
if (inconnues.length) throw new Error(`--variantes : ${inconnues.join(", ")} ? Choix : ${Object.keys(VARIANTES).join(", ")}.`);
// Sans cache, chaque appel lit toute la base au prix plein : le quota du chapitre 8 (0,15 $ par client
// et par jour) arrêterait la conversation en route. On le relève pour cette mesure.
console.log(`Quota par client relevé de ${config.QUOTA_CLIENT_JOUR} $ à 1 $ pour la mesure.`);
config.QUOTA_CLIENT_JOUR = 1.0;
const totaux = new Map<string, number>();
for (const variante of args.variantes) {
  const [cache, nom] = VARIANTES[variante]!;
  totaux.set(nom, await jouer(cache, nom));
}
console.log("\n" + [...totaux].map(([nom, t]) => `${nom} : ${t.toFixed(4)} $`).join(" ; "));
