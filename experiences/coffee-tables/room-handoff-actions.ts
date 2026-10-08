import { baselineFromVersions } from "./insights";
import type { CoffeeSession } from "./types";

/** Only explicit, still-current convergence acceptance can select this target. */
export function acceptedConvergenceInsightIds(session: CoffeeSession): string[] | undefined {
  const undo = session.convergenceUndo, ids = undo?.acceptedInsightIds;
  if (!undo || !ids?.length || session.dirtyNotes || session.status !== "completed"
    || JSON.stringify(session.observerNotes ?? []) !== JSON.stringify(undo.expectedNotes)
    || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    || new Set(ids).size !== ids.length) return undefined;
  const reachable = new Set(baselineFromVersions(session.observerNotes ?? [], session.language).map(item => item.id));
  return ids.every(id => reachable.has(id)) ? [...ids] : undefined;
}

/** Product room actions; native view and browser component tests share this renderer. */
export function renderCoffeeRoomHandoffActions(parent: HTMLElement, current: () => CoffeeSession, open: (ids?: string[]) => unknown, unavailable: () => boolean = () => false, onError: (error: unknown) => void = () => undefined): void {
  const invoke = (acceptedOnly: boolean) => {
    void Promise.resolve().then(() => {
      if (unavailable()) return;
      const ids = acceptedOnly ? acceptedConvergenceInsightIds(current()) : undefined;
      if (acceptedOnly && !ids) return;
      return open(ids);
    }).catch(onError);
  };
  const zh = current().language === "zh-TW";
  const accepted = parent.createEl("button", { text: zh ? "將已接受的收斂洞見帶去 VAM" : "Take accepted convergence insights to VAM" });
  accepted.addClass("mod-cta");
  accepted.disabled = unavailable() || !acceptedConvergenceInsightIds(current());
  accepted.addEventListener("click", () => {
    invoke(true);
  });
  parent.createEl("p", { text: zh ? "只交付上次收斂明確接受且尚未變動的洞見；舊資料或已還原的資料沒有可驗證的接受集合。" : "Includes only explicitly accepted insights from the last unchanged convergence. Older or undone data has no verifiable accepted set.", cls: "ct-muted" });
  const whole = parent.createEl("button", { text: zh ? "將整桌快照帶去 VAM（包含未接受洞見）" : "Take whole-table snapshot to VAM (includes unaccepted insights)" });
  whole.disabled = unavailable();
  whole.addEventListener("click", () => { invoke(false); });
}
