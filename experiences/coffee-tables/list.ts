import type { CoffeeSession } from "./types";

export interface TableListItem {
  id: string; path: string; topic: string; status: CoffeeSession["status"];
  createdAt: string; updatedAt: string; lastGenerationStartedAt?: string; lastCompletedAt?: string; model: string;
  legacyTime?: boolean; unreadable?: boolean;
}
export type TableListFilter = "all" | "generating" | "unfinished" | "completed";
export type TableListEmptyState = "no-matches" | "no-status-matches" | "no-archived" | "empty";

export function tableListEmptyState(query: string, focusedTopic: string | null | undefined, filter: TableListFilter, archived: boolean, sourceCount: number): TableListEmptyState {
  if (query.trim() || focusedTopic?.trim()) return "no-matches";
  if (archived && sourceCount === 0) return "no-archived";
  if (filter !== "all") return "no-status-matches";
  if (archived) return "no-archived";
  return "empty";
}

const activityTime = (item: TableListItem): number => Date.parse(item.lastGenerationStartedAt || item.updatedAt || item.createdAt) || 0;
const startTime = (item: TableListItem): number => Date.parse(item.lastGenerationStartedAt || item.updatedAt || item.createdAt) || 0;
const completeTime = (item: TableListItem): number => Date.parse(item.lastCompletedAt || item.updatedAt || item.createdAt) || 0;
function itemTime(item: TableListItem): number { return item.status === "completed" ? completeTime(item) : activityTime(item); }

export function effectiveTableStatus(session: Pick<CoffeeSession, "status" | "questions" | "rounds" | "interventions">, busy = false): CoffeeSession["status"] {
  if (busy) return "generating";
  if (session.status === "generating" || session.questions.some(question => question.status !== "complete") || (session.rounds ?? []).some(round => round.status !== "completed") || (session.interventions ?? []).some(item => item.status === "pending" || item.status === "failed")) return "error";
  return session.status;
}

export function selectTables(items: TableListItem[], query = "", filter: TableListFilter = "all", focusedTopic?: string | null): TableListItem[] {
  const needle = query.trim().toLocaleLowerCase(), topic = focusedTopic?.trim();
  return items.filter(item => {
    if (needle && !item.topic.toLocaleLowerCase().includes(needle)) return false;
    if (topic && item.topic.trim() !== topic) return false;
    if (filter === "generating") return item.status === "generating";
    if (filter === "unfinished") return item.status !== "generating" && item.status !== "completed";
    if (filter === "completed") return item.status === "completed";
    return true;
  }).sort((a, b) => itemTime(b) - itemTime(a) || a.id.localeCompare(b.id));
}

export function topicTableCount(topic: string, items: TableListItem[]): number {
  const exactTopic = topic.trim();
  return items.filter(item => item.topic.trim() === exactTopic).length;
}

export function tableTime(item: TableListItem): { value: number; isFallback: boolean } {
  if (item.status === "completed") return { value: completeTime(item), isFallback: !item.lastCompletedAt };
  if (item.lastGenerationStartedAt) return { value: startTime(item), isFallback: false };
  return { value: activityTime(item), isFallback: true };
}

export function formatTableTime(timestamp: number, now = Date.now(), language = "en"): string {
  const date = new Date(timestamp), today = new Date(now);
  if (!Number.isFinite(date.getTime())) return "";
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const isYesterday = date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate();
  const zh = language.toLowerCase().startsWith("zh");
  if (sameDay || isYesterday) {
    const day = sameDay ? (zh ? "今天" : "Today") : (zh ? "昨天" : "Yesterday");
    return `${day} ${new Intl.DateTimeFormat(zh ? "zh-TW" : "en", { hour: "2-digit", minute: "2-digit", hour12: !zh }).format(date)}`;
  }
  return new Intl.DateTimeFormat(zh ? "zh-TW" : "en", { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }).format(date);
}
