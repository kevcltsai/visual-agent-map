import type { AiResult } from "./ai/types";
import { debugLog, type LogLevel } from "./log-manager";
import { isMapAiMode, type MapAiMode } from "./experiences/visual-map/ai-mode";
import {
  pruneAfterText,
  pruneAnnotatedImages,
  removeAnchorRelationsForTopics,
  retargetAnchorRelations,
  sanitizeCanvasItems,
  type CanvasItem
} from "./experiences/visual-map/canvas-items";
import { cleanBranchLayouts } from "./layouts/compose";
import { isLayoutKind, isStoredLayoutSpacing, type MapLayout } from "./map-layout";
import { isContentLanguage, t, translate, type ContentLanguage, type NoteLanguage } from "./i18n";
import {
  applyCollapseLevel,
  CARD_WIDTH,
  clampCardHeight,
  clampCardWidth,
  branchSize,
  childIndex,
  descendants,
  parentIdsForNode,
  visibleNodes,
  type AimNodeKind,
  type MapNode
} from "./map-graph";
export { applyCollapseLevel, branchSize, childIndex, descendants, parentIdsForNode, visibleNodes };
export type { AimNodeKind, MapNode };
export interface MapDocument {
  version: 1;
  id: string;
  title: string;
  nodes: MapNode[];
  viewport: { x: number; y: number; zoom: number };
  aim?: AimMapData;
  /**
   * The language the AI writes this map's content in, remembered per map (D-2026-10-88): the language chosen by hand in a
   * task menu or the AIM start dialog, or recorded when an AIM map was created in a language other than its note
   * language. Any content language, including the follow-the-input row. Unknown values are ignored (dropped on read).
   */
  outputLanguage?: ContentLanguage;
  /** The AI mode (Quick or Standard) last used to run a research or expansion in this map; the dialogs' default. Unknown values are ignored (dropped on read). */
  aiMode?: MapAiMode;
  /** How the map is laid out; absent means "right". Unknown values are ignored (dropped on read). */
  layout?: MapLayout;
  detailTemplateId?: string;
  /** Default tone preset id for the map; absent = academic. */
  toneId?: string;
  /** Semantic links between topics (evidence for a hypothesis, prerequisite knowledge). Absent when there are none. */
  topicRelations?: TopicRelation[];
  /** Free images and boundary frames drawn on the canvas. Absent when there are none. */
  canvasItems?: CanvasItem[];
  /**
   * Hypothesis-research (argument map) state, written only by that flow. parseMap and serializeMap carry it through untouched,
   * whatever its content, so a key this version cannot read (`v` other than 1, an unknown enum, a role pointing to a missing node)
   * is saved back exactly as it was; core/argument-map/model.ts `readArgumentMap` decides whether it is usable. Absent on every other map.
   */
  argumentMap?: unknown;
}
/**
 * Semantic links between topics; none of them changes the parent/child tree. `from` is A and `to` is B for every kind
 * (`related` has no direction). `derives_from` and `prerequisite` must not form a cycle among links of their own kind.
 * The V1.5 `evidence` kind is no longer known: it is dropped when a map is read (with a warning), not migrated.
 */
export type TopicRelationKind = "supports" | "contradicts" | "verifies" | "derives_from" | "related" | "prerequisite";
export interface TopicRelation {
  kind: TopicRelationKind;
  from: string;
  to: string;
  /** Optional single-line note, written through `normalizeRelationDescription`; read back as stored. */
  description?: string;
}
export const TOPIC_RELATION_KINDS: readonly TopicRelationKind[] = [
  "supports",
  "contradicts",
  "verifies",
  "derives_from",
  "related",
  "prerequisite"
];
export const RELATION_DESCRIPTION_MAX_LENGTH = 200;
/** A pair of topics, in either order and of any kind, holds at most one relation (decision #37), so this is the key. */
const relationKey = (r: Pick<TopicRelation, "kind" | "from" | "to">): string =>
  r.from > r.to ? `${r.to}\0${r.from}` : `${r.from}\0${r.to}`;
