import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import type { ConsistencyChapter } from "../../book-pipeline/consistency";
import { singleLine } from "../../book-pipeline/text";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  arrayOf,
  exactKeys,
  fail,
  languageInstruction,
  overBudget,
  parseJson,
  recordOf,
  textOf,
  type BookStepBase
} from "./base";
import { runPlanStep } from "./run";
import template from "./consistency.md";

/** The whole book as the check reads it: every chapter with text, in reading order (already cut to the budget by `compactChapters`). */
export interface ConsistencyRequest extends BookStepBase {
  chapters: readonly ConsistencyChapter[];
}
/** One contradiction between chapter `a` and chapter `b` (1-based positions in the request, a < b). */
export interface RawInconsistency {
  a: number;
  b: number;
  claimA: string;
  claimB: string;
  suggestion: string;
}

export const CONSISTENCY_MAX_ISSUES = 20;
export const CONSISTENCY_CLAIM_CHARS = 160;
const KEYS = ["a", "b", "claimA", "claimB", "suggestion"] as const;

export const CONSISTENCY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          a: { type: "integer", minimum: 1 },
          b: { type: "integer", minimum: 1 },
          claimA: { type: "string", minLength: 1 },
          claimB: { type: "string", minLength: 1 },
          suggestion: { type: "string" }
        },
        required: [...KEYS]
      }
    }
  },
  required: ["issues"]
};

/**
 * Reads `issues` and nothing else. An entry naming a chapter the request does not have, the same chapter twice, or an empty claim
 * makes the reply a failure (retried); the order of `a` and `b` is normalized. At most {@link CONSISTENCY_MAX_ISSUES} are kept.
 */
export function parseConsistency(raw: string, chapters: number): RawInconsistency[] {
  const value = parseJson(raw);
  exactKeys(value, ["issues"]);
  return arrayOf(value.issues, "issues")
    .slice(0, CONSISTENCY_MAX_ISSUES)
    .map(entry => {
      const item = recordOf(entry, "issue");
      exactKeys(item, KEYS);
      const a = item.a;
      const b = item.b;
      const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= chapters;
      if (!valid(a) || !valid(b) || a === b) return fail("An issue names a chapter the book does not have");
      const claimA = singleLine(textOf(item.claimA, "claimA"), CONSISTENCY_CLAIM_CHARS);
      const claimB = singleLine(textOf(item.claimB, "claimB"), CONSISTENCY_CLAIM_CHARS);
      const suggestion = singleLine(
        typeof item.suggestion === "string" ? item.suggestion : "",
        CONSISTENCY_CLAIM_CHARS
      );
      return a < b ? { a, b, claimA, claimB, suggestion } : { a: b, b: a, claimA: claimB, claimB: claimA, suggestion };
    });
}

/** The whole-book consistency check: one text-only call over every chapter's text (no web, no tools). */
export const consistencyStep: StepDefinition<ConsistencyRequest, RawInconsistency[]> = {
  id: "book-pipeline.consistency",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.chapters[0]?.text ?? ""),
      chapters: JSON.stringify(
        request.chapters.map((chapter, at) => ({
          number: at + 1,
          title: singleLine(chapter.title, 200),
          text: chapter.text
        }))
      )
    }),
  schema: CONSISTENCY_SCHEMA,
  policy: (prompt, request) => {
    if (request.chapters.length < 2) fail("A consistency check needs two chapters");
    overBudget(prompt, CONSISTENCY_SCHEMA);
  },
  parse: (raw, request) => parseConsistency(raw, request.chapters.length)
};

export function runConsistency(
  aiCalls: AiCalls,
  request: ConsistencyRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<RawInconsistency[]> {
  return runPlanStep(aiCalls, consistencyStep, request, run);
}
