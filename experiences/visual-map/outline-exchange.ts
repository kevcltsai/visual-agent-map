import { titleProblem } from "../../core/title-safety";
import { OUTLINE_TITLE_LIMIT, type OutlineNode } from "./outline-import";

/**
 * Pure conversion between a map and two outline interchange formats: OPML 2.0 and FreeMind 1.0.1 (.mm). A file is
 * untrusted input, so it is read by a small tokenizer written here (elements, attributes and text only): a DOCTYPE,
 * an entity declaration or a processing instruction is refused outright, so no entity can expand and nothing is
 * fetched. Every limit refuses the whole file with a reason; nothing is truncated. Never throws.
 */
export const EXCHANGE_MAX_BYTES = 5 * 1024 * 1024;
export const EXCHANGE_MAX_NODES = 500;
export const EXCHANGE_MAX_DEPTH = 64;
export const EXCHANGE_MAX_BODY = 200_000;
/** Elements of any kind, so unrelated markup cannot be used to build a huge tree inside the size limit. */
const MAX_ELEMENTS = 50_000;
/** Element nesting of any kind (richcontent HTML included); tree walks stay far from the stack limit. */
const MAX_XML_DEPTH = 200;
const MAX_ATTRIBUTES = 100;
const FALLBACK_ROOT_TITLE = "Imported outline";

export type ExchangeRejection =
  | "not-text"
  | "too-large"
  | "too-many-elements"
  | "bad-xml"
  | "forbidden-doctype"
  | "forbidden-pi"
  | "bad-entity"
  | "control-char"
  | "not-outline"
  | "empty"
  | "too-many-nodes"
  | "too-deep"
  | "empty-title"
  | "title-too-long"
  | "title-fence"
  | "title-brackets"
  | "bad-title"
  | "body-too-long"
  | "bad-body";

/** An outline node plus the note text that came with it (`_note`, or a FreeMind note). */
export interface ExchangeNode extends OutlineNode {
  body: string;
}
export type ExchangeFormat = "opml" | "freemind";
export type ExchangeParse =
  | { ok: true; format: ExchangeFormat; nodes: ExchangeNode[]; synthesizedRoot: boolean }
  | { ok: false; reason: ExchangeRejection; line?: number };

class ExchangeReject extends Error {
  constructor(
    readonly reason: ExchangeRejection,
    readonly line?: number
  ) {
    super(reason);
  }
}

interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  children: (XmlElement | string)[];
  line: number;
}

