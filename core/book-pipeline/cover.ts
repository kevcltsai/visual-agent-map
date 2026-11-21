/**
 * Cover pictures of the picture-book pipeline (plan 2026-11-21-book-cover-image, A1). Pure: the planner's cover ask as a slot and as a
 * Prompt line, the Wikimedia-only rule for what may be downloaded into the vault (host, path, thumbnail address, size, file type by
 * magic bytes), and the file name and path of the saved copy. No I/O; the download itself is in cover-download.ts.
 */

import { cleanSearchTerms, cleanSlotText, shortHash, type ImageSlot } from "./image-slots";

/** The cover is slot 0 of a card's find-images request (body pictures are 1..n). */
export const COVER_INDEX = 0;
/** A cover file is refused above this many bytes. */
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
/** The thumbnail width asked of Wikimedia. */
export const COVER_THUMB_WIDTH = 1280;
/** The needs-review token of a card whose placed cover looks off its ask. */
export const coverOffToken = "cover:off";

/** What the planner wants as a card's cover: one line of what it shows and 2 to 4 English search terms (none on the book structure's copy). */
export interface CoverPlan {
  explains: string;
  search: string[];
}

export type CoverMime = "image/png" | "image/jpeg" | "image/webp";
export type CoverExt = "png" | "jpg" | "webp";

const EXPLAINS_MAX = 200;
const TITLE_MAX = 40;
const LINE_LABELS = {
  zh: { cover: "封面要找", search: "英文搜尋詞", colon: "：" },
  en: { cover: "Cover to find", search: "Search terms", colon: ": " }
} as const;
const SEPARATOR = "｜";

/** The cover as a find-images slot (kind `cover`, index 0, no position). */
export function coverAsSlot(plan: CoverPlan): ImageSlot {
  return { index: COVER_INDEX, kind: "cover", explains: plan.explains, anchor: "", search: plan.search };
}

/** `封面要找：<描述>｜英文搜尋詞：a, b` (the search part only when there are terms); one line, no field separator inside the parts. */
export function composeCoverLine(plan: CoverPlan, language: "zh" | "en" = "zh"): string {
  const l = LINE_LABELS[language];
  const terms = cleanSearchTerms(plan.search);
  const search = terms.length ? `${SEPARATOR}${l.search}${l.colon}${terms.join(", ")}` : "";
  return `${l.cover}${l.colon}${cleanSlotText(plan.explains, EXPLAINS_MAX)}${search}`;
}

const LINE = /^(?:封面要找|Cover to find)[：:][ \t]*(.*)$/;
const SEARCH_PART = /^(?:英文搜尋詞|Search terms)[：:][ \t]*(.*)$/;
/** Reads one cover line (either language); undefined when it is not one or names nothing to find. */
export function parseCoverLine(line: string): CoverPlan | undefined {
  const m = LINE.exec(line.trim());
  if (!m) return undefined;
  const [first, ...rest] = m[1].split(SEPARATOR);
  const explains = cleanSlotText(first, EXPLAINS_MAX);
  if (!explains) return undefined;
  const terms = rest.map(part => SEARCH_PART.exec(part.trim())?.[1]).find(value => value !== undefined);
  return { explains, search: terms ? cleanSearchTerms(terms.split(",")) : [] };
}

const HOST = "upload.wikimedia.org";
const FILE_EXT = /\.(jpe?g|png|webp|svg)$/i;

interface Parsed {
  a: string;
  ab: string;
  name: string;
}

/** The file a Wikimedia Commons upload address names, or undefined for any other address (host exact, https, no userinfo, no port, `/wikipedia/commons/`). */
function parseCommonsUrl(value: string): Parsed | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== HOST || url.username || url.password || url.port) return undefined;
  const parts = url.pathname.split("/");
  if (parts[0] !== "" || parts[1] !== "wikipedia" || parts[2] !== "commons") return undefined;
  const rest = parts.slice(3);
  // /a/ab/File.jpg  or  /thumb/a/ab/File.jpg/320px-File.jpg
  const direct = rest[0] !== "thumb" && rest.length === 3;
  const thumb = rest[0] === "thumb" && rest.length === 5;
  if (!direct && !thumb) return undefined;
  const [a, ab, name] = direct ? rest : rest.slice(1);
  if (!/^[0-9a-f]$/.test(a) || !/^[0-9a-f]{2}$/.test(ab) || !name || name.includes("..")) return undefined;
  return { a, ab, name };
}

/** Candidates whose address passes the download rule; every other host is dropped before a cover is chosen. */
export function coverCandidates<T extends { url: string }>(candidates: readonly T[]): T[] {
  return candidates.filter(candidate => parseCommonsUrl(candidate.url) !== undefined && coverDownloadUrl(candidate.url) !== undefined);
}

const BASE = `https://${HOST}/wikipedia/commons`;

/** The 1280px thumbnail address built from the file's original or thumbnail address (an SVG gets `.png`); undefined when the address or the file type is not allowed. */
export function coverDownloadUrl(url: string): string | undefined {
  const parsed = parseCommonsUrl(url);
  const ext = parsed && FILE_EXT.exec(parsed.name)?.[1].toLowerCase();
  if (!parsed || !ext) return undefined;
  const sized = `${COVER_THUMB_WIDTH}px-${parsed.name}${ext === "svg" ? ".png" : ""}`;
  return `${BASE}/thumb/${parsed.a}/${parsed.ab}/${parsed.name}/${sized}`;
}

/** The original file address, the fallback for a raster whose thumbnail answered 4xx (asked width above the original); an SVG has none. */
export function coverOriginalUrl(url: string): string | undefined {
  const parsed = parseCommonsUrl(url);
  const ext = parsed && FILE_EXT.exec(parsed.name)?.[1].toLowerCase();
  if (!parsed || !ext || ext === "svg") return undefined;
  return `${BASE}/${parsed.a}/${parsed.ab}/${parsed.name}`;
}

const EXT_OF: Record<CoverMime, CoverExt> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** The file extension of a detected type (never taken from the address). */
export const coverExtOf = (mime: CoverMime): CoverExt => EXT_OF[mime];

/** The image type by its first bytes: PNG, JPEG or WebP; undefined for anything else (SVG, GIF, HTML, a short or empty body). */
export function sniffImageMime(data: ArrayBuffer | Uint8Array): CoverMime | undefined {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  const at = (offset: number, bytes: readonly number[]): boolean => bytes.every((byte, i) => b[offset + i] === byte);
  if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return undefined;
}

/**
 * The saved copy's name: `<cleaned card title, at most 40 characters>-<hash of the picture's key>.<ext>`. The title loses `\ / : * ? " < > | # ^ [ ]`,
 * control characters, `..` and leading dots; nothing left becomes `cover`. Undefined for an extension other than png, jpg or webp.
 */
export function coverFileName(title: string, sourceUrl: string, ext: string): string | undefined {
  if (ext !== "png" && ext !== "jpg" && ext !== "webp") return undefined;
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  const name = Array.from(cleaned.replace(/^[.\s]+/, "")).slice(0, TITLE_MAX).join("").replace(/[.\s]+$/, "");
  return `${name || "cover"}-${shortHash(sourceUrl)}.${ext}`;
}

/** The vault path of a cover file inside its folder; undefined when a folder segment is `.` or `..` or the file name could leave the folder. */
export function coverPath(folder: string, fileName: string): string | undefined {
  if (!fileName || /[\\/]/.test(fileName) || fileName.includes("..") || fileName.startsWith(".")) return undefined;
  const segments = folder.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === ".." || segment.includes("\\"))) return undefined;
  return [...segments, fileName].join("/");
}
