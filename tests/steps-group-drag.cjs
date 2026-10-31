// Selection-mode group drag: dragging a picked card moves every picked card by one offset and saves it as one change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const geometry = support.load('experiences/visual-map/relation-geometry.ts');
const SEP = '\u0000';

// root(0,0) -> a(400,0) -> c(800,0); root -> b(400,200); root -> d(400,400). Every card is 280 x 100.
function harness({ layout, notes = [] } = {}) {
  const frames = [], cancelled = [];
  const windowValues = { setTimeout: run => { run(); return 1; }, clearTimeout() {}, requestAnimationFrame: run => { frames.push(run); return frames.length; }, cancelAnimationFrame: id => { cancelled.push(id); } };
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Notice: dom.makeNotice(notes) } }, windowValues);
  const spec = [['root', null, 0, 0], ['a', 'root', 400, 0], ['b', 'root', 400, 200], ['c', 'a', 800, 0], ['d', 'root', 400, 400]];
  const nodes = spec.map(([id, parentId, x, y]) => Object.assign(support.node(id, parentId), { x, y }));
  const doc = support.map(nodes);
  if (layout) doc.layout = { direction: layout };
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...support.DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {} });
  view.map = doc; view.path = 'm/Map.md';
  const make = id => {
    const n = nodes.find(item => item.id === id);
    const handlers = new Map();
    return { id, handlers, style: { left: `${n.x}px`, top: `${n.y}px` }, offsetLeft: n.x, offsetTop: n.y, offsetWidth: 280, offsetHeight: 100,
      addEventListener(name, handler) { handlers.set(name, handler); }, removeEventListener(name) { handlers.delete(name); }, setPointerCapture() {} };
  };
  const cards = Object.fromEntries(nodes.map(n => [n.id, make(n.id)]));
  view.cardEls = new Map(Object.entries(cards));
  const pathOf = () => { const attrs = {}; return { attrs, setAttribute(name, value) { attrs[name] = value; } }; };
  const edges = { 'root>a': pathOf(), 'a>c': pathOf(), 'root>b': pathOf(), 'root>d': pathOf() };
  view.edgeEls = new Map(Object.entries(edges).map(([k, v]) => [k.replace('>', SEP), v]));
  const relation = pathOf();
  view.relationEls = new Map([[`b${SEP}d`, relation]]);
  view.relationHitEls = new Map(); view.relationGapEls = new Map(); view.placeRelationLabel = () => {};
  const references = [];
  view.chat = { hitTest: (x) => x >= 5000, setDropHighlight() {}, addTopicReference: id => references.push(id) };
  const changes = [];
  view.enqueue = work => work();
  view.mapChange = async change => { changes.push(change); };
  for (const n of nodes) view.enableDrag(cards[n.id], n);
  view.integrationMode = true; view.multiSelected = new Set(['a', 'b']);
  const down = (id, x = 0, y = 0) => cards[id].handlers.get('pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: x, clientY: y });
  const fire = (id, name, x = 0, y = 0) => cards[id].handlers.get(name)?.({ type: name, clientX: x, clientY: y });
  const flush = () => { while (frames.length) frames.shift()(); };
  // Runs the saved changes against a fresh copy of the map and returns [id, x, y] for every card.
  const saved = () => { const copy = JSON.parse(JSON.stringify(doc)); changes.forEach(change => change(copy)); return Object.fromEntries(copy.nodes.map(n => [n.id, [n.x, n.y]])); };
  return { view, doc, cards, edges, relation, references, changes, down, fire, flush, saved, notes, cancelled };
}
const box = (x, y) => ({ x, y, width: 280, height: 100 });

test('group drag: every picked card moves by the same offset, in one change', () => {
  const h = harness();
  h.down('a'); h.fire('a', 'pointermove', 50, 30); h.flush();
  assert.equal(h.cards.a.style.left, '450px'); assert.equal(h.cards.a.style.top, '30px');
  assert.equal(h.cards.b.style.left, '450px'); assert.equal(h.cards.b.style.top, '230px');
  assert.equal(h.cards.c.style.left, '800px', 'a card that is not picked stays');
  h.fire('a', 'pointermove', 61, 40);
  h.fire('a', 'pointerup', 61, 40);
  assert.equal(h.changes.length, 1, 'one change is one undo step');
  assert.equal(h.view.dragging, false);
  assert.deepEqual(h.saved(), { root: [0, 0], a: [461, 40], b: [461, 240], c: [800, 0], d: [400, 400] });
});