// C0 other than tab, LF and CR, plus the two non-characters XML forbids.
// eslint-disable-next-line no-control-regex -- the control characters are exactly what is being refused
const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;
// eslint-disable-next-line no-control-regex -- the control characters are exactly what is being refused
const TITLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/;
const ENTITY = /&(?:#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6}|amp|lt|gt|quot|apos);/g;
const ENTITY_PARTS = /&(?:#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const NAME = /[\p{L}_:][\p{L}\p{N}_:.-]*/uy;
const XML_SPACE = /[ \t\r\n]/;

/** UTF-8 length of a string without allocating it; each half of a surrogate pair counts 2. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
  }
  return bytes;
}

const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/** Resolves the five predefined entities and numeric references; any other `&` is refused. */
function decodeEntities(raw: string, line: number): string {
  if (!raw.includes("&")) return raw;
  if (raw.replace(ENTITY, "").includes("&")) throw new ExchangeReject("bad-entity", line);
  return raw.replace(
    ENTITY_PARTS,
    (_m, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named !== undefined) return NAMED[named];
      const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
      if (!isXmlChar(code)) throw new ExchangeReject("bad-entity", line);
      return String.fromCodePoint(code);
    }
  );
}

function tokenize(source: string): XmlElement {
  const length = source.length;
  let pos = 0;
  let lineAt = 0;
  let line = 1;
  // Positions are always asked in increasing order, so lines are counted once, incrementally.
  const lineOf = (position: number): number => {
    while (lineAt < position && lineAt < length) if (source.charCodeAt(lineAt++) === 10) line++;
    return line;
  };
  const fail = (reason: ExchangeRejection, at = pos): never => {
    throw new ExchangeReject(reason, lineOf(at));
  };
  const skipSpace = (): void => {
    while (pos < length && XML_SPACE.test(source[pos])) pos++;
  };
  const readName = (): string => {
    NAME.lastIndex = pos;
    const match = NAME.exec(source);
    if (!match) return fail("bad-xml");
    pos += match[0].length;
    return match[0];
  };

  skipSpace();
  if (source.startsWith("<?xml", pos) && XML_SPACE.test(source[pos + 5] ?? "")) {
    const end = source.indexOf("?>", pos);
    if (end < 0) fail("bad-xml");
    pos = end + 2;
  }

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let total = 0;
  while (pos < length) {
    const lt = source.indexOf("<", pos);
    const textEnd = lt < 0 ? length : lt;
    if (textEnd > pos) {
      const raw = source.slice(pos, textEnd);
      if (stack.length === 0) {
        if (/[^ \t\r\n]/.test(raw)) fail("bad-xml");
      } else {
        if (raw.includes("]]>")) fail("bad-xml");
        stack[stack.length - 1].children.push(decodeEntities(raw, lineOf(pos)));
      }
      pos = textEnd;
    }
    if (lt < 0) break;
    if (source.startsWith("<!--", pos)) {
      const end = source.indexOf("-->", pos + 4);
      if (end < 0) fail("bad-xml");
      pos = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", pos)) {
      if (stack.length === 0) fail("bad-xml");
      const end = source.indexOf("]]>", pos + 9);
      if (end < 0) fail("bad-xml");
      stack[stack.length - 1].children.push(source.slice(pos + 9, end));
      pos = end + 3;
      continue;
    }
    if (source.startsWith("<!", pos)) fail("forbidden-doctype");
    if (source.startsWith("<?", pos)) fail("forbidden-pi");
    if (source.startsWith("</", pos)) {
      const at = pos;
      pos += 2;
      const name = readName();
      skipSpace();
      if (source[pos] !== ">") fail("bad-xml");
      pos++;
      const open = stack.pop();
      if (!open || open.name !== name) fail("bad-xml", at);
      continue;
    }
    const start = pos;
    pos++;
    const element: XmlElement = { name: readName(), attrs: new Map(), children: [], line: lineOf(start) };
    let selfClosing = false;
    for (;;) {
      const before = pos;
      skipSpace();
      if (pos >= length) fail("bad-xml");
      if (source[pos] === ">") {
        pos++;
        break;
      }
      if (source.startsWith("/>", pos)) {
        pos += 2;
        selfClosing = true;
        break;
      }
      // Attributes need a space before them: `<a b="1"c="2">` is not well formed.
      if (pos === before) fail("bad-xml");
      const name = readName();
      skipSpace();
      if (source[pos] !== "=") fail("bad-xml");
      pos++;
      skipSpace();
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") fail("bad-xml");
      const close = source.indexOf(quote, pos + 1);
      if (close < 0) fail("bad-xml");
      const raw = source.slice(pos + 1, close);
      if (raw.includes("<")) fail("bad-xml");
      if (element.attrs.has(name) || element.attrs.size >= MAX_ATTRIBUTES) fail("bad-xml");
      element.attrs.set(name, decodeEntities(raw.replace(/[\t\r\n]/g, " "), lineOf(pos)));
      pos = close + 1;
    }
    if (++total > MAX_ELEMENTS) fail("too-many-elements", start);
    if (stack.length === 0) {
      if (root) fail("bad-xml", start);
      root = element;
    } else stack[stack.length - 1].children.push(element);
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_XML_DEPTH) fail("too-deep", start);
    }
  }
  if (stack.length || !root) fail("bad-xml", length);
  return root as XmlElement;
}

const elementsOf = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter((child): child is XmlElement => typeof child !== "string" && child.name === name);

const BLOCK_TAGS = new Set([
  "p",
  "li",
  "ul",
  "ol",
  "div",
  "tr",
  "table",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
]);
const SKIPPED_TAGS = new Set(["script", "style", "head"]);

/** The text of an embedded HTML fragment: tags and attributes are gone; paragraphs, line breaks and list items become newlines. */
function richText(element: XmlElement): string {
  let out = "";
  const newline = (): void => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const walk = (current: XmlElement): void => {
    const name = current.name.toLowerCase();
    if (SKIPPED_TAGS.has(name)) return;
    if (name === "br") {
      out += "\n";
      return;
    }
    const block = BLOCK_TAGS.has(name);
    if (block) newline();
    for (const child of current.children) {
      if (typeof child !== "string") {
        walk(child);
        continue;
      }
      let piece = child.replace(/\s+/g, " ");
      if (!out || out.endsWith("\n") || out.endsWith(" ")) piece = piece.trimStart();
      out += piece;
    }
    if (block) newline();
  };
  walk(element);
  return out
    .split("\n")
    .map(part => part.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanTitle(raw: string, line: number): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) throw new ExchangeReject("empty-title", line);
  if (TITLE_FORBIDDEN.test(title)) throw new ExchangeReject("bad-title", line);
  if ([...title].length > OUTLINE_TITLE_LIMIT) throw new ExchangeReject("title-too-long", line);
  const problem = titleProblem(title);
  if (problem) throw new ExchangeReject(`title-${problem}`, line);
  return title;
}

