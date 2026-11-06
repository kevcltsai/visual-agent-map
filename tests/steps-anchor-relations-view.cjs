// Annotated image P4a: anchor relation lines in the view (drawRelations), their labels and highlight, the card's
// "N image relations" mark, the exclusion from PNG/SVG export, and the group role of an annotated image.
// The data layer is tested in steps-annotated-image.cjs; the editor for these lines comes in P4b.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const geometry = support.load('experiences/visual-map/relation-geometry.ts');
const SEP = '\u0000';
const KINDS = ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'];

/** A fake SVG element: the dom helper plus the attribute and text API the view uses on SVG nodes. */
function createSvg(tag) {
  const el = element(tag);
  el.tagName = tag;
  el.setAttribute = (name, value) => { el.attrs[name] = String(value); };
  el.getAttribute = name => el.attrs[name] ?? null;
  el.removeAttribute = name => { delete el.attrs[name]; };
  Object.defineProperty(el, 'textContent', { get() { return this.text; }, set(value) { this.text = String(value); } });
  return el;
}
const style = values => ({ getPropertyValue: name => values[name] ?? '', ...values });

// root(0,0) 280x100, a(400,0), b(400,200) 280x100; one annotated image at (100, 600), 200 x 100, with anchors p1 (0.5, 0.5),
// p2 (0.25, 0.75), f1 (an unknown position kind).
const IMG = { id: 'img1', kind: 'annotated-image', path: 'a.png', x: 100, y: 600, w: 200, h: 100, note: 'cow scan' };
const anchors = () => [
  { id: 'p1', at: { kind: 'image-2d', x: 0.5, y: 0.5 }, note: 'cow back' },
  { id: 'p2', at: { kind: 'image-2d', x: 0.25, y: 0.75 } },
  { id: 'f1', at: { kind: 'model-3d', z: 1 } }
];
const rel = (kind, from, to, extra = {}) => ({ kind, from, to, ...extra });

function harness({ relations = [], topicRelations, cards = ['root', 'a', 'b'], layout } = {}) {
  const notices = [];
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Notice: dom.makeNotice(notices) } }, {
    createSvg, createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    getComputedStyle: el => style(el.computed ?? {}), setTimeout: () => 1, clearTimeout() {}
  });
  const spec = [['root', null, 0, 0], ['a', 'root', 400, 0], ['b', 'root', 400, 200]];
  const nodes = spec.map(([id, parentId, x, y]) => Object.assign(support.node(id, parentId), { x, y }));
  const doc = support.map(nodes);
  doc.title = 'T';
  if (layout) doc.layout = { direction: layout };
  doc.canvasItems = [{ ...IMG, anchors: anchors(), relations }];
  if (topicRelations) doc.topicRelations = topicRelations;
  const view = new VisualAgentMapView({ app: { vault: { getAbstractFileByPath: () => null } } }, { settings: { ...support.DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {} });
  view.map = doc; view.path = 'm/Map.md';
  view.notes = new Map(nodes.map(n => [n.id, { title: `Title ${n.id}`, summary: '' }]));
  view.viewportEl = element('div'); view.viewportEl.computed = style({ '--background-primary': '#ffffff', '--text-normal': '#222222' });
  view.contentEl = element('div'); view.stageEl = element('div');
  view.cardEls = new Map();
  for (const n of nodes.filter(item => cards.includes(item.id))) {
    const card = element('div', 'vam-node');
    Object.assign(card, { offsetLeft: n.x, offsetTop: n.y, offsetWidth: 280, offsetHeight: 100 });
    card.computed = style({ backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(204, 204, 204)' });
    const title = card.createDiv('vam-card-title'); title.text = n.id; title.computed = style({ color: 'rgb(34, 34, 34)' });
    view.cardEls.set(n.id, card);
  }
  view.edgesEl = createSvg('svg');
  view.draw = () => { view.drawRelations(); view.syncRelationClasses(); };
  const lines = () => [...view.relationEls.keys()];
  const pathOf = key => view.relationEls.get(key);
  return { view, doc, nodes, notices, lines, pathOf };
}
const KEY = (image, anchor, topic) => `anchor:${image}:${anchor}:${topic}`;

test('anchor relation: one line from the anchor to the nearest card edge, keyed apart from topic relations, all six kinds (verifies included)', () => {
  const relations = KINDS.map(kind => rel(kind, 'p1', 'a'));
  // One anchor and one topic can hold one relation, so six kinds go to six different anchor-topic pairs through six images.
  const h = harness();
  h.doc.canvasItems = KINDS.map((kind, i) => ({ ...IMG, id: `img${i}`, anchors: anchors(), relations: [rel(kind, 'p1', 'a')] }));
  h.view.draw();
  assert.deepEqual(h.lines(), KINDS.map((_, i) => KEY(`img${i}`, 'p1', 'a')));
  for (const [i, kind] of KINDS.entries()) {
    const path = h.pathOf(KEY(`img${i}`, 'p1', 'a'));
    assert.ok(path.hasClass('vam-relation') && path.hasClass(`vam-relation-${kind}`), kind);
    // The anchor centre is (img.x + 0.5 * w, img.y + 0.5 * h) in map units; the line leaves it.
    const lead = path.attrs.d.match(/^M (\S+) (\S+) C /);
    assert.ok(lead && Math.hypot(lead[1] - 200, lead[2] - 650) >= 7, `${kind}: the line starts clear of the anchor`);
    assert.equal(path.attrs['marker-end'] === undefined, kind === 'related', `${kind}: related has no arrowhead`);
    assert.equal(h.view.relationGapEls.has(KEY(`img${i}`, 'p1', 'a')), kind === 'derives_from', `${kind}: only derives_from has the second rail`);
    assert.ok(h.view.relationHitEls.has(KEY(`img${i}`, 'p1', 'a')) && h.view.relationLabelEls.has(KEY(`img${i}`, 'p1', 'a')));
  }
  assert.match(h.pathOf(KEY('img1', 'p1', 'a')).attrs['marker-end'], /-bar\)$/, 'contradicts uses the barred arrowhead');
  assert.equal(relations.length, 6);
  // The same six on a single image through different anchors would clash on the pair rule, so one image per kind above is the fixture.
});

test('direction follows from to: an anchor as the target puts the arrowhead on the anchor', () => {
  const h = harness({ relations: [rel('supports', 'a', 'p1'), rel('supports', 'p2', 'b')] });
  h.view.draw();
  const into = h.pathOf(KEY('img1', 'p1', 'a')).attrs.d, out = h.pathOf(KEY('img1', 'p2', 'b')).attrs.d;
  const tail = into.match(/ (\S+) (\S+)$/);
  assert.ok(tail && Math.hypot(tail[1] - 200, tail[2] - 650) >= 7, 'from the card, ends clear of the anchor');
  const start = out.match(/^M (\S+) (\S+) C /);
  assert.ok(start && Math.hypot(start[1] - 150, start[2] - 675) >= 7, 'from the anchor (0.25, 0.75), starting clear of it, ends on the card');
  const toCard = geometry.pointToBoxPathData({ x: 150, y: 675 }, { x: 400, y: 200, width: 280, height: 100 }, true);
  assert.equal(out, toCard);
});

test('geometry: the line enters the facing edge midpoint of the card; a point inside joins the centre; numbers only', () => {
  const box = { x: 400, y: 200, width: 280, height: 100 };
  assert.match(geometry.pointToBoxPathData({ x: 100, y: 250 }, box, true), / 400 250$/, 'left of the card: left edge');
  assert.match(geometry.pointToBoxPathData({ x: 900, y: 250 }, box, true), / 680 250$/, 'right of the card: right edge');
  assert.match(geometry.pointToBoxPathData({ x: 540, y: 600 }, box, true), / 540 300$/, 'below: bottom edge');
  assert.match(geometry.pointToBoxPathData({ x: 540, y: 0 }, box, true), / 540 200$/, 'above: top edge');
  assert.match(geometry.pointToBoxPathData({ x: 500, y: 250 }, box, true), / 540 250$/, 'inside: centre');
  const d = geometry.pointToBoxPathData({ x: 100, y: 250 }, box, false);
  assert.match(d, /^M 400 250 C /);
  assert.match(d, /^[MC0-9 .,-]+$/);
  const mid = geometry.pointToBoxLabelPoint({ x: 100, y: 250 }, box, true);
  assert.ok(mid.x > 100 && mid.x < 400 && Math.abs(mid.y - 250) < 1);
});

test('a map without anchor relations draws exactly the topic relation lines (same key, DOM and label)', () => {
  const h = harness({ topicRelations: [rel('supports', 'a', 'b', { description: 'why' })] });
  h.view.draw();
  assert.deepEqual(h.lines(), [`a${SEP}b${SEP}supports`]);
  assert.equal(h.view.anchorLinks.size, 0);
  assert.ok(!findAll(h.view.edgesEl, i => i.attrs['data-anchor-relation'] !== undefined).length);
  assert.equal(h.view.relationLabelEls.get(`a${SEP}b${SEP}supports`).text, 'Supports');
});

test('counter-example: topic off screen, anchor with an unknown position kind, relation to a missing topic draw nothing and do not throw', () => {
  const h = harness({ cards: ['root', 'a'], relations: [rel('supports', 'p1', 'b'), rel('supports', 'f1', 'a'), rel('related', 'p2', 'a'), rel('supports', 'p1', 'ghost')] });
  assert.doesNotThrow(() => h.view.draw());
  assert.deepEqual(h.lines(), [KEY('img1', 'p2', 'a')], 'only the 2D anchor with a topic on screen');
});

test('counter-example: an AIM map draws no anchor line', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a')] });
  h.view.relationsEnabled = () => false;
  h.view.draw();
  assert.deepEqual(h.lines(), []);
});

