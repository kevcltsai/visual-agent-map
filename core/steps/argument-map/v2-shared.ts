import { linksOf } from "../task/merge-check";
import { ArgumentStepError, list, text, type Rec } from "./shared";

/**
 * Helpers of the five methodology-6 steps (framing, premise verdict, hypotheses, needs, assessment). They sit beside `shared.ts` and do
 * not change it: the V1 steps keep using `parseObject`, `citation` and `grounded` as they are.
 *
 * Contract common to all five: the reply is one JSON object with exactly the schema's keys (nested objects too); a field that does not
 * apply is an empty string, an empty array or `null`, never missing; every id the reply cites comes from the request; ids the program
 * will store (hypotheses, needs, predictions) are never invented by the model.
 */
export const fail = (message: string): never => {
  throw new ArgumentStepError(message);
};

/** Keys of one reply object, exactly. Missing and extra keys both throw. */
export function exact(value: unknown, keys: readonly string[], what: string): Rec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${what} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !actual.includes(key))) fail(`${what} has unexpected fields`);
  return value as Rec;
}

export function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") return fail(`${what} must be a boolean`);
  return value;
}

/** One reply sentence or phrase: non-empty and at most `MAX_REPLY_TEXT` characters (a runaway reply is refused, not stored). */
export const MAX_REPLY_TEXT = 600;
export function short(value: unknown, what: string): string {
  const out = text(value, what);
  if (out.length > MAX_REPLY_TEXT) return fail(`${what} is too long`);
  return out;
}

/** A string that may be empty (the "does not apply" form). */
export function maybeText(value: unknown, what: string): string {
  if (typeof value !== "string") return fail(`${what} must be a string`);
  if (value.trim().length > MAX_REPLY_TEXT) return fail(`${what} is too long`);
  return value.trim();
}

export function pick<T extends string>(values: readonly T[], value: unknown, what: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value))
    return fail(`${what} is not allowed`);
  return value as T;
}

/** An array of non-empty strings, `min` to `max` long (empty allowed when `min` is 0). */
export function strings(value: unknown, what: string, min: number, max: number): string[] {
  const items = list(value, what);
  if (items.length < min || items.length > max) return fail(`${what} must have ${min} to ${max} items`);
  return items.map(item => short(item, what));
}

/** A reply id that must come from the request, exactly once. */
export function fromRequest(value: unknown, allowed: ReadonlySet<string>, what: string): string {
  if (typeof value !== "string" || !allowed.has(value)) return fail(`${what} is outside the request`);
  return value;
}

/** Ids of a list that must all be in the request and distinct. May be empty. */
export function idsFrom(value: unknown, allowed: ReadonlySet<string>, what: string): string[] {
  const ids = list(value, what).map(id => fromRequest(id, allowed, what));
  if (new Set(ids).size !== ids.length) return fail(`${what} repeats an id`);
  return ids;
}

/** Texts the user confirms as settings or definitions may carry numbers, never links. */
export function noLinks(texts: string[]): void {
  const found = linksOf(texts);
  if (found.size) fail(`The reply uses the link ${[...found.values()][0]}, which the request does not have`);
}

/** Local labels the model chooses inside one reply (candidates, claims). The program renames them before they reach a map. */
export const LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
export function label(value: unknown, what: string): string {
  if (typeof value !== "string" || !LABEL.test(value)) return fail(`${what} must be a short label`);
  return value;
}

// ---- JSON schema builders (every property required, nothing extra: the strict form every provider accepts) ----
export const S = {
  str: { type: "string", minLength: 1 },
  free: { type: "string" },
  bool: { type: "boolean" },
  arr: (items: unknown, min = 0, max?: number): Record<string, unknown> => ({
    type: "array",
    items,
    minItems: min,
    ...(max === undefined ? {} : { maxItems: max })
  }),
  enum: (values: readonly string[]): Record<string, unknown> => ({ type: "string", enum: [...values] }),
  obj: (properties: Record<string, unknown>): Record<string, unknown> => ({
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties)
  })
};
