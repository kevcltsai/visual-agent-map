/**
 * Write rules and output cleaning of the seamless research flow (pure, no Obsidian imports).
 * Phase 2 returns model markdown, source footnotes, per-statement verdicts and image candidates; nothing in it reaches the Vault before passing through here.
 */

export const WEB_SUPPLEMENT_HEADING = "### 網路補充";
export const ORIGINAL_PREFIX = "原本寫：";
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface Phase2Footnote {
  id: string;
  url: string;
  title: string;
}
export interface Phase2Verdict {
  sentence: string;
  verdict: "supported" | "unsupported";
  correction?: string;
  sourceUrl?: string;
}
export interface Phase2Image {
  imageUrl: string;
  sourceUrl: string;
  title: string;
  license: string;
}

/** Detail text compared by ownership hash: line endings and outer blank space do not count as a user edit. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** 32-bit FNV-1a of the normalized text, as hex. Marks "this detail is what the AI wrote and nobody changed". */
export function detailHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of normalize(text)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------- URLs ----------

const UNSAFE_URL_CHARS = /[\s<>"'`\\]/;

/** Control characters, zero-width marks and bidirectional overrides cannot be part of an address. */
function hasHiddenCharacter(text: string): boolean {
  return stripUnsafeCharacters(text) !== text || /[\u0080-\u009f\u2028\u2029]/.test(text);
}

function privateIpv4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0)
  );
}

/** Eight 16-bit groups of an IPv6 address (no brackets), or undefined when it cannot be read. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some(octet => octet > 255)) return undefined;
    text = `${text.slice(0, dotted.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const read = (part: string): number[] =>
    part ? part.split(":").map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)) : [];
  const head = read(halves[0]);
  const groups =
    halves.length === 1
      ? head
      : [
          ...head,
          ...new Array<number>(Math.max(0, 8 - head.length - read(halves[1]).length)).fill(0),
          ...read(halves[1])
        ];
  return groups.length === 8 && groups.every(group => group >= 0) ? groups : undefined;
}

/** Hosts that are not on the public internet: loopback, private, link-local, CGNAT, multicast, local names, and IPv6 forms that embed an IPv4 address. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) return true;
  if (host.includes(":")) {
    const g = ipv6Groups(host);
    if (!g) return true;
    const embedded = (hi: number, lo: number): boolean => privateIpv4(hi >> 8, hi & 255, lo >> 8);
    const zeros = (count: number): boolean => g.slice(0, count).every(group => group === 0);
    return (
      zeros(6) ||
      (zeros(5) && g[5] === 0xffff && embedded(g[6], g[7])) ||
      (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(group => group === 0) && embedded(g[6], g[7])) ||
      (g[0] === 0x2002 && embedded(g[1], g[2])) ||
      (g[0] & 0xfe00) === 0xfc00 ||
      (g[0] & 0xffc0) === 0xfe80 ||
      (g[0] & 0xffc0) === 0xfec0 ||
      g[0] >> 8 === 0xff
    );
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return privateIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  );
}

/**
 * The one URL gate. Parses with `new URL()` and returns the address to write, or undefined.
 * Needs https, a public host, no credentials, and no whitespace, control or invisible characters, quotes, angle brackets, backticks or backslashes.
 * The text is kept as given except that ( ) [ ] ! after the host become %28 %29 %5B %5D %21, so it can never close a link or open an image.
 */
