import { TFile, TFolder, parseYaml, type App } from "obsidian";
import {
  dedupeReferenceGroups,
  readMarkdownFile,
  type ReferenceDocument,
  type ReferenceGroup
} from "../../ai/reference-materials";
import type { MapDocument } from "../../map-model";

/**
 * The data sources of one mind map, kept in its `Map.md` frontmatter key `map-sources` as an ordered list of
 * `"<kind>:<vault-relative path>"` strings. Research, expand and synthesize runs started on that map read them.
 */
export type MapSourceKind = "map" | "folder" | "file";
export interface MapSource {
  kind: MapSourceKind;
  path: string;
}

export const MAP_SOURCES_KEY = "map-sources";
const KINDS: readonly MapSourceKind[] = ["map", "folder", "file"];

/** A vault-relative path: not empty, not absolute (POSIX, Windows drive, UNC), no `..` segment. */
function validVaultPath(path: string): boolean {
  if (!path.trim() || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).includes("..");
}

export function sameMapSource(a: MapSource, b: MapSource): boolean {
  return a.kind === b.kind && a.path === b.path;
}

/**
 * Reads `map-sources` from a map file's frontmatter. Tolerant: a missing key, a non-list, or non-string, unknown,
 * empty, absolute, `..` and duplicate entries give `[]` or the valid subset in order. Never throws; the caller never
 * rewrites what it dropped.
 */
export function readMapSources(fm: Record<string, unknown> | undefined): MapSource[] {
  const raw = fm?.[MAP_SOURCES_KEY];
  if (!Array.isArray(raw)) return [];
  const result: MapSource[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const colon = item.indexOf(":");
    if (colon < 0) continue;
    const kind = item.slice(0, colon) as MapSourceKind;
    const path = item.slice(colon + 1);
    if (!KINDS.includes(kind) || !validVaultPath(path)) continue;
    const source = { kind, path };
    if (!result.some(existing => sameMapSource(existing, source))) result.push(source);
  }
  return result;
}

/** The frontmatter value for a list: strings in order; invalid entries and duplicates are not written. */
export function serializeMapSources(sources: readonly MapSource[]): string[] {
  const clean: MapSource[] = [];
  for (const source of sources)
    if (KINDS.includes(source.kind) && validVaultPath(source.path) && !clean.some(item => sameMapSource(item, source)))
      clean.push(source);
  return clean.map(source => `${source.kind}:${source.path}`);
}

/**
 * True for a VAM-managed note (`agent-map-node`) that is archived: `topic-state: archived`, or no `topic-state` and the
 * note sits directly in a folder named `Archive`. Ordinary notes (also in an `Archive` folder) are never archived.
 */
export function isArchivedVamNote(path: string, fm: Record<string, unknown> | null | undefined): boolean {
  if (!fm || typeof fm !== "object") return false;
  const managed = fm["agent-map-node"] === true || fm["agent-map-node"] === "true";
  if (!managed) return false;
  return (
    fm["topic-state"] === "archived" ||
    (fm["topic-state"] === undefined && path.replace(/\\/g, "/").split("/").at(-2) === "Archive")
  );
}

/** Frontmatter of note text; a block that does not parse throws only when it names `agent-map-node`. */
function contentFrontmatter(content: string): Record<string, unknown> | undefined {
  const yaml = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!yaml) return undefined;
  try {
    const parsed: unknown = parseYaml(yaml);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch (error) {
    if (yaml.includes("agent-map-node")) throw error;
    return undefined;
  }
}

export interface MapSourceDeps {
  app: App;
  /** Reads and parses a map file; throws when it cannot. */
  readMap(path: string): Promise<MapDocument>;
}

const aborted = (): Error => Object.assign(new Error("Aborted"), { name: "AbortError" });

function markdownFiles(folder: TFolder): TFile[] {
  const found: TFile[] = [];
  const visit = (item: TFolder): void => {
    for (const child of item.children) {
      if (child instanceof TFolder) visit(child);
      else if (child instanceof TFile && child.extension.toLowerCase() === "md") found.push(child);
    }
  };
  visit(folder);
  return found;
}

