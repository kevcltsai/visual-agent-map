import type { MapDocument } from "../../map-model";
import type { RelevanceTier } from "../../note-values";
import type { ContentLanguage } from "../../i18n";
import { readTopicColor, readTopicStyle, type TopicColor, type TopicStyle } from "../../topic-colors";
import { CARD_WIDTH, clampCardHeight, clampCardWidth } from "../../map-graph";
import { branchDirectionOf, layoutDirectionFor, type BranchDirection } from "../../layouts/compose";
import { layoutOf, type MapLayout } from "../../map-layout";
import { readTopicMarkers, type TopicMarker } from "../../topic-markers";
import { readTopicLinks } from "../../topic-links";
import { aimEnabled } from "../aim/availability";

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
/**
 * `contentLanguage` of a file whose original language could not be told (a map with Latin or other text nothing
 * recognises). BCP 47 "undetermined": it takes none of the six translation languages' places, and the viewer names no
 * source language for it.
 */
export const SHARE_UNKNOWN_LANGUAGE = "und";
/** The language of a file's original text: a registry language, or {@link SHARE_UNKNOWN_LANGUAGE}. */
export type ShareOriginalLanguage = ContentLanguage | typeof SHARE_UNKNOWN_LANGUAGE;
export type ShareTranslationLanguage = (typeof SHARE_TRANSLATION_LANGUAGES)[number];
export const isShareTranslationLanguage = (value: unknown): value is ShareTranslationLanguage =>
  typeof value === "string" && (SHARE_TRANSLATION_LANGUAGES as readonly string[]).includes(value);

/** One edit to a diagram's flat node list (elements and text nodes in document order, the `<svg>` itself first): a text node's new text, or an element's attributes (a value of null removes the attribute). */
export type ShareDiagramPatchOp = [number, string] | [number, Record<string, string | null>];
/**
 * A translated diagram (D-2026-10-122): null keeps the original drawing; `{check, patch}` edits the original drawing
 * (`check` ties the patch to it); `{svg}` carries the whole translated drawing when a patch cannot describe it.
 */
export type ShareDiagramTranslation = { check: string; patch: ShareDiagramPatchOp[] } | { svg: string } | null;

/**
 * One note's text in a translated language. New files carry the compact form (D-2026-10-122): `detailSegments` holds
 * the translated text units of the original `detailHtml` (null keeps the original unit), `detailCheck` ties them to
 * that original, and `detailDiagrams` the diagrams; the viewer rebuilds the note from the original. `detailHtml` is
 * the legacy whole-note form: read-only, never written any more.
 */
export interface ShareNodeTranslation {
  title: string;
  summary: string;
  reason?: string;
  detailHtml?: string;
  detailSegments?: Array<string | null>;
  detailCheck?: string;
  detailDiagrams?: ShareDiagramTranslation[];
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
  /** Optional (card-resize): a custom card width, 200-560 and not 280. Absent means the standard width; `version` stays 1. */
  width?: number;
  /** Optional (card-height): a custom card height, 80-720. Absent means as tall as the content; `version` stays 1. */
  height?: number;
  /** Optional (text-then-topic): the text block (in `textNodes`, on the same `parentId`) this topic follows. Absent means a direct child; `version` stays 1. */
  afterTextId?: string;
  status: "idea" | "completed";
  title: string;
  summary: string;
  tier?: RelevanceTier;
  reason?: string;
  manual?: true;
  /** Optional (ticket 33): whitelisted topic marker ids in fixed order. Absent means none; `version` stays 1. */
  markers?: TopicMarker[];
  /** Optional (ticket 37): a whitelisted topic colour id. Absent means none; `version` stays 1. */
  color?: TopicColor;
  /** Optional (card-style): whitelisted topic style tokens. Absent means none; `version` stays 1. The viewer checks them again. */
  style?: TopicStyle[];
  /** Optional (topic-links): normalized http(s) hrefs of the topic. Absent means none; `version` stays 1. The viewer checks each again. */
  links?: string[];
  /** Detail rendered to sanitized HTML at export time; images reference `assets` by name. */
  detailHtml?: string;
  /** Optional (share-match-map): this branch's own growth direction (already cleaned by the map reader). Absent means the map's. `version` stays 1. */
  layout?: { direction: BranchDirection };
  /** Optional (share-match-map): the card's cover picture; only with notes and images in the file. Default look values are not written. `version` stays 1. */
  cover?: ShareCoverPayload;
  /** Optional (D-2026-10-116): this note's text per translated language, keyed by language id. The original stays in the fields above. */
  translations?: Record<string, ShareNodeTranslation>;
}

