/**
 * DOM clean-up for shared note HTML. Everything here works on plain Element members (children, attributes, remove),
 * so it runs against Obsidian's real DOM and against the small fake DOM of the unit tests. No obsidian import.
 *
 * Two layers: `scrubShareTree` is the allowlist-style pass every note goes through after sanitizeHTMLToDom;
 * `scrubMermaidSvg` applies the same pass to a mermaid SVG that is put back after sanitizing (sanitizeHTMLToDom
 * strips mermaid's `<style>` and the `foreignObject` that holds its labels, which leaves the diagram without text).
 */

const BLOCKED_TAGS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "button",
  "textarea",
  "select",
  "option",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "template",
  "noscript",
  "slot",
  "canvas",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "image"
]);
/** Obsidian's own controls and chrome around rendered Markdown; never part of a note. */
const CHROME_CLASSES = new Set([
  "copy-code-button",
  "edit-block-button",
  "frontmatter-container",
  "metadata-container",
  "mermaid-guard-header",
  "heading-collapse-indicator",
  "collapse-indicator",
  "callout-fold",
  "markdown-embed",
  "internal-embed",
  "file-embed"
]);
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "xlink:href",
  "srcset",
  "data",
  "poster",
  "action",
  "formaction",
  "background",
  "cite",
  "longdesc",
  "ping",
  "manifest",
  "codebase",
  "usemap"
]);
const FORBIDDEN_SCHEMES = /(?:app|obsidian|file|capacitor):\/\//i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]/;

export interface ScrubReport {
  /** Elements removed. */
  elements: number;
  /** Attributes removed. */
  attributes: number;
}
export interface ScrubOptions {
  /** Keep `<style>` elements whose CSS loads nothing (mermaid SVG). */
  allowStyle?: boolean;
}

const normalizeUrl = (value: string): string => value.replace(/[\p{Cc}\s]/gu, "").toLowerCase();

function allowedUrl(tag: string, name: string, value: string): boolean {
  const url = normalizeUrl(value);
  if (!url) return false;
  const isLink = name === "href" || name === "xlink:href";
  if (isLink && url.startsWith("#")) return true;
  if (/^https?:\/\//.test(url)) return name !== "data" && name !== "action" && name !== "formaction";
  if (name === "href" && tag === "a" && url.startsWith("mailto:")) return true;
  if (name === "src" && tag === "img") return url.startsWith("vam-asset:") || SAFE_DATA_IMAGE.test(url);
  return false;
}

/** CSS that fetches or runs anything. Fragment references (`url(#arrow)`) are the only `url()` mermaid needs. */
export function cssIsInert(css: string): boolean {
  const lower = css.toLowerCase();
  if (lower.includes("@import") || lower.includes("expression(") || lower.includes("javascript:")) return false;
  if (lower.includes("behavior:") || lower.includes("-moz-binding")) return false;
  for (const match of lower.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g))
    if (!match[2].trim().startsWith("#")) return false;
  return !FORBIDDEN_SCHEMES.test(lower);
}

function scrubAttributes(element: Element, tag: string, report: ScrubReport): void {
  for (const name of element.getAttributeNames()) {
    const lower = name.toLowerCase();
    const value = element.getAttribute(name) ?? "";
    let drop = false;
    if (lower.startsWith("on") || lower === "srcdoc") drop = true;
    else if (lower.startsWith("data-") && !lower.startsWith("data-callout")) drop = true;
    else if (URL_ATTRIBUTES.has(lower)) drop = !allowedUrl(tag, lower, value);
    else if (lower === "style") drop = !cssIsInert(value);
    else if (FORBIDDEN_SCHEMES.test(value)) drop = true;
    if (drop) {
      element.removeAttribute(name);
      report.attributes++;
    }
  }
}

function hasChromeClass(element: Element): boolean {
  const classes = (element.getAttribute("class") ?? "").split(/\s+/);
  return classes.some(name => CHROME_CLASSES.has(name));
}

const COMMENT_NODE = 8;

function scrubChildren(parent: Element, options: ScrubOptions, report: ScrubReport): void {
  // HTML comments never reach the file, whatever the renderer left in the tree.
  for (const node of Array.from(parent.childNodes))
    if (node.nodeType === COMMENT_NODE) {
      node.remove();
      report.elements++;
    }
  for (const child of Array.from(parent.children)) {
    const tag = child.localName.toLowerCase();
    let keep = !BLOCKED_TAGS.has(tag) && !hasChromeClass(child);
    // Task-list checkboxes stay as read-only boxes; every other input goes.
    if (tag === "input") keep = (child.getAttribute("type") ?? "").toLowerCase() === "checkbox";
    if (keep && tag === "style") keep = !!options.allowStyle && cssIsInert(child.textContent ?? "");
    if (!keep) {
      child.remove();
      report.elements++;
      continue;
    }
    scrubAttributes(child, tag, report);
    if (tag === "input") child.setAttribute("disabled", "");
    // An image whose source did not survive would show a broken picture; the viewer has its own placeholder.
    if (tag === "img" && !child.getAttribute("src")) {
      child.remove();
      report.elements++;
      continue;
    }
    scrubChildren(child, options, report);
  }
}

