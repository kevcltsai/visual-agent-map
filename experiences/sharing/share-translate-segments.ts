/**
 * Translation segments for shared note HTML (D-2026-10-116). The input is the already cleaned `detailHtml`; the output
 * is a list of text units to translate and a way to put the translations back.
 *
 * Safety by construction: reassembly only creates TEXT nodes and clones elements that were already in the cleaned
 * tree. The model's reply is data that becomes text; it can never add an element or an attribute, so `<script>`,
 * `<a href="obsidian://x">` or `[[private]]` in a reply are shown as plain text and the leak scan still sees them.
 *
 * Works on plain Node members (childNodes, nodeType, nodeValue, getAttribute, cloneNode, insertBefore, removeChild,
 * ownerDocument.createTextNode), so it runs against Obsidian's DOM and against the small DOM of the unit tests.
 * No obsidian import.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Placeholder tokens in a unit's text: `⟦n⟧…⟦/n⟧` for an inline element, `⟦n/⟧` for something left untouched. */
export const PLACEHOLDER_OPEN = "⟦";
export const PLACEHOLDER_CLOSE = "⟧";
const TOKEN = /⟦(\/?)(\d+)(\/?)⟧/g;

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul"
]);
/** Never translated and never entered: the block is skipped as it is (code blocks, scripts, form controls). */
const SKIP_BLOCK_TAGS = new Set(["pre", "script", "style", "textarea", "template", "noscript"]);
/** Inline things that stay exactly as they are inside a sentence. */
const ATOM_TAGS = new Set([
  "code",
  "kbd",
  "samp",
  "var",
  "tt",
  "svg",
  "math",
  "img",
  "br",
  "wbr",
  "input",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "select",
  "button"
]);
/** Obsidian and VAM classes whose content is not prose: rendered math, tags, export markers. */
const ATOM_CLASSES = new Set([
  "math",
  "katex",
  "katex-display",
  "mjx-container",
  "tag",
  "notranslate",
  "vam-image-omitted",
  "vam-mermaid-note",
  "vam-mermaid-slot"
]);
/** A web address inside prose is never translated. */
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'，。、；：）」』】》]+/gi;
const HAS_LETTER = /\p{L}/u;

export interface SegmentPart {
  /** The original node: an inline element (rebuilt around its translated children) or an untouched atom. */
  node?: Node;
  /** Text kept verbatim (a web address). */
  literal?: string;
  atom: boolean;
}
export interface SegmentUnit {
  /** Position in the extraction; the translation of this unit is looked up by it. */
  index: number;
  kind: "run" | "attribute";
  /** What the model sees: trimmed, with placeholders. */
  text: string;
  /** run: the consecutive nodes of one parent that the unit replaces. */
  nodes: Node[];
  /** run: whitespace that stood before and after the text. */
  lead: string;
  trail: string;
  /** run: what each placeholder number (1-based) stands for. */
  parts: SegmentPart[];
  /** attribute: the element and attribute (an image's alt text). */
  element?: Element;
  attribute?: string;
}
export interface SegmentExtraction {
  units: SegmentUnit[];
}
export interface ApplyReport {
  applied: number;
  /** Units whose translation was missing or failed the placeholder check; their original text stays. */
  kept: number;
}

const tagOf = (element: Element): string => element.localName.toLowerCase();
const classesOf = (element: Element): string[] => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const elementChildren = (parent: Node): Element[] =>
  Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === ELEMENT_NODE);

function hasBlockDescendant(element: Element): boolean {
  for (const child of elementChildren(element)) {
    if (BLOCK_TAGS.has(tagOf(child)) || SKIP_BLOCK_TAGS.has(tagOf(child)) || hasBlockDescendant(child)) return true;
  }
  return false;
}