test('counter-example: an image whose file is missing still has its lines (they follow the data)', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a')] });
  h.view.canvasImageEls = new Map();
  h.view.draw();
  assert.deepEqual(h.lines(), [KEY('img1', 'p1', 'a')]);
});

test('label: kind name; hovered or selected shows "Name: anchor -> topic" and the note; plain text only', () => {
  const hostile = ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', 'line one\nline two', 'x'.repeat(300)];
  for (const description of hostile) {
    const h = harness({ relations: [rel('supports', 'p1', 'a', { description })] });
    h.view.draw();
    const key = KEY('img1', 'p1', 'a'), label = h.view.relationLabelEls.get(key);
    assert.equal(label.text, 'Supports');
    h.view.hoverRelation = key; h.view.syncRelationClasses();
    assert.ok(label.hasClass('is-expanded'));
    const parts = label.children.map(c => c.text);
    assert.equal(parts[0], 'Supports: Annotated image · cow back → Title a');
    const chars = Array.from(description);
    assert.equal(parts[1], chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : description, 'the note is text, cut at 60 characters');
    assert.ok(!findAll(label, i => i.tag === 'img' || i.tag === 'a').length, 'no element made from the text');
    assert.match(h.pathOf(key).attrs.d, /^[MC0-9 .,-]+$/, 'path data holds only numbers and command letters');
  }
  const h = harness({ relations: [rel('related', 'p2', 'a')] });
  h.view.draw();
  h.view.hoverRelation = KEY('img1', 'p2', 'a'); h.view.syncRelationClasses();
  assert.equal(h.view.relationLabelEls.get(KEY('img1', 'p2', 'a')).children[0].text, 'Related: Annotated image · anchor — Title a', 'an anchor without a note, related has a dash');
});

test('labels hide below zoom 0.6 and show from 0.6 (the same stage attribute as topic relations)', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a')] });
  h.view.draw();
  h.view.stageEl = createSvg('div');
  h.view.map.viewport = { x: 0, y: 0, zoom: 0.59 };
  h.view.transform();
  assert.equal(h.view.stageEl.attrs['data-relation-labels'], 'hidden');
  h.view.map.viewport = { x: 0, y: 0, zoom: 0.6 };
  h.view.transform();
  assert.equal(h.view.stageEl.attrs['data-relation-labels'], undefined);
});

test('selecting a topic highlights its anchor lines and dims the others; focusing an anchor highlights its lines', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a'), rel('related', 'p2', 'b')] });
  h.view.draw();
  const toA = h.pathOf(KEY('img1', 'p1', 'a')), toB = h.pathOf(KEY('img1', 'p2', 'b'));
  assert.ok(!toA.hasClass('is-related') && !toB.hasClass('is-dimmed'));
  h.view.selection.setSelected('a');
  h.view.syncRelationClasses();
  assert.ok(toA.hasClass('is-related') && !toA.hasClass('is-dimmed'));
  assert.ok(toB.hasClass('is-dimmed') && !toB.hasClass('is-related'));
  h.view.selection.setSelected(null);
  h.view.hoverAnchor = 'img1\u0000p2'; h.view.syncRelationClasses();
  assert.ok(toB.hasClass('is-related') && !toA.hasClass('is-related'));
});

