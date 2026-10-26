// Le Comptoir aiguillé : un routeur, trois services, une trace par message (chapitre 12).
//
// Le gestionnaire est du code, pas un modèle : il demande la catégorie au routeur, puis confie le message
// au bon exécutant, chacun avec son modèle, son prompt et ce qu'il doit voir, rien de plus.
// - information : l'assistant documentaire, avec Claude Haiku 5.5 et la base d'Awa en cache, sans
//   citations ni réflexion : avec les citations, Haiku réfléchit quand même, et ses réponses se dégradent
//   (mesuré au chapitre 12) ; une réponse coupée part au Comptoir, comme, depuis le chapitre 18, une
//   réponse qui annonce une transmission à Awa (comptoir/garde.ts) ;
// - commande et autre : le Comptoir du chapitre 9, avec ses outils et la base ; Claude Sonnet 5.5 au
//   chapitre 12, Claude Haiku 5.5 depuis l'évaluation du chapitre 17 (config.MODELE_COMPTOIR) ;
// - reclamation : la chaîne des réclamations, qui transmet tout à Awa.
//
// Les échanges traités hors du Comptoir sont ajoutés à son historique, en texte simple : quand le client
// enchaîne sur une commande, le Comptoir connaît la conversation.

import type Anthropic from "@anthropic-ai/sdk";
import type { Boutique } from "./boutique.ts";
import type { Budget } from "./budget.ts";
import type { ClientMessages } from "./client.ts";
import { ComptoirCommandes, type Reponse } from "./commandes.ts";
import { config } from "./config.ts";
import type { Cache, Morceau } from "./connaissances.ts";
import { chargerPrompt, repondre as repondreDocuments } from "./documentaire.ts";
import { annonceUneTransmission } from "./garde.ts";
import { messageClient, type PromptSysteme } from "./prompt.ts";
import { traiter } from "./reclamations.ts";
import { MODELE_ROUTEUR, router } from "./routeur.ts";
import { Trace } from "./trace.ts";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export const MODELE_DOCUMENTS = config.MODELE_DOCUMENTS;

export interface ReponseAiguillee {
  texte: string;
  categorie: string;
  trace: Trace;
}

/**
 * Chapitre 17 : modeleComptoir, versionPrompt et versionDocuments se changent pour évaluer une variante ;
 * les défauts sont la version livrée (modèle : config.MODELE_COMPTOIR ; prompt v5 depuis le chapitre 18,
 * qui dit au Comptoir qu'il est une IA). effortComptoir (chapitre 19) : null pour config.EFFORT_COMPTOIR
 * (le défaut du modèle s'il est vide). Cet effort-là a été mesuré pour le modèle livré : il ne s'applique
 * pas à un autre modèle qu'on évalue (chapitre 20, relevé par la relecture de Claude).
 */
export interface OptionsAiguillage {
  modeleDocuments?: string;
  cache?: Cache;
  modeleComptoir?: string | null;
  versionPrompt?: string;
  versionDocuments?: string;
  effortComptoir?: Effort | null;
}

export class ComptoirAiguille {
  readonly modeleDocuments: string;
  readonly cache: Cache;
  readonly comptoir: ComptoirCommandes;
  readonly promptDocuments: PromptSysteme;

  constructor(
    readonly client: ClientMessages,
    readonly boutique: Boutique,
    budget: Budget,
    readonly conversation: string,
    readonly base: Morceau[],
    { modeleDocuments = MODELE_DOCUMENTS, cache = "1h", modeleComptoir = null, versionPrompt = "v5", versionDocuments = "v1", effortComptoir = null }: OptionsAiguillage = {},
  ) {
    this.modeleDocuments = modeleDocuments;
    this.cache = cache;
    this.comptoir = new ComptoirCommandes(client, boutique, budget, conversation, {
      versionPrompt,
      connaissances: base,
      cache,
      modele: modeleComptoir || config.MODELE_COMPTOIR,
      effort: effortComptoir || (modeleComptoir === null ? (config.EFFORT_COMPTOIR as Effort | null) : null),
    });
    this.promptDocuments = chargerPrompt(versionDocuments);
  }

  commandeEnCours(): boolean {
    return this.boutique.recapitulatifs(this.conversation).some((r) => r.statut === "en_attente");
  }

  private garderLeFil(texte: string, reponse: string): void {
    this.comptoir.historique.push(
      { role: "user", content: messageClient(texte) },
      { role: "assistant", content: [{ type: "text", text: reponse }] },
    );
  }

  async repondre(texte: string): Promise<ReponseAiguillee> {
    const trace = new Trace();
    const decision = await trace.etape("routage", MODELE_ROUTEUR, async (e) => {
      // Le réglage retenu par la mesure : Claude Haiku 5.5, sans réflexion.
      const d = await router(this.client, texte, { commandeEnCours: this.commandeEnCours(), sansReflexion: true });
      e.noter(d.cout, `${d.categorie} (par ${d.par})`);
      return d;
    });
    let categorie = decision.categorie;

    if (categorie === "information") {
      const reponse = await this.information(texte, trace);
      if (reponse !== null) return { texte: reponse, categorie, trace };
      categorie = "information, repli"; // une réponse coupée n'est pas une réponse : le Comptoir prend le relais
    }
    if (categorie === "reclamation") {
      const resultat = await traiter(this.client, texte, this.boutique, this.conversation, { trace });
      this.garderLeFil(texte, resultat.reponse);
      return { texte: resultat.reponse, categorie, trace };
    }
    const r = await trace.etape("comptoir", this.comptoir.prompt.identifiant, async (e) => {
      const avant = this.comptoir.historique.length;
      const reponse = await this.comptoir.repondre(texte);
      e.noter(coutDuTour(reponse), `${this.comptoir.historique.length - avant} messages ajoutés`);
      return reponse;
    });
    return { texte: r.texte, categorie, trace };
  }

  private async information(texte: string, trace: Trace): Promise<string | null> {
    const r = await trace.etape("documents", this.modeleDocuments, async (e) => {
      const reponse = await repondreDocuments(this.client, texte, this.base, {
        prompt: this.promptDocuments,
        cache: this.cache,
        mode: "aiguille",
        modele: this.modeleDocuments,
        sansReflexion: true,
        avecCitations: false,
      });
      e.noter(reponse.cout.dollars, reponse.arret);
      return reponse;
    });
    if (r.arret !== "end_turn" || !r.texteSimple) return null;
    if (annonceUneTransmission(r.texteSimple)) {
      // Chapitre 18 : l'assistant documentaire n'a aucun outil. Une transmission qu'il annonce n'aura pas
      // lieu : sa réponse n'est pas envoyée, le Comptoir, qui a l'outil, prend le relais.
      trace.ajouter("garde", "code", 0, 0, "transmission annoncée sans outil : relais au Comptoir");
      return null;
    }
    this.garderLeFil(texte, r.texteSimple);
    return r.texteSimple;
  }
}

/** Le coût des appels faits par le Comptoir pendant ce tour (0 pour une confirmation lue par le code). */
const coutDuTour = (reponse: Reponse): number => (reponse.tour ? reponse.tour.cout : 0);
