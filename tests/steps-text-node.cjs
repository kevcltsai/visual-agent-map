// tree-text-node P1: text canvas items (data contract, old-plugin round trip, layout leaves, reading order).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, loadSource } = require('./support-replay.cjs');
const ci = load('experiences/visual-map/canvas-items.ts');
const layout = load('map-layout.ts');
const layoutText = load('map-layout-text.ts');
const order = load('experiences/visual-map/presentation-order.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const sanitize = raw => plain(ci.sanitizeCanvasItems(raw));
const txt = (over = {}) => ({ id: 't1', kind: 'text', text: 'hello', parentId: 'r', x: 10, y: 20, ...over });
const img = { id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 };

test('A1: a valid text item round-trips; free text (no parentId) is kept without the field', () => {
  const free = { id: 'f', kind: 'text', text: 'free', x: 0, y: 0 };
  assert.deepEqual(sanitize([txt(), free, img]), [txt(), free, img]);
  assert.deepEqual(sanitize([{ ...free, parentId: null }]), [free]);
});

test('A1: text is trimmed and cut at 2000 characters; extra fields are dropped', () => {
  assert.equal(sanitize([txt({ text: '  hi \n' })])[0].text, 'hi');
  assert.equal(sanitize([txt({ text: 'a'.repeat(5000) })])[0].text.length, 2000);
  assert.equal(sanitize([txt({ evil: 1 })])[0].evil, undefined);
});

test('A1 counter-examples: bad text, id, coordinates or parentId drop that item only', () => {
  const ok = txt({ id: 'ok' });
  const out = sanitize([
    txt({ id: 'a', text: 5 }),
    txt({ id: 'b', text: '   ' }),
    txt({ id: 'c', text: undefined }),
    txt({ id: 'd', x: Infinity }),
    txt({ id: 'e', y: '1' }),
    txt({ id: 'bad id!' }),
    txt({ id: 'g', parentId: 7 }),
    txt({ id: 'h', parentId: '' }),
    txt({ id: 'j', parentId: 'x'.repeat(300) }),
    ok,
    txt({ id: 'ok', text: 'duplicate id' })
  ]);
  assert.deepEqual(out, [ok]);
});

test('A1: html-looking text is kept as a literal string', () => {
  const text = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  assert.equal(sanitize([txt({ text })])[0].text, text);
});

test('A1: a map without text items serialises the same bytes as before', () => {
  const items = [img, { id: 'b1', kind: 'boundary', members: ['n1'] }];
  assert.equal(JSON.stringify(sanitize(items)), JSON.stringify(items));
});

test('add/update/remove are pure and ignore bad input', () => {
  const base = [img];
  const added = plain(ci.addTextNode(base, { id: 't1', text: ' hi ', parentId: 'r', x: 1, y: 2 }));
  assert.deepEqual(added, [img, { id: 't1', kind: 'text', text: 'hi', parentId: 'r', x: 1, y: 2 }]);
  assert.equal(base.length, 1);
  assert.equal(ci.addTextNode(added, { id: 't1', text: 'dup', x: 0, y: 0 }).length, 2);
  assert.equal(ci.addTextNode(base, { id: 't2', text: '  ', x: 0, y: 0 }).length, 1);
  assert.equal(ci.addTextNode(base, { id: 'i1', text: 'clash', x: 0, y: 0 }).length, 1);
  assert.equal(plain(ci.updateTextNode(added, 't1', ' new '))[1].text, 'new');
  assert.deepEqual(plain(ci.updateTextNode(added, 't1', '   ')), added);
  assert.deepEqual(plain(ci.updateTextNode(added, 'i1', 'x')), added);
  assert.deepEqual(plain(ci.removeTextNode(added, 't1')), [img]);
  assert.deepEqual(plain(ci.removeTextNode(added, 'i1')), added);
});

test('treeTextNodes separates attached from orphans and never drops any', () => {
  const items = [
    txt({ id: 'a', parentId: 'r' }),
    txt({ id: 'b', parentId: 'gone' }),
    txt({ id: 'c', parentId: 'c' }),
    txt({ id: 'd', parentId: undefined }),
    img
  ];
  const { attached, orphans } = plain(ci.treeTextNodes(items, new Set(['r'])));
  assert.deepEqual(attached.map(i => i.id), ['a']);
  assert.deepEqual(orphans.map(i => i.id), ['b', 'c', 'd']);
  assert.deepEqual(plain(ci.treeTextNodes(items, ['r', 'gone'])).attached.map(i => i.id), ['a', 'b']);
});

test('A2: the 47c406a plugin keeps a text item byte for byte through its own sanitize', () => {
  const old = loadSource(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-canvas-items-47c406a.ts.txt'), 'utf8'));
  const items = [txt(), txt({ id: 'orphan', parentId: 'gone' }), img];
  const oldOut = plain(old.sanitizeCanvasItems(items));
  assert.deepEqual(oldOut, items);
  assert.deepEqual(sanitize(oldOut), items);
  // Removing an unrelated image in the old plugin leaves text items alone.
  assert.deepEqual(plain(old.removeItem(items, 'i1')), items.slice(0, 2));
});

// ---- layout ----
const node = (id, parentId = null) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed: false });
const tree = () => [node('r'), node('a', 'r'), node('b', 'r'), node('a1', 'a'), node('a2', 'a')];
const heightOf = () => 100;
const KINDS = ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone'];
const textsFor = () => [
  txt({ id: 't1', parentId: 'r', text: 'one' }),
  txt({ id: 't2', parentId: 'a', text: 'two' }),
  txt({ id: 't3', parentId: 'a', text: 'three' }),
  txt({ id: 'orph', parentId: 'gone', x: 7, y: 8, text: 'orphan' })
];
const overlaps = rects =>
  rects.some((p, i) => rects.slice(i + 1).some(q => p.x < q.x + 300 && q.x < p.x + 300 && p.y < q.y + 100 && q.y < p.y + 100));

