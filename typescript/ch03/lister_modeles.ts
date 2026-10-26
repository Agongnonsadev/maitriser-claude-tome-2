// Chapitre 3 : lister les modèles disponibles pour votre clé, avec leurs limites et leur date de retrait.
//
// L'API Models ne génère aucun texte : elle ne consomme pas de tokens.
// Lancement, depuis le dossier typescript/ :  npx tsx ch03/lister_modeles.ts

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const milliers = (n: number | null): string => (n ? n.toLocaleString("en-US") : "?");

for await (const modele of client.models.list()) {
  const retrait = modele.retires_at ? modele.retires_at.slice(0, 10) : "non annoncé";
  console.log(
    `${modele.id.padEnd(28)} ${modele.lifecycle.padEnd(11)} contexte ${milliers(modele.max_input_tokens).padStart(9)} · ` +
      `sortie ${milliers(modele.max_tokens).padStart(7)} · retrait : ${retrait}`,
  );
}
