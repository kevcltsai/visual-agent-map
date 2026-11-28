/**
 * The map export run: reads the scene the screen drew (through a read-only source) and writes or downloads the result.
 * No Obsidian import: the vault, notices, the PNG encoder and the view's lifecycle are reached through ports, so the
 * run is loaded and tested without a view.
 */
import { errorMessage } from "../../core/error-message";
import { effectiveSummaryRange, isAnnotatedImage } from "./canvas-items";
import type { AnnotatedImageItem, BoundaryItem, ImageItem, SummaryItem } from "./canvas-items";
import { sniffImage } from "./image-input";
import {
  EXPORT_MAX_EDGE,
  EXPORT_MAX_EMBEDDED_BYTES,
  EXPORT_MAX_PIXELS,
  buildMapSvg,
  exportFileStem,
  exportLimits,
  mapOutline,
  normalizeCssColor,
  toDataUri,
  wrapText,
  type MapScene,
  type SceneBoundary,
  type SceneSummary,
  type SceneCard,
  type SceneEdge,
  type SceneImage
} from "./map-export";
import type { ReferenceOutline } from "./knowledge-refs";
import type { BracketResult } from "./summary-bracket-geometry";
import type { CoverFrame } from "./card-cover";
import type { MapDocument, MapNode } from "../../map-model";
import { t } from "../../i18n";

export interface ExportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Read-only: what the screen drew, read at the moment of the call. */
export interface ExportSceneSource {
  map(): MapDocument | null;
  noteTitle(id: string): string | undefined;
  cards(): Iterable<[string, HTMLElement]>;
  /** A card's layout (normal-zoom) height; the export box uses it so the zoom tier at export time never changes the card. */
  layoutHeight?(id: string): number | undefined;
  texts(): Iterable<HTMLElement>;
  edges(): readonly Element[];
  styleRoot(): Element;
  frameBox(members: readonly string[]): ExportRect | null;
  summaryGeometry(parentId: string, range: readonly string[], text?: string): BracketResult | null;
  coverOf(notePath: string): { path: string; frame: CoverFrame | null } | null;
  /** Null when the path is not a file; the thunk reads its bytes. */
  imageReader(path: string): (() => Promise<ArrayBuffer>) | null;
}
export interface MapExportPorts extends ExportSceneSource {
  path(): string;
  /** Captures the path and open epoch now; the returned check is false once the view closed or moved on. */
  fence(): () => boolean;
  outlineNodes(map: MapDocument): MapNode[];
  outlineSummary(id: string): string;
  /** Reference lines to add to a Markdown outline; absent or empty when the map holds no usable reference to show. */
  referenceOutline?(map: MapDocument): Promise<ReferenceOutline>;
  png(svg: string, width: number, height: number, scale: number): Promise<Blob>;
  host(): HTMLElement;
  attachmentPath(name: string, mapPath: string): Promise<string>;
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
  notice(text: string): void;
}

const boxOf = (card: HTMLElement, layoutHeight?: number): { x: number; y: number; width: number; height: number } => ({
  x: card.offsetLeft,
  y: card.offsetTop,
  width: card.offsetWidth,
  height: layoutHeight || card.offsetHeight
});
/**
 * The lines of an exported text block. The block's real horizontal padding + border is 14, and the exporter's width guess runs wider than
 * the browser's, so the text is widened until it needs no more lines than the screen shows: a fitted one-line block never loses its text.
 */
function textBlockLines(text: string, boxWidth: number, boxHeight: number, lineHeight: number): string[] {
  const shown = Math.max(
    1,
    Math.round((boxHeight - 8) / (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 19))
  );
  let room = Math.max(1, boxWidth - 14);
  let lines = wrapText(text, room);
  for (let tries = 0; lines.length > shown && tries < 40; tries++) {
    room *= 1.1;
    lines = wrapText(text, room);
  }
  return lines;
}
/**
 * The map as the screen shows it (decision D9): card rectangles and edge paths (the fishbone spine included) are
 * read from the drawn DOM, so every layout is followed without a second layout engine; colours come from computed
 * styles; covers and free pictures are read with `readBinary` and embedded as data URIs. `isCurrent` is checked
 * after every await. Returns null when the view moved on, `{ empty }` for nothing to draw, `{ refuse }` when the
 * pictures alone are over the limit (read no further).
 */
