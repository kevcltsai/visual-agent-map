import type VisualAgentMapPlugin from "../../main";
import { t, type ContentLanguage, type UiLanguage } from "../../i18n";
import type { History, MapDocument } from "../../map-model";
import {
  normalizeRelevanceContext,
  normalizeRelevanceGoal,
  type NoteRelevance,
  type RelevanceTier
} from "../../note-values";
import type { Note } from "../../repository";
import { buildStructureReviewNodes, type StructureNode } from "../../core/structure-review-service";
import type {
  GoalRecommendChange,
  GoalRecommendItem,
  GoalRecommendOutcome,
  GoalRecommendReceived,
  GoalRecommendRequest,
  GoalRecommendResult,
  GoalRecommendRun,
  GoalRecommendScope,
  GoalRecommendSuggestion
} from "../../core/goal-recommend-service";
import { goalRecommendFailureDetail } from "../../core/goal-recommend-service";
import { raiseParents, type RelevancePin } from "./relevance-pins";

interface Action {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  label?: string;
}
/** Message of any thrown value, without relying on instanceof Error (errors may cross realms). */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}
/** Identifies one relevance grading run, so a late result can tell it is no longer the current one. */
let relevanceRunToken = 0;
export interface RelevanceGradePorts {
  plugin(): VisualAgentMapPlugin;
  path(): string;
  closed(): boolean;
  map(): MapDocument | null;
  notes(): Map<string, Note>;
  history(): History<Action>;
  paintCount(): number;
  gradeable(): boolean;
  notesLoading(): boolean;
  dropGoalSuggest(): void;
  setGoal(goal: string, context: string | undefined): void;
  aiGrades(): RelevancePin[];
  pins(): RelevancePin[];
  describe(id: string): { title: string; summary: string; status: string } | undefined;
  usageMapField(): { usageMapPath?: string };
  contentLanguage(language: UiLanguage): ContentLanguage;
  lockedParent(parentId: string): boolean;
  refresh(focusBar?: boolean): void;
  paintReceived(run: GoalRecommendRun): void;
  updateHistoryButtons(): void;
  openRecommendations(run: GoalRecommendRun, mapPath: string, suggestions: GoalRecommendSuggestion[]): void;
  notice(message: string): void;
}
/** One view's relevance grading: start, apply, undo/redo, stop and abort of a run kept in the plugin's map by path. */
export class RelevanceGradeRun {
  /** True once this view has started a relevance grading run (so closing it has a run to abort). */
  started = false;
  constructor(
    private readonly owner: object,
    private readonly ports: RelevanceGradePorts
  ) {}
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
  private get paintCount(): number {
    return this.ports.paintCount();
  }
  isCurrent(run: GoalRecommendRun, mapPath: string): boolean {
    return (
      !this.closed &&
      this.path === mapPath &&
      this.plugin.relevanceGrades.get(mapPath) === run &&
      run.status === "running" &&
      !run.controller.signal.aborted
    );
  }
  /** Whether this view owns a grading run that is still running (what closing or switching the map would stop). */
  isRunning(): boolean {
    if (!this.started || !this.path) return false;
    const run = this.plugin.relevanceGrades.get(this.path);
    return run?.owner === this.owner && run.status === "running";
  }
  /** View closed or map switched: stop this view's run and forget it. A late result then fails every fence. */
  abort(mapPath = this.path): void {
    if (!this.started) return;
    const run = this.plugin.relevanceGrades.get(mapPath);
    if (!run || run.owner !== this.owner) return;
    this.plugin.relevanceGrades.delete(mapPath);
    run.controller.abort();
  }
  finish(run: GoalRecommendRun, mapPath: string, status: "failed" | "declined", message: string): void {
    if (!this.isCurrent(run, mapPath)) return;
    this.plugin.releaseWarmClaude?.();
    run.received = undefined;
    run.status = status;
    run.message = message;
    this.ports.refresh();
  }
  /**
   * Enter in the goal field, the goal icon, or the chat's `rate_by_goal`. The goal is saved first (its own undo step),
   * then, after the usage confirmation, ONE request recommends new cards and rates the map. The scope is decided by the
   * repository (a changed setup, or a map without AI tiers, asks for every card; otherwise only what should change).
   * Nothing is written when the AI is declined, stopped, fails or returns a reply the strict parser refuses; there is no
   * repair round and no second call. The recommended cards open as a list once the tiers are written.
   */
  async start(raw: string, contextRaw?: string): Promise<void> {
    const goal = normalizeRelevanceGoal(raw);
    const context = contextRaw === undefined ? undefined : normalizeRelevanceContext(contextRaw);
    const mapPath = this.path;
    if (!goal || !this.ports.gradeable() || this.ports.notesLoading()) return;
    if (this.plugin.relevanceGrades.get(mapPath)?.status === "running") return;
    // The run takes over the spot under the bar: an open list or a waiting suggestion call is dropped.
    this.ports.dropGoalSuggest();
    const run: GoalRecommendRun = {
      token: ++relevanceRunToken,
      owner: this.owner,
      controller: new AbortController(),
      goal,
      status: "running",
      startedAt: Date.now()
    };
    // Claim the map before the first await, so a second Enter cannot start another run.
    this.plugin.relevanceGrades.set(mapPath, run);
    this.started = true;
    // Stop, closing the view or switching maps before the run took the pre-started process leaves nothing waiting.
    run.controller.signal.addEventListener("abort", () => this.plugin.releaseWarmClaude?.(), { once: true });
    this.ports.refresh(true);
    const settings = this.plugin.settings;
    let result: GoalRecommendResult | undefined;
    let basis: StructureNode[] = [];
    let scope: GoalRecommendScope = "all";
    let pins: RelevancePin[] = [];
    try {
      await this.plugin.mutate(async () => {
        const { previous, next, setupChanged } = await this.plugin.repo.writeRelevanceGoal(mapPath, goal, context);
        if (this.path !== mapPath) return;
        this.ports.setGoal(goal, context);
        // The repository has the last word: a changed setup, or a map with no AI tier yet, is rated in full.
        scope = setupChanged || !this.ports.aiGrades().length ? "all" : "current";
        // Goal and context are one undo step; none changed means nothing to undo.
        if (!setupChanged) return;
        this.history.push({
          label: t("ui.relevance_goal_history_label"),
          undo: () => this.plugin.repo.restoreRelevanceGoal(mapPath, previous),
          redo: () => this.plugin.repo.restoreRelevanceGoal(mapPath, next)
        });
        this.ports.updateHistoryButtons();
      });
      const { model, reasoning } = this.plugin.currentModelChoice();
      // The run stays "running" (the map is locked and Stop works) but the bar must not claim recommending while the
      // usage notice waits for an answer. Only a notice that really opens needs the bar to say so.
      if (this.plugin.usageNoticePending?.(model)) {
        run.awaitingUsage = true;
        this.ports.refresh();
      }
      const started = await this.plugin.confirmAiUsage(model, async () => {
        // Stopped, or the map changed, while the usage dialog was open.
        if (!this.isCurrent(run, mapPath) || !this.map) return;
        if (run.awaitingUsage) {
          run.awaitingUsage = false;
          // The seconds count the model's work, not the wait for the usage notice.
          run.startedAt = Date.now();
          this.ports.refresh();
        }
        basis = buildStructureReviewNodes(this.map.nodes, id => this.ports.describe(id));
        // Pinned (hand-set) and locked cards are the learner's: the AI sees them as anchors and never rates them.
        pins = this.ports.pins();
        const lockedIds = basis
          .filter(node => node.parentId !== null && this.notes.get(node.id)?.aiLocked)
          .map(node => node.id);
        const request: GoalRecommendRequest = {
          goal,
          ...(context ? { context } : {}),
          nodes: basis,
          language: settings.language,
          contentLanguage: this.ports.contentLanguage(settings.language),
          model,
          reasoning,
          ...(pins.length ? { pins } : {}),
          ...(lockedIds.length ? { lockedIds } : {}),
          scope,
          // Scope `all` sends no earlier tier: the model rates every card from scratch.
          ...(scope === "current" ? { current: this.ports.aiGrades() } : {}),
          ...this.ports.usageMapField()
        };
        const hooks = {
          // Text only: the count changes in place, the map is not repainted for it.
          onProgress: (progress: GoalRecommendReceived | null) => {
            if (!this.isCurrent(run, mapPath)) return;
            run.received = progress ?? undefined;
            this.ports.paintReceived(run);
          }
        };
        result = await this.plugin.goalRecommend.recommend(request, run.controller.signal, hooks);
      });
      if (!this.isCurrent(run, mapPath)) return;
      if (!started) return this.finish(run, mapPath, "declined", t("ui.relevance_not_started"));
      const answered: GoalRecommendResult | undefined = result;
      if (!answered) return;
      // Writing the notes makes the view synchronize, which repaints when a note changed (the run is already "done"
      // by then); repaint here only when it did not, so a run costs one repaint after the write.
      const paintedBefore = this.paintCount;
      await this.plugin.mutate(() => this.apply(run, mapPath, basis, answered, { scope, pins }));
      if (this.paintCount === paintedBefore) this.ports.refresh();
      this.ports.openRecommendations(run, mapPath, answered.suggestions);
    } catch (error) {
      this.finish(
        run,
        mapPath,
        "failed",
        t("ui.relevance_failed_0", goalRecommendFailureDetail(error, this.plugin.settings.language))
      );
    }
  }
  /**
   * Writes the tiers as one undo step. Each card is checked against what the AI was shown: a card deleted, renamed or
   * moved meanwhile is skipped (its old tier stays), and cards added meanwhile are not in the result so they stay
   * unrated. A card never ranks below one it holds: the program raises such a parent (any number of levels) in the same
   * write and the same undo step, unless the parent is hand-set, locked, outside what the AI saw, or changed meanwhile.
   * A note that cannot be written is counted; the undo step covers only the notes actually written.
   */
  async apply(
    run: GoalRecommendRun,
    mapPath: string,
    basis: StructureNode[],
    graded: GoalRecommendResult,
    meta: { scope: GoalRecommendScope; pins: RelevancePin[] }
  ): Promise<void> {
    if (!this.isCurrent(run, mapPath) || !this.map) return;
    const items: GoalRecommendItem[] = graded.items;
    run.writing = true;
    run.received = undefined;
    const startedAt = Date.now();
    const repo = this.plugin.repo;
    const fresh = new Map<string, Note>();
    for (const node of this.map.nodes) {
      try {
        fresh.set(node.id, await repo.readNote(node.path, this.map));
      } catch {
        /* A card whose note cannot be read counts as changed and is skipped below. */
      }
    }
    const current = new Map(
      buildStructureReviewNodes(this.map.nodes, id => {
        const note = fresh.get(id);
        return note ? { title: note.title, summary: "", status: "" } : undefined;
      }).map(node => [node.id, node])
    );
    // Parent before child, over every card the map holds now (not only the ones the AI saw).
    const tree = buildStructureReviewNodes(this.map.nodes, () => undefined).map(node => ({
      id: node.id,
      parentId: node.parentId
    }));
    const pathOf = new Map(this.map.nodes.map(node => [node.id, node.path]));
    const byId = new Map(items.map(item => [item.id, item]));
    const titleOf = new Map(basis.map(base => [base.id, base.title]));
    const pinned = new Set(meta.pins.map(pin => pin.id));
    const outcome: GoalRecommendOutcome = {
      graded: 0,
      changes: [],
      skipped: 0,
      failed: 0,
      pinned: 0,
      scope: meta.scope,
      raised: 0,
      // The list drops cards under a locked parent, so only the ones it will show are counted.
      recommended: graded.suggestions.filter(item => !this.ports.lockedParent(item.parentId)).length,
      pins: meta.pins.map(pin => ({ id: pin.id, title: titleOf.get(pin.id) ?? "", tier: pin.tier })),
      conflicts: (graded.conflicts ?? []).map(conflict => ({
        ancestor: titleOf.get(conflict.ancestorId) ?? "",
        ancestorTier: conflict.ancestorTier,
        descendant: titleOf.get(conflict.descendantId) ?? "",
        descendantTier: conflict.descendantTier
      })),
      ...(graded.pinnedIgnored ? { pinnedIgnored: graded.pinnedIgnored } : {}),
      ...(graded.anchorsDropped ? { anchorsDropped: graded.anchorsDropped } : {}),
      ...(graded.unchangedIgnored ? { unchangedIgnored: graded.unchangedIgnored } : {})
    };
    try {
      // Which cards the AI may write: seen by the AI, unchanged since, not locked, not hand-set.
      const writable = new Set<string>();
      for (const base of basis) {
        if (base.parentId === null) continue;
        const now = current.get(base.id),
          note = fresh.get(base.id);
        const item = byId.get(base.id);
        if (!now || !note || !pathOf.get(base.id) || now.title !== base.title || now.parentId !== base.parentId) {
          if (item) outcome.skipped++;
          continue;
        }
        if (note.aiLocked) {
          // AI lock: a locked card keeps its tier, like a hand-set one, and is counted as skipped.
          if (item) outcome.skipped++;
          continue;
        }
        if (note.relevance?.manual) {
          // A hand-set (pinned) card is never written by the AI, whatever the AI said.
          pinned.add(base.id);
          continue;
        }
        writable.add(base.id);
      }
      // Merged result: what the notes hold now, plus the AI's tier for every card it may write.
      const merged = new Map<string, RelevanceTier>();
      for (const [id, note] of fresh) if (note.relevance) merged.set(id, note.relevance.tier);
      for (const item of items) if (writable.has(item.id)) merged.set(item.id, item.tier);
      // Everything else is frozen: its tier stays, though the height of what it holds still passes up. `raised` therefore
      // never names a frozen card, and a frozen card has no item here: this is the only gate on who is written.
      const frozen = new Set(tree.filter(node => !writable.has(node.id)).map(node => node.id));
      const raised = raiseParents(tree, merged, frozen);
      for (const base of basis) {
        const item = writable.has(base.id) ? byId.get(base.id) : undefined;
        const lift = raised.get(base.id);
        const tier = lift ?? item?.tier;
        if (!tier) continue;
        const note = fresh.get(base.id) as Note;
        const path = pathOf.get(base.id) as string;
        const after = { tier };
        const before = note.relevance ? { tier: note.relevance.tier } : undefined;
        if (before && before.tier === after.tier) {
          if (item) outcome.graded++;
          continue;
        }
        try {
          await repo.writeRelevance(path, after);
          if (item) outcome.graded++;
          if (lift) outcome.raised++;
          outcome.changes.push({
            id: base.id,
            path,
            title: note.title,
            before,
            after,
            ...(item?.anchor && !lift ? { anchor: item.anchor } : {}),
            ...(lift ? { raised: true } : {})
          });
        } catch (error) {
          outcome.failed++;
          this.plugin.logs.appendLog("error", t("log.operation_failed_0", errorMessage(error)));
        }
      }
    } finally {
      outcome.pinned = pinned.size;
      this.plugin.logs.appendLog(
        "info",
        `Relevance ${meta.scope}: raised ${outcome.raised}, suggestions ${graded.suggestions.length}, suggestionsDropped ${graded.dropped.length}, pinned ${pinned.size}, pinnedIgnored ${graded.pinnedIgnored ?? 0}, anchorsDropped ${graded.anchorsDropped ?? 0}, unchangedIgnored ${graded.unchangedIgnored ?? 0}, written ${outcome.changes.length}, failed ${outcome.failed}, skipped ${outcome.skipped}, ${Date.now() - startedAt} ms`
      );
      if (outcome.changes.length) {
        const changes = outcome.changes;
        const entry: Action = {
          label: t("ui.relevance_history_label"),
          undo: () => this.restore(changes, "undo"),
          redo: () => this.restore(changes, "redo")
        };
        this.history.push(entry);
        run.historyEntry = entry;
        this.ports.updateHistoryButtons();
      }
      run.outcome = outcome;
      run.status = "done";
    }
  }
  /**
   * Undo or redo a grading run. A note is only put back when it still holds exactly what the run wrote (or, for redo,
   * what it replaced); a note the owner edited since is left alone and counted in a Notice.
   */
  async restore(changes: GoalRecommendChange[], direction: "undo" | "redo"): Promise<void> {
    let skipped = 0;
    const same = (a: NoteRelevance | undefined, b: NoteRelevance | undefined): boolean =>
      a === b || (!!a && !!b && a.tier === b.tier && !!a.manual === !!b.manual);
    for (const change of changes) {
      const expected = direction === "undo" ? change.after : change.before;
      const replacement = direction === "undo" ? change.before : change.after;
      try {
        const latest = (await this.plugin.repo.readNote(change.path)).relevance;
        if (!same(latest, expected)) {
          skipped++;
          continue;
        }
        await this.plugin.repo.writeRelevance(change.path, replacement ?? null);
      } catch {
        skipped++;
      }
    }
    if (skipped) this.ports.notice(t("ui.relevance_undo_skipped_0", skipped));
  }
  stop(): void {
    const run = this.plugin.relevanceGrades.get(this.path);
    if (!run || run.status !== "running" || run.writing) return;
    run.status = "stopped";
    run.received = undefined;
    run.message = t("ui.relevance_stopped");
    run.controller.abort();
    this.ports.refresh();
  }
}
