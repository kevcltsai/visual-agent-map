/**
 * The compact translated-note format (D-2026-10-122). A translated note stores only its translated text units and a
 * check that ties them to the original `detailHtml`; the note is rebuilt from the original when it is opened. The
 * exporter and the viewer use the SAME rebuild function below, so what the privacy gate scans is what is displayed.
 *
 * Safety by construction: the rebuild creates only text nodes and the `alt` attribute (through
 * `applyTranslations`), clones elements that already are in the original, and puts diagrams back from the original or
 * from a patch of it. It never adds an element of its own.
 *
 * Pure: plain Node members only, no obsidian import, no DOMParser; the caller passes a parser. The viewer bundle
 * imports this module, so it must not import i18n or obsidian either.
 */
import type { ShareDiagramPatchOp, ShareDiagramTranslation, ShareNodeTranslation } from "./share-format";
import { segmentHash } from "./share-translate-plan";
import {
  applyTranslations,
  elementsWithClass,
  extractSegments,
  topLevelSvgs,
  type SegmentExtraction
} from "./share-translate-segments";

export const SLOT_CLASS = "vam-mermaid-slot";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export type CompactDetailEntry = Pick<ShareNodeTranslation, "detailSegments" | "detailCheck" | "detailDiagrams">;

/** True when a translated note uses the compact form (the viewer rebuilds it) rather than the legacy `detailHtml`. */
export const isCompactEntry = (entry: object | null | undefined): boolean => {
  const value = entry as CompactDetailEntry | null | undefined;
  return !!value && (Array.isArray(value.detailSegments) || Array.isArray(value.detailDiagrams));
};

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function canonicalNode(node: Node): string {
  if (node.nodeType === TEXT_NODE) return escapeText(node.nodeValue ?? "");
  if (node.nodeType !== ELEMENT_NODE) return `\u0000${node.nodeType}:${node.nodeValue ?? ""}\u0000`;
  return canonicalElement(node as Element);
}
/** One element as a string with its attributes sorted: two trees are the same when their strings are (attribute order does not count). */
export function canonicalElement(element: Element): string {
  const tag = element.localName.toLowerCase();
  const attributes = element
    .getAttributeNames()
    .sort()
    .map(name => ` ${name}="${escapeAttribute(element.getAttribute(name) ?? "")}"`)
    .join("");
  return `<${tag}${attributes}>${canonicalChildren(element)}</${tag}>`;
}
/** The children of a container as a canonical string. */
export function canonicalChildren(root: Element): string {
  return Array.from(root.childNodes).map(canonicalNode).join("");
}

/** Elements and text nodes of a subtree in document order, the root first. */
function flatNodes(root: Element): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    out.push(node);
    if (node.nodeType === ELEMENT_NODE) for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(root);
  return out;
}

export interface PreparedDetail {
  root: Element;
  /** The original top-level diagrams, taken out of the tree. */
  svgs: Element[];
  extraction: SegmentExtraction;
}

/**
 * Takes the top-level diagrams out of the tree (each leaves an empty `vam-mermaid-slot` block in its place) and cuts
 * the text units. The slot is part of the unit cutting, so the exporter and the viewer must prepare the same way.
 * `createSlot` makes an empty `div` (the caller owns the document and its element helpers).
 */
export function prepareDetail(root: Element, createSlot: () => Element): PreparedDetail {
  const svgs = topLevelSvgs(root);
  for (const svg of svgs) {
    const slot = createSlot();
    slot.setAttribute("class", SLOT_CLASS);
    svg.parentNode?.replaceChild(slot, svg);
  }
  return { root, svgs, extraction: extractSegments(root) };
}

/** Ties the translated segments to the exact original: the unit count and a hash over every unit's kind and text. */
export function detailCheckOf(extraction: SegmentExtraction): string {
  const joined = extraction.units.map(unit => `${unit.kind}\u0000${unit.text}`).join("\u0001");
  return `${extraction.units.length}.${segmentHash(joined)}`;
}

/** Ties a diagram patch to the exact original drawing. */
export const svgCheckOf = (svg: Element): string => segmentHash(canonicalElement(svg));

/** Replaces the translated drawing's own id with the original's everywhere (attributes, styles), so only real differences remain. */
export function normalizeSvgId(translated: Element, originalId: string | null): boolean {
  const own = translated.getAttribute("id");
  if (!own || !originalId || own === originalId) return false;
  const fix = (text: string): string => text.split(own).join(originalId);
  for (const node of flatNodes(translated)) {
    if (node.nodeType === TEXT_NODE) node.nodeValue = fix(node.nodeValue ?? "");
    else if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element;
      for (const name of element.getAttributeNames()) element.setAttribute(name, fix(element.getAttribute(name) ?? ""));
    }
  }
  return true;
}

/**
 * The edits that turn `original` into `translated`, or null when the two do not have the same shape (same nodes of
 * the same kind in the same order) and a patch cannot describe the difference.
 */
export function diffSvg(original: Element, translated: Element): ShareDiagramPatchOp[] | null {
  const a = flatNodes(original);
  const b = flatNodes(translated);
  if (a.length !== b.length) return null;
  const patch: ShareDiagramPatchOp[] = [];
  for (const [index, x] of a.entries()) {
    const y = b[index];
    if (x.nodeType !== y.nodeType) return null;
    if (x.nodeType === TEXT_NODE) {
      if (x.nodeValue !== y.nodeValue) patch.push([index, y.nodeValue ?? ""]);
    } else if (x.nodeType === ELEMENT_NODE) {
      const ex = x as Element;
      const ey = y as Element;
      if (ex.localName !== ey.localName) return null;
      const changes: Record<string, string | null> = {};
      for (const name of ey.getAttributeNames()) {
        const value = ey.getAttribute(name) ?? "";
        if (ex.getAttribute(name) !== value) changes[name] = value;
      }
      for (const name of ex.getAttributeNames()) if (ey.getAttribute(name) === null) changes[name] = null;
      if (Object.keys(changes).length) patch.push([index, changes]);
    } else return null;
  }
  return patch;
}

