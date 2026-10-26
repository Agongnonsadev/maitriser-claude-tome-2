// Les dates comme le module datetime de Python, sur des jours écrits AAAA-MM-JJ (chapitres 13 et 15) : lire
// une date comme date.fromisoformat, ajouter des jours, trouver le lundi d'une semaine, le jour de la semaine.

export const jourUtc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
export const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** date + timedelta(days=n). */
export const ajouterJours = (jour: string, n: number): string => iso(new Date(jourUtc(jour).getTime() + n * 86_400_000));

/** Le lundi de la semaine d'un jour (weekday() vaut 0 le lundi). */
export const lundiDe = (jour: string): string => ajouterJours(jour, -((jourUtc(jour).getUTCDay() + 6) % 7));

/**
 * date.fromisoformat() de Python : « 2026-10-21 », « 20261021 », et les semaines ISO (« 2026-W43 »,
 * « 2026-W43-3 », « 2026W433 »). Rend le jour au format AAAA-MM-JJ, ou null si le texte n'est pas une date.
 */
export function lireDate(texte: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texte) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(texte);
  if (m) {
    const [annee, mois, jour] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (annee < 1 || mois < 1 || mois > 12 || jour < 1) return null;
    const d = new Date(Date.UTC(annee, mois - 1, jour));
    d.setUTCFullYear(annee); // les années avant 100 ne sont pas décalées de 1900
    return d.getUTCMonth() === mois - 1 && d.getUTCDate() === jour ? iso(d).padStart(10, "0") : null;
  }
  m = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(texte) ?? /^(\d{4})W(\d{2})(\d)?$/.exec(texte);
  if (!m) return null;
  const [annee, semaine, jour] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)];
  if (annee < 1 || jour < 1 || jour > 7 || semaine < 1) return null;
  // Le lundi de la semaine 1 : celui de la semaine du 4 janvier.
  const quatre = new Date(Date.UTC(annee, 0, 4));
  quatre.setUTCFullYear(annee);
  const lundi1 = quatre.getTime() - ((quatre.getUTCDay() + 6) % 7) * 86_400_000;
  // Une année a 53 semaines si elle commence un jeudi, ou un mercredi quand elle est bissextile.
  const premier = (quatre.getUTCDay() + 6 - 3 + 7) % 7; // jour de la semaine du 1er janvier, lundi = 0
  const bissextile = (annee % 4 === 0 && annee % 100 !== 0) || annee % 400 === 0;
  if (semaine > (premier === 3 || (premier === 2 && bissextile) ? 53 : 52)) return null;
  return iso(new Date(lundi1 + ((semaine - 1) * 7 + jour - 1) * 86_400_000)).padStart(10, "0");
}


/** weekday() de Python : 0 le lundi, 6 le dimanche. */
export const jourDeLaSemaine = (jour: string): number => (jourUtc(jour).getUTCDay() + 6) % 7;