const asDocument = (document: ReferenceDocument): ReferenceDocument => ({
  path: document.path,
  content: document.content,
  external: false,
  key: document.path
});

async function readFiles(
  app: App,
  files: TFile[],
  signal: AbortSignal,
  skipArchived: boolean
): Promise<ReferenceDocument[]> {
  const documents: ReferenceDocument[] = [];
  for (let index = 0; index < files.length; index += 20) {
    if (signal.aborted) throw aborted();
    const batch = await Promise.all(
      files.slice(index, index + 20).map(async file => {
        try {
          return await readMarkdownFile(app, file);
        } catch {
          return undefined; // a note inside an existing folder or map that cannot be read is skipped quietly
        }
      })
    );
    for (const document of batch) {
      if (!document) continue;
      if (skipArchived && isArchivedVamNote(document.path, contentFrontmatter(document.content))) continue;
      documents.push(asDocument(document));
    }
  }
  if (signal.aborted) throw aborted();
  return documents;
}

const baseName = (path: string): string => path.split("/").at(-1) || path;

/**
 * Turns a map's saved sources into the reference groups a task starts with (same shape the old picker produced:
 * group id `map:<id>`, `folder:<path>`, `files:<path>`; documents vault-relative with `external: false`). A `map:`
 * entry equal to the current map is dropped. An entry whose path is missing or cannot be read is skipped and listed in
 * `unreadable`; missing or unreadable notes inside an existing folder or map are skipped quietly. Rejects with an
 * AbortError when the signal aborts, so the caller sends no request.
 */
export async function resolveMapSources(
  deps: MapSourceDeps,
  sources: readonly MapSource[],
  currentMapPath: string,
  signal: AbortSignal
): Promise<{ groups: ReferenceGroup[]; unreadable: MapSource[] }> {
  const groups: ReferenceGroup[] = [];
  const unreadable: MapSource[] = [];
  for (const source of sources) {
    if (signal.aborted) throw aborted();
    if (source.kind === "map" && source.path === currentMapPath) continue;
    try {
      const item = deps.app.vault.getAbstractFileByPath(source.path);
      if (source.kind === "folder") {
        if (!(item instanceof TFolder)) throw new Error("missing folder");
        const documents = await readFiles(deps.app, markdownFiles(item), signal, true);
        if (documents.length)
          groups.push({
            id: `folder:${source.path}`,
            name: item.name || baseName(source.path),
            location: source.path,
            documents
          });
      } else if (source.kind === "file") {
        if (!(item instanceof TFile) || item.extension.toLowerCase() !== "md") throw new Error("missing file");
        groups.push({
          id: `files:${source.path}`,
          name: baseName(source.path),
          location: source.path,
          documents: [asDocument(await readMarkdownFile(deps.app, item))]
        });
      } else {
        if (!(item instanceof TFile)) throw new Error("missing map");
        const map = await deps.readMap(source.path);
        const files = map.nodes
          .map(node => deps.app.vault.getAbstractFileByPath(node.path))
          .filter((file): file is TFile => file instanceof TFile && file.extension.toLowerCase() === "md");
        const documents = await readFiles(deps.app, files, signal, false);
        if (documents.length) groups.push({ id: `map:${map.id}`, name: map.title, location: source.path, documents });
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw aborted();
      unreadable.push(source);
    }
  }
  return { groups: dedupeReferenceGroups(groups), unreadable };
}

/**
 * What the panel shows for one source: whether its path exists and, for a folder, how many Markdown notes it holds
 * (archived VAM notes excluded, using the metadata cache).
 */
export function mapSourceStatus(app: App, source: MapSource): { exists: boolean; count?: number } {
  const item = app.vault.getAbstractFileByPath(source.path);
  if (source.kind === "folder") {
    if (!(item instanceof TFolder)) return { exists: false };
    const count = markdownFiles(item).filter(
      file => !isArchivedVamNote(file.path, app.metadataCache.getFileCache(file)?.frontmatter)
    ).length;
    return { exists: true, count };
  }
  return { exists: item instanceof TFile };
}
