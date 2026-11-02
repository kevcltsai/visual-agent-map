/**
 * The selection of a Visual Map: which topic is selected, which topics are ticked in multi-select, whether the map is
 * in multi-select mode, which relation line is selected and which card is the keyboard tab stop.
 * Pure logic: it imports nothing, reads no map and touches no DOM. The caller passes in what it knows (can this map
 * multi-select, which ids exist, which topics are shown in order). Every operation returns a SelectionChange.
 * The operations are one per way f852afa wrote the same rule; the differences are kept, not unified (see later.md).
 */
export interface SelectionChange {
  /** Every topic id whose card may look different now (null ids dropped, no duplicates). */
  readonly touched: readonly string[];
  /** The operation turned multi-select mode on or off, so the view rebuilds its chrome (selection bar). */
  readonly multiSelectModeChanged: boolean;
  /** The selected relation line changed. */
  readonly relationChanged: boolean;
}
export interface SelectionState {
  readonly selected: string | null;
  readonly multiSelected: ReadonlySet<string>;
  /** Named integrationMode in the view; the view keeps that name. */
  readonly multiSelectMode: boolean;
  readonly selectedRelation: string | null;
  readonly tabStopId: string | null;
}
/** A shown topic in display order; parentId null marks a root. */
export interface ShownTopic {
  readonly id: string;
  readonly parentId: string | null;
}
export interface CommitContext {
  /** When given, the operation resets the tab stop from these topics like applySelectionState does (view.ts 10562). */
  readonly shown?: readonly ShownTopic[];
}
export interface SelectionContext extends CommitContext {
  /** False for an AIM map. */
  readonly canMultiSelect: boolean;
}
export interface SelectionSnapshot {
  readonly selected: string | null;
  readonly multiSelected: readonly string[];
}
export type ExitVariant = "openMap" | "emptyMap" | "backgroundRun";

const NO_CHANGE: SelectionChange = Object.freeze({
  touched: Object.freeze([]),
  multiSelectModeChanged: false,
  relationChanged: false
});

function change(
  ids: Iterable<string | null>,
  multiSelectModeChanged = false,
  relationChanged = false
): SelectionChange {
  const touched: string[] = [];
  for (const id of ids) if (id !== null && !touched.includes(id)) touched.push(id);
  return Object.freeze({ touched: Object.freeze(touched), multiSelectModeChanged, relationChanged });
}

/** The tab stop when nothing moved it: the selected shown card, else the first root, else the first card (view.ts 10520). */
export function defaultTabStop(selected: string | null, shown: readonly ShownTopic[]): string | null {
  return (
    (selected && shown.some(topic => topic.id === selected) ? selected : null) ??
    shown.find(topic => !topic.parentId)?.id ??
    shown[0]?.id ??
    null
  );
}

export class TopicSelection {
  private selected: string | null = null;
  private multi = new Set<string>();
  private mode = false;
  private relation: string | null = null;
  private tabStop: string | null = null;

  /** A frozen copy: editing it, or its Set, never reaches the module. */
  get state(): SelectionState {
    return Object.freeze({
      selected: this.selected,
      multiSelected: new Set(this.multi),
      multiSelectMode: this.mode,
      selectedRelation: this.relation,
      tabStopId: this.tabStop
    });
  }

  // ---- single select (three copies) ----
  /** Select one topic, no guard: enableDrag plain click (view.ts 17606-17609) and revealPath (10899-10902). */
  click(id: string, ctx: CommitContext = {}): SelectionChange {
    const before = this.selected,
      multi = [...this.multi];
    this.selected = id;
    this.multi.clear();
    return this.commit([before, id, ...multi], ctx);
  }
  /** Select one topic unless that is already the whole selection: selectMapNode (10908-10915). */
  selectIfChanged(id: string, ctx: CommitContext = {}): SelectionChange {
    if (this.selected === id && this.multi.size === 0) return NO_CHANGE;
    return this.click(id, ctx);
  }
  /** Write only the selected id, then the caller renders: 2065, 3937, 4162, 4354, 4364, 4413, 4464, 4554, 6447, 7934, 7966, 8019, 8334, 9412, 11301, 12651. */
  setSelected(id: string | null): SelectionChange {
    const before = this.selected;
    this.selected = id;
    return change([before, id]);
  }

  // ---- Cmd/Ctrl click ----
  /** enableDrag Cmd/Ctrl branch (17592-17604). */
  cmdClick(id: string, ctx: SelectionContext): SelectionChange {
    const before = this.selected,
      multi = [...this.multi];
    if (ctx.canMultiSelect && !this.multi.size && before && before !== id) this.multi.add(before);
    if (this.multi.has(id)) this.multi.delete(id);
    else this.multi.add(id);
    this.selected = id;
    if (ctx.canMultiSelect && this.multi.size >= 2) {
      this.mode = true;
      // View renders fully here and does not end a relation selection.
      return change([before, ...multi, id], true);
    }
    return this.commit([before, ...multi, id], ctx);
  }

