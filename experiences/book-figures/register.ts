import type { MarkdownPostProcessorContext, Plugin } from "obsidian";
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
/** Exactly the attribute names figure-layout emits; anything else is dropped. */
export const FIGURE_ATTRS: ReadonlySet<string> = new Set([
  "viewBox",
  "role",
  "class",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "width",
  "height",
  "d",
  "fill",
  "text-anchor",
  "marker-end",
  "id",
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
  "orient"
]);
let figureCounter = 0;
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
export function buildFigureElement(node: FigureNode, doc: SvgFactory, uid: number): SvgLike | undefined {
  if (!FIGURE_TAGS.has(node.tag)) return undefined;
  const el = doc.createElementNS(SVG_NS, node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!FIGURE_ATTRS.has(name)) continue;
    if (typeof value === "number" ? !Number.isFinite(value) : !ATTR_VALUE.test(value)) continue;
    // The marker id is made unique per figure (uid is a module counter, never AI data) so two figures on a page do not share one.
    if (name === "id") el.setAttribute(name, `${value}-${uid}`);
    else if (name === "marker-end") el.setAttribute(name, String(value).replace(/\)$/, `-${uid})`));
    else el.setAttribute(name, String(value));
  }
  if (node.text !== undefined) el.textContent = node.text;
  for (const child of node.children) {
    const built = buildFigureElement(child, doc, uid);
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

/** The part of the code-block context the renderer uses. */
export interface FigureCtx {
  getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}

/** The line right after the closing fence is the figure's caption; used as the SVG's accessible name. */
function captionOf(host: unknown, ctx?: FigureCtx): string | undefined {
  try {
    const info = ctx?.getSectionInfo(host as HTMLElement);
    if (!info) return undefined;
    const line = info.text.split(/\r?\n/)[info.lineEnd + 1]?.trim();
    return line ? line : undefined;
  } catch {
    return undefined;
  }
}

/** Draws a ```vam-figure block: the figure, or, when the source cannot be read, the source as text and one line saying so. Never throws. */
export function renderFigure(source: string, host: HostLike, ctx?: FigureCtx): void {
  host.empty();
  host.addClass("vam-figure");
  try {
    const parsed = parseFigure(source);
    if (parsed.ok) {
      const svg = buildFigureElement(
        layoutFigure(parsed.spec, captionOf(host, ctx)),
        host.ownerDocument,
        ++figureCounter
      );
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
  plugin.registerMarkdownCodeBlockProcessor("vam-figure", (source, el, ctx: MarkdownPostProcessorContext) =>
    renderFigure(source, el as unknown as HostLike, ctx)
  );
}
