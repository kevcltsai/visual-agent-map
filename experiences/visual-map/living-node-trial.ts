import type { LivingCoordinator, LivingLease } from "./living-node-coordinator";
import {
  applyLivingChanges,
  summarizeLivingChanges,
  type LivingChangeContext,
  type LivingChangeSummary,
  type LivingKnowledge
} from "./living-node-changes";
import {
  commitLivingMarkdown,
  livingGeneration,
  readLivingMarkdown,
  livingSnapshotRevision,
  type LivingMarkdownCommit,
  type LivingMarkdownPort
} from "./living-node-markdown";
import type { LivingCommitCheck } from "./living-node-state";

export type LivingPreviewStatus = "none" | "running" | "ready" | "invalid" | "error";

type TrialSnapshot = Omit<LivingMarkdownCommit, "proposal" | "signal" | "isCurrent" | "inspect" | "onCommit">;
type TrialRequestSnapshot = Omit<TrialSnapshot, "baseGeneration">;

export interface LivingTrialRequest extends TrialRequestSnapshot {
  /** Reads only the authorized draft inputs. It may not write, dispatch dependencies or modify formal diagnostics. */
  generate(signal: AbortSignal): Promise<unknown>;
  /** Must check the draft read set, effective configuration and formal base after the provider settles. */
  stillCurrent(): Promise<boolean>;
  /** Exact bytes predicted by the trusted configuration-only save command for this draft. */
  savedContent?: string;
  /** The provider returns its proposal together with the runtime-verified evidence catalog. */
  generatedEvidence?: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface LivingAdoptionCheck {
  /** Includes exact saved effective configuration and re-read formal source revisions. */
  inspect(): Promise<LivingCommitCheck>;
  /** Re-read the target after the optional explicit save. No mutation is allowed here. */
  readSavedContent?(): Promise<string>;
  isCurrent(): boolean;
  onCommit?(path: string, before: string, after: string): void;
}

/** One editor-scoped preview. The host invalidates it on draft/source changes and disposes it on close. */
export class LivingTrial {
  private status: LivingPreviewStatus = "none";
  private preview?: LivingKnowledge;
  private summary?: LivingChangeSummary;
  private candidate?: { snapshot: TrialSnapshot; proposal: unknown; savedContent?: string };
  private lease?: LivingLease;
  private generation = 0;
  private closed = false;
  private adopting = false;
  private adoptionLease?: LivingLease;
  /** The error code of the last failed run, for the setup window's reason line. */
  failureCode?: string;
  /** The failed run's error identity (name + message), so the reason can tell a "did not search" error from a provider one. */
  failure?: { name: string; message: string };

  constructor(private readonly coordinator: LivingCoordinator) {}

  get state(): LivingPreviewStatus {
    return this.status;
  }

  get result(): LivingKnowledge | undefined {
    return this.preview ? clone(this.preview) : undefined;
  }

