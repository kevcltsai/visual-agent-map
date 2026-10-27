/** Failure classes and final status of one seamless-research topic (pure). Nothing here ever reports success for a failure. */
import { isSearchNotPerformed } from "../../ai/search-not-performed";

export type FailureClass = "network" | "no-web-model" | "no-images" | "stopped" | "other";
export type SeamlessStatus = "idea" | "running" | "completed" | "error";
export type SeamlessAction = "retry" | "switch-model" | "dismiss";

const NETWORK_CODE = /\b(?:ENOTFOUND|ECONN[A-Z]*|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b/;
const NETWORK_MESSAGE = /fetch failed|network (?:error|request failed|is unreachable)|socket hang up|failed to fetch|getaddrinfo|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|unable to connect|connection (?:refused|reset|timed out)|offline/i;

function text(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as { message?: unknown; code?: unknown; cause?: unknown };
  const cause = record.cause && record.cause !== error ? text(record.cause) : "";
  return [typeof record.code === "string" ? record.code : "", typeof record.message === "string" ? record.message : "", cause].filter(Boolean).join(" ");
}

/**
 * Maps a thrown error to a failure class. A stop is "stopped"; no web retrieval (after the runner's single retry) and
 * network errors are "network"; anything else is "other" and is never shown as success either.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (typeof error === "object" && error !== null && ((error as { name?: unknown }).name === "AbortError")) return "stopped";
  if (isSearchNotPerformed(error)) return "network";
  const message = text(error);
  if (NETWORK_CODE.test(message) || NETWORK_MESSAGE.test(message)) return "network";
  return "other";
}

export interface OutcomeInput {
  failure?: FailureClass;
  stopped?: boolean;
  phase1Written: boolean;
  /** Phase 2 reached the note ("applied"), waits for the note to be closed ("held"), or has not produced a result ("none"). */
  phase2: "applied" | "held" | "none";
  imagesRequested: boolean;
  imagesSaved: number;
}

export interface Outcome {
  /** "restore" means the stop came before anything was written: put back the status the topic had before. */
  status: SeamlessStatus | "restore";
  reason?: FailureClass;
  /** The one button next to the one sentence; undefined when there is nothing to offer. */
  action?: SeamlessAction;
}

export function seamlessOutcome(input: OutcomeInput): Outcome {
  if (input.stopped || input.failure === "stopped") return input.phase1Written ? { status: "idea", reason: "stopped" } : { status: "restore", reason: "stopped" };
  if (input.failure === "network") return { status: "error", reason: "network", action: "retry" };
  if (input.failure === "no-web-model") return { status: "error", reason: "no-web-model", action: "switch-model" };
  if (input.failure === "no-images") return { status: "error", reason: "no-images", action: "dismiss" };
  if (input.failure) return { status: "error", reason: "other", action: "retry" };
  if (input.phase2 !== "applied") return { status: "running" };
  if (input.imagesRequested && input.imagesSaved <= 0) return { status: "error", reason: "no-images", action: "dismiss" };
  return { status: "completed" };
}
