import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { openedUrlsFromEvents } from "../../argument-map/source-proof";
import type { ChecklistItem } from "../../book-pipeline/plan-text";
import {
  evaluateProof,
  isProofFailure,
  ProofFailure,
  PROOF_STATUSES,
  type ProofResult,
  type ProofStatus,
  type RawProofItem
} from "../../book-pipeline/proof";
import { singleLine } from "../../book-pipeline/text";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { BookStepError, isBookStepError, languageInstruction, overBudget, type BookStepBase } from "./base";
import template from "./proofread.md";

export const PROOF_SEARCH_BUDGET = 4;
export const PROOF_TIMEOUT_MS = 4 * 60 * 1000;

/** Everything the proofreader sees: the chapter text and its checklist. No title, no neighbours, no plan. */
export interface ProofreadRequest extends BookStepBase {
  body: string;
  checklist: readonly ChecklistItem[];
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

/** What a proofread's exchange-log entry says when it fails: a code, never text. */
export const proofFailMessage = (error: unknown): string =>
  isProofFailure(error) ? error.code : isBookStepError(error) ? "invalid_step" : "failed";

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
    raw => evaluateProof(prepared.parse(raw), request.checklist, openedUrlsFromEvents(events), { body: request.body })
  );
}
