// text-then-topic P1: a topic that follows a text block (`afterTextId`). Data contract, cleanup, virtual-tree layout, order.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const ci = load('experiences/visual-map/canvas-items.ts');
const graph = load('map-graph.ts');
const layout = load('map-layout.ts');
const layoutText = load('map-layout-text.ts');
const order = load('experiences/visual-map/presentation-order.ts');
const model = load('map-model.ts');
const plain = value => JSON.parse(JSON.stringify(value));

const node = (id, parentId = null, extra = {}) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed: false, ...extra });
const txt = (over = {}) => ({ id: 't1', kind: 'text', text: 'hello', x: 0, y: 0, parentId: 'a', ...over });
const heightOf = () => 100;
const KINDS = ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone'];
// r -> a, b ; a -> a1 ; text t1 on a is followed by c1 (which has a child c1x), c2, c3 ; text t2 on r is followed by d.
const nodes = () => [
  node('r'), node('a', 'r'), node('b', 'r'), node('a1', 'a'),
  node('c1', 'a', { afterTextId: 't1' }), node('c2', 'a', { afterTextId: 't1' }), node('c3', 'a', { afterTextId: 't1' }),
  node('c1x', 'c1'), node('d', 'r', { afterTextId: 't2' })
];
const items = () => [txt(), txt({ id: 't2', parentId: 'r', text: 'two' })];
const docOf = (ns, its, extra = {}) => ({ version: 1, id: 'm', title: 'M', nodes: ns, viewport: { x: 0, y: 0, zoom: 1 }, ...(its ? { canvasItems: its } : {}), ...extra });
const reparse = (ns, its) => plain(model.parseMap(model.serializeMap(docOf(plain(ns), plain(its)))));
const boxes = (ns, its) => [...ns, ...its.filter(i => i.kind === 'text')].map(n => ({ id: n.id, x: n.x, y: n.y }));
const overlapping = rects => {
  const hits = [];
  rects.forEach((p, i) => rects.slice(i + 1).forEach(q => { if (p.x < q.x + 280 && q.x < p.x + 280 && p.y < q.y + 100 && q.y < p.y + 100) hits.push(`${p.id}/${q.id}`); }));
  return hits;
};

test('withTextParents: only a follower whose text hangs on the same parent is moved under the text', () => {
  const texts = new Map([['t1', 'a']]);
  const out = graph.withTextParents(nodes(), texts);
  assert.equal(out.find(n => n.id === 'c1').parentId, 't1');
  assert.equal(out.find(n => n.id === 'd').parentId, 'r', 't2 is not in the map');
  assert.equal(out.find(n => n.id === 'a1').parentId, 'a');
  assert.equal(graph.withTextParents(nodes(), new Map([['t1', 'b']])).find(n => n.id === 'c1').parentId, 'a', 'different parent');
  const input = nodes();
  graph.withTextParents(input, texts);
  assert.equal(input.find(n => n.id === 'c1').parentId, 'a', 'input is not changed');
  const same = nodes();
  assert.equal(graph.withTextParents(same, new Map()), same);
  assert.equal(graph.withTextParents(same.filter(n => !n.afterTextId), texts).length, 5);
});

test('layouts: parentId and afterTextId leave unchanged, the map reopens, followers sit after the text without overlap', () => {
  for (const kind of KINDS) {
    const out = layoutText.arrangeMapWithText(nodes(), items(), undefined, heightOf, kind);
    assert.deepEqual(out.nodes.map(n => [n.id, n.parentId, n.afterTextId]), nodes().map(n => [n.id, n.parentId, n.afterTextId]), `${kind}: ids stay`);
    const back = reparse(out.nodes, out.items);
    assert.deepEqual(back.nodes.map(n => [n.id, n.parentId, n.afterTextId]), nodes().map(n => [n.id, n.parentId, n.afterTextId]), `${kind}: reopened`);
    assert.equal(back.canvasItems.length, 2);
    assert.deepEqual(overlapping(boxes(out.nodes, plain(out.items))), [], `${kind}: no overlap`);
    const t = plain(out.items).find(i => i.id === 't1');
    for (const id of ['c1', 'c2', 'c3']) {
      const c = out.nodes.find(n => n.id === id);
      assert.ok(c.x !== t.x || c.y !== t.y, `${kind}: ${id} is not on the text`);
      if (kind === 'right') assert.ok(c.x > t.x, `${kind}: ${id} after the text`);
      if (kind === 'left') assert.ok(c.x < t.x, `${kind}: ${id} after the text`);
      if (kind === 'down') assert.ok(c.y > t.y, `${kind}: ${id} after the text`);
      if (kind === 'up') assert.ok(c.y < t.y, `${kind}: ${id} after the text`);
    }
    const c1x = out.nodes.find(n => n.id === 'c1x');
    const c1 = out.nodes.find(n => n.id === 'c1');
    if (kind === 'right') assert.ok(c1x.x > c1.x);
  }
});

