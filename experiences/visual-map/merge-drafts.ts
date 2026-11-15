import type { DetailTemplate } from "../../ai/detail-templates";
import type { ModelChoice } from "../../ai/model-resolution";
import type { ReferenceGroup } from "../../ai/reference-materials";
import type { ResearchObserver } from "../../ai/research-observer";
import type { AiResult, TaskContext } from "../../ai/types";
import { isAiLockedError } from "../../core/ai-lock";
import { inLanguage, NONE } from "../../core/steps/_shared/fragments";
import { mergeRepair } from "../../core/steps/task/fragments";
import { findingList, type MergeCheckResult } from "../../core/steps/task/merge-check";
import { t, type ContentLanguage } from "../../i18n";
import type { TopicAppearanceChange } from "../../repository";
import type { TransactionEntry } from "./map-transaction";
import { mergeTitleFromResult } from "./merge-topics";
import { mergeGoalTask, mergeSupplementTask, noSummaryYet } from "./steps/fragments";

/** The AI merge that hid its dialog: owned by the view, one per map. It writes nothing until the draft is confirmed. */
/** A chat reply's undo step, still open to the one AI merge the reply started (it lands later and joins the step). */
export interface ChatReplyStep {
  entry: TransactionEntry;
  absorb: (entry: TransactionEntry) => Promise<void>;
}
export interface MergeTask {
  /** The reply step this merge may join when it is written (the chat's merge); see {@link ChatReplyStep}. */
  replyStep?: ChatReplyStep;
  mapPath: string;
  mapId: string;
  mapTitle: string;
  /** The fallback name (first source's title) until the AI names the topic; then the AI's name. */
  title: string;
  /** The name was given by the user (the map chat's merge): the AI's suggested name does not replace it. */
  keepTitle?: boolean;
  /** The map chat's "make it red" of the same reply: written to the merged card (the sources go to Unassigned). */
  appearance?: TopicAppearanceChange;
  sources: { id: string; path: string }[];
  parentId: string | null;
  /** Parent mode: the parent topic that keeps its card (first of `sources`); null when a new topic replaces siblings. */
  targetId: string | null;
  model: string;
  reasoning: ModelChoice["reasoning"];
  /** The sources as sent to the model (JSON of the reference documents); compared again before the draft is saved. */
  sourceContent: string;
  /** The model's additions from the map's data sources (written as a separate block, never into the merged text). */
  supplement?: string;
  /** The supplement request failed: the block says so instead of silently leaving the sources out. */
  supplementFailed?: boolean;
  controller: AbortController;
  /** running: the model works (Stop works); applying: the result is being written; a task that ends is removed. */
  state: "running" | "applying";
  draft?: AiResult;
  /** The request in flight (tests await it). */
  run?: Promise<void>;
}

/** What the merge drafts need from their view; each is a late-bound call into the view (tests override the targets). */
export interface MergeDraftPorts {
  path(): string;
  closed(): boolean;
  changed(): void;
  language(): ContentLanguage;
  detailTemplate(language: ContentLanguage): DetailTemplate;
  progress(task: MergeTask): { observer?: ResearchObserver; end: () => void };
  snapshot(
    sources: { id: string; path: string }[],
    signal: AbortSignal
  ): Promise<{ group: ReferenceGroup; mapGroups: ReferenceGroup[]; content: string }>;
  ask(
    context: TaskContext,
    model: string,
    reasoning: ModelChoice["reasoning"],
    signal: AbortSignal,
    observer: ResearchObserver | undefined
  ): Promise<AiResult>;
  check(task: MergeTask, result: AiResult): Promise<MergeCheckResult>;
  recordFailure(label: string, error: unknown): string;
  notice(message: string): void;
  /** Writes the merged result (the view's History, selection and Undo Notice); the only write port. */
  write(task: MergeTask, result: AiResult, check: MergeCheckResult): Promise<void>;
}

