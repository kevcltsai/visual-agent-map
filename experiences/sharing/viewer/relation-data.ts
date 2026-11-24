// What the share viewer takes from the payload's relation and frame fields, and the arrowhead geometry. Everything here is
// untrusted input: a kind must be on the whitelist, ends must be ids that are in the file, text is kept as plain strings.
// No DOM and no imports of plugin modules, so a unit test can load it directly.

export type ViewerRelationKind = "supports" | "contradicts" | "verifies" | "derives_from" | "related" | "prerequisite";
export const VIEWER_RELATION_KINDS: readonly ViewerRelationKind[] = [
  "supports",
  "contradicts",
  "verifies",
  "derives_from",
  "related",
  "prerequisite"
];
export const readRelationKind = (value: unknown): ViewerRelationKind | undefined =>
  typeof value === "string" && (VIEWER_RELATION_KINDS as readonly string[]).includes(value)
    ? (value as ViewerRelationKind)
    : undefined;

const RELATION_LIMIT = 2000;
const FRAME_LIMIT = 200;
const MEMBER_LIMIT = 2000;
const TEXT_LIMIT = 200;

export interface ViewerRelation {
  kind: ViewerRelationKind;
  from: string;
  to: string;
  description: string;
}
export interface ViewerFrame {
  id: string;
  members: string[];
  label: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const plainLine = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT) : "";

/** The topic relations of a payload: a known kind, both ends in the file, not the same topic, one line per kind and pair. */
export function readRelations(raw: unknown, topicIds: ReadonlySet<string>): ViewerRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewerRelation[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, RELATION_LIMIT)) {
    if (!isRecord(item)) continue;
    const kind = readRelationKind(item.kind);
    const { from, to } = item;
    if (!kind || typeof from !== "string" || typeof to !== "string" || from === to) continue;
    if (!topicIds.has(from) || !topicIds.has(to)) continue;
    const key = `${kind}\u0000${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, from, to, description: plainLine(item.description) });
  }
  return out;
}

/** The frames of a payload: members must be ids the file draws; a frame left with no member is dropped. */
export function readFrames(raw: unknown, presentIds: ReadonlySet<string>): ViewerFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewerFrame[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, FRAME_LIMIT)) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || seen.has(item.id)) continue;
    if (!Array.isArray(item.members)) continue;
    const members = [
      ...new Set(item.members.slice(0, MEMBER_LIMIT).filter((id): id is string => typeof id === "string" && presentIds.has(id)))
    ];
    if (!members.length) continue;
    seen.add(item.id);
    out.push({ id: item.id, members, label: plainLine(item.label) });
  }
  return out;
}

interface Point {
  x: number;
  y: number;
}
const ARROW_LENGTH = 10;
const ARROW_HALF_WIDTH = 5;
const BAR_BACK = 14;
const BAR_THICKNESS = 2;

/** The end point and the unit direction the line arrives in, read from the cubic path the geometry modules write ("M x y C x y, x y, x y"); null for anything else. */
export function pathEnd(d: string): { tip: Point; ux: number; uy: number } | null {
  const numbers = (d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  if (numbers.length !== 8 || !numbers.every(Number.isFinite)) return null;
  const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = numbers;
  // Objects, not pairs: the bundle may not contain a double opening bracket (the leak gate reads it as a wikilink).
  for (const from of [
    { x: cx2, y: cy2 },
    { x: cx1, y: cy1 },
    { x: x1, y: y1 }
  ]) {
    const length = Math.hypot(x2 - from.x, y2 - from.y);
    if (length > 1e-6) return { tip: { x: x2, y: y2 }, ux: (x2 - from.x) / length, uy: (y2 - from.y) / length };
  }
  return null;
}

const round = (value: number): number => Math.round(value * 100) / 100;
const points = (list: Point[]): string => list.map(point => `${round(point.x)},${round(point.y)}`).join(" ");

/**
 * Arrowhead polygons for the end of a line (polygons, not markers: the file may not contain `url(`). The plain head is a
 * triangle whose tip is the end of the line; "contradicts" adds a bar across the line just before the head, as the map's barred marker.
 * Returns the polygons' `points` values.
 */
export function arrowPolygons(d: string, barred: boolean): string[] {
  const end = pathEnd(d);
  if (!end) return [];
  const { tip, ux, uy } = end;
  const nx = -uy,
    ny = ux;
  const at = (back: number, side: number): Point => ({ x: tip.x - ux * back + nx * side, y: tip.y - uy * back + ny * side });
  const head = points([at(0, 0), at(ARROW_LENGTH, ARROW_HALF_WIDTH), at(ARROW_LENGTH, -ARROW_HALF_WIDTH)]);
  if (!barred) return [head];
  const back = BAR_BACK;
  const bar = points([
    at(back, ARROW_HALF_WIDTH),
    at(back - BAR_THICKNESS, ARROW_HALF_WIDTH),
    at(back - BAR_THICKNESS, -ARROW_HALF_WIDTH),
    at(back, -ARROW_HALF_WIDTH)
  ]);
  return [head, bar];
}
