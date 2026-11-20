import { t } from "../../i18n";
import { undoApplied } from "../../core/book-pipeline/notes-apply";
import type { NotesApplyResult } from "./book-pipeline-run";
import type { NoteWriteResult } from "./book-pipeline-callouts";

/**
 * The reader's side of "apply the notes" (T6c): one job per chapter note with a running clock and cancel, the messages, the light-green
 * mark, and the undo of the last apply (same session). The AI job itself is the runner's `applyNotes`; everything here goes through ports.
 */

export const NOTES_TIMEOUT_MS = 3 * 60_000;
export const UNDO_NOTICE_MS = 10_000;

export interface NotesApplyPorts {
  /** Runs the runner's job (throws a refusal or a failure). */
  run(path: string, signal: AbortSignal): Promise<NotesApplyResult>;
  /** The runner's cancel of this chapter's map. */
  cancel(path: string): void;
  /** Why the chapter's map cannot take a job now: a drive is running, or another notes job holds it. */
  mapBusy(path: string): "drive" | "notes" | null;
  /** The code of a runner refusal, undefined for any other error. */
  codeOf(error: unknown): string | undefined;
  refusalText(error: unknown): string;
  /** A plain localized reason for a failure that is not a refusal (never the raw error message). */
  reasonText(error: unknown): string;
  write(path: string, transform: (text: string) => string): Promise<NoteWriteResult>;
  notice(message: string): void;
  /** A notice with one clickable word; `hide` closes it. */
  noticeAction(message: string, label: string, onClick: () => void, ms: number): { hide(): void };
  highlight(path: string, ranges: readonly { from: number; to: number }[]): void;
  releaseHighlight(): void;
  /** A chapter's text went back to an earlier state (undo): the map's boxes must be aligned again. */
  undone(path: string): void;
  /** The header action and menu must repaint (state changed). */
  changed(): void;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  setTick(run: () => void, ms: number): unknown;
  clearTick(handle: unknown): void;
}

interface Job {
  startedAt: number;
  abort: AbortController;
  cancelled: boolean;
  timedOut: boolean;
  timer: unknown;
}
interface Undo {
  path: string;
  edits: { before: string; after: string }[];
}

export class BookNotesApply {
  private readonly jobs = new Map<string, Job>();
  private lastUndo: Undo | null = null;
  private undoNotice: { hide(): void } | null = null;
  private tick: unknown = null;
  private disposed = false;

  constructor(private readonly ports: NotesApplyPorts) {}

