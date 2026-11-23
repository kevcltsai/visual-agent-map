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
  if (!open) strictRequired(out);
  return out;
}

/**
 * Strict output (Codex) rejects an object whose `required` leaves out one of its properties (400 invalid_json_schema). Each optional
 * property becomes required and nullable instead, so the model sends null where it has nothing; the parsers already read null as absent.
 */
function strictRequired(out: Record<string, unknown>): void {
  const properties = out.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  const required = Array.isArray(out.required) ? (out.required as string[]) : [];
  const missing = Object.keys(properties).filter(key => !required.includes(key));
  if (!missing.length) return;
  const props = { ...(properties as Record<string, unknown>) };
  for (const key of missing) props[key] = nullable(props[key]);
  out.properties = props;
  out.required = [...required, ...missing];
}

function nullable(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const body = schema as Record<string, unknown>;
  if (typeof body.type === "string") return { ...body, type: [body.type, "null"] };
  if (Array.isArray(body.type)) {
    const types = body.type as unknown[];
    return types.includes("null") ? body : { ...body, type: [...types, "null"] };
  }
  return { anyOf: [body, { type: "null" }] };
}
