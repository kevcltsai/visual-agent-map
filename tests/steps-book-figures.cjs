// Structured book figures (bar, scale, graph, board): parse, check against the chapter text, canonical JSON and pure layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const spec = S.load('core/book-pipeline/figure-spec.ts');
const layout = S.load('core/book-pipeline/figure-layout.ts');

const parse = raw => {
  const r = spec.parseFigure(raw);
  assert.ok(r.ok, JSON.stringify(r));
  return r.spec;
};
const walk = (node, out = []) => (out.push(node), node.children.forEach(c => walk(c, out)), out);
const find = (tree, tag, cls) => walk(tree).filter(n => n.tag === tag && (!cls || n.attrs.class === cls));
const ALLOWED = new Set(['svg', 'g', 'rect', 'line', 'circle', 'polygon', 'path', 'text', 'title', 'defs', 'marker']);
// every attribute is a number, a fixed class/name, or a path made of digits only
function assertSafe(tree) {
  for (const n of walk(tree)) {
    assert.ok(ALLOWED.has(n.tag), n.tag);
    for (const [k, v] of Object.entries(n.attrs)) {
      assert.ok(/^[a-zA-Z0-9-]+$/.test(k), k);
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k}=${v}`);
      else assert.ok(/^[\w #(),.:-]*$/.test(v) && !/href|<|"/i.test(v), `${k}=${v}`);
    }
  }
  const m = /^0 0 480 (\d+)$/.exec(tree.attrs.viewBox);
  assert.ok(m && Number(m[1]) <= 320, tree.attrs.viewBox);
}
const run = (raw, text, title = '圖') => {
  const s = parse(raw);
  const c = spec.checkFigure(s, text);
  assert.ok(c.ok, JSON.stringify(c));
  assert.deepEqual(JSON.parse(c.body), JSON.parse(spec.canonicalFigureJson(parse(JSON.parse(c.body)))));
  const tree = layout.layoutFigure(parse(c.body), title);
  assertSafe(tree);
  return { s, c, tree };
};

const ANCHOR = '轉盤停在 10 時，受試者估計約 25%；停在 65 時，估計約 45%。';
const MUSIC = '2024 年錄音收入 296 億美元，串流占 69.0%；2025 年 317 億美元，串流占 69.6%。';
const CI = '抽 100 人，平均睡 6.2 到 6.8 小時，範圍在 6.0 到 7.0 之間。';
const BOARD = '8×8 的棋盤剪掉左上與右下兩個角，剩 62 格。';
const GAUSS = '1 加 100、2 加 99、3 加 98，每一對的和都是 101。';
const HOUSE = '房子圖形：兩個屋角連著 3 條線，另外兩個連著 4 條，屋頂尖連著 2 條，中間連著 4 條。';

test('bar: anchoring 10/65 -> 25%/45%, heights proportional', () => {
  const { tree } = run({ type: 'bar', unit: '%', stacked: false, groups: [{ label: '轉盤 10', values: [{ value: '25' }] }, { label: '轉盤 65', values: [{ value: '45' }] }] }, ANCHOR);
  const bars = find(tree, 'rect', 'fig-bar-0');
  assert.equal(bars.length, 2);
  assert.ok(Math.abs(bars[1].attrs.height / bars[0].attrs.height - 45 / 25) < 0.05);
  assert.ok(find(tree, 'text').some(t => t.text === '45%'));
});

test('bar: revenue 296/317 億 stacked with 69.0/69.6 as written, nulls read as absent', () => {
  const { s, tree } = run({ type: 'bar', unit: null, stacked: true, groups: [
    { label: '2024', values: [{ series: '串流', value: '69.0' }, { series: '其他', value: '31.0' }] },
    { label: '2025', values: [{ series: '串流', value: '69.6' }, { series: '其他', value: '30.4' }] }] }, MUSIC + ' 其他 31.0 與 30.4。');
  assert.equal(s.unit, undefined);
  assert.equal(find(tree, 'rect', 'fig-bar-0').length, 3, '2 bars + legend swatch');
  assert.equal(find(tree, 'rect', 'fig-bar-1').length, 3);
  assert.ok(find(tree, 'text').some(t => t.text === '串流'), 'legend');
});

test('bar: "69" is rejected when the text says "69.0"; a number only in a label counts too', () => {
  const mk = value => parse({ type: 'bar', stacked: false, groups: [{ label: '2024', values: [{ value }] }] });
  assert.equal(spec.checkFigure(mk('69'), MUSIC).code, 'number_not_in_text');
  assert.equal(spec.checkFigure(mk('69.0'), MUSIC).ok, true);
  const labelled = parse({ type: 'bar', stacked: false, groups: [{ label: '2031 年', values: [{ value: '69.0' }] }] });
  assert.equal(spec.checkFigure(labelled, MUSIC).code, 'number_not_in_text');
});

test('scale: CI 6.2 to 6.8 as an interval, point inside the axis', () => {
  const { tree } = run({ type: 'scale', unit: ' 小時', min: '6.0', max: '7.0', marks: [{ label: '信賴區間', from: '6.2', to: '6.8' }, { label: '下限', at: '6.2' }] }, CI);
  const [iv] = find(tree, 'rect', 'fig-interval');
  assert.ok(iv.attrs.x > 30 && iv.attrs.x + iv.attrs.width < 450);
  assert.equal(find(tree, 'circle', 'fig-point').length, 1);
});

test('scale: marks outside min..max, reversed interval, mixed at+from are shape errors', () => {
  const base = { type: 'scale', min: '6.0', max: '7.0' };
  for (const marks of [[{ label: 'x', at: '8' }], [{ label: 'x', from: '6.8', to: '6.2' }], [{ label: 'x', at: '6.5', from: '6.2' }], []])
    assert.equal(spec.parseFigure({ ...base, marks }).code, 'figure_shape');
  assert.equal(spec.parseFigure({ ...base, min: '7.0', max: '6.0', marks: [{ label: 'x', at: '6.5' }] }).code, 'figure_shape');
});

test('board: 8x8 with two corners cut, checker shading, domino boxes', () => {
  const { tree } = run({ type: 'board', rows: '8', cols: '8', shade: 'checker',
    cells: [{ row: 1, col: 1, cut: true }, { row: 8, col: 8, cut: true }],
    pairs: [{ a: [3, 3], b: [3, 4] }, { a: [5, 6], b: [6, 6] }] }, BOARD);
  assert.equal(find(tree, 'rect', 'fig-cut').length, 2);
  assert.equal(find(tree, 'rect', 'fig-sq-a').length + find(tree, 'rect', 'fig-sq-b').length, 62);
  assert.equal(find(tree, 'rect', 'fig-box').length, 2);
});

test('board: a single row 1..100 pairs 101 draws arcs (adjacent pair a box); cols must equal the labelled cells', () => {
  const cells = [['1', 1], ['2', 2], ['3', 3], ['98', 4], ['99', 5], ['100', 6]].map(([label, col]) => ({ row: 1, col, label }));
  const raw = { type: 'board', rows: '1', cols: '6', shade: 'none', cells, pairs: [{ a: [1, 1], b: [1, 6], label: '101' }, { a: [1, 2], b: [1, 5], label: '101' }, { a: [1, 3], b: [1, 4], label: '101' }] };
  const { tree } = run(raw, GAUSS);
  assert.equal(find(tree, 'path', 'fig-arc').length, 2);
  assert.equal(find(tree, 'rect', 'fig-box').length, 1, 'the middle pair is adjacent: a box, as the plan says');
  assert.equal(spec.checkFigure(parse({ ...raw, cols: '7' }), GAUSS).code, 'figure_shape');
});

test('board: rows/cols not in the text are rejected; coordinates are not number-checked', () => {
  const raw = { type: 'board', rows: '9', cols: '9', shade: 'none', cells: [], pairs: [] };
  assert.equal(spec.checkFigure(parse(raw), BOARD).code, 'number_not_in_text');
  assert.equal(spec.checkFigure(parse({ ...raw, rows: '8', cols: '8', pairs: [{ a: [7, 7], b: [8, 8] }] }), BOARD).ok, true);
});

test('graph: house with degrees 3/3/4/4/2/4 in a circle, undirected; directed row gets arrows', () => {
  const labels = ['3', '3', '4', '4', '2', '4'];
  const nodes = labels.map((label, i) => ({ id: `n${i}`, label }));
  const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 4], [0, 3], [1, 2]].map(([a, b]) => ({ from: `n${a}`, to: `n${b}` }));
  const { tree } = run({ type: 'graph', directed: false, layout: 'circle', nodes, edges }, HOUSE);
  assert.equal(find(tree, 'circle', 'fig-node').length, 6);
  assert.equal(find(tree, 'line', 'fig-edge').length, 8);
  assert.equal(find(tree, 'marker').length, 0);
  const directed = run({ type: 'graph', directed: true, layout: 'row', nodes: nodes.slice(0, 3), edges: [{ from: 'n0', to: 'n1' }, { from: 'n0', to: 'n2' }] }, HOUSE).tree;
  assert.equal(find(directed, 'marker').length, 1);
  assert.equal(find(directed, 'line', 'fig-edge')[0].attrs['marker-end'], 'url(#vam-ah)');
  assert.equal(find(directed, 'path', 'fig-edge').length, 1, 'the non-adjacent edge arcs over');
});

test('graph: unknown edge ends, self loops, duplicate ids, bad layout, > limits are shape errors', () => {
  const nodes = [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }];
  const g = extra => ({ type: 'graph', directed: false, layout: 'circle', nodes, edges: [], ...extra });
  for (const x of [{ edges: [{ from: 'a', to: 'z' }] }, { edges: [{ from: 'a', to: 'a' }] }, { nodes: [nodes[0], nodes[0]] }, { layout: 'free' },
    { nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: 'x' })) },
    { edges: Array.from({ length: 13 }, () => ({ from: 'a', to: 'b' })) }, { directed: 'yes' }])
    assert.equal(spec.parseFigure(g(x)).code, 'figure_shape', JSON.stringify(x).slice(0, 40));
});

test('unsafe text: < [ ] ! backtick URL 〔 〕 and control characters', () => {
  for (const bad of ['a<b', 'a[b', 'a]', 'a!', 'a`b', '〔1〕', '〕', 'see https://x.io', 'www.x.io', 'a\u0007b', 'x\ny']) {
    const s = parse({ type: 'graph', directed: false, layout: 'row', nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: bad }], edges: [] });
    assert.equal(spec.checkFigure(s, '甲').code, 'unsafe_text', JSON.stringify(bad));
  }
  const s = parse({ type: 'bar', unit: '[億]', stacked: false, groups: [{ label: '甲', values: [{ value: '1' }] }] });
  assert.equal(spec.checkFigure(s, '甲 1').code, 'unsafe_text');
});

