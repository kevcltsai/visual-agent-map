import type { MapDocument } from "../../map-model";
import type { MindSearchAttemptRecord } from "../../map-model";
import type { Note } from "../../repository";
import type { AiResult } from "../../ai/types";

export interface MindSearchRetryTarget { runId: string; diagnosticNotePath: string }

const diagnosticHeading = "### MindSearch incomplete-attempt diagnostic";
const originalHeading = "### Original draft response";
const detailEnd = "<!-- visual-agent-map:detail:end -->";

/** Extract only a retained report that belongs to this failed attempt and has completed-search telemetry. */
export function extractMindSearchFailedReport(note: Note, attempt: MindSearchAttemptRecord): AiResult[] | null {
  if (note.status !== "error" || !note.detail.trim()) return null;

  const reportMarker = "**Source boundary:** ";
  const reportStart = note.detail.indexOf(reportMarker);
  if (note.detail.includes("**Status:** Diagnostic only.") && reportStart >= 0 &&
      note.detail.includes(` ${attempt.id}; the persisted attempt remains failed.`)) {
    const reportDetail = note.detail.slice(reportStart + reportMarker.length).trim();
    return note.summary.trim() && /^Research status:\s*search completed\b/i.test(reportDetail)
      ? [{ summary: note.summary, detail: reportDetail, suggestions: [], visualReferences: [] }]
      : null;
  }

  // RunStore's native failed-draft format predates the normalized wrapper. Search completion is
  // proven by persisted Codex action telemetry, not inferred from report wording or URL fields.
  const exactAttempt = `This draft was not published because attempt ${attempt.id} did not complete successfully.`;
  const start = note.detail.indexOf(diagnosticHeading), originalStart = note.detail.indexOf(originalHeading);
  if (start < 0 || originalStart <= start || !note.detail.slice(start, originalStart).includes(exactAttempt)) return null;
  if (!(attempt.searchDiagnostics ?? []).some(item => item.completedSearchActions > 0)) return null;
  const body = note.detail.slice(originalStart + originalHeading.length).split(detailEnd, 1)[0].trim();
  const summaryStart = body.indexOf("Original summary:");
  const firstReport = body.indexOf("## Searcher report 1");
  if (summaryStart < 0 || firstReport < 0 || firstReport <= summaryStart) return null;
  const summaries = [...body.slice(summaryStart, firstReport).matchAll(/^Original summary:\s*(.*)$/gm)]
    .flatMap(match => [...match[1].matchAll(/(?:^|\n)Report (\d+):\s*(.+)/g)].map(item => ({ index: Number(item[1]), summary: item[2].trim() })));
  const reports: AiResult[] = [];
  const headings = [...body.matchAll(/^## Searcher report (\d+)\s*$/gm)];
  if (!headings.length || headings.length !== summaries.length) return null;
  for (let index = 0; index < headings.length; index++) {
    const number = Number(headings[index][1]), next = headings[index + 1]?.index ?? body.length;
    const section = body.slice(headings[index].index + headings[index][0].length, next).trim();
    if (number !== index + 1 || summaries[index]?.index !== number || !summaries[index]?.summary || !section) return null;
    reports.push({ summary: summaries[index].summary, detail: section, suggestions: [], visualReferences: [] });
  }
  return reports;
}

/** Match one map-local completed-search diagnostic to a currently failed attempt/question. */
export function matchMindSearchFailedReportTargets(map: MapDocument, candidates: { path: string; note: Note }[]): Map<string, MindSearchRetryTarget> {
  const currentFailed = map.mindSearch?.runs.flatMap(run => {
    const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
    return attempt?.status === "failed" ? [{ runId: run.id, attempt }] : [];
  }) ?? [];
  const failed = map.mindSearch?.runs.flatMap(run => {
    const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
    const branch = map.mindSearch?.branches.find(item => item.id === run.branchId);
    const question = branch && map.nodes.find(item => item.id === branch.questionNodeId);
    return attempt?.status === "failed" && branch && question?.mindSearchKind === "question"
      ? [{ runId: run.id, attempt, branchId: branch.id, questionNodeId: question.id }]
      : [];
  }) ?? [];
  const matches = new Map<string, MindSearchRetryTarget[]>();
  for (const { path, note } of candidates) {
    const isWrapped = note.detail.includes("**Status:** Diagnostic only.");
    let selected: typeof failed = [];
    if (isWrapped) {
      selected = failed.filter(item => note.detail.includes(`**Prior attempt:** ${item.branchId} / ${item.attempt.id}; the persisted attempt remains failed.`) && extractMindSearchFailedReport(note, item.attempt) !== null);
    } else {
      const nativeAttemptId = note.detail.match(/This draft was not published because attempt ([^\s]+) did not complete successfully\./)?.[1];
      const sameOrdinalFailures = currentFailed.filter(item => item.attempt.id === nativeAttemptId);
      if (nativeAttemptId && sameOrdinalFailures.length === 1) {
        selected = failed.filter(item => item.runId === sameOrdinalFailures[0].runId && extractMindSearchFailedReport(note, item.attempt) !== null);
      }
    }
    for (const item of selected) {
      if (isWrapped && !note.detail.includes("**Source boundary:** ")) continue;
      const list = matches.get(item.questionNodeId) ?? [];
      list.push({ runId: item.runId, diagnosticNotePath: path }); matches.set(item.questionNodeId, list);
    }
  }
  const targets = new Map<string, MindSearchRetryTarget>();
  for (const [questionNodeId, items] of matches) if (items.length === 1) targets.set(questionNodeId, items[0]);
  return targets;
}
