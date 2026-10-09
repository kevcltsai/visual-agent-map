import { t, translate } from "./i18n";

export interface MapNode {
  id: string;
  path: string;
  parentId: string | null;
  x: number;
  y: number;
  collapsed: boolean;
  mindSearchKind?: MindSearchNodeKind;
  mindSearchQuestion?: { requestId: string; parentBranchId?: string | null; options: { id: string; label: string }[]; allowMultiple: boolean; allowFreeText: boolean };
  mindSearchConvergesFromNodeIds?: string[];
}
export type MindSearchNodeKind = "topic" | "question" | "answer" | "research" | "synthesis" | "conclusion";
export interface MapDocument {
  version: 1;
  id: string;
  title: string;
  nodes: MapNode[];
  viewport: { x: number; y: number; zoom: number };
  mindSearch?: MindSearchMapData;
}

export function clearQuestionConvergenceEdges(map: MapDocument): boolean {
  let changed = false;
  for (const node of map.nodes) {
    if (node.mindSearchKind !== "question" || node.mindSearchConvergesFromNodeIds === undefined) continue;
    delete node.mindSearchConvergesFromNodeIds;
    changed = true;
  }
  return changed;
}

export function parentIdsForNode(node: MapNode): string[] {
  const convergenceParents = node.mindSearchKind === "question" ? [] : node.mindSearchConvergesFromNodeIds ?? [];
  return [...(node.parentId ? [node.parentId] : []), ...convergenceParents.filter(id => id !== node.parentId)];
}

