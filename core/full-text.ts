/**
 * Full text of a file the user asked for ("把 SKILL.md 全文放進去"). The provider's page tool (Claude Code WebFetch) hands the
 * model a summary of the page, never its text, so the model cannot copy a file word for word. When a research request asks
 * for full text, the program fetches the raw file itself from the GitHub addresses the provider opened during that call and
 * puts it, unchanged, in a code block of the Detail. It never takes the model's copy for the original: when no raw file could
 * be fetched, the Detail says plainly that it holds a summary, not the original text.
 *
 * Trust boundary: only GitHub file addresses are fetched (an allowlist of hosts and URL shapes, https only), at most
 * {@link MAX_FILES} per call, each refused above {@link MAX_FILE_BYTES} or when it is not text. The fetched text is written only
 * inside a code fence longer than any backtick run in it, so it renders as inert text. The blocks are program-owned: before a
 * request they are taken out of the Detail the model sees ({@link splitFullText}) and after the reply the program puts them
 * back ({@link attachFullText}), so the model never reads the fetched text and cannot rewrite a block under the VAM label.
 */
import { escapeRegExp } from "./escape-regexp";
import { translateNote, type ContentLanguage, type TranslationKey } from "../i18n";
import type { FetchResponse } from "./argument-map/source-proof";
import type { TaskContext } from "../ai/types";

export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 200 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

/** Words that ask for the original text rather than a summary. */
const FULL_TEXT_WORDS = /全文|原文|逐字|完整原始|full[\s-]?text|verbatim|word[\s-]for[\s-]word/i;
/** A named file (`SKILL.md`, `config.yaml`) or a GitHub address: a full-text request is about a file, not a phrase like 「原文指出」. */
const NAMED_FILE =
  /[\w-]\.(?:md|markdown|mdx|txt|rst|ya?ml|json|toml|ini|cfg|csv|py|sh|ipynb)(?![\w./])|github(?:usercontent)?\.com\//i;

/**
 * True when the Detail already holds a VAM full-text block (as its placeholder), or when one of the topic's own fields both
 * names a file and asks for its full or original text. The fields are the title and the task, plus the current understanding
 * only before the first research (afterwards the AI writes it). Inherited rules are never read.
 */
export function wantsFullText(context: Pick<TaskContext, "title" | "summary" | "task" | "detail">): boolean {
  if (placeholderPattern().test(context.detail ?? "")) return true;
  const fields = [context.title, context.task, ...(context.detail?.trim() ? [] : [context.summary])];
  return fields.some(field => typeof field === "string" && FULL_TEXT_WORDS.test(field) && NAMED_FILE.test(field));
}

const GITHUB_PART = /^[A-Za-z0-9._-]+$/;

/**
 * The raw-file address of a GitHub file URL the provider opened, or undefined for every other address. Accepted:
 * raw.githubusercontent.com and gist.githubusercontent.com files, and github.com `/<owner>/<repo>/(blob|raw)/<ref>/<path>`.
 */
export function rawFileUrl(opened: string): string | undefined {
  let url: URL;
  try {
    url = new URL(opened);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com" || host === "gist.githubusercontent.com") {
    if (parts.length < 4) return undefined;
    return `https://${host}/${parts.join("/")}`;
  }
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, kind, ...rest] = parts;
    if (!owner || !repo || (kind !== "blob" && kind !== "raw") || rest.length < 2) return undefined;
    if (!GITHUB_PART.test(owner) || !GITHUB_PART.test(repo)) return undefined;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`;
  }
  return undefined;
}

export type FullTextFile =
  | { ok: true; url: string; name: string; text: string }
  | { ok: false; url: string; name: string; reason: "network" | "status" | "not_text" | "too_large" };

/** Obsidian `requestUrl` with a Range header, so the server sends at most one byte over the cap. */
export type FetchFile = (request: {
  url: string;
  method: "GET";
  throw: false;
  headers: Record<string, string>;
}) => Promise<FetchResponse>;

/** The file name shown in the note: decoded, then only letters, digits and `._ -` (no markup, links or line breaks). */
const nameOf = (url: string): string => {
  const last = url.split("/").pop() || url;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    /* A malformed escape keeps the raw segment. */
  }
  return decoded.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file";
};

/** Fetches each distinct raw GitHub file the provider opened (at most {@link MAX_FILES}); never throws. */
export async function fetchFullTexts(
  openedUrls: readonly string[],
  fetchPage: FetchFile,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<FullTextFile[]> {
  const raws = [...new Set(openedUrls.map(rawFileUrl).filter((url): url is string => !!url))].slice(0, MAX_FILES);
  return Promise.all(
    raws.map(async (url): Promise<FullTextFile> => {
      const name = nameOf(url);
      let timer: number | undefined;
      try {
        const response = await Promise.race([
          fetchPage({ url, method: "GET", throw: false, headers: { Range: `bytes=0-${MAX_FILE_BYTES}` } }),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error("timeout")), timeoutMs);
          })
        ]);
        // 206: the Range answer. A file over the cap arrives as cap + 1 bytes and is refused below; a server that ignores Range sends 200.
        if (response.status !== 200 && response.status !== 206) return { ok: false, url, name, reason: "status" };
        const type =
          Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
        // requestUrl gives the body size; a transport without it is judged by the text length (never more than the bytes).
        const bytes = response.arrayBuffer?.byteLength ?? (response.text ?? "").length;
        if (bytes > MAX_FILE_BYTES) return { ok: false, url, name, reason: "too_large" };
        const text = typeof response.text === "string" ? response.text : "";
        if (!/^text\//i.test(type.trim()) || text.includes("\u0000"))
          return { ok: false, url, name, reason: "not_text" };
        return { ok: true, url, name, text: text.replace(/\r\n?/g, "\n").replace(/\n+$/, "") };
      } catch {
        return { ok: false, url, name, reason: "network" };
      } finally {
        if (timer) window.clearTimeout(timer);
      }
    })
  );
}

const LANGUAGES: ContentLanguage[] = ["zh-TW", "zh-CN", "en"];
const alternatives = (key: TranslationKey): string =>
  LANGUAGES.map(language => escapeRegExp(translateNote(language, key, "\u0000")).replace("\u0000", "[^\\n]*")).join(
    "|"
  );

/** A block VAM wrote: heading, origin line with the address, blank line, fence … closing fence. */
const blockPattern = (): RegExp =>
  new RegExp(
    `^#### (?:${alternatives("detail.full_text_heading")})\\n(?:${alternatives("detail.full_text_origin")})\\n\\n(\`{4,})[^\\n]*\\n[\\s\\S]*?\\n\\1[ \\t]*$`,
    "gm"
  );