/** Applies a patch to `svg` in place. False (the drawing may be half edited; discard it) when the patch does not fit. */
export function applySvgPatch(svg: Element, patch: unknown): boolean {
  if (!Array.isArray(patch)) return false;
  const nodes = flatNodes(svg);
  for (const op of patch as unknown[]) {
    if (!Array.isArray(op) || op.length !== 2) return false;
    const [index, change] = op as [unknown, unknown];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= nodes.length) return false;
    const node = nodes[index];
    if (typeof change === "string") {
      if (node.nodeType !== TEXT_NODE) return false;
      node.nodeValue = change;
    } else if (change && typeof change === "object" && !Array.isArray(change)) {
      if (node.nodeType !== ELEMENT_NODE) return false;
      for (const [name, value] of Object.entries(change as Record<string, unknown>)) {
        if (value === null) (node as Element).removeAttribute(name);
        else if (typeof value === "string") (node as Element).setAttribute(name, value);
        else return false;
      }
    } else return false;
  }
  return true;
}

/**
 * How to store a translated drawing of `original`: a patch when it describes the difference exactly (verified by
 * applying it to a copy and comparing), the whole drawing otherwise. `serialize` turns an `<svg>` element into HTML.
 */
export function diagramEntryFor(
  original: Element,
  translated: Element,
  serialize: (svg: Element) => string
): ShareDiagramTranslation {
  const patch = diffSvg(original, translated);
  if (patch) {
    const copy = original.cloneNode(true) as Element;
    if (applySvgPatch(copy, patch) && canonicalElement(copy) === canonicalElement(translated)) {
      return patch.length ? { check: svgCheckOf(original), patch } : null;
    }
  }
  return { svg: serialize(translated) };
}

export interface ReconstructOptions {
  /** An empty `div` for a diagram's place while the text is rebuilt. */
  createSlot: () => Element;
  /** Parses an HTML fragment into a detached container (the viewer: DOMParser's body); used for a whole-drawing entry. */
  parse: (html: string) => Element;
  /**
   * Called with the tree after the text is rebuilt and before the diagrams are put back (the diagrams are still empty
   * slots). Returning false rejects the text: the report says `fallback` and the tree is partly rebuilt, so discard it.
   */
  afterText?: (root: Element) => boolean;
}
export interface ReconstructReport {
  /** Text units that were translated / left in the original (a null entry or a failed placeholder check). */
  applied: number;
  kept: number;
  /** The text was not applied (check mismatch or rejected): the note's text shows the original. */
  fallback: boolean;
  /** Diagrams that show their original drawing although the note has a translated entry for them. */
  diagramsKept: number;
}

function drawingFrom(entry: unknown, original: Element, parse: (html: string) => Element): Element | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as { svg?: unknown; check?: unknown; patch?: unknown };
  if (typeof value.svg === "string") {
    const holder = parse(value.svg);
    const elements = Array.from(holder.childNodes).filter(node => node.nodeType === ELEMENT_NODE) as Element[];
    return elements.length === 1 && elements[0].localName.toLowerCase() === "svg" ? elements[0] : null;
  }
  if (typeof value.check === "string" && value.check === svgCheckOf(original)) {
    const copy = original.cloneNode(true) as Element;
    return applySvgPatch(copy, value.patch) ? copy : null;
  }
  return null;
}

/**
 * Turns the ORIGINAL note tree `root` into the translated note, in place. Fail closed (D-2026-10-122, DP4): a segment
 * list that does not fit the original (count or check) leaves the whole text original; a unit whose placeholders do
 * not match stays original; a diagram whose check or patch does not fit shows its original drawing. A legacy entry
 * (no compact fields) changes nothing.
 */
export function reconstructTranslatedDetail(
  root: Element,
  entry: CompactDetailEntry,
  options: ReconstructOptions
): ReconstructReport {
  const report: ReconstructReport = { applied: 0, kept: 0, fallback: false, diagramsKept: 0 };
  const { svgs, extraction } = prepareDetail(root, options.createSlot);
  const segments = entry.detailSegments;
  if (segments !== undefined || entry.detailCheck !== undefined) {
    if (
      Array.isArray(segments) &&
      segments.length === extraction.units.length &&
      entry.detailCheck === detailCheckOf(extraction)
    ) {
      const outcome = applyTranslations(extraction, unit => {
        const text = segments[unit.index];
        return typeof text === "string" ? text : undefined;
      });
      const untouched = segments.filter(text => typeof text !== "string").length;
      report.applied = outcome.applied;
      report.kept = Math.max(0, outcome.kept - untouched);
      if (options.afterText && !options.afterText(root)) {
        report.fallback = true;
        return report;
      }
    } else report.fallback = true;
  }
  // Text rebuilding clones the slots it passes, so they are looked up again; the order is the diagrams' order.
  const slots = elementsWithClass(root, SLOT_CLASS);
  if (slots.length !== svgs.length) report.fallback = true;
  for (const [index, slot] of slots.entries()) {
    const original = svgs[index];
    if (!original) break;
    const wanted = entry.detailDiagrams?.[index];
    let chosen = original;
    if (wanted) {
      let drawn: Element | null = null;
      try {
        drawn = drawingFrom(wanted, original, options.parse);
      } catch {
        drawn = null;
      }
      if (drawn) chosen = drawn;
      else report.diagramsKept++;
    }
    slot.parentNode?.replaceChild(chosen, slot);
  }
  return report;
}