// ---- P4 of "image as centre": straight ring lines and emphasis ------------------------------------------------------
// img1 sits at (100,600) 200x100, so card a (400,0) lies above it ("top") and the card end is its bottom edge midpoint.
const ringHarness = (relations, move = {}) => {
  const h = harness({ relations });
  for (const n of h.doc.nodes) n.parentId = null;
  Object.assign(h.doc.nodes.find(n => n.id === 'a'), move);
  if ('x' in move) Object.assign(h.view.cardEls.get('a'), { offsetLeft: move.x, offsetTop: move.y });
  h.view.draw();
  return h;
};
const num = d => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);

test('P4 ring line: a ring card gets a straight line from the anchor to the middle of its edge facing the picture; the label sits at its midpoint', () => {
  const h = ringHarness([rel('supports', 'p1', 'a', { ring: true })]);
  const d = h.pathOf(KEY('img1', 'p1', 'a')).attrs.d;
  assert.match(d, /^M [\d. -]+ L [\d. -]+$/, 'a straight path, no curve command');
  const box = { x: 400, y: 0, width: 280, height: 100 };
  assert.equal(d, geometry.pointToBoxStraightPathData({ x: 200, y: 650 }, box, 'top', true));
  const [, , x2, y2] = num(d);
  assert.deepEqual([x2, y2], [540, 100], 'ends at the bottom edge midpoint of the card above the picture');
  const label = h.view.relationLabelAt.get(KEY('img1', 'p1', 'a')), [x1, y1] = num(d);
  assert.deepEqual([label.x, label.y], [(x1 + x2) / 2, (y1 + 100) / 2]);
});

test('P4 ring line: all four sides end on the edge that faces the picture', () => {
  const box = { x: 0, y: 0, width: 100, height: 40 };
  const end = side => num(geometry.pointToBoxStraightPathData({ x: 500, y: 500 }, box, side, true)).slice(2);
  assert.deepEqual(end('top'), [50, 40]);
  assert.deepEqual(end('bottom'), [50, 0]);
  assert.deepEqual(end('left'), [100, 20]);
  assert.deepEqual(end('right'), [0, 20]);
});

test('counter-example P4: a line that is not a ring line keeps the curve (same path as before), and so does a ring card dragged into the picture', () => {
  const plainLine = harness({ relations: [rel('supports', 'p1', 'a')] });
  plainLine.view.draw();
  assert.equal(plainLine.pathOf(KEY('img1', 'p1', 'a')).attrs.d, geometry.pointToBoxPathData({ x: 200, y: 650 }, { x: 400, y: 0, width: 280, height: 100 }, true));
  assert.match(plainLine.pathOf(KEY('img1', 'p1', 'a')).attrs.d, / C /);
  // The ring card sits on the picture: its centre is inside, the end rule does not hold, the old curve is drawn and nothing throws.
  const inside = ringHarness([rel('supports', 'p1', 'a', { ring: true })], { x: 60, y: 580 });
  const d = inside.pathOf(KEY('img1', 'p1', 'a')).attrs.d;
  assert.equal(d, geometry.pointToBoxPathData({ x: 200, y: 650 }, { x: 60, y: 580, width: 280, height: 100 }, true));
  // Dragging the card into the picture and back swaps between the two.
  const out = ringHarness([rel('supports', 'p1', 'a', { ring: true })]);
  out.view.dragEdges('a', out.view.cardEls.get('a')).update(60, 580);
  assert.match(out.pathOf(KEY('img1', 'p1', 'a')).attrs.d, / C /);
  out.view.dragEdges('a', out.view.cardEls.get('a')).update(400, 0);
  assert.match(out.pathOf(KEY('img1', 'p1', 'a')).attrs.d, / L /);
});

test('P4 ring line: moving the picture moves the straight line with it (the preview uses the moved picture, not the stored one)', () => {
  const h = ringHarness([rel('supports', 'p1', 'a', { ring: true })]);
  const group = h.view.groupDragEdges(new Map([['a', h.view.cardEls.get('a')]]), 'img1');
  group.update(0, 0);
  assert.equal(h.pathOf(KEY('img1', 'p1', 'a')).attrs.d, geometry.pointToBoxStraightPathData({ x: 200, y: 650 }, { x: 400, y: 0, width: 280, height: 100 }, 'top', true));
  // The picture and the card move 1000 down together: still "top", still straight.
  group.update(0, 1000);
  assert.equal(h.pathOf(KEY('img1', 'p1', 'a')).attrs.d, geometry.pointToBoxStraightPathData({ x: 200, y: 1650 }, { x: 400, y: 1000, width: 280, height: 100 }, 'top', true));
});

const dotOf = (h, id) => { const dot = element('button', 'vam-anchor'); dot.isConnected = true; h.view.anchorDots.set(`img1${SEP}${id}`, dot); return dot; };
const state = (h, key) => { const p = h.pathOf(key); return `${p.hasClass('is-related') ? 'R' : '-'}${p.hasClass('is-dimmed') ? 'D' : '-'}`; };

test('A11 emphasis: a selected, a hovered and a focused card (and a hovered anchor) give the same result; leaving restores', () => {
  const h = ringHarness([rel('supports', 'p1', 'a', { ring: true }), rel('related', 'p2', 'b')]);
  const A = KEY('img1', 'p1', 'a'), B = KEY('img1', 'p2', 'b');
  const dotA = dotOf(h, 'p1'), dotB = dotOf(h, 'p2');
  h.view.syncRelationClasses();
  assert.deepEqual([state(h, A), state(h, B)], ['--', '--'], 'the lines are always shown, nothing is faded at rest');
  const select = () => { h.view.selection.setSelected('a'); h.view.syncRelationClasses(); };
  select();
  const bySelect = [state(h, A), state(h, B), dotA.hasClass('is-related'), dotB.hasClass('is-related')];
  assert.deepEqual(bySelect, ['R-', '-D', true, false]);
  h.view.selection.setSelected(null); h.view.syncRelationClasses();
  assert.deepEqual([state(h, A), state(h, B), dotA.hasClass('is-related')], ['--', '--', false], 'cleared');
  h.view.hoverTopic = 'a'; h.view.syncRelationClasses();
  assert.deepEqual([state(h, A), state(h, B), dotA.hasClass('is-related'), dotB.hasClass('is-related')], bySelect, 'card hover (and focus, which sets the same state) = selection');
  h.view.hoverTopic = null; h.view.hoverAnchor = `img1${SEP}p1`; h.view.syncRelationClasses();
  assert.deepEqual([state(h, A), state(h, B), dotA.hasClass('is-related'), dotB.hasClass('is-related')], bySelect, 'anchor hover/focus = card');
  h.view.hoverAnchor = null; h.view.syncRelationClasses();
  assert.deepEqual([state(h, A), state(h, B), dotA.hasClass('is-related')], ['--', '--', false]);
});

