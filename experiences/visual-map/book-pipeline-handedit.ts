import { bodyStateRaw, integrityFpRaw, isKeptRaw, keepRaw } from "../../core/book-pipeline/body-integrity";
import { formatPipelineLog } from "../../core/book-pipeline/log";
import { effectiveOrder, readBookPipeline, type PipelineFieldsPatch } from "../../core/book-pipeline/model";
import { t } from "../../i18n";
import type { MapDocument } from "../../map-model";
import type { NoteWriteResult } from "./book-pipeline-callouts";
import { isRewriteAsked, patchHandBox, readReviewState } from "./book-pipeline-review";
import type { BookRerunResult, PipelineCard } from "./book-pipeline-run";
import { bookRefusalText } from "./book-pipeline-ui";

/**
 * The reader's two answers on a hand-edited chapter's box. "Keep my version" writes the choice into the chapter (so later automatic runs
 * leave it alone). "Rewrite with AI" is a one-time command bound to the operation id and the text fingerprint the box carries: it runs the
 * single-card rerun at once (decision F), or, while the book is still running, is queued in the box's own marker and runs when the book is
 * back at the review checkpoint with nothing running (decision H). A changed text cancels it; a failure is never counted as handled.
 */
export interface HandEditPorts {
  readMap(path: string): Promise<MapDocument>;
  readCard(path: string): Promise<PipelineCard>;
  /** The callouts writer ({@link createNoteWriter}). */
  write(path: string, transform: (text: string) => string): Promise<NoteWriteResult>;
  /** The card's pipeline frontmatter (repository `writePipelineFields`). */
  writeFields(path: string, patch: PipelineFieldsPatch): Promise<void>;
  rerunCard(
    mapPath: string,
    nodeId: string,
    options: { overwrite: { operation: string; fingerprint: string } }
  ): Promise<BookRerunResult>;
  /** A drive (a run, a rerun) holds the map. */
  isRunning(mapPath: string): boolean;
  newId(): string;
  log(line: string): void;
}

export class BookHandEdits {
  /** Operations being carried out, and the ones that have been (a repeated tick of the same box never charges twice). */
  private readonly inflight = new Set<string>();
  private readonly done = new Set<string>();
  private disposed = false;
  /** Maps being drained: one drain per map at a time. The value is whether another settle came meanwhile (the drain looks once more). */
  private readonly draining = new Map<string, boolean>();

  constructor(private readonly ports: HandEditPorts) {}

  dispose(): void {
    this.disposed = true;
  }

  /**
   * "Keep my version" was ticked: the chapter text as it is now is recorded as kept, and the chapter is done (`checked`, no issue):
   * the kept text is the reader's answer, not a failed write. A later edit voids the kept record and the box asks again. `accept`:
   * "accept as it is" on a chapter the program wrote: the same record for the program's own text, so a whole-book rerun leaves it
   * alone (the card's own rerun still rewrites it).
   */
  async keep(path: string, accept = false): Promise<void> {
    if (this.disposed) return;
    try {
      // Judged on the text the write itself saw: with the note open in an editor the file on disk is saved later, so reading it back
      // right away may still show the text before the keep (the chapter then stayed needs-review).
      let kept = false;
      const result = await this.ports.write(path, text => {
        // "Accept as it is" on a chapter the program wrote holds only for the program's own text (a failed or empty chapter is not kept).
        if (accept && bodyStateRaw(text) !== "clean") return text;
        const next = keepRaw(text);
        kept = isKeptRaw(next);
        return next;
      });
      if (this.disposed || !kept || result === "refused") return;
      await this.ports.writeFields(path, { pipelineStage: "checked", pipelineIssue: null });
    } catch {
      // the box stays as it is; the reader can tick again
    }
  }

