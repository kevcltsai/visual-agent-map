/**
 * Argument map runner, methodology 6 (packet V5). Executes what `core/argument-map/machine-v2.ts` allows, one checkpoint (one `mutate`)
 * per step. The v1 runner (`argument-run.ts`) stays for legacy maps and is not changed; this file is written fresh beside it.
 *
 * Public API (stage 1: signatures only, bodies are filled in by the next commits):
 * - `frame(original, { note, attempt, signal })`: one AI call (`framingStep`) before any map exists. Writes nothing. A failure is thrown
 *   and counts as the caller's attempt (`MAX_FRAMING_CALLS`); the usage confirmation is the caller's (the start window), not the runner's.
 * - `start(path, locked)`: `locked` is `lockFraming(...)`'s output. Creates the cards and `newArgumentMap(...)` in ONE mutate (the framing is
 *   locked by construction: there is no operation that edits it afterwards), then runs to the end or a pause. Resolves when the run is over.
 *   A legacy, existing or unusable map is refused as a result, nothing is written.
 * - `resume(path)`, `stop(path)` (aborts and pauses, resumable), `isRunning(path)`, `recover(path)` (open-map recovery: a run left
 *   `running` by a reload is paused as `interrupted`; legacy or other maps are never written; no provider call), `dispose()`.
 */
import type { TranslationKey } from "../../i18n";
import type { ArgumentMapData, Framing } from "../../core/argument-map/model";
import { MAX_FRAMING_CALLS, WORST_CASE_AI_CALLS } from "../../core/argument-map/model";
import { lockedFraming, type FramingClaim, type FramingResult } from "../../core/steps/argument-map/runner";
import type { ArgumentRunPorts } from "./argument-run";

export { WORST_CASE_AI_CALLS, MAX_FRAMING_CALLS };
export type { ArgumentRunPorts as ArgumentRunV2Ports };
export type { TranslationKey };

/** Why a start, resume or frame call was refused. Nothing was written when one is returned. */
export type ArgumentRunV2Refusal =
  | "busy"
  | "unusable"
  | "legacy"
  | "exists"
  | "missing"
  | "finished"
  | "not_paused"
  | "disposed"
  | "framing_limit"
  | "not_locked";
export class ArgumentRunV2Error extends Error {
  constructor(readonly code: ArgumentRunV2Refusal) {
    super(`argument run refused: ${code}`);
    this.name = "ArgumentRunV2Error";
  }
}
/** The result of `start` and `resume`: the run ended (finished, paused or stopped) or the call was refused without writing anything. */
export type ArgumentRunOutcome = { ok: true } | { ok: false; refusal: ArgumentRunV2Refusal };

export interface FrameOptions {
  /** What the user said about the earlier restatement; empty on the first call. */
  note?: string;
  /** This call's number. Must be within `MAX_FRAMING_CALLS`, else the call is refused (`framing_limit`) and no provider call is made. */
  attempt: 1 | 2 | 3;
  /** The window's own signal: closing the window or Esc aborts; a late result is the caller's to drop. */
  signal: AbortSignal;
}

/** What the user confirmed: the locked framing plus the claim breakdown it came with (labels c1, c2; the runner assigns card ids). */
export interface LockedFraming {
  framing: Framing;
  claims: FramingClaim[];
}

/**
 * The locked framing of a confirmed `FramingResult` (the user may have changed `chosen`, answered the ambiguity questions in `settings`,
 * and edited `definitions` before this call; the result passed here already carries those edits). `now` stamps `lockedAt`.
 */
export function lockFraming(
  original: string,
  result: FramingResult,
  attempts: number,
  now: string,
  chosen: string = result.chosen
): LockedFraming {
  return {
    framing: lockedFraming(original, result, attempts, now, chosen),
    claims: result.claims.map(c => ({
      ...c,
      dependsOn: [...c.dependsOn],
      definitions: c.definitions.map(d => ({ ...d })),
      dataNeeds: [...c.dataNeeds]
    }))
  };
}

/** Read-only snapshot for a view or modal. */
export interface ArgumentRunV2Status {
  running: boolean;
}

/** The runner as the start window and the map view see it. */
export interface ArgumentRunV2Api {
  frame(original: string, options: FrameOptions): Promise<FramingResult>;
  start(path: string, locked: LockedFraming): Promise<ArgumentRunOutcome>;
  resume(path: string): Promise<ArgumentRunOutcome>;
  stop(path: string): Promise<void>;
  isRunning(path: string): boolean;
  recover(path: string): Promise<boolean>;
  dispose(): void;
}

export class ArgumentRunsV2 implements ArgumentRunV2Api {
  constructor(private readonly ports: ArgumentRunPorts) {}

  frame(_original: string, _options: FrameOptions): Promise<FramingResult> {
    throw new Error("TODO V5: frame");
  }
  start(_path: string, _locked: LockedFraming): Promise<ArgumentRunOutcome> {
    throw new Error("TODO V5: start");
  }
  resume(_path: string): Promise<ArgumentRunOutcome> {
    throw new Error("TODO V5: resume");
  }
  stop(_path: string): Promise<void> {
    throw new Error("TODO V5: stop");
  }
  isRunning(_path: string): boolean {
    throw new Error("TODO V5: isRunning");
  }
  recover(_path: string): Promise<boolean> {
    throw new Error("TODO V5: recover");
  }
  dispose(): void {
    void this.ports;
  }
}

export type { ArgumentMapData };
