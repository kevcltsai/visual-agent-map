/**
 * Progress of a whole multi-step instruction ("整段流程"): the model names the steps in its first reply and later only moves their
 * status. Pure data, no Obsidian. The names are plain text from the model: shown as text, never an action or a link.
 */
export type MapChatStepStatus = "done" | "current" | "todo";
export interface MapChatProgressStep {
  name: string;
  status: MapChatStepStatus;
}
export interface MapChatProgress {
  steps: MapChatProgressStep[];
  /** 0-based index of the step being worked on (the last one when all are done). */
  current: number;
}

export const MAP_CHAT_PROGRESS_MAX_STEPS = 30;
export const MAP_CHAT_PROGRESS_NAME_LIMIT = 60;

const RANK: Record<MapChatStepStatus, number> = { todo: 0, current: 1, done: 2 };
const isStatus = (value: unknown): value is MapChatStepStatus =>
  value === "done" || value === "current" || value === "todo";

const currentOf = (steps: readonly MapChatProgressStep[]): number => {
  const index = steps.findIndex(step => step.status !== "done");
  return index < 0 ? steps.length - 1 : index;
};

/** A reply's `progress` as data; anything missing or malformed is null (no progress), never an error. `current` is worked out from the statuses. */
export function normalizeProgress(value: unknown): MapChatProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as { steps?: unknown }).steps;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAP_CHAT_PROGRESS_MAX_STEPS) return null;
  const steps: MapChatProgressStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { name, status } = item as { name?: unknown; status?: unknown };
    if (typeof name !== "string" || !isStatus(status)) return null;
    const text = [...name.replace(/\s+/g, " ").trim()].slice(0, MAP_CHAT_PROGRESS_NAME_LIMIT).join("").trim();
    if (!text) return null;
    steps.push({ name: text, status });
  }
  return { steps, current: currentOf(steps) };
}

/**
 * The first progress sets the steps; after that only statuses move forward (todo, current, done). A different count or other names
 * ignore the whole new one; an absent one keeps the old. Returns the old object itself when nothing is taken.
 */
export function mergeProgress(
  old: MapChatProgress | null | undefined,
  next: MapChatProgress | null | undefined
): MapChatProgress | null {
  if (!next) return old ?? null;
  if (!old) return next;
  if (old.steps.length !== next.steps.length || old.steps.some((step, i) => step.name !== next.steps[i].name))
    return old;
  const steps = old.steps.map((step, i) => ({
    name: step.name,
    status: RANK[next.steps[i].status] > RANK[step.status] ? next.steps[i].status : step.status
  }));
  return { steps, current: currentOf(steps) };
}
