/**
 * Links from one note of a shared map to another note of the same map (`[[Other note]]` where Other note is a card).
 * The cleaner cannot emit an `<a>` (it writes Markdown, and the sanitizer would rewrite it), so it marks the text with
 * three private-use characters; after sanitize and scrub the exporter turns each mark into
 * `<a class="vam-node-link" href="#vam-node-<id>">` with exactly those two attributes. The author's own text never
 * carries the marks (they are stripped from every input first), so nobody can forge a link by typing them.
 * No imports of Obsidian, so a unit test can load it directly.
 */

import { socialVideoOf } from "../../core/social-video";

export const NODE_LINK_START = "\uE000";
export const NODE_LINK_MID = "\uE001";
export const NODE_LINK_END = "\uE002";
/** Starts a mark for a file attachment (a card, not a link to a note): `ATTACHMENT_START label MID name END`. */
export const ATTACHMENT_START = "\uE003";
/** Starts the text of a YouTube link the cleaner wrote (`[VIDEO ▶ title](url)`): the viewer may turn it into a click-to-play card. Author-written links never carry it. */
export const VIDEO_MARK = "\uE004";
export const VIDEO_LINK_CLASS = "vam-video-link";
export const ATTACHMENT_CLASS = "vam-attachment-card";
export const ATTACHMENT_HREF_PREFIX = "#vam-attachment-";
export const NODE_LINK_CLASS = "vam-node-link";
export const NODE_LINK_HREF_PREFIX = "#vam-node-";

const MARKS = /[\uE000-\uE004]/g;
const HAS_MARK = /[\uE000-\uE004]/;
const MARKED = /([\uE000\uE003])([^\uE000-\uE004]*)\uE001([^\uE000-\uE004]*)\uE002/g;
/** The ids a link may carry; anything else stays plain text (the viewer looks the id up in the file, so this is about the attribute value only). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Text with the five marks removed: what every author input and every title goes through before a mark is added. */
export const stripNodeLinkMarks = (text: string): string => text.replace(MARKS, "");

/** `text` wrapped in a mark for node `id`; the text unchanged when the id cannot be a link target. */
export function markNodeLink(id: string, text: string): string {
  const plain = stripNodeLinkMarks(text);
  return SAFE_ID.test(id) ? `${NODE_LINK_START}${plain}${NODE_LINK_MID}${id}${NODE_LINK_END}` : plain;
}

/** `label` (a file's basename) wrapped in a mark for attachment `name`; the label alone when the name cannot be an attribute value. */
export function markAttachment(name: string, label: string): string {
  const plain = stripNodeLinkMarks(label);
  return SAFE_ID.test(name) ? `${ATTACHMENT_START}${plain}${NODE_LINK_MID}${name}${NODE_LINK_END}` : plain;
}

const textOf = (node: Node): string =>
  node.nodeType === 3 ? (node.nodeValue ?? "") : Array.from(node.childNodes).map(textOf).join("");

/**
 * Turns the marks in the text of `root` into links to the nodes in `knownIds` and, for attachment marks, cards for the
 * names in `knownAttachments` (`<a class="vam-attachment-card" href="#vam-attachment-<name>">`, text = the file's basename). A mark for an unknown id, a mark inside
 * another link or code, and a mark that got split by the renderer all end as the plain text; no mark character survives.
 * Returns how many links were made.
 */
export function applyNodeLinks(
  root: Element,
  knownIds: ReadonlySet<string>,
  createLink: () => Element,
  knownAttachments: ReadonlySet<string> = new Set()
): number {
  const doc = root.ownerDocument;
  let made = 0;
  const texts: Text[] = [];
  const links: Element[] = [];
  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) texts.push(child as Text);
      else if (child.nodeType === 1) {
        if ((child as Element).localName.toLowerCase() === "a") links.push(child as Element);
        walk(child);
      }
    }
  };
  walk(root);
  // A mark inside an attribute an author wrote (`<span title="[[Note]]">`) never becomes a link: its label stays as plain text.
  const clearAttributes = (element: Element): void => {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      if (HAS_MARK.test(value))
        element.setAttribute(name, stripNodeLinkMarks(value.replace(MARKED, (_all, _start, label: string) => label)));
    }
    for (const child of Array.from(element.children)) clearAttributes(child);
  };
  clearAttributes(root);
  // Only the cleaner's own YouTube links carry the video mark; a class an author wrote by hand never survives.
  for (const link of links) {
    const kept = (link.getAttribute("class") ?? "").split(/\s+/).filter(name => name && name !== VIDEO_LINK_CLASS);
    if (kept.length) link.setAttribute("class", kept.join(" "));
    else link.removeAttribute("class");
    const href = link.getAttribute("href") ?? "";
    // A Facebook or Instagram video link is a video card however it was written (Obsidian shows it only as a link).
    if (!textOf(link).includes(VIDEO_MARK) && !socialVideoOf(href)) continue;
    if (/^https:\/\//i.test(href)) link.setAttribute("class", VIDEO_LINK_CLASS);
  }
  for (const node of texts) {
    const value = node.nodeValue ?? "";
    if (!HAS_MARK.test(value)) continue;
    const inside = (() => {
      for (let el = node.parentNode as Element | null; el && el !== root; el = el.parentNode as Element | null) {
        const name = el.localName.toLowerCase();
        if (name === "a" || name === "code" || name === "pre") return true;
      }
      return false;
    })();
    const parts: Node[] = [];
    let last = 0;
    for (const match of value.matchAll(MARKED)) {
      const at = match.index ?? 0;
      if (at > last) parts.push(doc.createTextNode(stripNodeLinkMarks(value.slice(last, at))));
      const [, start, label, id] = match;
      if (start === ATTACHMENT_START) {
        if (!inside && label && knownAttachments.has(id) && SAFE_ID.test(id)) {
          const card = createLink();
          card.setAttribute("class", ATTACHMENT_CLASS);
          card.setAttribute("href", `${ATTACHMENT_HREF_PREFIX}${id}`);
          card.appendChild(doc.createTextNode(label));
          parts.push(card);
          made++;
        } else parts.push(doc.createTextNode(label));
      } else if (!inside && label && knownIds.has(id) && SAFE_ID.test(id)) {
        const link = createLink();
        link.setAttribute("class", NODE_LINK_CLASS);
        link.setAttribute("href", `${NODE_LINK_HREF_PREFIX}${id}`);
        link.appendChild(doc.createTextNode(label));
        parts.push(link);
        made++;
      } else parts.push(doc.createTextNode(label));
      last = at + match[0].length;
    }
    if (last < value.length) parts.push(doc.createTextNode(stripNodeLinkMarks(value.slice(last))));
    const parent = node.parentNode;
    if (!parent) continue;
    for (const part of parts) parent.insertBefore(part, node);
    parent.removeChild(node);
  }
  return made;
}