const noticePattern = (): RegExp => new RegExp(`^(?:${alternatives("detail.full_text_missing_prefix")})[^\\n]*$`, "gm");
const placeholderPattern = (): RegExp =>
  new RegExp(`^(?:${alternatives("detail.full_text_placeholder")})[ \\t]*$`, "gm");

export interface PriorFullText {
  url: string;
  block: string;
}

const tidy = (detail: string): string => detail.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");

/**
 * The Detail as the model may see it: each VAM full-text block becomes a one-line placeholder and each "not retrieved" notice
 * is dropped. The blocks are returned so {@link attachFullText} can put them back after the reply.
 */
export function splitFullText(
  detail: string,
  language: ContentLanguage
): { detail: string; blocks: PriorFullText[]; notices: number } {
  const blocks: PriorFullText[] = [];
  let notices = 0;
  const stripped = detail
    .replace(blockPattern(), block => {
      const url = /https:\/\/\S+/.exec(block.split("\n")[1] ?? "")?.[0] ?? "";
      const name = url ? nameOf(url) : "file";
      blocks.push({ url, block });
      return translateNote(language, "detail.full_text_placeholder", name);
    })
    .replace(noticePattern(), () => {
      notices++;
      return "";
    });
  return { detail: blocks.length || notices ? tidy(stripped) : detail, blocks, notices };
}

function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  return "`".repeat(Math.max(4, longest + 1));
}

function block(file: Extract<FullTextFile, { ok: true }>, language: ContentLanguage): string {
  const marks = fence(file.text);
  const lang = /\.(md|markdown)$/i.test(file.name) ? "markdown" : "";
  return [
    `#### ${translateNote(language, "detail.full_text_heading", file.name)}`,
    translateNote(language, "detail.full_text_origin", file.url),
    "",
    `${marks}${lang}`,
    file.text,
    marks
  ].join("\n");
}

/** Where the full text goes: inside the section for original text, else before the sources section, else at the end. */
function insert(detail: string, addition: string): string {
  const lines = detail.split("\n");
  const original = lines.findIndex(line => /^###\s+.*(原文|Source text)/i.test(line));
  if (original >= 0) {
    let end = lines.findIndex((line, index) => index > original && /^###\s/.test(line));
    if (end < 0) end = lines.length;
    while (end > original + 1 && !lines[end - 1].trim()) end--;
    return [...lines.slice(0, end), "", addition, ...(end < lines.length ? ["", ...lines.slice(end)] : [])].join("\n");
  }
  const sources = lines.findIndex(line => /^###\s+(出處|出处|來源|来源|Sources?)\s*$/i.test(line));
  if (sources >= 0) return [...lines.slice(0, sources), addition, "", ...lines.slice(sources)].join("\n");
  return `${detail.replace(/\s+$/, "")}\n\n${addition}`;
}

/**
 * The reply's Detail with the full text put back by the program: what the model wrote under the VAM label, any placeholder and
 * any notice are removed; then the files fetched this time, the earlier blocks this run did not replace, and, for a full-text
 * request that has neither, a notice that the note holds a summary and not the original text.
 */
export function attachFullText(
  detail: string,
  files: readonly FullTextFile[],
  language: ContentLanguage,
  prior: readonly PriorFullText[] = [],
  requested = true
): string {
  const stripped = detail.replace(blockPattern(), "").replace(noticePattern(), "").replace(placeholderPattern(), "");
  const fetched = files.filter((file): file is Extract<FullTextFile, { ok: true }> => file.ok);
  const failed = files.filter((file): file is Extract<FullTextFile, { ok: false }> => !file.ok);
  const replaced = new Set(fetched.map(file => file.url));
  const kept = prior.filter(item => !replaced.has(item.url));
  const keptUrls = new Set(kept.map(item => item.url));
  const parts = [...fetched.map(file => block(file, language)), ...kept.map(item => item.block)];
  const prefix = translateNote(language, "detail.full_text_missing_prefix");
  if (requested && !parts.length) {
    const why = failed.length
      ? failed.map(file => translateNote(language, `detail.full_text_reason_${file.reason}`, file.name)).join("；")
      : translateNote(language, "detail.full_text_reason_no_url");
    parts.push(`${prefix}${translateNote(language, "detail.full_text_missing", why)}`);
  } else {
    for (const file of failed)
      if (!keptUrls.has(file.url))
        parts.push(`${prefix}${translateNote(language, `detail.full_text_reason_${file.reason}`, file.name)}`);
  }
  if (!parts.length) return stripped === detail ? detail : tidy(stripped);
  return insert(tidy(stripped), parts.join("\n\n"));
}
