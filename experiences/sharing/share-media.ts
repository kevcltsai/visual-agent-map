/**
 * Media a note embeds (video, audio, frame, embed, object) is never carried into a shared file. Each one becomes a link
 * card (`<a class="vam-media-link" href="<https address>">Video: host</a>`); a source that is not http(s)
 * (`javascript:`, `file:`, `data:`, `app:` ...) becomes visible text with no link, so the reader sees that something was
 * there. Runs on the renderer's output before the sanitizer. No imports of Obsidian, so a unit test can load it directly.
 */

export const MEDIA_LINK_CLASS = "vam-media-link";

export type MediaKind = "video" | "audio" | "embed";

export interface MediaLabels {
  /** The label of a media item: `kind` and the host (or the address's scheme for a source that is not a web address). */
  label(kind: MediaKind, host: string): string;
}

const MEDIA_TAGS = new Set(["iframe", "video", "audio", "embed", "object"]);
const kindOf = (tag: string): MediaKind => (tag === "video" ? "video" : tag === "audio" ? "audio" : "embed");

const elementsOf = (parent: Element): Element[] =>
  Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1);

function sourceOf(element: Element): string {
  const own = element.getAttribute(element.localName.toLowerCase() === "object" ? "data" : "src") ?? "";
  if (own.trim()) return own.trim();
  for (const source of elementsOf(element))
    if (source.localName.toLowerCase() === "source" && (source.getAttribute("src") ?? "").trim())
      return (source.getAttribute("src") ?? "").trim();
  return "";
}

/** `https` address (and its host without `www.`) of a media source; null when it is not a plain web address. */
function webSource(raw: string): { href: string; host: string } | null {
  if (/[\p{Cc}\s]/u.test(raw)) return null;
  const text = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { href: url.href, host: url.hostname.replace(/^www\./i, "") };
  } catch {
    return null;
  }
}

/** The label's host part for a source that is not a web address: its scheme, or nothing. */
function otherHost(raw: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw.replace(/[\p{Cc}\s]/gu, ""));
  return match ? match[1].toLowerCase() : "";
}

/** Replaces every media element under `root`; returns how many. `create` makes the new elements (the platform's `createEl`). */
export function replaceMediaWithLinks(
  root: Element,
  labels: MediaLabels,
  create: (tag: "a" | "span") => Element
): number {
  let count = 0;
  const visit = (parent: Element): void => {
    for (const child of elementsOf(parent)) {
      const tag = child.localName.toLowerCase();
      if (!MEDIA_TAGS.has(tag)) {
        visit(child);
        continue;
      }
      const raw = sourceOf(child);
      const web = webSource(raw);
      const kind = kindOf(tag);
      let replacement: Element;
      if (web) {
        replacement = create("a");
        replacement.setAttribute("class", MEDIA_LINK_CLASS);
        replacement.setAttribute("href", web.href);
        replacement.append(root.ownerDocument.createTextNode(labels.label(kind, web.host)));
      } else {
        replacement = create("span");
        replacement.setAttribute("class", "vam-media-text");
        replacement.append(root.ownerDocument.createTextNode(labels.label(kind, otherHost(raw))));
      }
      child.replaceWith(replacement);
      count++;
    }
  };
  visit(root);
  return count;
}