test('group drag: the offset follows the zoom and the saved positions are rounded', () => {
  const h = harness();
  h.view.map.viewport.zoom = 2;
  h.down('b'); h.fire('b', 'pointermove', 51, 11); h.fire('b', 'pointerup', 51, 11);
  assert.deepEqual([h.saved().a, h.saved().b], [[426, 6], [426, 206]]);
});

test('group drag: an edge with both ends in the group uses both new positions, one end keeps the measured far end', () => {
  const h = harness();
  h.view.multiSelected = new Set(['a', 'c']);
  h.down('a'); h.fire('a', 'pointermove', 0, 100); h.flush();
  assert.notEqual(h.edges['a>c'].attrs.d, undefined);
  assert.match(h.edges['a>c'].attrs.d, /^M 680 150 /, 'starts at the moved parent right edge, centre height');
  assert.match(h.edges['a>c'].attrs.d, / 800 150$/, 'ends at the moved child left edge, centre height');
  assert.match(h.edges['root>a'].attrs.d, /^M 280 50 .* 400 150$/, 'the root stays, the child end moved');
  assert.equal(h.edges['root>b'].attrs.d, undefined, 'an edge that touches no picked card is not touched');
});

test('group drag: a relation between two picked cards follows both', () => {
  const h = harness();
  h.view.multiSelected = new Set(['b', 'd']);
  h.down('b'); h.fire('b', 'pointermove', 0, 40); h.flush();
  assert.equal(h.relation.attrs.d, geometry.relationPathData(box(400, 240), box(400, 440)));
});

test('click without moving more than 3px does not move and leaves the click to the click handler', () => {
  const h = harness();
  h.down('a'); h.fire('a', 'pointermove', 2, 2); h.flush(); h.fire('a', 'pointerup', 2, 2);
  assert.equal(h.changes.length, 0); assert.equal(h.cards.a.style.left, '400px');
  assert.equal(h.view.suppressClickUntil ?? 0, 0, 'a tap does not suppress the click');
});

test('after a drag the click that follows is suppressed', () => {
  const h = harness();
  h.down('a'); h.fire('a', 'pointermove', 40, 0); h.fire('a', 'pointerup', 40, 0);
  assert.ok(h.view.suppressClickUntil > Date.now() - 1);
});

test('pointercancel and lostpointercapture put the whole group back and write nothing', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const h = harness();
    h.down('a'); h.fire('a', 'pointermove', 60, 60); h.flush();
    assert.equal(h.cards.b.style.left, '460px');
    h.fire('a', 'pointermove', 70, 70); // a pending frame at the moment of the cancel
    h.fire('a', ending, 70, 70);
    assert.equal(h.changes.length, 0, ending);
    assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.cards.b.style.top, '200px');
    assert.equal(h.view.dragging, false); assert.deepEqual(h.cancelled.length, 1, 'the pending frame is cancelled');
  }
});

test('dropping on the chat adds every picked card as a reference and writes nothing', () => {
  const h = harness();
  h.down('a'); h.fire('a', 'pointermove', 60, 0); h.flush();
  h.fire('a', 'pointermove', 6000, 0); h.fire('a', 'pointerup', 6000, 0);
  assert.equal(h.changes.length, 0); assert.deepEqual(h.references.sort(), ['a', 'b']);
  assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.cards.b.style.left, '400px');
});

test('dragging a card that is not picked does not move anything; dropping it on the chat adds only that card', () => {
  const h = harness();
  h.down('d'); h.fire('d', 'pointermove', 60, 60); h.flush();
  assert.equal(h.cards.d.style.left, '400px'); assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.view.dragging, true);
  h.fire('d', 'pointerup', 60, 60);
  assert.equal(h.changes.length, 0);
  const g = harness();
  g.down('d'); g.fire('d', 'pointermove', 6000, 0); g.fire('d', 'pointerup', 6000, 0);
  assert.deepEqual(g.references, ['d']); assert.equal(g.changes.length, 0);
});