  isRunning(path: string): boolean {
    return this.jobs.has(path);
  }
  /** m:ss since the job began, undefined when none runs. */
  elapsed(path: string): string | undefined {
    const job = this.jobs.get(path);
    if (!job) return undefined;
    const seconds = Math.max(0, Math.floor((this.ports.now() - job.startedAt) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  /** Why the action is disabled (a drive runs, or another chapter's job holds the map); null when it can be pressed or is the running one. */
  disabledReason(path: string): string | null {
    if (this.jobs.has(path)) return null;
    const busy = this.ports.mapBusy(path);
    if (busy === "drive") return t("ui.book_refused_drive_running");
    if (busy === "notes") return t("ui.book_refused_notes_busy");
    return null;
  }
  canUndo(): boolean {
    return !!this.lastUndo;
  }

  /** The header action, the menu item and the command: start, or cancel when this chapter's job is running. */
  press(path: string): void {
    if (this.disposed) return;
    const job = this.jobs.get(path);
    if (job) {
      job.cancelled = true;
      this.ports.cancel(path);
      job.abort.abort();
      return;
    }
    const why = this.disabledReason(path);
    if (why) return this.ports.notice(why);
    void this.start(path);
  }

  private async start(path: string): Promise<void> {
    const abort = new AbortController();
    const job: Job = {
      startedAt: this.ports.now(),
      abort,
      cancelled: false,
      timedOut: false,
      timer: this.ports.setTimer(() => {
        job.timedOut = true;
        abort.abort();
      }, NOTES_TIMEOUT_MS)
    };
    this.jobs.set(path, job);
    this.tick ??= this.ports.setTick(() => this.ports.changed(), 1000);
    this.ports.changed();
    try {
      const result = await this.ports.run(path, abort.signal);
      if (!this.disposed) this.done(path, result);
    } catch (error) {
      if (!this.disposed) this.failed(job, error);
    } finally {
      this.ports.clearTimer(job.timer);
      this.jobs.delete(path);
      if (!this.jobs.size && this.tick !== null) {
        this.ports.clearTick(this.tick);
        this.tick = null;
      }
      if (!this.disposed) this.ports.changed();
    }
  }

  private failed(job: Job, error: unknown): void {
    const code = this.ports.codeOf(error);
    if (code === "cancelled" && job.timedOut && !job.cancelled) return this.ports.notice(t("ui.book_note_timeout"));
    if (code) return this.ports.notice(this.ports.refusalText(error));
    this.ports.notice(t("ui.book_note_ai_failed_0", this.ports.reasonText(error)));
  }

  private done(path: string, result: NotesApplyResult): void {
    // `skipped` counts both reasons; `refused` (the reply's format) is a part of it, the rest is text that changed while waiting.
    const refused = Math.min(result.refused?.length ?? 0, result.skipped);
    const changed = result.skipped - refused;
    if (!result.applied) {
      this.ports.notice(
        !result.skipped
          ? t("ui.book_note_none_sendable")
          : !refused
            ? t("ui.book_note_none_skipped_0", changed)
            : !changed
              ? t("ui.book_note_none_refused_0", refused)
              : t("ui.book_note_none_mixed_0_1", changed, refused)
      );
      return;
    }
    this.lastUndo = { path, edits: result.edits.map(edit => ({ before: edit.before, after: edit.after })) };
    this.ports.highlight(
      path,
      result.edits.map(edit => ({ from: edit.from, to: edit.to }))
    );
    this.undoNotice?.hide();
    const text =
      t("ui.book_note_applied_n_0", result.applied) +
      (changed ? t("ui.book_note_applied_skipped_0", changed) : "") +
      (refused ? t("ui.book_note_applied_refused_0", refused) : "") +
      " · ";
    this.undoNotice = this.ports.noticeAction(
      text,
      t("ui.book_note_undo_label"),
      () => void this.undo(),
      UNDO_NOTICE_MS
    );
  }

  /** Puts back the paragraphs of the last apply that are still as it left them (their notes come back with them); the rest are reported. */
  async undo(): Promise<void> {
    const last = this.lastUndo;
    if (!last) return this.ports.notice(t("ui.book_note_undo_unavailable"));
    this.undoNotice?.hide();
    this.undoNotice = null;
    let outcome: { restored: number; skipped: number } | undefined;
    try {
      const written = await this.ports.write(last.path, text => {
        const result = undoApplied(text, last.edits);
        outcome = { restored: result.restored, skipped: result.skipped };
        return result.text;
      });
      if (written === "refused" || !outcome) return this.ports.notice(t("ui.book_note_undo_refused"));
    } catch {
      return this.ports.notice(t("ui.book_note_undo_refused"));
    }
    this.ports.releaseHighlight();
    this.lastUndo = null;
    if (outcome.restored) this.ports.undone(last.path);
    if (!outcome.restored) return this.ports.notice(t("ui.book_note_undo_none"));
    this.ports.notice(
      outcome.skipped
        ? t("ui.book_note_undo_partial_0_1", outcome.restored, outcome.skipped)
        : t("ui.book_note_undo_done_0", outcome.restored)
    );
  }

  /** Plugin unload: every job is cancelled, nothing is shown afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) job.abort.abort();
    this.undoNotice?.hide();
    this.undoNotice = null;
    this.lastUndo = null;
    if (this.tick !== null) this.ports.clearTick(this.tick);
    this.tick = null;
  }
}