test('over limits, unknown type, non-numeric values and non-objects', () => {
  const g = n => Array.from({ length: n }, (_, i) => ({ label: `g${i}`, values: [{ value: '1' }] }));
  assert.equal(spec.parseFigure({ type: 'bar', stacked: false, groups: g(7) }).code, 'figure_shape');
  assert.equal(spec.parseFigure({ type: 'bar', stacked: false, groups: [{ label: 'a', values: Array.from({ length: 4 }, () => ({ value: '1' })) }] }).code, 'figure_shape');
  assert.equal(spec.parseFigure({ type: 'bar', stacked: false, groups: [{ label: 'a', values: [{ value: '1,5' }] }] }).code, 'figure_shape');
  assert.equal(spec.parseFigure({ type: 'bar', stacked: false, groups: [{ label: 'a', values: [{ value: '0' }] }] }).code, 'figure_shape', 'all zero');
  assert.equal(spec.parseFigure({ type: 'bar', stacked: false, groups: [{ label: 'x'.repeat(25), values: [{ value: '1' }] }] }).code, 'figure_shape');
  assert.equal(spec.parseFigure({ type: 'board', rows: '11', cols: '2', shade: 'none', cells: [], pairs: [] }).code, 'figure_shape');
  assert.equal(spec.parseFigure({ type: 'board', rows: '2', cols: '2', shade: 'none', cells: [{ row: 3, col: 1 }], pairs: [] }).code, 'figure_shape');
  for (const t of ['pie', 'mermaid', '__proto__', 'constructor', 7, undefined]) assert.equal(spec.parseFigure({ type: t }).code, 'figure_type', String(t));
  for (const raw of [null, 'not json', '[]', 3, [], '{"type":"bar"']) assert.equal(spec.parseFigure(raw).code, 'figure_shape');
  assert.equal(spec.parseFigure(JSON.stringify({ type: 'scale', min: '1', max: '2', marks: [{ label: 'a', at: '1' }] })).ok, true, 'JSON text is accepted');
});