export async function collectExportScene(
  source: ExportSceneSource,
  isCurrent: () => boolean
): Promise<{ scene: MapScene; refuse?: undefined } | { scene?: undefined; refuse: "embedded" | "empty" } | null> {
  const map = source.map();
  if (!map) return null;
  const win = window;
  const computed = (el: Element, pseudo?: string): CSSStyleDeclaration => win.getComputedStyle(el, pseudo);
  const colorOf = (value: unknown): string | undefined => normalizeCssColor(value) || undefined;
  // The export shows the saved style: a selection or drag highlight (it switches the border colour) is taken off while
  // the box is measured and put back at once, so the card on screen keeps showing it.
  const transient = ["is-selected", "is-cut", "is-drop-target", "is-marquee-hit", "is-marquee-remove"];
  const savedLook = (el: HTMLElement): { backgroundColor: string; borderTopColor: string; borderTopWidth: string } => {
    const on = transient.filter(name => el.hasClass(name));
    // A card animates its border colour (0.16s): without this the read below would return a colour mid-way.
    if (on.length) {
      el.addClass("vam-export-measure");
      el.removeClass(...on);
    }
    try {
      const look = computed(el);
      return {
        backgroundColor: look.backgroundColor,
        borderTopColor: look.borderTopColor,
        borderTopWidth: look.borderTopWidth
      };
    } finally {
      if (on.length) {
        el.addClass(...on);
        el.removeClass("vam-export-measure");
      }
    }
  };
  let embedded = 0;
  const loaded = new Map<string, string | null>();
  const imageHref = async (path: string): Promise<string | null | false> => {
    const read = source.imageReader(path);
    if (!read) return null;
    if (!loaded.has(path)) {
      const data = await read();
      const mime = sniffImage(data);
      loaded.set(path, mime ? toDataUri(mime, data) : null);
      sizes.set(path, mime ? data.byteLength : 0);
    }
    embedded += sizes.get(path) ?? 0;
    return embedded > EXPORT_MAX_EMBEDDED_BYTES ? false : (loaded.get(path) ?? null);
  };
  const sizes = new Map<string, number>();
  const cards: SceneCard[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number, w: number, h: number): void => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x + w);
    bounds.maxY = Math.max(bounds.maxY, y + h);
  };
  for (const [id, card] of source.cards()) {
    const node = map.nodes.find(item => item.id === id);
    if (!node) continue;
    const box = boxOf(card, source.layoutHeight?.(id));
    grow(box.x, box.y, box.width, box.height);
    const style = savedLook(card);
    const titleEl = card.querySelector<HTMLElement>(".vam-card-title");
    const title = (titleEl?.textContent ?? source.noteTitle(id) ?? "").trim();
    const item: SceneCard = {
      x: box.x,
      y: box.y,
      w: box.width,
      h: box.height,
      title: wrapText(title, box.width - 28),
      fill: colorOf(style.backgroundColor),
      stroke: colorOf(style.borderTopColor),
      textColor: colorOf(titleEl ? computed(titleEl).color : undefined),
      accent: card.dataset.topicColor ? colorOf(computed(card, "::before").backgroundColor) : undefined
    };
    // card-height: only a fixed-height card that cuts its content says so, so a map without heights exports unchanged.
    if (node.height && card.classList.contains("is-clipped")) item.clipped = true;
    // topic-cover-position: under or beside the picture the title is not below the cover, so it goes where the card
    // draws it (and wraps at its own width). A top cover leaves the scene as it was.
    const placedTitle = ["has-cover-bottom", "has-cover-left", "has-cover-right"].some(cls =>
      card.classList.contains(cls)
    );
    if (placedTitle && titleEl && titleEl.offsetWidth > 0) {
      item.titleAt = { x: box.x + titleEl.offsetLeft, y: box.y + titleEl.offsetTop };
      item.title = wrapText(title, titleEl.offsetWidth);
    }
    // The summary the card shows (at most its clamp of lines) is drawn where the screen puts it.
    const summaryEl = card.querySelector<HTMLElement>(".vam-card-summary");
    const summaryText = (
      summaryEl?.querySelector<HTMLElement>(".vam-card-preview-text") ?? summaryEl
    )?.textContent?.trim();
    if (summaryEl && summaryText && summaryEl.offsetWidth > 0) {
      const summaryStyle = computed(summaryEl);
      const clamp = parseInt(summaryStyle.getPropertyValue("-webkit-line-clamp"), 10);
      const size = parseFloat(summaryStyle.fontSize);
      const lines = wrapText(summaryText, summaryEl.offsetWidth);
      item.summary = {
        lines: Number.isFinite(clamp) && clamp > 0 ? lines.slice(0, clamp) : lines,
        x: box.x + summaryEl.offsetLeft,
        y: box.y + summaryEl.offsetTop,
        size: Number.isFinite(size) && size > 0 ? Math.round((size * 13) / 15) : undefined,
        textColor: colorOf(summaryStyle.color)
      };
      if (item.summary.lines.length < lines.length) item.summary.lines[item.summary.lines.length - 1] += "…";
    }
    // card-style: only a styled card carries these, so an unstyled map's scene is unchanged.
    if (card.dataset.topicStyleSize) {
      const size = parseFloat(titleEl ? computed(titleEl).fontSize : "");
      // The screen's small / large title relative to the 13 px export default (medium is 15 px on screen).
      if (Number.isFinite(size) && size > 0) item.titleSize = Math.round((size * 13) / 15);
    }
    if (card.dataset.topicStyleBold) item.titleWeight = 800;
    if (card.dataset.topicStyleBorder) {
      const width = parseFloat(style.borderTopWidth);
      if (Number.isFinite(width) && width > 0) item.strokeWidth = width;
    }
    const frame = card.querySelector<HTMLElement>(".vam-card-cover");
    const coverInfo = frame ? source.coverOf(node.path) : null;
    if (frame && coverInfo) {
      const href = await imageHref(coverInfo.path);
      if (!isCurrent()) return null;
      if (href === false) return { refuse: "embedded" };
      // Only a sized cover has the region's own shape; the lazy 96 px placeholder would stretch the region, so it
      // exports the whole picture proportionally (meet) instead.
      const win =
        coverInfo.frame && frame.classList.contains("is-sized")
          ? frame.querySelector<HTMLElement>(".vam-card-cover-window")
          : null;
      if (href && coverInfo.frame && win && win.offsetWidth > 0 && win.offsetHeight > 0) {
        // A masked cover: the whole picture is placed so the framed region fills the window (at the window's own place
        // in the cover, cover-layout.ts); the export clips to the window, and to the cover when a short card cuts it.
        const mask = coverInfo.frame;
        const winX = box.x + frame.offsetLeft + win.offsetLeft;
        const winY = box.y + frame.offsetTop + win.offsetTop;
        const w = win.offsetWidth / mask.w;
        const h = win.offsetHeight / mask.h;
        const shownHeight = Math.min(win.offsetHeight, Math.max(0, frame.offsetHeight - win.offsetTop));
        item.cover = {
          x: winX - mask.x * w,
          y: winY - mask.y * h,
          w,
          h,
          href,
          fit: "fill",
          window: { x: winX, y: winY, w: win.offsetWidth, h: shownHeight || win.offsetHeight }
        };
      } else if (href)
        item.cover = {
          x: box.x + frame.offsetLeft,
          y: box.y + frame.offsetTop,
          w: frame.offsetWidth,
          h: frame.offsetHeight,
          href,
          fit: "contain"
        };
    }
    cards.push(item);
  }
  // Text nodes as drawn (tree-text-node): plain text with no box, wrapped; the line to the parent is in edgesEl.
  for (const el of source.texts()) {
    const box = boxOf(el);
    grow(box.x, box.y, box.width, box.height);
    const body = el.querySelector<HTMLElement>(".vam-text-node-body");
    cards.push({
      x: box.x,
      y: box.y,
      w: box.width,
      h: box.height,
      title: textBlockLines(
        body?.textContent ?? "",
        box.width,
        box.height,
        parseFloat(computed(body ?? el).lineHeight)
      ),
      plain: true,
      textColor: colorOf(computed(body ?? el).color)
    });
  }
  const images: SceneImage[] = [];
  for (const item of map.canvasItems ?? []) {
    if (item.kind !== "image" && !isAnnotatedImage(item)) continue;
    const image = item as ImageItem | AnnotatedImageItem;
    const href = await imageHref(image.path);
    if (!isCurrent()) return null;
    if (href === false) return { refuse: "embedded" };
    if (!href) continue;
    grow(image.x, image.y, image.w, image.h);
    images.push({ x: image.x, y: image.y, w: image.w, h: image.h, href, fit: "fill" });
  }
  // Frames as drawn on screen: measured from the same cards, so they follow the layout; a frame with no card is left out.
  const boundaries: SceneBoundary[] = [];
  for (const item of map.canvasItems ?? []) {
    if (item.kind !== "boundary") continue;
    const frame = item as BoundaryItem;
    const box = source.frameBox(frame.members);
    if (!box) continue;
    grow(box.x, box.y, box.w, box.h);
    boundaries.push({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      ...(frame.label ? { label: frame.label } : {}),
      stroke: colorOf(computed(source.styleRoot()).getPropertyValue("--text-muted"))
    });
  }
  // Summary brackets as drawn (summary-bracket): the brace path and the text wrapped to its box width, beside the tip.
  const summaryScenes: SceneSummary[] = [];
  for (const item of map.canvasItems ?? []) {
    if (item.kind !== "summary") continue;
    const summary = item as SummaryItem;
    const geometry = source.summaryGeometry(summary.parentId, effectiveSummaryRange(summary, map.nodes), summary.text);
    if (!geometry?.ok) continue;
    const lines = wrapText(summary.text, 200 - 12);
    grow(geometry.extent.x, geometry.extent.y, geometry.extent.w, geometry.extent.h);
    // Make room for the text beside the brace tip.
    const across = geometry.side === "right" || geometry.side === "left";
    grow(
      geometry.side === "left"
        ? geometry.label.x - 200
        : geometry.side === "right"
          ? geometry.label.x
          : geometry.label.x - 100,
      across
        ? geometry.label.y - lines.length * 9
        : geometry.side === "up"
          ? geometry.label.y - lines.length * 17
          : geometry.label.y,
      200,
      across ? lines.length * 18 : lines.length * 17
    );
    summaryScenes.push({
      d: geometry.path,
      x: geometry.label.x,
      y: geometry.label.y,
      side: geometry.side,
      text: lines,
      stroke: colorOf(computed(source.styleRoot()).getPropertyValue("--text-muted")),
      textColor: colorOf(computed(source.styleRoot()).getPropertyValue("--text-normal"))
    });
  }
  const edges: SceneEdge[] = [];
  for (const el of source.edges()) {
    if (el.tagName?.toLowerCase() !== "path") continue;
    // Anchor lines are a view of the image notes, not of the map picture: the export has none of them.
    if (el.getAttribute("data-anchor-relation") !== null) continue;
    const d = el.getAttribute("d");
    const style = computed(el);
    const stroke = colorOf(style.stroke);
    if (!d || !stroke || stroke === "none" || style.display === "none") continue;
    edges.push({
      d,
      stroke,
      ...((el.getAttribute("class") ?? "").split(/\s+/).includes("vam-text-link") ? { dashed: true } : {}),
      ...((el.getAttribute("data-line-thick") ?? null) !== null
        ? { width: parseFloat(style.strokeWidth) > 0 ? parseFloat(style.strokeWidth) : 4 }
        : {})
    });
    try {
      const bbox = (el as unknown as SVGGraphicsElement).getBBox?.();
      if (bbox) grow(bbox.x, bbox.y, bbox.width, bbox.height);
    } catch {
      // A path that cannot be measured is still drawn; it only does not widen the picture.
    }
  }
  if (!cards.length && !images.length) return { refuse: "empty" };
  const margin = 24;
  const root = computed(source.styleRoot());
  const variable = (name: string): string | undefined => colorOf(root.getPropertyValue(name));
  const scene: MapScene = {
    x: bounds.minX - margin,
    y: bounds.minY - margin,
    width: bounds.maxX - bounds.minX + margin * 2,
    height: bounds.maxY - bounds.minY + margin * 2,
    title: map.title,
    theme: {
      background: variable("--background-primary"),
      text: variable("--text-normal"),
      stroke: variable("--background-modifier-border"),
      card: variable("--background-primary")
    },
    boundaries,
    edges,
    summaries: summaryScenes,
    cards,
    images
  };
  return { scene };
}
/** A download through a blob URL; the URL is released shortly after the click. */
function downloadBlob(host: HTMLElement, blob: Blob, name: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = host.createEl("a", { cls: "vam-sr-only", attr: { href: url, download: name } });
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}
/**
 * Exports the map as PNG, SVG or a Markdown outline, saved next to the other attachments of Map.md or downloaded.
 * An export is not a map edit: no transaction, no undo step. A result that is ready after the view closed or moved
 * to another map is thrown away (nothing written, nothing said).
 */
