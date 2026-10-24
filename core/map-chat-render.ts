/**
 * Lays a model reply out in the map chat. The reply is untrusted, so it is never handed to Obsidian's own Markdown engine
 * (which would load remote images, embed notes and run code-block processors of other plugins). It is parsed here into a small
 * set of blocks and inline pieces, and the page is built only from `createEl`/`createSpan` calls with plain text. No HTML
 * string is ever parsed, and no `img`, `iframe` or `embed` is ever created. Everything outside the supported set (images, HTML, callouts,
 * tables, math, indented code) stays visible as the text the model wrote; fences keep no language, so nothing runs them.
 */

export type ChatInline =
  | { t: "text"; text: string }
  | { t: "br" }
  | { t: "code"; text: string }
  | { t: "fmt"; tag: "strong" | "em" | "del"; c: ChatInline[] }
  | { t: "wiki"; target: string; label: string }
  | { t: "link"; href: string; c: ChatInline[] };

export interface ChatListItem {
  c: ChatInline[];
  sub: Extract<ChatBlock, { t: "list" }> | null;
}

export type ChatBlock =
  | { t: "p"; c: ChatInline[] }
  | { t: "h"; level: number; c: ChatInline[] }
  | { t: "hr" }
  | { t: "code"; text: string }
  | { t: "quote"; c: ChatBlock[] }
  | { t: "list"; ordered: boolean; items: ChatListItem[] };

const MAX_INLINE_DEPTH = 4;
const MAX_QUOTE_DEPTH = 3;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const ALNUM = /[\p{L}\p{N}]/u;
const HTTP_URL = /^https?:\/\/[^\s<>]+$/i;
const BARE_URL = /https?:\/\/[^\s<>]+/iy;
const TRAILING = ".,;:!?'\"*_~]";
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const INVISIBLE = /[\s\u200b-\u200d\u2060\ufeff\u00ad]/g;
const MAX_REPLY_CHARS = 50000;
/** Most elements one reply may build; the rest of it is shown as one plain text block (see {@link renderChatMarkdown}). */
export const MAX_REPLY_NODES = 2000;
const WIKI = /\[\[([^[\]\n]+)\]\]/y;

/** Per-source lookup tables, built in one pass the first time they are needed, so no opener ever rescans the text. */
interface InlineScan {
  src: string;
  brackets?: Int32Array;
  parens?: Int32Array;
  noClose: Record<string, number>;
}

/** For every `[` the index of the `]` that closes it (nested pairs and `\]` are skipped), or -1. */
function bracketTable(scan: InlineScan): Int32Array {
  if (scan.brackets) return scan.brackets;
  const { src } = scan;
  const table = new Int32Array(src.length).fill(-1);
  const stack: number[] = [];
  for (let at = 0; at < src.length; at++) {
    const ch = src[at];
    if (ch === "\\") at++;
    else if (ch === "[") stack.push(at);
    else if (ch === "]" && stack.length) table[stack.pop() as number] = at;
  }
  return (scan.brackets = table);
}

/** For every `(` the index of the `)` that closes it on the same line (`\)` is skipped), or -1. */
function parenTable(scan: InlineScan): Int32Array {
  if (scan.parens) return scan.parens;
  const { src } = scan;
  const table = new Int32Array(src.length).fill(-1);
  let stack: number[] = [];
  for (let at = 0; at < src.length; at++) {
    const ch = src[at];
    if (ch === "\\") at++;
    else if (ch === "(") stack.push(at);
    else if (ch === ")" && stack.length) table[stack.pop() as number] = at;
    else if (ch === "\n") stack = [];
  }
  return (scan.parens = table);
}

/** `[label](destination "title")` at `open`: where it ends, the label text and the destination. Null when it is not that shape. */
function bracketLink(scan: InlineScan, open: number): { end: number; label: string; dest: string } | null {
  const { src } = scan;
  if (src[open] !== "[") return null;
  const close = bracketTable(scan)[open];
  if (close < 0 || src[close + 1] !== "(") return null;
  const at = parenTable(scan)[close + 1];
  if (at < 0) return null;
  let dest = src.slice(close + 2, at).trim();
  if (dest.startsWith("<")) {
    const stop = dest.indexOf(">");
    dest = stop > 0 ? dest.slice(1, stop) : dest;
  } else dest = dest.split(/\s+/)[0] ?? "";
  return { end: at + 1, label: src.slice(open + 1, close), dest };
}

