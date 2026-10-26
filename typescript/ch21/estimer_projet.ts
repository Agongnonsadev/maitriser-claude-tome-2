// Chapitre 21 : estimer ce que coûtera, chaque mois, un assistant comme le Comptoir pour un client.
//
// Depuis le dossier typescript/ (gratuit, aucun appel) :
//     npx tsx ch21/estimer_projet.ts --messages 1500 --whatsapp --hebergement 7
//     npx tsx ch21/estimer_projet.ts --messages 1500 --cout-message 0.0009
//
// Une estimation, pas une mesure : elle part des prix unitaires mesurés dans le livre, pour une application qui
// ressemble au Comptoir (Claude Haiku 5.5, outils, cache, réclamations rédigées par Claude Sonnet 5.5). Pour
// une autre application, mesurez d'abord son coût par message (chapitre 19), puis passez-le en --cout-message.
// L'hébergement n'a pas été mesuré dans le livre : c'est à vous de le donner.

import { parseArgs } from "node:util";
import { fixe } from "../comptoir/arrondi.ts";
import { config } from "../comptoir/config.ts";
import { estLance } from "../comptoir/lancement.ts";
import { pourcent } from "../ch17/suite.ts";

// Chapitre 19 : huit conversations types, trois essais, le 22 octobre 2026 (0,00075 $ par message).
export const COUT_PAR_MESSAGE = 0.00075;
// Chapitre 19 : tarif d'un message de service WhatsApp, région « Reste de l'Afrique », relevé le 22 octobre 2026,
// et les 1 000 messages de service gratuits par mois et par numéro.
export const TARIF_WHATSAPP = 0.004;
export const GRATUITS_WHATSAPP = 1000;
export const MARGE = 0.5; // chapitre 1 : la moitié en plus, pour ce que la mesure n'a pas vu (pics, conversations longues)

export interface Estimation {
  claude: number;
  claudeAvecMarge: number;
  whatsapp: number;
  hebergement: number | null;
  total: number | null;
}

export function estimer(messages: number, { coutMessage = COUT_PAR_MESSAGE, whatsapp = false, tarifWhatsapp = TARIF_WHATSAPP, hebergement = null as number | null } = {}): Estimation {
  const claude = messages * coutMessage;
  const canal = whatsapp ? Math.max(0, messages - GRATUITS_WHATSAPP) * tarifWhatsapp : 0;
  const claudeAvecMarge = claude * (1 + MARGE);
  return { claude, claudeAvecMarge, whatsapp: canal, hebergement, total: hebergement === null ? null : claudeAvecMarge + canal + hebergement };
}

export function enTexte(e: Estimation, messages: number): string {
  const ligne = (nom: string, dollars: number | null): string =>
    dollars === null
      ? `${nom.padEnd(38)} [à mesurer]`
      : `${nom.padEnd(38)} ${fixe(dollars, 2).padStart(8)} $  ${fixe(dollars * config.TAUX_FCFA, 0).padStart(8)} FCFA  ${fixe(dollars * config.TAUX_EUR, 2).padStart(7)} €`;
  const lignes = [
    `Pour ${messages} messages par mois :`,
    ligne("Claude (prix unitaire mesuré)", e.claude),
    ligne(`Claude, avec ${pourcent(MARGE)} de marge`, e.claudeAvecMarge),
    ligne("WhatsApp (messages de service)", e.whatsapp),
    ligne("Hébergement", e.hebergement),
    ligne("Total par mois", e.total),
  ];
  if (e.total !== null && messages) lignes.push(`${"Par message".padEnd(38)} ${fixe(e.total / messages, 4).padStart(8)} $`);
  return lignes.join("\n");
}

function main(): void {
  const { values: args } = parseArgs({
    options: {
      messages: { type: "string" }, //                                    messages de clients par mois
      "cout-message": { type: "string", default: String(COUT_PAR_MESSAGE) }, // en dollars, mesuré pour votre application
      whatsapp: { type: "boolean", default: false }, //                  les clients écrivent sur WhatsApp
      "tarif-whatsapp": { type: "string", default: String(TARIF_WHATSAPP) }, // en dollars, pour votre pays
      hebergement: { type: "string" }, //                                 en dollars par mois
    },
  });
  if (!args.messages) {
    console.error("--messages est obligatoire : les messages de clients par mois.");
    process.exit(2);
  }
  const messages = Number(args.messages);
  console.log(enTexte(estimer(messages, {
    coutMessage: Number(args["cout-message"]), whatsapp: args.whatsapp, tarifWhatsapp: Number(args["tarif-whatsapp"]),
    hebergement: args.hebergement === undefined ? null : Number(args.hebergement),
  }), messages));
}

if (estLance(import.meta.url)) main();
