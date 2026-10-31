/**
 * Whitelist for image bytes that arrive from drop, paste or file pick. Everything here is untrusted: the type is
 * decided by magic bytes (never by file name or declared MIME alone), SVG, URLs and HTML are refused, and nothing is
 * fetched. Pure functions, no DOM or Obsidian imports.
 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ImageRejection = "not-image-mime" | "svg" | "too-large" | "empty" | "bad-content";
export type ImageAcceptance = { ok: true; mime: ImageMime } | { ok: false; reason: ImageRejection };
export interface ImageCandidate {
  mime: string;
  size: number;
  bytes: ArrayBuffer | Uint8Array;
}

const EXTENSION: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};
const NAME_LIMIT = 80;

const asBytes = (bytes: ArrayBuffer | Uint8Array): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
const startsWith = (b: Uint8Array, at: number, text: number[]): boolean => text.every((c, i) => b[at + i] === c);
const ascii = (text: string): number[] => Array.from(text, ch => ch.charCodeAt(0));

/** Recognises PNG, JPEG, GIF and WebP by magic bytes; anything else (SVG, HTML, text) is null. */
export function sniffImage(bytes: ArrayBuffer | Uint8Array): ImageMime | null {
  const b = asBytes(bytes);
  if (b.length >= 8 && startsWith(b, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 6 && (startsWith(b, 0, ascii("GIF87a")) || startsWith(b, 0, ascii("GIF89a")))) return "image/gif";
  if (b.length >= 12 && startsWith(b, 0, ascii("RIFF")) && startsWith(b, 8, ascii("WEBP"))) return "image/webp";
  return null;
}

/** Accepts one candidate only if the declared MIME is image/* (not SVG), the size is within the limit and the bytes sniff as a whitelisted image. */
export function acceptImage(candidate: ImageCandidate): ImageAcceptance {
  const mime = typeof candidate.mime === "string" ? candidate.mime.trim().toLowerCase() : "";
  if (!mime.startsWith("image/")) return { ok: false, reason: "not-image-mime" };
  if (mime.startsWith("image/svg")) return { ok: false, reason: "svg" };
  const bytes = asBytes(candidate.bytes);
  const size = Math.max(Number.isFinite(candidate.size) ? candidate.size : 0, bytes.byteLength);
  if (size > IMAGE_MAX_BYTES) return { ok: false, reason: "too-large" };
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  const sniffed = sniffImage(bytes);
  return sniffed ? { ok: true, mime: sniffed } : { ok: false, reason: "bad-content" };
}

interface FileListLike {
  length: number;
  [index: number]: { type?: string } | undefined;
}
/** Only `files` count. `text/uri-list`, `text/html` and `items` strings are ignored so nothing is ever downloaded. */
export function imageFilesFrom<T extends { type?: string }>(
  transfer: { files?: ArrayLike<T> | FileListLike | null } | null | undefined
): T[] {
  const files = transfer?.files;
  if (!files || typeof files.length !== "number") return [];
  const out: T[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as T | undefined;
    if (file && typeof file.type === "string" && file.type.toLowerCase().startsWith("image/")) out.push(file);
  }
  return out;
}

/** A vault-safe attachment name: only letters, digits, `-_ .`; the extension comes from the sniffed MIME, never the input name. Null for a MIME outside the whitelist. */
export function safeImageName(name: string, mime: string): string | null {
  const extension = EXTENSION[mime as ImageMime];
  if (!extension) return null;
  const leaf =
    String(name ?? "")
      .split(/[\\/]/)
      .pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const cleaned = stem
    .replace(/[^A-Za-z0-9\-_ .]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, NAME_LIMIT)
    .replace(/[ .]+$/g, "");
  return `${cleaned || "image"}.${extension}`;
}
