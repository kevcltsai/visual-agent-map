import { createHash } from "node:crypto";
import type { TranslationKey } from "../../i18n";
import type { LivingValidity } from "./living-node-execution";

const REASON_KEYS: Record<string, TranslationKey> = {
  "source-replaced": "ui.living_node_source_replaced",
  "map-file-source": "ui.living_node_reason_map_file",
  "upstream-trial": "ui.living_node_upstream_trial",
  "missing-source": "ui.living_node_reason_missing_source",
  "dependency-blocked": "ui.living_node_reason_dependency",
  cycle: "ui.living_node_reason_cycle",
  "range-too-large": "ui.living_node_reason_range_too_large",
  failed: "ui.living_node_reason_failed",
  "provider-failed": "ui.living_node_trial_reason_provider",
  timeout: "ui.living_node_trial_reason_timeout",
  "web-required": "ui.living_node_trial_reason_web",
  "source-changed": "ui.living_node_trial_reason_replaced",
  "markers-damaged": "ui.living_node_reason_markers_damaged",
  "validation-rejected": "ui.living_node_trial_reason_validation"
};

/** A bare error code such as "required-web-unavailable"; anything longer or free-form may carry private text. */
const CODE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * The short code stored with a failed card. Never raw error text, which can carry prompt text or paths: only the
 * class of the failure survives, and an unrecognised internal code is the generic "failed".
 */
export function livingFailureCode(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  const code = CODE.test(message) ? message : "";
  if (/required-web|forbidden-web|web-check|missing-search-decision/.test(code)) return "web-required";
  if (/too-large|^living-section-ambiguous/.test(code)) return "range-too-large";
  if (/^(stale-base|changed-knowledge|stale-or-cancelled-write|changed-[a-z-]+)$/.test(code)) return "source-changed";
  if (/^(ambiguous-living-node-region|invalid-generation|invalid-receipts|unknown-ownership)$/.test(code))
    return "markers-damaged";
  if (code === "map-file-source") return code;
  if (/^(unauthorized-source|missing-source|invalid-source)$/.test(code)) return "missing-source";
  if (/^(cancelled|living-node-busy.*|missing-or-locked-target|missing-target|locked-target|empty-prompt)$/.test(code))
    return "failed";
  if (code) return "validation-rejected";
  if ((error as { name?: unknown } | null)?.name === "SyntaxError" || /JSON/i.test(message))
    return "validation-rejected";
  if (/time.?out|timed out/i.test(message)) return "timeout";
  return "provider-failed";
}

/** The short line a card shows for an unfinished state; it comes from the note, so it survives a reopen. */
export function livingReasonKey(
  living: { damaged: boolean; outcome: string; reason?: string } | undefined
): TranslationKey | undefined {
  if (!living) return undefined;
  if (living.damaged) return "ui.living_node_reason_markers_damaged";
  if ((living.outcome === "failed" || living.outcome === "blocked") && living.reason)
    return REASON_KEYS[living.reason] ?? "ui.living_node_reason_failed";
  return undefined;
}

export interface LivingRead {
  id: string;
  revision: string;
  scope: string;
}

export interface LivingInput {
  configRevision: string;
  model: string;
  language: string;
  reads: readonly LivingRead[];
}

export interface LivingSuccess {
  inputRevision: string;
  knowledgeRevision: string;
}

export interface LivingDiagnostics {
  latestOutcome: "never" | "ok" | "failed" | "blocked" | "cancelled";
  lastAttempt?: string;
  lastSuccessfulCheck?: string;
  lastContentChange?: string;
  lastSuccessfulInput?: LivingSuccess;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Configuration identity is independent of display order and execution times. */
export function livingConfigRevision(prompt: string, sourceIds: readonly string[]): string {
  return digest(JSON.stringify([prompt.trim(), canonical(sourceIds)]));
}

/** The caller supplies only formal knowledge and semantic evidence, not diagnostics or UI metadata. */
export function livingKnowledgeRevision(content: string, evidence: readonly string[]): string {
  return digest(JSON.stringify([content.replace(/\r\n/g, "\n"), canonical(evidence)]));
}

export function livingInputRevision(input: LivingInput): string {
  const reads = canonical(input.reads.map(read => JSON.stringify([read.id, read.revision, read.scope])));
  return digest(JSON.stringify([input.configRevision, input.model, input.language, reads]));
}

/** A failed latest attempt is independent of the validity of its last successful output. */
export function livingValidity(
  success: LivingSuccess | undefined,
  input: LivingInput,
  knowledgeRevision: string,
  upstreamPending: boolean
): LivingValidity {
  if (!success) return "none";
  if (
    upstreamPending ||
    success.inputRevision !== livingInputRevision(input) ||
    success.knowledgeRevision !== knowledgeRevision
  )
    return "stale";
  return "valid";
}

export function livingAttempt(
  previous: LivingDiagnostics,
  at: string,
  outcome: "failed" | "blocked" | "cancelled"
): LivingDiagnostics {
  return { ...previous, latestOutcome: outcome, lastAttempt: at };
}

/** A successful no-change check updates diagnostics only; it does not advance content time. */
export function livingSuccess(
  previous: LivingDiagnostics,
  at: string,
  input: LivingInput,
  knowledgeRevision: string
): LivingDiagnostics {
  const changed = previous.lastSuccessfulInput?.knowledgeRevision !== knowledgeRevision;
  return {
    ...previous,
    latestOutcome: "ok",
    lastAttempt: at,
    lastSuccessfulCheck: at,
    ...(changed ? { lastContentChange: at } : {}),
    lastSuccessfulInput: { inputRevision: livingInputRevision(input), knowledgeRevision }
  };
}

export interface LivingCandidateIdentity {
  executionId: string;
  cardId: string;
  mapId: string;
  baseRevision: string;
  inputRevision: string;
  viewSession: string;
}

export interface LivingCommitCheck extends LivingCandidateIdentity {
  locked: boolean;
  aborted: boolean;
  dependenciesReady: boolean;
  alreadyCommitted: boolean;
}

/** Compare at the write boundary, not only before the AI call. The storage port must serialize this with the write. */
export function canCommitLivingCandidate(candidate: LivingCandidateIdentity, current: LivingCommitCheck): boolean {
  return (
    !!candidate.executionId &&
    !!candidate.cardId &&
    !!candidate.mapId &&
    !!candidate.baseRevision &&
    !!candidate.inputRevision &&
    !!candidate.viewSession &&
    !current.locked &&
    !current.aborted &&
    current.dependenciesReady &&
    !current.alreadyCommitted &&
    candidate.executionId === current.executionId &&
    candidate.cardId === current.cardId &&
    candidate.mapId === current.mapId &&
    candidate.baseRevision === current.baseRevision &&
    candidate.inputRevision === current.inputRevision &&
    candidate.viewSession === current.viewSession
  );
}
