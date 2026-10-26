// Les sorties structurées (chapitre 7) : un schéma Zod, traduit en schéma JSON que l'API impose à Claude.
//
// L'API n'accepte qu'une partie de JSON Schema. Comme transform_schema() du SDK Python, on garde ce
// qu'elle impose (types, enum, objets fermés, formats de texte connus) et on recopie le reste dans la
// description du champ (« {minimum: 1} ») : Claude le lit, et la validation Zod le vérifie ensuite.
//
// Le SDK TypeScript a son équivalent, zodOutputFormat(). Mais dans sa version 1.1.0, il ne garde pas
// enum : il le renvoie lui aussi dans la description, et l'API ne l'imposerait plus (constaté le
// 22 octobre 2026, à comparer au SDK Python 2.1.0). D'où cette traduction de la fonction Python.

import { z } from "zod";

type Schema = Record<string, unknown>;

const FORMATS_DE_TEXTE = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Les bornes que Zod ajoute à tout entier (les entiers « sûrs » de JavaScript) : rien à dire à Claude. */
const BORNES_DE_ZOD = new Set([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);

/** Traduction de transform_schema() du SDK Python : ce que l'API impose, et le reste en description. */
export function transformerSchema(schema: Schema): Schema {
  // Zod écrit un champ nullable { type: ["string", "null"] } ; Pydantic, et la documentation de l'API,
  // un anyOf. On le récrit en anyOf, la description restant sur le champ.
  if (Array.isArray(schema.type)) {
    const { type, description, title, ...propre } = schema;
    const variantes = (type as string[]).map((t) => (t === "null" ? { type: t } : { ...propre, type: t }));
    return transformerSchema({ anyOf: variantes, ...(description !== undefined && { description }), ...(title !== undefined && { title }) });
  }
  const reste: Schema = { ...schema };
  const strict: Schema = {};
  const prendre = (cle: string): unknown => {
    const valeur = reste[cle];
    delete reste[cle];
    return valeur;
  };
  delete reste.$schema; // l'en-tête que Zod ajoute ; Pydantic ne le met pas

  const defs = prendre("$defs") as Record<string, Schema> | undefined;
  if (defs) strict.$defs = Object.fromEntries(Object.entries(defs).map(([nom, d]) => [nom, transformerSchema(d)]));
  const ref = prendre("$ref");
  if (ref !== undefined) return { ...strict, $ref: ref };

  const type = prendre("type");
  const [anyOf, oneOf, allOf] = [prendre("anyOf"), prendre("oneOf"), prendre("allOf")];
  if (Array.isArray(anyOf)) strict.anyOf = anyOf.map(transformerSchema);
  else if (Array.isArray(oneOf)) strict.anyOf = oneOf.map(transformerSchema);
  else if (Array.isArray(allOf)) strict.allOf = allOf.map(transformerSchema);
  else if (type === undefined) throw new Error("Un schéma doit avoir un type, ou anyOf, oneOf, allOf.");
  else strict.type = type;

  const valeurs = prendre("enum");
  if (Array.isArray(valeurs)) strict.enum = valeurs;
  const description = prendre("description");
  if (description !== undefined) strict.description = description;
  const titre = prendre("title");
  if (titre !== undefined) strict.title = titre;

  if (type === "object") {
    const proprietes = (prendre("properties") ?? {}) as Record<string, Schema>;
    strict.properties = Object.fromEntries(Object.entries(proprietes).map(([cle, p]) => [cle, transformerSchema(p)]));
    prendre("additionalProperties");
    strict.additionalProperties = false;
    const requis = prendre("required");
    if (requis !== undefined) strict.required = requis;
  } else if (type === "string") {
    const format = prendre("format");
    if (typeof format === "string" && FORMATS_DE_TEXTE.has(format)) strict.format = format;
    else if (format !== undefined) reste.format = format;
  } else if (type === "array") {
    const elements = prendre("items") as Schema | undefined;
    if (elements !== undefined) strict.items = transformerSchema(elements);
    const minimum = prendre("minItems");
    if (minimum === 0 || minimum === 1) strict.minItems = minimum;
    else if (minimum !== undefined) reste.minItems = minimum;
  } else if (type === "integer" || type === "number") {
    for (const borne of ["minimum", "maximum"]) if (BORNES_DE_ZOD.has(reste[borne] as number)) delete reste[borne];
  }

  // Ce qui reste n'est pas imposé par l'API : dans la description, Claude a des chances de le suivre.
  if (Object.keys(reste).length) {
    const precedente = strict.description;
    strict.description =
      (precedente !== undefined ? `${precedente}\n\n` : "") +
      `{${Object.entries(reste).map(([cle, valeur]) => `${cle}: ${JSON.stringify(valeur)}`).join(", ")}}`;
  }
  return strict;
}

/** Le format d'une sortie structurée (output_config.format), à partir d'un schéma Zod. */
export function formatJson(schema: z.ZodType): { type: "json_schema"; schema: Schema } {
  return { type: "json_schema", schema: transformerSchema(z.toJSONSchema(schema) as Schema) };
}
