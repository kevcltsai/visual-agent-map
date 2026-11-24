/**
 * YouTube embeds in a research note. Obsidian renders `![](https://www.youtube.com/watch?v=ID)` as a player, so a model that
 * invents an id would put a video it never saw into the note. Only a video whose page the provider really opened in this call stays
 * (and is written in the one form Obsidian documents); every other YouTube embed is removed. An embed is `![](url)`, an
 * `<iframe|embed|object>` tag, or a reference definition that an `![alt][ref]` image uses. Plain links and embeds of other hosts
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

/** The plain YouTube video urls written in `text` (what a user pasted), in order; trailing punctuation is not part of a url. */
export function videoUrlsInText(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"'()[\]]+/gi) ?? [])
    .map(url => url.replace(/[.,;:!?，。；：！？、]+$/u, ""))
    .filter(url => youtubeVideoId(url) !== null);
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

/** An `<iframe>`, `<embed>` or `<object>` opening tag (possibly over several lines), with an immediate closing tag of an iframe or object. */
const HTML_EMBED = /<(iframe|embed|object)\b[^>]*>(?:\s*<\/\1\s*>)?/gi;
const HTML_SOURCE = /\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** `[label]: url "title"` on a line of its own. */
const DEFINITION =
  /^( {0,3}\[([^\]\n]+)\]:[ \t]*)(?:<([^>\n]*)>|(\S+))((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*)$/;
/** `![alt][ref]`, `![ref][]`; a shortcut `![ref]` is read apart (it must not be followed by `(` or `[`). */
const IMAGE_REFERENCE = /!\[([^\]\n]*)\]\[([^\]\n]*)\]|!\[([^\]\n]+)\](?![([])/g;
const REMOVED = "\u0000";
const labelKey = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase();
const htmlSource = (tag: string): string => {
  const m = HTML_SOURCE.exec(tag);
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  return raw.startsWith("//") ? `https:${raw}` : raw;
};

/** Every YouTube id an embed of any of the forms names in `text` (an existing note: what was already there stays). */
function embeddedIds(text: string): Set<string> {
  const ids = new Set<string>();
  const add = (url: string): void => {
    const id = youtubeVideoId(url);
    if (id) ids.add(id);
  };
  for (const m of text.matchAll(EMBED)) add(m[2] ?? m[3] ?? "");
  for (const m of text.matchAll(HTML_EMBED)) add(htmlSource(m[0]));
  for (const line of text.split(/\r?\n/)) {
    const d = DEFINITION.exec(line);
    if (d) add(d[3] ?? d[4] ?? "");
  }
  return ids;
}

/** `text` (no code fence in it) with every YouTube video reference of the three forms kept or removed; a removal leaves a NUL. */
function filterText(text: string, opened: ReadonlySet<string>): string {
  const watch = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
  let out = text.replace(HTML_EMBED, (whole: string) => {
    const url = htmlSource(whole);
    if (!looksLikeYoutube(url)) return whole;
    const id = youtubeVideoId(url);
    return id && opened.has(id) ? `![](${watch(id)})` : REMOVED;
  });
  out = out.replace(EMBED, (whole: string, alt: string, angled?: string, bare?: string) => {
    const url = angled ?? bare ?? "";
    if (!looksLikeYoutube(url)) return whole;
    const id = youtubeVideoId(url);
    return id && opened.has(id) ? `![${alt}](${watch(id)})` : REMOVED;
  });
  // Reference definitions that an image uses: kept (rewritten) when the id is allowed, else the definition and its uses go.
  const imageLabels = new Set<string>();
  for (const m of out.matchAll(IMAGE_REFERENCE)) imageLabels.add(labelKey(m[2] ? m[2] : (m[1] ?? m[3] ?? "")));
  const dropped = new Set<string>();
  const lines = out.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const d = DEFINITION.exec(lines[i] ?? "");
    if (!d || !imageLabels.has(labelKey(d[2] ?? ""))) continue;
    const url = d[3] ?? d[4] ?? "";
    if (!looksLikeYoutube(url)) continue;
    const id = youtubeVideoId(url);
    if (id && opened.has(id)) lines[i] = `${d[1]}${watch(id)}${d[5] ?? ""}`;
    else {
      lines[i] = REMOVED;
      dropped.add(labelKey(d[2] ?? ""));
    }
  }
  out = lines.join("");
  if (dropped.size)
    out = out.replace(
      IMAGE_REFERENCE,
      (whole: string, alt: string | undefined, ref: string | undefined, short?: string) =>
        dropped.has(labelKey(ref ? ref : (alt ?? short ?? ""))) ? REMOVED : whole
    );
  return out;
}

/**
 * `detail` with only the YouTube embeds of pages in `openedUrls` kept (rewritten to `https://www.youtube.com/watch?v=ID`).
 * A video already embedded in `existingDetail` (the note this task rewrites: pasted by the user or kept by earlier research) stays too.
 */
export function keepOpenedVideoEmbeds(detail: string, openedUrls: readonly string[], existingDetail = ""): string {
  const opened = embeddedIds(existingDetail);
  for (const url of openedUrls) {
    const id = youtubeVideoId(url);
    if (id) opened.add(id);
  }
  const lines = detail.split(/(\r?\n)/);
  let fence: string | null = null;
  // Text between fences is filtered as one piece (an HTML tag can span lines); a fence's own lines are copied.
  const out: string[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (!pending.length) return;
    const filtered = filterText(pending.join(""), opened);
    if (!filtered.includes(REMOVED)) out.push(filtered);
    else {
      const parts = filtered.split(/(\r?\n)/);
      for (let i = 0; i < parts.length; i += 2) {
        const line = parts[i] ?? "";
        const eol = parts[i + 1] ?? "";
        if (!line.includes(REMOVED)) {
          out.push(line, eol);
          continue;
        }
        const rest = line.split(REMOVED).join("");
        // A line that held only removed embeds goes entirely, also a list item left with only its marker.
        if (!rest.trim() || /^\s*(?:[-*+]|\d+[.)])\s*$/.test(rest)) continue;
        out.push(rest.replace(/[ \t]+$/, ""), eol);
      }
    }
    pending = [];
  };
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const eol = lines[i + 1] ?? "";
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      out.push(line, eol);
    } else if (mark) {
      flush();
      fence = mark;
      out.push(line, eol);
    } else pending.push(line, eol);
  }
  flush();
  return out.join("");
}

