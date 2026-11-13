import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import type { ReferenceDocument, ReferenceGroup } from "../../ai/reference-materials";

/**
 * Folders outside the vault used as map data sources. The list lives only in this device's Obsidian local storage
 * (per vault, per map id): never in data.json, Map.md, a prompt, a note, a log or a share file. Every read re-checks the
 * folder's real location; tasks and the UI only ever see the label (`name`, `name#2`, ...), never the path.
 */
export interface ExternalSource {
  path: string;
  label: string;
}

export const EXTERNAL_MAX_FILES = 500;
export const EXTERNAL_MAX_FILE_BYTES = 1024 * 1024;
export const EXTERNAL_MAX_DEPTH = 10;
/** Stands in for the source's root path wherever a read file's text repeats it. */
export const EXTERNAL_PATH_PLACEHOLDER = "[external folder]";

const STORAGE_PREFIX = "vam-map-external-sources:";
const storageKey = (mapId: string): string => `${STORAGE_PREFIX}${mapId}`;

interface LocalStorageApp {
  loadLocalStorage?(key: string): unknown;
  saveLocalStorage?(key: string, data: unknown): void;
}

/** This map's external sources from device-local storage; anything malformed is dropped. Never throws. */
export function loadExternalSources(app: object, mapId: string | undefined): ExternalSource[] {
  if (!mapId) return [];
  let raw: unknown;
  try {
    raw = (app as LocalStorageApp).loadLocalStorage?.(storageKey(mapId));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const result: ExternalSource[] = [];
  const labels = new Set<string>();
  for (const item of raw) {
    const entry = item as { path?: unknown; label?: unknown } | null;
    if (!entry || typeof entry.path !== "string" || typeof entry.label !== "string") continue;
    if (!entry.path || !entry.label || labels.has(entry.label)) continue;
    labels.add(entry.label);
    result.push({ path: entry.path, label: entry.label });
  }
  return result;
}

export function saveExternalSources(app: object, mapId: string, sources: readonly ExternalSource[]): void {
  (app as LocalStorageApp).saveLocalStorage?.(
    storageKey(mapId),
    sources.length ? sources.map(source => ({ path: source.path, label: source.label })) : null
  );
}

/** First of `name`, `name#2`, `name#3`... that no label of this map uses. Assigned once; never recomputed. */
export function allocateExternalLabel(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name}#${n}`)) return `${name}#${n}`;
}

export interface ExternalScope {
  /** Absolute filesystem path of the vault; without it nothing outside can be judged, so nothing is allowed. */
  vaultBase?: string;
  home?: string;
}

export type ExternalRejection =
  "relative" | "malformed" | "no-vault-path" | "missing" | "not-folder" | "root" | "home" | "vault" | "inside-vault";

export type ExternalCheck = { ok: true; real: string } | { ok: false; reason: ExternalRejection };

const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

/** Pasted text to the path stored: trimmed, a trailing separator removed (never from a root). */
export function cleanExternalInput(input: string): string {
  const text = input.trim();
  const root = parse(text).root;
  let end = text.length;
  while (end > root.length && (text[end - 1] === "/" || text[end - 1] === "\\")) end--;
  return text.slice(0, end);
}

/**
 * Decides whether `input` may be a source. The scope test runs on the `realpath`, so a link at the folder itself or at
 * any parent that points to the filesystem root, the home folder or above, the vault or above, or inside the vault is
 * refused. Run it on every read too: nothing from an earlier check is trusted.
 */
