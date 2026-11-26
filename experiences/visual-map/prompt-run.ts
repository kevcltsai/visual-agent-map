/**
 * Prompt topics and "run all": pure planning helpers (no Obsidian, no I/O).
 *
 * A Prompt topic is a topic whose note has a non-empty Prompt. "Run all" runs the Prompt topics of a subtree from the leaves
 * to the root: a leaf runs the research, a topic with children runs the integration over its children's summaries. A topic with
 * an empty Prompt never runs: its own summary stands in, and it stops the chain (its children's results do not pass upward
 * through it, and their failure does not block its parent).
 */

export type PromptRunStatus = "idle" | "running" | "done" | "stale" | "blocked";

export interface PromptNodeRef {
  id: string;
  parentId?: string | null;
}
/** What the plan reads of a note; a note that is not loaded reads as `undefined`. */
export interface PromptNoteRef {
  prompt: string;
  researchMode: "local" | "research";
  reuseLastResult?: boolean;
  aiLocked?: boolean;
}
export type PromptNoteOf = (id: string) => PromptNoteRef | undefined;

export interface PromptPlanItem {
  id: string;
  /** What running it does: a leaf researches, a topic with children integrates them. */
  kind: "research" | "integrate";
  /** `run` calls the AI; `reuse` keeps the last returned summary (the switch is on, or the topic is AI-locked). */
  action: "run" | "reuse";
  /** Run only: the note's saved mode is Standard (the research searches the web). */
  web: boolean;
}
export interface PromptPlan {
  /** Every Prompt topic of the scope, children before parents. */
  order: PromptPlanItem[];
  /** The topics that will call the AI (`order` items with action "run"), in order. */
  run: PromptPlanItem[];
  reuse: PromptPlanItem[];
  counts: { run: number; web: number; reuse: number };
}

export const isPromptTopic = (note: PromptNoteRef | undefined): boolean => !!note && (note.prompt ?? "").trim() !== "";

const childrenOf = (nodes: readonly PromptNodeRef[]): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId == null) continue;
    const list = out.get(node.parentId);
    if (list) list.push(node.id);
    else out.set(node.parentId, [node.id]);
  }
  return out;
};

/** True when the topic has a Prompt: the entry points ask this before showing "run all". */
export function hasPromptTopic(nodes: readonly PromptNodeRef[], noteOf: PromptNoteOf): boolean {
  return nodes.some(node => isPromptTopic(noteOf(node.id)));
}

/**
 * The run of a subtree (`scopeId`) or of the whole map (`null`): the Prompt topics in post-order. A reused topic stays in the
 * order (its parent reads its summary) but is not run. A cycle in the parent links is walked once.
 */
export function planPromptRun(
  nodes: readonly PromptNodeRef[],
  noteOf: PromptNoteOf,
  scopeId: string | null
): PromptPlan {
  const kids = childrenOf(nodes);
  const present = new Set(nodes.map(node => node.id));
  const roots = scopeId
    ? present.has(scopeId)
      ? [scopeId]
      : []
    : nodes.filter(node => node.parentId == null || !present.has(node.parentId)).map(node => node.id);
  const seen = new Set<string>();
  const order: PromptPlanItem[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const children = kids.get(id) ?? [];
    for (const child of children) visit(child);
    const note = noteOf(id);
    if (!note || !isPromptTopic(note)) return;
    const kind = children.length ? "integrate" : "research";
    const reuse = note.reuseLastResult === true || note.aiLocked === true;
    order.push({
      id,
      kind,
      action: reuse ? "reuse" : "run",
      web: !reuse && kind === "research" && note.researchMode === "research"
    });
  };
  for (const root of roots) visit(root);
  const run = order.filter(item => item.action === "run");
  const reuse = order.filter(item => item.action === "reuse");
  return {
    order,
    run,
    reuse,
    counts: { run: run.length, web: run.filter(item => item.web).length, reuse: reuse.length }
  };
}

/**
 * The direct children of a topic that stop it: Prompt topics, not reused, that `isBad` (failed or stuck) says no to. A child with
 * an empty Prompt and a reused child never block.
 */
export function blockingChildren(
  nodes: readonly PromptNodeRef[],
  noteOf: PromptNoteOf,
  parentId: string,
  isBad: (id: string) => boolean
): string[] {
  return (childrenOf(nodes).get(parentId) ?? []).filter(id => {
    const note = noteOf(id);
    return isPromptTopic(note) && note?.reuseLastResult !== true && note?.aiLocked !== true && isBad(id);
  });
}

/** The Prompt ancestors above a topic that a new result makes out of date: the unbroken chain upward, stopping at an empty Prompt. */
export function staleAncestors(nodes: readonly PromptNodeRef[], noteOf: PromptNoteOf, fromId: string): string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const out: string[] = [];
  const seen = new Set([fromId]);
  let parent = byId.get(fromId)?.parentId ?? null;
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    if (!isPromptTopic(noteOf(parent))) break;
    out.push(parent);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return out;
}

/** An edge is drawn with an arrow when both ends are Prompt topics. */
export const isPromptEdge = (noteOf: PromptNoteOf, parentId: string, childId: string): boolean =>
  isPromptTopic(noteOf(parentId)) && isPromptTopic(noteOf(childId));

