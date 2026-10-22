import type { ShareViewerUi } from "../share-viewer-ui";

/**
 * Puts the exported note HTML into `target`. The exporter already sanitized it; this pass repeats the cheap checks
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
  const root = new DOMParser().parseFromString(html, "text/html").body;
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
