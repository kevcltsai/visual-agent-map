import type { Plugin } from "obsidian";
import { layoutFigure, type FigureNode } from "../../core/book-pipeline/figure-layout";
import { parseFigure } from "../../core/book-pipeline/figure-spec";
import { t } from "../../i18n";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The only elements a figure may contain; anything else the layout tree names is skipped with its children. */
export const FIGURE_TAGS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "rect",
  "line",
  "circle",
  "polygon",
  "path",
  "text",
  "title",
  "defs",
  "marker"
]);
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const ATTR_VALUE = /^[\w #(),.:-]*$/;

/** What the builder needs of a document: an SVG element factory. */
export interface SvgFactory {
  createElementNS(ns: string, tag: string): SvgLike;
}
export interface SvgLike {
  setAttribute(name: string, value: string): void;
  appendChild(child: SvgLike): unknown;
  textContent: string | null;
}

/** The layout tree as DOM: whitelisted tags, plugin-computed attributes only (no href, style or event attribute can pass), text through textContent. */
export function buildFigureElement(node: FigureNode, doc: SvgFactory): SvgLike | undefined {
  if (!FIGURE_TAGS.has(node.tag)) return undefined;
  const el = doc.createElementNS(SVG_NS, node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!ATTR_NAME.test(name) || /^(on|href|xlink|style)/i.test(name)) continue;
    if (typeof value === "number" ? !Number.isFinite(value) : !ATTR_VALUE.test(value)) continue;
    el.setAttribute(name, String(value));
  }
  if (node.text !== undefined) el.textContent = node.text;
  for (const child of node.children) {
    const built = buildFigureElement(child, doc);
    if (built) el.appendChild(built);
  }
  return el;
}

interface HostLike extends SvgLike {
  addClass(...names: string[]): void;
  createEl(tag: "pre"): { textContent: string | null };
  createDiv(options: { cls: string; text: string }): unknown;
  ownerDocument: SvgFactory;
  empty(): void;
}

/** Draws a ```vam-figure block: the figure, or, when the source cannot be read, the source as text and one line saying so. Never throws. */
export function renderFigure(source: string, host: HostLike): void {
  host.empty();
  host.addClass("vam-figure");
  try {
    const parsed = parseFigure(source);
    if (parsed.ok) {
      const svg = buildFigureElement(layoutFigure(parsed.spec), host.ownerDocument);
      if (svg) {
        host.appendChild(svg);
        return;
      }
    }
  } catch {
    // falls through to the plain reading below
  }
  host.empty();
  host.createEl("pre").textContent = source;
  host.createDiv({ cls: "vam-figure-note", text: t("ui.book_figure_unreadable") });
}

export function registerBookFigures(plugin: Plugin): void {
  plugin.registerMarkdownCodeBlockProcessor("vam-figure", (source, el) =>
    renderFigure(source, el as unknown as HostLike)
  );
}
