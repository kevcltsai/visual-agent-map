// Layout of a checked figure (figure-spec.ts) as a neutral tree; a thin DOM layer turns it into SVG. Pure. Attributes hold only numbers
// this file computed and fixed class names, never text from the figure; the figure's words go in `text`.
import type { BarFigure, BoardFigure, FigureSpec, GraphFigure, ScaleFigure } from "./figure-spec";

export interface FigureNode {
  tag: "svg" | "g" | "rect" | "line" | "circle" | "polygon" | "path" | "text" | "title" | "defs" | "marker";
  attrs: Record<string, string | number>;
  text?: string;
  children: FigureNode[];
}

export const FIGURE_WIDTH = 480;
export const FIGURE_MAX_HEIGHT = 320;
const ARROW = "url(#vam-ah)";

const r1 = (n: number): number => Math.round(n * 10) / 10;
const el = (
  tag: FigureNode["tag"],
  attrs: FigureNode["attrs"],
  children: FigureNode[] = [],
  text?: string
): FigureNode => ({
  tag,
  attrs,
  ...(text === undefined ? {} : { text }),
  children
});
const label = (
  x: number,
  y: number,
  s: string,
  cls = "fig-text",
  anchor: "middle" | "start" | "end" = "middle"
): FigureNode => el("text", { x: r1(x), y: r1(y), class: cls, "text-anchor": anchor }, [], s);
const line = (x1: number, y1: number, x2: number, y2: number, cls: string, arrow = false): FigureNode =>
  el("line", { x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), class: cls, ...(arrow ? { "marker-end": ARROW } : {}) });
const rect = (x: number, y: number, w: number, h: number, cls: string, rx = 0): FigureNode =>
  el("rect", {
    x: r1(x),
    y: r1(y),
    width: r1(Math.max(0, w)),
    height: r1(Math.max(0, h)),
    class: cls,
    ...(rx ? { rx } : {})
  });
