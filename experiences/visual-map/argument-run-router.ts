/**
 * The one `plugin.argumentRuns` the map view talks to: it sends a call to the v1 runner (legacy maps, and `start(path, claim)`, which is the
 * v1 start window's call) or to the v2 runner (usable v2 maps), by what `readArgumentMap` says about the map. The v2 runner reports a
 * refusal as a result and throws `ArgumentRunV2Error`; here both become the v1 `ArgumentRunError` the view already handles
 * (`legacy` and anything v1 has no word for become `unusable`).
 */
import { readArgumentMap } from "../../core/argument-map/model";
import type { MapDocument } from "../../map-model";
import { ArgumentRunError, type ArgumentRunRefusal, type ArgumentRuns } from "./argument-run";
import { ArgumentRunV2Error, type ArgumentRunV2Refusal, type ArgumentRunsV2 } from "./argument-run-v2";

const V1_CODES: readonly ArgumentRunRefusal[] = [
  "busy",
  "unusable",
  "exists",
  "missing",
  "finished",
  "not_paused",
  "disposed"
];
/** A v2 refusal as the v1 error the view maps to a message. */
export function toV1Refusal(refusal: ArgumentRunV2Refusal): ArgumentRunError {
  const code = (V1_CODES as readonly string[]).includes(refusal) ? (refusal as ArgumentRunRefusal) : "unusable";
  return new ArgumentRunError(code);
}
function convert(error: unknown): unknown {
  return error instanceof ArgumentRunV2Error ? toV1Refusal(error.code) : error;
}

export class ArgumentRunRouter {
  constructor(
    private readonly v1: ArgumentRuns,
    private readonly v2: ArgumentRunsV2,
    private readonly readMap: (path: string) => Promise<MapDocument>
  ) {}

  isRunning(path: string): boolean {
    return this.v1.isRunning(path) || this.v2.isRunning(path);
  }

  /** The v1 start window's call; a v2 map is started through `ArgumentRunsV2.start` with a locked framing instead. */
  start(path: string, claim: string): Promise<void> {
    return this.v1.start(path, claim);
  }

  async resume(path: string): Promise<void> {
    if (this.v1.isRunning(path) || this.v2.isRunning(path)) throw new ArgumentRunError("busy");
    const kind = readArgumentMap(await this.readMap(path)).kind;
    if (kind !== "usable") return this.v1.resume(path); // legacy and the rest: v1 gives the refusal it always did
    try {
      const outcome = await this.v2.resume(path);
      if (!outcome.ok) throw toV1Refusal(outcome.refusal);
    } catch (error) {
      throw convert(error);
    }
  }

  async stop(path: string): Promise<void> {
    await Promise.all([this.v1.stop(path), this.v2.stop(path)]);
  }

  /** Open-map recovery of a v2 run a reload left running (v1 has none). */
  recover(path: string): Promise<boolean> {
    return this.v2.recover(path);
  }

  /** `recover` for a caller already inside `plugin.mutate` (open-map): never enqueues again. */
  recoverInMutation(path: string): Promise<boolean> {
    return this.v2.recoverInMutation(path);
  }

  dispose(): void {
    this.v1.dispose();
    this.v2.dispose();
  }
}
