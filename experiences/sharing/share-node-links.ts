/**
 * Links from one note of a shared map to another note of the same map (`[[Other note]]` where Other note is a card).
 * The cleaner cannot emit an `<a>` (it writes Markdown, and the sanitizer would rewrite it), so it marks the text with
 * three private-use characters; after sanitize and scrub the exporter turns each mark into
 * `<a class="vam-node-link" href="#vam-node-<id>">` with exactly those two attributes. The author's own text never
 * carries the marks (they are stripped from every input first), so nobody can forge a link by typing them.
 * No imports of Obsidian, so a unit test can load it directly.
 */

export const NODE_LINK_START = "\uE000";
export const NODE_LINK_MID = "\uE001";
export const NODE_LINK_END = "\uE002";
export const NODE_LINK_CLASS = "vam-node-link";
export const NODE_LINK_HREF_PREFIX = "#vam-node-";

const MARKS = /[\uE000-\uE002]/g;
const HAS_MARK = /[\uE000-\uE002]/;
const MARKED = /\uE000([^\uE000-\uE002]*)\uE001([^\uE000-\uE002]*)\uE002/g;
/** The ids a link may carry; anything else stays plain text (the viewer looks the id up in the file, so this is about the attribute value only). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Text with the three marks removed: what every author input and every title goes through before a mark is added. */
export const stripNodeLinkMarks = (text: string): string => text.replace(MARKS, "");

/** `text` wrapped in a mark for node `id`; the text unchanged when the id cannot be a link target. */
export function markNodeLink(id: string, text: string): string {
  const plain = stripNodeLinkMarks(text);
  return SAFE_ID.test(id) ? `${NODE_LINK_START}${plain}${NODE_LINK_MID}${id}${NODE_LINK_END}` : plain;
}

/**
 * Turns the marks in the text of `root` into links to the nodes in `knownIds`. A mark for an unknown id, a mark inside
 * another link or code, and a mark that got split by the renderer all end as the plain text; no mark character survives.
 * Returns how many links were made.
 */
export function applyNodeLinks(root: Element, knownIds: ReadonlySet<string>, createLink: () => Element): number {
  const doc = root.ownerDocument;
  let made = 0;
  const texts: Text[] = [];
  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) texts.push(child as Text);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
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
      const [, label, id] = match;
      if (!inside && label && knownIds.has(id) && SAFE_ID.test(id)) {
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