const arrowDefs = (): FigureNode =>
  el("defs", {}, [
    el(
      "marker",
      { id: "vam-ah", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
      [el("path", { d: "M0,0 L10,5 L0,10 z", class: "fig-arrow-head" })]
    )
  ]);

function root(height: number, body: FigureNode[], title: string | undefined, arrows = false): FigureNode {
  const h = Math.min(FIGURE_MAX_HEIGHT, Math.ceil(height));
  return el("svg", { viewBox: `0 0 ${FIGURE_WIDTH} ${h}`, role: "img", class: "vam-figure-svg" }, [
    ...(title ? [el("title", {}, [], title)] : []),
    ...(arrows ? [arrowDefs()] : []),
    ...body
  ]);
}

function layoutBar(f: BarFigure, title?: string): FigureNode {
  const base = 232,
    plot = 170,
    left = 20,
    span = FIGURE_WIDTH - 2 * left;
  const total = (g: BarFigure["groups"][number]): number =>
    f.stacked ? g.values.reduce((s, v) => s + Number(v.value), 0) : Math.max(...g.values.map(v => Number(v.value)));
  const top = Math.max(...f.groups.map(total));
  const series: string[] = [];
  for (const g of f.groups) for (const v of g.values) if (v.series && !series.includes(v.series)) series.push(v.series);
  const unit = f.unit ?? "";
  const slot = span / f.groups.length;
  const body: FigureNode[] = [line(left, base, FIGURE_WIDTH - left, base, "fig-axis")];
  f.groups.forEach((g, gi) => {
    const cx = left + slot * (gi + 0.5);
    const cls = (v: { series?: string }, i: number): string =>
      `fig-bar-${(v.series ? series.indexOf(v.series) : i) % 3}`;
    if (f.stacked) {
      const w = Math.min(80, slot * 0.7);
      let y = base;
      g.values.forEach((v, i) => {
        const h = (Number(v.value) / top) * plot;
        y -= h;
        body.push(rect(cx - w / 2, y, w, h, cls(v, i)));
        if (h >= 16) body.push(label(cx, y + h / 2 + 4, `${v.value}${unit}`, "fig-text-inv"));
      });
      if (g.values.some(v => (Number(v.value) / top) * plot < 16))
        body.push(label(cx, y - 8, g.values.map(v => v.value).join(" / ") + unit, "fig-text-sm"));
    } else {
      const k = g.values.length;
      const w = Math.min(60, (slot * 0.8) / k);
      g.values.forEach((v, i) => {
        const h = (Number(v.value) / top) * plot;
        const x = cx - (w * k) / 2 + w * i;
        body.push(
          rect(x, base - h, w, h, cls(v, i)),
          label(x + w / 2, base - h - 6, `${v.value}${unit}`, "fig-text-sm")
        );
      });
    }
    body.push(label(cx, base + 22, g.label));
  });
  series.forEach((s, i) => {
    const x = left + i * 130;
    body.push(rect(x, 6, 10, 10, `fig-bar-${i % 3}`), label(x + 15, 15, s, "fig-text-sm", "start"));
  });
  return root(base + 36, body, title);
}

function layoutScale(f: ScaleFigure, title?: string): FigureNode {
  const x0 = 30,
    x1 = FIGURE_WIDTH - 30,
    axis = 104;
  const lo = Number(f.min),
    hi = Number(f.max);
  const X = (v: string): number => x0 + ((Number(v) - lo) / (hi - lo)) * (x1 - x0);
  const unit = f.unit ?? "";
  const body: FigureNode[] = [line(x0, axis, x1, axis, "fig-axis")];
  f.marks.forEach((m, i) => {
    const ly = 70 - (i % 3) * 20;
    const clamp = (x: number): number => Math.min(FIGURE_WIDTH - 50, Math.max(50, x));
    if ("at" in m) {
      const x = X(m.at);
      body.push(
        line(x, axis, x, ly + 6, "fig-guide"),
        el("circle", { cx: r1(x), cy: axis, r: 5, class: "fig-point" }),
        label(clamp(x), ly, m.label, "fig-text-acc")
      );
    } else {
      const a = X(m.from),
        b = X(m.to);
      body.push(
        rect(a, axis - 6, b - a, 12, "fig-interval", 3),
        line((a + b) / 2, axis - 6, (a + b) / 2, ly + 6, "fig-guide"),
        label(clamp((a + b) / 2), ly, m.label, "fig-text-acc")
      );
    }
  });
  body.push(line(x0, axis, x0, axis + 5, "fig-axis"), line(x1, axis, x1, axis + 5, "fig-axis"));
  body.push(
    label(x0, axis + 22, `${f.min}${unit}`, "fig-text-sm"),
    label(x1, axis + 22, `${f.max}${unit}`, "fig-text-sm")
  );
  return root(axis + 36, body, title);
}

function layoutGraph(f: GraphFigure, title?: string): FigureNode {
  const n = f.nodes.length,
    nr = 14;
  const inRow = f.layout === "row";
  const height = inRow ? 190 : 290;
  const pos = new Map<string, [number, number]>();
  f.nodes.forEach((node, i) => {
    if (inRow) pos.set(node.id, [n === 1 ? 240 : 40 + (400 * i) / (n - 1), 120]);
    else {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      pos.set(node.id, [240 + 105 * Math.cos(a), 145 + 105 * Math.sin(a)]);
    }
  });
  const idx = new Map(f.nodes.map((node, i) => [node.id, i]));
  const body: FigureNode[] = [];
  for (const e of f.edges) {
    const [ax, ay] = pos.get(e.from) as [number, number];
    const [bx, by] = pos.get(e.to) as [number, number];
    const gap = Math.abs((idx.get(e.from) as number) - (idx.get(e.to) as number));
    const cls = "fig-edge";
    let lx: number, ly: number;
    if (inRow && gap > 1) {
      const rise = 18 + 14 * gap;
      const mx = (ax + bx) / 2;
      const d = `M${r1(ax)},${r1(ay - nr)} Q${r1(mx)},${r1(ay - nr - 2 * rise)} ${r1(bx)},${r1(by - nr - (f.directed ? 2 : 0))}`;
      body.push(el("path", { d, class: cls, fill: "none", ...(f.directed ? { "marker-end": ARROW } : {}) }));
      lx = mx;
      ly = ay - nr - rise - 4;
    } else {
      const dx = bx - ax,
        dy = by - ay,
        len = Math.hypot(dx, dy) || 1;
      const ux = dx / len,
        uy = dy / len;
      body.push(
        line(
          ax + ux * nr,
          ay + uy * nr,
          bx - ux * (nr + (f.directed ? 2 : 0)),
          by - uy * (nr + (f.directed ? 2 : 0)),
          cls,
          f.directed
        )
      );
      lx = (ax + bx) / 2 - uy * 10;
      ly = (ay + by) / 2 + ux * 10 + 4;
    }
    if (e.label) body.push(label(lx, ly, e.label, "fig-text-sm"));
  }
  for (const node of f.nodes) {
    const [x, y] = pos.get(node.id) as [number, number];
    const small = [...node.label].length <= 2;
    body.push(el("circle", { cx: r1(x), cy: r1(y), r: nr, class: "fig-node" }));
    body.push(small ? label(x, y + 4, node.label) : label(x, y + nr + 16, node.label, "fig-text-sm"));
  }
  return root(height, body, title, f.directed);
}

function layoutBoard(f: BoardFigure, title?: string): FigureNode {
  const rows = Number(f.rows),
    cols = Number(f.cols);
  const adjacent = (a: [number, number], b: [number, number]): boolean =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
  const arcs = f.pairs.some(p => !adjacent(p.a, p.b));
  const s = Math.min(40, Math.floor((FIGURE_WIDTH - 40) / cols), Math.floor(240 / rows));
  const ox = (FIGURE_WIDTH - cols * s) / 2,
    oy = arcs ? 50 : 14;
  const info = new Map(f.cells.map(c => [`${c.row},${c.col}`, c]));
  const body: FigureNode[] = [];
  for (let r = 1; r <= rows; r++)
    for (let c = 1; c <= cols; c++) {
      const cell = info.get(`${r},${c}`);
      const cls = cell?.cut ? "fig-cut" : f.shade === "checker" && (r + c) % 2 === 1 ? "fig-sq-b" : "fig-sq-a";
      body.push(rect(ox + (c - 1) * s, oy + (r - 1) * s, s, s, cls));
      if (cell?.label) body.push(label(ox + (c - 0.5) * s, oy + (r - 0.5) * s + 4, cell.label, "fig-text-sm"));
    }
  const centre = (p: [number, number]): [number, number] => [ox + (p[1] - 0.5) * s, oy + (p[0] - 0.5) * s];
  f.pairs.forEach(p => {
    const [ax, ay] = centre(p.a),
      [bx, by] = centre(p.b);
    if (adjacent(p.a, p.b)) {
      body.push(
        rect(
          Math.min(ax, bx) - s / 2 + 3,
          Math.min(ay, by) - s / 2 + 3,
          Math.abs(ax - bx) + s - 6,
          Math.abs(ay - by) + s - 6,
          "fig-box",
          5
        )
      );
      if (p.label) body.push(label((ax + bx) / 2, (ay + by) / 2 + 4, p.label, "fig-text-sm"));
    } else {
      const dist = Math.hypot(ax - bx, ay - by);
      const apex = Math.min(40, 10 + dist / 12);
      const sameRow = p.a[0] === p.b[0];
      const top = sameRow ? ay - s / 2 : (ay + by) / 2;
      const mx = (ax + bx) / 2;
      const [sx, sy, ex, ey] = sameRow ? [ax, ay - s / 2, bx, by - s / 2] : [ax, ay, bx, by];
      const cy = sameRow ? top - 2 * apex : top - apex;
      const cx = sameRow ? mx : mx - apex;
      body.push(
        el("path", {
          d: `M${r1(sx)},${r1(sy)} Q${r1(cx)},${r1(cy)} ${r1(ex)},${r1(ey)}`,
          class: "fig-arc",
          fill: "none"
        })
      );
      if (p.label) body.push(label(cx, sameRow ? top - apex - 4 : cy - 4, p.label, "fig-text-acc"));
    }
  });
  return root(oy + rows * s + 24, body, title);
}

/** The figure as a tree: viewBox 480 wide and at most 320 high; `title` (the figure's plain title) becomes the SVG's accessible name. */
export function layoutFigure(spec: FigureSpec, title?: string): FigureNode {
  switch (spec.type) {
    case "bar":
      return layoutBar(spec, title);
    case "scale":
      return layoutScale(spec, title);
    case "graph":
      return layoutGraph(spec, title);
    case "board":
      return layoutBoard(spec, title);
  }
}
