import {
  classifySize,
  SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES,
  SHARE_SIZE_WARN_BYTES,
  type ShareMapTranslation,
  type ShareNodeTranslation,
  type SharePayload,
  type SizeClass
} from "./share-format";
import { SHARE_ASSET_SCHEME } from "./share-clean";
import { scanPayloadForLeaks, type ForbiddenString, type LeakCategory } from "./share-leak-scan";
import { countLocalReferences } from "./share-dom";
import { detailCheckOf, prepareDetail, reconstructTranslatedDetail } from "./share-translate-compact";

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

/** Names of the vault images the rendered note HTML refers to (`src="vam-asset:<name>"`). Images that only a hidden comment used are not among them. */
export function assetNamesInHtml(html: string): string[] {
  return [...html.matchAll(/\ssrc="vam-asset:([^"]*)"/g)].map(match => match[1]);
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

/**
 * Leak categories decided from the rendered notes themselves (not from the payload text): when the file carries note
 * content and any rendered note still contains a link to something that is not web, mail or in-page, the export is
 * blocked (fail closed) with the wikilink category. Structure-only files carry no note HTML, so nothing blocks them.
 */
export function renderedLeakCategories(
  rendered: Iterable<{ localRefs: number }>,
  options: { includeDetail: boolean }
): LeakCategory[] {
  if (!options.includeDetail) return [];
  for (const note of rendered) if (note.localRefs > 0) return ["wikilink"];
  return [];
}

/** One translated language as the translation service returns it. */
export interface ShareTranslationPiece {
  top: ShareMapTranslation;
  nodes: Readonly<Record<string, ShareNodeTranslation>>;
}

/**
 * Leak categories found in one language's translated text. It runs the payload scan itself on a payload that holds
 * only this language, so the translated fields get every rule of the original text and no rule is written twice
 * (D-2026-10-116, DP4). `rebuilt` is what a compact translation shows once the viewer has rebuilt each note
 * (node id to HTML, D-2026-10-122); it is scanned under the `detailHtml` key, the same as the original note text.
 * Categories only, never the matched text.
 */
export function leakCategoriesInTranslation(
  language: string,
  piece: ShareTranslationPiece,
  forbidden: readonly ForbiddenString[],
  rebuilt?: Readonly<Record<string, string>>
): LeakCategory[] {
  const shaped = {
    translations: { [language]: piece.top },
    nodes: Object.entries(piece.nodes).map(([id, translation]) => ({
      id,
      translations: {
        [language]: rebuilt?.[id] !== undefined ? { ...translation, detailHtml: rebuilt[id] } : translation
      }
    }))
  } as unknown as SharePayload;
  return [...new Set(scanPayloadForLeaks(shaped, forbidden).map(hit => hit.category))];
}

/** The DOM pieces the rebuild needs; Obsidian's DOMParser and `innerHTML`, or a stand-in in tests. */
export interface RebuildDom {
  parse(html: string): Element;
  serialize(root: Element): string;
  createDiv(): Element;
}
export interface RebuiltTranslations {
  /** The pieces with every compact note that does not fit its original (check mismatch, no original note) stripped of its compact fields. */
  pieces: AttachTranslationsOptions["pieces"];
  /** Language, then node id: the note HTML a viewer will display. Only notes with a compact translation are listed. */
  rebuilt: Record<string, Record<string, string>>;
  /** Links in the rebuilt notes that lead outside the page; above 0 blocks the file. */
  localRefs: number;
}

/**
 * Rebuilds every compact translated note from the payload's own note HTML with the viewer's function (D-2026-10-122,
 * DP4): the privacy gates scan this result, not what the translation service saw earlier. A compact note whose check
 * no longer fits the note HTML (the image option changed, say) is dropped back to its title and summary.
 */
export function rebuildTranslationsForPayload(
  nodes: ReadonlyArray<{ id: string; detailHtml?: string }>,
  pieces: AttachTranslationsOptions["pieces"],
  dom: RebuildDom
): RebuiltTranslations {
  const original = new Map(nodes.map(node => [node.id, node.detailHtml]));
  const rebuilt: Record<string, Record<string, string>> = {};
  let localRefs = 0;
  const next = pieces.map(({ language, piece }) => {
    const entries: Record<string, ShareNodeTranslation> = {};
    for (const [id, entry] of Object.entries(piece.nodes)) {
      const compact = Array.isArray(entry.detailSegments) || Array.isArray(entry.detailDiagrams);
      const html = original.get(id);
      if (!compact && entry.detailCheck === undefined) {
        entries[id] = entry;
        continue;
      }
      const bare: ShareNodeTranslation = { ...entry };
      delete bare.detailSegments;
      delete bare.detailCheck;
      delete bare.detailDiagrams;
      try {
        const fits =
          !!html?.trim() &&
          (entry.detailSegments === undefined ||
            entry.detailCheck === detailCheckOf(prepareDetail(dom.parse(html), () => dom.createDiv()).extraction));
        if (!html || !fits) {
          entries[id] = bare;
          continue;
        }
        const root = dom.parse(html);
        reconstructTranslatedDetail(root, entry, {
          parse: text => dom.parse(text),
          createSlot: () => dom.createDiv()
        });
        localRefs += countLocalReferences(root);
        (rebuilt[language] ??= {})[id] = dom.serialize(root);
        entries[id] = entry;
      } catch {
        // Fail closed: a note that cannot be rebuilt here shows its original in the viewer too.
        entries[id] = bare;
      }
    }
    return { language, piece: { top: piece.top, nodes: entries } };
  });
  return { pieces: next, rebuilt, localRefs };
}

export interface AttachTranslationsOptions {
  /** Language id of the original text. */
  contentLanguage: string;
  /** Languages to carry, in menu order; each needs a piece. The original is listed first in the file. */
  pieces: ReadonlyArray<{ language: string; piece: ShareTranslationPiece }>;
  /** The language to open in; ignored unless the file carries it. */
  defaultLanguage?: string;
}

/**
 * The payload with its translated languages added (D-2026-10-116). The original fields are never touched; the optional
 * `contentLanguage`, `languages`, `defaultLanguage` and `translations` fields appear only when there is at least one
 * translated language, so a file without translations is byte-identical to the P1 file.
 */
export function attachTranslations(payload: SharePayload, options: AttachTranslationsOptions): SharePayload {
  const pieces = options.pieces.filter(item => item.language !== options.contentLanguage);
  if (!pieces.length) return payload;
  const languages = [options.contentLanguage, ...pieces.map(item => item.language)];
  const translations: Record<string, ShareMapTranslation> = {};
  for (const item of pieces) translations[item.language] = item.piece.top;
  const nodes = payload.nodes.map(node => {
    const byLanguage: Record<string, ShareNodeTranslation> = {};
    for (const item of pieces) {
      const translation = item.piece.nodes[node.id];
      if (translation) byLanguage[item.language] = translation;
    }
    return Object.keys(byLanguage).length ? { ...node, translations: byLanguage } : node;
  });
  return {
    ...payload,
    nodes,
    contentLanguage: options.contentLanguage,
    languages,
    ...(options.defaultLanguage && languages.includes(options.defaultLanguage)
      ? { defaultLanguage: options.defaultLanguage }
      : {}),
    translations
  };
}
