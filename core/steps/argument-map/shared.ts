import { estimateTokens } from "../../../ai/context-builder";
import type { ContentLanguage } from "../../../i18n";
import type { ReasoningLevel } from "../../../ai/types";
import { inLanguageNaming } from "../_shared/fragments";
import { noteNumbers } from "../chart/insert";
import { linksOf } from "../task/merge-check";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";

/**
 * Shared parts of the six argument-map steps (situation plan, situation gate, hypotheses, evidence needs, verdict, conclusion). None of them
 * browses: each runs text-only with a search budget of 0 (see `runner.ts`), its request type holds exactly the fields the
 * prompt may show, and its parser refuses any id, number or URL the request did not contain.
 */
export const ARGUMENT_STEP_TOKEN_BUDGET = 32_000;

/** Fields every argument-map request carries. `usageMapPath` is trusted and never rendered. */
export interface ArgumentStepBase {
  usageMapPath?: string;
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}

export class ArgumentStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentStepError";
  }
}
const fail = (message: string): never => {
  throw new ArgumentStepError(message);
};

export function languageInstruction(language: ContentLanguage, anchorText: string): string {
  return inLanguageNaming({ zh: languageZh, en: languageEn }, language, { language: "region" }, "en", {
    kind: "question",
    text: anchorText
  });
}

export function overBudget(prompt: string, schema: unknown): void {
  if (estimateTokens(prompt + JSON.stringify(schema)) > ARGUMENT_STEP_TOKEN_BUDGET)
    throw new ArgumentStepError("The argument step request is over the token budget");
}

export type Rec = Record<string, unknown>;

/** The reply must be one JSON object with exactly these keys. */
export function parseObject(raw: string, keys: readonly string[]): Rec {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("The reply is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("The reply is not an object");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !actual.includes(key))) fail("The reply has unexpected fields");
  return value as Rec;
}

export function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) return fail(`${what} must be a non-empty string`);
  return value.trim();
}

export function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) return fail(`${what} must be an array`);
  return value;
}

/** A citation: a non-empty list of distinct ids that all appear in the request. Anything else throws. */
export function citation(value: unknown, allowed: ReadonlySet<string>, what: string): string[] {
  const ids = list(value, what);
  if (!ids.length) fail(`${what} must cite at least one id`);
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !allowed.has(id)) return fail(`${what} cites an id outside the request`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const normalNumber = (token: string): string => {
  const value = Number(token);
  return Number.isFinite(value) && token.length < 16 ? String(value) : token;
};

/**
 * No-memory check: every number and URL in the reply's free text must already be in the request's free text. Identifiers
 * are not passed in `sources`, so digits inside an id never count as a supplied quantity.
 */
export function grounded(replyTexts: string[], sources: string[]): void {
  const known = new Set<string>();
  for (const token of noteNumbers(sources.join("\n"))) known.add(normalNumber(token));
  for (const token of noteNumbers(replyTexts.join("\n")))
    if (!known.has(normalNumber(token))) fail(`The reply uses the number ${token}, which the request does not have`);
  const knownLinks = linksOf(sources);
  for (const [key, shown] of linksOf(replyTexts))
    if (!knownLinks.has(key)) fail(`The reply uses the link ${shown}, which the request does not have`);
}

export const normalized = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();

export const idSchema = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 };
