import { parseBlocks, type ChatBlock, type ChatInline, type ChatListItem } from "./map-chat-render";

/**
 * "Save as a note" for the map chat (B3). Pure functions only: the file name, and the Markdown written for the conversation.
 *
 * Everything in a conversation is untrusted (the model's reply, the user's message, a web page's title, a note's name). The
 * note is therefore not a copy of the text: it is built again from a small whitelist of Markdown (see {@link transcriptMarkdown}).
 * Anything outside it becomes plain text with every ASCII punctuation character backslash-escaped, so Obsidian's reading view
 * shows it as written and runs nothing (no image or note embed, no HTML, no code-block processor, no comment, no math).
 */

const CHAT_NAME_LIMIT = 40;
/** A sentence ends at 。！？!? or a line break, or at a "." that is followed by a blank or the end (so "v1.5" stays whole). */
const SENTENCE_END = /[。！？!?\n\r]|\.(?=\s|$)/;
/** U+200B, written by code so no invisible character sits in this file. */
const ZERO_WIDTH = String.fromCharCode(0x200b);

type GraphemeSegmenter = new (
  locale?: string,
  options?: { granularity: "grapheme" }
) => { segment(input: string): Iterable<{ segment: string }> };

/** Splits text into grapheme clusters (code points when `Intl.Segmenter` is unavailable). */
function graphemesOf(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: GraphemeSegmenter }).Segmenter;
  if (Segmenter)
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment);
  return Array.from(value);
}