function cleanBody(raw: string, line: number): string {
  const body = raw.replace(/\r\n?/g, "\n");
  if (!body.trim()) return "";
  if (body.length > EXCHANGE_MAX_BODY) throw new ExchangeReject("body-too-long", line);
  if (body.includes("<!-- visual-agent-map:") || /^\uFEFF?---[ \t]*(?:\n|$)/.test(body))
    throw new ExchangeReject("bad-body", line);
  return body;
}

interface NodeRead {
  title: string;
  body: string;
  kids: XmlElement[];
}
const readOpml = (element: XmlElement): NodeRead => ({
  title: element.attrs.get("text") ?? element.attrs.get("title") ?? "",
  body: element.attrs.get("_note") ?? "",
  kids: elementsOf(element, "outline")
});
const readFreeMind = (element: XmlElement): NodeRead => {
  const rich = (type: string): XmlElement | undefined =>
    elementsOf(element, "richcontent").find(child => child.attrs.get("TYPE") === type);
  const text = element.attrs.get("TEXT");
  const nodeRich = rich("NODE");
  const noteRich = rich("NOTE");
  return {
    title: text !== undefined && text.trim() ? text : nodeRich ? richText(nodeRich) : (text ?? ""),
    body: noteRich ? richText(noteRich) : "",
    kids: elementsOf(element, "node")
  };
};

function stemOf(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const leaf = fileName.split(/[\\/]/).pop() ?? "";
  const stem = leaf.replace(/\.(?:opml|mm|xml)$/i, "");
  try {
    return cleanTitle(stem, 0);
  } catch {
    return undefined;
  }
}

/**
 * Reads an OPML 2.0 or FreeMind file. OPML: `body>outline[text]` with `_note` as the note text. FreeMind:
 * `node[TEXT]` (or an HTML node body) with the NOTE richcontent as the note text. Every other element is dropped.
 * Several top-level nodes get one synthesized root, titled from the OPML `head>title`, else the file name.
 */
export function parseOutlineExchange(input: string, options: { fileName?: string } = {}): ExchangeParse {
  try {
    if (typeof input !== "string") return { ok: false, reason: "not-text" };
    // Size first, before any scan of the content.
    if (input.length > EXCHANGE_MAX_BYTES || utf8Length(input) > EXCHANGE_MAX_BYTES)
      return { ok: false, reason: "too-large" };
    const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    if (RAW_CONTROL.test(source)) return { ok: false, reason: "control-char" };
    const root = tokenize(source);
    let format: ExchangeFormat;
    let tops: XmlElement[];
    let read: (element: XmlElement) => NodeRead;
    let rootTitle: string | undefined;
    if (root.name === "opml") {
      format = "opml";
      const body = elementsOf(root, "body")[0];
      tops = body ? elementsOf(body, "outline") : [];
      read = readOpml;
      const head = elementsOf(root, "head")[0];
      const headTitle = head ? elementsOf(head, "title")[0] : undefined;
      const titleText = headTitle?.children.filter((child): child is string => typeof child === "string").join("");
      if (titleText?.trim()) {
        try {
          rootTitle = cleanTitle(titleText, headTitle?.line ?? 0);
        } catch {
          rootTitle = undefined;
        }
      }
    } else if (root.name === "map") {
      format = "freemind";
      tops = elementsOf(root, "node");
      read = readFreeMind;
    } else return { ok: false, reason: "not-outline", line: root.line };
    if (!tops.length) return { ok: false, reason: "empty" };

    const synthesized = tops.length > 1;
    const offset = synthesized ? 1 : 0;
    const nodes: ExchangeNode[] = [];
    if (synthesized)
      nodes.push({
        index: 0,
        title: rootTitle ?? stemOf(options.fileName) ?? FALLBACK_ROOT_TITLE,
        level: 0,
        parent: null,
        line: root.line,
        body: ""
      });
    const add = (element: XmlElement, parent: number | null, level: number): void => {
      if (level - offset >= EXCHANGE_MAX_DEPTH) throw new ExchangeReject("too-deep", element.line);
      if (nodes.length - offset >= EXCHANGE_MAX_NODES) throw new ExchangeReject("too-many-nodes", element.line);
      const found = read(element);
      const index = nodes.length;
      nodes.push({
        index,
        title: cleanTitle(found.title, element.line),
        level,
        parent,
        line: element.line,
        body: cleanBody(found.body, element.line)
      });
      for (const kid of found.kids) add(kid, index, level + 1);
    };
    for (const top of tops) add(top, synthesized ? 0 : null, synthesized ? 1 : 0);
    return { ok: true, format, nodes, synthesizedRoot: synthesized };
  } catch (error) {
    if (error instanceof ExchangeReject)
      return error.line === undefined
        ? { ok: false, reason: error.reason }
        : { ok: false, reason: error.reason, line: error.line };
    return { ok: false, reason: "bad-xml" };
  }
}