/**
 * Optional (tree-text-node): a user-written text node. `parentId` is the topic it hangs under, or null for an orphan
 * (no parent topic left); an orphan is shown as free text at its own x/y. `text` is plain text, never HTML.
 */
export interface ShareTextNodePayload {
  id: string;
  parentId: string | null;
  text: string;
  x: number;
  y: number;
  /** Optional (canvas-text-node): ids of the topics a free text block is linked to; present only when it has live links. */
  links?: string[];
}

/**
 * Optional (summary-bracket): a curly brace around a run of sibling subtrees, with the user's conclusion text beyond it.
 * `members` is the whole run (first to last sibling, in order); the card heights are only known on the page, so the viewer
 * draws the brace from the cards it lays out. `side` is the side of the run the brace stands on. `text` is plain text, never HTML.
 */
export interface ShareSummaryPayload {
  id: string;
  parentId: string;
  members: string[];
  side: "right" | "left" | "down" | "up";
  text: string;
}

/** The card's cover picture: `asset` names an `assets` entry; `frame` is [x, y, w, h] as 0-1 fractions of the picture. */
export interface ShareCoverPayload {
  asset: string;
  frame?: [number, number, number, number];
  size?: number;
  position?: "bottom" | "left" | "right";
}

/** One anchor of an annotated image (only `image-2d` positions): x and y are 0-1 fractions of the picture. */
export interface ShareAnchorPayload {
  id: string;
  x: number;
  y: number;
  note?: string;
}

/**
 * Optional (share-match-map): an annotated image on the canvas. `asset` is absent when the picture is not in the file
 * (no images, or it could not be read): the viewer then draws a placeholder. The vault path never travels.
 */