/** Whether a video can be played: true, false (private, deleted or embedding off), or null when that cannot be told (offline, timeout). */
export type VideoPlayableCheck = (id: string, signal?: AbortSignal) => Promise<boolean | null>;

/**
 * `detail` without the YouTube embeds that `check` says are unplayable. Only ids that are new (not in `existingDetail`, which is the
 * user's own choice) are asked, all at once, plus the ids in `alsoCheck` (restored from the old note, so not the user's choice now);
 * null (cannot tell) or a thrown error keeps the embed, so no content is lost to a network error.
 */
export async function dropUnplayableVideos(
  detail: string,
  existingDetail: string | undefined,
  check: VideoPlayableCheck | undefined,
  signal?: AbortSignal,
  alsoCheck: ReadonlySet<string> = new Set()
): Promise<string> {
  if (!check) return detail;
  const existing = embeddedIds(existingDetail ?? "");
  const all = [...embeddedIds(detail)];
  const ids = all.filter(id => !existing.has(id) || alsoCheck.has(id));
  if (!ids.length) return detail;
  const verdicts = await Promise.all(ids.map(id => check(id, signal).catch(() => null)));
  const bad = new Set(ids.filter((_, i) => verdicts[i] === false));
  if (!bad.size) return detail;
  const good = all.filter(id => !bad.has(id)).map(id => `https://www.youtube.com/watch?v=${id}`);
  return keepOpenedVideoEmbeds(detail, good);
}

const UPDATE_LOG_HEADING = /^(#{1,6})[ \t]+.*(?:更新紀錄|更新记录|Update log)/i;
const MD_LINK = /(?<!!)\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/;
const HTML_LINK = /<a\b[^>]*>[\s\S]*?<\/a\s*>/i;
const watchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

/** `text` cut into [isFence, piece] runs; a piece keeps its line ends. */
function fenceSegments(text: string): Array<[boolean, string]> {
  const lines = text.split(/(\r?\n)/);
  const out: Array<[boolean, string]> = [];
  let fence: string | null = null;
  const push = (isFence: boolean, piece: string): void => {
    const last = out[out.length - 1];
    if (last && last[0] === isFence) last[1] += piece;
    else out.push([isFence, piece]);
  };
  for (let i = 0; i < lines.length; i += 2) {
    const piece = (lines[i] ?? "") + (lines[i + 1] ?? "");
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i] ?? "")?.[1];
    if (fence) {
      push(true, piece);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    } else if (mark) {
      fence = mark;
      push(true, piece);
    } else push(false, piece);
  }
  return out;
}

