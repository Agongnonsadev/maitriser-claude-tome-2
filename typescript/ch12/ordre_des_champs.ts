// Chapitre 12 : l'évaluateur coche-t-il avant ou après avoir écrit sa critique ? 40 appels.
//
// Deux réponses à une réclamation : l'une conforme, l'autre qui promet une livraison. Chacune est relue dix
// fois par Claude Haiku 5.5 avec le schéma d'évaluation, les cases d'abord puis la critique d'abord. Une
// sortie structurée suit l'ordre des propriétés requises du schéma : la case « promet_quelque_chose » est
// donc remplie avant, ou après, l'avis. Coût : moins d'un centime.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch12/ordre_des_champs.ts

import Anthropic from "@anthropic-ai/sdk";
import { texteDe } from "../comptoir/client.ts";
import { cout } from "../comptoir/couts.ts";
import { noter } from "../comptoir/journal.ts";
import { estLance } from "../comptoir/lancement.ts";
import { MODELE_AUXILIAIRE as MODELE, SCHEMA_EVALUATION, SYSTEME_EVALUATION } from "../comptoir/reclamations.ts";

const CONFORME =
  "Nous sommes sincèrement désolés pour cette bouteille manquante dans votre livraison. Votre réclamation " +
  "est transmise à Awa, qui vous répondra sous 24 heures, conformément à nos conditions de vente. " +
  "Pourriez-vous nous préciser quel produit était concerné ?";
const PROMESSE =
  "Nous sommes sincèrement désolés pour cette bouteille manquante. Votre réclamation est transmise à Awa, " +
  "qui vous répondra sous 24 heures, et la bouteille vous sera livrée dès demain.";

type Schema = typeof SCHEMA_EVALUATION;

/** Le schéma du Comptoir (critique d'abord), ou sa première version (cases d'abord). */
export function schema(critiqueDAbord: boolean): Schema {
  const s = structuredClone(SCHEMA_EVALUATION);
  if (!critiqueDAbord) {
    const { critique, ...cases } = s.properties;
    s.properties = { ...cases, critique } as Schema["properties"];
    s.required = [...s.required.filter((k) => k !== "critique"), "critique"];
  }
  return s;
}

async function relire(client: Anthropic, texte: string, critiqueDAbord: boolean): Promise<[Record<string, unknown>, number]> {
  const reponse = await client.messages.create({
    model: MODELE,
    max_tokens: 600,
    system: SYSTEME_EVALUATION,
    messages: [{ role: "user", content: `<reponse>${texte}</reponse>` }],
    output_config: { format: { type: "json_schema", schema: schema(critiqueDAbord) } },
  });
  const prix = cout(MODELE, reponse.usage);
  noter(reponse._request_id, MODELE, prix, { prompt: "ch12-ordre-des-champs", stop_reason: reponse.stop_reason });
  return [JSON.parse(texteDe(reponse)) as Record<string, unknown>, prix.dollars];
}

/** nombre fois la même tâche, au plus maximum à la fois, comme un ThreadPoolExecutor(max_workers=maximum). */
async function enParallele<T>(nombre: number, maximum: number, tache: () => Promise<T>): Promise<T[]> {
  const resultats: T[] = new Array(nombre);
  let suivant = 0;
  const ouvrier = async (): Promise<void> => {
    while (suivant < nombre) {
      const i = suivant++;
      resultats[i] = await tache();
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, nombre) }, ouvrier));
  return resultats;
}

async function main(): Promise<void> {
  const client = new Anthropic();
  let total = 0;
  for (const [nom, texte] of [["réponse conforme", CONFORME], ["réponse qui promet", PROMESSE]] as const) {
    for (const critiqueDAbord of [false, true]) {
      const resultats = await enParallele(10, 5, () => relire(client, texte, critiqueDAbord));
      total += resultats.reduce((s, [, prix]) => s + prix, 0);
      const promet = resultats.filter(([j]) => j.promet_quelque_chose).length;
      const ordre = critiqueDAbord ? "critique d'abord" : "cases d'abord";
      const [premier] = resultats[0]!;
      console.log(`${nom.padEnd(20)} ${ordre.padEnd(17)} : « promet » coché ${promet} fois sur 10 ; premier champ rendu : ${Object.keys(premier)[0]}`);
      console.log(`${"".padEnd(20)} exemple de critique : ${[...String(premier.critique)].slice(0, 150).join("")}`);
    }
  }
  console.log(`\nCoût : ${total.toFixed(4)} $`);
}

if (estLance(import.meta.url)) await main();
