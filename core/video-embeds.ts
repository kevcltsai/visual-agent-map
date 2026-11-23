/**
 * YouTube embeds in a research note. Obsidian renders `![](https://www.youtube.com/watch?v=ID)` as a player, so a model that
 * invents an id would put a video it never saw into the note. Only a video whose page the provider really opened in this call stays
 * (and is written in the one form Obsidian documents); every other YouTube embed is removed. Plain links and embeds of other hosts
 * are left alone, and so is everything inside a code fence.
 */

const YOUTUBE_HOSTS: ReadonlySet<string> = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** `![alt](url)` or `![alt](<url> "title")`: the url is one run without spaces (or an angle-bracket one). */
const EMBED = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** The 11-character id of a YouTube watch, short, embed, shorts or live URL; null for anything else (also a look-alike host). */
export function youtubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined;
  if (host === "youtu.be") id = parts[0];
  else if (parts[0] === "watch") id = url.searchParams.get("v");
  else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) id = parts[1];
  return id && VIDEO_ID.test(id) ? id : null;
}

/** A host that is YouTube or dresses up as it (`youtube.com.evil.example`, `youtube-nocookie.com`): such an embed is never kept as it is. */
const looksLikeYoutube = (rawUrl: string): boolean => {
  try {
    const host = new URL(rawUrl.trim()).hostname.toLowerCase();
    return YOUTUBE_HOSTS.has(host) || host.split(".").some(label => label.startsWith("youtube") || label === "youtu");
  } catch {
    return false;
  }
};

/**
 * `detail` with only the YouTube embeds of pages in `openedUrls` kept (rewritten to `https://www.youtube.com/watch?v=ID`).
 * A video already embedded in `existingDetail` (the note this task rewrites: pasted by the user or kept by earlier research) stays too.
 */
export function keepOpenedVideoEmbeds(detail: string, openedUrls: readonly string[], existingDetail = ""): string {
  const opened = new Set<string>();
  for (const m of existingDetail.matchAll(EMBED)) {
    const id = youtubeVideoId(m[2] ?? m[3] ?? "");
    if (id) opened.add(id);
  }
  for (const url of openedUrls) {
    const id = youtubeVideoId(url);
    if (id) opened.add(id);
  }
  const lines = detail.split(/(\r?\n)/);
  let fence: string | null = null;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const eol = lines[i + 1] ?? "";
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      out.push(line, eol);
      continue;
    }
    if (mark) {
      fence = mark;
      out.push(line, eol);
      continue;
    }
    let touched = false;
    const next = line.replace(EMBED, (whole: string, alt: string, angled?: string, bare?: string) => {
      const url = angled ?? bare ?? "";
      if (!looksLikeYoutube(url)) return whole;
      touched = true;
      const id = youtubeVideoId(url);
      return id && opened.has(id) ? `![${alt}](https://www.youtube.com/watch?v=${id})` : "";
    });
    // A line that held only removed embeds goes entirely.
    if (touched && !next.trim()) continue;
    out.push(touched ? next.replace(/[ \t]+$/, "") : line, eol);
  }
  return out.join("");
}
