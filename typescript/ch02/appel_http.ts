// Chapitre 2 : un appel à Claude en HTTP brut, sans SDK, avec le seul fetch de Node.
//
// Lancement, depuis le dossier typescript/ :  npx tsx ch02/appel_http.ts

const corpsRequete = {
  model: "claude-sonnet-5-5",
  max_tokens: 1000,
  messages: [{ role: "user", content: "Bonjour ! Présente-toi en une phrase." }],
};

const cle = process.env.ANTHROPIC_API_KEY; // lue dans l'environnement, jamais écrite ici
if (!cle) throw new Error("La variable d'environnement ANTHROPIC_API_KEY n'est pas définie.");

const reponse = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": cle,
    "anthropic-version": "2026-10-21", // la version de l'API depuis le 21 octobre 2026 (chapitre 21)
    "content-type": "application/json",
  },
  body: JSON.stringify(corpsRequete),
  signal: AbortSignal.timeout(60_000),
});

const identifiant = reponse.headers.get("request-id");
const corps = (await reponse.json()) as {
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage: Record<string, unknown>;
};
if (!reponse.ok) throw new Error(`Erreur ${reponse.status} (requête ${identifiant}) : ${JSON.stringify(corps)}`);

// La réponse est une liste de blocs : on ne garde que les blocs de texte.
const texte = corps.content.map((bloc) => (bloc.type === "text" ? bloc.text : "")).join("");

console.log(texte);
console.log("Identifiant de la requête :", identifiant);
console.log("Raison de l'arrêt :", corps.stop_reason);
console.log("Consommation :", corps.usage);
