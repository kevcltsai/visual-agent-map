/**
 * Map export builders (map-images P2). The SVG is built from a whitelist: only the elements
 * `svg g rect path line text image title`, only numeric geometry and sanitised colours, text escaped, and an image
 * href only when it is a base64 PNG/JPEG/GIF/WebP data URI. Nothing in the scene can add a script, a style, an event
 * attribute, a url() reference or an external href. Pure functions, no DOM.
 */
export interface SceneCard {
  x: number;
  y: number;
  w: number;
  h: number;
  /** One string per line. */
  title: string | string[];
  fill?: string;
  stroke?: string;
  textColor?: string;
  /** The topic-colour bar at the card's left edge (the `::before` of a card that has a topic colour). */
  accent?: string;
  cover?: SceneImage | null;
}
export interface SceneImage {
  x: number;
  y: number;
  w: number;
  h: number;
  href: string;
  /** "cover" crops to fill the box (a card cover); anything else stretches to it (a free canvas image). */
  fit?: "cover" | "fill";
}
export interface SceneEdge {
  d: string;
  stroke?: string;
}
export interface SceneBoundary {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  stroke?: string;
}
export interface SceneTheme {
  background?: string;
  text?: string;
  stroke?: string;
  card?: string;
}
export interface MapScene {
  /** Top-left of the drawn area in the scene's own coordinates (default 0, 0); edge paths are written as they are. */
  x?: number;
  y?: number;
  width: number;
  height: number;
  title?: string;
  theme?: SceneTheme;
  boundaries?: SceneBoundary[];
  edges?: SceneEdge[];
  cards?: SceneCard[];
  images?: SceneImage[];
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\(\s*[\d.%\s,/-]+\)|[a-zA-Z]{3,20})$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.eE+-]+$/;
const FONT = "sans-serif";
const TEXT_LIMIT = 300;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const isXmlControl = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffe || code === 0xffff;
};
const escapeXml = (text: string): string =>
  Array.from(text)
    .filter(ch => !isXmlControl(ch))
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
/** A colour that cannot carry anything but a colour: hex, rgb()/hsl() with digits only, or a plain keyword. */
function color(value: unknown, fallback: string): string {
  return typeof value === "string" && COLOR.test(value.trim()) && !/url|expression|var/i.test(value)
    ? value.trim()
    : fallback;
}
/**
 * A computed colour as the browser reports it, made plain: `color(srgb r g b / a)` (what a resolved `color-mix()` can
 * serialise to) becomes `rgb()`/`rgba()`; a fully transparent colour becomes "". Anything else is returned trimmed.
 */
export function normalizeCssColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || text === "transparent") return "";
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (srgb) {
    const channel = (v: string): number => Math.max(0, Math.min(255, Math.round(Number(v) * 255)));
    const alpha =
      srgb[4] === undefined ? 1 : srgb[4].endsWith("%") ? Number.parseFloat(srgb[4]) / 100 : Number(srgb[4]);
    if (!Number.isFinite(alpha) || alpha <= 0) return "";
    const [r, g, b] = [channel(srgb[1]), channel(srgb[2]), channel(srgb[3])];
    return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
  }
  const rgba = /^rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+\s*[,/]\s*0(?:\.0+)?%?\s*\)$/.exec(text);
  return rgba ? "" : text;
}
function rect(x: unknown, y: unknown, w: unknown, h: unknown): [number, number, number, number] | null {
  const [bx, by, bw, bh] = [num(x), num(y), num(w), num(h)];
  return bx !== null && by !== null && bw !== null && bh !== null && bw > 0 && bh > 0 ? [bx, by, bw, bh] : null;
}
function imageElement(image: SceneImage | null | undefined): string {
  if (!image || typeof image.href !== "string" || !DATA_IMAGE.test(image.href)) return "";
  const box = rect(image.x, image.y, image.w, image.h);
  // An image element clips to its own box, so "slice" crops a cover the way the card's object-fit: cover does.
  const fit = image.fit === "cover" ? "xMidYMid slice" : "none";
  return box
    ? `<image x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" preserveAspectRatio="${fit}" href="${image.href}"/>`
    : "";
}
function textLines(title: string | string[]): string[] {
  const raw = Array.isArray(title) ? title : String(title ?? "").split(/\r?\n/);
  return raw.slice(0, 20).map(line => String(line).slice(0, TEXT_LIMIT));
}