test('counter-example A11: selection and hover at once emphasise both; a hovered card that is deleted leaves no emphasis; multi-select works; topic lines are untouched', () => {
  const h = ringHarness([rel('supports', 'p1', 'a', { ring: true }), rel('related', 'p2', 'b')]);
  h.doc.topicRelations = [{ kind: 'supports', from: 'root', to: 'a' }];
  h.view.draw();
  const A = KEY('img1', 'p1', 'a'), B = KEY('img1', 'p2', 'b'), T = h.lines().find(k => !k.startsWith('anchor:'));
  const topicBefore = state(h, T);
  h.view.selection.setSelected('a'); h.view.hoverTopic = 'b'; h.view.syncRelationClasses();
  assert.deepEqual([state(h, A), state(h, B)], ['R-', 'R-'], 'selected a plus hovered b: both stand out');
  assert.equal(state(h, T), 'R-', 'a topic line follows the selection only (a is its end)');
  h.view.selection.setSelected(null); h.view.hoverTopic = 'a'; h.view.syncRelationClasses();
  assert.equal(state(h, T), topicBefore, 'a hover alone does not touch topic lines');
  // The hovered card is deleted: no mouseleave ever comes.
  h.view.cardEls.delete('a'); h.doc.nodes = h.doc.nodes.filter(n => n.id !== 'a'); h.doc.canvasItems[0].relations = [rel('related', 'p2', 'b')];
  h.view.draw();
  assert.equal(h.view.hoverTopic, null, 'the stale hover is cleared');
  assert.equal(state(h, B), '--', 'nothing is faded or emphasised any more');
  // Multi-select: both selected cards' lines are emphasised, others dimmed.
  const m = ringHarness([rel('supports', 'p1', 'a', { ring: true }), rel('related', 'p2', 'b'), rel('related', 'p1', 'root')]);
  m.view.selection.toggleMultiSelect();
  m.view.selection.replaceMulti(['a', 'b']);
  assert.ok(m.view.selection.state.multiSelectMode && m.view.selection.state.multiSelected.size === 2);
  m.view.syncRelationClasses();
  assert.deepEqual([state(m, KEY('img1', 'p1', 'a')), state(m, KEY('img1', 'p2', 'b')), state(m, KEY('img1', 'p1', 'root'))], ['R-', 'R-', '-D']);
});

test('A11 wiring: the real card events (mouseenter/leave, focusin) emphasise the lines like a selection does; a multi-select mode hover does too', () => {
  const h = ringHarness([rel('supports', 'p1', 'a', { ring: true }), rel('related', 'p2', 'b')]);
  Object.assign(h.view, { cardEls: new Map(), stageEl: element('div'), contentEl: element('div'), labelCard() {}, alignCardTools() {} });
  h.view.renderNode(h.doc.nodes.find(n => n.id === 'a'));
  const card = h.view.cardEls.get('a');
  card.matches = () => false;
  const fire = (name, event = {}) => card.listeners[name].forEach(fn => fn(event));
  h.view.cardEls.set('b', h.view.cardEls.get('b') ?? element('div'));
  h.view.draw();
  const A = KEY('img1', 'p1', 'a'), B = KEY('img1', 'p2', 'b');
  const states = () => [state(h, A), state(h, B)];
  fire('mouseenter');
  assert.deepEqual(states(), ['R-', '-D'], 'pointer');
  fire('mouseleave');
  assert.deepEqual(states(), ['--', '--'], 'pointer leaves');
  fire('focusin', { target: card });
  assert.deepEqual(states(), ['R-', '-D'], 'keyboard focus is the same as the pointer');
  // focusout reads `instanceof Node`, which the test sandbox does not have; it calls the same one-line clear as mouseleave.
  fire('mouseleave');
  assert.deepEqual(states(), ['--', '--'], 'leaving restores');
  h.view.selection.toggleMultiSelect();
  fire('mouseenter');
  assert.deepEqual(states(), ['R-', '-D'], 'multi-select mode');
  fire('mouseleave');
  assert.deepEqual(states(), ['--', '--']);
});

test('A11 map without anchor lines: classes on topic lines are as before (no hover effect, no anchor class)', () => {
  const h = harness({ topicRelations: [{ kind: 'supports', from: 'a', to: 'b' }] });
  h.view.draw();
  const only = h.lines()[0];
  h.view.hoverTopic = 'a'; h.view.syncRelationClasses();
  assert.ok(!h.pathOf(only).hasClass('is-related') && !h.pathOf(only).hasClass('is-dimmed'));
  h.view.hoverTopic = null; h.view.selection.setSelected('root'); h.view.syncRelationClasses();
  assert.ok(h.pathOf(only).hasClass('is-dimmed'), 'the old selection rule still dims');
});