  /** A save of a chapter note: when its rewrite box is ticked, carry the rewrite out (or queue it). */
  async tick(mapPath: string, nodeId: string): Promise<void> {
    if (this.disposed) return;
    try {
      const map = await this.ports.readMap(mapPath);
      const read = readBookPipeline(map);
      const node = map.nodes.find(item => item.id === nodeId);
      if (read.kind !== "usable" || !node || !effectiveOrder(read.data).includes(nodeId)) return;
      const card = await this.ports.readCard(node.path);
      const state = readReviewState(card.raw);
      if (!isRewriteAsked(state) || !state?.op) return;
      const op = state.op;
      if (this.inflight.has(op) || this.done.has(op)) return;
      const now = integrityFpRaw(card.raw);
      if (now !== state.ifp) {
        // The text is not the one the reader chose "rewrite" for (typed since): nothing is overwritten and a queue is cancelled.
        await this.patch(node.path, {
          clearRewrite: true,
          queued: false,
          op: this.ports.newId(),
          ifp: now,
          status: t("ui.book_review_hand_changed")
        });
        return;
      }
      if (this.ports.isRunning(mapPath) || read.data.phase !== "gate2") {
        await this.patch(node.path, { queued: true, status: t("ui.book_review_hand_queued") });
        return;
      }
      await this.carryOut(mapPath, nodeId, node.path, op, state.ifp ?? now);
    } catch {
      // A tick must never break the editor's save path; failures of the rewrite itself are shown in the box.
    }
  }

  /** The book is at the checkpoint with nothing running: every queued rewrite of the map runs now, one after another. */
  async drain(mapPath: string): Promise<void> {
    if (this.disposed) return;
    if (this.draining.has(mapPath)) {
      this.draining.set(mapPath, true);
      return;
    }
    try {
      do {
        this.draining.set(mapPath, false);
        await this.drainOnce(mapPath);
      } while (this.draining.get(mapPath) && !this.disposed);
    } finally {
      this.draining.delete(mapPath);
    }
  }

  private async drainOnce(mapPath: string): Promise<void> {
    try {
      const map = await this.ports.readMap(mapPath);
      const read = readBookPipeline(map);
      if (read.kind !== "usable" || read.data.phase !== "gate2" || this.ports.isRunning(mapPath)) return;
      for (const id of effectiveOrder(read.data)) {
        if (this.disposed || this.ports.isRunning(mapPath)) return;
        const node = map.nodes.find(item => item.id === id);
        if (!node) continue;
        const card = await this.ports.readCard(node.path).catch(() => undefined);
        const state = card ? readReviewState(card.raw) : undefined;
        if (state?.queued && isRewriteAsked(state)) await this.tick(mapPath, id);
      }
    } catch {
      // the queue stays in the boxes; the next open or settle tries again
    }
  }

  private async carryOut(mapPath: string, nodeId: string, path: string, op: string, ifp: string): Promise<void> {
    this.inflight.add(op);
    try {
      this.ports.log(
        formatPipelineLog({
          event: "hand_edit_rewrite",
          runId: "-",
          card: nodeId,
          step: "write",
          attempt: 0,
          result: "start",
          ms: 0
        })
      );
      await this.ports.rerunCard(mapPath, nodeId, { overwrite: { operation: op, fingerprint: ifp } });
      const after = await this.ports.readCard(path).catch(() => undefined);
      const state = after ? bodyStateRaw(after.raw) : undefined;
      if (state === "clean") {
        this.done.add(op);
        return;
      }
      await this.patch(path, {
        clearRewrite: true,
        queued: false,
        op: this.ports.newId(),
        status: t("ui.book_review_hand_failed_0", t("ui.book_plain_write_hand_edited"))
      });
    } catch (error) {
      // Another drive holds the map right now: the command stays queued in its box and runs at the next settle (decision H).
      if ((error as { code?: unknown } | null)?.code === "busy") {
        await this.patch(path, { queued: true, status: t("ui.book_review_hand_queued") });
        return;
      }
      await this.patch(path, {
        clearRewrite: true,
        queued: false,
        op: this.ports.newId(),
        status: t("ui.book_review_hand_failed_0", bookRefusalText(error))
      });
    } finally {
      this.inflight.delete(op);
    }
  }

  private async patch(path: string, patch: Parameters<typeof patchHandBox>[1]): Promise<void> {
    await this.ports.write(path, text => patchHandBox(text, patch)).catch(() => undefined);
  }
}