/** Removes script-capable and Obsidian-only elements, event handlers, and every URL that is not a plain web, mail, fragment or asset reference. */
export function scrubShareTree(root: Element, options: ScrubOptions = {}): ScrubReport {
  const report: ScrubReport = { elements: 0, attributes: 0 };
  scrubAttributes(root, root.localName.toLowerCase(), report);
  scrubChildren(root, options, report);
  return report;
}

/**
 * A diagram must load nothing when the file opens. After the shared pass (which already cleans the HTML inside
 * `foreignObject`: scripts, frames, handlers, script URLs), drop every remote reference except clickable `<a>` links:
 * an `<img>` in a label, a `<use>`/`<feImage>` pointing at a web address.
 */
function dropRemoteReferences(parent: Element): void {
  for (const child of Array.from(parent.children)) {
    const tag = child.localName.toLowerCase();
    const remote = (value: string | null): boolean => /^(?:https?:)?\/\//.test(normalizeUrl(value ?? ""));
    if (tag === "img" && !/^(?:vam-asset:|data:image\/)/.test(normalizeUrl(child.getAttribute("src") ?? ""))) {
      child.remove();
      continue;
    }
    if (tag !== "a") {
      for (const name of ["href", "xlink:href", "src", "srcset"])
        if (remote(child.getAttribute(name))) child.removeAttribute(name);
    }
    dropRemoteReferences(child);
  }
}

/** True when `root` is an `<svg>` and was scrubbed (style kept when inert). False means the SVG cannot be used. */
export function scrubMermaidSvg(root: Element): boolean {
  if (root.localName.toLowerCase() !== "svg") return false;
  scrubShareTree(root, { allowStyle: true });
  dropRemoteReferences(root);
  return true;
}

/**
 * How many links in the rendered tree lead somewhere that is not a web page, a mail address or the page itself:
 * Obsidian's `internal-link` anchors (unless they point inside the page) and any `<a>` whose href is not http(s),
 * mailto or `#…`. Run on the renderer's output BEFORE sanitizing: this is the privacy decision for note links, so it
 * does not depend on how the Markdown was cleaned. Tags (`#tag`), footnotes (`#fn…`), external links, anchors
 * without a target and `vam-asset:` images are not counted.
 */
export function countLocalReferences(root: Element): number {
  let count = 0;
  const local = (value: string | null): boolean => {
    const url = normalizeUrl(value ?? "");
    return !!url && !url.startsWith("#") && !/^https?:\/\//.test(url) && !url.startsWith("mailto:");
  };
  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (child.localName.toLowerCase() === "a") {
        const internal = (child.getAttribute("class") ?? "").split(/\s+/).includes("internal-link");
        const refs = [child.getAttribute("href"), child.getAttribute("xlink:href")];
        if (internal) refs.push(child.getAttribute("data-href"));
        if (refs.some(local)) count++;
      }
      visit(child);
    }
  };
  visit(root);
  return count;
}

/**
 * Replaces every link that does not lead to a web page, mail address or in-page anchor with plain text (a span that
 * keeps the link's children). Obsidian's `internal-link` anchors always go: their target would name a private note.
 */
export function unwrapLocalLinks(root: Element, createSpan: () => Element): number {
  let count = 0;
  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (child.localName.toLowerCase() === "a") {
        const href = normalizeUrl(child.getAttribute("href") ?? "");
        const classes = (child.getAttribute("class") ?? "").split(/\s+/);
        const web = /^https?:\/\//.test(href) || href.startsWith("mailto:") || href.startsWith("#");
        if (classes.includes("internal-link") || !web) {
          const span = createSpan();
          span.append(...Array.from(child.childNodes));
          child.replaceWith(span);
          count++;
          visit(span);
          continue;
        }
      }
      visit(child);
    }
  };
  visit(root);
  return count;
}

/** The sources of the ```mermaid fences in a Markdown text, in document order (used to restore a diagram that did not render). */
export function extractMermaidSources(markdown: string): string[] {
  const sources: string[] = [];
  const pattern = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)^ {0,3}\1[`~]*[ \t]*$/gm;
  for (const match of markdown.matchAll(pattern)) sources.push(match[2].replace(/\n$/, ""));
  return sources;
}
