import type { ShareNodeTranslation } from "../share-format";
import type { ShareViewerUi } from "../share-viewer-ui";
import { reconstructTranslatedDetail } from "../share-translate-compact";

/** The pieces of the "Source: host" line shown under a web image: text before, link label, text after. */
export function imageSourceParts(src: string, ui: Pick<ShareViewerUi, "imageSource">): [string, string, string] {
  // Plain text parsing (no URL constructor): the label is the host, without credentials or port.
  const match = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(src);
  const host = match?.[1] ?? src;
  const [before, after = ""] = ui.imageSource.split("{0}");
  return [before, host, after];
}

function sourceLine(doc: Document, src: string, ui: ShareViewerUi): HTMLElement {
  const [before, host, after] = imageSourceParts(src, ui);
  const line = doc.createElement("span");
  line.className = "vam-image-source";
  const link = doc.createElement("a");
  link.setAttribute("href", src);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  link.textContent = host;
  line.append(doc.createTextNode(before), link, doc.createTextNode(after));
  return line;
}

/**
 * Puts the exported note HTML into `target` (see {@link fillDetailRoot} for the part after parsing). The exporter already sanitized it; this pass repeats the cheap checks
 * (no script, no event attributes, no script URLs) and does the viewer's own work: asset images, links, wide tables.
 * The HTML is parsed with DOMParser (an inert document), so nothing loads before it is cleaned.
 */
export function fillDetail(
  doc: Document,
  target: HTMLElement,
  html: string,
  assets: Readonly<Record<string, string>>,
  ui: ShareViewerUi
): void {
  // A parsed document is inert: no script runs and no image loads until the nodes are adopted below.
  fillDetailRoot(doc, target, new DOMParser().parseFromString(html, "text/html").body, assets, ui);
}

/** The same clean-up and adoption for a note tree that is already parsed (a rebuilt translated note, D-2026-10-122). */
export function fillDetailRoot(
  doc: Document,
  target: HTMLElement,
  root: HTMLElement,
  assets: Readonly<Record<string, string>>,
  ui: ShareViewerUi
): void {
  for (const node of Array.from(
    root.querySelectorAll("script, iframe, frame, object, embed, applet, link, meta, base")
  ))
    node.remove();
  for (const node of Array.from(root.querySelectorAll("*"))) {
    for (const name of node.getAttributeNames()) {
      const value = node.getAttribute(name) ?? "";
      const lower = name.toLowerCase();
      if (
        lower.startsWith("on") ||
        (/^(href|src|xlink:href|action|formaction)$/.test(lower) && /^\s*(javascript|vbscript):/i.test(value))
      )
        node.removeAttribute(name);
    }
  }
  const omitted = (): HTMLElement => {
    const span = doc.createElement("span");
    span.className = "vam-image-omitted";
    span.textContent = ui.imageOmitted;
    return span;
  };
  for (const image of Array.from(root.querySelectorAll("img"))) {
    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("vam-asset:")) {
      const data = assets[src.slice("vam-asset:".length)];
      if (typeof data === "string" && data.startsWith("data:image/")) image.setAttribute("src", data);
      else image.replaceWith(omitted());
    } else if (/^https?:\/\//i.test(src)) {
      image.setAttribute("referrerpolicy", "no-referrer");
      image.setAttribute("loading", "lazy");
      // A web image can fail to load (offline, blocked): keep a visible line that names where it came from.
      const anchor = image.closest("a");
      (anchor ?? image).after(sourceLine(doc, src, ui));
    } else if (!/^data:image\//i.test(src)) image.replaceWith(omitted());
  }
  for (const link of Array.from(root.querySelectorAll("a"))) {
    const href = link.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else if (!href.startsWith("#")) link.removeAttribute("href");
  }
  for (const table of Array.from(root.querySelectorAll("table"))) {
    if (table.parentElement?.classList.contains("vam-table-scroll")) continue;
    const wrap = doc.createElement("div");
    wrap.className = "vam-table-scroll";
    table.replaceWith(wrap);
    wrap.append(table);
  }
  target.append(...Array.from(root.childNodes).map(child => doc.importNode(child, true)));
}

/**
 * Shows a note in a translated language from its compact translation (D-2026-10-122): the original HTML is parsed,
 * rebuilt with the stored text units and diagrams (text nodes only, no new element), and then goes through the same
 * clean-up as any note. Fail closed: a translation that does not fit, or any error, shows the original note.
 */
export function fillTranslatedDetail(
  doc: Document,
  target: HTMLElement,
  originalHtml: string,
  translation: ShareNodeTranslation,
  assets: Readonly<Record<string, string>>,
  ui: ShareViewerUi
): void {
  const parse = (html: string): HTMLElement => new DOMParser().parseFromString(html, "text/html").body;
  try {
    const root = parse(originalHtml);
    reconstructTranslatedDetail(root, translation, { parse, createSlot: () => doc.createElement("div") });
    fillDetailRoot(doc, target, root, assets, ui);
  } catch {
    target.replaceChildren();
    fillDetail(doc, target, originalHtml, assets, ui);
  }
}
