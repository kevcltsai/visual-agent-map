import type { ReasoningLevel } from "../../../ai/types";
import type { ContentLanguage } from "../../../i18n";
import { estimateTokens } from "../../../ai/context-builder";
import { languageInstruction } from "../argument-map/shared";

/** Fields every picture-book step request carries. `usageMapPath` is trusted and never rendered. */
export interface BookStepBase {
  usageMapPath?: string;
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}

/** A refused request or reply. The message is a fixed phrase, never owner text, so it is safe to log. */
export class BookStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookStepError";
  }
}
/** By name, so it holds across module copies (a bundle of its own carries its own class). */
export const isBookStepError = (error: unknown): boolean =>
  !!error && typeof error === "object" && (error as { name?: unknown }).name === "BookStepError";
export const fail = (message: string): never => {
  throw new BookStepError(message);
};

export const BOOK_STEP_TOKEN_BUDGET = 32_000;
export function overBudget(prompt: string, schema: unknown): void {
  if (estimateTokens(prompt + JSON.stringify(schema)) > BOOK_STEP_TOKEN_BUDGET)
    fail("Book step request is over budget");
}
export { languageInstruction };

export type Rec = Record<string, unknown>;
export function parseJson(raw: string): Rec {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("The reply is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("The reply is not an object");
  return value as Rec;
}
/** Exactly these keys, no more and no fewer. */
export function exactKeys(value: Rec, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !actual.includes(key))) fail("The reply has unexpected fields");
}
export function arrayOf(value: unknown, what: string): unknown[] {
  return Array.isArray(value) ? value : fail(`${what} must be an array`);
}
export function recordOf(value: unknown, what: string): Rec {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : fail(`${what} must be an object`);
}
export function textOf(value: unknown, what: string): string {
  return typeof value === "string" && value.trim() ? value : fail(`${what} must be a non-empty string`);
}
