import { t } from "../../i18n";
import { cardRevision } from "../../core/book-pipeline/machine";
import type { MapDocument } from "../../map-model";
import { formatPipelineLog } from "../../core/book-pipeline/log";
import { effectiveOrder, readBookPipeline, type BookPipelineData } from "../../core/book-pipeline/model";
import { hashText } from "../../core/book-pipeline/text";
import type { PipelineCard } from "./book-pipeline-run";
import {
  collapseReviewCallouts,
  markReviewHandled,
  reopenReviewCallouts,
  findProgramCallouts,
  idPart,
  isReviewResolved,
  putProgramCallout,
  readReviewState,
  removeProgramCallouts,
  removeProgramCalloutsWhere,
  reviewCallout,
  reviewEntries,
  type Gate2Card,
  type HandEditBox,
  trialCallout,
  type BookNoteLink,
  type ReviewState
} from "./book-pipeline-review";

/**
 * The program's callouts in the chapter notes of a picture book, and the one way every program write to a chapter note goes in.
 * `createNoteWriter` is that single write coordinator; `BookCallouts` aligns the notes of a map with its run (a trial hint at gate 1, a
 * review box at gate 2, nothing otherwise). Aligning is idempotent: it reads the run and the notes as they are now and writes only
 * what differs, so any trigger (a phase change, a rerun, a map opening) can ask for it again without harm.
 */

// ---- the write coordinator ----

/** A markdown view that has the note open: its live text (typed but maybe not yet saved) and a way to replace it as an editor edit. */
export interface OpenNoteView {
  text(): string;
  /** Applies `next` as one editor transaction; false when it could not. */
  replace(next: string): boolean;
}
export interface NoteWritePorts {
  /** Every markdown view that has this note open right now (a note open in two panes has two). */
  openViews(path: string): OpenNoteView[];
  /** `updateNoteRawGuarded`: `authorize` runs inside the write on the text it is given; false writes nothing and answers "discarded". */
  rawGuarded(
    path: string,
    transform: (content: string) => string,
    options: { authorize: () => boolean }
  ): Promise<"written" | "discarded">;
}
/** written: the text changed; unchanged: it already was as wanted; refused: nothing was written (views disagree, or the note changed under us). */
export type NoteWriteResult = "written" | "unchanged" | "refused";

/** The part of a markdown view the coordinator needs (Obsidian's `MarkdownView` satisfies it). */
export interface MarkdownViewLike {
  file: { path: string } | null;
  getMode(): string;
  editor: {
    getValue(): string;
    offsetToPos(offset: number): { line: number; ch: number };
    transaction(spec: {
      changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[];
    }): void;
  };
}

/**
 * The views of `path` the coordinator may edit through. A view in reading (preview) mode is left out: its editor is not the live
 * text there (it may be stale or its edit may never show), so a note only a reading view has open is written as a file; Obsidian
 * reloads the view from the file.
 */
export function editorViewsOf(path: string, views: MarkdownViewLike[]): OpenNoteView[] {
  const out: OpenNoteView[] = [];
  for (const view of views) {
    if (view.file?.path !== path || view.getMode() === "preview") continue;
    out.push({
      text: () => view.editor.getValue(),
      replace: next => {
        const editor = view.editor;
        const change = minimalChange(editor.getValue(), next);
        if (!change) return true;
        editor.transaction({
          changes: [{ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.insert }]
        });
        return true;
      }
    });
  }
  return out;
}

/** The smallest single replacement that turns `before` into `after` (common head and tail kept), so a cursor elsewhere in the text stays put. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let head = 0;
  const max = Math.min(before.length, after.length);
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < max - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail))
    tail++;
  return { from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) };
}

/**
 * The write coordinator of the chapter notes. A note a markdown view has open is changed through that view's editor (one
 * transaction on the live text, so nothing typed is lost); two views that disagree about the text refuse. A note no view has open goes
 * through the guarded file write, whose `authorize` checks again, inside the write, that no view has opened it meanwhile; if one has,
 * the file is left alone and the write is retried once through the editor.
 */
export function createNoteWriter(
  ports: NoteWritePorts
): (path: string, transform: (text: string) => string) => Promise<NoteWriteResult> {
  const viaEditor = (views: OpenNoteView[], transform: (text: string) => string): NoteWriteResult => {
    const texts = views.map(view => view.text());
    if (texts.some(text => text !== texts[0])) return "refused";
    const next = transform(texts[0]);
    if (next === texts[0]) return "unchanged";
    return views[0].replace(next) ? "written" : "refused";
  };
  return async (path, transform) => {
    const views = ports.openViews(path);
    if (views.length) return viaEditor(views, transform);
    let opened = false;
    let same = false;
    const outcome = await ports.rawGuarded(
      path,
      content => {
        const next = transform(content);
        same = next === content;
        return next;
      },
      {
        authorize: () => {
          opened = ports.openViews(path).length > 0;
          return !opened;
        }
      }
    );
    if (outcome === "written") return same ? "unchanged" : "written";
    if (!opened) return "refused";
    const now = ports.openViews(path);
    return now.length ? viaEditor(now, transform) : "refused";
  };
}

