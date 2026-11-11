/**
 * Pure planning for "integrate the whole subtree" in the topic chat: how deep the subtree is, how many topics were researched,
 * how many AI calls each depth choice costs, the order a bottom-up integration runs in, and the budgeted outline of the topics
 * below the direct subtopics that the root's integration prompt carries. No view, no I/O.
 */

/** What the plan needs of one map node and its note. `researched` is false for a note whose status is idea or error. */
export interface PlanNode {
  id: string;
  parentId: string | null;
  title: string;
  summary: string;
  researched: boolean;
}

/** quick: the direct subtopics integrate their own subtopics, then the root; bottom-up: every parent from the deepest up; research-first: research the unresearched leaves, then bottom-up. */
export type IntegrationDepth = "quick" | "bottom-up" | "research-first";
export const INTEGRATION_DEPTHS: readonly IntegrationDepth[] = ["quick", "bottom-up", "research-first"];

export interface SubtreeStats {
  /** Levels below the root (a root with only direct subtopics has 1). */
  levels: number;
  /** Topics below the root. */
  topics: number;
  /** Of those, the ones researched (status other than idea or error). */
  researched: number;
  /** Nodes that have subtopics, the root included. */
  parents: number;
  /** Leaves (no subtopics) that were never researched. */
  unresearchedLeaves: number;
  /** Direct subtopics that have subtopics of their own. */
  directParents: number;
}

/** Longest summary an outline line carries, in characters. */
export const OUTLINE_SUMMARY_CHARS = 60;
/** The outline's size limit, in characters; it is counted in the 32k context budget. */
export const OUTLINE_MAX_CHARS = 6000;
/** Written on an outline line whose topic was never researched; the prompt's outline rule names it. */
export const UNRESEARCHED_MARK = "[unresearched]";

const childrenIndex = (nodes: readonly PlanNode[]): Map<string, PlanNode[]> => {
  const index = new Map<string, PlanNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = index.get(node.parentId);
    if (list) list.push(node);
    else index.set(node.parentId, [node]);
  }
  return index;
};

