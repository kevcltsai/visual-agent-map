/**
 * Ledger of changes that touched two maps (a cross-map cut), so an undo asked from either map's view runs once.
 * In memory only, FIFO with a fixed size, one ledger per plugin instance. It holds the undo and redo functions of the
 * change, never a view. Imports nothing from obsidian or from a view.
 */
export const CROSS_MAP_HISTORY_LIMIT = 20;

export type LedgerStatus = "applied" | "undone" | "broken";
export interface LedgerHandlers {
  undo(): Promise<void> | void;
  redo(): Promise<void> | void;
}
export interface LedgerPush {
  id: string;
  /** The map paths the change touched. */
  paths: readonly string[];
  entry: LedgerHandlers;
}
export interface LedgerView {
  id: string;
  paths: readonly string[];
  status: LedgerStatus;
}
export type LedgerRunResult =
  | { ran: true; status: LedgerStatus }
  | {
      ran: false;
      reason: "unknown" | "broken" | "wrong-state" | "busy" | "failed";
      status?: LedgerStatus;
      error?: unknown;
    };

interface Slot {
  id: string;
  paths: readonly string[];
  entry: LedgerHandlers;
  status: LedgerStatus;
  running: boolean;
}

export class CrossMapLedger {
  private readonly slots: Slot[] = [];

  /** Adds an applied change; the oldest is dropped past the limit. Returns false (and adds nothing) for a repeated id. */
  push(input: LedgerPush): boolean {
    if (this.slots.some(slot => slot.id === input.id)) return false;
    this.slots.push({
      id: input.id,
      paths: Object.freeze([...new Set(input.paths)]),
      entry: input.entry,
      status: "applied",
      running: false
    });
    while (this.slots.length > CROSS_MAP_HISTORY_LIMIT) this.slots.shift();
    return true;
  }

  /** Changes that touched `path`, oldest first, whatever their status. */
  entriesFor(path: string): LedgerView[] {
    return this.slots
      .filter(slot => slot.paths.includes(path))
      .map(slot => ({ id: slot.id, paths: slot.paths, status: slot.status }));
  }

  statusOf(id: string): LedgerStatus | undefined {
    return this.slots.find(slot => slot.id === id)?.status;
  }

  /** Forgets a change (for instance when a view finds its proxy no longer applies). */
  forget(id: string): void {
    const index = this.slots.findIndex(slot => slot.id === id);
    if (index >= 0) this.slots.splice(index, 1);
  }

  /**
   * Undo needs `applied` and redo needs `undone`; any other state does nothing. A second call for the same change
   * while the first is still running does nothing. A `broken` change is refused. A throw whose `kind` is
   * `rollback-failed` marks the change broken; any other throw leaves the state as it was.
   */
  async run(id: string, direction: "undo" | "redo"): Promise<LedgerRunResult> {
    const slot = this.slots.find(candidate => candidate.id === id);
    if (!slot) return { ran: false, reason: "unknown" };
    if (slot.status === "broken") return { ran: false, reason: "broken", status: slot.status };
    if (slot.running) return { ran: false, reason: "busy", status: slot.status };
    if (slot.status !== (direction === "undo" ? "applied" : "undone"))
      return { ran: false, reason: "wrong-state", status: slot.status };
    slot.running = true;
    try {
      await (direction === "undo" ? slot.entry.undo() : slot.entry.redo());
      slot.status = direction === "undo" ? "undone" : "applied";
      return { ran: true, status: slot.status };
    } catch (error) {
      if ((error as { kind?: unknown } | null | undefined)?.kind === "rollback-failed") slot.status = "broken";
      return { ran: false, reason: slot.status === "broken" ? "broken" : "failed", status: slot.status, error };
    } finally {
      slot.running = false;
    }
  }
}

const ledgers = new WeakMap<object, CrossMapLedger>();

/** The ledger of one plugin instance, created on first use; released together with the plugin. */
export function ledgerFor(plugin: object): CrossMapLedger {
  if (typeof plugin !== "object" || plugin === null) throw new TypeError("ledgerFor needs the plugin object");
  let ledger = ledgers.get(plugin);
  if (!ledger) {
    ledger = new CrossMapLedger();
    ledgers.set(plugin, ledger);
  }
  return ledger;
}

/** What stops a cross-map cut at the source map; `gone` drops the cut mark, the others keep it so the paste can be retried. */
export type CutSourceProblem = "gone" | "changed" | "aim";
interface CutSourceNode {
  id: string;
  parentId: string | null;
  aimKind?: unknown;
  aimQuestion?: unknown;
}
/**
 * Decides, from the source map as it is stored now, whether the recorded branches may still be cut out of it. `found`
 * is `resolveCrossSource` run on that same map (null: a topic, its note path or the tree shape no longer matches). A
 * map with AIM data, an AIM topic in the branch, or a new topic under the branch (it would be cut off from its parent)
 * is refused. Pure; the caller runs it again on the freshest copy it can read right before it writes.
 */
export function cutSourceProblem(
  sourceMap: { id: string; aim?: unknown; nodes: readonly CutSourceNode[] },
  record: { sourceMapId: string; nodeIds: readonly string[] },
  found: { branch: readonly CutSourceNode[] } | null
): CutSourceProblem | null {
  const present = new Set(sourceMap.nodes.map(node => node.id));
  if (sourceMap.id !== record.sourceMapId || record.nodeIds.every(id => !present.has(id))) return "gone";
  if (sourceMap.aim) return "aim";
  if (!found) return "changed";
  const ids = new Set(record.nodeIds);
  if (sourceMap.nodes.some(node => node.parentId !== null && ids.has(node.parentId) && !ids.has(node.id)))
    return "changed";
  if (found.branch.some(node => node.aimKind !== undefined || node.aimQuestion !== undefined)) return "aim";
  return null;
}

const noteParts = (text: string): { lines: string[]; body: string } | null => {
  const found = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!found) return null;
  return { lines: found[1].split("\n").filter(line => !line.startsWith("updated:")), body: found[2] };
};
/**
 * True when two texts of one note differ only in the `updated:` stamp and in the order of the front matter lines: what
 * putting a parked note back leaves behind. Any other difference (a changed value or body) is false.
 */
export function sameApartFromStamps(a: string, b: string): boolean {
  const first = noteParts(a),
    second = noteParts(b);
  if (!first || !second || first.body !== second.body || first.lines.length !== second.lines.length) return false;
  const sorted = (lines: string[]): string => [...lines].sort().join("\n");
  return sorted(first.lines) === sorted(second.lines);
}
