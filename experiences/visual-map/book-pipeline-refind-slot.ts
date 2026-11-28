import { t } from "../../i18n";
import { reverseSwap, swapFigureStamped } from "../../core/book-pipeline/refind-slot";
import type { RefindResult } from "./book-pipeline-run";
import type { NoteWriteResult } from "./book-pipeline-callouts";

/**
 * The reader's side of "find another picture" (V3.3 P5.1b): one job per chapter note with a cancel (press again) and a time limit, the
 * messages, and the undo of the last swap (same session, offered for 10 s). The search and the swap are the runner's `refindSlot`;
 * everything here goes through ports.
 */

export const REFIND_TIMEOUT_MS = 3 * 60_000;
export const REFIND_UNDO_MS = 10_000;

export interface RefindSlotPorts {
  /** Runs the runner's job for the picture at `url` (throws a refusal or a failure). */
  run(path: string, url: string, signal: AbortSignal): Promise<RefindResult>;
  /** The runner's cancel of this chapter's map. */
  cancel(path: string): void;
  /** Why the chapter's map cannot take a job now: a drive is running, or another notes or picture job holds it. */
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
  /** The menu item and the command must repaint (state changed). */
  changed(): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

interface Job {
  abort: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}
type Replaced = Extract<RefindResult, { kind: "replaced" }>;

export class BookRefindSlot {
  private readonly jobs = new Map<string, Job>();
  private lastUndo: Replaced | null = null;
  private undoNotice: { hide(): void } | null = null;
  private disposed = false;

  constructor(private readonly ports: RefindSlotPorts) {}

  isRunning(path: string): boolean {
    return this.jobs.has(path);
  }
  canUndo(): boolean {
    return !!this.lastUndo;
  }

  /** The menu item and the command: start a search for the picture at `url`, or cancel when this chapter's job is running. */
  press(path: string, url: string): void {
    if (this.disposed) return;
    const job = this.jobs.get(path);
    if (job) {
      job.cancelled = true;
      this.ports.cancel(path);
      job.abort.abort();
      return;
    }
    const busy = this.ports.mapBusy(path);
    if (busy)
      return this.ports.notice(t(busy === "drive" ? "ui.book_refused_drive_running" : "ui.book_refused_notes_busy"));
    void this.start(path, url);
  }

  private async start(path: string, url: string): Promise<void> {
    const abort = new AbortController();
    const job: Job = { abort, cancelled: false, timedOut: false };
    const timer = this.ports.setTimer(() => {
      job.timedOut = true;
      abort.abort();
    }, REFIND_TIMEOUT_MS);
    this.jobs.set(path, job);
    this.ports.changed();
    this.ports.notice(t("ui.book_refind_started"));
    try {
      const result = await this.ports.run(path, url, abort.signal);
      if (!this.disposed) this.done(result);
    } catch (error) {
      if (!this.disposed) this.failed(job, error);
    } finally {
      this.ports.clearTimer(timer);
      this.jobs.delete(path);
      if (!this.disposed) this.ports.changed();
    }
  }

  private failed(job: Job, error: unknown): void {
    const code = this.ports.codeOf(error);
    if (code === "cancelled" && job.timedOut && !job.cancelled) return this.ports.notice(t("ui.book_refind_timeout"));
    if (code === "cancelled") return this.ports.notice(t("ui.book_refind_cancelled"));
    if (code) return this.ports.notice(this.ports.refusalText(error));
    this.ports.notice(t("ui.book_refind_failed_0", this.ports.reasonText(error)));
  }

  private done(result: RefindResult): void {
    if (result.kind === "none") return this.ports.notice(t("ui.book_refind_none"));
    this.lastUndo = result;
    this.undoNotice?.hide();
    this.undoNotice = this.ports.noticeAction(
      `${t("ui.book_refind_done")} · `,
      t("ui.book_note_undo_label"),
      () => void this.undo(),
      REFIND_UNDO_MS
    );
  }

  /**
   * Puts the last swapped picture back. A chapter still exactly as the swap left it gets its earlier text back byte for byte; one changed
   * since gets the reverse swap (only the picture's lines, its Sources entry and its record item), or nothing when the new picture is no
   * longer there as written.
   */
  async undo(): Promise<void> {
    const last = this.lastUndo;
    if (!last) return;
    this.undoNotice?.hide();
    this.undoNotice = null;
    this.lastUndo = null;
    let written: NoteWriteResult;
    try {
      written = await this.ports.write(last.path, text =>
        text === last.after ? last.before : (swapFigureStamped(text, reverseSwap(last.swap), last.language) ?? text)
      );
    } catch {
      written = "refused";
    }
    if (this.disposed) return;
    this.ports.notice(t(written === "written" ? "ui.book_refind_undo_done" : "ui.book_refind_undo_refused"));
  }

  /** Plugin unload: every job is cancelled, nothing is shown afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) job.abort.abort();
    this.undoNotice?.hide();
    this.undoNotice = null;
    this.lastUndo = null;
  }
}
