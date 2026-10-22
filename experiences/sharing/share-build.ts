import {
  classifySize,
  SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES,
  SHARE_SIZE_WARN_BYTES,
  type SizeClass
} from "./share-format";
import { SHARE_ASSET_SCHEME } from "./share-clean";

/**
 * Pure helpers for the share dialog's build lifecycle. No obsidian import.
 *
 * Critical Path of an export: the dialog owns one controller. Opening it or changing a switch starts a new build
 * (`begin`), which aborts the previous one; every step of a build checks its ticket and drops a stale result.
 * Closing the dialog calls `cancel`, so nothing that finishes late can reach the file system.
 */
export interface BuildTicket {
  readonly generation: number;
  readonly signal: AbortSignal;
  /** True while this is the newest build and the dialog has not been cancelled. */
  isCurrent(): boolean;
}

export class BuildController {
  private generationCount = 0;
  private active: AbortController | null = null;
  begin(): BuildTicket {
    this.active?.abort();
    const abort = new AbortController();
    this.active = abort;
    const generation = ++this.generationCount;
    return {
      generation,
      signal: abort.signal,
      isCurrent: () => generation === this.generationCount && !abort.signal.aborted
    };
  }
  /** Aborts the running build and makes every outstanding ticket stale. */
  cancel(): void {
    this.active?.abort();
    this.active = null;
    this.generationCount++;
  }
  get generation(): number {
    return this.generationCount;
  }
}

/** Raised inside a build when its ticket went stale; callers catch it and drop the result. */
export class StaleBuildError extends Error {
  constructor() {
    super("The share build was superseded or cancelled.");
    this.name = "StaleBuildError";
  }
}
export function assertCurrent(ticket: BuildTicket): void {
  if (!ticket.isCurrent()) throw new StaleBuildError();
}
export const isStaleBuild = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "StaleBuildError";

/** Resolves after `ms`, or throws StaleBuildError as soon as the ticket goes stale. */
export function pause(ticket: BuildTicket, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ticket.isCurrent()) return reject(new StaleBuildError());
    const timer = window.setTimeout(() => {
      ticket.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new StaleBuildError());
    };
    ticket.signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SizeAdvice {
  level: SizeClass;
  /** Suggest leaving images out: only when the file is large and images are in it. */
  suggestNoImages: boolean;
}
export function sizeAdvice(
  bytes: number,
  includeImages: boolean,
  thresholds: { warn: number; large: number } = {
    warn: SHARE_SIZE_WARN_BYTES,
    large: SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES
  }
): SizeAdvice {
  const level = classifySize(bytes, thresholds);
  return { level, suggestNoImages: level === "large" && includeImages };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Replaces the Markdown image references `![alt](vam-asset:<name>)` whose name is in `names` with `label`. */
export function replaceAssetRefs(markdown: string, names: ReadonlySet<string>, label: string): string {
  if (!names.size) return markdown;
  return markdown.replace(/!\[[^\]\n]*\]\(vam-asset:([^)\n]*)\)/g, (all, name: string) =>
    names.has(name.trim()) ? label : all
  );
}

/** Names of the vault images a cleaned Markdown text refers to. */
export function assetNamesIn(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(new RegExp(`\\]\\(${SHARE_ASSET_SCHEME}([^)\\n]*)\\)`, "g")))
    names.push(match[1].trim());
  return names;
}

/** Wikilinks in a plain-text field (a summary) become their alias or target text. */
export function plainWikilinks(text: string): string {
  return text.replace(/\[\[([^\]\n]+)\]\]/g, (_all, inner: string) => {
    const bar = inner.search(/\\?\|/);
    if (bar >= 0)
      return (
        inner
          .slice(bar)
          .replace(/^\\?\|/, "")
          .trim() || inner.slice(0, bar).trim()
      );
    const target = inner.split("#")[0].trim() || inner.replace(/^#\^?/, "").trim();
    return (target.split("/").pop() ?? target).replace(/\.md$/i, "");
  });
}

/** A file name for the share: the map title without characters file systems reject, ending in .html. */
export function shareFileName(title: string): string {
  const base = title
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || "map"}.html`;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Replaces `<img … src="vam-asset:<name>" …>` in exported note HTML with a text marker. `names` limits which images
 * (null means all). The marker uses the class the viewer uses for a missing image.
 */
export function omitAssetImages(html: string, names: ReadonlySet<string> | null, label: string): string {
  if (names && !names.size) return html;
  return html.replace(/<img\b[^>]*?\ssrc="vam-asset:([^"]*)"[^>]*>/g, (all, name: string) =>
    !names || names.has(name) ? `<span class="vam-image-omitted">${escapeHtml(label)}</span>` : all
  );
}

/** Joins a note's folder and a relative reference (`../Attachments/a.png`), collapsing `.` and `..`; null when it climbs above the vault root. */
export function resolveRelative(folder: string, ref: string): string | null {
  const parts: string[] = [];
  for (const part of `${folder}/${ref}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Note and image problem counts only matter for what the chosen mode puts in the file: no notes means no note content or unreadable images. */
export function scopeCountsToMode(
  options: { includeDetail: boolean; includeImages: boolean },
  raw: { notesWithContent: number; failedImages: number }
): { notesWithContent: number; failedImages: number } {
  return {
    notesWithContent: options.includeDetail ? raw.notesWithContent : 0,
    failedImages: options.includeDetail && options.includeImages ? raw.failedImages : 0
  };
}
