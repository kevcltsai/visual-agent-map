/** The Living Node editor keeps at least this much width in the central pane (its footer buttons wrap, but must stay reachable). */
export const LIVING_EDITOR_MIN_WIDTH = 320;

export interface SideDock {
  collapsed: boolean;
  collapse(): void;
}

/**
 * Obsidian's own side panels can squeeze the central pane to a few dozen pixels, which hides the editor's buttons. When the
 * pane is under the minimum, this folds one expanded side panel (the left one first; the right one holds the reader, so it
 * goes last) and says whether it did. It folds one at a time: the caller asks again after the layout has settled.
 */
export function collapseForEditorRoom(width: number, docks: readonly (SideDock | null | undefined)[]): boolean {
  if (!width || width >= LIVING_EDITOR_MIN_WIDTH) return false;
  const dock = docks.find(item => item && !item.collapsed);
  if (!dock) return false;
  dock.collapse();
  return true;
}
