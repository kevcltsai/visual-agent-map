import { createHash, randomUUID } from "node:crypto";
import type { AiResult } from "../ai/types";
import type { MapDocument, MindSearchBranchRecord, MindSearchMapData, MindSearchPendingCommit, MindSearchPlannerReviewRecord, MindSearchResultDraftRecord, MindSearchSearchDiagnostic } from "../map-model";
import type { Repository } from "../repository";

export interface NewAnswerBranch {
  requestId?: string;
  questionNodeId: string;
  parentBranchId: string | null;
  answerSnapshot: { selections: string[]; freeText: string };
  inputSnapshot: { topic: string; conditions: Record<string, string>; upstreamResults: { notePath: string; version: number }[] };
}
export interface AttemptHandle { runId: string; attemptId: string; inputSnapshotHash: string; dispatch: boolean }
export type CommitResult = { status: "committed"; resultId: string; notePath: string; resultStatus?: "completed" | "partial" } | { status: "stale"; runId: string; attemptId: string };
export type ResultDraftCreation = { status: "ready"; draft: MindSearchResultDraftRecord } | { status: "stale"; runId: string; attemptId: string };
export interface MindSearchAttemptConfig { model: string; reasoning: "low" | "medium" | "high"; maxResearchTurns: number }
export interface MindSearchResultDraftOptions { kind?: "research" | "synthesis" | "conclusion"; subtopicId?: string; parentNodeId?: string; convergesFromNodeIds?: string[] }

