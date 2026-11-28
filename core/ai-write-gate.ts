/**
 * The one check every AI write-back runs at commit time (research, integrate and selection write-back, the chat writer,
 * the guarded note write of an AI writer, a structure suggestion's apply). Pure: the caller reads the facts (from the
 * bytes being replaced where it can) and maps each code to its own wording. Only AI-specific checks live here; structure
 * rules stay with `canParent` / `mergeEligibility`, and a manual edit never calls this gate.
 */
export type AiWriteGateCode =
  /** The run that asked for the write no longer owns it: stopped, timed out, replaced, or its view or map went away. */
  | "owner_changed"
  /** The target carries `ai-locked` now (read at commit, not when the run started). */
  | "ai_locked"
  /** The target is read-only for this writer (a Living Node card for an unintegrated AI writer). */
  | "read_only"
  /** The target's identity (map id, topic id) is not the one the run read: another note now sits at that path. */
  | "identity_changed"
  /** The target's content is not the version the run read: it changed externally meanwhile. */
  | "stale";

/** Every code, in the order `aiWriteGate` lists them. */
export const AI_WRITE_GATE_CODES: readonly AiWriteGateCode[] = [
  "owner_changed",
  "ai_locked",
  "read_only",
  "identity_changed",
  "stale"
];

/** A stamp of the target as the run read it and as it is at commit; any text both sides compute the same way. */
export interface AiWriteStamp {
  read: string;
  now: string;
}

export interface AiWriteGateInput {
  owned: boolean;
  aiLocked?: boolean;
  readOnly?: boolean;
  /** Compared only when given. */
  identity?: AiWriteStamp;
  /** Compared only when given. */
  version?: AiWriteStamp;
}

/** Every reason the write may not happen, in `AI_WRITE_GATE_CODES` order; empty means the write may go ahead. */
export function aiWriteGate(input: AiWriteGateInput): AiWriteGateCode[] {
  const blocked: AiWriteGateCode[] = [];
  if (!input.owned) blocked.push("owner_changed");
  if (input.aiLocked === true) blocked.push("ai_locked");
  if (input.readOnly === true) blocked.push("read_only");
  if (input.identity && input.identity.read !== input.identity.now) blocked.push("identity_changed");
  if (input.version && input.version.read !== input.version.now) blocked.push("stale");
  return blocked;
}