type Kind = "skip" | "atom" | "inline" | "block";
function classify(element: Element): Kind {
  const tag = tagOf(element);
  if (SKIP_BLOCK_TAGS.has(tag)) return "skip";
  if (
    ATOM_TAGS.has(tag) ||
    element.getAttribute("translate") === "no" ||
    classesOf(element).some(name => ATOM_CLASSES.has(name))
  )
    return "atom";
  if (BLOCK_TAGS.has(tag) || hasBlockDescendant(element)) return "block";
  return "inline";
}

/** Replaces web addresses with `⟦n/⟧` markers, recording them as literals. */
function maskUrls(text: string, parts: SegmentPart[]): string {
  return text.replace(URL_IN_TEXT, url => {
    parts.push({ literal: url, atom: true });
    return `${PLACEHOLDER_OPEN}${parts.length}/${PLACEHOLDER_CLOSE}`;
  });
}

function buildText(nodes: readonly Node[], parts: SegmentPart[]): string {
  let out = "";
  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      out += maskUrls(node.nodeValue ?? "", parts);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      parts.push({ node, atom: true });
      out += `${PLACEHOLDER_OPEN}${parts.length}/${PLACEHOLDER_CLOSE}`;
      return;
    }
    const element = node as Element;
    if (classify(element) === "inline") {
      parts.push({ node: element, atom: false });
      const number = parts.length;
      out += `${PLACEHOLDER_OPEN}${number}${PLACEHOLDER_CLOSE}`;
      for (const child of Array.from(element.childNodes)) visit(child);
      out += `${PLACEHOLDER_OPEN}/${number}${PLACEHOLDER_CLOSE}`;
      return;
    }
    parts.push({ node: element, atom: true });
    out += `${PLACEHOLDER_OPEN}${parts.length}/${PLACEHOLDER_CLOSE}`;
  };
  for (const node of nodes) visit(node);
  return out;
}

/** True when the text, minus placeholders, has something to translate. */
export function hasTranslatableText(text: string): boolean {
  return HAS_LETTER.test(text.replace(TOKEN, ""));
}

/**
 * Finds every translation unit under `root`: runs of consecutive inline content (text, links, emphasis, code, images)
 * inside each container, and the `alt` text of images. `<pre>`, scripts, rendered math, diagram slots and
 * `translate="no"` content are never entered. A unit whose text already contains the placeholder brackets is left out.
 */
export function extractSegments(root: Element): SegmentExtraction {
  const units: SegmentUnit[] = [];
  const addAttribute = (element: Element): void => {
    const alt = element.getAttribute("alt");
    if (alt && hasTranslatableText(alt))
      units.push({
        index: units.length,
        kind: "attribute",
        text: alt.trim(),
        nodes: [],
        lead: "",
        trail: "",
        parts: [],
        element,
        attribute: "alt"
      });
  };
  const collectAlt = (parent: Element): void => {
    for (const child of elementChildren(parent)) {
      const tag = tagOf(child);
      if (SKIP_BLOCK_TAGS.has(tag) || tag === "svg") continue;
      if (tag === "img") addAttribute(child);
      else collectAlt(child);
    }
  };
  const flush = (run: Node[]): void => {
    if (!run.length) return;
    const parts: SegmentPart[] = [];
    const raw = buildText(run, parts);
    const text = raw.trim();
    if (!text || !hasTranslatableText(text) || raw.includes("⟦⟦")) return;
    // Source text that already contains the bracket characters would be ambiguous with the placeholders.
    const stripped = raw.replace(TOKEN, "");
    if (stripped.includes(PLACEHOLDER_OPEN) || stripped.includes(PLACEHOLDER_CLOSE)) return;
    const lead = raw.slice(0, raw.length - raw.trimStart().length);
    const trail = raw.slice(raw.trimEnd().length);
    units.push({ index: units.length, kind: "run", text, nodes: run, lead, trail, parts });
  };
  const walk = (parent: Element): void => {
    let run: Node[] = [];
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        run.push(child);
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) {
        // A comment or processing instruction ends the run; the cleaner removes them, so this is a safety net.
        flush(run);
        run = [];
        continue;
      }
      const element = child as Element;
      const kind = classify(element);
      if (kind === "atom" || kind === "inline") run.push(element);
      else {
        flush(run);
        run = [];
        if (kind === "block") walk(element);
      }
    }
    flush(run);
  };
  collectAlt(root);
  walk(root);
  return { units };
}