test('layouts: a text block with followers is not a leaf (the followers do not share its column)', () => {
  const out = layoutText.arrangeMapWithText(nodes(), items(), undefined, heightOf, 'right');
  const t = plain(out.items).find(i => i.id === 't1');
  const a1 = out.nodes.find(n => n.id === 'a1');
  assert.equal(t.x, a1.x, 'the text is a sibling of a1');
  assert.ok(out.nodes.find(n => n.id === 'c1').x > t.x);
  assert.ok(out.nodes.find(n => n.id === 'c1x').x > out.nodes.find(n => n.id === 'c1').x);
});

test('layouts: folding the topic keeps the follower and text coordinates; a collapsed follower is a leaf', () => {
  const placed = layoutText.arrangeMapWithText(nodes(), items(), undefined, heightOf, 'right');
  const folded = placed.nodes.map(n => (n.id === 'a' ? { ...n, collapsed: true } : n));
  const hidden = new Set(['a1', 'c1', 'c2', 'c3', 'c1x']);
  const out = layoutText.arrangeMapWithText(folded, placed.items, hidden, heightOf, 'right');
  for (const id of ['a1', 'c1', 'c2', 'c3', 'c1x']) {
    const before = placed.nodes.find(n => n.id === id), after = out.nodes.find(n => n.id === id);
    assert.deepEqual([after.x, after.y, after.parentId], [before.x, before.y, before.parentId], id);
  }
  assert.deepEqual(plain(out.items).find(i => i.id === 't1'), plain(placed.items).find(i => i.id === 't1'));
  const closed = placed.nodes.map(n => (n.id === 'c1' ? { ...n, collapsed: true } : n));
  const leaf = layoutText.arrangeMapWithText(closed, placed.items, new Set(['c1x']), heightOf, 'right');
  assert.deepEqual(overlapping(boxes(leaf.nodes, plain(leaf.items)).filter(b => b.id !== 'c1x')), []);
});

test('layouts: a wider text block pushes its followers right', () => {
  const wide = items().map(i => (i.id === 't1' ? { ...i, width: 520 } : i));
  const narrow = layoutText.arrangeMapWithText(nodes(), items(), undefined, heightOf, 'right');
  const out = layoutText.arrangeMapWithText(nodes(), wide, undefined, heightOf, 'right');
  assert.ok(out.nodes.find(n => n.id === 'c1').x > narrow.nodes.find(n => n.id === 'c1').x);
});

test('arrangeNewBranchWithText: a new follower is placed after its text without overlap, in every layout', () => {
  for (const kind of KINDS) {
    const base = layoutText.arrangeMapWithText(nodes().filter(n => n.id !== 'c3'), items(), undefined, heightOf, kind);
    const grown = [...base.nodes, node('c3', 'a', { afterTextId: 't1' })];
    const out = layoutText.arrangeNewBranchWithText(grown, base.items, 'a', new Set(['c3']), heightOf, undefined, kind);
    assert.deepEqual(out.nodes.map(n => [n.id, n.parentId, n.afterTextId]), grown.map(n => [n.id, n.parentId, n.afterTextId]), `${kind}: ids stay`);
    reparse(out.nodes, out.items);
    assert.deepEqual(overlapping(boxes(out.nodes, plain(out.items))), [], `${kind}: no overlap`);
    const t = plain(out.items).find(i => i.id === 't1');
    const c3 = out.nodes.find(n => n.id === 'c3');
    if (kind === 'right') assert.ok(c3.x > t.x);
    if (kind === 'left') assert.ok(c3.x < t.x);
    if (kind === 'down') assert.ok(c3.y > t.y);
    if (kind === 'up') assert.ok(c3.y < t.y);
  }
});

test('arrangeNewBranchWithText: the first follower of a text, and a new topic without text, still work', () => {
  const ns = [node('r'), node('a', 'r'), node('b', 'r')];
  const its = [txt()];
  const base = layoutText.arrangeMapWithText(ns, its, undefined, heightOf, 'right');
  const grown = [...base.nodes, node('c', 'a', { afterTextId: 't1' }), node('e', 'b')];
  const out = layoutText.arrangeNewBranchWithText(grown, base.items, 'a', new Set(['c']), heightOf, undefined, 'right');
  assert.deepEqual(overlapping(boxes(out.nodes, plain(out.items))), []);
  assert.ok(out.nodes.find(n => n.id === 'c').x > plain(out.items)[0].x);
  assert.equal(out.nodes.find(n => n.id === 'c').parentId, 'a');
});

test('layouts: maps without afterTextId lay out exactly as before', () => {
  const plainNodes = () => [node('r'), node('a', 'r'), node('b', 'r'), node('a1', 'a')];
  for (const kind of KINDS) {
    const withText = layoutText.arrangeMapWithText(plainNodes(), [txt()], undefined, heightOf, kind);
    const sibling = plain(withText.nodes);
    assert.deepEqual(sibling.map(n => n.parentId), ['', 'r', 'r', 'a'].map((p, i) => (i ? p : null)));
    assert.ok(sibling.every(n => !('afterTextId' in n)));
  }
});

