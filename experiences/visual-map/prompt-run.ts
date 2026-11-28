/**
 * AI cards and "run all": pure planning helpers (no Obsidian, no I/O).
 *
 * An AI card is a topic whose note has `ai-card: true` and a non-empty Prompt (a Prompt alone, as AI-expanded sub-topics carry,
 * is an ordinary card). "Run all" runs the AI cards of the map from the leaves to the root: a leaf runs the research (on the
 * web), a card with children runs the integration over its children's summaries. A locked AI card and its subtree do not run
 * (its own summary stands in). An ordinary card never runs and stops the chain (its children's results do not pass upward
 * through it, and their failure does not block its parent).
 */
import type { LivingSettlement } from "./living-node-execution";

/** "waiting": queued in this round, not reached yet. */
export type PromptRunStatus = "idle" | "waiting" | "running" | "done" | "blocked";

export interface PromptNodeRef {
  id: string;
  parentId?: string | null;
}
/** What the plan reads of a note; a note that is not loaded reads as `undefined`. */
export interface PromptNoteRef {
  prompt: string;
  aiCard?: boolean;
  aiLocked?: boolean;
}
export type PromptNoteOf = (id: string) => PromptNoteRef | undefined;

export interface PromptPlanItem {
  id: string;
  /** What running it does: a leaf researches, a card with children integrates them. */
  kind: "research" | "integrate";
  /** The research of a leaf searches the web; an integration does not. */
  web: boolean;
}
export interface PromptPlan {
  /** Every AI card that will run, children before parents. */
  order: PromptPlanItem[];
  counts: { run: number; web: number };
}

export const isAiCard = (note: PromptNoteRef | undefined): boolean =>
  !!note && note.aiCard === true && (note.prompt ?? "").trim() !== "";

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

/** True when the map has an AI card: the toolbar button is enabled only then. */
export function hasAiCard(nodes: readonly PromptNodeRef[], noteOf: PromptNoteOf): boolean {
  return nodes.some(node => isAiCard(noteOf(node.id)));
}

/**
 * The run of the whole map: the AI cards in post-order. A locked AI card and everything below it is left out (not run, not
 * counted); a locked ordinary card does not cut anything. A cycle in the parent links is walked once.
 */
export function planPromptRun(nodes: readonly PromptNodeRef[], noteOf: PromptNoteOf): PromptPlan {
  const kids = childrenOf(nodes);
  const present = new Set(nodes.map(node => node.id));
  const roots = nodes.filter(node => node.parentId == null || !present.has(node.parentId)).map(node => node.id);
  const seen = new Set<string>();
  const order: PromptPlanItem[] = [];
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const note = noteOf(id);
    const card = isAiCard(note);
    if (card && note?.aiLocked === true) return;
    const children = kids.get(id) ?? [];
    for (const child of children) visit(child);
    if (!card) return;
    const kind = children.length ? "integrate" : "research";
    order.push({ id, kind, web: kind === "research" });
  };
  for (const root of roots) visit(root);
  return { order, counts: { run: order.length, web: order.filter(item => item.web).length } };
}

/**
 * The direct children of a card that stop it: unlocked AI cards that `isBad` (failed or stuck) says no to. An ordinary child and a
 * locked child never block.
 */
export function blockingChildren(
  nodes: readonly PromptNodeRef[],
  noteOf: PromptNoteOf,
  parentId: string,
  isBad: (id: string) => boolean
): string[] {
  return (childrenOf(nodes).get(parentId) ?? []).filter(id => {
    const note = noteOf(id);
    return isAiCard(note) && note?.aiLocked !== true && isBad(id);
  });
}

/** An edge is drawn with an arrow at the parent's end when the parent is an AI card (it reads its children's summaries). */
export const isPromptEdge = (noteOf: PromptNoteOf, parentId: string): boolean => isAiCard(noteOf(parentId));

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
  /** Topics that ran and wrote: changed or no-change only, never reused. */
  done: number;
  /** Topics whose own run failed. */
  failed: number;
  /** Topics not run because a Prompt child failed or was stuck. */
  blocked: number;
  /** True when Stop (or closing the view) ended the batch early. */
  stopped: boolean;
  /** The no-change part of `done`. */
  noChange: number;
  /** Cancelled, or not reached in a stopped round. */
  cancelled: number;
  /** Not run in a round that was not stopped (a locked or trial card). */
  skipped: number;
  /** Already current: nothing ran. */
  reused: number;
}