// ---- aligning a text with what the run wants ----

/** What one chapter note should carry now (the trial hint, the review box); undefined: nothing of the program's. */
export interface WantedCallouts {
  runId: string;
  nodeId: string;
  trial?: string;
  /** `build` gets the box the note carries now (when it is being written again): a queued rewrite of an unchanged hand-edited text is carried over. */
  review?: { fp: string; build: (prior?: ReviewState) => string };
  /** Gate 2: a review box the reader answered stays (folded) even when the chapter no longer asks for one. */
  keepAnswered?: boolean;
}

/**
 * `text` with the program's callouts as `want` says. Callouts of another run (or another chapter) always go. A review box that was
 * written for the same fingerprint stays as it is (a tick stays) and is folded when one of its boxes is ticked; one for another
 * fingerprint is written again unticked (a queued rewrite for a hand-edited text that has not changed is carried over). A queued box of this run
 * stays also when `want` has no review (the run is between two checkpoints). With `want` undefined every program callout goes. Running it again changes nothing.
 */
export function alignCallouts(text: string, want: WantedCallouts | undefined): string {
  if (!want) return removeProgramCallouts(text);
  let out = removeProgramCalloutsWhere(text, c => c.runId !== idPart(want.runId) || c.nodeId !== idPart(want.nodeId));
  out = want.trial ? putProgramCallout(out, want.trial) : removeProgramCallouts(out, "trial");
  if (want.review) {
    const state = readReviewState(out);
    if (state && state.fp === idPart(want.review.fp)) {
      if (isReviewResolved(state, state.fp)) out = collapseReviewCallouts(out);
      else if (state.collapsed || state.handled) out = reopenReviewCallouts(out);
    } else out = putProgramCallout(out, want.review.build(state));
  } else {
    const state = readReviewState(out);
    const own = !!state && state.runId === idPart(want.runId) && state.nodeId === idPart(want.nodeId);
    // A box the reader answered stays folded under its "handled" title while the book is at gate 2 (whatever the answer cleared, such
    // as a join to check, no longer asks for it): ticking either box ends the same way (mockup ⑦-3).
    const answered = own && want.keepAnswered === true && isReviewResolved(state, state?.fp ?? "");
    if (answered) out = collapseReviewCallouts(out);
    else if (!(own && state?.queued)) out = removeProgramCallouts(out, "review");
  }
  return out;
}

/** Whether a note text carries any callout of the program (the cheap "is there anything to clean" check). */
export const hasProgramCallouts = (text: string): boolean => findProgramCallouts(text).length > 0;

// ---- the map-level aligner ----

export interface BookCalloutPorts {
  readMap(path: string): Promise<MapDocument>;
  readCard(path: string): Promise<PipelineCard>;
  /** The raw text of a note (the cheap read for the scan of notes that are not chapters of the run). */
  readText(path: string): Promise<string>;
  /** {@link createNoteWriter}. */
  write(path: string, transform: (text: string) => string): Promise<NoteWriteResult>;
  log(line: string): void;
  /** A fresh id for the operation a hand-edited chapter's box carries. */
  newId?(): string;
}

/**
 * What the caller already knows without a read: whether a note may carry a program callout (true), certainly does not (false), or is
 * not known (undefined: read it). The map view answers it from the notes it holds in memory, so opening a map with no picture book in
 * it reads no note at all.
 */
export type MayCarryCallouts = (nodeId: string) => boolean | undefined;

