/**
 * Web sources a reply names that nobody saw (V3.3 #06, D5). A http(s) URL in the model's Detail that this run did not open and
 * that none of the run's inputs (the user's text, the reference documents, the previous Detail) already held is followed by
 * the note-language marker, so a reader can tell a link the run checked from one the model wrote from memory. A Quick run opens
 * nothing, so every URL it adds is marked by the same rule. A URL the previous Detail marked stays unknown until a run opens it.
 * Nothing is stored: the URLs are compared in memory only.
 *
 * Left alone: code (fenced or inline), images and embeds (`![](url)`, the video rules own those), HTML tags and reference
 * definitions (a marker there would break the syntax), and a URL already followed by the marker.
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
const TOKENS = new RegExp(
  [
    String.raw`(\`{3,}|~{3,})[\s\S]*?(?:\1|$(?![\s\S]))`, // fenced code
    String.raw`\`[^\`\n]*\``, // inline code
    String.raw`!\[[^\]\n]*\]\([^)\n]*\)`, // image or embed
    String.raw`^ {0,3}\[(?!\^)[^\]\n]+\]:[^\n]*`, // reference definition
    String.raw`\[[^\]\n]*\]\(\s*(?:<(https?:\/\/[^>\n]*)>|(${URL_BODY}))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`, // [text](url)
    String.raw`<(https?:\/\/[^>\s]+)>`, // autolink
    String.raw`<\/?[A-Za-z][^>\n]*>`, // HTML tag
    `(${URL_BODY})` // bare URL
  ].join("|"),
  "gim"
);

/** The http(s) URLs written anywhere in `text` (trailing punctuation is not part of one). */
export function webUrlsIn(text: string): string[] {
  return (text.match(BARE) ?? []).map(url => url.replace(TRAILING, ""));
}

/** Each URL of `text` outside code, images, tags and reference definitions, with whether `markers` already follow it. */
function eachUrl(
  text: string,
  markers: readonly string[],
  visit: (url: string, marked: boolean, match: string, tail: string) => string
): string {
  const follows = (rest: string): boolean => markers.some(item => rest.trimStart().startsWith(item));
  return text.replace(
    TOKENS,
    (match: string, _fence, angleLink, plainLink, autolink, bare, offset: number, whole: string) => {
      const after = whole.slice(offset + match.length);
      const linked = (angleLink ?? plainLink ?? autolink) as string | undefined;
      if (linked !== undefined) return visit(linked, follows(after), match, "");
      if (bare === undefined) return match;
      const url = (bare as string).replace(TRAILING, "");
      const tail = (bare as string).slice(url.length);
      return visit(url, follows(tail + after), url, tail);
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

/**
 * `detail` with `marker` after every URL whose {@link webUrlKey} is not among `known` (the opened URLs and the URLs of the run's
 * inputs). `markers` are the marker in every note language, so a URL that already carries one is not marked twice.
 */
export function markUnverifiedUrls(
  detail: string,
  known: readonly string[],
  marker: string,
  markers: readonly string[] = [marker]
): string {
  const seen = new Set(known.map(webUrlKey));
  return eachUrl(detail, markers, (url, marked, match, tail) =>
    seen.has(webUrlKey(url)) || marked ? match + tail : `${match} ${marker}${tail}`
  );
}
