import type { MapDocument } from "../../map-model";
import type { RelevanceTier } from "../../note-values";
import type { ContentLanguage } from "../../i18n";

/** The `vam-share` v1 file format: one self-contained HTML file carrying this payload in `<script id="vam-map">`. */
export const SHARE_FORMAT = "vam-share";
export const SHARE_VERSION = 1;
export type ShareLanguage = "en" | "zh-TW" | "zh-CN";

/**
 * The languages a share can be translated into (D-2026-10-114): the three interface languages plus Japanese, Korean
 * and Spanish from the output-only table. A literal list, not a runtime import of `i18n/languages.ts`, so the viewer
 * bundle never pulls the dictionaries in; the type check and a unit test keep it equal to the registry ids.
 */
export const SHARE_TRANSLATION_LANGUAGES = [
  "zh-TW",
  "zh-CN",
  "en",
  "ja",
  "ko",
  "es"
] as const satisfies readonly ContentLanguage[];
export type ShareTranslationLanguage = (typeof SHARE_TRANSLATION_LANGUAGES)[number];
export const isShareTranslationLanguage = (value: unknown): value is ShareTranslationLanguage =>
  typeof value === "string" && (SHARE_TRANSLATION_LANGUAGES as readonly string[]).includes(value);

/** One note's text in a translated language. `detailHtml` keeps the field name so the leak scan treats it like the original. */
export interface ShareNodeTranslation {
  title: string;
  summary: string;
  reason?: string;
  detailHtml?: string;
}
/** The map-level text in a translated language. */
export interface ShareMapTranslation {
  title: string;
  goal?: string;
}

/** Size thresholds (bytes) for the preview warning and the "leave the images out" suggestion. */
export const SHARE_SIZE_WARN_BYTES = 10 * 1024 * 1024;
export const SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES = 20 * 1024 * 1024;
/** Longest edge (px) of an embedded image. */
export const SHARE_IMAGE_MAX_EDGE = 1600;
/** OQ-1 (owner decision): shares include the full note content unless the exporter turns it off. */
export const SHARE_DEFAULT_INCLUDE_DETAIL = true;

/**
 * P1 carries no Markdown `detail` (D-2026-10-110): the viewer reads `detailHtml` only, and whatever is not rendered
 * (comments, reference definitions) can then never travel. The field was removed from the types rather than left
 * optional-but-unused; P2 can add an optional `detail?: string` back without changing `version`.
 */
export interface ShareNodePayload {
  id: string;
  parentId: string | null;
  x: number;
  y: number;
  collapsed: boolean;
  status: "idea" | "completed";
  title: string;
  summary: string;
  tier?: RelevanceTier;
  reason?: string;
  manual?: true;
  /** Detail rendered to sanitized HTML at export time; images reference `assets` by name. */
  detailHtml?: string;
  /** Optional (D-2026-10-116): this note's text per translated language, keyed by language id. The original stays in the fields above. */
  translations?: Record<string, ShareNodeTranslation>;
}

export interface SharePayload {
  format: typeof SHARE_FORMAT;
  version: typeof SHARE_VERSION;
  title: string;
  goal?: string;
  language: ShareLanguage;
  exportedAt: string;
  source: { vamVersion: string; mapId: string };
  viewport: { x: number; y: number; zoom: number };
  nodes: ShareNodePayload[];
  assets: Record<string, string>;
  /** Optional (D-2026-10-116). Language id of the original text; any registry language, so it may lie outside the six. */
  contentLanguage?: string;
  /** Optional. Every language the file carries, the original first. Absent means the original only. */
  languages?: string[];
  /** Optional. The language to open in; absent means follow the reader's browser, then fall back to the original. */
  defaultLanguage?: string;
  /** Optional. Map-level text per translated language. */
  translations?: Record<string, ShareMapTranslation>;
}

/** What the exporter hands over per note. Only these fields can reach the file. */
export interface ShareNoteInput {
  title: string;
  summary: string;
  status: string;
  relevance?: { tier: RelevanceTier; manual?: true };
  /** Legacy `relevance-reason`, still shown when an older note has one. */
  reason?: string;
  /** Rendered, sanitized HTML (supplied by the Obsidian-side exporter). */
  detailHtml?: string;
}

export interface ShareOptions {
  includeDetail: boolean;
  includeImages: boolean;
  language: ShareLanguage;
  vamVersion: string;
  exportedAt: string;
  goal?: string;
  /** name -> data URL, embedded only when includeImages is true. */
  assets?: Record<string, string>;
}

export class ShareError extends Error {
  constructor(
    readonly code: "aim-map" | "unsupported-version",
    message: string
  ) {
    super(message);
    this.name = "ShareError";
  }
}

const optionalText = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Builds the share payload. Throws ShareError for AIM maps, which cannot be shared. */
export function buildSharePayload(
  map: MapDocument,
  notesById: Readonly<Record<string, ShareNoteInput | undefined>>,
  options: ShareOptions
): SharePayload {
  if (map.aim || map.nodes.some(node => node.aimKind !== undefined))
    throw new ShareError("aim-map", "AIM maps cannot be shared.");
  const nodes: ShareNodePayload[] = map.nodes.map(node => {
    const note = notesById[node.id];
    const fallbackTitle = node.path.split("/").pop()?.replace(/\.md$/i, "") ?? node.id;
    const out: ShareNodePayload = {
      id: node.id,
      parentId: node.parentId,
      x: node.x,
      y: node.y,
      collapsed: node.collapsed,
      status: note?.status === "completed" ? "completed" : "idea",
      title: note?.title || fallbackTitle,
      summary: note?.summary ?? ""
    };
    if (note?.relevance) {
      out.tier = note.relevance.tier;
      if (note.relevance.manual) out.manual = true;
      const reason = optionalText(note.reason);
      if (reason) out.reason = reason;
    }
    if (options.includeDetail) {
      if (note?.detailHtml?.trim()) out.detailHtml = note.detailHtml;
    }
    return out;
  });
  const goal = optionalText(options.goal);
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    title: map.title,
    ...(goal ? { goal } : {}),
    language: options.language,
    exportedAt: options.exportedAt,
    source: { vamVersion: options.vamVersion, mapId: map.id },
    viewport: { x: map.viewport.x, y: map.viewport.y, zoom: map.viewport.zoom },
    nodes,
    assets: options.includeImages ? { ...options.assets } : {}
  };
}

/** JSON for the `<script type="application/json">` block. Every `<` is escaped so `</script>` and `<!--` cannot occur. */
export function serializeShareJson(payload: SharePayload): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, ch => (ch === "\u2028" ? "\\u2028" : "\\u2029"));
}

export type SizeClass = "ok" | "warn" | "large";
/** warn above 10 MB, large above 20 MB (thresholds injectable for tests). */
export function classifySize(
  bytes: number,
  thresholds: { warn: number; large: number } = {
    warn: SHARE_SIZE_WARN_BYTES,
    large: SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES
  }
): SizeClass {
  if (bytes > thresholds.large) return "large";
  if (bytes > thresholds.warn) return "warn";
  return "ok";
}

/** Scales (width, height) down so the longest edge is at most `max`; never upscales. */
export function fitWithin(
  width: number,
  height: number,
  max: number = SHARE_IMAGE_MAX_EDGE
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    throw new RangeError("Image dimensions must be positive.");
  const longest = Math.max(width, height);
  if (longest <= max) return { width: Math.round(width), height: Math.round(height) };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
