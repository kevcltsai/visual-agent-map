// Structured book figures (bar, scale, graph, board): the model fills a small JSON, the plugin checks it against the chapter text and
// draws it (figure-layout.ts). Pure functions only. Every number is a string exactly as written in the text ("69.0", not 69), so a
// number check is a string lookup; coordinates (board rows/columns of a cell) are positions the plugin draws, not quantities.
import { noteNumbers, numberTokens } from "../steps/chart/insert";

export type FigureCode = "figure_type" | "figure_shape" | "unsafe_text" | "number_not_in_text" | "bad_body";

export interface BarFigure {
  type: "bar";
  unit?: string;
  stacked: boolean;
  groups: { label: string; values: { series?: string; value: string }[] }[];
}
export type ScaleMark = { label: string; at: string } | { label: string; from: string; to: string };
export interface ScaleFigure {
  type: "scale";
  unit?: string;
  min: string;
  max: string;
  marks: ScaleMark[];
}
export interface GraphFigure {
  type: "graph";
  directed: boolean;
  layout: "circle" | "row";
  nodes: { id: string; label: string }[];
  edges: { from: string; to: string; label?: string }[];
}
export type Cell = [number, number];
export interface BoardFigure {
  type: "board";
  rows: string;
  cols: string;
  shade: "checker" | "none";
  cells: { row: number; col: number; label?: string; cut?: boolean }[];
  pairs: { a: Cell; b: Cell; label?: string }[];
}
export type FigureSpec = BarFigure | ScaleFigure | GraphFigure | BoardFigure;

export const FIGURE_TYPES = ["bar", "scale", "graph", "board"] as const;
export const FIGURE_LIMITS = {
  groups: 6,
  series: 3,
  marks: 6,
  nodes: 8,
  edges: 12,
  side: 10,
  cells: 100,
  pairs: 10,
  text: 24,
  body: 1500
};

export type ParseFigure = { ok: true; spec: FigureSpec } | { ok: false; code: "figure_type" | "figure_shape" };
export type FigureCheck = { ok: true; body: string } | { ok: false; code: FigureCode };

class Shape extends Error {}
const bad = (): never => {
  throw new Shape("figure_shape");
};
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const absent = (v: unknown): boolean => v === undefined || v === null;
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : bad();
const arr = (v: unknown, max: number, min = 0): unknown[] =>
  Array.isArray(v) && v.length >= min && v.length <= max ? v : bad();
const text = (v: unknown): string =>
  typeof v === "string" && v.trim() && v.length <= FIGURE_LIMITS.text ? v.trim() : bad();
const optText = (v: unknown): string | undefined => (absent(v) || v === "" ? undefined : text(v));
const num = (v: unknown): string =>
  typeof v === "string" && v.length <= 12 && NUMERIC.test(v.trim()) ? v.trim() : bad();
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : bad());
const int = (v: unknown, max: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : bad();
const side = (v: unknown): string => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN;
  return String(int(n, FIGURE_LIMITS.side));
};
const cell = (v: unknown): Cell => {
  const a = arr(v, 2, 2);
  return [int(a[0], FIGURE_LIMITS.side), int(a[1], FIGURE_LIMITS.side)];
};

function parseBar(r: Record<string, unknown>): BarFigure {
  const groups = arr(r.groups, FIGURE_LIMITS.groups, 1).map(g => {
    const o = obj(g);
    const values = arr(o.values, FIGURE_LIMITS.series, 1).map(x => {
      const v = obj(x);
      const series = optText(v.series);
      const value = num(v.value);
      if (Number(value) < 0) bad();
      return series === undefined ? { value } : { series, value };
    });
    return { label: text(o.label), values };
  });
  const unit = optText(r.unit);
  const stacked = absent(r.stacked) ? false : bool(r.stacked);
  const total = (g: BarFigure["groups"][number]): number =>
    stacked ? g.values.reduce((s, v) => s + Number(v.value), 0) : Math.max(...g.values.map(v => Number(v.value)));
  if (!(Math.max(...groups.map(total)) > 0)) bad();
  return { type: "bar", ...(unit === undefined ? {} : { unit }), stacked, groups };
}