/** Minimal MVE store: immutable user-answer snapshots, attempt fencing, and idempotent Map/Note recovery. */
export class MindSearchRunStore {
  private static readonly liveAttempts = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly repository: Repository, private readonly id: () => string = randomUUID, private readonly now: () => string = () => new Date().toISOString()) {}

  async createAnswerBranch(mapPath: string, input: NewAnswerBranch): Promise<MindSearchBranchRecord> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map);
      const requestId = input.requestId?.trim();
      const existing = requestId ? state.branches.find(branch => branch.submissionId === requestId) : undefined;
      if (existing) {
        const sameSubmission = (existing.sourceQuestionNodeId ?? existing.questionNodeId) === input.questionNodeId && existing.parentBranchId === input.parentBranchId && JSON.stringify(existing.answerSnapshot) === JSON.stringify(input.answerSnapshot) && JSON.stringify(existing.inputSnapshot) === JSON.stringify(input.inputSnapshot);
        if (!sameSubmission) throw new Error("This answer submission identity was already used for different input.");
        await this.recoverAnswerBranchesInMap(mapPath, map);
        return JSON.parse(JSON.stringify(existing)) as MindSearchBranchRecord;
      }
      await this.recoverAnswerBranchesInMap(mapPath, map);
      const questionNode = map.nodes.find(node => node.id === input.questionNodeId);
      if (!questionNode) throw new Error("Question node does not exist in this map.");
      if (questionNode.mindSearchQuestion) {
        const allowed = new Set(questionNode.mindSearchQuestion.options.map(option => option.id));
        if (input.answerSnapshot.selections.some(selection => !allowed.has(selection))) throw new Error("The submitted answer contains an option that was not offered by this question.");
        if (!questionNode.mindSearchQuestion.allowMultiple && input.answerSnapshot.selections.length > 1) throw new Error("This question accepts only one selected option.");
        if (!questionNode.mindSearchQuestion.allowFreeText && input.answerSnapshot.freeText.trim()) throw new Error("This question does not accept free-text answers.");
        if ((questionNode.mindSearchQuestion.parentBranchId ?? null) !== input.parentBranchId) throw new Error("Answer branch does not continue the branch that produced this question.");
      }
      if (input.parentBranchId && !state.branches.some(branch => branch.id === input.parentBranchId)) throw new Error("Parent answer branch does not exist.");
      await this.splitSharedQuestionPivots(mapPath, map);
      const prior = state.branches.find(branch => branch.questionNodeId === questionNode.id);
      let branchQuestion = questionNode;
      let sourceQuestionNodeId = questionNode.id;
      if (prior) {
        branchQuestion = await this.cloneQuestionForBranch(mapPath, map, questionNode);
      }
      const branch: MindSearchBranchRecord = {
        id: this.id(), ...(requestId ? { submissionId: requestId } : {}), sourceQuestionNodeId, questionNodeId: branchQuestion.id, parentBranchId: input.parentBranchId,
        answerSnapshot: JSON.parse(JSON.stringify(input.answerSnapshot)) as MindSearchBranchRecord["answerSnapshot"],
        inputSnapshot: JSON.parse(JSON.stringify(input.inputSnapshot)) as MindSearchBranchRecord["inputSnapshot"],
        createdAt: this.now(), results: []
      };
      state.branches.push(branch); map.mindSearch = state; await this.repository.saveMap(mapPath, map);
      return JSON.parse(JSON.stringify(branch)) as MindSearchBranchRecord;
    });
  }

  /** Keeps answer-specific questions and result children connected without legacy answer pivot nodes. */
  async recoverAnswerBranches(mapPath: string): Promise<number> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath);
      return this.recoverAnswerBranchesInMap(mapPath, map);
    });
  }

  private async recoverAnswerBranchesInMap(mapPath: string, map: MapDocument): Promise<number> {
    const state = this.state(map);
    let changed = await this.splitSharedQuestionPivots(mapPath, map);
    const removedPivots = new Set<string>();
    for (const branch of state.branches) {
      const question = map.nodes.find(node => node.id === branch.questionNodeId);
      if (!question) throw new Error("The answer's question node is missing.");
      if (branch.answerNodeId) {
        const pivot = map.nodes.find(node => node.id === branch.answerNodeId && node.mindSearchKind === "answer");
        if (pivot) {
          for (const node of map.nodes) if (node.parentId === pivot.id) node.parentId = question.id;
          for (const draft of state.resultDrafts ?? []) {
            if (draft.branchId === branch.id && draft.parentNodeId === pivot.id) delete draft.parentNodeId;
          }
          removedPivots.add(pivot.id);
        }
        delete branch.answerNodeId;
        changed++;
      }
      for (const result of branch.results) {
        const node = map.nodes.find(item => item.id === result.nodeId);
        if (node && removedPivots.has(node.parentId ?? "")) { node.parentId = question.id; changed++; }
      }
    }
    if (removedPivots.size) { map.nodes = map.nodes.filter(node => !removedPivots.has(node.id)); changed += removedPivots.size; }
    if (changed) { map.mindSearch = state; await this.repository.saveMap(mapPath, map); }
    return changed;
  }

  /** Give each saved answer its own question pivot before continuing legacy shared-question branches. */
  private async splitSharedQuestionPivots(mapPath: string, map: MapDocument): Promise<number> {
    const state = this.state(map), grouped = new Map<string, MindSearchBranchRecord[]>();
    for (const branch of state.branches) {
      const group = grouped.get(branch.questionNodeId) ?? [];
      group.push(branch); grouped.set(branch.questionNodeId, group);
    }
    let created = 0;
    for (const [questionNodeId, branches] of grouped) {
      if (branches.length < 2) continue;
      const source = map.nodes.find(node => node.id === questionNodeId);
      if (!source) throw new Error("The answer's question node is missing.");
      for (const branch of branches.slice(1)) {
        const copy = await this.cloneQuestionForBranch(mapPath, map, source);
        branch.sourceQuestionNodeId ??= source.id;
        branch.questionNodeId = copy.id;
        if (branch.answerNodeId) {
          const answer = map.nodes.find(node => node.id === branch.answerNodeId);
          if (answer) answer.parentId = copy.id;
        }
        const resultNodeIds = new Set(branch.results.map(result => result.nodeId));
        for (const resultId of resultNodeIds) {
          const node = map.nodes.find(item => item.id === resultId);
          if (node?.parentId === source.id) node.parentId = copy.id;
        }
        for (const draft of state.resultDrafts ?? []) {
          if (draft.branchId !== branch.id) continue;
          const node = map.nodes.find(item => item.id === draft.nodeId);
          if (draft.parentNodeId === source.id || (!draft.parentNodeId && node?.parentId === source.id)) {
            if (draft.parentNodeId) draft.parentNodeId = copy.id;
            if (node?.parentId === source.id) node.parentId = copy.id;
          }
        }
        created++;
      }
    }
    if (created) { map.mindSearch = state; await this.repository.saveMap(mapPath, map); }
    return created;
  }

  private async cloneQuestionForBranch(mapPath: string, map: MapDocument, source: MapDocument["nodes"][number]): Promise<MapDocument["nodes"][number]> {
    if (source.mindSearchKind !== "question" || !source.mindSearchQuestion) throw new Error("A saved MindSearch question is required to create an answer-specific pivot.");
    const note = await this.repository.readNote(source.path);
    const clone = await this.repository.duplicateNote(source.path, map, mapPath);
    await this.repository.updateNote(clone.path, { title: note.title });
    const siblingCount = map.nodes.filter(node => node.parentId === source.parentId && node.mindSearchKind === "question").length;
    const pivot = {
      ...source,
      id: clone.id,
      path: clone.path,
      x: source.x,
      y: source.y + (siblingCount + 1) * 600,
      collapsed: false,
      mindSearchQuestion: { ...source.mindSearchQuestion, requestId: this.id() }
    };
    delete pivot.mindSearchConvergesFromNodeIds;
    map.nodes.push(pivot);
    return pivot;
  }

  async saveResearchPlan(mapPath: string, branchId: string, plan: NonNullable<MindSearchBranchRecord["researchPlan"]>): Promise<void> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), branch = state.branches.find(item => item.id === branchId);
      if (!branch) throw new Error("Answer branch does not exist.");
      if (branch.researchPlan) {
        if (JSON.stringify(branch.researchPlan) !== JSON.stringify(plan)) throw new Error("The saved research plan for this answer branch cannot be replaced.");
        return;
      }
      if (plan.length < 2 || plan.length > 5 || plan.some(item => !item.id.trim() || !item.title.trim() || !item.task.trim() || !item.expectedValue.trim()) || new Set(plan.map(item => item.id)).size !== plan.length || new Set(plan.map(item => item.title.trim().toLowerCase())).size !== plan.length) throw new Error("A new MindSearch research plan needs 2–5 distinct subtopics with unique ids and titles.");
      branch.researchPlan = JSON.parse(JSON.stringify(plan)) as NonNullable<MindSearchBranchRecord["researchPlan"]>;
      delete branch.researchPlanError;
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
    });
  }

  async saveResearchPlanError(mapPath: string, branchId: string, error: unknown): Promise<void> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), branch = state.branches.find(item => item.id === branchId);
      if (!branch || branch.researchPlan) return;
      const message = error instanceof Error ? error.message : String(error);
      branch.researchPlanError = message.slice(0, 500) || "Research subtopics were not generated.";
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
    });
  }

  async clearResearchPlanError(mapPath: string, branchId: string): Promise<void> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), branch = state.branches.find(item => item.id === branchId);
      if (!branch || !branch.researchPlanError) return;
      delete branch.researchPlanError;
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
    });
  }

  async startAttempt(mapPath: string, branchId: string, runId?: string, config?: MindSearchAttemptConfig): Promise<AttemptHandle> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), branch = state.branches.find(item => item.id === branchId);
      if (!branch) throw new Error("Answer branch does not exist.");
      if (!runId) {
        const activeRun = state.runs.find(item => item.branchId === branchId && (() => { const attempt = item.attempts.find(candidate => candidate.id === item.currentAttemptId); return attempt?.status === "running" || attempt?.status === "saving"; })());
        if (activeRun) {
          const activeAttempt = activeRun.attempts.find(item => item.id === activeRun.currentAttemptId)!;
          return { runId: activeRun.id, attemptId: activeAttempt.id, inputSnapshotHash: activeAttempt.inputSnapshotHash, dispatch: false };
        }
      }
      const id = runId ?? this.id();
      let run = state.runs.find(item => item.id === id);
      if (run && run.branchId !== branchId) throw new Error("A research run cannot move to another answer branch.");
      if (!run) { run = { id, branchId, currentAttemptId: "", attempts: [] }; state.runs.push(run); }
      const current = run.attempts.find(item => item.id === run.currentAttemptId);
      if (current && (current.status === "running" || current.status === "saving")) {
        this.releaseAttempt(mapPath, { runId: id, attemptId: current.id, inputSnapshotHash: current.inputSnapshotHash, dispatch: false });
        current.status = "superseded"; current.stopReason = "A newer attempt started for this run.";
        const staleDrafts = (state.resultDrafts ?? []).filter(item => item.runId === id && item.attemptId === current.id);
        const staleNodes = new Set(staleDrafts.map(item => item.nodeId));
        for (const draft of staleDrafts) await this.retireDraftNote(draft, current.stopReason);
        state.resultDrafts = (state.resultDrafts ?? []).filter(item => !staleNodes.has(item.nodeId));
        state.pendingCommits = state.pendingCommits.filter(item => item.runId !== id || item.attemptId !== current.id);
        map.nodes = map.nodes.filter(node => !staleNodes.has(node.id));
      }
      const attemptId = `attempt-${run.attempts.length + 1}`;
      const inputSnapshotHash = this.snapshotHash({ branch: branch.inputSnapshot, answer: branch.answerSnapshot });
      run.attempts.push({ id: attemptId, inputSnapshotHash, status: "running", ...(config ? { model: config.model, reasoningLevel: config.reasoning, maxResearchTurns: config.maxResearchTurns, researchTurns: 0, plannerReviews: [] } : {}) }); run.currentAttemptId = attemptId;
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
      MindSearchRunStore.liveAttempts.add(this.liveKey(mapPath, id, attemptId));
      return { runId: id, attemptId, inputSnapshotHash, dispatch: true };
    });
  }

  releaseAttempt(mapPath: string, handle: AttemptHandle): void { MindSearchRunStore.liveAttempts.delete(this.liveKey(mapPath, handle.runId, handle.attemptId)); }

  async recordResearchTurn(mapPath: string, handle: AttemptHandle): Promise<number> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) throw new Error("The MindSearch attempt is no longer current.");
      const next = (attempt.researchTurns ?? 0) + 1;
      if (next > (attempt.maxResearchTurns ?? 1)) throw new Error("The bounded MindSearch research-turn budget is exhausted.");
      attempt.researchTurns = next; map.mindSearch = state; await this.repository.saveMap(mapPath, map); return next;
    });
  }

  async recordPlannerReview(mapPath: string, handle: AttemptHandle, review: MindSearchPlannerReviewRecord, stopReason?: string): Promise<void> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) throw new Error("The MindSearch attempt is no longer current.");
      const reviews = attempt.plannerReviews ?? [];
      if (reviews.some(item => item.researchTurn === review.researchTurn)) throw new Error("A Planner review is already recorded for this research turn.");
      if (review.researchTurn !== (attempt.researchTurns ?? 0)) throw new Error("Planner review must follow a completed research turn.");
      reviews.push(JSON.parse(JSON.stringify(review)) as MindSearchPlannerReviewRecord); attempt.plannerReviews = reviews;
      if (stopReason?.trim()) attempt.stopReason = stopReason.trim();
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
    });
  }

  async recordSearchDiagnostic(mapPath: string, handle: AttemptHandle, diagnostic: MindSearchSearchDiagnostic): Promise<void> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) throw new Error("The MindSearch attempt is no longer current.");
      const diagnostics = attempt.searchDiagnostics ?? [];
      const existing = diagnostics.find(item => item.researchTurn === diagnostic.researchTurn);
      if (existing) Object.assign(existing, JSON.parse(JSON.stringify(diagnostic)) as MindSearchSearchDiagnostic);
      else diagnostics.push(JSON.parse(JSON.stringify(diagnostic)) as MindSearchSearchDiagnostic);
      attempt.searchDiagnostics = diagnostics.slice(-8);
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
    });
  }

  async updateResultDraftReport(mapPath: string, handle: AttemptHandle, draftId: string, summary: string, detail: string): Promise<boolean> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId), draft = state.resultDrafts?.find(item => item.id === draftId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash || !draft || draft.runId !== run.id || draft.attemptId !== attempt.id || draft.status !== "ready") return false;
      await this.repository.updateNote(draft.notePath, { summary, detail, status: "idea" });
      const saved = await this.repository.readNote(draft.notePath);
      if (saved.summary !== summary || saved.detail !== detail) throw new Error("The Searcher report did not match the Repository readback before Planner review.");
      return true;
    });
  }

  /** Retitles/reclassifies a saved synthesis draft after its bounded Planner review selects the final state. */
  async updateResultDraftPresentation(mapPath: string, handle: AttemptHandle, draftId: string, title: string, kind: "synthesis" | "conclusion"): Promise<boolean> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId), draft = state.resultDrafts?.find(item => item.id === draftId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash || !draft || draft.runId !== run.id || draft.attemptId !== attempt.id || draft.status !== "ready") return false;
      const node = map.nodes.find(item => item.id === draft.nodeId && item.path === draft.notePath);
      if (!node) throw new Error("MindSearch synthesis draft node is missing before finalization.");
      await this.repository.updateNote(draft.notePath, { title });
      const note = await this.repository.readNote(draft.notePath);
      if (note.title !== title) throw new Error("MindSearch synthesis draft title did not match its Repository readback.");
      draft.title = title; draft.kind = kind; node.mindSearchKind = kind;
      map.mindSearch = state; await this.repository.saveMap(mapPath, map);
      return true;
    });
  }

  async failAttempt(mapPath: string, handle: AttemptHandle, reason: string): Promise<boolean> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map);
      const run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) return false;
      if (state.pendingCommits.some(item => item.runId === handle.runId && item.attemptId === handle.attemptId)) throw new Error("A saving attempt must be recovered or explicitly cancelled before it can be failed.");
      attempt.status = "failed"; attempt.stopReason = reason;
      this.releaseAttempt(mapPath, handle);
      const drafts = (state.resultDrafts ?? []).filter(item => item.runId === handle.runId && item.attemptId === handle.attemptId);
      for (const draft of drafts) await this.retireDraftNote(draft, reason, "incomplete");
      const staleNodes = new Set(drafts.map(item => item.nodeId));
      state.resultDrafts = (state.resultDrafts ?? []).filter(item => !staleNodes.has(item.nodeId)); map.nodes = map.nodes.filter(node => !staleNodes.has(node.id));
      map.mindSearch = state; await this.repository.saveMap(mapPath, map); return true;
    });
  }

  async cancelAttempt(mapPath: string, handle: AttemptHandle, reason: string): Promise<boolean> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map);
      const run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) return false;
      if (state.pendingCommits.some(item => item.runId === handle.runId && item.attemptId === handle.attemptId)) return false;
      attempt.status = "cancelled"; attempt.stopReason = reason;
      this.releaseAttempt(mapPath, handle);
      const staleDrafts = (state.resultDrafts ?? []).filter(item => item.runId === handle.runId && item.attemptId === handle.attemptId);
      const staleNodes = new Set(staleDrafts.map(item => item.nodeId));
      for (const draft of staleDrafts) await this.retireDraftNote(draft, reason, "incomplete");
      state.resultDrafts = (state.resultDrafts ?? []).filter(item => !staleNodes.has(item.nodeId));
      state.pendingCommits = state.pendingCommits.filter(item => item.runId !== handle.runId || item.attemptId !== handle.attemptId);
      map.nodes = map.nodes.filter(node => !staleNodes.has(node.id));
      map.mindSearch = state; await this.repository.saveMap(mapPath, map); return true;
    });
  }

  async createResultDraft(mapPath: string, handle: AttemptHandle, title: string, model: string, reasoning?: "low" | "medium" | "high", options: MindSearchResultDraftOptions = {}): Promise<ResultDraftCreation> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) return { status: "stale", runId: handle.runId, attemptId: handle.attemptId };
      const branch = state.branches.find(item => item.id === run.branchId);
      if (!branch) throw new Error("Answer branch does not exist.");
      const folder = this.repository.topicFolder(mapPath, "Notes"); await this.repository.ensureTopicFolders(this.repository.topicRoot(mapPath));
      const notePath = this.repository.unique(folder, title), nodeId = this.id();
      const parentNodeId = options.parentNodeId ?? branch.questionNodeId, parent = map.nodes.find(item => item.id === parentNodeId);
      if (!parent) throw new Error("MindSearch result parent does not exist.");
      const siblingCount = map.nodes.filter(item => item.parentId === parentNodeId).length;
      const kind = options.kind ?? "research";
      const node = { id: nodeId, path: notePath, parentId: parentNodeId, x: parent.x + 360, y: parent.y + 180 + siblingCount * 220, collapsed: false, mindSearchKind: kind, ...(options.convergesFromNodeIds?.length ? { mindSearchConvergesFromNodeIds: [...options.convergesFromNodeIds] } : {}) };
      const draft: MindSearchResultDraftRecord = { id: this.id(), branchId: branch.id, nodeId, notePath, title, status: "creating", runId: run.id, attemptId: attempt.id, inputSnapshotHash: attempt.inputSnapshotHash, kind, ...(options.subtopicId ? { subtopicId: options.subtopicId } : {}), ...(parentNodeId !== branch.questionNodeId ? { parentNodeId } : {}), ...(options.convergesFromNodeIds?.length ? { convergesFromNodeIds: [...options.convergesFromNodeIds] } : {}), ...(attempt.model ? { model: attempt.model } : {}), ...(attempt.reasoningLevel ? { reasoning: attempt.reasoningLevel } : {}) };
      map.nodes.push(node); state.resultDrafts ??= []; state.resultDrafts.push(draft); map.mindSearch = state;
      await this.repository.saveMap(mapPath, map);
      await this.repository.createNoteAt(title, model, map, mapPath, "workspace", notePath, nodeId, { summary: "MindSearch result pending synthesis.", reasoning: reasoning ?? draft.reasoning });
      const latestMap = await this.repository.readMap(mapPath), latestState = this.state(latestMap), latestRun = latestState.runs.find(item => item.id === handle.runId), latestAttempt = latestRun?.attempts.find(item => item.id === handle.attemptId);
      const latestDraft = latestState.resultDrafts?.find(item => item.id === draft.id);
      if (!latestRun || latestRun.currentAttemptId !== handle.attemptId || latestAttempt?.status !== "running" || !latestDraft) {
        await this.retireDraftNote(draft, latestAttempt?.stopReason ?? "Attempt became stale while creating its result draft.");
        latestState.resultDrafts = (latestState.resultDrafts ?? []).filter(item => item.id !== draft.id); latestMap.nodes = latestMap.nodes.filter(item => item.id !== nodeId); latestMap.mindSearch = latestState;
        await this.repository.saveMap(mapPath, latestMap); return { status: "stale", runId: handle.runId, attemptId: handle.attemptId };
      }
      latestDraft.status = "ready"; latestMap.mindSearch = latestState; await this.repository.saveMap(mapPath, latestMap);
      return { status: "ready", draft: JSON.parse(JSON.stringify(latestDraft)) as MindSearchResultDraftRecord };
    });
  }

  async commitResult(mapPath: string, handle: AttemptHandle, resultDraftId: string, result: Pick<AiResult, "summary" | "detail">, resultStatus: "completed" | "partial" = "completed"): Promise<CommitResult> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), run = state.runs.find(item => item.id === handle.runId), attempt = run?.attempts.find(item => item.id === handle.attemptId);
      if (!run || !attempt || run.currentAttemptId !== handle.attemptId || attempt.status !== "running" || attempt.inputSnapshotHash !== handle.inputSnapshotHash) return { status: "stale", runId: handle.runId, attemptId: handle.attemptId };
      const branch = state.branches.find(item => item.id === run.branchId)!;
      const draft = state.resultDrafts?.find(item => item.id === resultDraftId && item.branchId === branch.id);
      if (!draft || draft.status !== "ready" || draft.runId !== run.id || draft.attemptId !== attempt.id || !map.nodes.some(node => node.id === draft.nodeId && node.path === draft.notePath && node.parentId === (draft.parentNodeId ?? branch.questionNodeId)) || branch.results.some(item => item.notePath === draft.notePath) || state.pendingCommits.some(item => item.notePath === draft.notePath)) throw new Error("MindSearch result must use a fresh, registered result draft owned by this answer attempt.");
      const pending: MindSearchPendingCommit = { resultId: `result-${run.id}-${attempt.id}`, branchId: branch.id, runId: run.id, attemptId: attempt.id, resultDraftId: draft.id, nodeId: draft.nodeId, notePath: draft.notePath, title: draft.title, summary: result.summary, detail: result.detail, version: branch.results.length + 1, resultStatus };
      attempt.status = "saving"; state.pendingCommits = state.pendingCommits.filter(item => item.resultId !== pending.resultId); state.pendingCommits.push(pending); map.mindSearch = state;
      await this.repository.saveMap(mapPath, map);
      try {
        await this.writePendingNote(pending);
        const currentMap = await this.repository.readMap(mapPath), currentState = this.state(currentMap), currentRun = currentState.runs.find(item => item.id === handle.runId), currentAttempt = currentRun?.attempts.find(item => item.id === handle.attemptId);
        if (!currentRun || currentRun.currentAttemptId !== handle.attemptId || currentAttempt?.status !== "saving") return { status: "stale", runId: handle.runId, attemptId: handle.attemptId };
        this.finishCommit(currentState, pending); currentMap.mindSearch = currentState; await this.repository.saveMap(mapPath, currentMap);
        this.releaseAttempt(mapPath, handle);
        return { status: "committed", resultId: pending.resultId, notePath: draft.notePath, ...(resultStatus === "partial" ? { resultStatus } : {}) };
      } catch (error) { this.releaseAttempt(mapPath, handle); throw error; }
    });
  }

  async recoverPending(mapPath: string): Promise<{ recovered: string[]; stale: string[] }> {
    return this.locked(mapPath, async () => {
      const recovered: string[] = [], stale: string[] = [], map = await this.repository.readMap(mapPath), state = this.state(map);
      for (const draft of [...(state.resultDrafts ?? [])]) {
        const run = state.runs.find(item => item.id === draft.runId), attempt = run?.attempts.find(item => item.id === draft.attemptId);
        if (run && attempt && MindSearchRunStore.liveAttempts.has(this.liveKey(mapPath, run.id, attempt.id))) continue;
        const hasPendingCommit = state.pendingCommits.some(item => item.resultDraftId === draft.id && item.runId === draft.runId && item.attemptId === draft.attemptId);
        const validRunningDraft = attempt?.status === "running" && (draft.status === "creating" || draft.status === "ready");
        const validSavingDraft = attempt?.status === "saving" && draft.status === "ready" && hasPendingCommit;
        if (!run || run.currentAttemptId !== draft.attemptId || (!validRunningDraft && !validSavingDraft) || attempt.inputSnapshotHash !== draft.inputSnapshotHash) {
          await this.retireDraftNote(draft, attempt?.stopReason ?? "The attempt is no longer current.");
          state.resultDrafts = (state.resultDrafts ?? []).filter(item => item.id !== draft.id); map.nodes = map.nodes.filter(node => node.id !== draft.nodeId); stale.push(draft.id); continue;
        }
        if (draft.status === "creating") {
          await this.repository.createNoteAt(draft.title, draft.model ?? "gpt-6-luna", map, mapPath, "workspace", draft.notePath, draft.nodeId, { summary: "MindSearch result pending synthesis.", reasoning: draft.reasoning });
          draft.status = "ready"; recovered.push(draft.id);
        }
      }
      for (const pending of [...state.pendingCommits]) {
        const run = state.runs.find(item => item.id === pending.runId), attempt = run?.attempts.find(item => item.id === pending.attemptId);
        if (run && attempt && MindSearchRunStore.liveAttempts.has(this.liveKey(mapPath, run.id, attempt.id))) continue;
        if (!run || run.currentAttemptId !== pending.attemptId || attempt?.status !== "saving") {
          state.pendingCommits = state.pendingCommits.filter(item => item.resultId !== pending.resultId); stale.push(pending.resultId); continue;
        }
        await this.writePendingNote(pending);
        this.finishCommit(state, pending); recovered.push(pending.resultId);
      }
      map.mindSearch = state; await this.repository.saveMap(mapPath, map); return { recovered, stale };
    });
  }

  async failInterrupted(mapPath: string): Promise<string[]> {
    return this.locked(mapPath, async () => {
      const map = await this.repository.readMap(mapPath), state = this.state(map), interrupted: string[] = [];
      for (const run of state.runs) {
        const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
        if (attempt?.status !== "running" || MindSearchRunStore.liveAttempts.has(this.liveKey(mapPath, run.id, attempt.id))) continue;
        const reason = "The app reopened after this research attempt stopped before saving a result. Retry is available; research was not resumed automatically.";
        attempt.status = "failed"; attempt.stopReason = reason; interrupted.push(run.id);
        const drafts = (state.resultDrafts ?? []).filter(item => item.runId === run.id && item.attemptId === attempt.id);
        for (const draft of drafts) await this.retireDraftNote(draft, reason, "incomplete");
        const staleNodes = new Set(drafts.map(item => item.nodeId));
        state.resultDrafts = (state.resultDrafts ?? []).filter(item => !staleNodes.has(item.nodeId)); map.nodes = map.nodes.filter(node => !staleNodes.has(node.id));
      }
      if (interrupted.length) { map.mindSearch = state; await this.repository.saveMap(mapPath, map); }
      return interrupted;
    });
  }

  private async writePendingNote(pending: MindSearchPendingCommit): Promise<void> {
    const noteStatus = pending.resultStatus === "partial" ? "idea" : "completed";
    await this.repository.updateNote(pending.notePath, { title: pending.title, summary: pending.summary, detail: pending.detail, status: noteStatus });
    const saved = await this.repository.readNote(pending.notePath);
    if (saved.title !== pending.title || saved.summary !== pending.summary || saved.detail !== pending.detail || saved.status !== noteStatus) throw new Error("Saved MindSearch note did not match its pending result.");
  }
  private async retireDraftNote(draft: MindSearchResultDraftRecord, reason: string, disposition: "stale" | "incomplete" = "stale"): Promise<void> {
    if (!this.repository.hasNote(draft.notePath)) return;
    const note = await this.repository.readNote(draft.notePath), marker = disposition === "stale" ? "### MindSearch stale-attempt diagnostic" : "### MindSearch incomplete-attempt diagnostic";
    if (note.status === "error" && note.detail.includes(marker)) return;
    const dispositionReason = disposition === "stale" ? "is stale" : "did not complete successfully";
    const detail = [marker, `This draft was not published because attempt ${draft.attemptId} ${dispositionReason}.`, `Stop reason: ${reason}`, "The original draft is retained below for diagnosis; it is not an active research result.", "### Original draft response", `Original summary: ${note.summary}`, note.detail].filter(Boolean).join("\n\n");
    await this.repository.updateNote(draft.notePath, {
      title: note.title.includes("未發布診斷") ? note.title : `${note.title}（未發布診斷）`,
      summary: `未發布診斷：此內容屬於已失效的 MindSearch attempt ${draft.attemptId}，不是有效研究結果。`,
      detail, status: "error"
    });
  }
  private finishCommit(state: MindSearchMapData, pending: MindSearchPendingCommit): void {
    const branch = state.branches.find(item => item.id === pending.branchId)!;
    const run = state.runs.find(item => item.id === pending.runId)!;
    const attempt = run.attempts.find(item => item.id === pending.attemptId)!;
    const draft = (state.resultDrafts ?? []).find(item => item.id === pending.resultDraftId);
    if (!branch.results.some(item => item.resultId === pending.resultId)) branch.results.push({ resultId: pending.resultId, runId: pending.runId, attemptId: pending.attemptId, nodeId: pending.nodeId, notePath: pending.notePath, version: pending.version, ...(draft?.kind ? { kind: draft.kind } : {}), ...(draft?.subtopicId ? { subtopicId: draft.subtopicId } : {}) });
    attempt.status = pending.resultStatus === "partial" ? "partial" : "completed"; state.pendingCommits = state.pendingCommits.filter(item => item.resultId !== pending.resultId);
    state.resultDrafts = (state.resultDrafts ?? []).filter(item => item.id !== pending.resultDraftId);
  }
  private state(map: MapDocument): MindSearchMapData { const state = map.mindSearch ?? { version: 1 as const, branches: [], runs: [], pendingCommits: [] }; state.resultDrafts ??= []; return state; }
  private snapshotHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private liveKey(mapPath: string, runId: string, attemptId: string): string { return `${mapPath}\n${runId}\n${attemptId}`; }
  private async locked<T>(mapPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(mapPath) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }); const tail = previous.then(() => current); this.locks.set(mapPath, tail);
    await previous; try { return await operation(); } finally { release(); if (this.locks.get(mapPath) === tail) this.locks.delete(mapPath); }
  }
}
