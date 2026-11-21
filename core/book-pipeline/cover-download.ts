/**
 * Downloading a cover picture into the vault (plan 2026-11-21-book-cover-image §6 security). The fetch is injected (production:
 * Obsidian's `requestUrl`, which cannot be aborted, so an answer that arrives after an abort or the timeout is simply dropped).
 * The order is fixed: address whitelist, request, status, content-length, real size, content-type, magic bytes agree with the header.
 * Only after all that does {@link saveCover} write, and only a new path: an existing file is reused, never overwritten or deleted.
 */

import { retryAfterMs } from "./commons-search";
import {
  COVER_MAX_BYTES,
  coverDownloadUrl,
  coverExtOf,
  coverFileName,
  coverOriginalUrl,
  coverPath,
  sniffImageMime,
  type CoverExt,
  type CoverMime
} from "./cover";

export interface CoverResponse {
  status: number;
  headers?: Record<string, string>;
  bytes: ArrayBuffer;
}
/** One GET; the headers are only the Wikimedia User-Agent policy pair (nothing about the user). */
export type CoverFetch = (url: string, init: { headers: Record<string, string> }) => Promise<CoverResponse>;

export type CoverFailure = "url" | "status" | "size" | "type" | "mismatch" | "timeout" | "aborted" | "failed" | "path";
export type CoverDownload =
  { ok: true; bytes: Uint8Array; mime: CoverMime; ext: CoverExt; url: string } | { ok: false; reason: CoverFailure };

export interface CoverDownloadOptions {
  signal?: AbortSignal;
  /** The whole download (thumbnail and the one fallback) gives up after this long. Default 15 s. */
  timeoutMs?: number;
  userAgent?: string;
}

export const COVER_TIMEOUT_MS = 15_000;
/** A 429 answer is waited out once, as long as its Retry-After says, at most this long; a longer (or no) wait is a failed download. */
export const COVER_RETRY_MAX_MS = 8000;
const DEFAULT_AGENT = "VisualAgentMap-Obsidian-plugin";
const ALLOWED = new Set<string>(["image/png", "image/jpeg", "image/webp"]);

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** What a cover answer is worth: the downloaded file, or the first rule it broke. */
function judge(response: CoverResponse, url: string): CoverDownload {
  if (response.status !== 200) return { ok: false, reason: "status" };
  const length = Number(header(response.headers, "content-length"));
  if (Number.isFinite(length) && length > COVER_MAX_BYTES) return { ok: false, reason: "size" };
  if (response.bytes.byteLength > COVER_MAX_BYTES) return { ok: false, reason: "size" };
  const type = (header(response.headers, "content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.has(type)) return { ok: false, reason: "type" };
  const bytes = new Uint8Array(response.bytes);
  const mime = sniffImageMime(bytes);
  if (mime !== type) return { ok: false, reason: "mismatch" };
  return { ok: true, bytes, mime, ext: coverExtOf(mime), url };
}

/** Downloads the cover of a Commons file: its 1280px thumbnail, or (a raster whose thumbnail answered 4xx other than 429) the original once. */
export async function downloadCover(
  imageUrl: string,
  fetch: CoverFetch,
  options: CoverDownloadOptions = {}
): Promise<CoverDownload> {
  const thumb = coverDownloadUrl(imageUrl);
  if (!thumb) return { ok: false, reason: "url" };
  const { signal } = options;
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const agent = options.userAgent ?? DEFAULT_AGENT;
  const headers = { "User-Agent": agent, "Api-User-Agent": agent };
  let onAbort = (): void => undefined;
  let timer: number | undefined;
  const stop = new Promise<CoverDownload>(resolve => {
    onAbort = () => resolve({ ok: false, reason: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => resolve({ ok: false, reason: "timeout" }), options.timeoutMs ?? COVER_TIMEOUT_MS);
  });
  const timers: number[] = [];
  let waited = false;
  const get = async (url: string): Promise<CoverResponse | CoverDownload> => {
    const result = await Promise.race([
      fetch(url, { headers }).catch((): CoverDownload => ({ ok: false, reason: "failed" })),
      stop
    ]);
    // The fetch may answer in the same turn as an abort: the abort wins, the bytes are dropped.
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    if ("ok" in result || result.status !== 429 || waited) return result;
    // Too many requests: wait the Retry-After once (never longer than the limit, and a stop or the timeout ends the wait), then ask again.
    const ms = retryAfterMs(result.headers, Date.now());
    if (ms === undefined || ms > COVER_RETRY_MAX_MS) return result;
    waited = true;
    const slept = await Promise.race([
      new Promise<undefined>(resolve => timers.push(window.setTimeout(() => resolve(undefined), ms))),
      stop
    ]);
    if (slept) return slept;
    return signal?.aborted ? { ok: false, reason: "aborted" } : get(url);
  };
  try {
    let response = await get(thumb);
    if ("ok" in response) return response;
    const original = coverOriginalUrl(imageUrl);
    if (original && response.status >= 400 && response.status < 500 && response.status !== 429) {
      const second = await get(original);
      if ("ok" in second) return second;
      return judge(second, original);
    }
    return judge(response, thumb);
  } finally {
    window.clearTimeout(timer);
    for (const waiting of timers) window.clearTimeout(waiting);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The vault operations a cover save needs (production: `adapter.exists`, `Vault.createBinary`, folder creation). */
export interface CoverVaultPorts {
  exists(path: string): Promise<boolean>;
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
  ensureFolder?(folder: string): Promise<void>;
}
export type CoverSaved = { ok: true; path: string; reused: boolean } | { ok: false; reason: CoverFailure };

/**
 * Saves a downloaded cover as `<folder>/<card title>-<hash>.<ext>`. The name carries the picture's hash, so a rerun finds the same path:
 * a file already there (the program's earlier copy, or anything of the owner's) is reused as it is. Never overwrites, never deletes.
 * Nothing is written once `signal` aborted.
 */
export async function saveCover(
  ports: CoverVaultPorts,
  folder: string,
  title: string,
  sourceUrl: string,
  download: CoverDownload,
  signal?: AbortSignal
): Promise<CoverSaved> {
  if (!download.ok) return download;
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const name = coverFileName(title, sourceUrl, download.ext);
  const path = name ? coverPath(folder, name) : undefined;
  if (!path) return { ok: false, reason: "path" };
  try {
    await ports.ensureFolder?.(folder);
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    if (await ports.exists(path))
      return signal?.aborted ? { ok: false, reason: "aborted" } : { ok: true, path, reused: true };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    const data = download.bytes.buffer.slice(
      download.bytes.byteOffset,
      download.bytes.byteOffset + download.bytes.byteLength
    ) as ArrayBuffer;
    await ports.createBinary(path, data);
    return { ok: true, path, reused: false };
  } catch {
    // Another writer created the same path first: that file is the one in use.
    const raced = await ports.exists(path).catch(() => false);
    return raced ? { ok: true, path, reused: true } : { ok: false, reason: "failed" };
  }
}
