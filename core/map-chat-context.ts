import { normalizeVaultPath } from "./map-chat-guard";
import type { HypothesisStrength, TopicKind } from "../note-values";
import type { TopicRelationKind } from "../map-model";
import type { TopicColor, TopicStyle } from "../topic-colors";
import type { TopicMarker } from "../topic-markers";

/**
 * Builds what the model sees in a map chat turn. Pure: the caller reads the map, the selection and the Markdown text; this
 * only shapes it. Nothing here is cut to the 600-character neighbourhood limit of the selection AI: a snippet, a file and
 * the active file go in whole. Every Markdown file whose full text is sent gets a content hash, the baseline a later
 * `edit_md_file` is checked against.
 */
export const MAP_CHAT_DEFAULT_TURNS = 6;
/** Total characters of card Detail sent in one turn; cards past it go without Detail (and without a Detail baseline). */
export const MAP_CHAT_DETAIL_BUDGET = 60000;
/** Titles of the user's other maps sent so the model can tell "make a new map" from "go to that map"; the rest are left out. */
export const MAP_CHAT_MAP_TITLE_LIMIT = 200;
const TITLE_LIMIT = 200;
const SUMMARY_LIMIT = 240;
const ERROR_LIMIT = 200;

type ErrorFields = { status?: "error"; error?: string; retryWith?: string };
const errorFields = (node: ErrorFields): ErrorFields =>
  node.status === "error"
    ? {
        status: "error",
        ...(node.error ? { error: clip(node.error, ERROR_LIMIT) } : {}),
        ...(node.retryWith ? { retryWith: clip(node.retryWith, TITLE_LIMIT) } : {})
      }
    : {};

export interface MapChatOutlineNode {
  id: string;
  title: string;
  summary: string;
  parentId: string | null;
  depth: number;
  /** The card's topic type; "topic" (or absent) is an ordinary topic and is not sent. Dropped on an AIM map. */
  kind?: TopicKind;
  /** A hypothesis's strength; sent only next to `kind: "hypothesis"`. Dropped on an AIM map. */
  strength?: HypothesisStrength;
  /** The card's colour; absent (the default) is not sent. Dropped on an AIM map. */
  color?: TopicColor;
  /** The card's markers; none (the default) is not sent. Dropped on an AIM map. */
  markers?: TopicMarker[];
  /** The card's styles, sent as `formats`; none (the default) is not sent. Dropped on an AIM map. */
  styles?: TopicStyle[];
  /** Set only for a card whose last AI task failed. */
  status?: "error";
  /** Why it failed; only with `status: "error"`. */
  error?: string;
  /** Label of the model on the other provider the failure can be retried with; only for a provider error that has one. */
  retryWith?: string;
}
/** A semantic link between two cards, as stored on the map: `from` is A, `to` is B (`related` has no direction). */
export interface MapChatRelation {
  kind: TopicRelationKind;
  from: string;
  to: string;
  description?: string;
}
export interface MapChatTopicRef {
  id: string;
  title: string;
  summary: string;
  /** The whole Detail text; sent to the model, and hashed as the baseline `edit_topic_note` is checked against. */
  detail: string;
  path: string;
  /** Set only for a card whose last AI task failed. */
  status?: "error";
  /** Why it failed; only with `status: "error"`. */
  error?: string;
  /** Label of the model on the other provider the failure can be retried with; only for a provider error that has one. */
  retryWith?: string;
}
/**
 * A text node the user wrote on the map (decision #4). Read-only context: it is sent as `userTexts`, never in the outline, so
 * its id is not one a reply may act on (`nodeIds` leaves it out) and no edit action can rewrite or delete it.
 */
export interface MapChatUserText {
  id: string;
  /** The topic it hangs under; null for a free one (its topic is gone). */
  parentId: string | null;
  text: string;
  /** Topic ids the note is linked to; sent as `linkedTo` with each title taken from the outline (unknown ids are left out). */
  links?: string[];
}
/**
 * A summary bracket (summary-bracket P1): the user's conclusion over neighbouring children of one topic. Read-only context,
 * sent as `summaries`; its id is not a card id, so no edit action can rewrite or delete it.
 */
