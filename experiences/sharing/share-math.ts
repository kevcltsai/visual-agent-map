/**
 * Math in a shared file is MathML, not MathJax's own markup (the sanitizer strips `mjx-*` and leaves flattened text). The
 * exporter reads each formula's LaTeX before sanitizing, asks MathJax for MathML afterwards, and rebuilds that MathML here
 * from a whitelist, so nothing MathJax (or a hostile formula) adds can reach the file: no links, styles, classes, event
 * attributes, annotations or scripts. No imports of Obsidian, so a unit test can load it directly.
 */

export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
export const MATH_SOURCE_CLASS = "vam-math-source";
export const MATH_NOTE_CLASS = "vam-math-note";

export const MATHML_ELEMENTS: readonly string[] = [
  "math",
  "semantics",
  "mrow",
  "mi",
  "mn",
  "mo",
  "mtext",
  "mspace",
  "ms",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mover",
  "munder",
  "munderover",
  "mtable",
  "mtr",
  "mtd",
  "mstyle",
  "mpadded",
  "mphantom",
  "menclose"
];
export const MATHML_ATTRIBUTES: readonly string[] = [
  "display",
  "mathvariant",
  "displaystyle",
  "scriptlevel",
  "stretchy",
  "fence",
  "separator",
  "lspace",
  "rspace",
  "accent",
  "accentunder",
  "linethickness",
  "columnalign",
  "rowalign",
  "width",
  "height",
  "depth",
  "notation"
];
const ELEMENTS = new Set(MATHML_ELEMENTS);
const ATTRIBUTES = new Set(MATHML_ATTRIBUTES);
/** Never kept, and nothing inside them is kept either (a whitelisted element inside `annotation-xml` would otherwise surface). */
const DROP_WITH_CONTENT = new Set(["annotation", "annotation-xml", "maction", "script", "style", "foreignobject"]);

const childNodesOf = (node: Node): Node[] => Array.from(node.childNodes);

/**
 * A clean copy of the MathML tree under `source` (its `math` element), built with `create` (an element in the MathML
 * namespace). Elements outside the whitelist are unwrapped (their children are kept) unless they are in the drop list;
 * only whitelisted attributes are copied; text is copied as text. Null when `source` is not a `math` element.
 */
export function rebuildMath(source: Element, create: (name: string) => Element, display: boolean): Element | null {
  if (source.localName.toLowerCase() !== "math") return null;
  const copy = (from: Element): Element => {
    const out = create(from.localName.toLowerCase());
    for (const name of from.getAttributeNames()) {
      const lower = name.toLowerCase();
      if (ATTRIBUTES.has(lower)) out.setAttribute(lower, from.getAttribute(name) ?? "");
    }
    fill(from, out);
    return out;
  };
  const fill = (from: Element, into: Element): void => {
    for (const child of childNodesOf(from)) {
      if (child.nodeType === 3) {
        into.append(from.ownerDocument.createTextNode(child.nodeValue ?? ""));
      } else if (child.nodeType === 1) {
        const element = child as Element;
        const name = element.localName.toLowerCase();
        if (DROP_WITH_CONTENT.has(name)) continue;
        if (ELEMENTS.has(name)) into.append(copy(element));
        else fill(element, into);
      }
    }
  };
  const math = copy(source);
  if (display) math.setAttribute("display", "block");
  else math.removeAttribute("display");
  return math;
}

export interface MathDeps {
  /** MathJax's `tex2mml`, or undefined when MathJax is not there. */
  tex2mml: ((latex: string, options: { display: boolean }) => string) | undefined;
  /** Parses a MathML string (as HTML) and returns its `math` element, or null. */
  parse(mml: string): Element | null;
  create(name: string): Element;
}

/** The shared form of one formula: a `math` element, or null when MathJax could not make usable MathML (the caller shows the source). */
export function mathFromLatex(latex: string, display: boolean, deps: MathDeps): Element | null {
  if (!latex.trim() || !deps.tex2mml) return null;
  try {
    const mml = deps.tex2mml(latex, { display });
    if (typeof mml !== "string" || !mml.trim()) return null;
    const parsed = deps.parse(mml);
    const math = parsed ? rebuildMath(parsed, name => deps.create(name), display) : null;
    return math && math.textContent?.trim() ? math : null;
  } catch {
    return null;
  }
}