export function normalizeHttpsUrl(value: string): string | undefined {
  const raw = value.trim();
  if (!raw || UNSAFE_URL_CHARS.test(raw) || hasHiddenCharacter(raw) || !/^https:\/\//i.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname)) return undefined;
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i.test(url.hostname)) return undefined;
  const afterScheme = raw.slice(8);
  const authorityLength = afterScheme.search(/[/?#]/);
  const cut = authorityLength < 0 ? raw.length : 8 + authorityLength;
  const authority = raw.slice(8, cut);
  if (!authority || authority.includes("@")) return undefined;
  return (
    `https://${url.host}` +
    raw.slice(cut).replace(/[()[\]!]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  );
}

export function isHttpsUrl(value: string): boolean {
  return normalizeHttpsUrl(value) !== undefined;
}

// ---------- allowlist builder ----------

/** Removes control characters (except tab and newline), zero-width marks and bidirectional overrides. */
function stripUnsafeCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const control = (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    const invisible =
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    if (!control && !invisible) out += char;
  }
  return out;
}

export interface SanitizeResult {
  markdown: string;
  dropped: string[];
}
export interface BuildOptions {
  /** Footnote ids a `[^id]` may refer to. Missing = any well-formed id. Others are written as plain text. */
  footnoteIds?: ReadonlySet<string>;
  /** `![[name]]` embeds the orchestrator itself made (saved local images). Every other embed is dropped. */
  embeds?: ReadonlySet<string>;
  /** Keep `[id]: https://…` reference definitions (default). The note writer turns them off: references are never written as links, so a definition would only wait for a `![id]` in the user's own text. */
  referenceDefinitions?: boolean;
}
type Drop = (kind: string, what: string) => void;
/** text = a body (links allowed); label = inside a link label; plain = a footnote title (no markup survives, brackets are left for the caller). */
type Mode = "text" | "label" | "plain";

const MAX_LABEL = 2000;

/** Index of the `]` that closes the `[` at `open` (nesting and backslash escapes honored), or -1. */
function findClose(text: string, open: number): number {
  let depth = 0;
  const end = Math.min(text.length, open + MAX_LABEL);
  for (let k = open; k < end; k++) {
    const char = text[k];
    if (char === "\\") k++;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return k;
  }
  return -1;
}

/** `(destination "title")` starting at `text[from] === "("`. `raw` is the destination as written. Undefined when the shape is not closed. */
function parseDestination(text: string, from: number): { raw: string; end: number } | undefined {
  let j = from + 1;
  while (j < text.length && /[ \t]/.test(text[j])) j++;
  let raw: string;
  if (text[j] === "<") {
    const close = text.indexOf(">", j);
    if (close < 0) return undefined;
    raw = text.slice(j + 1, close);
    j = close + 1;
  } else {
    const start = j;
    let depth = 0;
    while (j < text.length) {
      const char = text[j];
      if (char === "\\") {
        j += 2;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    raw = text.slice(start, j);
  }
  const spaced = /[ \t]/.test(text[j] ?? "");
  while (j < text.length && /[ \t]/.test(text[j])) j++;
  if (spaced && /["'(]/.test(text[j] ?? "")) {
    const closer = text[j] === "(" ? ")" : text[j];
    let k = j + 1;
    while (k < text.length && text[k] !== closer) k += text[k] === "\\" ? 2 : 1;
    if (k >= text.length) return undefined;
    j = k + 1;
    while (j < text.length && /[ \t]/.test(text[j])) j++;
  }
  return text[j] === ")" ? { raw, end: j + 1 } : undefined;
}

/** Writes one line of model text as allowed nodes only: plain text, https links, validated footnote references, own embeds. */
function inline(text: string, mode: Mode, options: BuildOptions, drop: Drop): string {
  let out = "";
  let pending = "";
  const emit = (value: string): void => {
    out += pending + value;
    pending = "";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        pending += char + next;
        i += 2;
      } else {
        pending += "\\\\";
        i++;
      }
      continue;
    }
    if (char === "<") {
      pending += "&lt;";
      i++;
      continue;
    }
    if (char === "!" && text[i + 1] === "[") {
      if (text[i + 2] === "[") {
        const end = text.indexOf("]]", i + 3);
        if (end < 0) {
          drop("embed", text.slice(i));
          i++;
          continue;
        }
        const name = text.slice(i + 3, end);
        if (mode === "text" && options.embeds?.has(name)) emit(`![[${name}]]`);
        else drop("embed", text.slice(i, end + 2));
        i = end + 2;
        continue;
      }
      const close = findClose(text, i + 1);
      if (close < 0) {
        drop("image", text.slice(i));
        i++;
        continue;
      }
      let j = close + 1;
      if (text[j] === "(") {
        const destination = parseDestination(text, j);
        j = destination ? destination.end : text.length;
      } else if (text[j] === "[") {
        const second = findClose(text, j);
        if (second >= 0) j = second + 1;
      }
      drop("image", text.slice(i, j));
      i = j;
      continue;
    }
    if (char === "[") {
      const note = /\[\^([\w-]+)\]/y;
      note.lastIndex = i;
      const found = note.exec(text);
      if (found && text[i + found[0].length] !== "(") {
        const id = found[1];
        if (mode === "text" && (!options.footnoteIds || options.footnoteIds.has(id))) emit(found[0]);
        else pending += `\\[^${id}\\]`;
        i += found[0].length;
        continue;
      }
      const close = findClose(text, i);
      if (close >= 0 && text[close + 1] === "(") {
        const destination = parseDestination(text, close + 1);
        if (destination) {
          const href = normalizeHttpsUrl(destination.raw);
          const label = inline(text.slice(i + 1, close), mode === "plain" ? "plain" : "label", options, drop);
          if (href && mode === "text") emit(`[${label.trim() || href.replace(/[[\]]/g, "")}](${href})`);
          else {
            if (!href) drop("link", text.slice(i, destination.end));
            emit(label);
          }
          i = destination.end;
          continue;
        }
      }
      pending += "\\[";
      i++;
      continue;
    }
    if (char === "!" || char === "]" || char === "(" || char === ")" || char === ">" || char === "`") {
      pending += `\\${char}`;
      i++;
      continue;
    }
    pending += char;
    i++;
  }
  emit("");
  return out;
}

/** Whole-text steps that must see across lines: control characters, autolinks, comments, and every HTML tag (dropped, not kept). */
function removeMarkup(markdown: string, drop: Drop): string {
  let text = stripUnsafeCharacters(markdown.replace(/\r\n?/g, "\n"));
  text = text.replace(/<(https:\/\/[^\s<>]+)>/gi, (match, url: string) => {
    const href = normalizeHttpsUrl(url);
    if (href) return href;
    drop("link", match);
    return "";
  });
  text = text.replace(/<!--[\s\S]*?-->/g, match => {
    drop("html", match);
    return "";
  });
  text = text.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, match => {
    drop("html", match);
    return "";
  });
  return text.replace(/<\/?[A-Za-z][^>]*>/g, match => {
    drop("html", match);
    return "";
  });
}

/** Block level: a run of 3+ `~` or backticks at line start (after quote, list, task, footnote or indent prefixes) could open a fence; its first character is escaped. */
function escapeFenceOpener(line: string): string {
  const match =
    /^((?:[ \t]*(?:>|[-*+][ \t]|\d+[.)][ \t]|\[[ xX]\][ \t]|\[\^[\w-]+\]:[ \t]|\[![\w-]+\][+-]?))*[ \t]*)([~`])\2{2,}/.exec(
      line
    );
  if (!match) return line;
  return `${match[1]}\\${line.slice(match[1].length)}`;
}

function buildLine(line: string, options: BuildOptions, drop: Drop): string | undefined {
  const built = buildLineRaw(line, options, drop);
  return built === undefined ? undefined : escapeFenceOpener(built);
}

function buildLineRaw(line: string, options: BuildOptions, drop: Drop): string | undefined {
  const note = /^\[\^([\w-]+)\]:\s*(.*)$/.exec(line);
  if (note && (!options.footnoteIds || options.footnoteIds.has(note[1])))
    return `[^${note[1]}]: ${inline(note[2], "text", options, drop)}`;
  const definition = /^\s*\[(?!\^)([^\]]+)\]:\s*(\S+)/.exec(line);
  if (definition) {
    if (options.referenceDefinitions === false) {
      drop("definition", line);
      return undefined;
    }
    const href = normalizeHttpsUrl(definition[2].replace(/^<|>$/g, ""));
    if (!href) {
      drop("definition", line);
      return undefined;
    }
    return `[${definition[1].replace(/[[\]\\]/g, " ").trim() || "link"}]: ${href}`;
  }
  const keep =
    /^(?:\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?=\s)|\s*>+\s*\[![\w-]+\][+-]?|\s*(?:>\s*)+)/.exec(line)?.[0] ?? "";
  return keep + inline(line.slice(keep.length), "text", options, drop);
}

/**
 * Builds the note text from model markdown. Only these nodes are written: plain text (with list, heading, emphasis and table characters passed through;
 * a `~~~`/backtick run that could open a fence is escaped at line start),
 * https links made from validated URLs, `[^id]` references, and `![[name]]` embeds the caller lists. Images, raw HTML, wiki links, reference-style
 * links and every other bracket form come out as dropped text or backslash-escaped plain text, never as a node.
 */
export function sanitizePhase2Markdown(markdown: string, options: BuildOptions = {}): SanitizeResult {
  const dropped: string[] = [];
  const drop: Drop = (kind, what) => {
    dropped.push(`${kind}: ${what.slice(0, 80)}`);
  };
  const lines = removeMarkup(markdown, drop)
    .split("\n")
    .map(line => buildLine(line, options, drop))
    .filter((line): line is string => line !== undefined);
  return {
    markdown: lines
      .join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    dropped
  };
}

/** A single line of model text (a correction, an old sentence, a title) through the same builder. */
function cleanFragment(text: string, mode: Mode, options: BuildOptions = {}): string {
  const drop: Drop = () => undefined;
  return inline(removeMarkup(text, drop).replace(/\n+/g, " "), mode, options, drop).trim();
}

// ---------- images ----------

export type ImageKind = "png" | "jpeg" | "gif" | "webp";

/** Looks at the first bytes, never at the extension or content type. */
export function imageKind(bytes: Uint8Array): ImageKind | undefined {
  const at = (offset: number, values: number[]): boolean =>
    values.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (bytes.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])))
    return "gif";
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return undefined;
}

export type ImageRejection = "too-large" | "empty" | "not-an-image";

/** Result of checking downloaded bytes: the detected kind, or why the file is refused. */
export function checkImageBytes(bytes: Uint8Array): { kind: ImageKind } | { rejected: ImageRejection } {
  if (bytes.length === 0) return { rejected: "empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { rejected: "too-large" };
  const kind = imageKind(bytes);
  return kind ? { kind } : { rejected: "not-an-image" };
}

const NO_LICENSE = /^(?:|n\/?a|none|unknown|unspecified|not specified|no license|無|未知|不明|未標示|未註明|未說明)$/i;

function usableHttps(value: string): boolean {
  return normalizeHttpsUrl(value) !== undefined;
}

export interface EligibleImages {
  eligible: Phase2Image[];
  rejected: { image: Phase2Image; reason: string }[];
}

/** Candidates that may be downloaded: https image and source page on public hosts, a stated license or credit, no duplicates, at most MAX_IMAGES. */
export function eligibleImages(images: readonly Phase2Image[], limit = MAX_IMAGES): EligibleImages {
  const eligible: Phase2Image[] = [];
  const rejected: { image: Phase2Image; reason: string }[] = [];
  const seen = new Set<string>();
  for (const image of images) {
    const reason = !usableHttps(String(image?.imageUrl ?? ""))
      ? "image-url"
      : !usableHttps(String(image?.sourceUrl ?? ""))
        ? "source-url"
        : NO_LICENSE.test(String(image?.license ?? "").trim())
          ? "license"
          : seen.has(image.imageUrl)
            ? "duplicate"
            : eligible.length >= limit
              ? "over-limit"
              : undefined;
    if (reason) rejected.push({ image, reason });
    else {
      seen.add(image.imageUrl);
      eligible.push(image);
    }
  }
  return { eligible, rejected };
}

// ---------- footnotes and corrections ----------

/** A footnote title as a link label: through the builder, so every bracket in it comes out escaped. */
function footnoteLabel(title: string): string {
  return cleanFragment(title, "plain");
}

/** "[^id]: [title](url)" lines for the footnotes whose id and address pass the gates; titles keep no markup. */
export function renderFootnoteDefinitions(footnotes: readonly Phase2Footnote[]): string {
  const lines: string[] = [];
  for (const note of footnotes) {
    const href = /^[\w-]+$/.test(note.id) ? normalizeHttpsUrl(note.url) : undefined;
    if (href) lines.push(`[^${note.id}]: [${footnoteLabel(note.title) || href.replace(/[[\]]/g, "")}](${href})`);
  }
  return lines.join("\n");
}

/** Body of the footnote that keeps a corrected sentence: "原本寫：…" plus the source when known. One line, built by the same builder. */
export function originalFootnote(original: string, sourceUrl?: string): string {
  const text = cleanFragment(original.replace(/\[\^[^\]]+\]/g, "").replace(/\s+/g, " "), "text", {
    footnoteIds: new Set()
  });
  const href = sourceUrl ? normalizeHttpsUrl(sourceUrl) : undefined;
  return `${ORIGINAL_PREFIX}${text}${href ? `（來源：${href}）` : ""}`;
}

function highestFootnote(text: string): number {
  let highest = 0;
  for (const match of text.matchAll(/\[\^(\d+)\]/g)) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** Shifts numeric footnote ids ([^1] and [^1]:) by `offset`, so appended text cannot collide with footnotes already in the note. */
export function offsetFootnotes(markdown: string, offset: number): string {
  return offset ? markdown.replace(/\[\^(\d+)\]/g, (_m, id: string) => `[^${Number(id) + offset}]`) : markdown;
}

export interface CorrectionResult {
  detail: string;
  /** Ids of the "原本寫" footnotes this call added. */
  addedFootnoteIds: string[];
  corrected: string[];
  removed: string[];
  unmatched: string[];
}

/** First place the sentence stands in the body; footnote definitions (where an earlier 原本寫 note lives) are not searched. */
function locate(detail: string, sentence: string): { start: number; end: number } | undefined {
  const wanted = sentence.trim();
  if (!wanted) return undefined;
  const pattern = new RegExp(wanted.split(/\s+/).map(escape).join("\\s+"), "g");
  for (const found of detail.matchAll(pattern)) {
    const lineStart = detail.lastIndexOf("\n", found.index - 1) + 1;
    if (!/^\s*\[\^[^\]]+\]:/.test(detail.slice(lineStart, found.index + 1)))
      return { start: found.index, end: found.index + found[0].length };
  }
  return undefined;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Applies the model's verdicts to the detail. An unsupported sentence with a correction is replaced by the correction plus a
 * footnote "原本寫：…" (added here when the model left it out); an unsupported sentence without one is removed.
 * Supported verdicts and sentences that cannot be found change nothing.
 */
export function applyCorrections(
  detail: string,
  verdicts: readonly Phase2Verdict[],
  options: BuildOptions = {}
): CorrectionResult {
  let text = detail.replace(/\r\n?/g, "\n");
  const corrected: string[] = [];
  const removed: string[] = [];
  const unmatched: string[] = [];
  const definitions: string[] = [];
  const addedFootnoteIds: string[] = [];
  let next = highestFootnote(text) + 1;
  for (const verdict of verdicts) {
    if (verdict.verdict !== "unsupported") continue;
    const found = locate(text, verdict.sentence);
    if (!found) {
      unmatched.push(verdict.sentence);
      continue;
    }
    // The correction is model text: it goes through the builder before it is placed. Nothing left of it means the sentence is removed.
    const correction = verdict.correction ? cleanFragment(verdict.correction, "text", options) : "";
    if (!correction) {
      const start = found.start;
      let end = found.end;
      while (end < text.length && /[ \t]/.test(text[end])) end++;
      text = text.slice(0, start) + text.slice(end);
      // A line left with nothing but its list or quote marker goes away with the sentence.
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = text.indexOf("\n", start) < 0 ? text.length : text.indexOf("\n", start);
      if (/^\s*(?:>\s*)*(?:[-*+]\s*|\d+[.)]\s*)?$/.test(text.slice(lineStart, lineEnd))) {
        text = text.slice(0, lineStart) + text.slice(Math.min(lineEnd + 1, text.length));
      }
      removed.push(verdict.sentence);
      continue;
    }
    const alreadyNoted = new RegExp(
      `\\[\\^[^\\]]+\\]:\\s*${escape(ORIGINAL_PREFIX)}\\s*${escape(
        verdict.sentence
          .trim()
          .replace(/\[\^[^\]]+\]/g, "")
          .replace(/\s+/g, " ")
          .slice(0, 24)
      )}`
    ).test(text);
    let replacement = correction;
    if (!alreadyNoted) {
      definitions.push(`[^${next}]: ${originalFootnote(verdict.sentence, verdict.sourceUrl)}`);
      addedFootnoteIds.push(String(next));
      replacement = `${correction}[^${next}]`;
      next++;
    }
    text = text.slice(0, found.start) + replacement + text.slice(found.end);
    corrected.push(verdict.sentence);
  }
  if (definitions.length) text = `${text.trimEnd()}\n\n${definitions.join("\n")}\n`;
  return { detail: text, addedFootnoteIds, corrected, removed, unmatched };
}

// ---------- write plan ----------

export type WriteMode = "replace" | "append" | "noop";
export interface WritePlan {
  mode: WriteMode;
  /** The complete new detail. For "append" the current detail is its exact prefix. */
  detail: string;
  /** Hash to store as research-written-hash: set when the AI owns the new detail ("replace"), undefined when the detail now holds user text. */
  writtenHash?: string;
}

export interface WritePlanInput {
  currentDetail: string;
  /** research-written-hash of the note; missing means the user owns the detail. */
  writtenHash?: string;
  phase2Detail: string;
}

/**
 * Phase-2 write rule. The detail is replaced only when it is empty or still equals what the AI wrote (same hash);
 * otherwise phase-2 text goes below the current text under 網路補充 and the current text stays byte for byte.
 */
export function planPhase2Write(input: WritePlanInput): WritePlan {
  const { currentDetail } = input;
  const phase2 = input.phase2Detail.replace(/\r\n?/g, "\n").trim();
  if (!phase2) return { mode: "noop", detail: currentDetail, writtenHash: input.writtenHash };
  const empty = normalize(currentDetail) === "";
  if (empty || (input.writtenHash !== undefined && input.writtenHash === detailHash(currentDetail))) {
    return { mode: "replace", detail: phase2, writtenHash: detailHash(phase2) };
  }
  const shifted = offsetFootnotes(phase2, highestFootnote(currentDetail));
  if (currentDetail.includes(shifted) || currentDetail.includes(phase2)) return { mode: "noop", detail: currentDetail };
  const separator = currentDetail.endsWith("\n\n") ? "" : currentDetail.endsWith("\n") ? "\n" : "\n\n";
  return { mode: "append", detail: `${currentDetail}${separator}${WEB_SUPPLEMENT_HEADING}\n\n${shifted}\n` };
}
