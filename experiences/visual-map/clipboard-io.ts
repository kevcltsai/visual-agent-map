/**
 * The DOM side of copy and paste on the map: which clipboard events belong to a view, and reading and writing the
 * `DataTransfer` of such an event. No obsidian import, so it can run against a plain object. The payload itself is
 * parsed by `clipboard.ts`; nothing read here is trusted.
 */
export const CLIPBOARD_MIME = "application/x-vam-branch";

/** The part of `DataTransfer` that is used. */
export interface ClipboardDataLike {
  getData(type: string): string;
  setData(type: string, value: string): void;
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false]), .vam-map-chat";

/**
 * True only when `target` is an element inside `root` (the view's content element) that is not a text control or the
 * chat panel. A target outside `root`, such as `body` when no card holds focus, is never ours: another pane or the
 * editor owns the key, so the view must not intercept it.
 */
export function inClipboardScope(target: unknown, root: { contains(node: unknown): boolean }): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== "function") return false;
  if (!root.contains(element)) return false;
  return !element.closest(EDITABLE);
}

/** Writes the private format and the plain-text outline; no text/html is written. */
export function writeClipboardData(data: ClipboardDataLike, serialized: string, outline: string): void {
  data.setData(CLIPBOARD_MIME, serialized);
  data.setData("text/plain", outline);
}

/** The private-format string and the plain text of a paste event; an empty string when a type is absent or unreadable. */
export function readClipboardData(data: ClipboardDataLike | null | undefined): { vam: string; text: string } {
  const read = (type: string): string => {
    try {
      const value = data?.getData(type);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  return { vam: read(CLIPBOARD_MIME), text: read("text/plain") };
}