const tokensOf = (text: string): string[] => [...text.matchAll(TOKEN)].map(match => match[0]);

/**
 * A translated unit is usable only when its placeholders are exactly those of the source, in the same order (which
 * also fixes the nesting), no bracket character is left over, and it is not blank.
 */
export function placeholdersMatch(source: string, translated: string): boolean {
  if (!translated.trim()) return false;
  const a = tokensOf(source);
  const b = tokensOf(translated);
  if (a.length !== b.length || a.some((token, i) => token !== b[i])) return false;
  const rest = translated.replace(TOKEN, "");
  return !rest.includes(PLACEHOLDER_OPEN) && !rest.includes(PLACEHOLDER_CLOSE);
}

/** Builds the nodes for a translated run: text nodes, clones of the original inline elements, clones of the atoms. */
function rebuild(unit: SegmentUnit, translated: string, doc: Document): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  const add = (node: Node): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.appendChild(node);
    else roots.push(node);
  };
  const addText = (text: string): void => {
    if (text) add(doc.createTextNode(text));
  };
  addText(unit.lead);
  let last = 0;
  for (const match of translated.matchAll(TOKEN)) {
    addText(translated.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    const part = unit.parts[Number(match[2]) - 1];
    if (match[1] === "/") {
      stack.pop();
    } else if (match[3] === "/") {
      if (part.literal !== undefined) addText(part.literal);
      else if (part.node) add(part.node.cloneNode(true));
    } else if (part.node) {
      const copy = part.node.cloneNode(false);
      add(copy);
      stack.push(copy);
    }
  }
  addText(translated.slice(last));
  addText(unit.trail);
  return roots;
}

/**
 * Puts translations back. `translationOf` returns the translated text of a unit or undefined. Attribute units are
 * applied first (the clones made for runs then carry the translated `alt`). Only text nodes are created; a unit with a
 * missing or placeholder-breaking translation keeps its original and is counted in `kept`.
 */
export function applyTranslations(
  extraction: SegmentExtraction,
  translationOf: (unit: SegmentUnit) => string | undefined
): ApplyReport {
  const report: ApplyReport = { applied: 0, kept: 0 };
  const ordered = [
    ...extraction.units.filter(unit => unit.kind === "attribute"),
    ...extraction.units.filter(unit => unit.kind === "run")
  ];
  for (const unit of ordered) {
    const translated = translationOf(unit);
    if (translated === undefined || !placeholdersMatch(unit.text, translated)) {
      report.kept++;
      continue;
    }
    if (unit.kind === "attribute") {
      unit.element?.setAttribute(unit.attribute ?? "alt", translated.trim());
      report.applied++;
      continue;
    }
    const first = unit.nodes[0];
    const parent = first?.parentNode;
    const doc = first?.ownerDocument;
    if (!first || !parent || !doc) {
      report.kept++;
      continue;
    }
    for (const node of rebuild(unit, translated, doc)) parent.insertBefore(node, first);
    for (const node of unit.nodes) node.parentNode?.removeChild(node);
    report.applied++;
  }
  return report;
}

/** Top-level `<svg>` elements of a tree (an svg inside another svg is not listed), in document order. */
export function topLevelSvgs(root: Element): Element[] {
  const found: Element[] = [];
  const visit = (parent: Element): void => {
    for (const child of elementChildren(parent)) {
      if (tagOf(child) === "svg") found.push(child);
      else visit(child);
    }
  };
  visit(root);
  return found;
}

/** Elements anywhere under `root` that carry `className`. */
export function elementsWithClass(root: Element, className: string): Element[] {
  const found: Element[] = [];
  const visit = (parent: Element): void => {
    for (const child of elementChildren(parent)) {
      if (classesOf(child).includes(className)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}