test('hovering or pressing a line selects it; the selected line ends mark the topic card only; a click on it opens the anchor relation editor, never the topic one (P4b)', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a')] });
  let opened = 0;
  const anchorOpened = [];
  h.view.openRelationEditor = () => { opened++; };
  h.view.openAnchorRelationEditor = ref => { anchorOpened.push(ref); };
  h.view.draw();
  const key = KEY('img1', 'p1', 'a'), hit = h.view.relationHitEls.get(key);
  hit.fire('pointerenter');
  assert.equal(h.view.hoverRelation, key);
  hit.fire('pointerdown');
  assert.equal(h.view.selection.state.selectedRelation, key);
  assert.ok(h.pathOf(key).hasClass('is-selected'));
  assert.ok(h.view.cardEls.get('a').hasClass('is-relation-end'));
  hit.fire('click');
  assert.equal(opened, 0, 'the topic relation editor must not open for an anchor line');
  assert.deepEqual(JSON.parse(JSON.stringify(anchorOpened)), [{ imageId: 'img1', anchorId: 'p1', topicId: 'a' }]);
  h.view.drawRelations();
  assert.equal(h.view.selection.state.selectedRelation, key, 'a redraw keeps the selection of a line that still exists');
  h.view.map.canvasItems[0].relations = [rel('related', 'p2', 'b')];
  h.view.drawRelations();
  assert.equal(h.view.selection.state.selectedRelation, null, 'a removed line cannot stay selected');
});

test('dragging a topic card moves its anchor lines with it; other lines keep their path', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a'), rel('related', 'p2', 'b')] });
  h.view.draw();
  const before = h.pathOf(KEY('img1', 'p2', 'b')).attrs.d;
  const group = h.view.groupDragEdges(new Map([['a', h.view.cardEls.get('a')]]));
  group.update(0, 500);
  assert.equal(h.pathOf(KEY('img1', 'p1', 'a')).attrs.d, geometry.pointToBoxPathData({ x: 200, y: 650 }, { x: 400, y: 500, width: 280, height: 100 }, true));
  assert.equal(h.pathOf(KEY('img1', 'p2', 'b')).attrs.d, before);
  h.view.edgeEls = new Map();
  h.view.dragEdges('b', h.view.cardEls.get('b')).update(400, 900);
  assert.equal(h.pathOf(KEY('img1', 'p2', 'b')).attrs.d, geometry.pointToBoxPathData({ x: 150, y: 675 }, { x: 400, y: 900, width: 280, height: 100 }, true), 'a single-card drag moves its anchor line too');
});

test('card mark: "N image relations" with a map-pin icon and plain text; nothing at 0', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a'), rel('related', 'p2', 'a'), rel('related', 'f1', 'b')] });
  const card = h.view.cardEls.get('a');
  h.view.paintCardImageRelations(card, 'a');
  const mark = find(card, i => i.hasClass('vam-image-relations-mark'));
  assert.ok(mark);
  assert.equal(find(mark, i => i.hasClass('vam-image-relations-mark-icon')).iconName, 'map-pin');
  assert.equal(find(mark, i => i.hasClass('vam-image-relations-mark-text')).text, '2 image relation(s)');
  assert.equal(mark.attrs['aria-label'], '2 image relation(s)');
  h.view.paintCardImageRelations(card, 'a');
  assert.equal(findAll(card, i => i.hasClass('vam-image-relations-mark')).length, 1, 'a repaint replaces the mark, never doubles it');
  const none = element('div', 'vam-node');
  h.view.paintCardImageRelations(none, 'root');
  assert.equal(findAll(none, i => i.hasClass('vam-image-relations-mark')).length, 0);
  const aim = harness({ relations: [rel('supports', 'p1', 'a')] });
  aim.view.relationsEnabled = () => false;
  const aimCard = element('div', 'vam-node');
  aim.view.paintCardImageRelations(aimCard, 'a');
  assert.equal(findAll(aimCard, i => i.hasClass('vam-image-relations-mark')).length, 0, 'AIM maps show no mark');
});

test('export: PNG/SVG scene has no anchor line, label or hit path; the topic relation is still there', async () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a'), rel('derives_from', 'p2', 'b')], topicRelations: [rel('related', 'a', 'b')] });
  h.view.draw();
  assert.ok(h.lines().length === 3);
  // Give every drawn path a colour like the stylesheet would, so only the exclusion decides what the scene gets.
  for (const el of h.view.edgesEl.children) if (el.tagName === 'path') el.computed = style({ stroke: 'rgb(34, 34, 34)', display: 'inline' });
  const got = await h.view.collectExportScene(() => true);
  assert.equal(got.refuse, undefined);
  const ds = got.scene.edges.map(e => e.d);
  const topicD = h.pathOf(`a${SEP}b${SEP}related`).attrs.d;
  assert.ok(ds.includes(topicD), 'the topic relation is exported');
  for (const key of h.lines().filter(k => k.startsWith('anchor:'))) {
    assert.ok(!ds.includes(h.pathOf(key).attrs.d), `${key} is not exported`);
    assert.ok(!ds.includes(h.view.relationHitEls.get(key).attrs.d));
  }
  assert.ok(!ds.some(d => d.startsWith('M 200 650') || d.startsWith('M 150 675') || d.includes(' 200 650')));
  // The SVG written from it has no anchor-line coordinates either.
  const svg = support.load('experiences/visual-map/map-export.ts').buildMapSvg(got.scene);
  assert.ok(!svg.includes('M 200 650'));
});

test('annotated image element is a group with its label; a plain image stays an image', async () => {
  const h = harness();
  h.doc.canvasItems = [{ ...IMG, anchors: anchors() }, { id: 'plain1', kind: 'image', path: 'b.png', x: 0, y: 0, w: 10, h: 10 }];
  const layer = element('div');
  h.view.stageEl = layer;
  h.view.app.vault.getResourcePath = () => 'app://x';
  h.view.app.vault.getAbstractFileByPath = () => null;
  h.view.render = () => {};
  h.view.renderCanvasItems();
  const ann = find(layer, i => i.hasClass && i.hasClass('is-annotated'));
  const plain = find(layer, i => i.hasClass && i.hasClass('vam-canvas-image') && !i.hasClass('is-annotated'));
  assert.ok(ann && plain);
  assert.equal(ann.attrs.role, 'group');
  assert.equal(ann.attrs['aria-label'], 'Annotated image: cow scan');
  assert.equal(plain.attrs.role, 'img');
});

