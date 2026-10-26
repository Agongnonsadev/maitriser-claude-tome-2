// Chapitre 18 : les données des clients, gardées le temps promis, effacées à la demande.
//
// Depuis le dossier typescript/ (GRATUIT, aucun appel à l'API) :
//     npx tsx ch18/donnees.ts purger                          les durées de config.ts, sur les deux bases
//     npx tsx ch18/donnees.ts effacer <conversation>          ce qu'un client a demandé d'effacer
//     npx tsx ch18/donnees.ts effacer-numero <numéro>         la même chose pour un client WhatsApp (chapitre 21)
//
// `purger` est à lancer chaque jour : le serveur en ligne le fait de lui-même (comptoir/en_ligne.ts), pour
// les trois bases. `effacer` sert quand un client le demande : le Comptoir ne peut rien effacer lui-même
// (aucun outil ne le permet), il transmet la demande à Awa, qui lance la commande. Les commandes passées
// restent, réduites au prénom et à l'initiale du client : la comptabilité en a besoin. Le délai pour
// répondre dépend de la loi du pays du client.

import { Boutique } from "../comptoir/boutique.ts";
import { config } from "../comptoir/config.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { estLance } from "../comptoir/lancement.ts";
import { jsonPython } from "../comptoir/python.ts";
import * as whatsapp from "../comptoir/whatsapp.ts";

export function purger(boutique: Boutique, conversations: Conversations, annuaire: whatsapp.Annuaire): Record<string, number> {
  return {
    ...boutique.purger(config.CONSERVATION_DEMANDES_J, config.CONSERVATION_NOMS_J, config.CONSERVATION_RECAPITULATIFS_J),
    conversations_effacees: conversations.purger(),
    clients_whatsapp_oublies: annuaire.purger(config.CONSERVATION_J),
  };
}

export function effacer(boutique: Boutique, conversations: Conversations, annuaire: whatsapp.Annuaire, conversation: string): Record<string, number | boolean> {
  return {
    ...boutique.effacer(conversation),
    conversation_effacee: conversations.effacer(conversation),
    // Chapitre 21 : le numéro WhatsApp aussi, qui restait dans l'annuaire du chapitre 19.
    numero_efface: annuaire.effacer(conversation) > 0,
  };
}

/** Un client WhatsApp donne son numéro, pas un identifiant de conversation : on le retrouve par l'empreinte. */
export function effacerNumero(boutique: Boutique, conversations: Conversations, annuaire: whatsapp.Annuaire, numero: string): Record<string, number | boolean> {
  const conversation = annuaire.conversation(whatsapp.pseudonyme(numero, config.SEL_PSEUDONYMES));
  if (conversation === null) return { conversation_trouvee: false };
  return { conversation_trouvee: true, ...effacer(boutique, conversations, annuaire, conversation) };
}

function main(): void {
  const [commande, argument] = process.argv.slice(2);
  const boutique = new Boutique(config.BOUTIQUE);
  const conversations = new Conversations(config.CONVERSATIONS);
  const annuaire = new whatsapp.Annuaire(config.CONVERSATIONS); // l'annuaire vit dans la base des conversations
  let resultat: Record<string, number | boolean>;
  if (commande === "purger") resultat = purger(boutique, conversations, annuaire);
  else if (commande === "effacer" && argument) resultat = effacer(boutique, conversations, annuaire, argument);
  else if (commande === "effacer-numero" && argument) resultat = effacerNumero(boutique, conversations, annuaire, argument); // au format de WhatsApp, sans + ni espace : 22997000000
  else {
    console.error("Commande : purger, effacer <conversation> ou effacer-numero <numéro>.");
    process.exit(2);
  }
  console.log(jsonPython(resultat));
}

if (estLance(import.meta.url)) main();
