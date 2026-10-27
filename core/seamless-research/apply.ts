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

// ---------- sanitizer ----------

const HTTPS_URL = /^https:\/\/[^\s<>"'`()]+$/i;

export function isHttpsUrl(value: string): boolean {
  if (!HTTPS_URL.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

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

/**
 * Keeps model markdown to an allowlist: https links only, no images (images arrive only as saved local copies), no raw HTML,
 * no javascript:/data:/file:/vbscript: text, no reference definitions that point anywhere but https.
 */
export function sanitizePhase2Markdown(markdown: string): SanitizeResult {
  const dropped: string[] = [];
  const drop = (kind: string, what: string): void => {
    dropped.push(`${kind}: ${what.slice(0, 80)}`);
  };
  let text = stripUnsafeCharacters(markdown.replace(/\r\n?/g, "\n"));
  // Images first, so a remote image never turns into a plain link: ![alt](url) and ![[embed]].
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, match => {
    drop("image", match);
    return "";
  });
  text = text.replace(/!\[\[[^\]]*\]\]/g, match => {
    drop("embed", match);
    return "";
  });
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, match => {
    drop("image", match);
    return "";
  });
  // Autolinks <https://x> keep the address; any other <...> is raw HTML.
  text = text.replace(/<(https:\/\/[^\s<>]+)>/gi, "$1");
  text = text.replace(/<!--[\s\S]*?-->/g, match => {
    drop("html", match);
    return "";
  });
  text = text.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, match => {
    drop("html", match);
    return "";
  });
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, match => {
    drop("html", match);
    return "";
  });
  // Inline links: keep the link only when the target is https, else keep the label.
  text = text.replace(
    /\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    (match, label: string, target: string) => {
      if (isHttpsUrl(target)) return match;
      drop("link", match);
      return label;
    }
  );
  // Reference definitions: [id]: url (not footnote definitions, whose body is text).
  text = text
    .split("\n")
    .filter(line => {
      const definition = /^\s*\[(?!\^)[^\]]+\]:\s*(\S+)/.exec(line);
      if (definition && !isHttpsUrl(definition[1].replace(/^<|>$/g, ""))) {
        drop("definition", line);
        return false;
      }
      return true;
    })
    .join("\n");
  // Bare dangerous schemes left in text (not inside a kept https link).
  text = text.replace(/\b(?:javascript|vbscript|data|file):[^\s)\]]*/gi, match => {
    drop("scheme", match);
    return "";
  });
  return {
    markdown: text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    dropped
  };
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

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return true;
  if (
    /^(?:127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  )
    return true;
  return (
    host === "::1" ||
    (host.startsWith("fc") && host.includes(":")) ||
    (host.startsWith("fd") && host.includes(":")) ||
    host.startsWith("fe80:")
  );
}

function usableHttps(value: string): URL | undefined {
  if (!isHttpsUrl(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || privateHost(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
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

/** "[^id]: [title](url)" lines for the footnotes whose address is https; titles lose characters that break a link label. */
export function renderFootnoteDefinitions(footnotes: readonly Phase2Footnote[]): string {
  return footnotes
    .filter(note => /^[\w-]+$/.test(note.id) && isHttpsUrl(note.url))
    .map(note => `[^${note.id}]: [${(note.title || note.url).replace(/[[\]\n]/g, " ").trim()}](${note.url})`)
    .join("\n");
}

/** Body of the footnote that keeps a corrected sentence: "原本寫：…" plus the source when known. One line. */
export function originalFootnote(original: string, sourceUrl?: string): string {
  const text = original
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${ORIGINAL_PREFIX}${text}${sourceUrl && isHttpsUrl(sourceUrl) ? `（來源：${sourceUrl}）` : ""}`;
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
export function applyCorrections(detail: string, verdicts: readonly Phase2Verdict[]): CorrectionResult {
  let text = detail.replace(/\r\n?/g, "\n");
  const corrected: string[] = [];
  const removed: string[] = [];
  const unmatched: string[] = [];
  const definitions: string[] = [];
  let next = highestFootnote(text) + 1;
  for (const verdict of verdicts) {
    if (verdict.verdict !== "unsupported") continue;
    const found = locate(text, verdict.sentence);
    if (!found) {
      unmatched.push(verdict.sentence);
      continue;
    }
    const correction = verdict.correction?.trim();
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
      replacement = `${correction}[^${next}]`;
      next++;
    }
    text = text.slice(0, found.start) + replacement + text.slice(found.end);
    corrected.push(verdict.sentence);
  }
  if (definitions.length) text = `${text.trimEnd()}\n\n${definitions.join("\n")}\n`;
  return { detail: text, corrected, removed, unmatched };
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