const copyRelation = (r: TopicRelation, from = r.from, to = r.to): TopicRelation => {
  const out: TopicRelation = { kind: r.kind, from, to };
  if (r.description !== undefined) out.description = r.description;
  return out;
};
type RelationLogger = (level: LogLevel, message: string) => void;

/** True for the kinds that must not form a cycle among links of their own kind. */
export function isAcyclicKind(kind: TopicRelationKind): boolean {
  return kind === "derives_from" || kind === "prerequisite";
}

/** Single line, collapsed whitespace, at most 200 characters; undefined when nothing is left. */
export function normalizeRelationDescription(text: string): string | undefined {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return Array.from(flat).slice(0, RELATION_DESCRIPTION_MAX_LENGTH).join("").trim() || undefined;
}

/**
 * Drops what cannot be a relation: a non-list value (the whole key), malformed entries, unknown kinds, endpoints that
 * are not topics, self links and a second relation on a pair of topics already linked (any kind, either direction;
 * the first in list order stays, decision #37). A description that is not a string is
 * removed but its relation is kept; a string description is kept as written. Derivation and prerequisite cycles are
 * kept (a hand-written loop still opens). Logs warns with counts only; removes the key when nothing is left. Never throws.
 */
export function sanitizeTopicRelations(
  map: MapDocument,
  log: RelationLogger = (l, m) => debugLog.appendLog(l, m)
): void {
  const raw: unknown = (map as { topicRelations?: unknown }).topicRelations;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    delete map.topicRelations;
    log("warn", "Ignored topicRelations: not a list.");
    return;
  }
  const ids = new Set(map.nodes.map(n => n?.id));
  const seen = new Set<string>();
  const kept: TopicRelation[] = [];
  let dropped = 0;
  let droppedDescriptions = 0;
  for (const item of raw as unknown[]) {
    const r = item as Partial<TopicRelation> | null;
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.kind !== "string" ||
      !(TOPIC_RELATION_KINDS as readonly string[]).includes(r.kind) ||
      typeof r.from !== "string" ||
      typeof r.to !== "string" ||
      !ids.has(r.from) ||
      !ids.has(r.to) ||
      r.from === r.to
    ) {
      dropped++;
      continue;
    }
    const clean: TopicRelation = { kind: r.kind, from: r.from, to: r.to };
    const key = relationKey(clean);
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    if (typeof r.description === "string") clean.description = r.description;
    else if ("description" in r) droppedDescriptions++;
    kept.push(clean);
  }
  if (dropped)
    log("warn", `Dropped ${dropped} invalid topic relation${dropped === 1 ? "" : "s"} while reading the map.`);
  if (droppedDescriptions)
    log(
      "warn",
      `Dropped ${droppedDescriptions} invalid topic relation description${droppedDescriptions === 1 ? "" : "s"} while reading the map.`
    );
  if (kept.length) map.topicRelations = kept;
  else delete map.topicRelations;
}
/** Replaces the relations; an empty list removes the key. Every write goes through here. */
export function setTopicRelations(map: MapDocument, list: TopicRelation[]): void {
  if (list.length) map.topicRelations = list.map(r => copyRelation(r));
  else delete map.topicRelations;
}
/** Removes every relation (of any kind) that touches one of `ids`. */
export function removeTopicRelationsFor(map: MapDocument, ids: Iterable<string>): void {
  if (!map.topicRelations) return;
  const gone = new Set(ids);
  setTopicRelations(
    map,
    map.topicRelations.filter(r => !gone.has(r.from) && !gone.has(r.to))
  );
}
/** True when `target` can be reached from `start` along links of `kind` (from -> to). Visited-set BFS, so loops end. */
function reachesByKind(
  relations: readonly TopicRelation[],
  kind: TopicRelationKind,
  start: string,
  target: string
): boolean {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift() as string;
    if (current === target) return true;
    for (const r of relations)
      if (r.kind === kind && r.from === current && !seen.has(r.to)) {
        seen.add(r.to);
        queue.push(r.to);
      }
  }
  return false;
}
/**
 * Whether `candidate` may be added. Refuses a self link, any pair of topics that already holds a relation (any kind,
 * either direction; decision #37) and, for the two acyclic kinds, a link that would close a cycle among links of that kind (other kinds do not count).
 * `replacingIndex` leaves that existing relation out first (changing its kind or reversing it).
 */
