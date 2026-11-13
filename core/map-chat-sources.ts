import { referenceBatches, type ReferenceGroup } from "../ai/reference-materials";
import { contentHash } from "./map-chat-context";
import { normalizeVaultPath } from "./map-chat-guard";
import { estimateCondenseCalls, MAX_CONDENSE_CALLS, sourceText } from "./source-gateway";

/**
 * The map's data sources as one chat turn sends them (pure: no Obsidian, no I/O). Read-only, untrusted text for the chat:
 * the documents as they are while they fit {@link MAP_CHAT_SOURCE_CHAR_LIMIT}; above it the condensed findings, condensed once
 * and reused until the sources change. The text sent is never over the limit: a result still over it refuses the turn.
 */
export const MAP_CHAT_SOURCE_CHAR_LIMIT = 60_000;

/** The findings of one condensing, kept for the turns after it: the map, and a hash of everything the sources said. */
export interface MapChatSourceCache {
  mapPath: string;
  hash: string;
  text: string;
}

export interface MapChatSourceMaterial {
  /** The text for the context's `mapSources` ("" = no sources). */
  text: string;
  /** Normalised vault paths of the source files: a reply may never write to one. */
  paths: string[];
  /** The cache to keep for the next turn (the caller stores it only while the map and conversation are still the same). */
  cache: MapChatSourceCache | null;
}

/** Normalised paths of every source document; an external label that cannot name a vault place is left out (it cannot be written anyway). */
export function mapSourcePaths(groups: readonly ReferenceGroup[]): string[] {
  const paths = new Set<string>();
  for (const group of groups)
    for (const document of group.documents) {
      const path = normalizeVaultPath(document.path);
      if (path) paths.add(path);
    }
  return [...paths];
}

export async function mapChatSourceMaterial(input: {
  groups: readonly ReferenceGroup[];
  mapPath: string;
  cache: MapChatSourceCache | null;
  /** Condenses the groups (one extraction run); called only when the sources are over the limit and no cache matches. */
  condense: () => Promise<string>;
  /** Thrown before anything is sent when condensing would pass the call cap or the findings still do not fit. */
  refuse: () => Error;
}): Promise<MapChatSourceMaterial> {
  const { groups } = input;
  if (!groups.some(group => group.documents.length)) return { text: "", paths: [], cache: null };
  const paths = mapSourcePaths(groups);
  const direct = sourceText(groups, referenceBatches([...groups]).join("\n\n"));
  if (direct.length <= MAP_CHAT_SOURCE_CHAR_LIMIT) return { text: direct, paths, cache: null };
  const hash = contentHash(direct);
  const cached = input.cache;
  if (cached && cached.mapPath === input.mapPath && cached.hash === hash)
    return { text: cached.text, paths, cache: cached };
  if (estimateCondenseCalls(groups) > MAX_CONDENSE_CALLS) throw input.refuse();
  const text = sourceText(groups, await input.condense());
  if (text.length > MAP_CHAT_SOURCE_CHAR_LIMIT) throw input.refuse();
  return { text, paths, cache: { mapPath: input.mapPath, hash, text } };
}