/** The AI merges of one view: the task per map, who still owns a card, and Stop. Writing stays in the view. */
export class MergeDrafts {
  /** AI merges that hid their dialog, keyed by map path (one per map). */
  readonly tasks = new Map<string, MergeTask>();
  constructor(private readonly ports: MergeDraftPorts) {}
  /** True while an AI merge on this map still holds the card (running or being written): the card is locked. */
  isMerging(nodeId: string, except?: MergeTask): boolean {
    return [...(this.tasks?.values() ?? [])].some(
      merge =>
        merge !== except && merge.mapPath === this.ports.path() && merge.sources.some(source => source.id === nodeId)
    );
  }
  has(mapPath: string): boolean {
    return this.tasks.has(mapPath);
  }
  isRunning(): boolean {
    return this.tasks.size > 0;
  }
  isLive(task: MergeTask): boolean {
    return this.tasks.get(task.mapPath) === task && !task.controller.signal.aborted && !this.ports.closed();
  }
  forget(mapPath: string, task: MergeTask): void {
    if (this.tasks.get(mapPath) === task) this.tasks.delete(mapPath);
  }
  /** Stop, or clear a finished one: the run is aborted and forgotten, so a late result changes nothing. */
  stop(task: MergeTask): void {
    this.forget(task.mapPath, task);
    task.controller.abort();
    this.ports.changed();
  }
  /** The view closes: every run is aborted first, then all are forgotten. */
  stopAll(): void {
    for (const task of this.tasks.values()) task.controller.abort();
    this.tasks.clear();
  }
  /** Registers a started merge: the task is set, `registered` runs (dialog hidden, started, render), then the run starts. */
  start(task: MergeTask, registered: () => void): MergeTask {
    this.tasks.set(task.mapPath, task);
    registered();
    task.run = this.run(task);
    return task;
  }
  /** The model call of an AI merge; a stopped, replaced or late run changes nothing. */
  async run(task: MergeTask): Promise<void> {
    const language = this.ports.language();
    const progress = this.ports.progress(task);
    try {
      const snapshot = await this.ports.snapshot(task.sources, task.controller.signal);
      const sourceGroup = snapshot.group;
      if (!this.isLive(task)) return;
      task.sourceContent = snapshot.content;
      const request: TaskContext = {
        title: t("ui.merge_ai_untitled"),
        summary: noSummaryYet(language),
        rules: "",
        detail: "",
        task: mergeGoalTask(language),
        ancestors: "",
        referenceGroups: [sourceGroup],
        // Within budget the sources go in as written (one request); only over-budget sources are extracted first.
        referenceDelivery: "direct",
        outputLanguage: language,
        mode: "merge",
        usageMapPath: task.mapPath,
        researchMode: "local",
        researchDepth: "normal",
        visualMode: "off",
        detailTemplate: this.ports.detailTemplate(language)
      };
      const ask = (context: TaskContext): Promise<AiResult> =>
        // Each request is its own attempt of one entry: the repair request clears the first request's preview.
        this.ports.ask(context, task.model, task.reasoning, task.controller.signal, progress.observer);
      /** The sources must still be what the model was given; a change during any request fails with the stale message. */
      const sourcesUnchanged = async (): Promise<boolean> => {
        if (!this.isLive(task)) return false;
        const latest = await this.ports.snapshot(task.sources, task.controller.signal);
        if (!this.isLive(task)) return false;
        if (latest.content !== task.sourceContent) throw new Error(t("ui.merge_draft_stale"));
        return true;
      };
      let result = await ask(request);
      if (!(await sourcesUnchanged())) return;
      if (!task.keepTitle) task.title = mergeTitleFromResult(result, task.title);
      // Programmatic content check, one repair round; whatever is still wrong then is applied with a warning.
      let check = await this.ports.check(task, result);
      if (!check.ok) {
        try {
          const repaired = await ask({
            ...request,
            summary: result.summary,
            detail: result.detail,
            task: mergeRepair(
              language,
              findingList(check.missing, inLanguage(NONE, language)),
              findingList(check.added, inLanguage(NONE, language)),
              task.title
            )
          });
          if (!(await sourcesUnchanged())) return;
          const again = await this.ports.check(task, repaired);
          // A repair that made it worse is not used.
          if (again.missing.length + again.added.length <= check.missing.length + check.added.length) {
            result = repaired;
            check = again;
            if (!task.keepTitle) task.title = mergeTitleFromResult(result, task.title);
          }
        } catch (error) {
          if (task.controller.signal.aborted || this.ports.closed() || !this.isLive(task)) throw error;
          if (error instanceof Error && error.message === t("ui.merge_draft_stale")) throw error;
          this.ports.recordFailure(t("log.merge_failed"), error);
        }
      }
      // The map's data sources only ever add a separate block after the merged text: the request that wrote the merged text
      // never saw them, so nothing in them can change what the cards say.
      if (snapshot.mapGroups.some(group => group.documents.length)) {
        try {
          const supplement = await ask({
            ...request,
            summary: result.summary,
            detail: result.detail,
            task: mergeSupplementTask(language),
            referenceGroups: snapshot.mapGroups
          });
          if (!(await sourcesUnchanged())) return;
          task.supplement = supplement.detail;
        } catch (error) {
          if (task.controller.signal.aborted || this.ports.closed() || !this.isLive(task)) throw error;
          if (error instanceof Error && error.message === t("ui.merge_draft_stale")) throw error;
          // The cards' merge is still good: it is written, with a line saying the sources were not read.
          this.ports.recordFailure(t("log.merge_failed"), error);
          task.supplement = "";
          task.supplementFailed = true;
        }
      }
      // The result is final: the unsaved preview goes away before anything is written.
      progress.end();
      task.state = "applying";
      task.draft = result;
      this.ports.changed();
      await this.ports.write(task, result, check);
    } catch (error) {
      // Nothing was written (a write that fails midway has already rolled itself back); the task is forgotten.
      const live = this.tasks.get(task.mapPath) === task;
      if (live) this.forget(task.mapPath, task);
      if (!this.ports.closed()) this.ports.changed();
      if (task.controller.signal.aborted || this.ports.closed()) return;
      const stale = error instanceof Error && error.message === t("ui.merge_draft_stale");
      if (isAiLockedError(error)) this.ports.notice(t("ui.ai_locked_notice"));
      else
        this.ports.notice(stale ? t("ui.merge_draft_stale") : this.ports.recordFailure(t("log.merge_failed"), error));
    } finally {
      progress.end();
    }
  }
}