/** One topic of the subtree below `rootId` with its depth (direct subtopics are 1), parents before children, siblings in map order. */
interface Walked {
  node: PlanNode;
  depth: number;
}
function walk(nodes: readonly PlanNode[], rootId: string): { items: Walked[]; index: Map<string, PlanNode[]> } {
  const index = childrenIndex(nodes);
  const items: Walked[] = [];
  const seen = new Set<string>([rootId]);
  const visit = (id: string, depth: number): void => {
    for (const child of index.get(id) ?? []) {
      // A cycle in a damaged map must not hang the plan.
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      items.push({ node: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(rootId, 1);
  return { items, index };
}

export function subtreeStats(nodes: readonly PlanNode[], rootId: string): SubtreeStats {
  const { items, index } = walk(nodes, rootId);
  const hasChildren = (id: string): boolean => (index.get(id)?.length ?? 0) > 0;
  const reached = new Set(items.map(item => item.node.id));
  const childrenOf = (id: string): PlanNode[] => (index.get(id) ?? []).filter(child => reached.has(child.id));
  return {
    levels: items.reduce((deepest, item) => Math.max(deepest, item.depth), 0),
    topics: items.length,
    researched: items.filter(item => item.node.researched).length,
    parents: (childrenOf(rootId).length ? 1 : 0) + items.filter(item => childrenOf(item.node.id).length).length,
    unresearchedLeaves: items.filter(item => !hasChildren(item.node.id) && !item.node.researched).length,
    directParents: items.filter(item => item.depth === 1 && childrenOf(item.node.id).length).length
  };
}

/** AI calls a depth choice costs: quick = direct subtopics with subtopics + 1; bottom-up = nodes with subtopics; research-first = unresearched leaves + nodes with subtopics. */
export function integrationCalls(stats: SubtreeStats, depth: IntegrationDepth): number {
  if (depth === "quick") return stats.directParents + 1;
  if (depth === "bottom-up") return stats.parents;
  return stats.unresearchedLeaves + stats.parents;
}

/** Ids of the nodes that integrate their own subtopics, in run order, the root last. Deeper nodes first; siblings in map order. */
export function bottomUpOrder(nodes: readonly PlanNode[], rootId: string): string[] {
  const { items, index } = walk(nodes, rootId);
  const reached = new Set(items.map(item => item.node.id));
  const parents = items.filter(item => (index.get(item.node.id) ?? []).some(child => reached.has(child.id)));
  // Stable: Array.prototype.sort keeps the walk order among equal depths.
  const ordered = [...parents].sort((left, right) => right.depth - left.depth).map(item => item.node.id);
  if ((index.get(rootId) ?? []).length) ordered.push(rootId);
  return ordered;
}

/** Direct subtopics that integrate their own subtopics first in the quick choice (map order); the root follows. */
export function quickOrder(nodes: readonly PlanNode[], rootId: string): string[] {
  const { items, index } = walk(nodes, rootId);
  return items.filter(item => item.depth === 1 && (index.get(item.node.id)?.length ?? 0) > 0).map(item => item.node.id);
}

/** Unresearched leaves, deepest first (the research-first choice researches them before integrating). */
export function unresearchedLeaves(nodes: readonly PlanNode[], rootId: string): string[] {
  const { items, index } = walk(nodes, rootId);
  return [...items]
    .filter(item => !(index.get(item.node.id)?.length ?? 0) && !item.node.researched)
    .sort((left, right) => right.depth - left.depth)
    .map(item => item.node.id);
}

export interface UnresearchedList {
  /** Unresearched topics anywhere below the root. */
  total: number;
  /** Titles of the unresearched topics at depth 1 and 2, in map order. */
  titles: string[];
  /** Unresearched topics deeper than depth 2 (written as one "the other K were not researched" line). */
  deeper: number;
}

export function unresearchedList(nodes: readonly PlanNode[], rootId: string): UnresearchedList {
  const { items } = walk(nodes, rootId);
  const open = items.filter(item => !item.node.researched);
  return {
    total: open.length,
    titles: open.filter(item => item.depth <= 2).map(item => item.node.title),
    deeper: open.filter(item => item.depth > 2).length
  };
}

export interface SubtreeOutline {
  /** The outline text: one line per topic below the direct subtopics' own lines, indented by depth. Empty when nothing is deeper than the direct subtopics. */
  text: string;
  /** Topics below the root, the direct subtopics included. */
  topics: number;
  unresearched: UnresearchedList;
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();
const clip = (value: string, max: number): string => {
  const line = oneLine(value);
  return line.length > max ? `${Array.from(line).slice(0, max).join("")}…` : line;
};

/**
 * The outline of the subtree: each direct subtopic as a heading line (title only; its full text travels elsewhere), then every
 * deeper topic as an indented line with its title, about 60 characters of summary and the unresearched mark. Over `maxChars`
 * the summaries go first (deepest level up), then the deepest levels fold into "(+N subtopics)" on their parent; the titles of
 * depth 2 always stay.
 */
export function buildSubtreeOutline(
  nodes: readonly PlanNode[],
  rootId: string,
  maxChars = OUTLINE_MAX_CHARS
): SubtreeOutline {
  const { items } = walk(nodes, rootId);
  const deepest = items.reduce((max, item) => Math.max(max, item.depth), 0);
  const unresearched = unresearchedList(nodes, rootId);
  if (deepest < 2) return { text: "", topics: items.length, unresearched };
  // Descendants of each topic, for the fold marker.
  const below = new Map<string, number>();
  const index = childrenIndex(nodes);
  const count = (id: string, seen: Set<string>): number => {
    let sum = 0;
    for (const child of index.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      sum += 1 + count(child.id, seen);
    }
    return sum;
  };
  for (const item of items) below.set(item.node.id, count(item.node.id, new Set([rootId, item.node.id])));
  // summaryFrom: summaries are kept at depths below this one (depth > 1 only); foldFrom: topics at this depth or deeper are folded.
  const render = (summaryDepths: ReadonlySet<number>, foldFrom: number): string =>
    items
      .filter(item => item.depth < foldFrom)
      .map(item => {
        const { node, depth } = item;
        const folded = depth + 1 === foldFrom && below.get(node.id)! > 0 ? ` (+${below.get(node.id)} subtopics)` : "";
        const summary =
          depth >= 2 && summaryDepths.has(depth) && node.summary
            ? ` — ${clip(node.summary, OUTLINE_SUMMARY_CHARS)}`
            : "";
        const mark = !node.researched ? ` ${UNRESEARCHED_MARK}` : "";
        return `${"  ".repeat(depth - 1)}- ${oneLine(node.title)}${summary}${mark}${folded}`;
      })
      .join("\n");
  const summaryDepths = new Set<number>();
  for (let depth = 2; depth <= deepest; depth++) summaryDepths.add(depth);
  let foldFrom = deepest + 1;
  let text = render(summaryDepths, foldFrom);
  // Order: drop the deepest summaries, then the next, fold the deepest level, then the rest of the summaries, then fold upward.
  const steps: Array<() => void> = [];
  if (deepest >= 2) steps.push(() => summaryDepths.delete(deepest));
  if (deepest >= 3) steps.push(() => summaryDepths.delete(deepest - 1));
  if (deepest >= 3) steps.push(() => (foldFrom = deepest));
  for (let depth = deepest - 2; depth >= 2; depth--) steps.push(() => summaryDepths.delete(depth));
  for (let depth = deepest - 1; depth >= 3; depth--) steps.push(() => (foldFrom = depth));
  for (const step of steps) {
    if (text.length <= maxChars) break;
    step();
    text = render(summaryDepths, foldFrom);
  }
  return { text, topics: items.length, unresearched };
}

/** Most unresearched titles the closing list names; the rest count in the "deeper" line (decision 5: the note stays readable). */
export const UNRESEARCHED_TITLES_MAX = 60;

/** The text of `TaskContext.subtreeOutline`: the outline lines, then the unresearched list the note's open questions are built from. Empty when there is no outline. */
export function subtreeOutlineText(outline: SubtreeOutline): string {
  if (!outline.text) return "";
  const { total, titles, deeper } = outline.unresearched;
  if (!total) return outline.text;
  const named = titles.slice(0, UNRESEARCHED_TITLES_MAX);
  const rest = deeper + (titles.length - named.length);
  return [
    outline.text,
    `Unresearched topics: ${total} of ${outline.topics}.${named.length ? ` ${named.map(oneLine).join("; ")}.` : ""}${rest ? ` The other ${rest} unresearched topics are deeper down and are not listed.` : ""}`
  ].join("\n\n");
}
