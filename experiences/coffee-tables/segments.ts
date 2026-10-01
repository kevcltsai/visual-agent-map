import type { CoffeeSession } from "./types";
export interface CoffeeSegment { id: string; kind: "initial" | "continuation" | "question" | "legacy"; summary?: string; status: "generating" | "completed" | "error"; text: string; createdAt: string }
export interface CoffeeNavigationSnapshot { sessionId: string; topic: string; readOnly?: boolean; segments: CoffeeSegment[] }
export function coffeeSegments(session: CoffeeSession): CoffeeSegment[] {
  const rounds = session.rounds ?? [];
  const result: CoffeeSegment[] = rounds.map((round, index) => ({ id: `round:${round.id}`, kind: round.kind ?? (index === 0 ? (round.id === "round-1" ? "legacy" : "initial") : "continuation"), summary: round.summary, status: round.status, text: [round.markdown || round.draftMarkdown || "", ...(session.interventions ?? []).filter(item => item.roundId === round.id).map(item => `User intervention after turn ${item.afterTurn ?? 0} (${item.status ?? "sent"}): ${item.text}`)].filter(Boolean).join("\n\n"), createdAt: round.createdAt }));
  if (!rounds.length && session.transcriptMarkdown) result.push({ id: "legacy", kind: "legacy", status: "completed", text: session.transcriptMarkdown, createdAt: session.createdAt });
  for (const question of session.questions) result.push({ id: `question:${question.id}`, kind: "question", summary: question.summary, status: question.status === "complete" ? "completed" : question.status === "pending" ? "generating" : "error", text: `${question.question}\n\n${question.answer || question.draftAnswer || ""}`, createdAt: question.createdAt ?? session.createdAt });
  return result.sort((a,b) => a.createdAt.localeCompare(b.createdAt));
}
const SUMMARY_MARKER = /^<!-- coffee-segment-summary:\s*(.*?)\s*-->\s*$/gm;
function summaryText(value: unknown): string | undefined { return typeof value === "string" && value.trim() && !/[\r\n]/.test(value.trim()) ? value.trim() : undefined; }
export function extractSegmentSummary(markdown: string): { markdown: string; summary?: string } {
  let summary: string | undefined;
  const clean = markdown.replace(SUMMARY_MARKER, (_marker, payload: string) => { try { const value = JSON.parse(payload) as { summary?: unknown }; summary = summaryText(value.summary) ?? summary; } catch { /* A missing summary must not fail dialogue. */ } return ""; });
  return { markdown: clean.trim(), ...(summary ? { summary } : {}) };
}
export function segmentSummaryInstruction(language: string): string {
  return language === "zh-TW" ? '\n段落導覽摘要（與聊天室風格及洞見分開）：在完整對談與洞見之後、完成標記之前，輸出一行 <!-- coffee-segment-summary: {"summary":"一句話說明本次對談聊到什麼及出現的轉折"} -->。只概括本次新增對談，不以首句節錄代替，不刪減洞見；摘要使用聊天室語言。' : '\nNavigation summary (separate from conversation style and insights): after the full dialogue and notes, before the completion marker, output one line <!-- coffee-segment-summary: {"summary":"One sentence describing what this segment explored and its turn in thinking."} -->. Summarize only this segment, not an excerpt of its first sentence; do not reduce the insights. Use the conversation language.';
}
export function parseSummaryBatch(response: string, allowed: string[]): Array<{ id: string; summary: string }> {
  const raw = response.trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "");
  const data = JSON.parse(raw) as { summaries?: unknown };
  if (!Array.isArray(data.summaries)) throw new Error("Invalid segment summaries");
  const seen = new Set<string>(), result: Array<{ id: string; summary: string }> = [];
  for (const entry of data.summaries as Array<{ id?: unknown; summary?: unknown }>) {
    if (typeof entry.id !== "string" || !allowed.includes(entry.id)) continue;
    if (seen.has(entry.id)) throw new Error("Duplicate segment summary ID"); seen.add(entry.id);
    const summary = summaryText(entry.summary); if (summary) result.push({ id: entry.id, summary });
  }
  return result;
}
