import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import type { RawAiEdit } from "../../book-pipeline/ai-fix";
import type { AiFixTarget } from "../../book-pipeline/ai-proof";
import { singleLine } from "../../book-pipeline/text";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { arrayOf, fail, languageInstruction, overBudget, parseJson, recordOf, type BookStepBase } from "./base";
import { runPlanStep } from "./run";
import template from "./ai-fix.md";

export const AI_FIX_MAX_EDITS = 40;

export interface AiFixChapter {
  number: number;
  title: string;
  text: string;
}
/**
 * What the author model is asked: the chapter text (several chapters for a whole-book fix) and the problems to repair. The text is the
 * proof body (no pictures), so a picture is never in what the model could rewrite. Nothing about the plan or the proofreader's model.
 */
export interface AiFixRequest extends BookStepBase {
  chapters: readonly AiFixChapter[];
  targets: readonly AiFixTarget[];
}

export const AI_FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          chapter: { type: "integer", minimum: 1 },
          quote: { type: "string" },
          replacement: { type: "string" }
        },
        required: ["id", "chapter", "quote", "replacement"]
      }
    }
  },
  required: ["edits"]
};

/** Reads `edits` and nothing else, coerced and capped; whether an edit may be applied is `applyAiEdits`' decision. */
export function parseAiFix(raw: string): RawAiEdit[] {
  const value = parseJson(raw);
  return arrayOf(value.edits, "edits")
    .slice(0, AI_FIX_MAX_EDITS)
    .map((entry): RawAiEdit => {
      const item = recordOf(entry, "edit");
      const chapter = item.chapter;
      return {
        id: typeof item.id === "string" ? item.id.trim() : "",
        ...(typeof chapter === "number" && Number.isInteger(chapter) ? { chapter } : {}),
        quote: typeof item.quote === "string" ? item.quote.trim() : "",
        replacement: typeof item.replacement === "string" ? item.replacement.trim() : ""
      };
    });
}

/** The in-place fix by the author model: one text-only call, no web. */
export const aiFixStep: StepDefinition<AiFixRequest, RawAiEdit[]> = {
  id: "book-pipeline.ai-fix",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.chapters[0]?.text ?? ""),
      problems: JSON.stringify(
        request.targets.map(target => ({
          id: target.id,
          chapter: target.chapter ?? 1,
          quote: target.quote,
          problem: singleLine(target.problem, 300),
          suggestion: singleLine(target.suggestion, 300)
        }))
      ),
      chapters: JSON.stringify(
        request.chapters.map(chapter => ({
          number: chapter.number,
          title: singleLine(chapter.title, 200),
          text: chapter.text
        }))
      )
    }),
  schema: AI_FIX_SCHEMA,
  policy: (prompt, request) => {
    if (!request.targets.length) fail("A fix needs a problem to repair");
    if (!request.chapters.some(chapter => chapter.text.trim())) fail("A fix needs the chapter text");
    overBudget(prompt, AI_FIX_SCHEMA);
  },
  parse: raw => parseAiFix(raw)
};

export function runAiFix(
  aiCalls: AiCalls,
  request: AiFixRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<RawAiEdit[]> {
  return runPlanStep(aiCalls, aiFixStep, request, run);
}
