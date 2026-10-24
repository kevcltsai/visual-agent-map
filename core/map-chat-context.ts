import { normalizeVaultPath } from "./map-chat-guard";

/**
 * Builds what the model sees in a map chat turn. Pure: the caller reads the map, the selection and the Markdown text; this
 * only shapes it. Nothing here is cut to the 600-character neighbourhood limit of the selection AI: a snippet, a file and
 * the active file go in whole. Every Markdown file whose full text is sent gets a content hash, the baseline a later
 * `edit_md_file` is checked against.
 */
export const MAP_CHAT_DEFAULT_TURNS = 6;
/** Total characters of card Detail sent in one turn; cards past it go without Detail (and without a Detail baseline). */
export const MAP_CHAT_DETAIL_BUDGET = 60000;
const TITLE_LIMIT = 200;
const SUMMARY_LIMIT = 240;

export interface MapChatOutlineNode {
  id: string;
  title: string;
  summary: string;
  parentId: string | null;
  depth: number;
}
export interface MapChatTopicRef {
  id: string;
  title: string;
  summary: string;
  /** The whole Detail text; sent to the model, and hashed as the baseline `edit_topic_note` is checked against. */
  detail: string;
  path: string;
}
export interface MapChatSnippet {
  path: string;
  text: string;
  /** The path is a best guess (for example the last active note), not a fact. */
  pathGuessed?: boolean;
  /** The whole file text at send time; without it the snippet carries no hash and cannot be edited. */
  fileContent?: string;
}
export interface MapChatFile {
  path: string;
  content: string;
}
export interface MapChatTurn {
  role: "user" | "assistant";
  text: string;
}
export interface MapChatContextInput {
  mapTitle: string;
  outline: MapChatOutlineNode[];
  selected: MapChatTopicRef[];
  references: MapChatTopicRef[];
  snippets: MapChatSnippet[];
  files: MapChatFile[];
  activeFile?: MapChatFile | null;
  history: MapChatTurn[];
  /** Question and answer rounds to keep; default {@link MAP_CHAT_DEFAULT_TURNS}. */
  maxTurns?: number;
  /** Total characters of card Detail to send; default {@link MAP_CHAT_DETAIL_BUDGET}. */
  detailBudget?: number;
}
export interface MapChatContext {
  /** The context as the JSON text put in the prompt. */
  json: string;
  /** Every card id the reply may name. */
  nodeIds: string[];
  /** Parent links of the outline, for the parser's cycle check. */
  parents: Record<string, string | null>;
  /** Normalised path -> content hash of every Markdown file sent whole in this turn. */
  mdHashes: Record<string, string>;
  /** Card id -> what the model saw of that card this turn; the baseline every card action is checked against. */
  topicHashes: Record<string, MapChatTopicHash>;
}
/**
 * What the model was shown of one card. `title` and `parentId` come from the outline, so every card has them. `summary` and
 * `detailHash` exist only for cards sent in full (selected or referenced): the outline clips the summary and has no Detail.
 */
export interface MapChatTopicHash {
  title: string;
  parentId: string | null;
  summary?: string;
  detailHash?: string;
}

/** 53-bit string hash (cyrb53) as hex. Not cryptographic; it only detects that a file changed since it was sent. */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** True when the file now differs from what was sent, or was never sent whole (no baseline = cannot judge, so stale). */
export function isMdStale(hashes: Readonly<Record<string, string>>, path: string, currentContent: string): boolean {
  const key = normalizeVaultPath(path);
  if (key === null || !Object.prototype.hasOwnProperty.call(hashes, key)) return true;
  return hashes[key] !== contentHash(currentContent);
}

const clip = (value: string, limit: number): string => {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
};

export function buildMapChatContext(input: MapChatContextInput): MapChatContext {
  const hashes: Record<string, string> = {};
  const topicHashes: Record<string, MapChatTopicHash> = {};
  const byId = new Map(input.outline.map(node => [node.id, node]));
  const ids = new Set<string>(byId.keys());
  const children = new Map<string, string[]>();
  for (const node of input.outline)
    if (node.parentId !== null) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  const brief = (id: string): { id: string; title: string } | null => {
    const node = byId.get(id);
    return node ? { id: node.id, title: clip(node.title, TITLE_LIMIT) } : null;
  };
  let detailLeft = input.detailBudget ?? MAP_CHAT_DETAIL_BUDGET;
  const topic = (ref: MapChatTopicRef, withLinks: boolean): Record<string, unknown> => {
    ids.add(ref.id);
    const node = byId.get(ref.id);
    const withDetail = ref.detail.length <= detailLeft;
    if (withDetail) detailLeft -= ref.detail.length;
    topicHashes[ref.id] = {
      title: ref.title,
      parentId: node?.parentId ?? null,
      summary: ref.summary,
      ...(withDetail ? { detailHash: contentHash(ref.detail) } : {})
    };
    return {
      id: ref.id,
      title: ref.title,
      summary: ref.summary,
      ...(withDetail ? { detail: ref.detail } : { detailOmitted: true }),
      path: ref.path,
      ...(withLinks
        ? {
            parent: node?.parentId ? brief(node.parentId) : null,
            children: (children.get(ref.id) ?? []).map(brief).filter(Boolean)
          }
        : {})
    };
  };
  for (const node of input.outline) topicHashes[node.id] = { title: node.title, parentId: node.parentId };
  const record = (path: string, content: string): string | null => {
    const key = normalizeVaultPath(path);
    if (key === null) return null;
    hashes[key] = contentHash(content);
    return key;
  };
  const files = input.files.map(file => {
    const key = record(file.path, file.content);
    return { path: file.path, contentHash: key === null ? null : hashes[key], content: file.content };
  });
  const active = input.activeFile
    ? (() => {
        const key = normalizeVaultPath(input.activeFile.path);
        const duplicate = key !== null && input.files.some(file => normalizeVaultPath(file.path) === key);
        if (!duplicate) record(input.activeFile.path, input.activeFile.content);
        return duplicate
          ? { path: input.activeFile.path, sameAsListedFile: true }
          : {
              path: input.activeFile.path,
              contentHash: key === null ? null : hashes[key],
              content: input.activeFile.content
            };
      })()
    : null;
  const snippets = input.snippets.map(snippet => {
    const key = snippet.fileContent === undefined ? null : record(snippet.path, snippet.fileContent);
    return {
      path: snippet.path,
      ...(snippet.pathGuessed ? { pathGuessed: true } : {}),
      contentHash: key === null ? null : hashes[key],
      text: snippet.text
    };
  });
  const turns = Math.max(0, input.maxTurns ?? MAP_CHAT_DEFAULT_TURNS) * 2;
  const history = turns ? input.history.slice(-turns) : [];
  const json = JSON.stringify({
    mapTitle: input.mapTitle,
    outline: input.outline.map(node => ({
      id: node.id,
      title: clip(node.title, TITLE_LIMIT),
      summary: clip(node.summary, SUMMARY_LIMIT),
      parentId: node.parentId,
      depth: node.depth
    })),
    selected: input.selected.map(ref => topic(ref, true)),
    references: input.references.map(ref => topic(ref, false)),
    snippets,
    files,
    activeFile: active,
    earlierTurns: history.map(turn => ({ role: turn.role, text: turn.text }))
  });
  return {
    json,
    nodeIds: [...ids],
    parents: Object.fromEntries(input.outline.map(node => [node.id, node.parentId])),
    mdHashes: hashes,
    topicHashes
  };
}