function parseScale(r: Record<string, unknown>): ScaleFigure {
  const min = num(r.min),
    max = num(r.max);
  if (!(Number(min) < Number(max))) bad();
  const inside = (v: string): string => (Number(v) >= Number(min) && Number(v) <= Number(max) ? v : bad());
  const marks = arr(r.marks, FIGURE_LIMITS.marks, 1).map((m): ScaleMark => {
    const o = obj(m);
    const label = text(o.label);
    if (!absent(o.at)) {
      if (!absent(o.from) || !absent(o.to)) bad();
      return { label, at: inside(num(o.at)) };
    }
    const from = inside(num(o.from)),
      to = inside(num(o.to));
    if (!(Number(from) < Number(to))) bad();
    return { label, from, to };
  });
  const unit = optText(r.unit);
  return { type: "scale", ...(unit === undefined ? {} : { unit }), min, max, marks };
}

function parseGraph(r: Record<string, unknown>): GraphFigure {
  const nodes = arr(r.nodes, FIGURE_LIMITS.nodes, 1).map(n => {
    const o = obj(n);
    return { id: text(o.id), label: text(o.label) };
  });
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) bad();
  const ids = new Set(nodes.map(n => n.id));
  const edges = arr(r.edges, FIGURE_LIMITS.edges).map(e => {
    const o = obj(e);
    const from = text(o.from),
      to = text(o.to),
      label = optText(o.label);
    if (!ids.has(from) || !ids.has(to) || from === to) bad();
    return label === undefined ? { from, to } : { from, to, label };
  });
  const layout = r.layout;
  if (layout !== "circle" && layout !== "row") bad();
  return { type: "graph", directed: bool(r.directed), layout: layout as "circle" | "row", nodes, edges };
}

function parseBoard(r: Record<string, unknown>): BoardFigure {
  const rows = side(r.rows),
    cols = side(r.cols);
  const inGrid = (c: Cell): Cell => (c[0] <= Number(rows) && c[1] <= Number(cols) ? c : bad());
  const seen = new Set<string>();
  const cells = arr(r.cells, FIGURE_LIMITS.cells).map(c => {
    const o = obj(c);
    const [row, col] = inGrid([int(o.row, FIGURE_LIMITS.side), int(o.col, FIGURE_LIMITS.side)]);
    if (seen.has(`${row},${col}`)) bad();
    seen.add(`${row},${col}`);
    const label = optText(o.label);
    const cut = absent(o.cut) ? false : bool(o.cut);
    return { row, col, ...(label === undefined ? {} : { label }), ...(cut ? { cut } : {}) };
  });
  const pairs = arr(r.pairs, FIGURE_LIMITS.pairs).map(p => {
    const o = obj(p);
    const a = inGrid(cell(o.a)),
      b = inGrid(cell(o.b));
    if (a[0] === b[0] && a[1] === b[1]) bad();
    const label = optText(o.label);
    return label === undefined ? { a, b } : { a, b, label };
  });
  const shade = r.shade === undefined || r.shade === null ? "none" : r.shade;
  if (shade !== "checker" && shade !== "none") bad();
  return { type: "board", rows, cols, shade: shade as "checker" | "none", cells, pairs };
}

/** The model's figure (an object, or the JSON text of one) as a clean spec: unknown keys dropped, null read as absent. */
export function parseFigure(raw: unknown): ParseFigure {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, code: "figure_shape" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "figure_shape" };
  const r = value as Record<string, unknown>;
  const builders: Record<string, (x: Record<string, unknown>) => FigureSpec> = {
    bar: parseBar,
    scale: parseScale,
    graph: parseGraph,
    board: parseBoard
  };
  if (typeof r.type !== "string" || !Object.prototype.hasOwnProperty.call(builders, r.type))
    return { ok: false, code: "figure_type" };
  try {
    return { ok: true, spec: builders[r.type](r) };
  } catch (error) {
    if (error instanceof Shape) return { ok: false, code: "figure_shape" };
    throw error;
  }
}

