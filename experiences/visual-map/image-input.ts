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

const SIZE_LIMIT = 65535 * 16;
const sized = (width: number, height: number): { width: number; height: number } | null =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= SIZE_LIMIT && height <= SIZE_LIMIT
    ? { width, height }
    : null;

/** Pixel size read from the header of an already sniffed image; null when the header is short or unreadable. Never decodes pixels. */
export function imageSize(bytes: ArrayBuffer | Uint8Array): { width: number; height: number } | null {
  const b = asBytes(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (sniffImage(b)) {
    case "image/png":
      return b.length >= 24 ? sized(view.getUint32(16), view.getUint32(20)) : null;
    case "image/gif":
      return b.length >= 10 ? sized(view.getUint16(6, true), view.getUint16(8, true)) : null;
    case "image/jpeg": {
      let at = 2;
      while (at + 9 < b.length) {
        if (b[at] !== 255) {
          at++;
          continue;
        }
        const marker = b[at + 1];
        if (marker === 255) {
          at++;
          continue;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          at += 2;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return sized(view.getUint16(at + 7), view.getUint16(at + 5));
        at += 2 + view.getUint16(at + 2);
      }
      return null;
    }
    case "image/webp": {
      if (b.length < 30) return null;
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === "VP8X") return sized((b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1);
      if (kind === "VP8 ") return sized(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (kind === "VP8L") {
        const bits = view.getUint32(21, true);
        return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      return null;
    }
    default:
      return null;
  }
}
