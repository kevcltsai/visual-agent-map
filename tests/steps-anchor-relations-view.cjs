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
    assert.match(path.attrs.d, /^M 200 650 C /, kind);
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
  assert.match(into, / 200 650$/, 'from the card, ends on the anchor');
  assert.match(out, /^M 150 675 C /, 'from the anchor (0.25, 0.75), ends on the card');
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

test('hovering or pressing a line selects it; the selected line ends mark the topic card only; the editor is not opened yet (P4b)', () => {
  const h = harness({ relations: [rel('supports', 'p1', 'a')] });
  let opened = 0;
  h.view.openRelationEditor = () => { opened++; };
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