test('canonical JSON over 1500 characters is bad_body; key order is fixed; unknown keys are dropped', () => {
  const marks = Array.from({ length: 6 }, (_, i) => ({ label: 'x'.repeat(24), from: '1', to: '2', extra: i }));
  const big = parse({ type: 'scale', min: '1', max: '2', marks });
  assert.equal(spec.checkFigure(big, '1 2').ok, true, 'about 450 characters is fine');
  const board = parse({ type: 'board', rows: '10', cols: '10', shade: 'checker', cells: Array.from({ length: 100 }, (_, i) => ({ row: (i % 10) + 1, col: Math.floor(i / 10) + 1, label: 'abcdefghij', cut: true })), pairs: [] });
  assert.equal(spec.checkFigure(board, '10').code, 'bad_body');
  const a = spec.canonicalFigureJson(parse({ marks: [{ to: '2', from: '1', label: 'a', junk: 1 }], max: '2', min: '1', type: 'scale', junk: 2 }));
  assert.equal(a, '{"type":"scale","min":"1","max":"2","marks":[{"label":"a","from":"1","to":"2"}]}');
});

test('layout: every type stays within 480x320 at the limits and bars never exceed the plot', () => {
  const six = parse({ type: 'bar', stacked: false, groups: Array.from({ length: 6 }, (_, i) => ({ label: `g${i}`, values: [{ series: 'a', value: '9' }, { series: 'b', value: '5' }, { series: 'c', value: '1' }] })) });
  assertSafe(layout.layoutFigure(six));
  const full = parse({ type: 'board', rows: '10', cols: '10', shade: 'checker', cells: [], pairs: [{ a: [1, 1], b: [10, 10] }, { a: [2, 2], b: [2, 9], label: '9' }] });
  assertSafe(layout.layoutFigure(full));
  const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `點${i}` }));
  for (const lay of ['circle', 'row']) assertSafe(layout.layoutFigure(parse({ type: 'graph', directed: true, layout: lay, nodes, edges: nodes.slice(1).map(n => ({ from: 'n0', to: n.id, label: '1' })) })));
  assertSafe(layout.layoutFigure(parse({ type: 'graph', directed: false, layout: 'circle', nodes: [nodes[0]], edges: [] })));
});