  /** What this preview would change against the formal knowledge it was run on. */
  get changes(): LivingChangeSummary | undefined {
    return this.summary ? clone(this.summary) : undefined;
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
    this.summary = undefined;
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
    this.failureCode = undefined;
    this.failure = undefined;
    this.status = "running";
    const current = (): boolean => lease.current() && !this.closed && this.generation === generation;
    try {
      const base = readLivingMarkdown(request.expectedContent);
      if (identity.baseRevision !== livingSnapshotRevision(request.expectedContent)) throw new Error("stale-base");
      const savedContent = request.savedContent;
      if (savedContent !== undefined && readLivingMarkdown(savedContent).revision !== base.revision)
        throw new Error("changed-knowledge");
      if (base.revision !== request.base.revision) throw new Error("stale-base");
      let snapshot: TrialSnapshot = clone({
        path: request.path,
        expectedContent: request.expectedContent,
        candidate: identity,
        base,
        baseGeneration: livingGeneration(request.expectedContent),
        context: request.context
      });
      let proposal = clone(await request.generate(lease.signal));
      if (request.generatedEvidence) {
        const result = proposal as { proposal: unknown; context: LivingChangeContext };
        snapshot = { ...snapshot, context: result.context };
        proposal = result.proposal;
      }
      if (!current()) return false;
      const next = applyLivingChanges(base, proposal, snapshot.context);
      if (base.revision === "empty" && !next.records.length && !next.output.text)
        throw new Error("missing-formal-result");
      if (!(await request.stillCurrent()) || !current()) {
        if (current()) {
          this.status = "invalid";
          this.failureCode = "source-changed";
        }
        return false;
      }
      this.preview = {
        ...base,
        records: next.records,
        output: next.output,
        ...(next.aiLatest ? { aiLatest: next.aiLatest } : {})
      };
      this.summary = summarizeLivingChanges(base, next);
      this.candidate = { snapshot, proposal, savedContent };
      this.status = "ready";
      return true;
    } catch (error) {
      if (current()) {
        this.status = "error";
        this.failureCode = error instanceof Error ? error.message : String(error);
        this.failure = { name: error instanceof Error ? error.name : "", message: this.failureCode };
      }
      return false;
    } finally {
      lease.release();
      this.lease = undefined;
      if (this.status === "running") this.status = "invalid";
    }
  }

  /** Called only with the exact bytes returned by the shared guarded configuration save. */
  acceptSave(before: string, after: string): void {
    const ready = this.candidate;
    if (!ready || this.status !== "ready") return;
    if (
      before !== ready.snapshot.expectedContent ||
      readLivingMarkdown(after).revision !== ready.snapshot.base.revision
    ) {
      this.invalidate();
      return;
    }
    ready.savedContent = after;
  }

  /** A ready preview still stands on these target bytes: the ones it read, or the ones of an accepted save. */
  matchesTarget(content: string): boolean {
    const ready = this.candidate;
    return (
      this.status === "ready" &&
      !!ready &&
      !this.adopting &&
      (content === ready.snapshot.expectedContent || content === ready.savedContent)
    );
  }

  /** Never calls the provider. A failed or consumed candidate cannot be reused. */
  async adopt(port: LivingMarkdownPort, check: LivingAdoptionCheck): Promise<"written" | "discarded"> {
    const ready = this.candidate;
    if (this.closed || this.status !== "ready" || !ready || this.adopting) return "discarded";
    const { snapshot, proposal, savedContent } = ready;
    const identity = snapshot.candidate;
    const lease = this.coordinator.acquire(identity.mapId, identity.viewSession, [snapshot.path], true);
    if (!lease) {
      // An explicit adoption attempt that cannot acquire its write lease consumes the candidate.
      // Never retry an old preview after a competing formal operation has settled.
      this.invalidate();
      return "discarded";
    }
    this.adopting = true;
    this.adoptionLease = lease;
    this.candidate = undefined;
    const generation = this.generation;
    const current = (): boolean =>
      lease.current() && !this.closed && this.generation === generation && check.isCurrent();
    try {
      const expectedContent = check.readSavedContent ? await check.readSavedContent() : snapshot.expectedContent;
      if (
        !current() ||
        (expectedContent !== snapshot.expectedContent && expectedContent !== savedContent) ||
        readLivingMarkdown(expectedContent).revision !== snapshot.base.revision ||
        livingGeneration(expectedContent) !== snapshot.baseGeneration
      ) {
        if (!this.closed && this.generation === generation) this.status = "invalid";
        return "discarded";
      }
      const candidate = { ...identity, baseRevision: livingSnapshotRevision(expectedContent) };
      const outcome = await commitLivingMarkdown(port, {
        ...snapshot,
        expectedContent,
        candidate,
        proposal,
        signal: lease.signal,
        inspect: () => check.inspect(),
        onCommit: (path, before, after) => check.onCommit?.(path, before, after),
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