test('A3: arrangeMapWithText equals arrangeMap when there are no attached text nodes', () => {
  for (const kind of KINDS) {
    const plainRun = plain(layout.arrangeMap(tree(), undefined, heightOf, kind));
    const none = layoutText.arrangeMapWithText(tree(), [img], undefined, heightOf, kind);
    assert.deepEqual(plain(none.nodes), plainRun, kind);
    assert.deepEqual(plain(none.items), [img]);
    const orphanOnly = layoutText.arrangeMapWithText(tree(), [txt({ parentId: 'gone' })], undefined, heightOf, kind);
    assert.deepEqual(plain(orphanOnly.nodes), plainRun, kind);
  }
});

test('A3: text nodes are leaves in every layout, never overlap, orphans and other items stay put', () => {
  for (const kind of KINDS) {
    const items = [...textsFor(), img];
    const out = layoutText.arrangeMapWithText(tree(), items, undefined, heightOf, kind);
    const texts = plain(out.items).filter(i => i.kind === 'text');
    const rects = [...out.nodes, ...texts.filter(i => i.id !== 'orph')].map(i => ({ x: i.x, y: i.y }));
    assert.equal(rects.length, 5 + 3, kind);
    assert.ok(!overlaps(rects), `overlap in ${kind}`);
    assert.deepEqual(texts.find(i => i.id === 'orph'), { ...textsFor()[3] }, kind);
    assert.deepEqual(plain(out.items).find(i => i.kind === 'image'), img);
    assert.equal(out.items.length, items.length);
    for (const t of texts) assert.equal(typeof t.x, 'number');
    const moved = texts.filter(t => t.id !== 'orph').some((t, i) => t.x !== textsFor()[i].x || t.y !== textsFor()[i].y);
    assert.ok(moved, `text moved by layout in ${kind}`);
  }
});