export class BookCallouts {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly waiting = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly ports: BookCalloutPorts) {}

  /** Aligns the chapter notes of this map's current run; asks that arrive while one waits to start share it. Failures are logged, never thrown. */
  reconcile(mapPath: string, mayCarry?: MayCarryCallouts): Promise<void> {
    // A call with a hint and one without are different jobs: the one without reads every note and must not borrow a hint.
    const key = `${mapPath}\u0000${mayCarry ? "hint" : "all"}`;
    const queued = this.waiting.get(key);
    if (queued) return queued;
    const job = this.enqueue(mapPath, async () => {
      this.waiting.delete(key);
      await this.align(mapPath, mayCarry);
    }).then(
      () => undefined,
      () => undefined
    );
    this.waiting.set(key, job);
    return job;
  }

  /** Takes every program callout (any run) off the chapters of the map's run; true when every note is clean. Called before the run is abandoned or replaced. */
  clear(mapPath: string): Promise<boolean> {
    return this.enqueue(mapPath, () => this.sweep(mapPath)).catch(() => false);
  }

  /** Takes every program callout (and with it a queued rewrite) off notes that left the run's map (a removed chapter): the map no longer names them, so the caller passes the paths. */
  clearNotes(mapPath: string, runId: string, cards: readonly { id: string; path: string }[]): Promise<boolean> {
    return this.enqueue(mapPath, async () => {
      let clean = true;
      for (const { id, path } of cards) {
        if (this.disposed) return false;
        let raw: string;
        try {
          raw = await this.ports.readText(path);
        } catch {
          continue;
        }
        if (!hasProgramCallouts(raw)) continue;
        if (!(await this.put(runId, id, path, text => alignCallouts(text, undefined)))) clean = false;
      }
      return clean;
    }).catch(() => false);
  }

  /** Folds a ticked review box under its "handled" title (the ticks and marker stay). */
  collapse(path: string): Promise<NoteWriteResult> {
    return this.disposed ? Promise.resolve("refused") : this.ports.write(path, collapseReviewCallouts);
  }
  /** Titles a ticked review box "handled" and leaves it open (it folds a moment later, see {@link collapse}). */
  markHandled(path: string): Promise<NoteWriteResult> {
    return this.disposed ? Promise.resolve("refused") : this.ports.write(path, markReviewHandled);
  }
  /** Opens a review box that is no longer ticked again, with its question as title. */
  reopen(path: string): Promise<NoteWriteResult> {
    return this.disposed ? Promise.resolve("refused") : this.ports.write(path, reopenReviewCallouts);
  }

  /** Resolves when every queued job has ended (tests, and a clean shutdown). */
  async idle(): Promise<void> {
    for (let again = true; again;) {
      const before = [...this.tails.values()];
      await Promise.all(before.map(tail => tail.catch(() => undefined)));
      again = [...this.tails.values()].some(tail => !before.includes(tail));
    }
  }

  /** Plugin unload: nothing is written afterwards. */
  dispose(): void {
    this.disposed = true;
    this.waiting.clear();
  }

  private enqueue<T>(mapPath: string, job: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(mapPath) ?? Promise.resolve();
    const next = tail.then(
      () => (this.disposed ? (undefined as T) : job()),
      () => (this.disposed ? (undefined as T) : job())
    );
    this.tails.set(mapPath, next);
    void next.then(
      () => this.release(mapPath, next),
      () => this.release(mapPath, next)
    );
    return next;
  }
  private release(mapPath: string, tail: Promise<unknown>): void {
    if (this.tails.get(mapPath) === tail) this.tails.delete(mapPath);
  }

  /** The hand-edited chapter's box content: the queue (operation, text fingerprint, queued mark) is carried over while the text is the one it was queued for. */
  private handBox(card: Gate2Card, prior: ReviewState | undefined): HandEditBox | undefined {
    if (!card.handEdited) return undefined;
    const ifp = card.bodyFp ?? "";
    if (prior?.op && prior.queued && prior.ifp === idPart(ifp))
      return { op: prior.op, ifp, queued: true, status: t("ui.book_review_hand_queued") };
    const op = this.ports.newId?.() ?? hashText(`${Date.now()}:${Math.random()}`);
    return { op, ifp };
  }

  private fail(runId: string, nodeId: string, result: string): void {
    this.ports.log(
      formatPipelineLog({ event: "callout_failed", runId, card: nodeId, step: "proof", attempt: 0, result, ms: 0 })
    );
  }

  /** The cards of the run in reading order with their note paths; a card whose note cannot be read is left out (and logged). */
  private async cardsOf(
    map: MapDocument,
    data: BookPipelineData,
    skip?: (id: string) => boolean
  ): Promise<{ id: string; card: PipelineCard }[]> {
    const out: { id: string; card: PipelineCard }[] = [];
    for (const id of effectiveOrder(data)) {
      if (skip?.(id)) continue;
      const node = map.nodes.find(item => item.id === id);
      if (!node) continue;
      try {
        out.push({ id, card: await this.ports.readCard(node.path) });
      } catch {
        this.fail(data.runId, id, "unreadable");
      }
    }
    return out;
  }

  private async sweep(mapPath: string): Promise<boolean> {
    const map = await this.ports.readMap(mapPath);
    const read = readBookPipeline(map);
    if (read.kind !== "usable") return true;
    let clean = true;
    for (const { id, card } of await this.cardsOf(map, read.data)) {
      if (this.disposed) return false;
      if (!hasProgramCallouts(card.raw)) continue;
      if (!(await this.put(read.data.runId, id, card.path, text => alignCallouts(text, undefined)))) clean = false;
    }
    return clean;
  }

  private async put(runId: string, id: string, path: string, transform: (text: string) => string): Promise<boolean> {
    try {
      const result = await this.ports.write(path, transform);
      if (result === "refused") this.fail(runId, id, "refused");
      return result !== "refused";
    } catch {
      this.fail(runId, id, "error");
      return false;
    }
  }

  private async align(mapPath: string, mayCarry?: MayCarryCallouts): Promise<void> {
    const clean = (id: string): boolean => mayCarry?.(id) === false;
    const map = await this.ports.readMap(mapPath);
    const read = readBookPipeline(map);
    if (read.kind === "absent") {
      await this.dropStale(map, undefined, new Set(), clean);
      return;
    }
    if (read.kind !== "usable") return;
    const data = read.data;
    // Gates need every chapter read (the trial hint, the review boxes); any other phase wants no callout, so a chapter known to have none is left unread.
    const gate = data.phase === "gate1" || data.phase === "gate2";
    const cards = await this.cardsOf(map, data, gate ? undefined : clean);
    const byId = new Map(cards.map(item => [item.id, item.card]));
    const link = (id: string | undefined): BookNoteLink | undefined => {
      const card = id ? byId.get(id) : undefined;
      return card ? { path: card.path, title: card.title } : undefined;
    };
    const wanted = new Map<string, WantedCallouts>();
    if (data.phase === "gate1") {
      const trial = data.trial ?? [];
      trial.forEach((id, at) => {
        if (!byId.has(id)) return;
        wanted.set(id, {
          runId: data.runId,
          nodeId: id,
          trial: trialCallout(
            at + 1,
            trial.length,
            link(trial[at - 1]),
            link(trial[at + 1]),
            data.status === "stopped",
            {
              runId: data.runId,
              nodeId: id
            }
          )
        });
      });
    } else if (data.phase === "gate2") {
      const entries = reviewEntries({
        proofContext: { runId: data.runId, revisionOf: id => cardRevision(data, id) },
        order: cards.map(item => item.id),
        titleOf: id => byId.get(id)?.title ?? id,
        noteOf: id => {
          const card = byId.get(id);
          return card
            ? {
                prompt: card.prompt,
                detail: card.detail,
                pipelineStage: card.fields.pipelineStage,
                pipelineIssue: card.fields.pipelineIssue,
                pipelineSeam: card.fields.pipelineSeam,
                bookRole: card.fields.bookRole
              }
            : undefined;
        }
      });
      entries.forEach((entry, at) => {
        const next = entries.length > 1 ? entries[(at + 1) % entries.length].card.id : undefined;
        wanted.set(entry.card.id, {
          runId: data.runId,
          nodeId: entry.card.id,
          review: {
            fp: entry.fp,
            build: prior =>
              reviewCallout(
                entry.card,
                entry.problems.map(problem => problem.text),
                link(next),
                entry.fp,
                data.runId,
                this.handBox(entry.card, prior)
              )
          }
        });
      });
    }
    // Any other phase wants none: a callout left from an earlier phase or run goes now.
    for (const { id, card } of cards) {
      if (this.disposed) return;
      const want = wanted.get(id) ?? {
        runId: data.runId,
        nodeId: id,
        ...(data.phase === "gate2" ? { keepAnswered: true } : {})
      };
      // The note as it is now, not as it was read with the cards: a chapter written meanwhile has lost its callouts.
      const now = await this.ports.readText(card.path).catch(() => card.raw);
      if (alignCallouts(now, want) === now) continue;
      await this.put(data.runId, id, card.path, text => alignCallouts(text, want));
    }
    await this.dropStale(map, data.runId, new Set(effectiveOrder(data)), clean);
  }

  /**
   * The notes of the map that are not chapters of the current run (or of any run, when there is none): every program callout whose
   * run is not the current one goes. This is what cleans up after an abandon or a restart whose clear failed.
   */
  private async dropStale(
    map: MapDocument,
    runId: string | undefined,
    chapters: Set<string>,
    known: (id: string) => boolean
  ): Promise<void> {
    const current = runId === undefined ? undefined : idPart(runId);
    for (const node of map.nodes) {
      if (this.disposed) return;
      if (chapters.has(node.id) || known(node.id)) continue;
      let raw: string;
      try {
        raw = await this.ports.readText(node.path);
      } catch {
        continue;
      }
      if (!hasProgramCallouts(raw)) continue;
      await this.put(runId ?? "none", node.id, node.path, text =>
        removeProgramCalloutsWhere(text, callout => callout.runId !== current)
      );
    }
  }
}
