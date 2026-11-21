import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { openedUrlsFromEvents } from "../../argument-map/source-proof";
import {
  AI_PROOF_MAX_ITEMS,
  type AiProofSource,
  reviewAiProof,
  type AiPriorIssue,
  type AiProofReview,
  type RawAiCheck,
  type RawAiProof
} from "../../book-pipeline/ai-proof";
import { safeHref } from "../../book-pipeline/proof";
import { singleLine } from "../../book-pipeline/text";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { arrayOf, fail, languageInstruction, overBudget, parseJson, recordOf, type BookStepBase } from "./base";
import { planFailMessage, runPlanStep } from "./run";
import template from "./ai-proof.md";
import bookTemplate from "./ai-proof-book.md";

export const AI_PROOF_SEARCH_BUDGET = 4;
export const AI_PROOF_TIMEOUT_MS = 4 * 60 * 1000;
export const AI_PROOF_SOURCES_MAX = 20;

/**
 * What the independent proofreader sees: the chapter title, the prose without pictures (`aiProofBody`), the chapter's own source list and
 * the language; on a re-check also the problems left open. Never the plan, the checklist, the author's self-check, the settings or the
 * author model.
 */
export interface AiProofRequest extends BookStepBase {
  title: string;
  body: string;
  sources: readonly AiProofSource[];
  prior?: readonly AiPriorIssue[];
  maxItems?: number;
}

export const AI_PROOF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["fact", "number", "consistency", "citation"] },
          quote: { type: "string" },
          verdict: { type: "string", enum: ["ok", "problem", "unverifiable"] },
          problem: { type: "string" },
          fixable: { type: "boolean" },
          why: { type: "string" },
          suggestion: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        },
        required: ["id", "kind", "quote", "verdict", "problem", "fixable", "why", "suggestion", "sources"]
      }
    },
    prior: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, status: { type: "string", enum: ["resolved", "still"] } },
        required: ["id", "status"]
      }
    }
  },
  required: ["checks", "prior"]
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const chapterNo = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

/**
 * Reads `checks` (and `prior`) and nothing else; any other field is ignored. A reply that is not that shape is a failure (retried). Which
 * kinds, verdicts and quotes are acceptable is `reviewAiProof`'s decision, not this reader's. `chapter` and `otherChapter` are read for a
 * whole-book reply.
 */
export function parseAiProof(raw: string): RawAiProof {
  const value = parseJson(raw);
  const checks = arrayOf(value.checks, "checks").map((entry): RawAiCheck => {
    const item = recordOf(entry, "check");
    const chapter = chapterNo(item.chapter);
    const otherChapter = chapterNo(item.otherChapter);
    return {
      id: str(item.id).trim(),
      kind: str(item.kind).trim(),
      quote: str(item.quote),
      verdict: str(item.verdict).trim(),
      problem: str(item.problem),
      fixable: item.fixable === true,
      why: str(item.why).trim(),
      suggestion: str(item.suggestion),
      sources: Array.isArray(item.sources)
        ? item.sources.filter((source): source is string => typeof source === "string").slice(0, 8)
        : [],
      ...(chapter !== undefined ? { chapter } : {}),
      ...(otherChapter !== undefined ? { otherChapter } : {})
    };
  });
  const prior = (Array.isArray(value.prior) ? value.prior : []).flatMap(entry => {
    const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return [{ id: str(item.id).trim(), status: str(item.status).trim() }];
  });
  return { checks, prior };
}

/** The chapter's sources as the prompt lists them: https only (`safeHref`), no duplicates, one-line titles. */
export function listedSources(sources: readonly AiProofSource[]): AiProofSource[] {
  const out: AiProofSource[] = [];
  for (const source of sources) {
    const url = safeHref(source.url);
    if (url && !out.some(item => item.url === url)) out.push({ url, title: singleLine(source.title, 200) });
    if (out.length >= AI_PROOF_SOURCES_MAX) break;
  }
  return out;
}

const SOURCE_RULE =
  "You must search the web or open at least one of the sources listed below, and only those: a page that is not on the list is not evidence. When you cannot open a source, or it does not cover the claim, return the check as unverifiable with why source_unreachable.";
const NO_SOURCE_RULE =
  "This chapter lists no sources and you have no web access. Check only what the text itself shows: consistency between its own sentences and how specific its citations are. A fact or number you cannot check from the text alone is unverifiable (fixable false, why source_unreachable).";

/** The independent proofread of one chapter. */
export const aiProofStep: StepDefinition<AiProofRequest, RawAiProof> = {
  id: "book-pipeline.ai-proof",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.body),
      maxItems: String(request.maxItems ?? AI_PROOF_MAX_ITEMS),
      sourceRule: listedSources(request.sources).length ? SOURCE_RULE : NO_SOURCE_RULE,
      prior: JSON.stringify(
        (request.prior ?? []).map(item => ({ id: item.id, quote: item.quote, problem: item.problem }))
      ),
      title: JSON.stringify(singleLine(request.title, 200)),
      sources: JSON.stringify(listedSources(request.sources)),
      body: JSON.stringify(request.body)
    }),
  schema: AI_PROOF_SCHEMA,
  policy: (prompt, request) => {
    if (!request.body.trim()) fail("An AI proofread needs the chapter text");
    overBudget(prompt, AI_PROOF_SCHEMA);
  },
  parse: raw => parseAiProof(raw)
};

