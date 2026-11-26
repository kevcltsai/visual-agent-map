import type { LivingCoordinator, LivingLease } from "./living-node-coordinator";
import { applyLivingChanges, type LivingKnowledge } from "./living-node-changes";
import {
  commitLivingMarkdown,
  readLivingMarkdown,
  type LivingMarkdownCommit,
  type LivingMarkdownPort
} from "./living-node-markdown";
import type { LivingCommitCheck } from "./living-node-state";

export type LivingPreviewStatus = "none" | "running" | "ready" | "invalid" | "error";

type TrialSnapshot = Omit<LivingMarkdownCommit, "proposal" | "signal" | "isCurrent" | "inspect">;

export interface LivingTrialRequest extends TrialSnapshot {
  /** Reads only the authorized draft inputs. It may not write, dispatch dependencies or modify formal diagnostics. */
  generate(signal: AbortSignal): Promise<unknown>;
  /** Must check the draft read set, effective configuration and formal base after the provider settles. */
  stillCurrent(): Promise<boolean>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface LivingAdoptionCheck {
  /** Includes exact saved effective configuration and re-read formal source revisions. */
  inspect(): Promise<LivingCommitCheck>;
  isCurrent(): boolean;
}

/** One editor-scoped preview. The host invalidates it on draft/source changes and disposes it on close. */
export class LivingTrial {
  private status: LivingPreviewStatus = "none";
  private preview?: LivingKnowledge;
  private candidate?: { snapshot: TrialSnapshot; proposal: unknown };
  private lease?: LivingLease;
  private generation = 0;
  private closed = false;
  private adopting = false;
  private adoptionLease?: LivingLease;

  constructor(private readonly coordinator: LivingCoordinator) {}

  get state(): LivingPreviewStatus {
    return this.status;
  }

  get result(): LivingKnowledge | undefined {
    return this.preview ? clone(this.preview) : undefined;
  }

  invalidate(): void {
    this.generation++;
    this.candidate = undefined;
    this.lease?.stop();
    this.adoptionLease?.stop();
    if (this.status !== "none") this.status = "invalid";
  }

  close(): void {
    this.closed = true;
    this.invalidate();
    this.preview = undefined;
    this.status = "none";
  }

  async run(request: LivingTrialRequest): Promise<boolean> {
    if (this.closed || this.lease || this.adopting) return false;
    const identity = request.candidate;
    const lease = this.coordinator.acquire(identity.mapId, identity.viewSession, [request.path], false);
    if (!lease) return false;
    const generation = ++this.generation;
    this.lease = lease;
    this.candidate = undefined;
    this.status = "running";
    const current = (): boolean => lease.current() && !this.closed && this.generation === generation;
    try {
      const base = readLivingMarkdown(request.expectedContent);
      if (base.revision !== request.base.revision) throw new Error("stale-base");
      const snapshot: TrialSnapshot = clone({
        path: request.path,
        expectedContent: request.expectedContent,
        candidate: identity,
        base,
        context: request.context
      });
      const proposal = clone(await request.generate(lease.signal));
      if (!current()) return false;
      const next = applyLivingChanges(base, proposal, snapshot.context);
      if (base.revision === "empty" && !next.records.length && !next.output.text)
        throw new Error("missing-formal-result");
      if (!(await request.stillCurrent()) || !current()) {
        if (current()) this.status = "invalid";
        return false;
      }
      this.preview = { ...base, records: next.records, output: next.output };
      this.candidate = { snapshot, proposal };
      this.status = "ready";
      return true;
    } catch {
      if (current()) this.status = "error";
      return false;
    } finally {
      lease.release();
      this.lease = undefined;
      if (this.status === "running") this.status = "invalid";
    }
  }

  /** Never calls the provider. A failed or consumed candidate cannot be reused. */
  async adopt(port: LivingMarkdownPort, check: LivingAdoptionCheck): Promise<"written" | "discarded"> {
    const ready = this.candidate;
    if (this.closed || this.status !== "ready" || !ready || this.adopting) return "discarded";
    const { snapshot, proposal } = ready;
    const identity = snapshot.candidate;
    const lease = this.coordinator.acquire(identity.mapId, identity.viewSession, [snapshot.path], true);
    if (!lease) return "discarded";
    this.adopting = true;
    this.adoptionLease = lease;
    this.candidate = undefined;
    const generation = this.generation;
    const current = (): boolean =>
      lease.current() && !this.closed && this.generation === generation && check.isCurrent();
    try {
      const outcome = await commitLivingMarkdown(port, {
        ...snapshot,
        proposal,
        signal: lease.signal,
        inspect: check.inspect,
        isCurrent: current
      });
      if (!this.closed && this.generation === generation) {
        this.status = outcome === "written" ? "none" : "invalid";
        if (outcome === "written") this.preview = undefined;
      }
      return outcome;
    } catch {
      if (!this.closed && this.generation === generation) this.status = "error";
      return "discarded";
    } finally {
      lease.release();
      this.adoptionLease = undefined;
      this.adopting = false;
    }
  }
}