export function relationAllowed(
  relations: readonly TopicRelation[],
  candidate: Pick<TopicRelation, "kind" | "from" | "to">,
  replacingIndex?: number
): boolean {
  if (candidate.from === candidate.to) return false;
  const others = relations.filter((_, i) => i !== replacingIndex);
  const key = relationKey(candidate);
  if (others.some(r => relationKey(r) === key)) return false;
  if (isAcyclicKind(candidate.kind) && reachesByKind(others, candidate.kind, candidate.to, candidate.from))
    return false;
  return true;
}
/** Every topic that `relationAllowed` accepts as the `to` end of a new `kind` link starting at `fromId`. */
export function legalRelationTargets(map: MapDocument, kind: TopicRelationKind, fromId: string): string[] {
  const relations = map.topicRelations ?? [];
  return map.nodes.filter(n => relationAllowed(relations, { kind, from: fromId, to: n.id })).map(n => n.id);
}
/**
 * Points every relation end at `fromIds` to `toId` (a merge). Self links are dropped; when several relations land on
 * the same pair of topics (any kind, either direction) only the first in list order stays and the rest are counted in
 * `droppedSamePair` (decision #37); a derivation or prerequisite that would newly close a cycle is dropped and counted (both kinds together).
 * Cycles already present are not touched.
 */
export function retargetTopicRelations(
  map: MapDocument,
  fromIds: Iterable<string>,
  toId: string
): { droppedCycles: number; droppedSamePair: number } {
  const result = { droppedCycles: 0, droppedSamePair: 0 };
  if (!map.topicRelations) return result;
  const merged = new Set(fromIds);
  const move = (id: string): string => (merged.has(id) ? toId : id);
  const kept: { r: TopicRelation; i: number }[] = [];
  const seen = new Set<string>();
  const touched: { r: TopicRelation; i: number }[] = [];
  map.topicRelations.forEach((r, i) => {
    const next = copyRelation(r, move(r.from), move(r.to));
    if (next.from === next.to) return;
    const key = relationKey(next);
    if (seen.has(key)) {
      result.droppedSamePair++;
      return;
    }
    seen.add(key);
    if (isAcyclicKind(next.kind) && (next.from !== r.from || next.to !== r.to)) touched.push({ r: next, i });
    else kept.push({ r: next, i });
  });
  for (const item of touched) {
    if (
      reachesByKind(
        kept.map(k => k.r),
        item.r.kind,
        item.r.to,
        item.r.from
      )
    )
      result.droppedCycles++;
    else kept.push(item);
  }
  kept.sort((a, b) => a.i - b.i);
  setTopicRelations(
    map,
    kept.map(k => k.r)
  );
  return result;
}
/**
 * `removeTopicRelationsFor` plus the anchor relations of every annotated image that touch one of `topicIds`. Mutates the map like
 * the function it wraps. Returns how many anchor relations were dropped (for a Notice).
 */
export function removeRelationsForTopics(
  map: MapDocument,
  topicIds: Iterable<string>
): { droppedAnchorRelations: number } {
  const ids = new Set(topicIds);
  removeTopicRelationsFor(map, ids);
  if (!map.canvasItems) return { droppedAnchorRelations: 0 };
  const result = removeAnchorRelationsForTopics(map.canvasItems, ids);
  if (result.dropped) map.canvasItems = result.items;
  return { droppedAnchorRelations: result.dropped };
}
/**
 * `retargetTopicRelations` plus the anchor relations of every annotated image (their topic end moves to `toId`). Same result
 * shape; same-pair drops of anchor relations are added to `droppedSamePair`, so the existing Notice counts them.
 */