export async function exportMap(
  source: MapExportPorts,
  format: "png" | "svg" | "md",
  target: "vault" | "download"
): Promise<void> {
  const map = source.map();
  if (!map) return;
  const mapPath = source.path(),
    isCurrent = source.fence();
  try {
    let blob: Blob;
    if (format === "md") {
      const refs = (await source.referenceOutline?.(map)) ?? { nodes: [], titles: new Map<string, string>() };
      if (!isCurrent()) return;
      if (refs.nodes.length) source.notice(t("ui.knowledge_ref_export_notice"));
      const outline = mapOutline(
        [...source.outlineNodes(map), ...refs.nodes],
        id => refs.titles.get(id) ?? source.noteTitle(id) ?? "",
        id => (refs.titles.has(id) ? "" : source.outlineSummary(id)),
        map.title
      );
      blob = new Blob([`${outline}\n`], { type: "text/markdown;charset=utf-8" });
    } else {
      const got = await collectExportScene(source, isCurrent);
      if (!got || !isCurrent()) return;
      if (got.refuse) {
        source.notice(t(got.refuse === "empty" ? "ui.export_empty" : "ui.export_refused_embedded"));
        return;
      }
      const limit = exportLimits(got.scene);
      if (limit.action === "refuse") {
        source.notice(
          t(
            limit.reason === "embedded"
              ? "ui.export_refused_embedded"
              : limit.reason === "pixels"
                ? "ui.export_refused_pixels"
                : "ui.export_empty"
          )
        );
        return;
      }
      const svg = buildMapSvg(got.scene);
      if (format === "svg") blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      else {
        const { width, height } = got.scene;
        let scale = 1;
        if (limit.action === "scaleDown") {
          scale = limit.scale;
          source.notice(t("ui.export_scaled", String(EXPORT_MAX_EDGE)));
        } else if (Math.max(width, height) * 2 <= EXPORT_MAX_EDGE && width * height * 4 <= EXPORT_MAX_PIXELS) scale = 2;
        blob = await source.png(svg, width, height, scale);
        if (!isCurrent()) return;
      }
    }
    const name = `${exportFileStem(map.title)}.${format}`;
    if (target === "download") {
      downloadBlob(source.host(), blob, name);
      source.notice(t("ui.export_downloaded", name));
      return;
    }
    const data = await blob.arrayBuffer();
    const destination = await source.attachmentPath(name, mapPath);
    // Last check before anything is written.
    if (!isCurrent()) return;
    await source.createBinary(destination, data);
    source.notice(t("ui.export_saved", destination));
  } catch (error) {
    if (isCurrent()) source.notice(t("ui.export_failed", errorMessage(error)));
  }
}
