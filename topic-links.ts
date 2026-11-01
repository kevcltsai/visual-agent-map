/** Topic links kept in a note's frontmatter (`topic-links`, a list of URL strings). Only http(s) URLs are shown or opened. */
export const TOPIC_LINKS_MAX = 20;
export const TOPIC_LINK_MAX_LENGTH = 2048;

/**
 * The normalized `URL.href` of an http(s) address, or null. The text is trimmed; control characters and inner
 * whitespace, a missing host, credentials and anything over the length limit are refused. Other schemes never pass.
 */
export function normalizeTopicLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > TOPIC_LINK_MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(text)) return null;
  // The URL parser repairs "http:/x" and "http:\\x"; the stored text must spell the scheme and both slashes itself.
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if (url.href.length > TOPIC_LINK_MAX_LENGTH) return null;
  return url.href;
}

/** Links read from note frontmatter: valid, deduplicated by href, in stored order, at most 20. A single string is a one-item list. */
export function readTopicLinks(fm: Record<string, unknown>): string[] {
  const raw = fm["topic-links"];
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const href = normalizeTopicLink(item);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= TOPIC_LINKS_MAX) break;
  }
  return out;
}

export type AddTopicLinkResult =
  { ok: true; next: string[] } | { ok: false; reason: "invalid" | "duplicate" | "too-many" };

/** The list to write after adding `input`; values this version does not understand stay as they are. */
export function addTopicLink(raw: unknown, input: string): AddTopicLinkResult {
  const href = normalizeTopicLink(input);
  if (!href) return { ok: false, reason: "invalid" };
  const current: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  const valid = readTopicLinks({ "topic-links": current });
  if (valid.includes(href)) return { ok: false, reason: "duplicate" };
  if (valid.length >= TOPIC_LINKS_MAX) return { ok: false, reason: "too-many" };
  return { ok: true, next: [...current, href] as string[] };
}

/**
 * The list to write after removing the item at `index` of the stored list when it still normalizes to `href`
 * (otherwise the list changed under the caller and nothing is removed). Null means remove the key.
 */
export function removeTopicLink(raw: unknown, index: number, href: string): string[] | null {
  const current: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  const next = normalizeTopicLink(current[index]) === href ? current.filter((_, i) => i !== index) : current;
  return next.length ? (next as string[]) : null;
}
