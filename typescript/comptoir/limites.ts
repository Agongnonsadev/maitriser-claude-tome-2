// Les limites du Comptoir sur le web (chapitre 18) : qui envoie, combien, et quelle taille.
//
// Le budget du chapitre 8 compte par conversation : un script qui ouvre une conversation neuve à chaque
// message ne le voit jamais revenir. D'où trois limites par adresse réseau, devant le budget :
// - des messages par minute : une rafale s'arrête ;
// - des conversations neuves par heure : le contournement du quota par client s'arrête ;
// - un quota en dollars par jour (comptoir/budget.ts, groupe) : une adresse ne prend jamais tout le jour.
//
// Une adresse n'est pas une personne : derrière celle d'un opérateur mobile, il y a souvent beaucoup
// d'abonnés. Les limites sont larges, faites pour un script ; l'identité solide viendra du numéro de
// téléphone, avec WhatsApp (chapitre 19).
//
// Les compteurs vivent en mémoire : un redémarrage les remet à zéro, ce qui est acceptable pour arrêter
// une rafale. Le quota en dollars, lui, est dans la base du budget.

import { performance } from "node:perf_hooks";

/** Une fenêtre glissante par clé : au plus `maximum` événements pendant `fenetreS` secondes. */
export class Limiteur {
  private readonly evenements = new Map<string, number[]>();

  constructor(
    readonly maximum: number,
    readonly fenetreS: number,
    private readonly horloge: () => number = () => performance.now() / 1000,
  ) {}

  /** null si l'événement est accepté (et compté) ; sinon, le nombre de secondes à attendre. */
  accepter(cle: string): number | null {
    const maintenant = this.horloge();
    const file = this.evenements.get(cle) ?? [];
    while (file.length && file[0]! <= maintenant - this.fenetreS) file.shift();
    this.evenements.set(cle, file);
    if (file.length >= this.maximum) return Math.round((file[0]! + this.fenetreS - maintenant) * 10) / 10;
    file.push(maintenant);
    return null;
  }
}

/**
 * L'adresse du client. Derrière un relais de confiance (Caddy), c'est la dernière adresse que ce relais
 * a ajoutée à X-Forwarded-For ; sans relais de confiance, l'en-tête est ignoré : n'importe qui peut
 * l'écrire.
 */
export function adresseDuClient(hote: string | null | undefined, transferePour: string | null | undefined, proxiesDeConfiance: string[]): string {
  if (hote && proxiesDeConfiance.includes(hote) && transferePour) return transferePour.split(",").at(-1)!.trim();
  return hote || "inconnue";
}
