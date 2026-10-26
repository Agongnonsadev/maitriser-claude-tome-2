// Le Comptoir qui prend des commandes : outils, récapitulatif officiel, confirmation par le client
// (chapitre 9).
//
// Le motif d'approbation est simple et ne dépend pas du modèle :
// 1. Claude prépare un récapitulatif avec l'outil commande_preparer ;
// 2. le code affiche lui-même le récapitulatif officiel, avec le total et un code à quatre chiffres ;
// 3. le client répond « OUI 1234 » ; ce message est lu par le code, pas par Claude ;
// 4. le code crée la commande, une seule fois.

import type Anthropic from "@anthropic-ai/sdk";
import { construireRequete } from "./assistant.ts";
import { type Tour, converser } from "./boucle.ts";
import { type Boutique, type Recapitulatif, RefusBoutique } from "./boutique.ts";
import type { Budget } from "./budget.ts";
import type { ClientMessages } from "./client.ts";
import { type Cache, type Morceau, blocsResultats } from "./connaissances.ts";
import { annonceUneTransmission } from "./garde.ts";
import { noterEvenement } from "./journal.ts";
import { OUTILS, Outils } from "./outils.ts";
import { type PromptSysteme, charger, messageClient } from "./prompt.ts";

export const VERSION_PROMPT = "v2";
export const CONFIRMATION = /^\s*oui\s+(\d{4})\s*[.!]?\s*$/i;

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** 11000 -> « 11 000 », comme f"{n:,}".replace(",", " ") en Python. */
const milliers = (n: number): string => n.toLocaleString("en-US").replaceAll(",", " ");

/** Le récapitulatif que voit le client : écrit par le code, à partir des données de la boutique. */
export function rendreRecapitulatif(recap: Recapitulatif): string {
  const lignes = recap.lignes.map((l) => `  ${l.quantite} × ${l.produit} : ${milliers(l.montant)} FCFA`);
  const frais = recap.frais_livraison;
  return [
    "Récapitulatif de votre commande",
    ...lignes,
    `  Livraison (${recap.quartier}, ${recap.livraison_prevue}) : ${frais === 0 ? "offerte" : `${frais} FCFA`}`,
    `  Total : ${milliers(recap.total_fcfa)} FCFA`,
    `Pour confirmer, répondez exactement : OUI ${recap.code_de_confirmation}`,
  ].join("\n");
}

export interface Reponse {
  texte: string; //                              ce que lit le client
  nouveauxMessages: Anthropic.MessageParam[];
  tour: Tour | null; //                          null : la réponse vient du code (confirmation)
}

export interface OptionsComptoir {
  versionPrompt?: string;
  /** Chapitre 11 : la base d'Awa en connaissances. */
  connaissances?: Morceau[] | null;
  /**
   * Chapitre 11 : "1h", le début commun à tous les clients (outils, prompt, base) est gardé une heure ;
   * la fin de chaque conversation, elle, reste en cache automatique de 5 minutes.
   */
  cache?: Cache;
  /** Chapitre 17 : null pour le modèle de config ; un autre, pour l'évaluer. */
  modele?: string | null;
  /**
   * Chapitre 19 : l'effort de ce modèle, constant pendant toute la conversation (en changer invaliderait
   * le cache) ; null pour le défaut du modèle.
   */
  effort?: Effort | null;
}

/** Une conversation avec le Comptoir, outils compris. L'historique est en ajout seul. */
export class ComptoirCommandes {
  readonly prompt: PromptSysteme;
  readonly historique: Anthropic.MessageParam[] = [];
  private readonly cache: boolean;
  private readonly blocs: Anthropic.SearchResultBlockParam[] | null;
  private readonly modele: string | null;
  private readonly effort: Effort | null;

  constructor(
    readonly client: ClientMessages,
    readonly boutique: Boutique,
    readonly budget: Budget,
    readonly conversation: string,
    { versionPrompt = VERSION_PROMPT, connaissances = null, cache = false, modele = null, effort = null }: OptionsComptoir = {},
  ) {
    this.prompt = charger(versionPrompt);
    this.cache = Boolean(cache);
    // Les blocs sont construits une fois pour toutes : identiques d'un tour à l'autre.
    this.blocs = connaissances?.length ? blocsResultats(connaissances, cache) : null;
    this.modele = modele;
    this.effort = effort;
  }

  requete(texte: string): Anthropic.MessageCreateParamsNonStreaming {
    const requete = construireRequete(texte, {
      historique: this.historique, prompt: this.prompt, cache: this.cache, connaissances: this.blocs,
      modele: this.modele, effort: this.effort,
    });
    // Les outils ne changent pas pendant une conversation : les modifier invaliderait la réflexion
    // préservée de tous les tours précédents (chapitre 6).
    requete.tools = OUTILS;
    return requete;
  }

  async repondre(texte: string): Promise<Reponse> {
    const confirmation = CONFIRMATION.exec(texte);
    let reponse: Reponse;
    if (confirmation) {
      reponse = this.confirmer(confirmation[1]!, texte);
    } else {
      const tour = await converser(this.client, this.requete(texte), new Outils(this.boutique, this.conversation), this.budget,
        this.conversation, this.prompt.identifiant);
      if (tour.arret?.code === "refus") {
        // Comme au chapitre 8 : la réponse refusée est jetée, et le tour n'entre pas dans l'historique.
        return { texte: tour.arret.pourLeClient, nouveauxMessages: [], tour };
      }
      let visible = tour.texte;
      if (annonceUneTransmission(tour.texte) && !tour.execution.transmissions.length) {
        // Chapitre 18 : le client a lu « je transmets votre demande à Awa » ; le code tient la promesse que
        // le modèle a faite sans appeler l'outil. Awa reçoit le message du client, tel quel.
        const demande = this.boutique.transmettre(this.conversation, "autre",
          `Transmission annoncée au client par le Comptoir. Son message : ${[...texte].slice(0, 300).join("")}`);
        tour.execution.transmissions.push(demande);
        noterEvenement("garde", { regle: "transmission_annoncee", demande: demande.demande });
      }
      if (tour.execution.recapitulatif) visible = `${visible}\n\n${rendreRecapitulatif(tour.execution.recapitulatif)}`;
      const question: Anthropic.MessageParam = { role: "user", content: messageClient(texte) };
      reponse = { texte: visible, nouveauxMessages: [question, ...tour.nouveauxMessages], tour };
    }
    this.historique.push(...reponse.nouveauxMessages);
    return reponse;
  }

  /** La confirmation ne passe pas par Claude : le code lit le message et crée la commande. */
  private confirmer(code: string, texte: string): Reponse {
    let visible: string;
    try {
      const commande = this.boutique.confirmer(this.conversation, code);
      visible = commande.deja_enregistree
        ? `Votre commande ${commande.commande} était déjà enregistrée : rien n'a été ajouté.`
        : `Votre commande ${commande.commande} est enregistrée, pour un total de ${milliers(commande.total_fcfa)} FCFA. ` +
          "Awa vous contacte pour la livraison. Merci !";
    } catch (refus) {
      if (!(refus instanceof RefusBoutique)) throw refus;
      visible = `Je n'ai pas pu confirmer : ${refus.message}`;
    }
    // L'échange entre dans l'historique, pour que Claude sache, au tour suivant, ce qui s'est passé.
    const echange: Anthropic.MessageParam[] = [
      { role: "user", content: messageClient(texte) },
      { role: "assistant", content: [{ type: "text", text: visible }] },
    ];
    return { texte: visible, nouveauxMessages: echange, tour: null };
  }
}
