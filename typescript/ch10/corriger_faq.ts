// Chapitre 10 : l'outil éditeur de texte, exécuté par notre code dans un dossier fermé.
//
// Claude relit la FAQ du site d'Awa, la compare aux conditions officielles, et corrige les erreurs avec
// l'outil éditeur. Le script travaille sur une copie, dans un dossier temporaire, et affiche les
// différences : rien n'est modifié dans le dépôt. La FAQ est celle de la version Python
// (python/ch10/donnees/faq-modele.md).
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch10/corriger_faq.ts

import Anthropic from "@anthropic-ai/sdk";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRecu } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { enBlocs } from "../comptoir/conversations.ts";
import { cout } from "../comptoir/couts.ts";
import { decouperLignes, diffUnifie } from "../comptoir/difference.ts";
import { Editeur, OUTIL, lireTexte } from "../comptoir/editeur.ts";
import { noter } from "../comptoir/journal.ts";
import { PYTHON } from "../comptoir/lancement.ts";
import { chargerDonnees, rendreConditions } from "../comptoir/prompt.ts";

const MODELE_FAQ = join(PYTHON, "ch10", "donnees", "faq-modele.md");
const TOURS_MAX = 8;

const client = new Anthropic();
const dossier = mkdtempSync(join(tmpdir(), "faq-"));
try {
  copyFileSync(MODELE_FAQ, join(dossier, "faq.md"));
  const editeur = new Editeur(dossier);
  const consigne =
    "Le fichier faq.md est la FAQ du site de Délices d'Awa. Compare-la aux conditions officielles ci-dessous " +
    "et corrige chaque affirmation qui les contredit, sans rien changer d'autre.\n\n<conditions>\n" +
    `${rendreConditions(chargerDonnees())}\n</conditions>`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: consigne }];
  let total = 0;
  let message!: MessageRecu;
  for (let tour = 0; tour < TOURS_MAX; tour++) {
    message = await client.messages.create({ model: config.MODELE, max_tokens: 4000, tools: [OUTIL], messages });
    const prix = cout(config.MODELE, message.usage);
    noter(message._request_id, config.MODELE, prix, { stop_reason: message.stop_reason });
    total += prix.dollars;
    messages.push({ role: "assistant", content: enBlocs(message.content) as Anthropic.ContentBlockParam[] });
    const appels = message.content.filter((b) => b.type === "tool_use");
    for (const appel of appels) {
      const entree = appel.input as { command?: string; path?: string };
      console.log(`  outil : ${entree.command ?? "None"} ${entree.path ?? "None"}`);
    }
    if (message.stop_reason !== "tool_use") break;
    messages.push({ role: "user", content: appels.map((appel) => editeur.resultat(appel)) });
  }

  console.log("\n" + message.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  const avant = decouperLignes(lireTexte(MODELE_FAQ), true);
  const apres = decouperLignes(lireTexte(join(dossier, "faq.md")), true);
  console.log(diffUnifie(avant, apres, "faq.md (avant)", "faq.md (après)").join(""));
  console.log(`Coût : ${total.toFixed(4)} $ (≈ ${(total * config.TAUX_FCFA).toFixed(1)} FCFA)`);
} finally {
  // Le SDK ne signale une clé absente qu'au premier envoi : le dossier se supprime dans tous les cas.
  rmSync(dossier, { recursive: true });
}