test('a merging member blocks the whole group with one Notice', () => {
  const notes = [];
  const h = harness({ notes });
  h.view.mergeTasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: 'b', path: 'b.md' }], controller: new AbortController(), state: 'running' });
  h.down('a'); h.fire('a', 'pointermove', 40, 0); h.fire('a', 'pointermove', 80, 0); h.flush();
  assert.equal(notes.length, 1); assert.equal(notes[0], 'Merging; try again when it finishes');
  h.fire('a', 'pointerup', 80, 0);
  assert.equal(h.changes.length, 0); assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.cards.b.style.left, '400px');
});

test('relevance sort keeps the group where it is', () => {
  const h = harness();
  h.view.relevanceSortOn = () => true;
  h.down('a'); h.fire('a', 'pointermove', 40, 0); h.flush(); h.fire('a', 'pointerup', 40, 0);
  assert.equal(h.changes.length, 0); assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.notes?.length ?? 0, 0);
});

test('timeline: a group with a first-level topic does not move and says why once; without one it moves', () => {
  const notes = [];
  const h = harness({ layout: 'timeline', notes });
  h.down('a'); h.fire('a', 'pointermove', 40, 0); h.fire('a', 'pointermove', 60, 0); h.flush(); h.fire('a', 'pointerup', 60, 0);
  assert.equal(h.changes.length, 0); assert.equal(h.cards.a.style.left, '400px');
  assert.deepEqual(notes, ['First-level topics in a timeline are reordered by dragging and cannot move as a group; uncheck them and drag again']);
  const ok = harness({ layout: 'timeline' });
  ok.view.multiSelected = new Set(['c']);
  ok.down('c'); ok.fire('c', 'pointermove', 40, 0); ok.fire('c', 'pointerup', 40, 0);
  assert.equal(ok.changes.length, 1); assert.deepEqual(ok.saved().c, [840, 0]);
});

test('the map swapped mid-drag ends the drag without writing', () => {
  const h = harness();
  h.down('a'); h.fire('a', 'pointermove', 40, 0);
  h.view.map = { ...h.view.map, id: 'other' };
  h.fire('a', 'pointermove', 80, 0);
  assert.equal(h.view.dragging, false); assert.equal(h.changes.length, 0);
});

test('a member removed from the map before the drop is skipped, the rest still move', () => {
  const h = harness();
  h.down('a'); h.fire('a', 'pointermove', 40, 0); h.fire('a', 'pointerup', 40, 0);
  const copy = JSON.parse(JSON.stringify(h.doc)); copy.nodes = copy.nodes.filter(n => n.id !== 'b');
  h.changes[0](copy);
  assert.deepEqual(copy.nodes.find(n => n.id === 'a') && [copy.nodes.find(n => n.id === 'a').x, copy.nodes.find(n => n.id === 'a').y], [440, 0]);
});

test('single card drag outside selection mode is unchanged', () => {
  const h = harness();
  h.view.integrationMode = false; h.view.multiSelected = new Set();
  h.down('d'); h.fire('d', 'pointermove', 30, 20); h.flush(); h.fire('d', 'pointerup', 30, 20);
  assert.equal(h.cards.d.style.left, '430px'); assert.equal(h.changes.length, 1); assert.deepEqual(h.saved().d, [430, 420]); assert.deepEqual(h.saved().a, [400, 0]);
});

test('fishbone: a picked head and topic move the spine with them', () => {
  const h = harness({ layout: 'fishbone' });
  const spine = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  h.view.spineEls = new Map([['root', spine]]);
  h.view.canvasNodes = () => h.doc.nodes;
  h.view.multiSelected = new Set(['a', 'b']);
  h.down('a'); h.fire('a', 'pointermove', 0, 50); h.flush();
  assert.equal(spine.attrs.d, geometry.fishboneSpinePathData(box(0, 0), [box(400, 50), box(400, 250), box(400, 400)]));
});