// ---- P4b: the topic panel's rows, the anchor relation editor, "Point on an image…" and the pick mode --------------------
// These use the real repo fixture (like steps-annotated-image-view.cjs) so a write goes through Map.md and the undo stack.
const { load: loadMain, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = support;
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-a/Map.md`;
const plain = value => JSON.parse(JSON.stringify(value));
const ann = (over = {}) => ({ id: 'img1', kind: 'annotated-image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, note: 'cow scan', anchors: [], ...over });
const pt = (id, note, x = 0.5, y = 0.5) => ({ id, at: { kind: 'image-2d', x, y }, ...(note === undefined ? {} : { note }) });

async function real(items) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-a', title: 'A', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-a`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(root);
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'inherited');
  child.parentId = root.id; child.x = 340;
  doc.nodes.push(child);
  doc.canvasItems = typeof items === 'function' ? items(root.id, child.id) : items;
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  await app.vault.create('attachments/a.png', 'png-bytes');
  app.vault.getResourcePath = file => `app://vault/${file.path}`;
  const modals = [], notices = [];
  const BaseModal = dom.makeModal();
  class Modal extends BaseModal { constructor(a) { super(a); modals.push(this); } }
  class Setting {
    constructor(parent) { this.el = parent.createDiv('setting-item'); }
    setName(text) { this.el.createSpan({ text }); return this; } setDesc(text) { this.el.createSpan({ text }); return this; }
    addButton(cb) { const b = this.el.createEl('button'); cb({ setButtonText(t) { b.text = t; return this; }, onClick(fn) { b.addEventListener('click', fn); return this; } }); return this; }
  }
  const { VisualAgentMapView } = loadMain('main.ts', { obsidian: { ...obsidian, Modal, Setting, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment, createSvg });
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => { view.stageEl.children = []; view.stageEl.child('div', 'vam-node'); view.renderCanvasItems(); };
  const settle = async () => { await pending; await dom.tick(); await pending; await dom.tick(); };
  const onDisk = async () => { const got = (await repo.readMap(MAP)).canvasItems; return got === undefined ? undefined : plain(got); };
  const panel = (node = view.map.nodes[0]) => { const host = element('div'); view.renderHypothesisSection(host, node, () => { host.closed = true; }); return host; };
  const rows = host => findAll(host, i => i.hasClass('vam-relation-row'));
  const imageEls = () => findAll(view.stageEl, i => i.hasClass('vam-canvas-image'));
  return { repo, view, settle, onDisk, modals, notices, panel, rows, imageEls, root: view.map.nodes[0].id, child: view.map.nodes[1].id, fileText: () => contents.get(MAP) };
}
const rowTexts = host => findAll(host, i => i.hasClass('vam-relation-row')).map(r => r.attrs['aria-label']);

test('P4b rows: the panel lists anchor relations as "kind <- Annotated image · anchor" (arrow follows the direction, related uses a dash), with the note', async () => {
  const h = await real((root, child) => [
    ann({ anchors: [pt('p1', 'cow back'), pt('p2'), pt('p3', 'hind')], relations: [
      { kind: 'supports', from: 'p1', to: root, description: 'strong' },
      { kind: 'contradicts', from: root, to: 'p2' },
      { kind: 'related', from: 'p3', to: root }
    ] })
  ]);
  const host = h.panel();
  assert.deepEqual(rowTexts(host), [
    'Supports ← Annotated image · cow back. strong',
    'Contradicts → Annotated image · anchor',
    'Related ← Annotated image · hind'
  ]);
  assert.equal(findAll(host, i => i.hasClass('vam-relation-empty')).length, 0, 'the empty hint is gone when only image relations exist');
  const first = h.rows(host)[0];
  assert.ok(find(first, i => i.hasClass('vam-relation-description-text') && i.text === 'strong'));
  const other = h.panel(h.view.map.nodes[1]);
  assert.deepEqual(rowTexts(other), [], 'a topic without image relations shows none');
});

test('counter-example (security P4b): hostile anchor and relation text stays plain text in rows, the pick panel and the editor', async () => {
  const evil = '<img src=x onerror=alert(1)> javascript:alert(1)\nline two';
  const h = await real(root => [ann({ note: evil, anchors: [pt('p1', evil)], relations: [{ kind: 'related', from: 'p1', to: root, description: evil.slice(0, 40) }] })]);
  const host = h.panel();
  const row = h.rows(host)[0];
  assert.ok(row.attrs['aria-label'].includes('<img src=x onerror=alert(1)>'), 'kept as text');
  assert.equal(findAll(host, i => i.tag === 'img').length, 0);
  assert.equal(findAll(host, i => i.tag === 'a').length, 0);
  assert.ok(!('innerHTML' in row) || row.innerHTML === undefined);
  const editor = element('div');
  h.view.renderAnchorRelationEditor(editor, { imageId: 'img1', anchorId: 'p1', topicId: h.root }, () => {}, () => {});
  assert.equal(findAll(editor, i => i.tag === 'img' || i.tag === 'a').length, 0);
  const select = findAll(host, i => i.hasClass('vam-relation-add-kind'))[0];
  assert.ok(select);
  findAll(host, i => i.hasClass('vam-relation-add-anchor'))[0].click();
  const modal = h.modals.at(-1);
  assert.equal(findAll(modal.modalEl, i => i.tag === 'img' || i.tag === 'a').length, 0);
  assert.ok(findAll(modal.modalEl, i => i.text.includes('<img src=x onerror=alert(1)>')).length >= 1);
});

test('editor: kind, reverse, note and delete are one undo step each; delete keeps the anchor and the card mark count drops; undo restores', async () => {
  const start = root => [ann({ anchors: [pt('p1', 'cow back')], relations: [{ kind: 'supports', from: 'p1', to: root }] })];
  const h = await real(start);
  const original = (await h.onDisk())[0];
  const host = element('div');
  let changed = 0;
  h.view.renderAnchorRelationEditor(host, { imageId: 'img1', anchorId: 'p1', topicId: h.root }, () => {}, () => { changed++; });
  const entries = () => h.view.history.past.length;
  let n = entries();
  const kind = find(host, i => i.tag === 'select');
  assert.equal(findAll(kind, i => i.tag === 'option' && !i.disabled).length, 6, 'all six kinds stay open (anchor relations have no cycle rule)');
  kind.value = 'verifies'; kind.fire('change');
  await h.settle();
  assert.equal((await h.onDisk())[0].relations[0].kind, 'verifies');
  assert.equal(entries(), n + 1);
  dom.button(host, 'Reverse direction').click();
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].relations, [{ kind: 'verifies', from: h.root, to: 'p1' }]);
  assert.equal(entries(), n + 2);
  const note = find(host, i => i.tag === 'textarea');
  note.value = 'line one\nline two'; note.fire('change');
  await h.settle();
  assert.equal((await h.onDisk())[0].relations[0].description, 'line one line two');
  assert.equal(entries(), n + 3);
  assert.equal((await h.onDisk())[0].relations.length, 1, 'still one relation for the pair');
  n = entries();
  let closed = false;
  const host2 = element('div');
  h.view.renderAnchorRelationEditor(host2, { imageId: 'img1', anchorId: 'p1', topicId: h.root }, () => { closed = true; }, () => {});
  dom.button(host2, 'Delete relation').click();
  await h.settle();
  const after = (await h.onDisk())[0];
  assert.deepEqual(after.anchors.map(a => a.id), ['p1'], 'the anchor stays');
  assert.equal(after.relations, undefined);
  assert.ok(closed);
  assert.equal(entries(), n + 1);
  const card = element('div', 'vam-node');
  h.view.map = await h.repo.readMap(MAP);
  h.view.paintCardImageRelations(card, h.root);
  assert.equal(findAll(card, i => i.hasClass('vam-image-relations-mark')).length, 0, 'the mark count dropped to none');
  await h.view.history.undoEntry.undo();
  assert.equal((await h.onDisk())[0].relations.length, 1, 'one undo restores the deleted relation');
});

