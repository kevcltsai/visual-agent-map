/**
 * An object schema marked with this keyword lets the reply carry fields it does not name, for a provider that checks the schema
 * itself and fails the whole call on one extra field (the Claude CLI's StructuredOutput retries, then gives up). Only for an object
 * whose parser reads its named fields and ignores the rest: every named field keeps its rule, and nothing else is used.
 */
export const IGNORE_EXTRA_FIELDS = "x-vam-ignore-extra-fields";

/** The schema with the keyword removed; with `open`, each marked object also drops its `additionalProperties: false`. */
export function outputSchemaFor(schema: unknown, open: boolean): unknown {
  if (Array.isArray(schema)) return schema.map(item => outputSchemaFor(item, open));
  if (!schema || typeof schema !== "object") return schema;
  const body = schema as Record<string, unknown>;
  const marked = body[IGNORE_EXTRA_FIELDS] === true;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === IGNORE_EXTRA_FIELDS || (open && marked && key === "additionalProperties")) continue;
    out[key] = outputSchemaFor(value, open);
  }
  return out;
}
