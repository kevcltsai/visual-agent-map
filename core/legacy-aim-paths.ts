import { createHash } from "node:crypto";
import type { AimMapData, AimReuseRecord } from "../map-model";

/** Preserve saved AIM references and snapshot identities when a legacy map's notes move. */
export function rebaseLegacyAimNotePaths(aim: AimMapData, move: (path: string) => string): void {
  const moveReuse = (record: AimReuseRecord | undefined): void => {
    if (record) record.sourceNotePath = move(record.sourceNotePath);
  };
  const hashSnapshot = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const branch of aim.branches) {
    const snapshotBefore = JSON.stringify(branch.inputSnapshot);
    for (const result of branch.inputSnapshot.upstreamResults) result.notePath = move(result.notePath);
    for (const item of branch.researchPlan ?? []) if (item.source) item.source.notePath = move(item.source.notePath);
    for (const result of branch.results) {
      result.notePath = move(result.notePath);
      moveReuse(result.reuse);
    }
    if (JSON.stringify(branch.inputSnapshot) === snapshotBefore) continue;
    const hash = hashSnapshot({ branch: branch.inputSnapshot, answer: branch.answerSnapshot });
    for (const run of aim.runs) {
      if (run.branchId !== branch.id) continue;
      for (const attempt of run.attempts) {
        attempt.inputSnapshotHash = hash;
        for (const draft of aim.resultDrafts ?? [])
          if (draft.runId === run.id && draft.attemptId === attempt.id) draft.inputSnapshotHash = hash;
      }
    }
  }
  for (const run of aim.runs)
    for (const attempt of run.attempts)
      if (attempt.retainedReports) attempt.retainedReports.notePath = move(attempt.retainedReports.notePath);
  for (const draft of aim.resultDrafts ?? []) {
    draft.notePath = move(draft.notePath);
    moveReuse(draft.reuse);
  }
  if (aim.rootDraft) aim.rootDraft.notePath = move(aim.rootDraft.notePath);
  if (aim.questionDraft) aim.questionDraft.notePath = move(aim.questionDraft.notePath);
  for (const pending of aim.pendingCommits) pending.notePath = move(pending.notePath);
}