test('editor: an unreachable pair (already related) cannot be duplicated; the line click on an anchor line opens this editor', async () => {
  const h = await real(root => [ann({ anchors: [pt('p1', 'x')], relations: [{ kind: 'related', from: 'p1', to: root }] })]);
  // The data layer refuses a second relation for the pair, whatever the kind or direction.
  const canvas = support.load('experiences/visual-map/canvas-items.ts');
  const items = h.view.map.canvasItems;
  for (const [from, to] of [['p1', h.root], [h.root, 'p1']]) {
    const next = canvas.addAnchorRelation(items, 'img1', { kind: 'supports', from, to });
    assert.equal(next[0].relations.length, 1);
  }
  h.view.cardEls = new Map(h.view.map.nodes.map(n => { const c = element('div', 'vam-node'); Object.assign(c, { offsetLeft: n.x, offsetTop: n.y, offsetWidth: 280, offsetHeight: 100 }); return [n.id, c]; }));
  h.view.edgesEl = createSvg('svg');
  h.view.viewportEl = element('div'); h.view.viewportEl.computed = style({});
  h.view.drawRelations();
  const key = `anchor:img1:p1:${h.root}`;
  const hit = h.view.relationHitEls.get(key);
  assert.ok(hit);
  const before = h.modals.length;
  hit.fire('click');
  assert.equal(h.modals.length, before + 1, 'the click opens the anchor relation editor dialog');
  assert.equal(h.view.selection.state.selectedRelation, key);
  const ro = await real(root => [ann({ anchors: [pt('p1', 'x')], relations: [{ kind: 'related', from: 'p1', to: root }] })]);
  ro.view.aimLive = () => true;
  ro.view.openAnchorRelationEditor({ imageId: 'img1', anchorId: 'p1', topicId: ro.root });
  assert.equal(ro.modals.length, 0, 'AIM opens no editor');
});

test('add from topic: "Point on an image…" lists existing anchors ("image · anchor"), disables the linked one, and adds a relation with the row kind (anchor -> topic)', async () => {
  const h = await real((root, child) => [
    ann({ note: 'cow scan', anchors: [pt('p1', 'cow back'), pt('p2', 'hind'), pt('p3')], relations: [{ kind: 'related', from: 'p1', to: root }] }),
    ann({ id: 'img2', note: '', path: 'attachments/b.png', anchors: [pt('q1', 'tail')] })
  ]);
  const host = h.panel();
  const kind = find(host, i => i.hasClass('vam-relation-add-kind'));
  kind.value = 'supports'; kind.fire('change');
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  const modal = h.modals.at(-1);
  const entry = text => find(modal.modalEl, i => i.tag === 'button' && i.text === text);
  assert.ok(entry('cow scan · cow back').disabled, 'already linked to this topic');
  assert.ok(find(modal.modalEl, i => i.text === 'Already linked to this topic'));
  assert.equal(entry('cow scan · hind').disabled, false);
  assert.ok(entry('cow scan · Anchor (no note)'));
  assert.ok(entry('b.png · tail'), 'no image note falls back to the file name');
  const n = h.view.history.past.length;
  entry('cow scan · hind').click();
  await h.settle();
  const rel = (await h.onDisk())[0].relations;
  assert.deepEqual(rel[1], { kind: 'supports', from: 'p2', to: h.root });
  assert.equal(h.view.history.past.length, n + 1);
  assert.equal((await h.onDisk())[0].relations.length, 2, 'the linked anchor got no second relation');
});

