// Les bases SQLite du Comptoir (conversations, budget), avec le module SQLite intégré à Node : aucune
// dépendance à compiler. Sans option depuis Node 22.13 ; Node 22 l'annonce encore comme expérimental,
// par un avertissement au premier usage, que `npm test` et `npm run web` masquent. Les versions récentes
// de Node l'appellent aussi Database ; DatabaseSync, son premier nom, marche partout.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Ouvre une base, en créant son dossier ; ":memory:" pour une base en mémoire (tests). */
export function ouvrirBase(chemin: string): DatabaseSync {
  if (chemin !== ":memory:") mkdirSync(dirname(chemin), { recursive: true });
  return new DatabaseSync(chemin);
}

/** Tout ou rien, comme `with db:` en Python : validé si f réussit, annulé si elle lève une erreur. */
export function transaction<T>(db: DatabaseSync, f: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const resultat = f();
    db.exec("COMMIT");
    return resultat;
  } catch (erreur) {
    db.exec("ROLLBACK");
    throw erreur;
  }
}

/** Un identifiant comme uuid.uuid4().hex en Python : 32 caractères hexadécimaux. */
export const identifiantAleatoire = (): string => crypto.randomUUID().replaceAll("-", "");

/** Une date comme datetime.isoformat() en Python, en UTC : 2026-10-22T08:15:00.123000+00:00. */
export const isoformat = (date: Date): string => date.toISOString().replace(/Z$/, "000+00:00");