/** Builds the export SVG from a scene. Returns "" when the canvas size itself is unusable. */
export function buildMapSvg(scene: MapScene): string {
  const width = num(scene?.width);
  const height = num(scene?.height);
  if (width === null || height === null || width <= 0 || height <= 0) return "";
  const theme = scene.theme ?? {};
  const background = color(theme.background, "#ffffff");
  const textColor = color(theme.text, "#222222");
  const strokeColor = color(theme.stroke, "#888888");
  const cardColor = color(theme.card, "#ffffff");
  const originX = num(scene.x) ?? 0;
  const originY = num(scene.y) ?? 0;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${originX} ${originY} ${width} ${height}">`
  ];
  if (typeof scene.title === "string" && scene.title)
    out.push(`<title>${escapeXml(scene.title.slice(0, TEXT_LIMIT))}</title>`);
  out.push(`<rect x="${originX}" y="${originY}" width="${width}" height="${height}" fill="${background}"/>`);

  for (const b of scene.boundaries ?? []) {
    const box = rect(b?.x, b?.y, b?.w, b?.h);
    if (!box) continue;
    const stroke = color(b.stroke, strokeColor);
    out.push(
      `<g><rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" rx="12" fill="none" stroke="${stroke}" stroke-dasharray="6 4"/>`
    );
    if (typeof b.label === "string" && b.label)
      out.push(
        `<text x="${box[0] + 8}" y="${box[1] + 16}" font-family="${FONT}" font-size="12" fill="${stroke}">${escapeXml(b.label.slice(0, TEXT_LIMIT))}</text>`
      );
    out.push("</g>");
  }
  for (const edge of scene.edges ?? []) {
    if (typeof edge?.d !== "string" || !PATH_DATA.test(edge.d) || edge.d.length > 4000) continue;
    out.push(`<path d="${edge.d.trim()}" fill="none" stroke="${color(edge.stroke, strokeColor)}" stroke-width="1.5"/>`);
  }
  for (const image of scene.images ?? []) out.push(imageElement(image));
  for (const card of scene.cards ?? []) {
    const box = rect(card?.x, card?.y, card?.w, card?.h);
    if (!box) continue;
    out.push(
      `<g><rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" rx="8" fill="${color(card.fill, cardColor)}" stroke="${color(card.stroke, strokeColor)}"/>`
    );
    if (card.accent !== undefined)
      out.push(
        `<rect x="${box[0]}" y="${box[1] + 14}" width="4" height="${Math.max(1, box[3] - 28)}" rx="2" fill="${color(card.accent, strokeColor)}"/>`
      );
    out.push(imageElement(card.cover));
    const fill = color(card.textColor, textColor);
    const coverBox = card.cover ? rect(card.cover.x, card.cover.y, card.cover.w, card.cover.h) : null;
    const top = (coverBox ? coverBox[1] + coverBox[3] : box[1]) + 22;
    const fits = Math.max(1, Math.floor((box[1] + box[3] - 8 - top) / 16) + 1);
    textLines(card.title)
      .slice(0, fits)
      .forEach((line, i) => {
        out.push(
          `<text x="${box[0] + 14}" y="${top + i * 16}" font-family="${FONT}" font-size="13" fill="${fill}">${escapeXml(line)}</text>`
        );
      });
    out.push("</g>");
  }
  out.push("</svg>");
  return out.filter(Boolean).join("\n");
}

/** Lays a title out in lines no wider than `maxWidth` px (wide characters count 13, the rest 7). */
export function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    let line = "";
    let used = 0;
    for (const ch of Array.from(paragraph)) {
      const w = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 13 : 7;
      if (used + w > maxWidth && line) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += ch;
      used += w;
    }
    lines.push(line);
  }
  return lines;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** `data:<mime>;base64,...` for bytes; no DOM API is needed. */
export function toDataUri(mime: string, bytes: Uint8Array | ArrayBuffer): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += 3) {
    const n = (data[i] << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    parts.push(
      BASE64[(n >> 18) & 63] +
        BASE64[(n >> 12) & 63] +
        (i + 1 < data.length ? BASE64[(n >> 6) & 63] : "=") +
        (i + 2 < data.length ? BASE64[n & 63] : "=")
    );
  }
  return `data:${mime};base64,${parts.join("")}`;
}