test('pick mode: "new point" closes the panel and shows the hint (role status); a plain image gives a Notice and stays in the mode; Esc leaves map and undo stack unchanged', async () => {
  const h = await real([ann({ anchors: [] }), { id: 'plain1', kind: 'image', path: 'attachments/a.png', x: 0, y: 0, w: 10, h: 10 }]);
  h.view.render();
  const host = h.panel();
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  const before = h.fileText(), n = h.view.history.past.length;
  dom.button(h.modals.at(-1).modalEl, 'Place a new point on an image').click();
  assert.ok(host.closed, 'the panel dialog is closed so the canvas can be clicked');
  const hint = find(h.view.contentEl, i => i.hasClass('vam-place-hint'));
  assert.ok(hint);
  assert.equal(hint.attrs.role, 'status');
  assert.ok(findAll(hint, i => i.text === 'Pick mode: only annotated images can be clicked').length === 1);
  assert.ok(findAll(hint, i => i.text === 'Esc to cancel').length === 1);
  const [annotatedEl, plainEl] = h.imageEls();
  h.view.contentEl.fire('click', { target: plainEl });
  assert.deepEqual(h.notices, ['This is a plain image. Right-click it and choose “Convert to annotated image” first, then you can place a point.']);
  assert.ok(find(h.view.contentEl, i => i.hasClass('vam-place-hint')), 'still in the mode');
  assert.equal(h.view.map.canvasItems[1].kind, 'image', 'not converted');
  let prevented = false;
  h.view.contentEl.fire('keydown', { key: 'Escape', target: annotatedEl, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(find(h.view.contentEl, i => i.hasClass('vam-place-hint')), undefined);
  await h.settle();
  assert.equal(h.fileText(), before);
  assert.equal(h.view.history.past.length, n);
  h.view.contentEl.fire('click', { target: annotatedEl });
  assert.equal(find(h.view.contentEl, i => i.hasClass('vam-anchor-crosshair')) ?? find(annotatedEl, i => i.hasClass('vam-anchor-crosshair')), undefined, 'the mode is over: a click does not start placing');
});

test('pick mode: clicking an annotated image starts placing; Enter writes the anchor and the relation (row kind, anchor -> topic) as one undo step; a click elsewhere cancels', async () => {
  const h = await real([ann({ anchors: [] })]);
  h.view.render();
  const host = h.panel();
  const kind = find(host, i => i.hasClass('vam-relation-add-kind'));
  kind.value = 'verifies'; kind.fire('change');
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  dom.button(h.modals.at(-1).modalEl, 'Place a new point on an image').click();
  const [el] = h.imageEls();
  h.view.contentEl.fire('click', { target: element('div') });
  assert.equal(find(h.view.contentEl, i => i.hasClass('vam-place-hint')), undefined, 'a click elsewhere cancels');
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  dom.button(h.modals.at(-1).modalEl, 'Place a new point on an image').click();
  const n = h.view.history.past.length;
  h.view.contentEl.fire('click', { target: el, clientX: 0, clientY: 0 });
  assert.ok(h.view.placing, 'now in the place mode of P3b');
  h.view.stageEl.fire('keydown', { key: 'Enter', target: el, preventDefault() {} });
  await h.settle();
  const [img] = await h.onDisk();
  assert.equal(img.anchors.length, 1);
  assert.deepEqual(img.relations, [{ kind: 'verifies', from: img.anchors[0].id, to: h.root }]);
  assert.equal(h.view.history.past.length, n + 1, 'anchor and relation in one step');
  await h.view.history.undoEntry.undo();
  const undone = (await h.onDisk())[0];
  assert.deepEqual(undone.anchors, []);
  assert.equal(undone.relations, undefined);
});

test('counter-example (read-only P4b): AIM and selection mode show the rows but no add entry, edit or remove buttons', async () => {
  for (const mode of ['selection', 'aim']) {
    const h = await real(root => [ann({ anchors: [pt('p1', 'x')], relations: [{ kind: 'related', from: 'p1', to: root }] })]);
    if (mode === 'selection') h.view.selection.toggleMultiSelect();
    else h.view.aimLive = () => true;
    const host = h.panel();
    if (mode === 'aim') { assert.deepEqual(rowTexts(host), [], mode + ': AIM shows no relation section at all'); continue; }
    assert.deepEqual(rowTexts(host), ['Related ← Annotated image · x'], mode);
    assert.equal(findAll(host, i => i.hasClass('vam-relation-add-anchor')).length, 0, mode);
    assert.equal(findAll(host, i => i.tag === 'button' && /Edit relation|Remove relation/.test(i.attrs['aria-label'] ?? '')).length, 0, mode);
    const row = h.rows(host)[0];
    row.fire('click');
    assert.equal(h.modals.length, 0, mode);
  }
});

test('geometry: the anchor end starts at least 7px (the anchor radius) from the anchor centre, in every direction', () => {
  const box = { x: 400, y: 200, width: 280, height: 100 };
  const points = [{ x: 100, y: 250 }, { x: 900, y: 250 }, { x: 540, y: 600 }, { x: 540, y: 0 }, { x: 380, y: 250 }, { x: 300, y: 80 }, { x: 800, y: 500 }];
  for (const point of points)
    for (const pointIsFrom of [true, false]) {
      const d = geometry.pointToBoxPathData(point, box, pointIsFrom);
      assert.match(d, /^[MC0-9 .,-]+$/, 'numbers only');
      const n = d.match(/-?\d+(\.\d+)?/g).map(Number);
      const end = pointIsFrom ? { x: n[0], y: n[1] } : { x: n[6], y: n[7] };
      assert.ok(Math.hypot(end.x - point.x, end.y - point.y) >= 7, `clear of the anchor at ${point.x},${point.y} from=${pointIsFrom}: ${d}`);
      const label = geometry.pointToBoxLabelPoint(point, box, pointIsFrom);
      assert.ok(Number.isFinite(label.x) && Number.isFinite(label.y));
    }
  assert.match(geometry.pointToBoxPathData({ x: 500, y: 250 }, box, true), /^M 500 250 C .* 540 250$/, 'inside the card: as before');
});

// Review round 1, R1: the ring is placed around the cards that stay, which only works if their lines are the straight
// lines the placement counted. On a picture with a ring every line is straight; a picture without one keeps its curves.
test('R1: on a picture that has a ring a line to an ordinary topic is straight too, to the edge facing the picture', () => {
  const h = ringHarness([rel('supports', 'p1', 'a', { ring: true }), rel('supports', 'p2', 'b')]);
  const d = h.pathOf(KEY('img1', 'p2', 'b')).attrs.d;
  assert.equal(d, geometry.pointToBoxStraightPathData({ x: 150, y: 675 }, { x: 400, y: 200, width: 280, height: 100 }, 'top', true));
  assert.doesNotMatch(d, / C /);
  // The same line on a picture without a ring is the curve, as before.
  const plain = harness({ relations: [rel('supports', 'p2', 'b')] });
  plain.view.draw();
  assert.match(plain.pathOf(KEY('img1', 'p2', 'b')).attrs.d, / C /);
});

// Review round 1, M1: a plain "related" ring line needs no name on the picture; hovering or selecting it shows the name.
test('M1: the name of a ring line of the kind related shows only when expanded; other lines keep theirs', () => {
  const h = ringHarness([rel('related', 'p1', 'a', { ring: true }), rel('supports', 'p2', 'b', { ring: true })]);
  const quiet = h.view.relationLabelEls.get(KEY('img1', 'p1', 'a')), loud = h.view.relationLabelEls.get(KEY('img1', 'p2', 'b'));
  assert.ok(quiet.hasClass('is-ring-quiet'), 'ring + related: quiet');
  assert.ok(!loud.hasClass('is-ring-quiet'), 'ring + supports: named as before');
  const other = ringHarness([rel('related', 'p1', 'a', { ring: true }), rel('related', 'p2', 'b')]);
  assert.ok(!other.view.relationLabelEls.get(KEY('img1', 'p2', 'b')).hasClass('is-ring-quiet'), 'a related line that is not a ring line keeps its name');
});