export interface PromptRunDeps {
  nodes: readonly PromptNodeRef[];
  noteOf: PromptNoteOf;
  signal: AbortSignal;
  /** True when this batch's status of the card is "stuck": failed, or not run because a child failed. */
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
 * Runs the `items` (children before parents) one after another. A card whose AI-card child is stuck is not run (no AI call) and is
 * stuck itself. Stop (the signal) ends the batch: the card that was running goes back to "idle" (nothing of it is written, the
 * caller's run is aborted) and nothing new starts.
 */
export async function runPromptItems(items: readonly PromptPlanItem[], deps: PromptRunDeps): Promise<PromptOutcome> {
  const outcome: PromptOutcome = {
    done: 0,
    failed: 0,
    blocked: 0,
    stopped: false,
    noChange: 0,
    cancelled: 0,
    skipped: 0,
    reused: 0
  };
  let finished = 0;
  for (const item of items) {
    if (deps.signal.aborted) {
      outcome.stopped = true;
      break;
    }
    const blockers = blockingChildren(deps.nodes, deps.noteOf, item.id, deps.isBad);
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
    }
  }
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
  /** This round's result for the card, and whether the round was stopped by then (a not-run card is then stopped). */
  settlement?: LivingSettlement;
  aborted?: boolean;
}
/** The run-all batch a view holds: live while `outcome` is unset, then the result until dismissed. */
export interface PromptBatchState {
  mapPath: string;
  controller: AbortController;
  total: number;
  /** Set once the round is planned: until then `total` is not known and no "n / N" shows. */
  planned?: boolean;
  /** Topics settled so far. */
  finished: number;
  /** The name of the topic running now. */
  current?: string;
  outcome?: PromptOutcome;
  /** This view stops following the shared run; the last view to leave cancels it. */
  leave?: () => void;
}

// ---- AI card records, status and question text ----------------------------------------------------------------------------
export type AiRunResult = "ok" | "failed" | "blocked";
/** What the note says of its last "run all" (`ai-run-at`, `ai-run-result`, `ai-run-input`); `input` is the fingerprint of the last success. */
export interface AiRunRecord {
  at: string;
  result: AiRunResult;
  input?: string;
}

/** FNV-1a over a string (UTF-16 code units), 8 hex characters. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface PromptInput {
  prompt: string;
  /** The direct children of the card (any kind), as read now. */
  children: readonly { id: string; summary: string }[];
  /** The notes the 資料來源 line resolves to; a link that does not resolve is left out. */
  sources: readonly { path: string; mtime: number }[];
}
/**
 * The fingerprint of what a card's run reads: its Prompt (trimmed), its direct children's summaries (by id) and the modified time of
 * its source notes. The "keep old data" switch is not part of it.
 */
export function promptInputKey(input: PromptInput): string {
  const children = [...input.children]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(c => [c.id, c.summary]);
  const sources = input.sources.map(s => [s.path, s.mtime]);
  return fnv1a(JSON.stringify([input.prompt.trim(), children, sources]));
}

/** The card face: "pending" is a suggested card (never run, or nothing out of date to say), "stale" one that needs a rerun. */
export type AiCardStatus = "pending" | "waiting" | "running" | "stale" | "failed" | "blocked" | "stopped" | "done";
export interface AiCardStatusInput {
  /** True while this view's run (batch or single AI job) is working on the card. */
  running: boolean;
  run?: AiRunRecord;
  /** The fingerprint of the card's inputs now. */
  inputKey: string;
  /** The status of each direct AI-card child that is not locked. */
  childStatuses: readonly AiCardStatus[];
}
/**
 * pending: never run. running: working now. failed: the last run failed or was held back. stale: ran fine before but its inputs
 * changed, or an unlocked AI-card child is not "done". done: ran, and as far as the plugin can tell it is up to date.
 */
export function aiCardStatus(input: AiCardStatusInput): AiCardStatus {
  if (input.running) return "running";
  const run = input.run;
  if (!run) return "pending";
  if (run.result !== "ok") return "failed";
  if (run.input !== input.inputKey || input.childStatuses.some(status => status !== "done")) return "stale";
  return "done";
}

const LINK_ONLY = /^[\s、,，;；]*(?:\[\[[^\]]+\]\][\s、,，;；]*)+$/;
/**
 * Splits a Prompt into the question text and the notes of its 資料來源 line. Only a source line made of nothing but links is taken
 * out; any other line (a source line with plain words included) stays in the question, as every other "name: content" line does.
 */
export function splitPrompt(prompt: string): { question: string; sources: string[] } {
  const keep: string[] = [];
  const sources: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const rest = SOURCE_LINE.exec(line)?.[1];
    if (rest !== undefined && LINK_ONLY.test(rest)) {
      for (const link of promptSourceLinks(line)) if (!sources.includes(link)) sources.push(link);
    } else keep.push(line);
  }
  return { question: keep.join("\n").trim(), sources };
}
/** The Prompt text of an AI card: the question, then the 資料來源 line (its label and list separator come from the interface language; a Latin label takes the half-width colon) when there are notes. */
export function joinPrompt(question: string, sources: readonly string[], label: string, separator: string): string {
  const text = question.trim();
  if (!sources.length) return text;
  const line = `${label}${/^[ -~]*$/.test(label) ? ": " : "："}${sources.map(name => `[[${name}]]`).join(separator)}`;
  return text ? `${text}\n${line}` : line;
}
/** The name of a new AI card when the user left it blank: the question's first line, 20 characters at most, without trailing punctuation. */
export function aiCardTitle(question: string): string {
  const first = question.split(/\r?\n/).find(line => line.trim()) ?? "";
  return Array.from(first.trim())
    .slice(0, 20)
    .join("")
    .replace(/[\s\p{P}]+$/u, "");
}
