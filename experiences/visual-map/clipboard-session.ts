/**
 * What the plugin remembers about its own last copy or cut (decision #17): the clipboard text is untrusted, so the
 * source map and files are never read from it. A paste may use the source only when the clipboard text is byte for
 * byte the string recorded here. In memory only; one session per plugin instance. Imports nothing from obsidian or
 * from a view, so it cannot keep a view alive.
 */
export type ClipMode = "copy" | "cut";

export interface ClipRecord {
  clipId: string;
  /** The private-format string that was written to the clipboard. */
  serialized: string;
  mode: ClipMode;
  sourceMapPath: string;
  sourceMapId: string;
  /** Map node ids of the selected branches' roots and everything under them, in clipboard order. */
  nodeIds: readonly string[];
  /** Note paths of the same nodes, in the same order. */
  notePaths: readonly string[];
}

export class ClipboardSession {
  private current: ClipRecord | null = null;

  /** Replaces any earlier record. The arrays are copied, so later changes by the caller cannot alter it. */
  record(input: ClipRecord): ClipRecord {
    this.current = Object.freeze({
      clipId: input.clipId,
      serialized: input.serialized,
      mode: input.mode,
      sourceMapPath: input.sourceMapPath,
      sourceMapId: input.sourceMapId,
      nodeIds: Object.freeze([...input.nodeIds]),
      notePaths: Object.freeze([...input.notePaths])
    });
    return this.current;
  }

  /** The record, or null when there is none. */
  get(): ClipRecord | null {
    return this.current;
  }

  /** True only when `raw` is exactly the recorded string: one changed, added or missing character is a mismatch. */
  matches(raw: unknown): boolean {
    return this.current !== null && typeof raw === "string" && raw === this.current.serialized;
  }

  /** The record when `raw` matches it, else null. */
  match(raw: unknown): ClipRecord | null {
    return this.matches(raw) ? this.current : null;
  }

  /** Drops a pending cut (the source cards lose their mark); a copy record is left alone. Returns whether one was dropped. */
  cancelCut(): boolean {
    if (this.current?.mode !== "cut") return false;
    this.current = null;
    return true;
  }

  clear(): void {
    this.current = null;
  }
}

const sessions = new WeakMap<object, ClipboardSession>();

/** The session of one plugin instance, created on first use; released together with the plugin. */
export function sessionFor(plugin: object): ClipboardSession {
  if (typeof plugin !== "object" || plugin === null) throw new TypeError("sessionFor needs the plugin object");
  let session = sessions.get(plugin);
  if (!session) {
    session = new ClipboardSession();
    sessions.set(plugin, session);
  }
  return session;
}