function wikiAt(src: string, at: number): { end: number; target: string; label: string } | null {
  WIKI.lastIndex = at;
  const match = WIKI.exec(src);
  if (!match) return null;
  const [rawTarget, ...alias] = match[1].split("|");
  const target = rawTarget.trim();
  if (!target) return null;
  return { end: at + match[0].length, target, label: alias.join("|").trim() || target };
}

const DELIMITERS = ["**", "__", "~~", "*", "_"] as const;

function formatAt(scan: InlineScan, at: number, depth: number): { end: number; node: ChatInline } | null {
  const { src } = scan;
  const delimiter = DELIMITERS.find(item => src.startsWith(item, at));
  if (!delimiter || depth >= MAX_INLINE_DEPTH) return null;
  const underscore = delimiter[0] === "_";
  if (underscore && at > 0 && ALNUM.test(src[at - 1])) return null;
  const start = at + delimiter.length;
  if (start >= src.length || /\s/.test(src[start])) return null;
  // Whether a closer is valid does not depend on the opener, so one failed search rules out every later opener of the same kind.
  if (start >= (scan.noClose[delimiter] ?? Infinity)) return null;
  for (let close: number = src.indexOf(delimiter, start + 1); close >= 0; close = src.indexOf(delimiter, close + 1)) {
    if (/\s/.test(src[close - 1])) continue;
    const after: string | undefined = src[close + delimiter.length];
    if (delimiter.length === 1 && after === delimiter) continue;
    if (underscore && after !== undefined && ALNUM.test(after)) continue;
    const tag = delimiter === "~~" ? "del" : delimiter.length === 2 ? "strong" : "em";
    return {
      end: close + delimiter.length,
      node: { t: "fmt", tag, c: parseInline(src.slice(start, close), depth + 1, true) }
    };
  }
  scan.noClose[delimiter] = start;
  return null;
}

function bareUrlAt(src: string, at: number): { end: number; url: string } | null {
  if (at > 0 && ALNUM.test(src[at - 1])) return null;
  BARE_URL.lastIndex = at;
  const match = BARE_URL.exec(src);
  if (!match) return null;
  const raw = match[0];
  const hasOpen = raw.includes("(");
  let stop = raw.length;
  for (;;) {
    while (stop > 0 && TRAILING.includes(raw[stop - 1])) stop--;
    if (stop > 0 && raw[stop - 1] === ")" && !hasOpen) stop--;
    else break;
  }
  const url = raw.slice(0, stop);
  return /^https?:\/\/./i.test(url) ? { end: at + url.length, url } : null;
}

/** How many characters a reader can see in these pieces (blanks and zero-width characters do not count). */
function visibleLength(nodes: ChatInline[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.t === "text" || node.t === "code") total += node.text.replace(INVISIBLE, "").length;
    else if (node.t === "fmt" || node.t === "link") total += visibleLength(node.c);
    else if (node.t === "wiki") total += node.label.replace(INVISIBLE, "").length;
  }
  return total;
}

