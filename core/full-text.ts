/**
 * Full text of a file the user asked for ("把 SKILL.md 全文放進去"). The provider's page tool (Claude Code WebFetch) hands the
 * model a summary of the page, never its text, so the model cannot copy a file word for word. When a research request asks
 * for full text, the program fetches the raw file itself from the GitHub addresses the provider opened during that call and
 * puts it, unchanged, in a code block of the Detail. It never takes the model's copy for the original: when no raw file could
 * be fetched, the Detail says plainly that it holds a summary, not the original text.
 *
 * Trust boundary: only GitHub file addresses are fetched (an allowlist of hosts and URL shapes, https only), at most
 * {@link MAX_FILES} per call, each refused above {@link MAX_FILE_BYTES} or when it is not text. The fetched text is never sent
 * to the model and is written only inside a code fence longer than any backtick run in it, so it renders as inert text.
 */
import { translateNote, type ContentLanguage } from "../i18n";
import type { FetchResponse } from "./argument-map/source-proof";
import type { TaskContext } from "../ai/types";

export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 200 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

/** Words that ask for the original text rather than a summary, in the request fields the user wrote. */
const FULL_TEXT_WORDS = /全文|原文|逐字|完整原始|full[\s-]?text|verbatim|word[\s-]for[\s-]word/i;

/** True when the topic's own words (title, current understanding, task, topic rules) ask for the full or original text. */
export function wantsFullText(context: Pick<TaskContext, "title" | "summary" | "task" | "rules">): boolean {
  return [context.title, context.summary, context.task, context.rules].some(
    field => typeof field === "string" && FULL_TEXT_WORDS.test(field)
  );
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

const nameOf = (url: string): string => {
  const last = url.split("/").pop() || url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
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
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes the blocks and notices an earlier run put in, so a re-research keeps exactly one current copy. */
function withoutPriorFullText(detail: string): string {
  const heads = LANGUAGES.map(language => escapeRegExp(translateNote(language, "detail.full_text_heading", "")));
  const missing = LANGUAGES.map(language => escapeRegExp(translateNote(language, "detail.full_text_missing_prefix")));
  return detail
    .replace(
      new RegExp(
        `^#### (?:${heads.join("|")})[^\\n]*\\n[^\\n]*\\n\\n(\`{4,})[^\\n]*\\n[\\s\\S]*?\\n\\1[ \\t]*(?:\\n|$)\\n?`,
        "gm"
      ),
      ""
    )
    .replace(new RegExp(`^(?:${missing.join("|")})[^\\n]*(?:\\n|$)\\n?`, "gm"), "");
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
 * The Detail with the fetched files written in word for word, or, when none could be fetched, with a notice that the note
 * holds a summary and not the original text. Earlier copies and notices are replaced.
 */
export function attachFullText(detail: string, files: readonly FullTextFile[], language: ContentLanguage): string {
  const base = withoutPriorFullText(detail);
  const fetched = files.filter((file): file is Extract<FullTextFile, { ok: true }> => file.ok);
  const failed = files.filter((file): file is Extract<FullTextFile, { ok: false }> => !file.ok);
  const parts = fetched.map(file => block(file, language));
  if (!fetched.length) {
    const why = failed.length
      ? failed.map(file => translateNote(language, `detail.full_text_reason_${file.reason}`, file.name)).join("；")
      : translateNote(language, "detail.full_text_reason_no_url");
    parts.push(
      `${translateNote(language, "detail.full_text_missing_prefix")}${translateNote(language, "detail.full_text_missing", why)}`
    );
  } else {
    for (const file of failed)
      parts.push(
        `${translateNote(language, "detail.full_text_missing_prefix")}${translateNote(language, `detail.full_text_reason_${file.reason}`, file.name)}`
      );
  }
  return insert(base, parts.join("\n\n"));
}