  // ---- toggling inside multi-select (four copies; the fourth is cmdClick) ----
  /** Checkbox: set by its checked state (9764-9766). */
  setChecked(id: string, checked: boolean): SelectionChange {
    if (checked) this.multi.add(id);
    else this.multi.delete(id);
    return this.commit([id], {});
  }
  /** Card click in multi-select (10268-10271). */
  toggleByClick(id: string): SelectionChange {
    return this.flip(id);
  }
  /** Enter on a card in multi-select (10316-10319). */
  toggleByEnter(id: string): SelectionChange {
    return this.flip(id);
  }
  private flip(id: string): SelectionChange {
    if (this.multi.has(id)) this.multi.delete(id);
    else this.multi.add(id);
    return this.commit([id], {});
  }

  // ---- marquee ----
  /** Rubber-band selection (14818-14832). An AIM map never gets here in the view (14939); the module also refuses. */
  marquee(ids: Iterable<string>, mode: "add" | "subtract" | "enter", ctx: SelectionContext): SelectionChange {
    if (!ctx.canMultiSelect) return NO_CHANGE;
    const hits = new Set(ids);
    if (!hits.size) return NO_CHANGE;
    if (mode === "subtract") {
      const removed = [...hits].filter(id => this.multi.has(id));
      if (!removed.length) return NO_CHANGE;
      for (const id of removed) this.multi.delete(id);
      return this.commit(removed, ctx);
    }
    for (const id of hits) this.multi.add(id);
    if (mode === "enter") {
      this.mode = true;
      return change(hits, true);
    }
    return this.commit(hits, ctx);
  }

  // ---- clear ----
  /** Selection bar Clear (13439-13441): multi emptied, selected and mode kept. */
  clearMulti(ctx: CommitContext = {}): SelectionChange {
    const multi = [...this.multi];
    this.multi.clear();
    return this.commit(multi, ctx);
  }
  /** Click on the empty canvas (14965-14975): ends a relation selection; outside multi-select also clears the selection. */
  clickEmpty(ctx: CommitContext = {}): SelectionChange {
    const hadRelation = this.relation !== null;
    this.relation = null;
    if (this.mode) return hadRelation ? change([], false, true) : NO_CHANGE;
    const before = this.selected,
      multi = [...this.multi];
    this.selected = null;
    this.multi.clear();
    return this.commit([before, ...multi], ctx, hadRelation);
  }
  /** Escape (1262-1270): everything cleared, mode off, relation off. */
  escape(ctx: CommitContext = {}): SelectionChange {
    const before = this.selected,
      multi = [...this.multi],
      wasMode = this.mode,
      hadRelation = this.relation !== null;
    this.selected = null;
    this.multi.clear();
    this.relation = null;
    this.mode = false;
    const stops = this.resetStop(ctx);
    return change([before, ...multi, ...stops], wasMode, hadRelation);
  }

  // ---- entering and leaving multi-select ----
  /** The "select topics" button (9548-9550): flips the mode and clears selected and multi. */
  toggleMultiSelect(): SelectionChange {
    const before = this.selected,
      multi = [...this.multi];
    this.mode = !this.mode;
    this.multi.clear();
    this.selected = null;
    return change([before, ...multi], true);
  }
  /** Leave multi-select. openMap (2006-2008) also drops selected; emptyMap (9532-9533) and backgroundRun (13231-13232) keep it. */
  exitMultiSelect(variant: ExitVariant): SelectionChange {
    const before = this.selected,
      multi = [...this.multi],
      wasMode = this.mode;
    this.mode = false;
    this.multi.clear();
    if (variant === "openMap") this.selected = null;
    return change([...(variant === "openMap" ? [before] : []), ...multi], wasMode);
  }
  /** Map chat picked topics (16508-16510). */
  chatSelect(ids: Iterable<string>): SelectionChange {
    return this.enterWith(ids);
  }
  /** A card's direct subtopics (17015-17017). */
  selectSubtopics(ids: Iterable<string>): SelectionChange {
    return this.enterWith(ids);
  }
  private enterWith(ids: Iterable<string>): SelectionChange {
    const before = this.selected,
      multi = [...this.multi],
      next = [...ids];
    this.multi = new Set(next);
    this.selected = null;
    this.mode = true;
    return change([before, ...multi, ...next], true);
  }
  /** Failed topics picked for another model (13384-13385): selected is kept. */
  retryFailed(ids: Iterable<string>): SelectionChange {
    const multi = [...this.multi],
      next = [...ids];
    this.multi = new Set(next);
    this.mode = true;
    return change([...multi, ...next], true);
  }
  /** Retry with another provider (13375): the set only; the mode is not touched. */
  replaceMulti(ids: Iterable<string>): SelectionChange {
    const multi = [...this.multi],
      next = [...ids];
    this.multi = new Set(next);
    return change([...multi, ...next]);
  }