test('layout: text from the figure only appears in text nodes, never in attributes', () => {
  const evil = 'x" onload="alert(1)';
  const s = parse({ type: 'graph', directed: false, layout: 'row', nodes: [{ id: evil, label: evil }, { id: 'b', label: 'b' }], edges: [{ from: evil, to: 'b', label: evil }] });
  const tree = layout.layoutFigure(s, evil);
  assertSafe(tree);
  assert.ok(!JSON.stringify(walk(tree).map(n => n.attrs)).includes('onload'));
  assert.ok(walk(tree).some(n => n.text === evil));
});

test('fix batch: thousands separators, graph ids unsafe, directed defaults to false, figure fences stripped, role only with a title', () => {
  const bar = value => parse({ type: 'bar', stacked: false, groups: [{ label: '人', values: [{ value }] }] });
  assert.equal(spec.checkFigure(bar('12,000'), '共 12,000 人').ok, true);
  assert.equal(spec.checkFigure(bar('12000'), '共 12,000 人').ok, true, 'numberTokens drops the comma on both sides');
  assert.equal(spec.parseFigure({ type: 'bar', stacked: false, groups: [{ label: 'a', values: [{ value: '1,23' }] }] }).code, 'figure_shape');
  const bars = find(layout.layoutFigure(bar('12,000')), 'rect', 'fig-bar-0');
  assert.ok(bars[0].attrs.height > 0);
  const g = id => parse({ type: 'graph', layout: 'row', nodes: [{ id, label: '甲' }, { id: 'b', label: '乙' }], edges: [{ from: id, to: 'b' }] });
  assert.equal(g('a').directed, false);
  for (const id of ['a<b', 'a[1]', 'http://x']) assert.equal(spec.checkFigure(g(id), '甲 乙').code, 'unsafe_text', id);
  assert.equal(spec.stripFigureFences('a 25\n```vam-figure\n{"x":"99"}\n```\nb\n~~~vam-figure\n7\n~~~\nc').replace(/\n/g, '|'), 'a 25|b|c');
  const s = parse({ type: 'scale', min: '1', max: '2', marks: [{ label: 'a', at: '1' }] });
  assert.equal(layout.layoutFigure(s).attrs.role, undefined);
  assert.equal(layout.layoutFigure(s, 'T').attrs.role, 'img');
});
