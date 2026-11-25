import { errorMessage } from "../../core/error-message";
import type VisualAgentMapPlugin from "../../main";
import { t } from "../../i18n";
import type { History, MapDocument, MapNode } from "../../map-model";
import type { Note } from "../../repository";
import type { RelevanceTier } from "../../note-values";
import { buildStructureReviewNodes } from "../../core/structure-review-service";
import type { GoalRecommendChange, GoalRecommendSuggestion } from "../../core/goal-recommend-service";
import { goalRecommendTitleKey } from "../../core/goal-recommend-service";
import { raiseParents } from "./relevance-pins";
import { RELEVANCE_LABEL } from "./relevance-tag";

interface Action {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  label?: string;
}
let goalSuggestSeq = 0;
/**
 * The recommended cards of a finished run. `ready`: the list is shown; `applying`: Add was pressed and the cards are being
 * written. The controller makes no AI call: it only fences a late Add (a dropped task is aborted).
 */
export interface GoalSuggestTask {
  mapPath: string;
  token: number;
  controller: AbortController;
  state: "ready" | "applying";
  suggestions: GoalRecommendSuggestion[];
  /** What the AI saw of each parent (title, its parent): Add skips a suggestion whose parent no longer matches. */
  basis: Map<string, { title: string; parentId: string | null }>;
  checked: Set<number>;
  /** Where the keyboard goes when the panel is next drawn (consumed by the draw). */
  focus: "list" | null;
}
export interface GoalSuggestPorts {
  plugin(): VisualAgentMapPlugin;
  path(): string;
  closed(): boolean;
  map(): MapDocument | null;
  notes(): Map<string, Note>;
  history(): History<Action>;
  contentEl(): HTMLElement;
  render(): void;
  placeMapTools(): void;
  focusGoalReturn(): void;
  whenEditing(action: () => void): void;
  lockedParent(parentId: string, fresh?: ReadonlyMap<string, Note>): boolean;
  isMerging(id: string): boolean;
  describe(id: string): { title: string; summary: string; status: string } | undefined;
  freshNotesOf(ids: readonly string[]): Promise<Map<string, Note>>;
  addNode(parent: MapNode, title: string): Promise<void>;
  restoreRelevance(changes: GoalRecommendChange[], direction: "undo" | "redo"): Promise<void>;
  updateHistoryButtons(): void;
  announce(text: string): void;
  notice(message: string): void;
}
/** One view's "suggest new topics for the goal": the task, its outside-press listener and its list under the goal bar. */
export class GoalSuggest {
  /** The "suggest new topics for the goal" task: one at a time; it owns the AI call, the list and the Add press. */
  task: GoalSuggestTask | null = null;
  private cleanup: (() => void) | null = null;
  private panelEl: HTMLElement | null = null;
  private cancelFocusReturn: (() => void) | null = null;
  constructor(private readonly ports: GoalSuggestPorts) {}
  private get plugin(): VisualAgentMapPlugin {
    return this.ports.plugin();
  }
  private get path(): string {
    return this.ports.path();
  }
  private get closed(): boolean {
    return this.ports.closed();
  }
  private get map(): MapDocument | null {
    return this.ports.map();
  }
  private get notes(): Map<string, Note> {
    return this.ports.notes();
  }
  private get history(): History<Action> {
    return this.ports.history();
  }
  private get contentEl(): HTMLElement {
    return this.ports.contentEl();
  }
  /** A result, a stop or a failure only counts while this is true: the task is still the view's own, on the same map. */
  current(task: GoalSuggestTask): boolean {
    return !this.closed && this.task === task && task.mapPath === this.path && !task.controller.signal.aborted;
  }
  /** Drops the task (aborting its AI call), its listeners and its panel; the late result then fails the fence. */
  end(task: GoalSuggestTask, options: { refocus: boolean; repaint?: boolean }): void {
    if (this.task !== task) return;
    this.drop();
    if (this.closed) return;
    if (options.repaint !== false) this.ports.render();
    else this.ports.placeMapTools();
    if (options.refocus) this.ports.focusGoalReturn();
    else if (options.repaint === false) {
      // A press outside: the browser moves (or drops) the focus after this handler, so look again once it settled.
      this.scheduleFocusReturn(task.mapPath);
    }
  }
  private scheduleFocusReturn(mapPath: string): void {
    const doc = this.contentEl?.ownerDocument;
    const timerWindow = doc?.defaultView ?? window;
    const cancel = (): void => timerWindow.clearTimeout(handle);
    const handle = timerWindow.setTimeout(() => {
      if (this.cancelFocusReturn !== cancel) return;
      this.cancelFocusReturn = null;
      if (this.closed || this.task || this.path !== mapPath || this.contentEl?.ownerDocument !== doc) return;
      const active = doc?.activeElement ?? null;
      if (!active || active === doc?.body) this.ports.focusGoalReturn();
    }, 0);
    this.cancelFocusReturn = cancel;
  }
  /** Another surface (the goal editor, a new grading) takes the spot: the open task closes without a repaint. */
  dismiss(): void {
    if (this.task) this.end(this.task, { refocus: false, repaint: false });
  }
  /** The goal bar is redrawn: its old DOM is gone, so the listener and the panel handle are dropped (the task keeps running). */
  detach(): void {
    this.releaseListener();
    this.panelEl = null;
  }
  /** The view closes: only the document listener goes (the task is stopped by drop). */
  releaseListener(): void {
    this.cleanup?.();
    this.cleanup = null;
  }
  /** Ends the task and its resources without a repaint or focus change (map departure, close or replacement). */
  drop(): void {
    const cancel = this.cancelFocusReturn;
    this.cancelFocusReturn = null;
    cancel?.();
    const task = this.task;
    this.task = null;
    this.releaseListener();
    const panel = this.panelEl;
    this.panelEl = null;
    panel?.remove();
    task?.controller.abort();
  }
  /** True when `node` is inside the list that is on screen. */
  holdsFocus(node: Node): boolean {
    return !!this.panelEl?.contains?.(node);
  }
  /** Starts the task for the finished run's recommendations and shows the list. */
  open(mapPath: string, suggestions: GoalRecommendSuggestion[], takeFocus: boolean): void {
    this.drop();
    const task: GoalSuggestTask = {
      mapPath,
      token: ++goalSuggestSeq,
      controller: new AbortController(),
      state: "ready",
      suggestions: [],
      basis: new Map(),
      checked: new Set(),
      focus: null
    };
    this.task = task;
    this.show(task, suggestions, takeFocus);
  }
  /** Locked parents are dropped (counted in a Notice); when none is left the task closes; otherwise the list opens. */
  private show(task: GoalSuggestTask, suggestions: GoalRecommendSuggestion[], takeFocus = true): void {
    const kept = suggestions.filter(item => !this.ports.lockedParent(item.parentId));
    const locked = suggestions.length - kept.length;
    if (locked) this.ports.notice(t("ui.ai_locked_suggestions_skipped_0", locked));
    if (!kept.length) {
      this.end(task, { refocus: takeFocus });
      return;
    }
    for (const item of kept) {
      const parent = this.map?.nodes.find(node => node.id === item.parentId);
      task.basis.set(item.parentId, {
        title: this.ports.describe(item.parentId)?.title ?? "",
        parentId: parent?.parentId ?? null
      });
    }
    task.suggestions = kept;
    task.checked = new Set(kept.map((_, index) => index));
    task.state = "ready";
    task.focus = takeFocus ? "list" : null;
    this.ports.render();
  }
  /** The card under the bar: the checkable list (title, one-line summary, tier) with Skip and Add. Model text goes in as text only. */
  draw(bar: HTMLElement): void {
    const task = this.task;
    if (!task) return;
    if (!this.current(task)) {
      this.drop();
      return;
    }
    this.panelEl?.remove();
    this.detach();
    const panel = bar.createDiv("vam-goal-suggest vam-goal-attachment");
    this.panelEl = panel;
    const applying = task.state === "applying";
    const ready = (): boolean => this.panelEl === panel && this.current(task) && task.state === "ready";
    panel.setAttr("role", "group");
    panel.setAttr("aria-label", t("ui.goal_suggest_list_label"));
    const boxes: HTMLInputElement[] = [];
    // The rows scroll inside the card; the footer below stays in view (the card's max-height follows the canvas).
    const rows = panel.createDiv("vam-goal-suggest-rows");
    task.suggestions.forEach((item, index) => {
      const row = rows.createEl("label", { cls: "vam-goal-suggest-row" });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = task.checked.has(index);
      box.disabled = applying;
      boxes.push(box);
      const text = row.createSpan("vam-goal-suggest-text");
      text.createSpan({ cls: "vam-goal-suggest-title", text: item.title });
      // The summary and the tier are shown here only; Add writes the tier, never the summary.
      text.createSpan({ cls: "vam-goal-suggest-summary", text: item.summary });
      text.createSpan({
        cls: "vam-goal-suggest-why",
        text: t("ui.goal_suggest_under_0", task.basis.get(item.parentId)?.title ?? "")
      });
      row.createSpan({
        cls: `vam-goal-suggest-tier is-${item.suggestedTier}`,
        text: t(RELEVANCE_LABEL[item.suggestedTier])
      });
      box.addEventListener("change", () => {
        if (!ready()) return;
        if (box.checked) task.checked.add(index);
        else task.checked.delete(index);
        syncAdd();
      });
    });
    const foot = panel.createDiv("vam-goal-suggest-foot");
    const skip = foot.createEl("button", { cls: "vam-goal-suggest-skip", text: t("ui.goal_suggest_skip") });
    const add = foot.createEl("button", { cls: "vam-goal-suggest-add mod-cta" });
    const syncAdd = (): void => {
      add.setText(t("ui.goal_suggest_add_0", task.checked.size));
      add.disabled = applying || task.checked.size === 0;
    };
    syncAdd();
    skip.disabled = applying;
    skip.addEventListener("click", event => {
      if (!ready()) return;
      event.stopPropagation();
      this.end(task, { refocus: true });
    });
    add.addEventListener("click", event => {
      if (!ready()) return;
      event.stopPropagation();
      this.ports.whenEditing(() => void this.apply(task));
    });
    panel.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !ready()) return;
      event.preventDefault();
      event.stopPropagation();
      this.end(task, { refocus: true });
    });
    if (task.focus === "list") {
      task.focus = null;
      (boxes[0] ?? add).focus();
    }
    // A press anywhere else closes it without writing (the spark toggles it itself).
    const doc = this.contentEl?.ownerDocument;
    if (doc?.addEventListener && !applying) {
      const outside = (event: Event): void => {
        if (!ready()) return;
        const target = event.target as Node | null;
        const spark = bar.querySelector?.('.vam-goal-icon[data-goal-action="recommend"]');
        if (!target || panel.contains(target) || spark?.contains(target)) return;
        // The status bar and its changes window work with the list open: pressing them must not lose the recommendations.
        if (this.contentEl?.querySelector?.(".vam-relevance-statusbar")?.contains?.(target)) return;
        if ((target as Element).closest?.(".vam-relevance-summary-modal")) return;
        this.end(task, { refocus: false, repaint: false });
      };
      doc.addEventListener("pointerdown", outside, true);
      this.cleanup = () => doc.removeEventListener("pointerdown", outside, true);
    }
  }
  /**
   * Add: every checked suggestion is checked again inside the map write (parent still there, same name and place, not
   * AI-locked, title not taken meanwhile); the ones that no longer fit are skipped and counted. All the cards are one
   * undo step. No AI call: each new card gets the tier the list showed (not hand-set), and a parent that now ranks below
   * a card it holds is raised (same undo step). The summary is not written to the card.
   */
  private async apply(task: GoalSuggestTask): Promise<void> {
    if (!this.current(task) || task.state !== "ready" || !task.checked.size) return;
    task.state = "applying";
    const picked = [...task.checked].sort((a, b) => a - b).flatMap(index => task.suggestions[index] ?? []);
    this.releaseListener();
    this.ports.render();
    let added = 0;
    let skipped = 0;
    try {
      await this.plugin.mutate(async () => {
        if (!this.current(task)) {
          skipped = picked.length;
          return;
        }
        const fresh = await this.ports.freshNotesOf(picked.map(item => item.parentId));
        if (!this.current(task)) {
          skipped = picked.length;
          return;
        }
        const mark = this.history.mark();
        try {
          for (const item of picked) {
            const parent = this.map?.nodes.find(node => node.id === item.parentId);
            if (!this.current(task) || !this.map || !parent || this.stale(item, task, parent, fresh)) {
              skipped++;
              continue;
            }
            await this.ports.addNode(parent, item.title);
            const card = this.map.nodes.at(-1);
            if (card) {
              await this.plugin.repo.writeRelevance(card.path, { tier: item.suggestedTier });
              added++;
            }
          }
          if (added) await this.raiseParentsAfterAdd();
          if (added) await this.plugin.rebuildDerivedData();
        } finally {
          this.history.collapseSince(mark, t("ui.goal_suggest_history_label"));
          this.ports.updateHistoryButtons();
        }
      });
    } catch {
      // mutate() has already shown the failure; whatever was added before it is still counted below.
    }
    if (this.closed || this.task !== task) return;
    this.end(task, { refocus: !added });
    if (skipped) this.ports.notice(t("ui.goal_suggest_skipped_0", skipped));
    if (!added) return;
    this.ports.announce(t("ui.goal_suggest_added_0", added));
  }
  /**
   * After Add: a parent never ranks below a card it holds. Reads every note fresh, raises the AI-set parents above the
   * new cards (any number of levels), and records them as one history entry the surrounding collapse merges into the add
   * step. A hand-set or AI-locked parent keeps its tier (its height still passes up); top-level cards are never raised.
   */
  private async raiseParentsAfterAdd(): Promise<void> {
    if (!this.map) return;
    const repo = this.plugin.repo;
    const notes = new Map<string, Note>();
    for (const node of this.map.nodes) {
      try {
        notes.set(node.id, await repo.readNote(node.path, this.map));
      } catch {
        /* An unreadable note is frozen below: it is not raised. */
      }
    }
    const tree = buildStructureReviewNodes(this.map.nodes, () => undefined).map(node => ({
      id: node.id,
      parentId: node.parentId
    }));
    const tiers = new Map<string, RelevanceTier>();
    for (const [id, note] of notes) if (note.relevance) tiers.set(id, note.relevance.tier);
    const frozen = new Set(
      tree
        .filter(node => {
          const note = notes.get(node.id);
          return !note || note.aiLocked || !!note.relevance?.manual;
        })
        .map(node => node.id)
    );
    const raised = raiseParents(tree, tiers, frozen);
    const changes: GoalRecommendChange[] = [];
    for (const [id, tier] of raised) {
      const node = this.map.nodes.find(item => item.id === id);
      const note = notes.get(id);
      if (!node || !note?.relevance) continue;
      try {
        await repo.writeRelevance(node.path, { tier });
        changes.push({
          id,
          path: node.path,
          title: note.title,
          before: { tier: note.relevance.tier },
          after: { tier },
          raised: true
        });
      } catch (error) {
        this.plugin.logs.appendLog("error", t("log.operation_failed_0", errorMessage(error)));
      }
    }
    if (!changes.length) return;
    this.history.push({
      label: t("ui.relevance_history_label"),
      undo: () => this.ports.restoreRelevance(changes, "undo"),
      redo: () => this.ports.restoreRelevance(changes, "redo")
    });
  }
  /** True when the suggestion no longer fits the map as it is now. */
  private stale(
    item: GoalRecommendSuggestion,
    task: GoalSuggestTask,
    parent: MapNode,
    fresh: ReadonlyMap<string, Note>
  ): boolean {
    const basis = task.basis.get(item.parentId);
    const title = fresh.get(parent.id)?.title ?? this.ports.describe(parent.id)?.title ?? "";
    if (!basis || title !== basis.title || parent.parentId !== basis.parentId) return true;
    if (this.ports.isMerging(parent.id) || this.ports.lockedParent(parent.id, fresh)) return true;
    const key = goalRecommendTitleKey(item.title);
    return !!this.map?.nodes.some(node => goalRecommendTitleKey(this.notes.get(node.id)?.title ?? "") === key);
  }
}