  // ---- reassignment after a structural operation ----
  /** Deleted or moved to Unassigned (5207-5208, 7444-7445): selected and multi cleared; the mode stays. */
  afterRemove(): SelectionChange {
    const before = this.selected,
      multi = [...this.multi];
    this.selected = null;
    this.multi.clear();
    return change([before, ...multi]);
  }
  /** New branches written (7734): multi cleared; selected is set separately by setSelected. */
  afterPaste(): SelectionChange {
    const multi = [...this.multi];
    this.multi.clear();
    return change(multi);
  }
  /** Branches moved (7492): multi cleared only when the caller asks. */
  afterMove(clearSelection: boolean): SelectionChange {
    return clearSelection ? this.afterPaste() : NO_CHANGE;
  }
  /** Merge (5705-5707, 5791-5793). */
  afterMerge(id: string): SelectionChange {
    return this.landOn(id);
  }
  /** Synthesis saved (14638-14640, 14672-14674). Same result as afterMerge today. */
  afterSynthesis(id: string): SelectionChange {
    return this.landOn(id);
  }
  private landOn(id: string): SelectionChange {
    const before = this.selected,
      multi = [...this.multi],
      wasMode = this.mode;
    this.mode = false;
    this.selected = id;
    this.multi.clear();
    return change([before, id, ...multi], wasMode);
  }

  // ---- pruning ----
  /** Drop selected and multi ids that no longer exist (9615-9616). The mode is left as it is. */
  prune(existing: ReadonlySet<string>): SelectionChange {
    const touched: string[] = [];
    if (this.selected !== null && !existing.has(this.selected)) {
      touched.push(this.selected);
      this.selected = null;
    }
    for (const id of [...this.multi])
      if (!existing.has(id)) {
        touched.push(id);
        this.multi.delete(id);
      }
    return touched.length ? change(touched) : NO_CHANGE;
  }
  /** Merge undo/redo (5838): only the selected id is pruned. */
  pruneSelectedOnly(existing: ReadonlySet<string>): SelectionChange {
    if (this.selected === null || existing.has(this.selected)) return NO_CHANGE;
    const gone = this.selected;
    this.selected = null;
    return change([gone]);
  }
  /** A relation line that is gone cannot stay selected (18061). */
  pruneRelation(existingKeys: ReadonlySet<string>): SelectionChange {
    if (this.relation === null || existingKeys.has(this.relation)) return NO_CHANGE;
    this.relation = null;
    return change([], false, true);
  }

  // ---- relation line ----
  /** Pointer down, click or focus on a line or its row (18032, 18038, 18181, 11724). */
  selectRelation(key: string): SelectionChange {
    if (this.relation === key) return NO_CHANGE;
    this.relation = key;
    return change([], false, true);
  }
  /** Blur of a row, or the edited relation was removed (18185, 11716): only the same key is cleared. */
  deselectRelation(key: string): SelectionChange {
    if (this.relation !== key) return NO_CHANGE;
    this.relation = null;
    return change([], false, true);
  }

  // ---- tab stop ----
  /** Back to the default stop (9618, 10562). */
  resetTabStop(shown: readonly ShownTopic[]): SelectionChange {
    return change(this.resetStop({ shown }));
  }
  /** Keyboard focus moved in multi-select (10504-10507). */
  moveTabStop(id: string | null): SelectionChange {
    const before = this.tabStop;
    this.tabStop = id;
    return change([before, id]);
  }

  // ---- presentation mode ----
  /** Copy of selected and multi for the presentation session (1565-1566). */
  stash(): SelectionSnapshot {
    return Object.freeze({ selected: this.selected, multiSelected: Object.freeze([...this.multi]) });
  }
  /** Put the stash back, dropping ids that no longer exist (1701-1703). It commits like a click; the mode is not touched. */
  restore(snapshot: SelectionSnapshot, existing: ReadonlySet<string>, ctx: CommitContext = {}): SelectionChange {
    const before = this.selected,
      multi = [...this.multi];
    this.selected = snapshot.selected !== null && existing.has(snapshot.selected) ? snapshot.selected : null;
    this.multi = new Set(snapshot.multiSelected.filter(id => existing.has(id)));
    return this.commit([before, this.selected, ...multi, ...this.multi], ctx);
  }

  /** The commit path of the view (commitSelection -> applySelectionState): ends a relation selection, resets the tab stop. */
  private commit(ids: Iterable<string | null>, ctx: CommitContext, relationAlready = false): SelectionChange {
    const hadRelation = this.relation !== null;
    this.relation = null;
    const stops = this.resetStop(ctx);
    return change([...ids, ...stops], false, hadRelation || relationAlready);
  }
  private resetStop(ctx: CommitContext): string[] {
    if (!ctx.shown) return [];
    const before = this.tabStop;
    this.tabStop = defaultTabStop(this.selected, ctx.shown);
    return [before, this.tabStop].filter((id): id is string => id !== null);
  }
}
