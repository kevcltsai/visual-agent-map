import type { MapNode } from "../map-model";

/**
 * Scratch state shared by the `readNote` calls of ONE hydrate. Each file is read once, and each ancestor's frontmatter
 * is parsed once, however many notes inherit from it. It lives for one hydrate only (no global cache), so a later
 * hydrate always sees the disk again. It does not depend on the view.
 */
export interface NoteReadContext {
  /** The map's nodes by id, so walking up the parents is a lookup instead of a scan. */
  nodesById: Map<string, MapNode>;
  /** The first node at each path, matching Array.find when a path occurs more than once. */
  nodesByPath: Map<string, MapNode>;
  /** Parsed frontmatter of an ancestor note by path; `null` when the note does not exist (a missing ancestor is skipped). */
  ancestorFm: Map<string, Promise<Record<string, unknown> | null>>;
  /** Content reads by path, shared by the note's own read and by ancestor lookups. */
  reads: Map<string, Promise<string>>;
  /** Paths of notes or ancestors that exist but whose read threw. A missing file is not listed. */
  failedPaths: Set<string>;
  /** The map this context was built for; a different map falls back to scanning. */
  map?: { nodes: MapNode[] };
}

export function createNoteReadContext(map?: { nodes: MapNode[] }): NoteReadContext {
  const nodesByPath = new Map<string, MapNode>();
  for (const node of map?.nodes ?? []) if (!nodesByPath.has(node.path)) nodesByPath.set(node.path, node);
  return {
    nodesById: new Map((map?.nodes ?? []).map(node => [node.id, node])),
    nodesByPath,
    ancestorFm: new Map(),
    reads: new Map(),
    failedPaths: new Set(),
    map
  };
}

/** Read `path` once per context; a throw is remembered in `failedPaths` and rethrown to every caller. */
export function readOnce(ctx: NoteReadContext, path: string, read: () => Promise<string>): Promise<string> {
  let pending = ctx.reads.get(path);
  if (!pending) {
    pending = read().catch(error => {
      ctx.failedPaths.add(path);
      throw error;
    });
    ctx.reads.set(path, pending);
  }
  return pending;
}
