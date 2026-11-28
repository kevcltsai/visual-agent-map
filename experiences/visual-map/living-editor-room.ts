/** The Living Node editor keeps at least this much width in the central pane (its footer buttons wrap, but must stay reachable). */
export const LIVING_EDITOR_MIN_WIDTH = 320;

export interface SideDock {
  collapsed: boolean;
  collapse(): void;
  expand(): void;
}

/**
 * Obsidian's own side panels can squeeze the central pane to a few dozen pixels, which hides the editor's buttons. When the
 * pane is under the minimum, this folds one expanded side panel (the left one first; the right one holds the reader, so it
 * goes last) and says whether it did. It folds one at a time: the caller asks again after the layout has settled.
 * `folded` holds the panels this editor already folded: each is folded at most once, so a panel the user opens again while
 * the editor is open stays open (the user's own action wins).
 */
export function collapseForEditorRoom(
  width: number,
  docks: readonly (SideDock | null | undefined)[],
  folded: Set<SideDock>
): boolean {
  // A width of 0 is a pane squeezed shut by both panels (the caller skips a hidden tab, whose boxes also measure 0).
  if (width >= LIVING_EDITOR_MIN_WIDTH) return false;
  const dock = docks.find(item => item && !item.collapsed && !folded.has(item));
  if (!dock) return false;
  dock.collapse();
  folded.add(dock);
  return true;
}

/**
 * When the editor closes: opens again only the panels it folded itself and that are still folded; the user's own folds stay.
 * `revealed` holds panels the user had folded that opening the editor's reader unfolded: they are folded back.
 */
export function restoreEditorRoom(folded: Set<SideDock>, revealed: Set<SideDock>): void {
  for (const dock of folded) if (dock.collapsed) dock.expand();
  for (const dock of revealed) if (!dock.collapsed) dock.collapse();
  folded.clear();
  revealed.clear();
}