/** The embeds an old note has outside code fences: YouTube ids with their alt text, and non-YouTube images in order. */
function mediaOf(text: string): { videos: Map<string, string>; images: Array<{ alt: string; url: string }> } {
  const videos = new Map<string, string>();
  const images: Array<{ alt: string; url: string }> = [];
  for (const [isFence, piece] of fenceSegments(text)) {
    if (isFence) continue;
    for (const m of piece.matchAll(EMBED)) {
      const url = m[2] ?? m[3] ?? "";
      const id = youtubeVideoId(url);
      if (id) {
        if (!videos.has(id)) videos.set(id, m[1] ?? "");
      } else if (url && !looksLikeYoutube(url)) images.push({ alt: m[1] ?? "", url });
    }
    for (const id of embeddedIds(piece)) if (!videos.has(id)) videos.set(id, "");
  }
  return { videos, images };
}

/**
 * Research rewrites a note and may drop its videos and pictures. Puts back what the old note had and `detail` lost: a YouTube link
 * (`[t](url)` or `<a href>`) turns back into the embed, an embed with no trace is added again, and an image whose url is nowhere in
 * `detail` is added again. Added lines go in their own paragraphs before the update log, or at the end. `detail` is returned
 * unchanged when nothing is missing.
 */
export function restoreDroppedMedia(detail: string, existingDetail: string): { detail: string; restoredVideoIds: Set<string> } {
  const restoredVideoIds = new Set<string>();
  const old = mediaOf(existingDetail);
  if (!old.videos.size && !old.images.length) return { detail, restoredVideoIds };
  const present = embeddedIds(detail);
  let segments = fenceSegments(detail);
  const added: string[] = [];
  for (const [id, alt] of old.videos) {
    if (present.has(id)) continue;
    let converted = false;
    segments = segments.map(([isFence, piece]) => {
      if (isFence || converted) return [isFence, piece];
      let out = piece;
      const md = new RegExp(MD_LINK.source, "g");
      for (const m of piece.matchAll(md)) {
        if (youtubeVideoId(m[2] ?? m[3] ?? "") !== id) continue;
        out = `${piece.slice(0, m.index)}![${m[1] ?? ""}](${watchUrl(id)})${piece.slice((m.index ?? 0) + m[0].length)}`;
        converted = true;
        break;
      }
      if (!converted) {
        const html = new RegExp(HTML_LINK.source, "gi");
        for (const m of piece.matchAll(html)) {
          if (youtubeVideoId(htmlHref(m[0])) !== id) continue;
          const text = m[0].replace(/<[^>]*>/g, "").trim();
          out = `${piece.slice(0, m.index)}![${text.replace(/[[\]\n]/g, " ")}](${watchUrl(id)})${piece.slice((m.index ?? 0) + m[0].length)}`;
          converted = true;
          break;
        }
      }
      return [isFence, out];
    });
    if (!converted) added.push(`![${alt}](${watchUrl(id)})`);
    restoredVideoIds.add(id);
  }
  const text = segments.map(s => s[1]).join("");
  const seen = new Set<string>();
  for (const { alt, url } of old.images) {
    if (text.includes(url) || seen.has(url)) continue;
    seen.add(url);
    added.push(`![${alt}](${url})`);
  }
  if (!restoredVideoIds.size && !added.length) return { detail, restoredVideoIds };
  if (!added.length) return { detail: text, restoredVideoIds };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const parts = text.split(/(\r?\n)/);
  let at = text.length;
  let offset = 0;
  let fence: string | null = null;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? "";
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    } else if (mark) fence = mark;
    else if (UPDATE_LOG_HEADING.test(line)) {
      at = offset;
      break;
    }
    offset += line.length + (parts[i + 1] ?? "").length;
  }
  let head = text.slice(0, at);
  const rest = text.slice(at);
  if (head) head = head.replace(/(?:\r?\n)*$/, "") + eol + eol;
  const block = added.join(eol + eol) + eol;
  return { detail: head + block + (rest ? eol + rest : ""), restoredVideoIds };
}

const htmlHref = (tag: string): string => {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
};
