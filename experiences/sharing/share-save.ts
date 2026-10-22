/**
 * Writes the finished share file to a place the user picks, outside the vault. First choice is the system save
 * dialog (`showSaveFilePicker`, present in Obsidian's Electron; it needs a user gesture, so call this straight from a
 * click handler). If the picker is missing or refuses, a Blob download via an anchor is the fallback. No obsidian import.
 */
export interface SaveEnvironment {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
  /** Starts a browser download of `url` under `name`. */
  triggerDownload(url: string, name: string): void;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  setTimeout(handler: () => void, ms: number): unknown;
}
export type SaveOutcome = "saved" | "downloaded" | "cancelled";

const isAbort = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "AbortError";

export function browserSaveEnvironment(): SaveEnvironment {
  const picker = (window as unknown as { showSaveFilePicker?: SaveEnvironment["showSaveFilePicker"] })
    .showSaveFilePicker;
  return {
    showSaveFilePicker: picker
      ? options => picker.call(window, options) as ReturnType<NonNullable<SaveEnvironment["showSaveFilePicker"]>>
      : undefined,
    triggerDownload: (url, name) => {
      const anchor = createEl("a", { attr: { href: url, download: name } });
      activeDocument.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url),
    setTimeout: (handler, ms) => window.setTimeout(handler, ms)
  };
}

/** `shouldWrite` is asked right before any byte is written (after the dialog); false means the dialog was closed meanwhile. */
export async function saveShareFile(
  html: string,
  suggestedName: string,
  shouldWrite: () => boolean,
  env: SaveEnvironment = browserSaveEnvironment()
): Promise<SaveOutcome> {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  if (env.showSaveFilePicker) {
    try {
      const handle = await env.showSaveFilePicker({
        suggestedName,
        types: [{ description: "HTML", accept: { "text/html": [".html"] } }]
      });
      if (!shouldWrite()) return "cancelled";
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "saved";
    } catch (error) {
      if (isAbort(error)) return "cancelled";
      // Any other refusal (no user gesture, no permission, unsupported): fall back to a download.
    }
  }
  if (!shouldWrite()) return "cancelled";
  const url = env.createObjectURL(blob);
  env.triggerDownload(url, suggestedName);
  env.setTimeout(() => env.revokeObjectURL(url), 30_000);
  return "downloaded";
}