export interface ShareImagePayload {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  asset?: string;
  note?: string;
  anchors: ShareAnchorPayload[];
  /** anchor -> topic relations (either direction in the map); kind and description are not carried. */
  links?: Array<{ anchor: string; topic: string; ring?: true }>;
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
  /** Optional (tree-text-node): present only when the map has text nodes; absent keeps older files byte-identical. `version` stays 1. */
  textNodes?: ShareTextNodePayload[];
  /** Optional (summary-bracket): present only when the map has a drawable bracket; absent keeps older files byte-identical. `version` stays 1. */
  summaries?: ShareSummaryPayload[];
  /** Optional (share-match-map): the map's layout when it is not the default (right, standard spacing). `version` stays 1. */
  layout?: MapLayout;
  /** Optional (share-match-map): annotated images; absent when the map has none. `version` stays 1. */
  images?: ShareImagePayload[];
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
  /** Topic marker ids from the note; anything not on the whitelist is dropped when the payload is built. */
  markers?: readonly unknown[];
  /** Topic colour id from the note; anything not on the whitelist is dropped when the payload is built. */
  color?: unknown;
  /** Topic style tokens from the note; anything not on the whitelist is dropped when the payload is built. */
  style?: readonly unknown[];
  /** Topic link list from the note; only valid http(s) addresses survive when the payload is built. */
  links?: readonly unknown[];
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
  /** topic id -> cover picture asset name and look. Used only when includeDetail and includeImages; an asset not in `assets` is ignored. */
  covers?: Readonly<
    Record<
      string,
      { asset: string; frame?: { x: number; y: number; w: number; h: number } | null; size?: number; position?: string }
    >
  >;
  /** annotated image id -> asset name. Same rule as `covers`. */
  imageAssets?: Readonly<Record<string, string>>;
  /** Turns free text into plain text (the exporter passes `plainWikilinks`); identity when absent. */
  plainText?: (text: string) => string;
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

/** Same limit as `cleanText` in canvas-items.ts, kept literal so the viewer bundle imports nothing new. */
const SHARE_TEXT_LIMIT = 2000;

/** The map's text nodes for the payload: a parent that is missing or the node itself makes it an orphan (parentId null), never dropped. */
function shareTextNodes(map: MapDocument): ShareTextNodePayload[] {
  const ids = new Set(map.nodes.map(node => node.id));
  const seen = new Set<string>();
  const out: ShareTextNodePayload[] = [];
  for (const item of map.canvasItems ?? []) {
    const raw = item as unknown as Record<string, unknown>;
    if (raw.kind !== "text" || typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue;
    if (typeof raw.text !== "string") continue;
    const text = raw.text.trim().slice(0, SHARE_TEXT_LIMIT);
    if (!text || typeof raw.x !== "number" || typeof raw.y !== "number") continue;
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) continue;
    seen.add(raw.id);
    const parentId = typeof raw.parentId === "string" && ids.has(raw.parentId) ? raw.parentId : null;
    const links: string[] = [];
    if (parentId === null && Array.isArray(raw.links))
      for (const link of raw.links)
        if (typeof link === "string" && ids.has(link) && !links.includes(link)) links.push(link);
    out.push({ id: raw.id, parentId, text, x: raw.x, y: raw.y, ...(links.length ? { links } : {}) });
  }
  return out;
}

/**
 * The map's summary brackets for the payload. A bracket whose run is gone, whose text is empty or whose arrangement
 * cannot draw it (radial, timeline, fishbone, or a balanced run on both halves) is left out; the map itself keeps it.
 */
function shareSummaries(map: MapDocument): ShareSummaryPayload[] {
  const out: ShareSummaryPayload[] = [];
  const seen = new Set<string>();
  const byId = new Map(map.nodes.map(node => [node.id, node]));
  for (const item of map.canvasItems ?? []) {
    const raw = item as unknown as Record<string, unknown>;
    if (raw.kind !== "summary" || typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue;
    if (typeof raw.text !== "string" || typeof raw.parentId !== "string" || !Array.isArray(raw.members)) continue;
    const text = raw.text.trim().slice(0, SHARE_TEXT_LIMIT);
    const parent = byId.get(raw.parentId);
    if (!text || !parent) continue;
    const picked = new Set(raw.members.filter((id): id is string => typeof id === "string"));
    // A topic that follows a text block is not in the row a bracket frames.
    const siblings = map.nodes.filter(node => node.parentId === parent.id && !node.afterTextId);
    const at = siblings.flatMap((node, index) => (picked.has(node.id) ? [index] : []));
    if (!at.length) continue;
    const range = siblings.slice(at[0], at[at.length - 1] + 1);
    const direction = layoutDirectionFor(map.nodes, range[0].id, layoutOf(map).direction);
    let side: ShareSummaryPayload["side"];
    if (direction === "balanced") {
      const middle = parent.x + (parent.width ?? CARD_WIDTH) / 2;
      const halves = new Set(range.map(node => (node.x + (node.width ?? CARD_WIDTH) / 2 < middle ? "left" : "right")));
      if (halves.size !== 1) continue;
      side = halves.has("left") ? "left" : "right";
    } else if (direction === "right" || direction === "left" || direction === "down" || direction === "up")
      side = direction;
    else continue;
    seen.add(raw.id);
    out.push({ id: raw.id, parentId: parent.id, members: range.map(node => node.id), side, text });
  }
  return out;
}

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The cover entry for a node: look values at their default are left out; an unusable frame is left out (the whole picture). */
function shareCover(raw: NonNullable<ShareOptions["covers"]>[string], assets: Record<string, string>) {
  if (!assets[raw.asset]) return undefined;
  const out: ShareCoverPayload = { asset: raw.asset };
  const f = raw.frame;
  if (
    f &&
    [f.x, f.y, f.w, f.h].every(finiteNumber) &&
    f.x >= 0 &&
    f.y >= 0 &&
    f.w > 0 &&
    f.h > 0 &&
    f.x + f.w <= 1.0001 &&
    f.y + f.h <= 1.0001 &&
    !(f.x === 0 && f.y === 0 && f.w === 1 && f.h === 1)
  )
    out.frame = [f.x, f.y, f.w, f.h];
  if (finiteNumber(raw.size) && raw.size >= 0.3 && raw.size < 1) out.size = raw.size;
  if (raw.position === "bottom" || raw.position === "left" || raw.position === "right") out.position = raw.position;
  return out;
}

/** The map's annotated images for the payload (decision #4: only these; the vault path, relation kind and description stay out). */
function shareImages(
  map: MapDocument,
  nodeIds: ReadonlySet<string>,
  assetNames: Readonly<Record<string, string>>,
  assets: Record<string, string>,
  plain: (text: string) => string
): ShareImagePayload[] {
  const out: ShareImagePayload[] = [];
  const seen = new Set<string>();
  for (const item of map.canvasItems ?? []) {
    const raw = item as unknown as Record<string, unknown>;
    if (raw.kind !== "annotated-image" || typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue;
    if (![raw.x, raw.y, raw.w, raw.h].every(finiteNumber)) continue;
    const [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h] as number[];
    if (!(w > 0 && h > 0)) continue;
    seen.add(raw.id);
    const image: ShareImagePayload = { id: raw.id, x, y, w, h, anchors: [] };
    const asset = assetNames[raw.id];
    if (asset && assets[asset]) image.asset = asset;
    const note = typeof raw.note === "string" ? optionalText(plain(raw.note)) : undefined;
    if (note) image.note = note;
    const anchorIds = new Set<string>();
    for (const entry of Array.isArray(raw.anchors) ? raw.anchors : []) {
      const anchor = entry as { id?: unknown; at?: { kind?: unknown; x?: unknown; y?: unknown }; note?: unknown };
      if (typeof anchor?.id !== "string" || !anchor.id || anchorIds.has(anchor.id)) continue;
      const at = anchor.at;
      if (!at || at.kind !== "image-2d" || !finiteNumber(at.x) || !finiteNumber(at.y)) continue;
      anchorIds.add(anchor.id);
      const entryOut: ShareAnchorPayload = { id: anchor.id, x: clamp01(at.x), y: clamp01(at.y) };
      const anchorNote = typeof anchor.note === "string" ? optionalText(plain(anchor.note)) : undefined;
      if (anchorNote) entryOut.note = anchorNote;
      image.anchors.push(entryOut);
    }
    const links: NonNullable<ShareImagePayload["links"]> = [];
    for (const relation of Array.isArray(raw.relations) ? raw.relations : []) {
      const { from, to, ring } = (relation ?? {}) as { from?: unknown; to?: unknown; ring?: unknown };
      if (typeof from !== "string" || typeof to !== "string") continue;
      const anchor = anchorIds.has(from) ? from : anchorIds.has(to) ? to : undefined;
      const topic = anchor === from ? to : from;
      if (!anchor || anchorIds.has(topic) || !nodeIds.has(topic)) continue;
      links.push({ anchor, topic, ...(ring === true ? { ring: true as const } : {}) });
    }
    if (links.length) image.links = links;
    out.push(image);
  }
  return out;
}

/**
 * Builds the share payload. Throws ShareError for AIM maps, which cannot be shared while AIM is available. While AIM is hidden
 * an old AIM map shares like any map: the payload is a whitelist of node fields, so it never carries `aim` or an `aim*` field.
 */
export function buildSharePayload(
  map: MapDocument,
  notesById: Readonly<Record<string, ShareNoteInput | undefined>>,
  options: ShareOptions
): SharePayload {
  if (aimEnabled() && (map.aim || map.nodes.some(node => node.aimKind !== undefined)))
    throw new ShareError("aim-map", "AIM maps cannot be shared.");
  // Pictures travel only with the notes and only when images are on (decision #3); an asset must really be in the file.
  const withImages = options.includeImages && options.includeDetail;
  const assets: Record<string, string> = options.includeImages ? { ...options.assets } : {};
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
    if (node.width !== undefined && clampCardWidth(node.width) !== undefined && node.width !== CARD_WIDTH)
      out.width = clampCardWidth(node.width);
    if (node.height !== undefined && clampCardHeight(node.height) !== undefined)
      out.height = clampCardHeight(node.height);
    if (note?.relevance) {
      out.tier = note.relevance.tier;
      if (note.relevance.manual) out.manual = true;
      const reason = optionalText(note.reason);
      if (reason) out.reason = reason;
    }
    const markers = readTopicMarkers({ "topic-markers": note?.markers });
    if (markers.length) out.markers = markers;
    const color = readTopicColor({ "topic-color": note?.color });
    if (color) out.color = color;
    const style = readTopicStyle({ "topic-style": note?.style });
    if (style.length) out.style = style;
    const links = readTopicLinks({ "topic-links": note?.links });
    if (links.length) out.links = links;
    if (options.includeDetail) {
      if (note?.detailHtml?.trim()) out.detailHtml = note.detailHtml;
    }
    const branch = branchDirectionOf(node);
    if (branch) out.layout = { direction: branch };
    const coverEntry = withImages ? options.covers?.[node.id] : undefined;
    const cover = coverEntry ? shareCover(coverEntry, assets) : undefined;
    if (cover) out.cover = cover;
    return out;
  });
  const goal = optionalText(options.goal);
  const textNodes = shareTextNodes(map);
  // Only a follower whose text block is in the payload on the same parent keeps the link; anything else is a direct child.
  const textParent = new Map(textNodes.map(text => [text.id, text.parentId]));
  for (const out of nodes) {
    const textId = map.nodes.find(node => node.id === out.id)?.afterTextId;
    if (typeof textId === "string" && out.parentId !== null && textParent.get(textId) === out.parentId)
      out.afterTextId = textId;
  }
  const summaries = shareSummaries(map);
  const stored = layoutOf(map);
  const images = shareImages(
    map,
    new Set(map.nodes.map(node => node.id)),
    withImages ? (options.imageAssets ?? {}) : {},
    assets,
    options.plainText ?? (text => text)
  );
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
    ...(textNodes.length ? { textNodes } : {}),
    ...(summaries.length ? { summaries } : {}),
    ...(stored.direction !== "right" || stored.spacing ? { layout: stored } : {}),
    ...(images.length ? { images } : {}),
    assets
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
