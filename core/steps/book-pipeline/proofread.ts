import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { openedUrlsFromEvents, searchEventCount } from "../../argument-map/source-proof";
import type { BookRole } from "../../book-pipeline/model";
import type { ChecklistItem } from "../../book-pipeline/plan-text";
import {
  evaluateProof,
  sourceDiagnostics,
  isProofFailure,
  ProofFailure,
  PROOF_STATUSES,
  type ProofCounts,
  type ProofResult,
  type ProofStatus,
  type RawProofItem
} from "../../book-pipeline/proof";
import { applyProseChecks } from "../../book-pipeline/prose-checks";
import { singleLine } from "../../book-pipeline/text";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { BookStepError, isBookStepError, languageInstruction, overBudget, type BookStepBase } from "./base";
import { providerFailMessage } from "./run";
import template from "./proofread.md";

export const PROOF_SEARCH_BUDGET = 4;
export const PROOF_TIMEOUT_MS = 4 * 60 * 1000;

/** Everything the proofreader sees: the chapter text, its checklist and the book's chapter list (titles and covers lines). No plan. */
export interface ProofreadRequest extends BookStepBase {
  body: string;
  checklist: readonly ChecklistItem[];
  /** The chapter's own title (absent: not shown). */
  title?: string;
  /** The chapter's role (an intro is checked for previewing later chapters too much); absent: not checked. */
  role?: BookRole;
  /** Every chapter in reading order: its title (the authoritative spelling of a person's name) and its covers line (may be empty). */
  chapters?: readonly ProofChapter[];
  /** The reader-visible callouts outside the chapter text (a `[!question]` box under the Sources): the research-voice check reads them. */
  readerNotes?: string;
}
export interface ProofChapter {
  title: string;
  covers: string;
}

export const PROOFREAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          status: { type: "string", enum: [...PROOF_STATUSES] },
          note: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        },
        required: ["id", "status", "note", "sources"]
      }
    }
  },
  required: ["results"]
};

/**
 * Reads the reply's `results` and nothing else: any other field (a rewritten chapter, a "summary", an instruction echoed
 * from a web page) is ignored, and the output type has no text field to carry it. A reply that is not that shape is a failure.
 */
export function parseProofread(raw: string): RawProofItem[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProofFailure("unparsable");
  }
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new ProofFailure("unparsable");
  return results.map(entry => {
    const one = entry as { id?: unknown; status?: unknown; note?: unknown; sources?: unknown } | null;
    if (!one || typeof one !== "object" || typeof one.id !== "string" || !one.id.trim())
      throw new ProofFailure("unparsable");
    if (!(PROOF_STATUSES as readonly unknown[]).includes(one.status)) throw new ProofFailure("unparsable");
    const sources = Array.isArray(one.sources)
      ? one.sources.filter((s): s is string => typeof s === "string").slice(0, 8)
      : [];
    return {
      id: one.id.trim(),
      status: one.status as ProofStatus,
      note: singleLine(one.note, 300),
      sources: sources.map(source => source.trim().slice(0, 500))
    };
  });
}

/** Judge a chapter against its checklist. Web search only; the reply is checked against the pages this call opened (`runProofread`). */
export const proofreadStep: StepDefinition<ProofreadRequest, RawProofItem[]> = {
  id: "book-pipeline.proofread",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.body),
      checklist: JSON.stringify(request.checklist.map(item => ({ id: item.id, type: item.type, text: item.text }))),
      title: JSON.stringify(request.title ?? ""),
      chapters: JSON.stringify(
        (request.chapters ?? []).map(chapter => ({ title: chapter.title, covers: chapter.covers }))
      ),
      body: JSON.stringify(request.body)
    }),
  schema: PROOFREAD_SCHEMA,
  policy: (prompt, request) => {
    if (!request.checklist.length) throw new ProofFailure("empty_list");
    if (!request.body.trim()) throw new BookStepError("A proofread needs the chapter text");
    overBudget(prompt, PROOFREAD_SCHEMA);
  },
  parse: raw => parseProofread(raw)
};

/** What a proofread's exchange-log entry says when it fails: a code, never chapter text (a provider failure adds its own message). */
export const proofFailMessage = (error: unknown): string =>
  isProofFailure(error) ? error.code : isBookStepError(error) ? "invalid_step" : providerFailMessage(error);

export interface ProofreadRun {
  signal: AbortSignal;
  /** The pipeline's call budget, one reservation before every provider request. */
  admission?: AdmissionContext;
}

/**
 * One proofread call: web search only (`localCodex: false`, search budget 4), the opened-page events of this call collected,
 * the verdict decided by `evaluateProof`. The exchange log never gets the chapter text or the reply (`noContentLog`).
 */
export async function runProofread(
  aiCalls: AiCalls,
  request: ProofreadRequest,
  run: ProofreadRun
): Promise<ProofResult> {
  const events: unknown[] = [];
  const prepared = prepareStep(proofreadStep, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: "Book pipeline proofread",
      taskName: "book-pipeline-proof",
      signal: run.signal,
      localCodex: false,
      noContentLog: true,
      failMessage: proofFailMessage,
      usage: { action: "other", mapPath: request.usageMapPath },
      ...(run.admission ? { admission: run.admission } : {}),
      task: {
        webSearchOnly: true,
        searchBudget: PROOF_SEARCH_BUDGET,
        timeoutMs: PROOF_TIMEOUT_MS,
        onWebSearchEvent: event => {
          events.push(event);
        }
      }
    },
    raw => {
      const opened = openedUrlsFromEvents(events);
      let counts: ProofCounts = { openedPages: opened.length, searches: searchEventCount(events) };
      try {
        const parsed = prepared.parse(raw);
        counts = { ...counts, sources: sourceDiagnostics(parsed, opened) };
        const judged = evaluateProof(parsed, request.checklist, opened, { body: request.body });
        // The program's own findings (research voice, a person name spelled unlike its chapter title) override the model's "met".
        const titles = (request.chapters ?? []).map(chapter => chapter.title);
        const context = {
          language: request.language,
          role: request.role,
          title: request.title,
          readerNotes: request.readerNotes
        };
        return { ...applyProseChecks(judged, request.body, titles, context), counts };
      } catch (error) {
        // The counts travel with a failure too: they are the only trace of what a no-content-log call did.
        if (isProofFailure(error))
          throw new ProofFailure(error.code, error.partial && { ...error.partial, counts }, counts);
        throw error;
      }
    }
  );
}
