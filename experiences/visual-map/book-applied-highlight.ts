import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/**
 * The light-green mark on the paragraphs the notes rewrite just replaced. One CM6 extension (registered once by the plugin) holds the
 * marked ranges per editor; {@link AppliedHighlights} decides when they are shown and released.
 */

/** Sets the marked ranges of one editor (null or empty clears them). */
export const setApplied = StateEffect.define<readonly { from: number; to: number }[] | null>();

const MARK = Decoration.mark({ class: "vam-book-applied" });

export const appliedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setApplied)) continue;
      const size = tr.newDoc.length;
      const ranges: Range<Decoration>[] = [];
      for (const range of effect.value ?? [])
        if (range.from < range.to && range.from >= 0 && range.to <= size) ranges.push(MARK.range(range.from, range.to));
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field)
});

export const appliedExtension: Extension = appliedField;

/** One open editor as the manager sees it: which note it shows, and how to set or clear its marks. */
export interface HighlightTarget {
  key: object;
  path(): string | undefined;
  set(ranges: readonly { from: number; to: number }[] | null): void;
}
export interface HighlightPorts {
  /** Every open markdown editor now. */
  targets(): HighlightTarget[];
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export const HIGHLIGHT_MS = 10_000;

/** Shows the marks on every open editor of a note for 10 s; a file switch, a closed view, a newer apply and plugin unload release them. */
export class AppliedHighlights {
  private shown: { path: string; targets: Set<HighlightTarget>; timer: unknown } | null = null;
  constructor(private readonly ports: HighlightPorts) {}

  show(path: string, ranges: readonly { from: number; to: number }[]): void {
    this.release();
    if (!ranges.length) return;
    const targets = new Set(this.ports.targets().filter(target => target.path() === path));
    if (!targets.size) return;
    for (const target of targets) target.set(ranges);
    this.shown = { path, targets, timer: this.ports.setTimer(() => this.release(), HIGHLIGHT_MS) };
  }

  /** The workspace changed (a file switch, a view closed): an editor that no longer shows the note drops its marks. */
  sync(): void {
    const shown = this.shown;
    if (!shown) return;
    const live = new Map(this.ports.targets().map(target => [target.key, target]));
    for (const target of [...shown.targets]) {
      const now = live.get(target.key);
      if (!now) shown.targets.delete(target);
      else if (now.path() !== shown.path) {
        now.set(null);
        shown.targets.delete(target);
      }
    }
    if (!shown.targets.size) this.release();
  }

  release(): void {
    const shown = this.shown;
    this.shown = null;
    if (!shown) return;
    this.ports.clearTimer(shown.timer);
    for (const target of shown.targets) target.set(null);
  }

  dispose(): void {
    this.release();
  }
}

/**
 * The reading view's twin of the CM6 mark: which rendered sections wear the light-green class. A section is matched by its source text
 * (one applied paragraph), not by line numbers: the reading view may still show the text from before the apply when the mark is set,
 * and a callout written afterwards moves the lines.
 */
export class ReadingMarks {
  private marks: { path: string; texts: Set<string> } | null = null;
  set(path: string, texts: readonly string[]): void {
    const kept = texts.map(normalSection).filter(text => text);
    this.marks = kept.length ? { path, texts: new Set(kept) } : null;
  }
  clear(): void {
    this.marks = null;
  }
  /** True when the section of `path` whose source is `section` is one of the marked paragraphs. */
  wears(path: string, section: string): boolean {
    const marks = this.marks;
    return !!marks && marks.path === path && marks.texts.has(normalSection(section));
  }
}

/** A view of a note in reading mode, as far as a forced re-render needs it. */
export interface RenderableView {
  path: string | undefined;
  reading: boolean;
  rerender(): void;
}
/** The text of a note went back (undo): its open reading views render again now, not when Obsidian next gets to it. Returns how many. */
export function rerenderReadingViews(views: readonly RenderableView[], path: string): number {
  let count = 0;
  for (const view of views)
    if (view.path === path && view.reading) {
      view.rerender();
      count++;
    }
  return count;
}

/** A view of a note as the reading mark needs it: re-render a reading view, or drop stale marked elements from an editing one. */
export interface ReadingTarget extends RenderableView {
  unmark(): void;
}
export interface ReadingHighlightPorts {
  /** Every open markdown view now (reading or editing). */
  views(): ReadingTarget[];
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
/**
 * The reading view's mark for 10 s, set from the applied paragraphs themselves: it does not wait for an editor (a reading-only view has
 * no CM6 editor, and an empty set of located ranges must not cancel it).
 */
export class ReadingHighlight {
  readonly marks = new ReadingMarks();
  private shown: { path: string; timer: unknown } | null = null;
  constructor(private readonly ports: ReadingHighlightPorts) {}

  show(path: string, texts: readonly string[]): void {
    this.release();
    this.marks.set(path, texts);
    if (!texts.some(text => normalSection(text))) return;
    this.shown = { path, timer: this.ports.setTimer(() => this.release(), HIGHLIGHT_MS) };
    rerenderReadingViews(this.ports.views(), path);
  }

  release(): void {
    const shown = this.shown;
    this.shown = null;
    this.marks.clear();
    if (!shown) return;
    this.ports.clearTimer(shown.timer);
    for (const view of this.ports.views())
      if (view.path === shown.path) {
        if (view.reading) view.rerender();
        else view.unmark();
      }
  }
}

/** The source lines `[lineStart, lineEnd]` of `text` (a section of the reading view). */
export function sectionSource(text: string, lineStart: number, lineEnd: number): string {
  return text
    .split("\n")
    .slice(lineStart, lineEnd + 1)
    .join("\n");
}

const normalSection = (text: string): string => text.replace(/\r/g, "").trim();