/** A file name stem that is safe in a Vault and in a download: link and path characters become "-". */
export function exportFileStem(title: string): string {
  const stem = String(title ?? "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return stem || "Mind map";
}

export interface PngEnv {
  /** Decodes the SVG text into a drawable image; `release` frees whatever the decode held. */
  load(svg: string): Promise<{ image: CanvasImageSource; release(): void }>;
  canvas(width: number, height: number): { context: CanvasRenderingContext2D | null; toBlob(): Promise<Blob | null> };
}
/** PNG: SVG -> image -> canvas -> blob. The canvas is only created here, after the caller has checked the limits. */
export async function svgToPngBlob(
  svg: string,
  width: number,
  height: number,
  scale: number,
  env: PngEnv
): Promise<Blob> {
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const loaded = await env.load(svg);
  try {
    const canvas = env.canvas(w, h);
    if (!canvas.context) throw new Error("canvas");
    canvas.context.drawImage(loaded.image, 0, 0, w, h);
    const blob = await canvas.toBlob();
    if (!blob) throw new Error("png");
    return blob;
  } finally {
    loaded.release();
  }
}

/** The real image/canvas plumbing of a window; kept out of `svgToPngBlob` so the limits can be tested without a canvas. */
export function browserPngEnv(doc: Document, urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">): PngEnv {
  return {
    async load(svg: string) {
      const url = urls.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      const image = doc.createEl("img");
      try {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("image"));
          image.src = url;
        });
      } catch (error) {
        urls.revokeObjectURL(url);
        throw error;
      }
      return { image, release: () => urls.revokeObjectURL(url) };
    },
    canvas(width: number, height: number) {
      const canvas = doc.createEl("canvas");
      canvas.width = width;
      canvas.height = height;
      return {
        context: canvas.getContext("2d"),
        toBlob: () => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"))
      };
    }
  };
}

export const EXPORT_MAX_EDGE = 8192;
export const EXPORT_MAX_PIXELS = 64_000_000;
export const EXPORT_MAX_EMBEDDED_BYTES = 50 * 1024 * 1024;
export type ExportLimit =
  | { action: "ok"; scale: 1 }
  | { action: "scaleDown"; scale: number }
  | { action: "refuse"; reason: "pixels" | "embedded" | "size" };

/** Decoded size of a base64 data URI body, or 0 when it is not one. */
function embeddedBytes(href: unknown): number {
  const body = typeof href === "string" ? /^data:[^,]*;base64,(.*)$/.exec(href)?.[1] : undefined;
  return body ? Math.floor((body.length * 3) / 4) : 0;
}

/**
 * Limits of decision D9: embedded images over 50 MB or total pixels over 64M are refused; a longest side over 8192 px is
 * scaled down to 8192.
 */
export function exportLimits(scene: MapScene): ExportLimit {
  const width = num(scene?.width);
  const height = num(scene?.height);
  if (width === null || height === null || width <= 0 || height <= 0) return { action: "refuse", reason: "size" };
  const images = [...(scene.images ?? []), ...(scene.cards ?? []).map(card => card?.cover)];
  const bytes = images.reduce((sum: number, image) => sum + embeddedBytes(image?.href), 0);
  if (bytes > EXPORT_MAX_EMBEDDED_BYTES) return { action: "refuse", reason: "embedded" };
  if (width * height > EXPORT_MAX_PIXELS) return { action: "refuse", reason: "pixels" };
  const longest = Math.max(width, height);
  return longest > EXPORT_MAX_EDGE
    ? { action: "scaleDown", scale: EXPORT_MAX_EDGE / longest }
    : { action: "ok", scale: 1 };
}

export interface OutlineNode {
  id: string;
  parentId?: string | null;
  collapsed?: boolean;
}

/**
 * Markdown outline of the whole map in node order, two spaces per level. Collapsed branches are written out in full:
 * collapsing is a view state, not content.
 */
export function mapOutline(nodes: OutlineNode[], titleOf: (id: string) => string): string {
  const ids = new Set(nodes.map(n => n.id));
  const children = new Map<string, OutlineNode[]>();
  const roots: OutlineNode[] = [];
  for (const node of nodes) {
    if (node.parentId && ids.has(node.parentId) && node.parentId !== node.id) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    } else roots.push(node);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (node: OutlineNode, depth: number): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const title =
      String(titleOf(node.id) ?? "")
        .replace(/\s+/g, " ")
        .trim() || node.id;
    lines.push(`${"  ".repeat(depth)}- ${title}`);
    for (const child of children.get(node.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return lines.join("\n");
}
