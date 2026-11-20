/**
 * Deterministic picture-quality rules of the picture-book search (no I/O, no model call): the source of a picture is its file
 * description page, a picture for a named person's work is by that person, and the same work under two file names is one work.
 */

const WIKI_HOST = /(^|\.)(wikimedia|wikipedia)\.org$/i;
const FILE_PAGE = /^\/wiki\/(?:File|Image):[^/]+$/i;

/** Lowercase ASCII words: accents folded, every run of other characters one space. */
function plainWords(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A Wikimedia image address as its project and file name (decoded), from an upload/thumb address or a Special:FilePath link; undefined for any other address. */
export function wikimediaFile(imageUrl: string): { project: string; name: string } | undefined {
  let url: URL;
  try {
    url = new URL(imageUrl.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (/^(upload|thumb)\.wikimedia\.org$/.test(host) && parts[0] === "wikipedia" && parts.length >= 5) {
    const thumbAt = parts.indexOf("thumb");
    // /wikipedia/commons/thumb/a/ab/File.jpg/1280px-File.jpg: the file name is the segment before the sized one.
    const name = thumbAt === 2 && parts.length >= 7 ? parts[5] : parts[parts.length - 1];
    return { project: parts[1].toLowerCase(), name: decode(name) };
  }
  const filePath = /^\/wiki\/Special:FilePath\/([^/]+)$/i.exec(url.pathname);
  if (host === "commons.wikimedia.org" && filePath) return { project: "commons", name: decode(filePath[1]) };
  return undefined;
}

/** The file description page of a Wikimedia image (`commons.wikimedia.org/wiki/File:…`, or the wiki's own `File:` page for a local file). */
function filePageOf(imageUrl: string): string | undefined {
  const file = wikimediaFile(imageUrl);
  if (!file || !/^[a-z-]+$/.test(file.project)) return undefined;
  const host = file.project === "commons" ? "commons.wikimedia.org" : `${file.project}.wikipedia.org`;
  return `https://${host}/wiki/File:${encodeURIComponent(file.name.replace(/ /g, "_"))}`;
}

/**
 * The source rule: a picture's source is its file description page. A Wikimedia image whose source is any other page gets its file
 * page instead, and the author and license the finder read off that other page are dropped (only a file page is trusted for them).
 * A source on a Wikipedia or Wikimedia site that is not a file page, for an image whose file page cannot be told, drops the picture
 * (undefined). Any other image and source are kept as they are.
 */
export function fileSourceOf<T extends { url: string; source: string; author?: string; license?: string }>(
  candidate: T
): T | undefined {
  let source: URL;
  try {
    source = new URL(candidate.source);
  } catch {
    return undefined;
  }
  const wikiSource = WIKI_HOST.test(source.hostname);
  if (wikiSource && FILE_PAGE.test(source.pathname)) return candidate;
  const page = filePageOf(candidate.url);
  if (page) {
    const { author: _author, license: _license, ...rest } = candidate;
    return { ...rest, source: page } as T;
  }
  return wikiSource ? undefined : candidate;
}

/** The file name of a picture address (the Wikimedia file name, else the last path segment), decoded. */
function fileNameOf(imageUrl: string): string {
  const file = wikimediaFile(imageUrl);
  if (file) return file.name;
  try {
    const last = new URL(imageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

/**
 * The subject rule: when the finder named the person whose work a position must show, a candidate is kept only when it is by that
 * person. The author the finder read off the file page must name the person (by the person's last name); with no author, the file
 * name must name the person and must not credit another one (`… by X`, `… par X`). No subject: every candidate passes.
 */
export function bySubject(
  candidate: { url: string; title: string; author?: string },
  subject: string | undefined
): boolean {
  const who = plainWords(subject ?? "");
  if (!who) return true;
  const words = who.split(" ");
  // A Latin name is matched by its last name (`Henri Cartier-Bresson` -> `bresson`); another script by the whole name.
  const latin = /^[a-z0-9 ]+$/.test(who);
  const key = latin ? words[words.length - 1] : who;
  const names = (text: string): boolean =>
    latin ? ` ${plainWords(text)} `.includes(` ${key} `) : plainWords(text).includes(key);
  if (candidate.author?.trim()) return names(candidate.author);
  const file = fileNameOf(candidate.url)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/_/g, " ");
  const credit = /\b(?:by|par|von|di|por|door)\s+(.+)$/i.exec(file);
  if (credit && !names(credit[1])) return false;
  return names(file) || (!latin && names(candidate.title));
}

/** Words a file name carries that do not change the work: a crop or an edit, a size prefix, a long catalogue number. */
const EDIT_WORDS = /\b(?:cropped|crop|edited|edit|restored|retouched|retouch|cleaned|version|ver|v\d)\b/g;

/**
 * The identity of a work under any file name: the normalised file name stem plus the normalised author (`work:` + stem + `|` + author).
 * `Sir_Winston_Churchill_(cropped).jpg` and `Sir_Winston_Churchill_-_19086236948.jpg` by Yousuf Karsh are one work. Undefined when the
 * author is not known or the stem is too short to tell works apart (the address key still applies).
 */
export function workKey(imageUrl: string, author: string | undefined): string | undefined {
  const who = plainWords((author ?? "").replace(/\([^)]*\)/g, " "));
  if (!who) return undefined;
  const stem = plainWords(
    fileNameOf(imageUrl)
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/^\d+px-/i, "")
  )
    .replace(EDIT_WORDS, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stem.replace(/ /g, "").length < 4) return undefined;
  return `work:${stem}|${who}`;
}

/** A page of a document file (PDF, DjVu, TIFF scan) or a thumbnail made from one (`….pdf/page1-960px-….jpg`): never a book picture. */
export const isDocumentFile = (url: string): boolean => /\.(?:pdf|djvu?|tiff?)(?:[/?#]|$)|\/page\d+-\d*px-/i.test(url);