/** The stored form: fixed key order, no spaces, so the same figure always has the same text (and hash). */
export function canonicalFigureJson(spec: FigureSpec): string {
  const o = (pairs: [string, unknown][]): Record<string, unknown> =>
    Object.fromEntries(pairs.filter(([, v]) => v !== undefined));
  switch (spec.type) {
    case "bar":
      return JSON.stringify(
        o([
          ["type", "bar"],
          ["unit", spec.unit],
          ["stacked", spec.stacked],
          [
            "groups",
            spec.groups.map(g =>
              o([
                ["label", g.label],
                [
                  "values",
                  g.values.map(v =>
                    o([
                      ["series", v.series],
                      ["value", v.value]
                    ])
                  )
                ]
              ])
            )
          ]
        ])
      );
    case "scale":
      return JSON.stringify(
        o([
          ["type", "scale"],
          ["unit", spec.unit],
          ["min", spec.min],
          ["max", spec.max],
          [
            "marks",
            spec.marks.map(m =>
              "at" in m
                ? o([
                    ["label", m.label],
                    ["at", m.at]
                  ])
                : o([
                    ["label", m.label],
                    ["from", m.from],
                    ["to", m.to]
                  ])
            )
          ]
        ])
      );
    case "graph":
      return JSON.stringify(
        o([
          ["type", "graph"],
          ["directed", spec.directed],
          ["layout", spec.layout],
          [
            "nodes",
            spec.nodes.map(n =>
              o([
                ["id", n.id],
                ["label", n.label]
              ])
            )
          ],
          [
            "edges",
            spec.edges.map(e =>
              o([
                ["from", e.from],
                ["to", e.to],
                ["label", e.label]
              ])
            )
          ]
        ])
      );
    case "board":
      return JSON.stringify(
        o([
          ["type", "board"],
          ["rows", spec.rows],
          ["cols", spec.cols],
          ["shade", spec.shade],
          [
            "cells",
            spec.cells.map(c =>
              o([
                ["row", c.row],
                ["col", c.col],
                ["label", c.label],
                ["cut", c.cut]
              ])
            )
          ],
          [
            "pairs",
            spec.pairs.map(p =>
              o([
                ["a", p.a],
                ["b", p.b],
                ["label", p.label]
              ])
            )
          ]
        ])
      );
  }
}

/** Strings the figure shows (ids and edge endpoints are only references). */
function shownStrings(spec: FigureSpec): string[] {
  switch (spec.type) {
    case "bar":
      return [
        ...(spec.unit ? [spec.unit] : []),
        ...spec.groups.flatMap(g => [g.label, ...g.values.flatMap(v => [v.value, ...(v.series ? [v.series] : [])])])
      ];
    case "scale":
      return [
        ...(spec.unit ? [spec.unit] : []),
        spec.min,
        spec.max,
        ...spec.marks.flatMap(m => ("at" in m ? [m.label, m.at] : [m.label, m.from, m.to]))
      ];
    case "graph":
      return [...spec.nodes.map(n => n.label), ...spec.edges.flatMap(e => (e.label ? [e.label] : []))];
    case "board":
      return [
        ...spec.cells.flatMap(c => (c.label ? [c.label] : [])),
        ...spec.pairs.flatMap(p => (p.label ? [p.label] : []))
      ];
  }
}

// markup, links, footnote and marker brackets, image and code marks
const UNSAFE = /[<>[\]!`〔〕]|:\/\/|www\./i;
const hasControl = (s: string): boolean => [...s].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/**
 * Pure per-figure check, so one failing figure is dropped alone. `chapterText` is the chapter text the model saw. Passes when: every shown
 * string is plain text; every number of every shown string is a number of the text (as written: "69" does not match "69.0"); a board's
 * rows and columns are in the text too, unless it is one row, whose columns must then equal its labelled cells; the stored JSON is at
 * most {@link FIGURE_LIMITS}.body characters. Returns the canonical JSON.
 */
export function checkFigure(spec: FigureSpec, chapterText: string): FigureCheck {
  const shown = shownStrings(spec);
  if (shown.some(s => UNSAFE.test(s) || hasControl(s))) return { ok: false, code: "unsafe_text" };
  const known = noteNumbers(chapterText);
  const numbers = shown.flatMap(numberTokens);
  if (spec.type === "board") {
    if (spec.rows === "1") {
      if (spec.cells.filter(c => c.label).length !== Number(spec.cols)) return { ok: false, code: "figure_shape" };
    } else numbers.push(spec.rows, spec.cols);
  }
  if (numbers.some(n => !known.has(n))) return { ok: false, code: "number_not_in_text" };
  const body = canonicalFigureJson(spec);
  if (body.length > FIGURE_LIMITS.body) return { ok: false, code: "bad_body" };
  return { ok: true, body };
}