export interface AiProofRun {
  signal: AbortSignal;
  /** The pipeline's call budget, one reservation before every provider request. */
  admission?: AdmissionContext;
}

/**
 * One AI proofread call: web search only (search budget 4) when the chapter lists sources, text only (no search, so no SearchNotPerformed) when it lists none; the opened-page events of this call collected. A source on a check is kept only
 * when the chapter lists it and this call opened it. The exchange log never gets the chapter text or the reply (`noContentLog`).
 */
export async function runAiProof(aiCalls: AiCalls, request: AiProofRequest, run: AiProofRun): Promise<AiProofReview> {
  const events: unknown[] = [];
  const hasSources = listedSources(request.sources).length > 0;
  const prepared = prepareStep(aiProofStep, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: "Book pipeline AI proof",
      taskName: "book-pipeline-ai-proof",
      signal: run.signal,
      localCodex: false,
      noContentLog: true,
      failMessage: planFailMessage,
      usage: { action: "other", mapPath: request.usageMapPath },
      ...(run.admission ? { admission: run.admission } : {}),
      task: hasSources
        ? {
            webSearchOnly: true,
            searchBudget: AI_PROOF_SEARCH_BUDGET,
            timeoutMs: AI_PROOF_TIMEOUT_MS,
            onWebSearchEvent: event => {
              events.push(event);
            }
          }
        : { textOnly: true, searchBudget: 0, timeoutMs: AI_PROOF_TIMEOUT_MS }
    },
    raw =>
      reviewAiProof(prepared.parse(raw), {
        body: request.body,
        allowedSources: request.sources.map(source => source.url),
        openedUrls: openedUrlsFromEvents(events),
        ...(request.maxItems ? { maxItems: request.maxItems } : {})
      })
  );
}

/** One chapter as the whole-book proofread reads it: its title and the prose without pictures (`aiProofBody`). */
export interface AiBookChapter {
  title: string;
  text: string;
}
/**
 * What the whole-book proofreader sees: every chapter with text in reading order (cut to the budget by `compactChapters`) and the
 * program's own findings as one-line hints (a hint is a lead to check, never a verdict). No web, no plan, no earlier review.
 */
export interface AiBookProofRequest extends BookStepBase {
  chapters: readonly AiBookChapter[];
  hints?: readonly string[];
  prior?: readonly AiPriorIssue[];
  maxItems?: number;
}

export const AI_BOOK_HINTS_MAX = 40;
export const AI_BOOK_PROOF_SCHEMA = {
  ...AI_PROOF_SCHEMA,
  properties: {
    ...AI_PROOF_SCHEMA.properties,
    checks: {
      type: "array",
      items: {
        ...AI_PROOF_SCHEMA.properties.checks.items,
        properties: {
          ...AI_PROOF_SCHEMA.properties.checks.items.properties,
          chapter: { type: "integer", minimum: 1 },
          otherChapter: { type: "integer", minimum: 0 }
        },
        required: [...AI_PROOF_SCHEMA.properties.checks.items.required, "chapter", "otherChapter"]
      }
    }
  }
};

/** The whole-book proofread: one text-only call over the chapters (the book's contradictions and references; no web, no tools). */
export const aiBookProofStep: StepDefinition<AiBookProofRequest, RawAiProof> = {
  id: "book-pipeline.ai-proof-book",
  version: 1,
  render: request =>
    renderTemplate(bookTemplate, {
      languageInstruction: languageInstruction(request.language, request.chapters[0]?.text ?? ""),
      maxItems: String(request.maxItems ?? AI_PROOF_MAX_ITEMS),
      prior: JSON.stringify(
        (request.prior ?? []).map(item => ({ id: item.id, quote: item.quote, problem: item.problem }))
      ),
      hints: JSON.stringify((request.hints ?? []).slice(0, AI_BOOK_HINTS_MAX).map(hint => singleLine(hint, 400))),
      chapters: JSON.stringify(
        request.chapters.map((chapter, at) => ({
          number: at + 1,
          title: singleLine(chapter.title, 200),
          text: chapter.text
        }))
      )
    }),
  schema: AI_BOOK_PROOF_SCHEMA,
  policy: (prompt, request) => {
    if (!request.chapters.some(chapter => chapter.text.trim())) fail("A book proofread needs the text");
    overBudget(prompt, AI_BOOK_PROOF_SCHEMA);
  },
  parse: raw => parseAiProof(raw)
};

/** One whole-book proofread call (text only). Quotes are checked against the chapters as sent (`chapters`), by their 1-based position. */
export async function runAiBookProof(
  aiCalls: AiCalls,
  request: AiBookProofRequest,
  run: AiProofRun
): Promise<AiProofReview> {
  const raw = await runPlanStep(aiCalls, aiBookProofStep, request, { ...run, topic: "Book pipeline AI proof (whole book)" });
  return reviewAiProof(raw, {
    body: request.chapters.map(chapter => chapter.text),
    ...(request.maxItems ? { maxItems: request.maxItems } : {})
  });
}