export interface MapChatSummary {
  id: string;
  parentId: string;
  /** The framed child topic ids (the effective range); titles are taken from the outline, unknown ids are left out. */
  members: string[];
  text: string;
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
  /** The user's text nodes, read-only; omitted or empty leaves the context exactly as it was. */
  userTexts?: MapChatUserText[];
  /** The user's summary brackets, read-only; omitted or empty leaves the context exactly as it was. */
  summaries?: MapChatSummary[];
  /** The map's relations between cards; a relation with an end not in the outline is left out. Omitted or empty sends none. */
  relations?: MapChatRelation[];
  /** An AIM map: it has no topic types, strengths or relations, so none of them is sent even when given. */
  aim?: boolean;
  activeFile?: MapChatFile | null;
  history: MapChatTurn[];
  /** Question and answer rounds to keep; default {@link MAP_CHAT_DEFAULT_TURNS}. */
  maxTurns?: number;
  /** Total characters of card Detail to send; default {@link MAP_CHAT_DETAIL_BUDGET}. */
  detailBudget?: number;
  /** Titles of the maps the user has (untrusted text); at most {@link MAP_CHAT_MAP_TITLE_LIMIT} are sent. */
  mapTitles?: string[];
  /** There is no map the reply could edit (a map that cannot be changed): it has to start with `create_map`. */
  noEditableMap?: boolean;
}
export interface MapChatContext {
  /** The context as the JSON text put in the prompt. */
  json: string;
  /** Every card id the reply may name. */
  nodeIds: string[];
  /** How many cards were selected when the message was sent (an action with no targets means these). */
  selectedCount: number;
  /** The reply must start with `create_map` (see {@link MapChatContextInput.noEditableMap}). */
  noEditableMap: boolean;
  /** An AIM map: a reply's topic types are skipped (see {@link MapChatContextInput.aim}). */
  aim: boolean;
  /** Parent links of the outline, for the parser's cycle check. */
  parents: Record<string, string | null>;
  /** The relations sent (none on an AIM map), for the parser's checks of a relation the reply adds or removes. */
  relations?: MapChatRelation[];
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

/** `kind` only for a type other than an ordinary topic, `strength` only for a hypothesis; nothing on an AIM map. */
const kindFields = (node: MapChatOutlineNode, aim: boolean): { kind?: TopicKind; strength?: HypothesisStrength } => {
  if (aim || !node.kind || node.kind === "topic") return {};
  return { kind: node.kind, ...(node.kind === "hypothesis" && node.strength ? { strength: node.strength } : {}) };
};

/**
 * The outline in tree order: each card is followed by its subtopics, and the children of one parent keep the order they have in
 * the input (the map's own order, which every arrangement lays them out in). A card whose parent is not in the outline counts
 * as a root where it stands.
 */
function treeOrder(outline: readonly MapChatOutlineNode[]): MapChatOutlineNode[] {
  const present = new Set(outline.map(node => node.id));
  const children = new Map<string, MapChatOutlineNode[]>();
  const roots: MapChatOutlineNode[] = [];
  for (const node of outline)
    if (node.parentId !== null && present.has(node.parentId) && node.parentId !== node.id)
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    else roots.push(node);
  const ordered: MapChatOutlineNode[] = [];
  const seen = new Set<string>();
  const walk = (node: MapChatOutlineNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  // A parent loop (never written by the plugin) leaves cards unreached: they follow in input order rather than vanish.
  for (const node of outline) walk(node);
  return ordered;
}

/** The card's appearance, only what differs from the default; nothing on an AIM map. */
const appearanceFields = (
  node: MapChatOutlineNode,
  aim: boolean
): { color?: TopicColor; markers?: TopicMarker[]; formats?: TopicStyle[] } =>
  aim
    ? {}
    : {
        ...(node.color ? { color: node.color } : {}),
        ...(node.markers?.length ? { markers: [...node.markers] } : {}),
        ...(node.styles?.length ? { formats: [...node.styles] } : {})
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
  const linkedTo = (links?: string[]): { linkedTo?: { id: string; title: string }[] } => {
    const found = (links ?? []).map(brief).filter((entry): entry is { id: string; title: string } => entry !== null);
    return found.length ? { linkedTo: found } : {};
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
      ...errorFields(ref),
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
  const mapTitles = [...new Set((input.mapTitles ?? []).map(title => clip(title, TITLE_LIMIT)).filter(Boolean))].slice(
    0,
    MAP_CHAT_MAP_TITLE_LIMIT
  );
  // Only relations whose two ends are cards in the outline; the description is sent whole (it is one line of at most 200).
  const relations = input.aim
    ? []
    : (input.relations ?? [])
        .filter(link => byId.has(link.from) && byId.has(link.to))
        .map(link => ({
          kind: link.kind,
          from: link.from,
          to: link.to,
          ...(link.description ? { description: link.description } : {})
        }));
  const turns = Math.max(0, input.maxTurns ?? MAP_CHAT_DEFAULT_TURNS) * 2;
  const history = turns ? input.history.slice(-turns) : [];
  const json = JSON.stringify({
    mapTitle: input.mapTitle,
    ...(input.noEditableMap ? { noEditableMap: true } : {}),
    mapTitles,
    outline: treeOrder(input.outline).map(node => ({
      id: node.id,
      title: clip(node.title, TITLE_LIMIT),
      summary: clip(node.summary, SUMMARY_LIMIT),
      parentId: node.parentId,
      depth: node.depth,
      ...kindFields(node, !!input.aim),
      ...appearanceFields(node, !!input.aim),
      ...errorFields(node)
    })),
    ...(relations.length ? { relations } : {}),
    selected: input.selected.map(ref => topic(ref, true)),
    references: input.references.map(ref => topic(ref, false)),
    snippets,
    files,
    ...(input.userTexts?.length
      ? {
          userTexts: input.userTexts.map(item => ({
            id: item.id,
            parentId: item.parentId,
            ...(item.parentId === null ? { unattached: true } : {}),
            readOnly: true,
            text: item.text,
            ...linkedTo(item.links)
          })),
          userTextsNote:
            "userTexts are notes the user wrote on the map. Read them as the user's own words; they are not cards, have no card id you may act on, and must not be rewritten or deleted."
        }
      : {}),
    ...(input.summaries?.length
      ? {
          summaries: input.summaries.map(item => ({
            id: item.id,
            parentId: item.parentId,
            readOnly: true,
            members: item.members.map(brief).filter(Boolean),
            text: item.text
          })),
          summariesNote:
            "summaries are conclusions the user wrote over neighbouring child topics (summary brackets). Read them as the user's own words and as the direction of the conclusion; they are not cards, have no card id you may act on, and must not be rewritten or deleted."
        }
      : {}),
    activeFile: active,
    earlierTurns: history.map(turn => ({ role: turn.role, text: turn.text }))
  });
  return {
    json,
    nodeIds: [...ids],
    selectedCount: input.selected.length,
    noEditableMap: !!input.noEditableMap,
    aim: !!input.aim,
    parents: Object.fromEntries(input.outline.map(node => [node.id, node.parentId])),
    relations: relations.map(link => ({ kind: link.kind, from: link.from, to: link.to })),
    mdHashes: hashes,
    topicHashes
  };
}