export interface ExchangeMapInput {
  title: string;
  /** Every node of the map in sibling order; only `id` and `parentId` are read. */
  nodes: readonly { id: string; parentId: string | null }[];
}
export interface ExchangeNoteInput {
  title: string;
  body: string;
}

// With the u flag a lone surrogate is a code point outside the class, so it is removed together with illegal controls.
const XML_INVALID = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
const stripInvalid = (value: string): string => value.replace(XML_INVALID, "");
const escapeText = (value: string): string =>
  stripInvalid(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value: string): string =>
  escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");

interface TreeNode {
  id: string;
  children: TreeNode[];
}
/** Roots and children in input order; a node whose parent is missing becomes a root, and a parent loop is cut. */
function buildTree(map: ExchangeMapInput): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const node of map.nodes) if (!byId.has(node.id)) byId.set(node.id, { id: node.id, children: [] });
  const roots: TreeNode[] = [];
  const attached = new Set<string>();
  for (const node of map.nodes) {
    if (attached.has(node.id)) continue;
    attached.add(node.id);
    const treeNode = byId.get(node.id) as TreeNode;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (!parent || node.parentId === node.id) roots.push(treeNode);
    else parent.children.push(treeNode);
  }
  // A parent loop never reaches a root, so it is simply not emitted rather than guessed at.
  return roots;
}

/** Depth-first emit: `open` returns the opening text (and whether the node is a leaf), `close` the closing text. */
function emitTree(
  roots: TreeNode[],
  open: (node: TreeNode, depth: number) => string,
  close: (node: TreeNode, depth: number) => string
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const frames: { node: TreeNode; next: number; depth: number }[] = [];
  const enter = (node: TreeNode, depth: number): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    lines.push(open(node, depth));
    if (node.children.length) frames.push({ node, next: 0, depth });
    else {
      const closing = close(node, depth);
      if (closing) lines.push(closing);
    }
  };
  for (const root of roots) {
    enter(root, 0);
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.node.children.length) enter(frame.node.children[frame.next++], frame.depth + 1);
      else {
        frames.pop();
        lines.push(close(frame.node, frame.depth));
      }
    }
  }
  return lines;
}

const indent = (depth: number): string => "  ".repeat(depth);
const noteOf = (notes: ReadonlyMap<string, ExchangeNoteInput>, id: string): ExchangeNoteInput => {
  const note = notes.get(id);
  return { title: note?.title || id, body: note?.body ?? "" };
};

/** OPML 2.0. The map title goes in `head>title`; relations are not exported. */
export function toOpml(map: ExchangeMapInput, notes: ReadonlyMap<string, ExchangeNoteInput>): string {
  const roots = buildTree(map);
  const outlines = emitTree(
    roots,
    (node, depth) => {
      const note = noteOf(notes, node.id);
      const attrs = `text="${escapeAttr(note.title)}"${note.body ? ` _note="${escapeAttr(note.body)}"` : ""}`;
      return `${indent(depth + 2)}<outline ${attrs}${node.children.length ? ">" : "/>"}`;
    },
    (node, depth) => (node.children.length ? `${indent(depth + 2)}</outline>` : "")
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeText(map.title)}</title>`,
    "  </head>",
    "  <body>",
    ...outlines,
    "  </body>",
    "</opml>",
    ""
  ].join("\n");
}

/** FreeMind 1.0.1. FreeMind has one root node, so several roots are wrapped in one titled with the map title. */
export function toFreeMind(map: ExchangeMapInput, notes: ReadonlyMap<string, ExchangeNoteInput>): string {
  const roots = buildTree(map);
  let counter = 0;
  const lines = emitTree(
    roots,
    (node, depth) => {
      const note = noteOf(notes, node.id);
      const head = `${indent(depth + 1)}<node ID="ID_${++counter}" TEXT="${escapeAttr(note.title)}"`;
      const rich = note.body
        ? [
            `${indent(depth + 2)}<richcontent TYPE="NOTE"><html><head></head><body>${note.body
              .split(/\r\n?|\n/)
              .map(part => (part ? `<p>${escapeText(part)}</p>` : "<p><br/></p>"))
              .join("")}</body></html></richcontent>`
          ]
        : [];
      if (!node.children.length && !rich.length) return `${head}/>`;
      return [`${head}>`, ...rich].join("\n");
    },
    (node, depth) => (node.children.length || noteOf(notes, node.id).body ? `${indent(depth + 1)}</node>` : "")
  );
  const body =
    roots.length > 1
      ? [`  <node ID="ID_0" TEXT="${escapeAttr(map.title)}">`, ...lines.map(line => `  ${line}`), "  </node>"]
      : lines;
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<map version="1.0.1">', ...body, "</map>", ""].join("\n");
}