export interface MindSearchBranchRecord {
  id: string;
  submissionId?: string;
  /** Original question node from which an answer-specific question pivot was copied. */
  sourceQuestionNodeId?: string;
  questionNodeId: string;
  answerNodeId?: string;
  parentBranchId: string | null;
  answerSnapshot: { selections: string[]; freeText: string };
  inputSnapshot: { topic: string; conditions: Record<string, string>; upstreamResults: { notePath: string; version: number }[] };
  createdAt: string;
  researchPlan?: { id: string; title: string; task: string; expectedValue: string }[];
  researchPlanError?: string;
  results: { resultId: string; runId: string; attemptId: string; nodeId: string; notePath: string; version: number; kind?: "research" | "synthesis" | "conclusion"; subtopicId?: string }[];
}
export interface MindSearchResultDraftRecord { id: string; branchId: string; nodeId: string; notePath: string; title: string; status: "creating" | "ready"; runId: string; attemptId: string; inputSnapshotHash: string; model?: string; reasoning?: "low" | "medium" | "high"; kind?: "research" | "synthesis" | "conclusion"; subtopicId?: string; parentNodeId?: string; convergesFromNodeIds?: string[] }
export interface MindSearchPlannerReviewRecord { decision: "research_more" | "ask_user" | "conclude"; rationale: string; researchTurn: number; question?: string; answerOptions?: (string | { axisId: string; value: string })[]; answerAxis?: { id: string; label: string }; researchTarget?: { title: string; task: string; expectedValue: string } }
export interface MindSearchSearchDiagnostic { researchTurn: number; startedEvents: number; completedEvents: number; completedSearchActions: number; otherCompletedActions: number }
export interface MindSearchAttemptRecord {
  id: string;
  inputSnapshotHash: string;
  status: "running" | "saving" | "completed" | "partial" | "failed" | "cancelled" | "superseded";
  stopReason?: string;
  model?: string;
  reasoningLevel?: "low" | "medium" | "high";
  maxResearchTurns?: number;
  researchTurns?: number;
  plannerReviews?: MindSearchPlannerReviewRecord[];
  searchDiagnostics?: MindSearchSearchDiagnostic[];
}
export interface MindSearchRunRecord {
  id: string;
  branchId: string;
  currentAttemptId: string;
  attempts: MindSearchAttemptRecord[];
}
export interface MindSearchPendingCommit {
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
export interface MindSearchQuestionDraft {
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
export interface MindSearchMapData {
  version: 1;
  creationId?: string;
  /** Exploration target; legacy field name retained for saved maps. Never forces questions or completion. */
  minimumAnswersBeforeConclusion?: number;
  rootDraft?: { nodeId: string; notePath: string; title: string; context: string; model?: string; reasoning?: "low" | "medium" | "high" };
  branches: MindSearchBranchRecord[];
  runs: MindSearchRunRecord[];
  resultDrafts?: MindSearchResultDraftRecord[];
  questionDraft?: MindSearchQuestionDraft;
  pendingCommits: MindSearchPendingCommit[];
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function descendants(nodes: MapNode[], id: string): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop();
    for (const node of nodes) {
      if (node.parentId === parent && node.id !== id && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
    }
  }
  return found;
}
export function canParent(nodes: MapNode[], id: string, parentId: string | null): boolean {
  return parentId === null || (parentId !== id && nodes.some(n => n.id === parentId) && !descendants(nodes, id).has(parentId));
}
export function visibleNodes(nodes: MapNode[]): MapNode[] {
  const hidden = new Set<string>();
  for (const node of nodes) if (node.collapsed) for (const id of descendants(nodes, node.id)) hidden.add(id);
  return nodes.filter(node => !hidden.has(node.id));
}
export function removeNodes(nodes: MapNode[], id: string, branch: boolean): MapNode[] {
  const removed = branch ? descendants(nodes, id) : new Set<string>();
  removed.add(id);
  return nodes.filter(node => !removed.has(node.id)).map(node => ({ ...node, parentId: node.parentId && removed.has(node.parentId) ? null : node.parentId }));
}
export function parseMap(content: string): MapDocument {
  const block = content.match(/```agent-map\s*\n([\s\S]*?)\n```/);
  if (!block) throw new Error(t("ui.mind_map_data_was_not_found_keep_the_agent_map_block"));
  const map = JSON.parse(block[1]) as MapDocument;
  if (map.version !== 1 || typeof map.id !== "string" || typeof map.title !== "string" || !Array.isArray(map.nodes)) throw new Error(t("ui.invalid_mind_map_format"));
  const ids = new Set<string>(), mindSearchQuestionRequests = new Set<string>();
  for (const n of map.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.path !== "string" || !n.path.endsWith(".md") || !Number.isFinite(n.x) || !Number.isFinite(n.y) || (n.parentId !== null && typeof n.parentId !== "string") || ids.has(n.id)) throw new Error(t("ui.invalid_node_data_or_duplicate_id"));
    ids.add(n.id);
    n.collapsed = n.collapsed === true;
    if (n.mindSearchKind !== undefined && !["topic", "question", "answer", "research", "synthesis", "conclusion"].includes(n.mindSearchKind)) throw new Error("Invalid MindSearch node kind.");
    if (n.mindSearchConvergesFromNodeIds !== undefined && (!Array.isArray(n.mindSearchConvergesFromNodeIds) || new Set(n.mindSearchConvergesFromNodeIds).size !== n.mindSearchConvergesFromNodeIds.length || n.mindSearchConvergesFromNodeIds.some(id => typeof id !== "string" || id === n.id || !map.nodes.some(candidate => candidate.id === id)))) throw new Error("Invalid MindSearch convergence references.");
    if (n.mindSearchQuestion !== undefined) {
      const question = n.mindSearchQuestion;
      if (n.mindSearchKind !== "question" || !question || typeof question.requestId !== "string" || !question.requestId.trim() || !(question.parentBranchId === undefined || question.parentBranchId === null || typeof question.parentBranchId === "string") || !Array.isArray(question.options) || question.options.length < 2 || question.options.some(option => !option || typeof option.id !== "string" || !option.id.trim() || typeof option.label !== "string" || !option.label.trim()) || new Set(question.options.map(option => option.id)).size !== question.options.length || typeof question.allowMultiple !== "boolean" || typeof question.allowFreeText !== "boolean") throw new Error("Invalid MindSearch question controls.");
      if (mindSearchQuestionRequests.has(question.requestId)) throw new Error("Duplicate MindSearch question request identity.");
      mindSearchQuestionRequests.add(question.requestId);
    }
  }
  for (const n of map.nodes) if (!canParent(map.nodes, n.id, n.parentId)) throw new Error(t("ui.a_link_contains_a_cycle_or_points_to_a_missing_parent_topic"));
  if (map.mindSearch !== undefined) validateMindSearchMap(map);
  if (!map.viewport || !Number.isFinite(map.viewport.x) || !Number.isFinite(map.viewport.y) || !Number.isFinite(map.viewport.zoom)) map.viewport = { x: 40, y: 40, zoom: 1 };
  map.viewport.zoom = Math.min(2, Math.max(0.25, map.viewport.zoom));
  return map;
}
function validateMindSearchMap(map: MapDocument): void {
  const data = map.mindSearch as MindSearchMapData;
  if (!data || data.version !== 1 || !Array.isArray(data.branches) || !Array.isArray(data.runs) || !Array.isArray(data.pendingCommits) || (data.resultDrafts !== undefined && !Array.isArray(data.resultDrafts))) throw new Error("Invalid MindSearch map extension.");
  if (data.creationId !== undefined && (typeof data.creationId !== "string" || !data.creationId.trim())) throw new Error("Invalid MindSearch creation identity.");
  if (data.minimumAnswersBeforeConclusion !== undefined && (!Number.isInteger(data.minimumAnswersBeforeConclusion) || data.minimumAnswersBeforeConclusion < 1 || data.minimumAnswersBeforeConclusion > 10)) throw new Error("Invalid MindSearch exploration question target.");
  if (data.rootDraft !== undefined && (!data.rootDraft || typeof data.rootDraft.nodeId !== "string" || typeof data.rootDraft.notePath !== "string" || !data.rootDraft.notePath.endsWith(".md") || typeof data.rootDraft.title !== "string" || typeof data.rootDraft.context !== "string" || (data.rootDraft.model !== undefined && (typeof data.rootDraft.model !== "string" || !data.rootDraft.model.trim())) || (data.rootDraft.reasoning !== undefined && !["low", "medium", "high"].includes(data.rootDraft.reasoning)) || map.nodes.some(node => node.id === data.rootDraft!.nodeId))) throw new Error("Invalid MindSearch root draft.");
  if (data.questionDraft !== undefined) {
    const draft = data.questionDraft;
    if (!draft || typeof draft.requestId !== "string" || !draft.requestId.trim() || map.nodes.some(node => node.mindSearchQuestion?.requestId === draft.requestId) || typeof draft.nodeId !== "string" || map.nodes.some(node => node.id === draft.nodeId) || typeof draft.parentId !== "string" || !map.nodes.some(node => node.id === draft.parentId) || !(draft.parentBranchId === undefined || draft.parentBranchId === null || typeof draft.parentBranchId === "string") || typeof draft.notePath !== "string" || !draft.notePath.endsWith(".md") || typeof draft.title !== "string" || typeof draft.summary !== "string" || !draft.summary.trim() || typeof draft.detail !== "string" || typeof draft.prompt !== "string" || typeof draft.model !== "string" || (draft.reasoning !== undefined && !["low", "medium", "high"].includes(draft.reasoning)) || !Array.isArray(draft.options) || draft.options.length < 2 || draft.options.some(option => !option || typeof option.id !== "string" || !option.id.trim() || typeof option.label !== "string" || !option.label.trim()) || new Set(draft.options.map(option => option.id)).size !== draft.options.length || (draft.convergesFromNodeIds !== undefined && (!Array.isArray(draft.convergesFromNodeIds) || new Set(draft.convergesFromNodeIds).size !== draft.convergesFromNodeIds.length || draft.convergesFromNodeIds.some(id => !map.nodes.some(node => node.id === id))))) throw new Error("Invalid MindSearch question draft.");
  }
  const branchIds = new Set<string>(), submissionIds = new Set<string>();
  for (const branch of data.branches) {
    if (!branch || typeof branch.id !== "string" || branchIds.has(branch.id) || (branch.submissionId !== undefined && (typeof branch.submissionId !== "string" || !branch.submissionId.trim() || submissionIds.has(branch.submissionId))) || (branch.sourceQuestionNodeId !== undefined && (typeof branch.sourceQuestionNodeId !== "string" || !branch.sourceQuestionNodeId.trim())) || typeof branch.questionNodeId !== "string" || !map.nodes.some(node => node.id === branch.questionNodeId) || (branch.answerNodeId !== undefined && (typeof branch.answerNodeId !== "string" || !map.nodes.some(node => node.id === branch.answerNodeId && node.mindSearchKind === "answer" && node.parentId === branch.questionNodeId))) || !(branch.parentBranchId === null || typeof branch.parentBranchId === "string") || !branch.answerSnapshot || !Array.isArray(branch.answerSnapshot.selections) || branch.answerSnapshot.selections.some(item => typeof item !== "string") || typeof branch.answerSnapshot.freeText !== "string" || !branch.inputSnapshot || typeof branch.inputSnapshot.topic !== "string" || !branch.inputSnapshot.conditions || typeof branch.inputSnapshot.conditions !== "object" || Array.isArray(branch.inputSnapshot.conditions) || !Array.isArray(branch.inputSnapshot.upstreamResults) || !Array.isArray(branch.results) || (branch.researchPlanError !== undefined && (typeof branch.researchPlanError !== "string" || !branch.researchPlanError.trim() || branch.researchPlanError.length > 500)) || (branch.researchPlan !== undefined && (!Array.isArray(branch.researchPlan) || branch.researchPlan.length < 2 || branch.researchPlan.length > 5 || branch.researchPlan.some(item => !item || typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || !item.title.trim() || typeof item.task !== "string" || !item.task.trim() || typeof item.expectedValue !== "string" || !item.expectedValue.trim()) || new Set(branch.researchPlan.map(item => item.id)).size !== branch.researchPlan.length || new Set(branch.researchPlan.map(item => item.title.trim().toLowerCase())).size !== branch.researchPlan.length))) throw new Error("Invalid MindSearch branch snapshot.");
    branchIds.add(branch.id);
    if (branch.submissionId) submissionIds.add(branch.submissionId);
    const questionNode = map.nodes.find(node => node.id === branch.questionNodeId)!;
    if (questionNode.mindSearchQuestion && questionNode.mindSearchQuestion.parentBranchId !== branch.parentBranchId) throw new Error("MindSearch answer branch does not match its question's parent branch.");
  }
  for (const branch of data.branches) {
    if (branch.parentBranchId && !branchIds.has(branch.parentBranchId)) throw new Error("MindSearch branch points to a missing parent.");
    const seen = new Set([branch.id]); let parent = branch.parentBranchId;
    while (parent) {
      if (seen.has(parent)) throw new Error("MindSearch answer branches cannot contain cycles.");
      seen.add(parent); parent = data.branches.find(item => item.id === parent)?.parentBranchId ?? null;
    }
  }
  const runIds = new Set<string>();
  const validAttempt = (attempt: MindSearchAttemptRecord): boolean => {
    if (!attempt || typeof attempt.id !== "string" || typeof attempt.inputSnapshotHash !== "string") return false;
    if (!["running", "saving", "completed", "partial", "failed", "cancelled", "superseded"].includes(attempt.status)) return false;
    if (attempt.model !== undefined && (typeof attempt.model !== "string" || !attempt.model.trim())) return false;
    if (attempt.reasoningLevel !== undefined && !["low", "medium", "high"].includes(attempt.reasoningLevel)) return false;
    if (attempt.maxResearchTurns !== undefined && (!Number.isInteger(attempt.maxResearchTurns) || attempt.maxResearchTurns < 1 || attempt.maxResearchTurns > 3)) return false;
    if (attempt.researchTurns !== undefined && (!Number.isInteger(attempt.researchTurns) || attempt.researchTurns < 0 || attempt.researchTurns > (attempt.maxResearchTurns ?? 3))) return false;
    if (attempt.plannerReviews !== undefined && (!Array.isArray(attempt.plannerReviews) || attempt.plannerReviews.some(review => !review || !["research_more", "ask_user", "conclude"].includes(review.decision) || typeof review.rationale !== "string" || !review.rationale.trim() || !Number.isInteger(review.researchTurn) || review.researchTurn < 1 || review.researchTurn > 3 || (review.question !== undefined && (typeof review.question !== "string" || !review.question.trim())) || (review.answerOptions !== undefined && (!Array.isArray(review.answerOptions) || review.answerOptions.some(option => typeof option === "string" ? !option.trim() : !option || typeof option.axisId !== "string" || !option.axisId.trim() || typeof option.value !== "string" || !option.value.trim()))) || (review.answerAxis !== undefined && (!review.answerAxis || typeof review.answerAxis.id !== "string" || !review.answerAxis.id.trim() || typeof review.answerAxis.label !== "string" || !review.answerAxis.label.trim())) || (review.researchTarget !== undefined && (!review.researchTarget || typeof review.researchTarget.title !== "string" || !review.researchTarget.title.trim() || typeof review.researchTarget.task !== "string" || !review.researchTarget.task.trim() || typeof review.researchTarget.expectedValue !== "string" || !review.researchTarget.expectedValue.trim()))))) return false;
    if (attempt.searchDiagnostics !== undefined && (!Array.isArray(attempt.searchDiagnostics) || attempt.searchDiagnostics.some(item => !item || !Number.isInteger(item.researchTurn) || item.researchTurn < 1 || !Number.isInteger(item.startedEvents) || item.startedEvents < 0 || !Number.isInteger(item.completedEvents) || item.completedEvents < 0 || !Number.isInteger(item.completedSearchActions) || item.completedSearchActions < 0 || !Number.isInteger(item.otherCompletedActions) || item.otherCompletedActions < 0))) return false;
    return true;
  };
  for (const run of data.runs) {
    if (!run || typeof run.id !== "string" || runIds.has(run.id) || !branchIds.has(run.branchId) || typeof run.currentAttemptId !== "string" || !Array.isArray(run.attempts) || !run.attempts.some(attempt => attempt.id === run.currentAttemptId) || run.attempts.some(attempt => !validAttempt(attempt))) throw new Error("Invalid MindSearch run record.");
    runIds.add(run.id);
  }
  const resultIds = new Set<string>();
  for (const branch of data.branches) for (const result of branch.results) {
    const run = data.runs.find(item => item.id === result?.runId), attempt = run?.attempts.find(item => item.id === result?.attemptId);
    if (!result || typeof result.resultId !== "string" || resultIds.has(result.resultId) || !run || run.branchId !== branch.id || !["completed", "partial"].includes(attempt?.status ?? "") || typeof result.nodeId !== "string" || typeof result.notePath !== "string" || !Number.isInteger(result.version) || result.version < 1 || (result.kind !== undefined && !["research", "synthesis", "conclusion"].includes(result.kind)) || (result.subtopicId !== undefined && (!branch.researchPlan?.some(item => item.id === result.subtopicId) || typeof result.subtopicId !== "string")) || !map.nodes.some(node => node.id === result.nodeId && node.path === result.notePath && (node.parentId === (branch.answerNodeId ?? branch.questionNodeId) || branch.results.some(parent => parent.nodeId === node.parentId)))) throw new Error("Invalid MindSearch branch result reference.");
    resultIds.add(result.resultId);
  }
  const drafts = data.resultDrafts ?? [];
  const draftIds = new Set<string>();
  for (const draft of drafts) {
    const branch = draft && data.branches.find(item => item.id === draft.branchId);
    const run = draft && data.runs.find(item => item.id === draft.runId), attempt = run?.attempts.find(item => item.id === draft.attemptId);
    if (!draft || typeof draft.id !== "string" || draftIds.has(draft.id) || !branch || typeof draft.nodeId !== "string" || typeof draft.notePath !== "string" || !draft.notePath.endsWith(".md") || typeof draft.title !== "string" || (draft.status !== "creating" && draft.status !== "ready") || (draft.model !== undefined && (typeof draft.model !== "string" || !draft.model.trim())) || (draft.reasoning !== undefined && !["low", "medium", "high"].includes(draft.reasoning)) || (draft.kind !== undefined && !["research", "synthesis", "conclusion"].includes(draft.kind)) || (draft.subtopicId !== undefined && !branch.researchPlan?.some(item => item.id === draft.subtopicId)) || run?.branchId !== branch.id || !attempt || attempt.inputSnapshotHash !== draft.inputSnapshotHash || !map.nodes.some(node => node.id === draft.nodeId && node.path === draft.notePath && node.parentId === (draft.parentNodeId ?? branch.answerNodeId ?? branch.questionNodeId))) throw new Error("Invalid MindSearch result draft.");
    draftIds.add(draft.id);
  }
  for (const pending of data.pendingCommits) {
    const run = data.runs.find(item => item.id === pending?.runId), attempt = run?.attempts.find(item => item.id === pending?.attemptId);
    const branch = data.branches.find(item => item.id === pending?.branchId), draft = drafts.find(item => item.id === pending?.resultDraftId);
    if (!pending || (pending.resultStatus !== undefined && !["completed", "partial"].includes(pending.resultStatus)) || !run || run.branchId !== pending.branchId || run.currentAttemptId !== pending.attemptId || attempt?.status !== "saving" || !branch || !draft || draft.status !== "ready" || draft.branchId !== branch.id || draft.runId !== run.id || draft.attemptId !== attempt.id || draft.nodeId !== pending.nodeId || draft.notePath !== pending.notePath || typeof pending.notePath !== "string" || !pending.notePath.endsWith(".md")) throw new Error("Invalid MindSearch pending commit.");
  }
}
export function serializeMap(map: MapDocument, language: "zh-TW" | "en" = "zh-TW"): string {
  const description = translate(language, "ui.map_file_description");
  return `---\nvisual-agent-map: true\n---\n\n# ${map.title.replace(/\n/g, " ")}\n\n${description}\n\n\`\`\`agent-map\n${JSON.stringify(map, null, 2)}\n\`\`\`\n`;
}
export function inheritModel(parentModel: string | undefined, defaultModel: string): string {
  return parentModel ?? defaultModel;
}
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoEntry(): T | undefined { return this.past[this.past.length - 1]; }
  get redoEntry(): T | undefined { return this.future[this.future.length - 1]; }
  push(entry: T): void { this.past.push(entry); if (this.past.length > 80) this.past.shift(); this.future = []; }
  undo(): T | undefined { const entry = this.past.pop(); if (entry) this.future.push(entry); return entry; }
  redo(): T | undefined { const entry = this.future.pop(); if (entry) this.past.push(entry); return entry; }
  clear(): void { this.past = []; this.future = []; }
}