export function retargetRelationsToTopic(
  map: MapDocument,
  fromIds: Iterable<string>,
  toId: string
): { droppedCycles: number; droppedSamePair: number } {
  const merged = new Set(fromIds);
  const result = retargetTopicRelations(map, merged, toId);
  if (!map.canvasItems) return result;
  const anchors = retargetAnchorRelations(map.canvasItems, merged, toId);
  map.canvasItems = anchors.items;
  result.droppedSamePair += anchors.droppedSamePair;
  return result;
}

export interface AimReuseRecord {
  sourceBranchId: string;
  sourceResultId: string;
  sourceNotePath: string;
  sourceVersion: number;
  sourceContentHash: string;
  checkedAt: string;
  applicableConditions: Record<string, string>;
  rationale: string;
  validityReason: string;
}

export interface AimBranchRecord {
  id: string;
  submissionId?: string;
  /** Original question node from which an answer-specific question pivot was copied. */
  sourceQuestionNodeId?: string;
  questionNodeId: string;
  answerNodeId?: string;
  parentBranchId: string | null;
  answerSnapshot: { selections: string[]; freeText: string };
  inputSnapshot: {
    topic: string;
    conditions: Record<string, string>;
    upstreamResults: { notePath: string; version: number }[];
  };
  createdAt: string;
  researchPlan?: {
    id: string;
    title: string;
    task: string;
    expectedValue: string;
    action?: "reuse" | "update" | "research";
    dependsOn?: string[];
    source?: { branchId: string; resultId: string; notePath: string; version: number; contentHash: string };
    rationale?: string;
    validity?: { conditionKeys: string[]; reason: string };
  }[];
  researchPlanError?: string;
  retryTimeoutMs?: number;
  deliveryRecovery?: {
    fingerprint: string;
    planner: AiResult;
    checkpoint: unknown;
    phase?: string;
    reports?: { summary: string; detail: string };
    researchTurn?: number;
    evidence?: { id: string; hash: string; detail: string }[];
  };
  results: {
    resultId: string;
    runId: string;
    attemptId: string;
    nodeId: string;
    notePath: string;
    version: number;
    kind?: "research" | "synthesis" | "conclusion";
    subtopicId?: string;
    reuse?: AimReuseRecord;
  }[];
}
/** A Searcher report kept as data so recovery never has to parse Markdown headings. */
export interface AimRetainedReport {
  summary: string;
  detail: string;
}
export interface AimResultDraftRecord {
  id: string;
  branchId: string;
  nodeId: string;
  notePath: string;
  title: string;
  status: "creating" | "ready";
  runId: string;
  attemptId: string;
  inputSnapshotHash: string;
  model?: string;
  reasoning?: "low" | "medium" | "high";
  kind?: "research" | "synthesis" | "conclusion";
  subtopicId?: string;
  reuse?: AimReuseRecord;
  parentNodeId?: string;
  convergesFromNodeIds?: string[];
  /** Individual reports behind an aggregated draft, kept for saved-report recovery. */
  retainedReports?: AimRetainedReport[];
}
export interface AimPlannerReviewRecord {
  decision: "research_more" | "ask_user" | "conclude";
  rationale: string;
  researchTurn: number;
  question?: string;
  answerOptions?: (string | { axisId: string; value: string })[];
  answerAxis?: { id: string; label: string };
  researchTarget?: { title: string; task: string; expectedValue: string };
}
export interface AimSearchDiagnostic {
  researchTurn: number;
  startedEvents: number;
  completedEvents: number;
  completedSearchActions: number;
  otherCompletedActions: number;
}
export interface AimAttemptRecord {
  id: string;
  inputSnapshotHash: string;
  status: "running" | "saving" | "completed" | "partial" | "failed" | "cancelled" | "superseded";
  stopReason?: string;
  phase?: string;
  subtopicId?: string;
  model?: string;
  reasoningLevel?: "low" | "medium" | "high";
  maxResearchTurns?: number;
  researchTurns?: number;
  plannerReviews?: AimPlannerReviewRecord[];
  searchDiagnostics?: AimSearchDiagnostic[];
  /** Reports of a failed attempt with completed web retrieval, and the diagnostic note that shows them. */
  retainedReports?: { notePath: string; reports: AimRetainedReport[] };
}
export interface AimRunRecord {
  id: string;
  branchId: string;
  currentAttemptId: string;
  attempts: AimAttemptRecord[];
}
export interface AimPendingCommit {
  resultId: string;
  branchId: string;
  runId: string;
  attemptId: string;
  resultDraftId: string;
  nodeId: string;
  notePath: string;
  title: string;
  summary: string;
  detail: string;
  version: number;
  resultStatus?: "completed" | "partial";
}
export interface AimQuestionDraft {
  requestId: string;
  nodeId: string;
  parentId: string;
  parentBranchId?: string | null;
  notePath: string;
  title: string;
  summary: string;
  detail: string;
  prompt: string;
  model: string;
  reasoning?: "low" | "medium" | "high";
  options: { id: string; label: string }[];
  convergesFromNodeIds?: string[];
}
export interface AimMapData {
  version: 1;
  creationId?: string;
  /** Language of AIM-generated content, decided once at creation; legacy maps derive it from the title. */
  contentLanguage?: NoteLanguage;
  /** Exploration target; legacy field name retained for saved maps. Never forces questions or completion. */
  minimumAnswersBeforeConclusion?: number;
  /**
   * "unattended": the user answers the intake once and the run never waits for them again; questions that come up
   * later become stated assumptions. Absent means the interactive question-by-question flow.
   */
  interaction?: "unattended";
  rootDraft?: {
    nodeId: string;
    notePath: string;
    title: string;
    context: string;
    model?: string;
    reasoning?: "low" | "medium" | "high";
  };
  branches: AimBranchRecord[];
  runs: AimRunRecord[];
  resultDrafts?: AimResultDraftRecord[];
  questionDraft?: AimQuestionDraft;
  pendingCommits: AimPendingCommit[];
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function canParent(nodes: MapNode[], id: string, parentId: string | null): boolean {
  return (
    parentId === null ||
    (parentId !== id && nodes.some(n => n.id === parentId) && !descendants(nodes, id).has(parentId))
  );
}
/**
 * Interim "research gap" synthesis results the map no longer shows: a synthesis whose run later committed a conclusion
 * in the same branch. Display only; a node that owns children is never hidden. Nothing is stored for this.
 */
export function supersededAimNodeIds(map: MapDocument): Set<string> {
  const hidden = new Set<string>();
  const parents = new Set(map.nodes.map(node => node.parentId).filter((id): id is string => !!id));
  for (const branch of map.aim?.branches ?? []) {
    branch.results.forEach((result, index) => {
      if (result.kind !== "synthesis" || parents.has(result.nodeId)) return;
      if (
        branch.results.some(
          (later, laterIndex) => laterIndex > index && later.runId === result.runId && later.kind === "conclusion"
        )
      )
        hidden.add(result.nodeId);
    });
  }
  return hidden;
}
export function removeNodes(nodes: MapNode[], id: string, branch: boolean): MapNode[] {
  const removed = branch ? descendants(nodes, id) : new Set<string>();
  removed.add(id);
  return nodes
    .filter(node => !removed.has(node.id))
    .map(node => ({ ...node, parentId: node.parentId && removed.has(node.parentId) ? null : node.parentId }));
}

export function parseMap(content: string, log?: RelationLogger): MapDocument {
  const block = content.match(/```agent-map\s*\n([\s\S]*?)\n```/);
  if (!block) throw new Error(t("ui.mind_map_data_was_not_found_keep_the_agent_map_block"));
  // An old AIM map (AIM was removed) is kept exactly as saved: no legacy-name rewrite and no check of its AIM data, so a
  // reference left dangling by an ordinary edit cannot make the map unopenable. A map without `aim` gets the AIM field checks.
  let parsed: MapDocument;
  try {
    parsed = JSON.parse(block[1]) as MapDocument;
  } catch {
    throw new Error(t("ui.map_data_block_invalid"));
  }
  const map = parsed;
  const checkAim = map.aim === undefined;
  if (map.version !== 1 || typeof map.id !== "string" || typeof map.title !== "string" || !Array.isArray(map.nodes))
    throw new Error(t("ui.invalid_mind_map_format"));
  if (map.detailTemplateId !== undefined && typeof map.detailTemplateId !== "string") delete map.detailTemplateId;
  if (map.toneId !== undefined && typeof map.toneId !== "string") delete map.toneId;
  if (map.outputLanguage !== undefined && !isContentLanguage(map.outputLanguage)) delete map.outputLanguage;
  if (map.aiMode !== undefined && !isMapAiMode(map.aiMode)) delete map.aiMode;
  if (
    map.layout !== undefined &&
    (!map.layout || typeof map.layout !== "object" || Array.isArray(map.layout) || !isLayoutKind(map.layout.direction))
  )
    delete map.layout;
  else if (map.layout && map.layout.spacing !== undefined && !isStoredLayoutSpacing(map.layout.spacing))
    delete map.layout.spacing;
  if (map.canvasItems !== undefined) {
    const items = sanitizeCanvasItems(map.canvasItems);
    if (items.length) map.canvasItems = items;
    else delete map.canvasItems;
  }
  const ids = new Set<string>(),
    aimQuestionRequests = new Set<string>();
  for (const n of map.nodes) {
    if (
      !n ||
      typeof n.id !== "string" ||
      typeof n.path !== "string" ||
      !n.path.endsWith(".md") ||
      !Number.isFinite(n.x) ||
      !Number.isFinite(n.y) ||
      (n.parentId !== null && typeof n.parentId !== "string") ||
      ids.has(n.id)
    )
      throw new Error(t("ui.invalid_node_data_or_duplicate_id"));
    if (
      checkAim &&
      n.aimDismissedQuestionRequestIds !== undefined &&
      (!Array.isArray(n.aimDismissedQuestionRequestIds) ||
        new Set(n.aimDismissedQuestionRequestIds).size !== n.aimDismissedQuestionRequestIds.length ||
        n.aimDismissedQuestionRequestIds.some(id => typeof id !== "string" || !id.trim()))
    )
      throw new Error("Invalid dismissed AIM question identities.");
    ids.add(n.id);
    n.collapsed = n.collapsed === true;
    if (n.width !== undefined) {
      const width = clampCardWidth(n.width);
      if (width === undefined || width === CARD_WIDTH) delete n.width;
      else n.width = width;
    }
    if (n.height !== undefined) {
      const height = clampCardHeight(n.height);
      if (height === undefined) delete n.height;
      else n.height = height;
    }
    if (
      checkAim &&
      n.aimKind !== undefined &&
      !["topic", "question", "answer", "research", "synthesis", "conclusion"].includes(n.aimKind)
    )
      throw new Error("Invalid AIM node kind.");
    if (
      checkAim &&
      n.aimConvergesFromNodeIds !== undefined &&
      (!Array.isArray(n.aimConvergesFromNodeIds) ||
        new Set(n.aimConvergesFromNodeIds).size !== n.aimConvergesFromNodeIds.length ||
        n.aimConvergesFromNodeIds.some(
          id => typeof id !== "string" || id === n.id || !map.nodes.some(candidate => candidate.id === id)
        ))
    )
      throw new Error("Invalid AIM convergence references.");
    if (checkAim && n.aimQuestion !== undefined) {
      const question = n.aimQuestion;
      if (
        n.aimKind !== "question" ||
        !question ||
        typeof question.requestId !== "string" ||
        !question.requestId.trim() ||
        !(
          question.parentBranchId === undefined ||
          question.parentBranchId === null ||
          typeof question.parentBranchId === "string"
        ) ||
        !Array.isArray(question.options) ||
        question.options.length < 2 ||
        question.options.some(
          option =>
            !option ||
            typeof option.id !== "string" ||
            !option.id.trim() ||
            typeof option.label !== "string" ||
            !option.label.trim()
        ) ||
        new Set(question.options.map(option => option.id)).size !== question.options.length ||
        typeof question.allowMultiple !== "boolean" ||
        typeof question.allowFreeText !== "boolean"
      )
        throw new Error("Invalid AIM question controls.");
      if (aimQuestionRequests.has(question.requestId)) throw new Error("Duplicate AIM question request identity.");
      aimQuestionRequests.add(question.requestId);
    }
  }
  for (const n of map.nodes)
    if (!canParent(map.nodes, n.id, n.parentId))
      throw new Error(t("ui.a_link_contains_a_cycle_or_points_to_a_missing_parent_topic"));
  cleanBranchLayouts(map.nodes, map.layout?.direction ?? "right", map.aim !== undefined);
  if (
    !map.viewport ||
    !Number.isFinite(map.viewport.x) ||
    !Number.isFinite(map.viewport.y) ||
    !Number.isFinite(map.viewport.zoom)
  )
    map.viewport = { x: 40, y: 40, zoom: 1 };
  map.viewport.zoom = Math.min(2, Math.max(0.25, map.viewport.zoom));
  sanitizeTopicRelations(map, log);
  if (map.canvasItems) {
    const pruned = pruneAnnotatedImages(map.canvasItems, ids);
    if (pruned.dropped) {
      map.canvasItems = pruned.items;
      (log ?? ((l, m) => debugLog.appendLog(l, m)))(
        "warn",
        `Dropped ${pruned.dropped} dangling annotated-image anchor${pruned.dropped === 1 ? "" : "s"} or relation${pruned.dropped === 1 ? "" : "s"} while reading the map.`
      );
    }
  }
  pruneAfterText(map, log ?? ((l, m) => debugLog.appendLog(l, m)));
  return map;
}
export function serializeMap(map: MapDocument, language: NoteLanguage = "zh-TW"): string {
  const description = translate(language, "ui.map_file_description");
  return `---\nvisual-agent-map: true\n---\n\n# ${map.title.replace(/\n/g, " ")}\n\n${description}\n\n\`\`\`agent-map\n${JSON.stringify(map, null, 2)}\n\`\`\`\n`;
}
export function inheritModel(parentModel: string | undefined, defaultModel: string): string {
  return parentModel ?? defaultModel;
}
export interface HistoryMark {
  epoch: number;
  dropped: number;
  length: number;
}
export class History<T extends { undo: () => Promise<void>; redo: () => Promise<void>; label?: string }> {
  private past: T[] = [];
  private future: T[] = [];
  /** Bumped by clear(), so a mark taken before it can tell the entries it covered are gone. */
  private epoch = 0;
  /** Entries pushed out of the front by the 80-entry cap, so a mark's position survives the cap. */
  private dropped = 0;
  /** While a group is open, pushed entries are collected here (no cap) instead of becoming undo steps of their own. */
  private grouped: T[] | null = null;
  /** Depth of {@link ownWrites} calls running: only then do pushes go into the open group. */
  private owning = 0;
  /** Entries that stay a step of their own when collapseSince folds the ones around them (a closed group's step). */
  private solo = new WeakSet<object>();
  /** True while a group is open (a chat reply is being applied). */
  get grouping(): boolean {
    return this.grouped !== null;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoEntry(): T | undefined {
    return this.past[this.past.length - 1];
  }
  get redoEntry(): T | undefined {
    return this.future[this.future.length - 1];
  }
  push(entry: T): void {
    if (this.grouped && this.owning > 0) {
      this.grouped.push(entry);
      this.future = [];
      return;
    }
    this.past.push(entry);
    if (this.past.length > 80) {
      this.past.shift();
      this.dropped++;
    }
    this.future = [];
  }
  /** Forgets the step redo would bring back (one cancelled for good, so redo must not replay it). */
  dropRedo(): void {
    this.future.pop();
  }
  undo(): T | undefined {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
    return entry;
  }
  redo(): T | undefined {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
    return entry;
  }
  clear(): void {
    this.past = [];
    this.future = [];
    this.epoch++;
    // An open group stays open, but what it collected belonged to the history that is gone.
    if (this.grouped) this.grouped = [];
  }
  /**
   * Starts collecting: every entry pushed until {@link closeGroup} is held back (the 80-entry cap does not apply to it), so the
   * caller can push them as one step. A group already open is kept.
   */
  openGroup(): void {
    this.grouped ??= [];
  }
  /**
   * Runs `work`; entries pushed meanwhile join the open group (when there is one). Pushes outside it, such as another job's
   * between two such calls, stay steps of their own.
   */
  async ownWrites<R>(work: () => Promise<R>): Promise<R> {
    this.owning++;
    try {
      return await work();
    } finally {
      this.owning--;
    }
  }
  /** Pushes `entry` as a step that collapseSince never folds into another one. */
  pushSolo(entry: T): void {
    this.solo.add(entry);
    this.push(entry);
  }
  /** Removes `entry` when it is the newest undo step (nothing else changes); false when it is not. */
  dropTop(entry: T): boolean {
    if (this.past[this.past.length - 1] !== entry) return false;
    this.past.pop();
    return true;
  }
  /** Ends the group and returns what it collected, oldest first (empty when nothing was pushed or the history was cleared). */
  closeGroup(): T[] {
    const entries = this.grouped ?? [];
    this.grouped = null;
    return entries;
  }
  /** Marks the present end of the history; collapseSince folds everything pushed after it into one entry. */
  mark(): HistoryMark {
    return { epoch: this.epoch, dropped: this.dropped, length: this.past.length };
  }
  /**
   * Drops the entries pushed since `mark`, so work done in between leaves no undo step; entries from before the mark stay.
   * When the history was cleared since the mark, every entry now in it was pushed after the mark and is dropped.
   */
  discardSince(mark: HistoryMark): void {
    const start = mark.epoch === this.epoch ? Math.max(0, mark.length - (this.dropped - mark.dropped)) : 0;
    if (start < this.past.length) this.past.splice(start);
  }
  /**
   * Folds the entries pushed since `mark` into one undo step: undo runs them newest first, redo oldest first. Does
   * nothing when the history was cleared since the mark, or when fewer than two entries were pushed. Each entry's
   * undo/redo is read when it runs, so later patches to an entry (a wrapper replaced after push) still apply.
   */
  collapseSince(mark: HistoryMark, label?: string): void {
    if (mark.epoch !== this.epoch) return;
    const start = Math.max(0, mark.length - (this.dropped - mark.dropped));
    if (this.past.length - start < 2) return;
    const all = this.past.splice(start);
    const entries = all.filter(entry => !this.solo.has(entry));
    if (entries.length < 2) {
      this.past.push(...all);
      return;
    }
    // Solo steps keep their place below the folded one, so folding never takes a step that is not the caller's.
    this.past.push(...all.filter(entry => this.solo.has(entry)));
    const run = async (list: T[], redo: boolean): Promise<void> => {
      const done: T[] = [];
      try {
        for (const entry of list) {
          await (redo ? entry.redo() : entry.undo());
          done.push(entry);
        }
      } catch (error) {
        // Put back what already ran so the map is not left half-way; the original error is what the caller sees.
        try {
          for (const entry of done.reverse()) await (redo ? entry.undo() : entry.redo());
        } catch {
          // best effort
        }
        throw error;
      }
    };
    const combined = {
      undo: () => run([...entries].reverse(), false),
      redo: () => run(entries, true),
      ...(label ? { label } : {})
    } as T;
    this.past.push(combined);
    this.future = [];
  }
}
