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
  cover?: SceneImage | null;
}
export interface SceneImage {
  x: number;
  y: number;
  w: number;
  h: number;
  href: string;
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
function rect(x: unknown, y: unknown, w: unknown, h: unknown): [number, number, number, number] | null {
  const [bx, by, bw, bh] = [num(x), num(y), num(w), num(h)];
  return bx !== null && by !== null && bw !== null && bh !== null && bw > 0 && bh > 0 ? [bx, by, bw, bh] : null;
}
function imageElement(image: SceneImage | null | undefined): string {
  if (!image || typeof image.href !== "string" || !DATA_IMAGE.test(image.href)) return "";
  const box = rect(image.x, image.y, image.w, image.h);
  return box ? `<image x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" href="${image.href}"/>` : "";
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
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  ];
  if (typeof scene.title === "string" && scene.title)
    out.push(`<title>${escapeXml(scene.title.slice(0, TEXT_LIMIT))}</title>`);
  out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>`);

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
    out.push(imageElement(card.cover));
    const fill = color(card.textColor, textColor);
    textLines(card.title).forEach((line, i) => {
      out.push(
        `<text x="${box[0] + 10}" y="${box[1] + box[3] - 12 - (textLines(card.title).length - 1 - i) * 16}" font-family="${FONT}" font-size="13" fill="${fill}">${escapeXml(line)}</text>`
      );
    });
    out.push("</g>");
  }
  out.push("</svg>");
  return out.filter(Boolean).join("\n");
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
