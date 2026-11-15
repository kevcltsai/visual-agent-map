import type { ModelChoice } from "../../ai/model-resolution";
import type { AiResult } from "../../ai/types";
import type { TopicAppearanceChange } from "../../repository";
import type { TransactionEntry } from "./map-transaction";

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
}