export async function checkExternalRoot(input: string, scope: ExternalScope): Promise<ExternalCheck> {
  const text = cleanExternalInput(input);
  if (!text || !isAbsolute(text)) return { ok: false, reason: "relative" };
  if (text.includes("\0") || text.split(/[\\/]/).includes("..") || normalize(text) !== text)
    return { ok: false, reason: "malformed" };
  if (!scope.vaultBase) return { ok: false, reason: "no-vault-path" };
  let real: string;
  let vaultReal: string;
  try {
    real = await realpath(text);
    vaultReal = await realpath(scope.vaultBase);
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    if (!(await lstat(real)).isDirectory()) return { ok: false, reason: "not-folder" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (parse(real).root === real) return { ok: false, reason: "root" };
  const home = scope.home ?? homedir();
  let homeReal = home;
  try {
    homeReal = await realpath(home);
  } catch {
    /* an unresolvable home is compared as written */
  }
  if (within(homeReal, real)) return { ok: false, reason: "home" };
  if (within(vaultReal, real)) return { ok: false, reason: "vault" };
  if (within(real, vaultReal)) return { ok: false, reason: "inside-vault" };
  return { ok: true, real };
}

/** Why a source cannot be used by a task. Carries no path. */
export type ExternalUnreadableReason = "unreadable" | "too-large";
export class ExternalSourceError extends Error {
  constructor(readonly reason: ExternalUnreadableReason) {
    super(reason);
  }
}

const aborted = (): Error => Object.assign(new Error("Aborted"), { name: "AbortError" });
const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith(".md");

interface ExternalFile {
  absolute: string;
  relative: string;
}
interface ExternalListing {
  real: string;
  files: ExternalFile[];
}

/**
 * The `.md` files of a source after a fresh range check: dot-folders skipped, links (files and folders) never followed,
 * at most 500 files, 1 MB each and 10 levels deep. Anything over a limit, missing or not allowed rejects the whole
 * source with an ExternalSourceError (no truncation).
 */
export async function listExternalSource(
  source: ExternalSource,
  scope: ExternalScope,
  signal: AbortSignal
): Promise<ExternalListing> {
  const check = await checkExternalRoot(source.path, scope);
  if (!check.ok) throw new ExternalSourceError("unreadable");
  const files: ExternalFile[] = [];
  const visit = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (signal.aborted) throw aborted();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new ExternalSourceError("unreadable");
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (depth + 1 > EXTERNAL_MAX_DEPTH) throw new ExternalSourceError("too-large");
        await visit(join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile() && isMarkdown(entry.name)) {
        if (files.length >= EXTERNAL_MAX_FILES) throw new ExternalSourceError("too-large");
        const absolute = join(dir, entry.name);
        let size: number;
        try {
          size = (await lstat(absolute)).size;
        } catch {
          throw new ExternalSourceError("unreadable");
        }
        if (size > EXTERNAL_MAX_FILE_BYTES) throw new ExternalSourceError("too-large");
        files.push({ absolute, relative: rel });
      }
    }
  };
  await visit(check.real, "", 0);
  return { real: check.real, files };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces every spelling of the source's root (as typed, real, and with the other slash) in file text. */
export function scrubExternalPaths(text: string, roots: readonly string[]): string {
  const spellings = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    spellings.add(root);
    spellings.add(root.replace(/\\/g, "/"));
    spellings.add(root.replace(/\//g, "\\"));
  }
  const ordered = [...spellings].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!ordered.length) return text;
  return text.replace(new RegExp(ordered.map(escapeRegExp).join("|"), "g"), EXTERNAL_PATH_PLACEHOLDER);
}

/** The file calls readExternalFile makes; a test replaces them to play a swap between two of the calls. */
export interface FileIo {
  realpath: typeof realpath;
  lstat: typeof lstat;
  stat: typeof stat;
  open: typeof open;
}
const DEFAULT_FILE_IO: FileIo = { realpath, lstat, stat, open };

/**
 * Reads one listed file without trusting the listing: its real path must still be inside the source, it is opened
 * with O_NOFOLLOW (a link swapped in since the listing is refused), and the same handle is checked (regular file, size)
 * and read, at most 1 MB + 1 byte. Where O_NOFOLLOW does not exist (Windows) an lstat check stands in for it.
 */
export async function readExternalFile(
  absolute: string,
  rootReal: string,
  io: FileIo = DEFAULT_FILE_IO
): Promise<string> {
  let handle;
  try {
    if (!within(await io.realpath(absolute), rootReal)) throw new ExternalSourceError("unreadable");
    const noFollow = constants.O_NOFOLLOW as number | undefined;
    if (noFollow === undefined && !(await io.lstat(absolute)).isFile()) throw new ExternalSourceError("unreadable");
    handle = await io.open(absolute, constants.O_RDONLY | (noFollow ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new ExternalSourceError("unreadable");
    // O_NOFOLLOW only covers the last path part. A parent swapped for a link before or during the open is caught here:
    // the path must still resolve inside the source, and to the very file the handle holds (same device and inode).
    const after = await io.realpath(absolute);
    if (!within(after, rootReal)) throw new ExternalSourceError("unreadable");
    const there = await io.stat(after);
    if (there.dev !== info.dev || there.ino !== info.ino) throw new ExternalSourceError("unreadable");
    if (info.size > EXTERNAL_MAX_FILE_BYTES) throw new ExternalSourceError("too-large");
    const buffer = new Uint8Array(EXTERNAL_MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > EXTERNAL_MAX_FILE_BYTES) throw new ExternalSourceError("too-large");
    return new TextDecoder("utf-8").decode(buffer.subarray(0, length));
  } catch (error) {
    throw error instanceof ExternalSourceError ? error : new ExternalSourceError("unreadable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Status for the panel: how many Markdown files the source holds, or why it cannot be read. */
export async function externalSourceStatus(
  source: ExternalSource,
  scope: ExternalScope,
  signal: AbortSignal
): Promise<{ count: number } | { unreadable: ExternalUnreadableReason }> {
  try {
    return { count: (await listExternalSource(source, scope, signal)).files.length };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw aborted();
    return { unreadable: error instanceof ExternalSourceError ? error.reason : "unreadable" };
  }
}

/**
 * One reference group for an external source. Documents are named `label/relative path` (`external: true`, so the
 * citation is that plain text); text is scrubbed of the root path. Throws ExternalSourceError (no path in it) or an
 * AbortError.
 */
export async function readExternalSource(
  source: ExternalSource,
  scope: ExternalScope,
  signal: AbortSignal,
  mapRoots: readonly string[] = []
): Promise<ReferenceGroup | null> {
  const listing = await listExternalSource(source, scope, signal);
  const roots = [source.path, cleanExternalInput(source.path), listing.real, ...mapRoots];
  const documents: ReferenceDocument[] = [];
  for (const file of listing.files) {
    if (signal.aborted) throw aborted();
    const content = await readExternalFile(file.absolute, listing.real);
    const name = `${source.label}/${file.relative}`;
    documents.push({
      path: name,
      content: scrubExternalPaths(content, roots),
      external: true,
      key: `external:${name}`
    });
  }
  if (signal.aborted) throw aborted();
  if (!documents.length) return null;
  return { id: `external:${source.label}`, name: source.label, location: source.label, documents };
}

/**
 * Every root (as typed and real) of all the external sources of one map. A file of one source may quote another
 * source's path, so each file's text is scrubbed with this whole set.
 */
export async function externalScrubRoots(sources: readonly ExternalSource[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const source of sources) {
    roots.add(source.path);
    const text = cleanExternalInput(source.path);
    if (text) roots.add(text);
    try {
      roots.add(await realpath(text));
    } catch {
      /* a folder that is gone has no other spelling to find */
    }
  }
  return [...roots];
}

/** Root paths of the given sources, as typed and real (best effort, synchronous); for the share leak gate. */
export function externalForbiddenPaths(sources: readonly ExternalSource[]): string[] {
  const paths = new Set<string>();
  for (const source of sources) {
    const text = cleanExternalInput(source.path);
    if (text) paths.add(text);
    try {
      paths.add(realpathSync(text));
    } catch {
      /* a folder that is gone has no other spelling to find */
    }
  }
  return [...paths];
}

export type AddExternalResult =
  | { ok: true; source: ExternalSource; sources: ExternalSource[] }
  | { ok: false; reason: ExternalRejection | "duplicate" };

/** Adds and removals of one map's list run one after another, so none of them writes from an older copy of the list. */
const commitQueues = new WeakMap<object, Map<string, Promise<unknown>>>();
function enqueueCommit<T>(app: object, mapId: string, task: () => Promise<T>): Promise<T> {
  const queues = commitQueues.get(app) ?? new Map<string, Promise<unknown>>();
  commitQueues.set(app, queues);
  const run = (queues.get(mapId) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(mapId, tail);
  void tail.then(() => {
    if (queues.get(mapId) === tail) queues.delete(mapId);
  });
  return run;
}

/**
 * Checks and stores one pasted folder for a map. The check can take a while, so the list is read only when the add
 * commits (inside the queue): the duplicate test, the label (unique among every label the map holds now) and the write
 * all use that fresh list. A source removed meanwhile stays removed; two adds at once both stay.
 */
export async function addExternalSource(
  app: object,
  mapId: string,
  input: string,
  scope: ExternalScope
): Promise<AddExternalResult> {
  const check = await checkExternalRoot(input, scope);
  if (!check.ok) return check;
  const text = cleanExternalInput(input);
  return enqueueCommit(app, mapId, async (): Promise<AddExternalResult> => {
    const existing = loadExternalSources(app, mapId);
    for (const item of existing) {
      let other = item.path;
      try {
        other = await realpath(item.path);
      } catch {
        /* compared as written */
      }
      if (item.path === text || other === check.real) return { ok: false, reason: "duplicate" };
    }
    const name = parse(text).base || parse(check.real).base;
    const label = allocateExternalLabel(name, new Set(existing.map(item => item.label)));
    const source = { path: text, label };
    const sources = [...existing, source];
    saveExternalSources(app, mapId, sources);
    return { ok: true, source, sources };
  });
}

/**
 * Removes the source the caller saw: label and stored path must both match the current list. A label that now belongs
 * to another folder (removed and re-added from another window) is left alone and reported as `removed: false`.
 */
export function removeExternalSource(
  app: object,
  mapId: string,
  expected: ExternalSource
): Promise<{ removed: boolean; sources: ExternalSource[] }> {
  return enqueueCommit(app, mapId, async () => {
    const current = loadExternalSources(app, mapId);
    const sources = current.filter(item => !(item.label === expected.label && item.path === expected.path));
    const removed = sources.length !== current.length;
    if (removed) saveExternalSources(app, mapId, sources);
    return { removed, sources };
  });
}
