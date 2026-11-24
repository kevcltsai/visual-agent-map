/**
 * The viewer's MathML check. A shared file carries formulas as MathML built from a whitelist (share-math.ts); a file can
 * be edited by hand, so the viewer applies the same whitelist again before showing a note. A separate copy of the lists
 * in share-math.ts (the viewer bundle imports no plugin module); a unit test compares both.
 */
export const VIEWER_MATHML_ELEMENTS: readonly string[] = [
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
export const VIEWER_MATHML_ATTRIBUTES: readonly string[] = [
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
const ELEMENTS = new Set(VIEWER_MATHML_ELEMENTS);
const ATTRIBUTES = new Set(VIEWER_MATHML_ATTRIBUTES);

const cleanTree = (node: Element): void => {
  for (const name of node.getAttributeNames()) if (!ATTRIBUTES.has(name.toLowerCase())) node.removeAttribute(name);
  for (const child of Array.from(node.children)) {
    if (ELEMENTS.has(child.localName.toLowerCase())) cleanTree(child);
    else child.remove();
  }
};

/** Inside every `math` element: removes what is not on the whitelist (an element with its content, an attribute). */
export function cleanViewerMath(root: Element): void {
  for (const child of Array.from(root.children)) {
    if (child.localName.toLowerCase() === "math") cleanTree(child);
    else cleanViewerMath(child);
  }
}