const SOURCE_LINE = /^[\s>]*(?:資料來源|资料来源|数据来源|sources?)\s*[:：]\s*(.*)$/i;
/**
 * The note links on the "資料來源：" line(s) of a Prompt (`[[A]]`, `[[A|alias]]`, `[[A#heading]]` give `A`). Only the line's
 * links count: a URL, a plain name or a link elsewhere in the Prompt is not a source here. Order kept, duplicates dropped.
 */
export function promptSourceLinks(prompt: string): string[] {
  const out: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const rest = SOURCE_LINE.exec(line)?.[1];
    if (rest === undefined) continue;
    for (const match of rest.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = match[1].trim();
      if (target && !out.includes(target)) out.push(target);
    }
  }
  return out;
}

export interface PromptOutcome {
  /** Topics that ran and wrote. */
  done: number;
  /** Topics whose own run failed. */
  failed: number;
  /** Topics not run because a Prompt child failed or was stuck. */
  blocked: number;
  /** True when Stop (or closing the view) ended the batch early. */
  stopped: boolean;
}

export interface PromptRunDeps {
  nodes: readonly PromptNodeRef[];
  noteOf: PromptNoteOf;
  signal: AbortSignal;
  /** True when this batch's status of the topic is "stuck": failed, or not run because a child failed. */
  isBad: (id: string) => boolean;
  setStatus: (id: string, status: PromptRunStatus, reason?: string) => void;
  /** Runs one topic's research or integration; throws (or rejects) with the reason when it did not write. */
  runItem: (item: PromptPlanItem) => Promise<void>;
  /** The topic's name, for the stuck reason. */
  titleOf: (id: string) => string;
  /** The reason text of a topic held back by failed children ("a, b"). */
  blockedReason: (titles: string) => string;
  /** Called before each topic starts, so a progress bar can name it. */
  onStart?: (id: string, finished: number) => void;
}

/**
 * Runs the `items` (children before parents) one after another. A topic whose Prompt child is stuck is not run (no AI call) and is
 * stuck itself. Stop (the signal) ends the batch: the topic that was running goes back to "idle" (nothing of it is written, the
 * caller's run is aborted) and nothing new starts. When the scope's own topic was written, its Prompt ancestors become stale.
 *
 * `checkBlocked` false is "run only this one": it reads the children's summaries as they are.
 */
export async function runPromptItems(
  items: readonly PromptPlanItem[],
  scopeId: string | null,
  deps: PromptRunDeps,
  checkBlocked = true
): Promise<PromptOutcome> {
  const outcome: PromptOutcome = { done: 0, failed: 0, blocked: 0, stopped: false };
  const queued = items.filter(item => item.action === "run");
  for (const item of queued) deps.setStatus(item.id, "idle");
  let finished = 0;
  let scopeWritten = false;
  for (const item of queued) {
    if (deps.signal.aborted) {
      outcome.stopped = true;
      break;
    }
    const blockers = checkBlocked ? blockingChildren(deps.nodes, deps.noteOf, item.id, deps.isBad) : [];
    if (blockers.length) {
      deps.setStatus(item.id, "blocked", deps.blockedReason(blockers.map(deps.titleOf).join(", ")));
      outcome.blocked++;
      finished++;
      continue;
    }
    deps.onStart?.(item.id, finished);
    deps.setStatus(item.id, "running");
    let failure: string | undefined;
    try {
      await deps.runItem(item);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (deps.signal.aborted) {
      deps.setStatus(item.id, "idle");
      outcome.stopped = true;
      break;
    }
    finished++;
    if (failure !== undefined) {
      deps.setStatus(item.id, "blocked", failure);
      outcome.failed++;
    } else {
      deps.setStatus(item.id, "done");
      outcome.done++;
      if (item.id === scopeId) scopeWritten = true;
    }
  }
  if (scopeWritten && scopeId)
    for (const id of staleAncestors(deps.nodes, deps.noteOf, scopeId)) deps.setStatus(id, "stale");
  return outcome;
}

/**
 * The Markdown notes on a Prompt's "資料來源：" line, read through `read` (the view's vault lookup: a note, or `null` when the link
 * does not resolve to a Markdown note). A link that does not resolve, or whose read throws, is skipped; nothing is fetched from the
 * web. At most `limit` notes.
 */
export async function readPromptSources<T>(
  prompt: string,
  read: (link: string) => Promise<T | null>,
  limit = 10
): Promise<T[]> {
  const out: T[] = [];
  for (const link of promptSourceLinks(prompt)) {
    if (out.length >= limit) break;
    try {
      const document = await read(link);
      if (document) out.push(document);
    } catch {
      /* A source that cannot be read is skipped. */
    }
  }
  return out;
}

export interface PromptRunEntry {
  status: PromptRunStatus;
  /** Why a topic is stuck (its own failure or the children that did not succeed). */
  reason?: string;
}
/** The run-all batch a view holds: live while `outcome` is unset, then the result until dismissed. */
export interface PromptBatchState {
  mapPath: string;
  controller: AbortController;
  total: number;
  /** Topics settled so far. */
  finished: number;
  /** The name of the topic running now. */
  current?: string;
  outcome?: PromptOutcome;
}
