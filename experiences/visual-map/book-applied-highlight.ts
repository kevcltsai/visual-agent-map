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

/** The 0-based line span of each offset range in `text` (CRLF-safe: lines are counted by "\n"). */
export function lineSpans(
  text: string,
  ranges: readonly { from: number; to: number }[]
): { start: number; end: number }[] {
  const lineAt = (offset: number): number => {
    let n = 0;
    for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
    return n;
  };
  return ranges
    .filter(r => r.from < r.to)
    .map(r => ({ start: lineAt(r.from), end: lineAt(Math.max(r.from, r.to - 1)) }));
}

/** The reading view's twin of the CM6 mark: which rendered sections (by their line span) wear the light-green class. */
export class ReadingMarks {
  private marks: { path: string; spans: { start: number; end: number }[] } | null = null;
  set(path: string, spans: { start: number; end: number }[]): void {
    this.marks = spans.length ? { path, spans } : null;
  }
  clear(): void {
    this.marks = null;
  }
  /** True when the section `[lineStart, lineEnd]` of `path` overlaps a marked span. */
  wears(path: string, lineStart: number, lineEnd: number): boolean {
    const marks = this.marks;
    return !!marks && marks.path === path && marks.spans.some(s => s.start <= lineEnd && s.end >= lineStart);
  }
}