const pad2 = (value: number): string => String(value).padStart(2, "0");
/** `YYYY-MM-DD` of the machine's local date. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
/** `YYYY-MM-DD HH:mm` of the machine's local time. */
export function localStamp(date: Date): string {
  return `${localDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * The first sentence of a message for a file name: from the first non-blank character up to (not including) the first sentence
 * end (`。！？.!?`) or line break, at most 40 graphemes (no ellipsis), with the characters a file or link name cannot hold
 * (`\ / : * ? " < > | # ^ [ ]`) turned into spaces, blanks collapsed, and leading dots and blanks and trailing dots and blanks
 * removed. "" when nothing is left.
 */
export function chatFirstSentence(message: string): string {
  const text = skipBlank(message);
  const end = text.search(SENTENCE_END);
  const sentence = end >= 0 ? text.slice(0, end) : text;
  let cut = "";
  let count = 0;
  for (const part of graphemesOf(sentence)) {
    if (count === CHAT_NAME_LIMIT) break;
    cut += part;
    count++;
  }
  return cut
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
}

/**
 * The file name (without `.md`) of a saved conversation: `<YYYY-MM-DD> <first sentence>` with the date of `date` (the moment
 * of saving, local time). `fallback` ("Chat" in the interface language) stands in when no usable sentence is left. A name that
 * is already taken is made unique by the caller (the repository adds " 2", " 3").
 */
export function chatNoteName(message: string, date: Date, fallback: string): string {
  return `${localDate(date)} ${chatFirstSentence(message) || fallback}`;
}

// ---- escaping and whitelist serialization -------------------------------------------------------------------------------

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** Control characters (except tab and line feed) and the bidirectional overrides and isolates. */
const isDropped = (code: number): boolean =>
  (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
  code === 127 ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);
const stripControl = (value: string): string =>
  Array.from(value)
    .filter(ch => !isDropped(ch.codePointAt(0) ?? 0))
    .join("");
/** Leading blanks, zero-width characters and byte order marks are skipped. */
function skipBlank(value: string): string {
  let at = 0;
  while (at < value.length && (/\s/.test(value[at]) || [0x200b, 0x200c, 0x200d, 0xfeff].includes(value.charCodeAt(at))))
    at++;
  return value.slice(at);
}
const FRONT_MATTER_KEYS = /agent-map-node|node-id|topic-id/g;

/** Plain text: control and bidirectional-override characters are dropped, every ASCII punctuation character gets a backslash. */
export function escapeText(value: string): string {
  return stripControl(value).replace(ASCII_PUNCTUATION, "\\$&");
}

/** A text that is one line (blanks collapsed), escaped. */
const escapeLine = (value: string): string => escapeText(value.replace(/\s+/g, " ").trim());

/** A user's text: line breaks stay as hard breaks, no line can start a block, everything is escaped. */
export function escapeMultiline(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => escapeText(line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")))
    .join("\\\n");
}

/** A link alias safe inside `[[path|alias]]`: no brackets, pipe, backtick or line breaks (the rule of the repository's `linkAlias`). */
function linkAliasOf(title: string): string {
  return stripControl(title)
    .replace(/[[\]|`\r\n\\]/g, " ")
    .replace(/%{2,}/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

/** A vault path as a wikilink target: no `.md`, no brackets, pipe, backtick, `!`, backslash or line breaks. "" when nothing is left. */
function wikiTargetOf(value: string): string {
  return stripControl(value)
    .replace(/\.md$/i, "")
    .replace(/[[\]|`!\\\r\n]/g, " ")
    .replace(/%{2,}/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

/** A wikilink to a note: `[[path]]`, or `[[path|alias]]` when the alias says something else. Plain escaped text when the target is unusable. */
export function wikiLink(target: string, label: string): string {
  const path = wikiTargetOf(target);
  const alias = linkAliasOf(label);
  if (!path) return escapeLine(label || target);
  return alias && alias !== path ? `[[${path}|${alias}]]` : `[[${path}]]`;
}

/** An https page link: `[label](<url>)` when the address is a plain https address, else the label as text. */
function pageLink(label: string, url: string): string {
  const text = escapeLine(label) || escapeLine(url);
  return /^https:\/\/[^\s<>]+$/i.test(url) ? `[${text}](<${url}>)` : text;
}

/** A code span for `text`: a fence of backticks longer than any run in it, padded when it starts or ends with a backtick or blank. */
function codeSpan(text: string): string {
  const body = defuseCode(text.replace(/\r?\n|\r/g, " "));
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(longest + 1);
  // Dataview runs an inline code that starts with "=" or "$" (after blanks): a zero-width space in front keeps it plain code.
  const guarded = /^\s*[=$]/.test(body) ? `${ZERO_WIDTH}${body}` : body;
  const padded = /^[`\s]|[`\s]$/.test(guarded) ? ` ${guarded} ` : guarded;
  return `${fence}${padded}${fence}`;
}

/** Code stays code, but `![` never appears (a zero-width space splits it), whatever Markdown reads inside the fence. */
function defuseCode(text: string): string {
  return stripControl(text).replace(/!(?=\[)/g, `!${ZERO_WIDTH}`);
}

function inlineMarkdown(nodes: ChatInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.t) {
      case "text":
        out += escapeText(node.text);
        break;
      case "br":
        out += "\\\n";
        break;
      case "code":
        out += codeSpan(node.text);
        break;
      case "fmt": {
        const inner = inlineMarkdown(node.c);
        const mark = node.tag === "strong" ? "**" : node.tag === "del" ? "~~" : "*";
        out += inner.trim() ? `${mark}${inner}${mark}` : inner;
        break;
      }
      case "wiki":
        out += wikiLink(node.target, node.label);
        break;
      case "link": {
        const label = inlineMarkdown(node.c).replace(/\\\n/g, " ");
        out += /^https?:\/\/[^\s<>]+$/i.test(node.href) ? `[${label || escapeText(node.href)}](<${node.href}>)` : label;
        break;
      }
    }
  }
  return out;
}

/** A line of text never starts with blanks (four of them would make a code block), also after a hard break. */
const tidy = (text: string): string => text.replace(/^[ \t]+/, "").replace(/\\\n[ \t]+/g, "\\\n");

const indentOf = (text: string, pad: string, first: string): string =>
  text
    .split("\n")
    .map((line, at) => (at === 0 ? `${first}${line}` : line ? `${pad}${line}` : line))
    .join("\n");

function listMarkdown(block: Extract<ChatBlock, { t: "list" }>): string {
  return block.items
    .map((item: ChatListItem, index) => {
      const marker = block.ordered ? `${index + 1}. ` : "- ";
      let body = tidy(inlineMarkdown(item.c));
      if (item.sub) body += `\n${listMarkdown(item.sub)}`;
      return indentOf(body, " ".repeat(marker.length), marker);
    })
    .join("\n");
}

function blockMarkdown(block: ChatBlock): string {
  switch (block.t) {
    case "p":
      return tidy(inlineMarkdown(block.c));
    case "h":
      return `${"#".repeat(Math.min(6, Math.max(1, block.level)))} ${tidy(inlineMarkdown(block.c).replace(/\\\n/g, " "))}`;
    case "hr":
      return "---";
    case "code": {
      const text = defuseCode(block.text);
      const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
      const fence = "`".repeat(longest + 1);
      return `${fence}\n${text}\n${fence}`;
    }
    case "quote":
      return blocksMarkdown(block.c)
        .split("\n")
        .map(line => (line ? `> ${line}` : ">"))
        .join("\n");
    case "list":
      return listMarkdown(block);
  }
}

function blocksMarkdown(blocks: ChatBlock[]): string {
  return blocks.map(blockMarkdown).join("\n\n");
}

/**
 * A model reply as Markdown written again from what {@link parseBlocks} and {@link parseInline} (the parse the chat window
 * renders with) understood of it: paragraphs, headings, rules, lists, quotes, code fences without a language, bold, italic,
 * strike-through, inline code, `[[wikilinks]]` (never with `!`) and http(s) links. The rest of the reply was kept by the
 * parser as plain text, and is escaped here.
 */
export function replyMarkdown(reply: string): string {
  return blocksMarkdown(parseBlocks(reply.replace(/\r\n?/g, "\n").split("\n")));
}

// ---- the whole note -----------------------------------------------------------------------------------------------------

/** What a turn's question was sent with. A card or note is named by its vault path; the model's words never reach a path. */
export interface TranscriptRef {
  kind: "topic" | "file" | "snippet";
  /** Vault path of the note ("" when a dropped snippet's note is unknown). */
  path: string;
  /** Title to show for a card. */
  title: string;
  /** A snippet's quoted text. */
  text?: string;
}
export interface TranscriptImages {
  /** The card the pictures were for. */
  nodeTitle: string;
  query: string;
  state: "searching" | "ready" | "empty" | "failed" | "stopped";
  reason?: string;
  items: { title: string; source: string; /** Title of the card the picture was inserted into. */ inserted?: string }[];
}
export interface TranscriptTurn {
  question: string;
  refs: TranscriptRef[];
  answer: string;
  /** Result lines exactly as the window shows them. */
  lines: string[];
  plan?: "pending" | "applied" | "cancelled";
  images: TranscriptImages[];
}
/** The fixed words of the note, in the interface language; `{0}` is replaced where a label takes a value. */
export interface TranscriptLabels {
  title: string;
  map: string;
  saved: string;
  you: string;
  ai: string;
  references: string;
  results: string;
  planPending: string;
  planApplied: string;
  planCancelled: string;
  images: string;
  imagesSearching: string;
  imagesNone: string;
  imagesFailed: string;
  imagesStopped: string;
  inserted: string;
}
export interface TranscriptInput {
  mapTitle: string;
  /** Vault path of the map's Map.md. */
  mapPath: string;
  savedAt: Date;
  labels: TranscriptLabels;
  turns: TranscriptTurn[];
}

/** A label with its value, as one line of escaped text (both the label and the value are plain text). */
const fill = (template: string, value: string): string => escapeLine(template.replace(/\{0\}/g, () => value));

function refMarkdown(ref: TranscriptRef): string {
  if (ref.kind === "topic") return wikiLink(ref.path, ref.title);
  const link = ref.path ? wikiLink(ref.path, "") : "";
  if (ref.kind === "file") return link;
  const quote = ref.text ? escapeLine([...ref.text.replace(/\s+/g, " ")].slice(0, 200).join("")) : "";
  return [link, quote].filter(Boolean).join(" ");
}

function imagesMarkdown(block: TranscriptImages, labels: TranscriptLabels): string {
  const head = `**${fill(labels.images, block.nodeTitle)}**`;
  if (block.state === "searching") return `${head}\n\n${fill(labels.imagesSearching, block.query)}`;
  if (block.state === "empty") return `${head}\n\n${escapeLine(labels.imagesNone)}`;
  if (block.state === "stopped") return `${head}\n\n${escapeLine(labels.imagesStopped)}`;
  if (block.state === "failed") return `${head}\n\n${fill(labels.imagesFailed, block.reason ?? "")}`;
  const rows = block.items.map(
    item => `- ${pageLink(item.title, item.source)}${item.inserted ? ` ${fill(labels.inserted, item.inserted)}` : ""}`
  );
  return `${head}\n\n${rows.join("\n")}`;
}

/**
 * The note for a conversation: a header with a link to the map and the time of saving, then every finished turn (the question
 * with its references, the answer, the result lines, the state of its plan, and the picture candidates with links only). It
 * has no front matter, no embed and no key the plugin reads, and it never contains `![`.
 */
export function transcriptMarkdown(input: TranscriptInput): string {
  const { labels } = input;
  const parts: string[] = [
    `# ${escapeLine(labels.title)}`,
    `${escapeLine(labels.map)}: ${wikiLink(input.mapPath, input.mapTitle)}\\\n${escapeLine(labels.saved)}: ${localStamp(input.savedAt)}`
  ];
  input.turns.forEach((turn, index) => {
    parts.push("---");
    parts.push(`## ${index + 1}. ${escapeLine(labels.you)}`);
    parts.push(escapeMultiline(turn.question));
    const refs = turn.refs.map(refMarkdown).filter(Boolean);
    if (refs.length) parts.push(`${escapeLine(labels.references)}: ${refs.join(", ")}`);
    parts.push(`### ${escapeLine(labels.ai)}`);
    const answer = replyMarkdown(turn.answer);
    if (answer.trim()) parts.push(answer);
    if (turn.lines.length) {
      parts.push(`**${escapeLine(labels.results)}**`);
      parts.push(turn.lines.map(line => `- ${escapeLine(line)}`).join("\n"));
    }
    if (turn.plan)
      parts.push(
        escapeLine(
          turn.plan === "pending"
            ? labels.planPending
            : turn.plan === "applied"
              ? labels.planApplied
              : labels.planCancelled
        )
      );
    for (const block of turn.images) parts.push(imagesMarkdown(block, labels));
  });
  return (
    parts
      .join("\n\n")
      // Defence in depth: nothing written can open an image, and no key the plugin reads can appear in the note.
      .replace(/!(?=\[)/g, `!${ZERO_WIDTH}`)
      // The three keys are split everywhere except inside a wikilink, whose target must stay a working path.
      .split(/(\[\[[^\]\n]*\]\])/)
      .map((part, at) =>
        at % 2 ? part : part.replace(FRONT_MATTER_KEYS, match => `${match[0]}${ZERO_WIDTH}${match.slice(1)}`)
      )
      .join("") + "\n"
  );
}
