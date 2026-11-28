/**
 * Web sources a reply names that nobody saw (V3.3 #06, D5). A http(s) URL in the model's Detail that this run did not open and
 * that none of the run's inputs (the user's text, the reference documents, the previous Detail) already held is followed by
 * the note-language marker, so a reader can tell a link the run checked from one the model wrote from memory. A Quick run opens
 * nothing, so every URL it adds is marked by the same rule. A URL the previous Detail marked stays unknown until a run opens it.
 * Nothing is stored: the URLs are compared in memory only.
 *
 * Left alone: code (fenced or inline), images and embeds (`![](url)`, the video rules own those), HTML tags and reference
 * definitions (a marker there would break the syntax), and a URL already followed by the marker. A marker never goes between a
 * link's `](` and its `)`: it follows the `)`, or is left out when the destination cannot be read. An HTML link
 * `<a href="url">text</a>` on one line is a link too: its marker follows the `</a>`, never inside the tag or the text; one without
 * a `</a>` on its line is left alone. A URL opened this run (or given by the user, the task or a reference) that still carries a
 * copied marker loses it.
 */

/** The same page under http and https, with or without a trailing slash or a fragment, is one URL. */
export function webUrlKey(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

// A URL run: no spaces, brackets or quotes; one level of balanced parentheses is part of it (Wikipedia `Foo_(bar)`).
const URL_BODY = String.raw`https?:\/\/(?:[^\s<>()[\]"'\`，。；：！？、（）「」『』【】《》]|\([^\s()]*\))+`;
const TRAILING = /[.,;:!?*_~]+$/;
const BARE = new RegExp(URL_BODY, "gi");
// Link text may hold one level of brackets (`[[PDF] Report](url)`).
const LINK_TEXT = String.raw`\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]`;
const TOKENS = new RegExp(
  [
    String.raw`(\`{3,}|~{3,})[\s\S]*?(?:\1|$(?![\s\S]))`, // fenced code
    String.raw`\`[^\`\n]*\``, // inline code
    String.raw`!${LINK_TEXT}\([^)\n]*\)`, // image or embed
    String.raw`^ {0,3}\[(?!\^)[^\]\n]+\]:[^\n]*`, // reference definition
    String.raw`${LINK_TEXT}\(\s*(?:<(https?:\/\/[^>\n]*)>|(${URL_BODY}))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`, // [text](url)
    // Any other [text](destination) up to its matching `)` (two levels of parentheses, quotes): the marker goes after the `)`.
    String.raw`${LINK_TEXT}\(((?:[^()\n]|\((?:[^()\n]|\([^()\n]*\))*\))*)\)`,
    String.raw`<(https?:\/\/[^>\s]+)>`, // autolink
    // <a href="url">text</a> on one line: the marker goes after the `</a>`.
    String.raw`<a\s(?:[^>\n]*?\s)?href\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')[^>\n]*>[^\n]*?<\/a\s*>`,
    String.raw`<\/?[A-Za-z][^>\n]*>`, // HTML tag
    `(${URL_BODY})` // bare URL
  ].join("|"),
  "gim"
);
// A bare URL that starts inside a link destination this file could not parse: never marked, so the link stays whole.
const IN_DESTINATION = /\]\(\s*<?[^\s)]*$/;

/** The http(s) URLs written anywhere in `text` (trailing punctuation is not part of one). */
export function webUrlsIn(text: string): string[] {
  return (text.match(BARE) ?? []).map(url => url.replace(TRAILING, ""));
}

/**
 * Each URL of `text` outside code, images, tags and reference definitions, with whether `markers` already follow it and the
 * offset in `text` where that marker would start.
 */
function eachUrl(
  text: string,
  markers: readonly string[],
  visit: (url: string, marked: boolean, match: string, tail: string, at: number) => string
): string {
  const follows = (rest: string): boolean => markers.some(item => rest.trimStart().startsWith(item));
  return text.replace(
    TOKENS,
    (
      match: string,
      _fence,
      angleLink,
      plainLink,
      destination,
      autolink,
      hrefDouble,
      hrefSingle,
      bare,
      offset: number,
      whole: string
    ) => {
      const after = whole.slice(offset + match.length);
      let linked = (angleLink ?? plainLink ?? autolink) as string | undefined;
      if (destination !== undefined) {
        const written = (destination as string).trim();
        const url = written.startsWith("<") ? written.slice(1).split(">")[0] : written.split(/\s+/)[0];
        if (!/^https?:\/\//i.test(url)) return match;
        linked = url;
      }
      const href = (hrefDouble ?? hrefSingle) as string | undefined;
      if (href !== undefined) {
        if (!/^https?:\/\//i.test(href.trim())) return match;
        linked = href.trim();
      }
      if (linked !== undefined) return visit(linked, follows(after), match, "", offset + match.length);
      if (bare === undefined) return match;
      const before = whole.slice(whole.lastIndexOf("\n", offset - 1) + 1, offset);
      if (IN_DESTINATION.test(before)) return match;
      const url = (bare as string).replace(TRAILING, "");
      const tail = (bare as string).slice(url.length);
      return visit(url, follows(tail + after), url, tail, offset + url.length);
    }
  );
}

/** The URLs of `text` that carry a marker: an earlier run could not vouch for them, so they are no known source. */
export function markedUrlsIn(text: string, markers: readonly string[]): string[] {
  const urls: string[] = [];
  eachUrl(text, markers, (url, marked, match, tail) => {
    if (marked) urls.push(url);
    return match + tail;
  });
  return urls;
}

/** The keys of `url`: its own and, when it holds a character a URL run stops at (`'`, nested parentheses), the run's. */
function keysOf(url: string): string[] {
  return [webUrlKey(url), webUrlKey(webUrlsIn(url)[0] ?? url)];
}

/**
 * `detail` with `marker` after every URL whose {@link webUrlKey} is not among `known` (the URLs of the run's inputs) or
 * `verified` (the opened URLs and the URLs the user, the task or a reference document gave). `markers` are the marker in every
 * note language, so a URL that already carries one is not marked twice; a `verified` URL that still carries one (copied from the
 * previous Detail) loses it.
 */
export function markUnverifiedUrls(
  detail: string,
  known: readonly string[],
  marker: string,
  markers: readonly string[] = [marker],
  verified: readonly string[] = []
): string {
  const good = new Set(verified.map(webUrlKey));
  const seen = new Set([...known, ...verified].map(webUrlKey));
  const stale: number[] = [];
  eachUrl(detail, markers, (url, marked, match, tail, at) => {
    if (marked && keysOf(url).some(key => good.has(key))) stale.push(at);
    return match + tail;
  });
  let text = detail;
  for (const at of stale.reverse()) {
    const space = /^[ \t]*/.exec(text.slice(at))?.[0] ?? "";
    const found = markers.find(item => text.startsWith(item, at + space.length));
    if (found) text = text.slice(0, at) + text.slice(at + space.length + found.length);
  }
  return eachUrl(text, markers, (url, marked, match, tail) =>
    marked || keysOf(url).some(key => seen.has(key)) ? match + tail : `${match} ${marker}${tail}`
  );
}