// ---- cleanup ----
const parse = (ns, its) => model.parseMap(model.serializeMap(docOf(plain(ns), its && plain(its))), () => {});
const afterOf = (ns, its, id = 'c') => plain(parse(ns, its)).nodes.find(n => n.id === id);
const base = (extra = {}) => [node('r'), node('a', 'r'), node('b', 'r'), node('c', 'a', extra)];

test('prune: a follower of an attached text of the same parent keeps afterTextId', () => {
  assert.equal(afterOf(base({ afterTextId: 't1' }), [txt()]).afterTextId, 't1');
});

test('prune: a missing text, a free text, another parent or a bad value drops the field; the map still opens', () => {
  const cases = [
    ['text missing', 't1', []],
    ['text is another item', 't1', [{ id: 't1', kind: 'image', path: 'a.png', x: 0, y: 0, w: 1, h: 1 }]],
    ['text is free', 't1', [txt({ parentId: undefined })]],
    ['text hangs on a missing topic', 't1', [txt({ parentId: 'gone' })]],
    ['text hangs on another parent', 't1', [txt({ parentId: 'b' })]],
    ['text hangs on the follower', 't1', [txt({ parentId: 'c' })]],
    ['number', 5, [txt()]],
    ['null', null, [txt()]],
    ['object', { id: 't1' }, [txt()]],
    ['empty string', '', [txt()]],
    ['array', ['t1'], [txt()]]
  ];
  for (const [label, value, its] of cases) {
    const c = afterOf(base({ afterTextId: value }), its);
    assert.ok(c, label);
    assert.equal('afterTextId' in c, false, label);
    assert.equal(c.parentId, 'a', label);
  }
  assert.equal(afterOf(base({ afterTextId: 't1' }), undefined).afterTextId, undefined, 'no canvasItems at all');
});

test('prune: pruneAfterText never throws and reports what it dropped', () => {
  const warns = [];
  const doc = { nodes: [null, 7, node('a', null, { afterTextId: 'x' }), node('b', 'a', { afterTextId: 5 })], canvasItems: 'nope' };
  assert.equal(ci.pruneAfterText(doc, (l, m) => warns.push([l, m])), 2);
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], 'warn');
  assert.equal(ci.pruneAfterText({}), 0);
  assert.equal(ci.pruneAfterText({ nodes: 'x' }), 0);
  const clean = { nodes: [node('a'), node('b', 'a')], canvasItems: [txt()] };
  const copy = plain(clean);
  assert.equal(ci.pruneAfterText(clean), 0);
  assert.deepEqual(plain(clean), copy);
});

test('prune: maps without the field are byte for byte through read and write; a valid field is kept byte for byte', () => {
  const text = model.serializeMap(docOf(base(), [txt(), txt({ id: 't2', parentId: 'b', width: 400 })]));
  assert.equal(model.serializeMap(model.parseMap(text)), text);
  const withField = model.serializeMap(docOf(base({ afterTextId: 't1' }), [txt()]));
  assert.equal(model.serializeMap(model.parseMap(withField)), withField);
  const plainText = model.serializeMap(docOf(base(), undefined));
  assert.equal(model.serializeMap(model.parseMap(plainText)), plainText);
});

// ---- order and siblings ----
const pn = (id, parentId, x, y, extra = {}) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false, ...extra });

test('readingOrder: a follower reads right after its text, before the sibling that is lower on the map', () => {
  const ns = [pn('r', null, 0, 0), pn('a', 'r', 300, 0), pn('c', 'r', 700, 500, { afterTextId: 't' }), pn('b', 'r', 300, 300)];
  const textNodes = [{ id: 't', parentId: 'r', x: 300, y: 100 }];
  assert.deepEqual([...order.readingOrder(ns, { textNodes })], ['r', 'a', 't', 'c', 'b']);
  assert.deepEqual([...order.readingOrder(ns)], ['r', 'a', 'b', 'c'], 'without the text it is an ordinary child');
  const folded = [{ ...ns[0], collapsed: true }, ...ns.slice(1)];
  assert.deepEqual([...order.readingOrder(folded, { textNodes })], ['r']);
});

test('shiftSibling and reorderTopLevel treat followers as their own group', () => {
  const ns = [pn('r', null, 0, 0), pn('a', 'r', 1, 0), pn('c1', 'r', 5, 0, { afterTextId: 't' }), pn('b', 'r', 2, 0), pn('c2', 'r', 6, 0, { afterTextId: 't' })];
  assert.deepEqual(layout.shiftSibling(ns, 'a', 1).map(n => n.id), ['r', 'b', 'c1', 'a', 'c2']);
  assert.deepEqual(layout.shiftSibling(ns, 'c1', 1).map(n => n.id), ['r', 'a', 'c2', 'b', 'c1']);
  assert.equal(layout.shiftSibling(ns, 'c2', 1), ns);
  assert.deepEqual(layout.reorderTopLevel(ns, 'r', 'a', 1000).map(n => n.id), ['r', 'b', 'c1', 'a', 'c2']);
  assert.equal(layout.reorderTopLevel(ns, 'r', 'c1', 0), ns);
});