test('A3: text nodes under a collapsed or hidden parent are left alone', () => {
  const nodes = tree();
  nodes.find(n => n.id === 'a').collapsed = true;
  const hidden = new Set(['a1', 'a2']);
  const items = textsFor();
  const out = layoutText.arrangeMapWithText(nodes, items, hidden, heightOf, 'right');
  const t = plain(out.items);
  assert.deepEqual(t[1], items[1]);
  assert.deepEqual(t[2], items[2]);
  assert.notDeepEqual(t[0], items[0]);
  const hiddenParent = layoutText.arrangeMapWithText(tree(), items, new Set(['a']), heightOf, 'right');
  assert.deepEqual(plain(hiddenParent.items)[1], items[1]);
});

test('A3: a text node takes the vertical space of a leaf (siblings shift to make room)', () => {
  const base = plain(layout.arrangeMap(tree(), undefined, heightOf, 'right'));
  const out = layoutText.arrangeMapWithText(tree(), [txt({ id: 't1', parentId: 'b' })], undefined, heightOf, 'right');
  const b = plain(out.nodes).find(n => n.id === 'b');
  const t = plain(out.items)[0];
  assert.ok(t.x > b.x);
  assert.ok(Math.abs(t.y - b.y) <= 100);
  assert.equal(plain(out.nodes).length, base.length);
});

test('A3: arrangeNewBranchWithText keeps existing text nodes as obstacles and places text under new cards', () => {
  const nodes = [...tree().map(n => ({ ...n })), node('n1', 'b')];
  const placedNodes = layout.arrangeMap(nodes.filter(n => n.id !== 'n1'), undefined, heightOf, 'right').concat(node('n1', 'b'));
  const existing = txt({ id: 'old', parentId: 'a', x: 700, y: 500 });
  const fresh = txt({ id: 'newt', parentId: 'n1', x: 0, y: 0 });
  const out = layoutText.arrangeNewBranchWithText(placedNodes, [existing, fresh], 'b', new Set(['n1']), heightOf, undefined, 'right');
  const items = plain(out.items);
  assert.deepEqual(items[0], existing);
  const n1 = plain(out.nodes).find(n => n.id === 'n1');
  assert.ok(items[1].x > n1.x);
  const none = layoutText.arrangeNewBranchWithText(placedNodes, [img], 'b', new Set(['n1']), heightOf, undefined, 'right');
  assert.deepEqual(plain(none.nodes), plain(layout.arrangeNewBranch(placedNodes, 'b', new Set(['n1']), heightOf, undefined, 'right')));
});

// ---- presentation order ----
const pn = (id, parentId, x, y, extra = {}) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false, ...extra });

test('A3: readingOrder puts a text node among its siblings by position', () => {
  const nodes = [pn('r', null, 0, 0), pn('a', 'r', 300, 0), pn('b', 'r', 300, 200)];
  const textNodes = [{ id: 't', parentId: 'r', x: 300, y: 100 }];
  assert.deepEqual([...order.readingOrder(nodes, { textNodes })], ['r', 'a', 't', 'b']);
  assert.deepEqual([...order.readingOrder(nodes)], ['r', 'a', 'b']);
});

test('A3: readingOrder hides text of a collapsed parent unless includeHidden; ignores orphans and id clashes', () => {
  const nodes = [pn('r', null, 0, 0, { collapsed: true }), pn('a', 'r', 300, 0)];
  const textNodes = [
    { id: 't', parentId: 'r', x: 300, y: 100 },
    { id: 'o', parentId: 'gone', x: 0, y: 0 },
    { id: 'a', parentId: 'r', x: 0, y: 0 }
  ];
  assert.deepEqual([...order.readingOrder(nodes, { textNodes })], ['r']);
  assert.deepEqual([...order.readingOrder(nodes, { textNodes, includeHidden: true })], ['r', 'a', 't']);
});
