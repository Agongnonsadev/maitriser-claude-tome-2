// Préparer une image ou un PDF pour Claude, et prévoir ce qu'il coûtera (chapitre 7).
//
// Règles et limites relevées le 20 octobre 2026 sur platform.claude.com (Vision, PDF support,
// Coordinates and bounding boxes). Elles changent : vérifiez-les (page d'accompagnement).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import sharp from "sharp";
import { arrondir } from "./arrondi.ts";

type TypeImage = Anthropic.Base64ImageSource["media_type"];

export const TYPES_IMAGE: Record<string, TypeImage> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif", // seule la première image d'une animation est lue
  ".webp": "image/webp",
};

// Par l'API d'Anthropic : 10 Mo par image une fois encodée en base64 (5 Mo sur Bedrock et Google
// Cloud), 32 Mo par requête, 8000 px au plus de côté.
export const IMAGE_BASE64_MAX = 10 * 1024 * 1024;
export const REQUETE_MAX = 32 * 1024 * 1024;
export const COTE_ABSOLU_MAX = 8000;

// Claude voit une image par carrés de 28 × 28 pixels : un carré, un token.
export const CARRE = 28;

// Deux niveaux de résolution. Les modèles 4.7 et suivants (tous ceux du Comptoir) sont en haute
// résolution : 2576 px de côté et 4784 tokens au plus. Les autres : 1568 et 1568.
export const HAUTE_RESOLUTION: [coteMax: number, jetonsMax: number] = [2576, 4784];
export const STANDARD: [coteMax: number, jetonsMax: number] = [1568, 1568];
export const MODELES_HAUTE_RESOLUTION = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

export function limites(modele: string): [number, number] {
  return MODELES_HAUTE_RESOLUTION.has(modele) ? HAUTE_RESOLUTION : STANDARD;
}

/** Tokens d'une image de cette taille, si Claude la voit sans la réduire. */
export function jetonsImage(largeur: number, hauteur: number): number {
  return Math.ceil(largeur / CARRE) * Math.ceil(hauteur / CARRE);
}

/**
 * La taille à laquelle Claude réduit une image avant de la lire.
 *
 * Traduction de l'implémentation de référence d'Anthropic : la plus grande taille, aux mêmes
 * proportions, qui respecte à la fois le côté maximal et le nombre de tokens.
 */
export function tailleVue(largeur: number, hauteur: number, coteMax: number, jetonsMax: number): [number, number] {
  const tient = (l: number, h: number): boolean =>
    Math.ceil(l / CARRE) * CARRE <= coteMax && Math.ceil(h / CARRE) * CARRE <= coteMax && jetonsImage(l, h) <= jetonsMax;

  if (tient(largeur, hauteur)) return [largeur, hauteur];
  if (hauteur > largeur) {
    const [h, l] = tailleVue(hauteur, largeur, coteMax, jetonsMax);
    return [l, h];
  }
  const proportion = largeur / hauteur;
  let bas = 1; // bas tient toujours, haut jamais
  let haut = largeur;
  while (bas + 1 < haut) {
    const milieu = Math.floor((bas + haut) / 2);
    if (tient(milieu, Math.max(arrondir(milieu / proportion), 1))) bas = milieu;
    else haut = milieu;
  }
  return [bas, Math.max(arrondir(bas / proportion), 1)];
}

/** Tokens que coûtera l'image avec ce modèle, réduction comprise. */
export function jetonsPrevus(largeur: number, hauteur: number, modele: string): number {
  return jetonsImage(...tailleVue(largeur, hauteur, ...limites(modele)));
}

export function typeImage(chemin: string): TypeImage {
  const type = TYPES_IMAGE[extname(chemin).toLowerCase()];
  if (!type) throw new Error(`${basename(chemin)} : format non accepté (JPEG, PNG, GIF ou WebP seulement).`);
  return type;
}

/**
 * Réduit une image pour que son grand côté ne dépasse pas coteMax, en JPEG de bonne qualité.
 *
 * Réduire avant d'envoyer coûte moins de tokens et allège la requête ; trop réduire rend l'écriture
 * illisible. Mesurez avant de choisir (étape 6 du chapitre).
 */
export async function reduire(octets: Buffer, coteMax: number): Promise<[Buffer, "image/jpeg"]> {
  const sortie = await sharp(octets)
    .rotate() // remet la photo droite, d'après ses métadonnées EXIF
    .resize({ width: coteMax, height: coteMax, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return [sortie, "image/jpeg"];
}

/** Un bloc image en base64, prêt pour l'API. */
export async function blocImage(chemin: string, coteMax: number | null = null): Promise<Anthropic.ImageBlockParam> {
  let mediaType: TypeImage = typeImage(chemin);
  let octets: Buffer = readFileSync(chemin);
  if (coteMax) [octets, mediaType] = await reduire(octets, coteMax);
  const donnees = octets.toString("base64");
  if (donnees.length > IMAGE_BASE64_MAX) {
    throw new Error(`${basename(chemin)} : plus de 10 Mo une fois encodée ; réduisez-la (coteMax).`);
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data: donnees } };
}

/** Un bloc document PDF en base64. Claude lit le texte de chaque page et son image. */
export function blocPdf(chemin: string, titre: string | null = null, citations = false): Anthropic.DocumentBlockParam {
  if (extname(chemin).toLowerCase() !== ".pdf") throw new Error(`${basename(chemin)} : un PDF est attendu.`);
  const donnees = readFileSync(chemin).toString("base64");
  if (donnees.length > REQUETE_MAX) {
    throw new Error(`${basename(chemin)} : trop lourd pour une requête ; découpez-le ou passez par la Files API.`);
  }
  const bloc: Anthropic.DocumentBlockParam = { type: "document", source: { type: "base64", media_type: "application/pdf", data: donnees } };
  if (titre) bloc.title = titre;
  if (citations) bloc.citations = { enabled: true };
  return bloc;
}

/** Un bloc qui désigne un fichier déjà envoyé par la Files API (genre : document ou image). */
export function blocFichier(fileId: string, genre: "document" | "image" = "document", citations = false): Anthropic.ContentBlockParam {
  if (genre === "image") return { type: "image", source: { type: "file", file_id: fileId } };
  const bloc: Anthropic.DocumentBlockParam = { type: "document", source: { type: "file", file_id: fileId } };
  if (citations) bloc.citations = { enabled: true };
  return bloc;
}

/** Image ou PDF, selon l'extension du fichier. */
export async function blocDocument(chemin: string, coteMax: number | null = null): Promise<Anthropic.ContentBlockParam> {
  return extname(chemin).toLowerCase() === ".pdf" ? blocPdf(chemin) : blocImage(chemin, coteMax);
}
