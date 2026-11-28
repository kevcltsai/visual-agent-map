/** The Living Node editor keeps at least this much width in the central pane (its footer buttons wrap, but must stay reachable). */
export const LIVING_EDITOR_MIN_WIDTH = 320;

export interface SideDock {
  collapsed: boolean;
  collapse(): void;
  expand(): void;
}

/**
 * The room the Living Node editor makes in the central pane while it is open, and the side panels it gives back.
 *
 * Obsidian's side panels can squeeze the central pane to nothing, which hides the editor's buttons. While the editor is
 * open, a pane under the minimum folds one expanded panel at a time (the left one first; the right one holds the reader),
 * each at most once. When it closes, every panel returns to how it was when the editor opened, except a panel the user
 * opened or folded meanwhile: the user's last action wins. A panel VAM itself changed (the reader revealing the right
 * panel) is reported through `accept`, so it is not mistaken for the user's action.
 */
export class EditorRoom {
  private readonly before = new Map<SideDock, boolean>();
  private readonly expected = new Map<SideDock, boolean>();
  /** Panels the user opened or folded while the editor was open, with the user's last choice (true: folded). */
  private readonly byUser = new Map<SideDock, boolean>();
  private readonly folded = new Set<SideDock>();

  constructor(private readonly docks: readonly SideDock[]) {
    for (const dock of docks) {
      this.before.set(dock, dock.collapsed);
      this.expected.set(dock, dock.collapsed);
    }
  }

  /**
   * VAM changed this panel itself (the reader revealed it): its state now is expected, not the user's choice. A panel the
   * editor had folded that VAM unfolded again may be folded again.
   */
  accept(dock: SideDock | null | undefined): void {
    if (!dock || !this.expected.has(dock)) return;
    this.expected.set(dock, dock.collapsed);
    if (!dock.collapsed) this.folded.delete(dock);
  }

  /** Folds one panel when the pane is under the minimum (0 counts: both panels can squeeze it shut); true when it did. */
  fit(width: number): boolean {
    this.notice();
    if (width >= LIVING_EDITOR_MIN_WIDTH) return false;
    const dock = this.docks.find(item => !item.collapsed && !this.byUser.has(item) && !this.folded.has(item));
    if (!dock) return false;
    dock.collapse();
    this.folded.add(dock);
    this.expected.set(dock, true);
    return true;
  }

  /** When the editor closes: each panel back to how it was when it opened, unless the user changed it meanwhile. */
  restore(): void {
    this.notice();
    for (const dock of this.docks) {
      // VAM may have changed a panel the user set (the reader revealing the right one on close): the user's choice wins.
      const was = this.byUser.has(dock) ? this.byUser.get(dock) : this.before.get(dock);
      if (was === undefined || dock.collapsed === was) continue;
      if (was) dock.collapse();
      else dock.expand();
    }
  }

  /** A panel that is not as the editor or VAM left it was opened or folded by the user. */
  private notice(): void {
    for (const dock of this.docks)
      if (this.expected.get(dock) !== dock.collapsed) {
        this.byUser.set(dock, dock.collapsed);
        this.expected.set(dock, dock.collapsed);
      }
  }
}
