// Chapitre 8 : provoquer volontairement chaque erreur, et lire le diagnostic du Comptoir.
//
// Lancement, depuis le dossier typescript/ :
//     npx tsx ch08/provoquer_erreurs.ts              (tous les cas)
//     npx tsx ch08/provoquer_erreurs.ts cle budget   (certains cas)
//
// Coût : presque nul. Les erreurs renvoyées par l'API (clé, modèle, requête invalide) ne sont pas
// facturées ; le cas max_tokens fait un appel de quelques tokens ; le cas budget ne fait qu'un comptage,
// gratuit.

import Anthropic from "@anthropic-ai/sdk";
import { appeler } from "../comptoir/appel.ts";
import { construireRequete } from "../comptoir/assistant.ts";
import { Budget } from "../comptoir/budget.ts";
import { config } from "../comptoir/config.ts";
import { type Diagnostic, ErreurComptoir, diagnostiquer, diagnostiquerArret } from "../comptoir/erreurs.ts";

const QUESTION: Anthropic.MessageParam[] = [{ role: "user", content: "Bonjour" }];

function montrer(nom: string, diagnostic: Diagnostic | null): void {
  if (diagnostic === null) {
    console.log(`${nom.padEnd(10)} aucune anomalie`);
    return;
  }
  console.log(`${nom.padEnd(10)} ${diagnostic.code} (origine : ${diagnostic.origine}, réessayer : ${diagnostic.reessayer ? "oui" : "non"})`);
  console.log(`${"".padEnd(10)} client : ${diagnostic.pourLeClient}`);
  console.log(`${"".padEnd(10)} Yao    : ${diagnostic.pourYao}`);
}

async function essayer(nom: string, client: Anthropic, requete: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Promise<void> {
  try {
    const message = await client.messages.create({ model: config.MODELE, max_tokens: 50, messages: QUESTION, ...requete });
    montrer(nom, diagnostiquerArret(message));
  } catch (erreur) {
    montrer(nom, diagnostiquer(erreur));
  }
}

/** Un quota de client minuscule : l'appel est refusé avant de partir. */
async function casBudget(): Promise<void> {
  config.QUOTA_CLIENT_JOUR = 0.000001;
  try {
    await appeler(new Anthropic(), construireRequete("Bonjour"), new Budget(), "essai-budget");
  } catch (erreur) {
    if (erreur instanceof ErreurComptoir) montrer("budget", erreur.diagnostic);
    else throw erreur;
  }
}

const CAS: Record<string, () => Promise<void>> = {
  // Une clé fausse, écrite en clair exprès : elle ne donne accès à rien.
  cle: () => essayer("cle", new Anthropic({ apiKey: "sk-ant-cle-volontairement-fausse", maxRetries: 0 })),
  modele: () => essayer("modele", new Anthropic({ maxRetries: 0 }), { model: "claude-modele-inexistant" }),
  prefill: () => essayer("prefill", new Anthropic({ maxRetries: 0 }), { messages: [...QUESTION, { role: "assistant", content: "Bonjour, je" }] }),
  delai: () => essayer("delai", new Anthropic({ timeout: 1, maxRetries: 0 })), // 1 ms : le SDK compte en millisecondes
  max_tokens: () => essayer("max_tokens", new Anthropic(), { max_tokens: 5 }),
  budget: casBudget,
};

const noms = process.argv.slice(2);
for (const nom of noms.length ? noms : Object.keys(CAS)) {
  const cas = CAS[nom];
  if (!cas) throw new Error(`Cas inconnu : ${nom} (cas possibles : ${Object.keys(CAS).join(", ")})`);
  await cas();
}