/** Parses inline Markdown. `links` is false inside a link label, where a nested link stays text. */
export function parseInline(src: string, depth = 0, links = true): ChatInline[] {
  const scan: InlineScan = { src, noClose: {} };
  const out: ChatInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ t: "text", text: buf });
    buf = "";
  };
  for (let at = 0; at < src.length;) {
    const ch = src[at];
    if (ch === "\\" && at + 1 < src.length && ESCAPABLE.test(src[at + 1])) {
      buf += src[at + 1];
      at += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      at++;
      continue;
    }
    if (ch === "`") {
      let end = at;
      while (src[end] === "`") end++;
      const run = src.slice(at, end);
      let close = -1;
      for (let search = end; search < src.length;) {
        const next = src.indexOf("`", search);
        if (next < 0) break;
        let stop = next;
        while (src[stop] === "`") stop++;
        if (stop - next === run.length) {
          close = next;
          break;
        }
        search = stop;
      }
      if (close < 0) {
        buf += run;
        at = end;
        continue;
      }
      flush();
      out.push({ t: "code", text: src.slice(end, close).replace(/\n/g, " ") });
      at = close + run.length;
      continue;
    }
    if (ch === "!" && src[at + 1] === "[") {
      // An image or embed is shown as written, never loaded and never turned into a link.
      const wiki = src.startsWith("[[", at + 1) ? wikiAt(src, at + 1) : null;
      const link = wiki ? null : bracketLink(scan, at + 1);
      const end = wiki?.end ?? link?.end;
      if (end !== undefined) {
        buf += src.slice(at, end);
        at = end;
      } else {
        buf += ch;
        at++;
      }
      continue;
    }
    if (ch === "[") {
      const wiki = wikiAt(src, at);
      if (wiki && SCHEME.test(wiki.target)) {
        // A target that names a scheme is never a note, so it stays the text the model wrote.
        buf += src.slice(at, wiki.end);
        at = wiki.end;
        continue;
      }
      if (wiki && links) {
        flush();
        out.push({ t: "wiki", target: wiki.target, label: wiki.label });
        at = wiki.end;
        continue;
      }
      if (wiki) {
        buf += src.slice(at, wiki.end);
        at = wiki.end;
        continue;
      }
      const link = bracketLink(scan, at);
      if (link) {
        if (links && HTTP_URL.test(link.dest)) {
          flush();
          // A link with no words in it shows its address, so it never turns into an invisible target.
          const label = parseInline(link.label, depth + 1, false);
          out.push({ t: "link", href: link.dest, c: visibleLength(label) ? label : [{ t: "text", text: link.dest }] });
        } else buf += src.slice(at, link.end);
        at = link.end;
        continue;
      }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const format = formatAt(scan, at, depth);
      if (format) {
        flush();
        out.push(format.node);
        at = format.end;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && links) {
      const url = bareUrlAt(src, at);
      if (url) {
        flush();
        out.push({ t: "link", href: url.url, c: [{ t: "text", text: url.url }] });
        at = url.end;
        continue;
      }
    }
    buf += ch;
    at++;
  }
  flush();
  return out;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_OPEN = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

/** An ATX heading's level and text, or null. The closing `#` run is stripped by hand, so no pattern can backtrack over spaces. */
function headingAt(line: string): { level: number; text: string } | null {
  const open = HEADING_OPEN.exec(line);
  if (!open) return null;
  let text = line.slice(open[0].length).trimEnd();
  let at = text.length;
  while (at > 0 && text[at - 1] === "#") at--;
  if (at > 0 && at < text.length && (text[at - 1] === " " || text[at - 1] === "\t")) text = text.slice(0, at).trimEnd();
  return { level: open[1].length, text };
}
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

const isFenceOpen = (line: string): RegExpExecArray | null => {
  const open = FENCE_OPEN.exec(line);
  // A backtick fence's info string cannot hold a backtick; otherwise the line is inline code.
  return open && !(open[1][0] === "`" && open[2].includes("`")) ? open : null;
};
const startsBlock = (line: string): boolean =>
  !!isFenceOpen(line) || !!headingAt(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line);

/** `starts`, when given, receives the line each top-level block begins at (one entry per block returned). */
export function parseBlocks(lines: string[], depth = 0, starts?: number[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (let at = 0; at < lines.length;) {
    const line = lines[at];
    if (!line.trim()) {
      at++;
      continue;
    }
    starts?.push(at);
    const open = isFenceOpen(line);
    if (open) {
      const mark = open[1][0];
      const length = open[1].length;
      const body: string[] = [];
      for (at++; at < lines.length; at++) {
        const close = FENCE_CLOSE.exec(lines[at]);
        if (close && close[1][0] === mark && close[1].length >= length) {
          at++;
          break;
        }
        body.push(lines[at]);
      }
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const heading = headingAt(line);
    if (heading) {
      blocks.push({ t: "h", level: heading.level, c: parseInline(heading.text) });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: "hr" });
      at++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; at < lines.length && QUOTE.test(lines[at]); at++) inner.push(lines[at].replace(/^ {0,3}> ?/, ""));
      blocks.push({
        t: "quote",
        c: depth < MAX_QUOTE_DEPTH ? parseBlocks(inner, depth + 1) : [{ t: "p", c: parseInline(inner.join("\n")) }]
      });
      continue;
    }
    if (LIST.test(line)) {
      const rows: { level: number; ordered: boolean; text: string }[] = [];
      while (at < lines.length) {
        const row = lines[at];
        if (!row.trim()) {
          let next = at + 1;
          while (next < lines.length && !lines[next].trim()) next++;
          if (next < lines.length && LIST.test(lines[next])) {
            at = next;
            continue;
          }
          break;
        }
        const item = LIST.exec(row);
        if (item) {
          const ordered = /\d/.test(item[2]);
          const level = item[1].length >= 2 ? 1 : 0;
          // Another kind of marker at the top level starts a new list.
          if (level === 0 && rows.length && ordered !== rows[0].ordered) break;
          rows.push({ level, ordered, text: item[3] });
        } else if (/^\s{2,}\S/.test(row) && rows.length) rows[rows.length - 1].text += `\n${row.trim()}`;
        else break;
        at++;
      }
      const list: Extract<ChatBlock, { t: "list" }> = { t: "list", ordered: rows[0].ordered, items: [] };
      for (const row of rows) {
        const top = list.items.at(-1);
        if (row.level === 1 && top) {
          top.sub ??= { t: "list", ordered: row.ordered, items: [] };
          top.sub.items.push({ c: parseInline(row.text), sub: null });
        } else list.items.push({ c: parseInline(row.text), sub: null });
      }
      blocks.push(list);
      continue;
    }
    const paragraph = [line];
    for (at++; at < lines.length && lines[at].trim() && !startsBlock(lines[at]); at++) paragraph.push(lines[at]);
    blocks.push({ t: "p", c: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

export function parseChatMarkdown(text: string): ChatBlock[] {
  return layoutReply(text).blocks;
}

/** How many elements {@link renderBlocks} creates for these pieces. */
function inlineCost(nodes: ChatInline[]): number {
  let cost = 0;
  for (const node of nodes) {
    cost += 1;
    if (node.t === "fmt" || node.t === "link") cost += inlineCost(node.c);
  }
  return cost;
}
function blockCost(block: ChatBlock): number {
  switch (block.t) {
    case "p":
      return 1 + inlineCost(block.c);
    case "h":
      return 1 + inlineCost(block.c);
    case "hr":
      return 1;
    case "code":
      return 2;
    case "quote":
      return 1 + blocksCost(block.c);
    case "list": {
      let cost = 1;
      for (const item of block.items) cost += 1 + inlineCost(item.c) + (item.sub ? blockCost(item.sub) : 0);
      return cost;
    }
  }
}
const blocksCost = (blocks: ChatBlock[]): number => blocks.reduce((sum, block) => sum + blockCost(block), 0);

interface ReplyLayout {
  blocks: ChatBlock[];
  /** What is not laid out (past the character limit or the element budget), exactly as written. */
  plain: string;
}

/**
 * Parses a reply into blocks, but only as many as fit the limits: 50,000 characters (cut at a line end when there is one) and
 * `budget` elements. The part left over is returned as it was written.
 */
function layoutReply(text: string, budget = MAX_REPLY_NODES): ReplyLayout {
  const clean = text.replace(/\r\n?/g, "\n");
  let head = clean;
  let tail = "";
  if (clean.length > MAX_REPLY_CHARS) {
    const line = clean.lastIndexOf("\n", MAX_REPLY_CHARS);
    const cut = line >= MAX_REPLY_CHARS / 2 ? line : MAX_REPLY_CHARS;
    head = clean.slice(0, cut);
    tail = clean.slice(cut);
  }
  const lines = head.split("\n");
  const starts: number[] = [];
  const blocks = parseBlocks(lines, 0, starts);
  let used = 0;
  let fit = 0;
  while (fit < blocks.length) {
    const cost = blockCost(blocks[fit]);
    if (used + cost > budget) break;
    used += cost;
    fit++;
  }
  if (fit === blocks.length) return { blocks, plain: tail };
  // Block `fit` does not fit whole: keep the longest start of it that does (cut at a blank), and the rest stays plain.
  const end = fit + 1 < blocks.length ? starts[fit + 1] : lines.length;
  const source = lines.slice(starts[fit], end).join("\n");
  const room = budget - used;
  const cutAt = (limit: number): number => {
    // At the end of a line when there is one, else at a blank, so the plain part starts at a word.
    const line = source.lastIndexOf("\n", limit - 1);
    if (line >= 0) return line + 1;
    let at = limit;
    while (at > 0 && !/\s/.test(source[at - 1])) at--;
    return at;
  };
  const fits = (limit: number): boolean => blocksCost(parseBlocks(source.slice(0, cutAt(limit)).split("\n"))) <= room;
  let low = 0;
  let high = source.length;
  // Grow the probe until it no longer fits (the answer is near the budget, far from the end), then narrow down.
  for (let probe = Math.max(256, room * 2); probe < high; probe *= 2) {
    if (fits(probe)) low = probe;
    else {
      high = probe - 1;
      break;
    }
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  low = cutAt(low);
  const kept = parseBlocks(source.slice(0, low).split("\n"));
  const rest = [source.slice(low), ...lines.slice(end)].join("\n") + (tail ? tail : "");
  return { blocks: [...blocks.slice(0, fit), ...kept], plain: rest };
}

function renderInline(parent: HTMLElement, nodes: ChatInline[]): void {
  for (const node of nodes) {
    switch (node.t) {
      case "text":
        parent.createSpan({ text: node.text });
        break;
      case "br":
        parent.createEl("br");
        break;
      case "code":
        parent.createEl("code", { text: node.text });
        break;
      case "fmt":
        renderInline(parent.createEl(node.tag), node.c);
        break;
      case "wiki":
        parent.createEl("a", {
          cls: "internal-link",
          text: node.label,
          attr: { "data-href": node.target, tabindex: "0" }
        });
        break;
      case "link":
        renderInline(
          parent.createEl("a", { cls: "external-link", attr: { href: node.href, target: "_blank", rel: "noopener" } }),
          node.c
        );
        break;
    }
  }
}

function renderBlocks(parent: HTMLElement, blocks: ChatBlock[]): void {
  for (const block of blocks) {
    switch (block.t) {
      case "p":
        renderInline(parent.createEl("p"), block.c);
        break;
      case "h":
        renderInline(parent.createEl(`h${block.level}` as "h1", { cls: "vam-map-chat-heading" }), block.c);
        break;
      case "hr":
        parent.createEl("hr");
        break;
      case "code":
        parent.createEl("pre").createEl("code", { text: block.text });
        break;
      case "quote":
        renderBlocks(parent.createEl("blockquote"), block.c);
        break;
      case "list": {
        const list = parent.createEl(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const row = list.createEl("li");
          renderInline(row, item.c);
          if (item.sub) renderBlocks(row, [item.sub]);
        }
        break;
      }
    }
  }
}

/**
 * Replaces the children of `parent` with the reply laid out as a safe subset of Markdown. A reply is laid out only up to
 * {@link MAX_REPLY_NODES} elements (and 50,000 characters); what is left stays visible as one plain text block that keeps its
 * line breaks, introduced by `overflowNote` (a line of small text, given by the caller because this file has no translations).
 */
export function renderChatMarkdown(parent: HTMLElement, text: string, overflowNote = ""): void {
  parent.empty();
  const { blocks, plain } = layoutReply(text);
  renderBlocks(parent, blocks);
  const rest = plain.replace(/^\s+/, "");
  if (!rest) return;
  if (overflowNote) parent.createEl("p", { cls: "vam-map-chat-overflow-note", text: overflowNote });
  parent.createEl("p", { cls: "vam-map-chat-plain", text: rest });
}
