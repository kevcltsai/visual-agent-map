// Dropping a dragged card (or a picked group) on another card makes it the new parent, with the same rule as "Move to...".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');

// root(0,0) -> a(400,0) -> c(800,0); root -> b(400,200); root -> d(400,400). Every card is 280 x 100, zoom 1.
// The fake card rect equals its position, so a pointer's client position is also its map position.
function harness({ notes = [], aim = false } = {}) {
  const frames = [];
  const windowValues = { setTimeout: run => { run(); return 1; }, clearTimeout() {}, requestAnimationFrame: run => { frames.push(run); return frames.length; }, cancelAnimationFrame() {} };
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Notice: dom.makeNotice(notes) } }, windowValues);
  const spec = [['root', null, 0, 0], ['a', 'root', 400, 0], ['b', 'root', 400, 200], ['c', 'a', 800, 0], ['d', 'root', 400, 400]];
  const nodes = spec.map(([id, parentId, x, y]) => Object.assign(support.node(id, parentId), { x, y }));
  const doc = support.map(nodes);
  if (aim) doc.aim = {};
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...support.DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {} });
  view.map = doc; view.path = 'm/Map.md';
  const make = id => {
    const n = nodes.find(item => item.id === id);
    const handlers = new Map(), classes = new Set();
    return { id, handlers, classes, style: { left: `${n.x}px`, top: `${n.y}px` }, offsetLeft: n.x, offsetTop: n.y, offsetWidth: 280, offsetHeight: 100,
      toggleClass() {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
      getBoundingClientRect: () => ({ left: n.x, top: n.y }),
      addEventListener(name, handler) { handlers.set(name, handler); }, removeEventListener(name) { handlers.delete(name); }, setPointerCapture() {} };
  };
  const cards = Object.fromEntries(nodes.map(n => [n.id, make(n.id)]));
  view.cardEls = new Map(Object.entries(cards));
  view.edgeEls = new Map(); view.relationEls = new Map(); view.relationHitEls = new Map(); view.relationGapEls = new Map(); view.placeRelationLabel = () => {};
  const references = [], errors = [], changes = [];
  view.chat = { hitTest: x => x >= 5000, setDropHighlight() {}, addTopicReference: id => references.push(id) };
  view.enqueue = work => work().catch(error => errors.push(error.message));
  view.mapChange = async change => { changes.push(change); };
  view.render = () => {};
  for (const n of nodes) view.enableDrag(cards[n.id], n);
  const at = id => nodes.find(n => n.id === id);
  const down = id => cards[id].handlers.get('pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: at(id).x + 10, clientY: at(id).y + 10 });
  const fire = (id, name, x = 0, y = 0) => cards[id].handlers.get(name)?.({ type: name, clientX: x, clientY: y });
  const flush = () => { while (frames.length) frames.shift()(); };
  const drag = (id, x, y) => { down(id); fire(id, 'pointermove', x, y); flush(); };
  const drop = (id, x, y) => fire(id, 'pointerup', x, y);
  const saved = () => { const copy = JSON.parse(JSON.stringify(doc)); changes.forEach(change => change(copy)); return Object.fromEntries(copy.nodes.map(n => [n.id, n])); };
  const lit = () => Object.keys(cards).filter(id => cards[id].classes.has('is-reparent-target'));
  return { view, doc, cards, references, changes, errors, notes, drag, drop, fire, saved, lit, nodes };
}
const CIRCULAR = 'Circular links are not allowed.';

test('dropping a card on another card makes it a child, expands the target, and is one change', async () => {
  const h = harness();
  h.nodes.find(n => n.id === 'b').collapsed = true;
  h.drag('d', 450, 250);
  assert.deepEqual(h.lit(), ['b'], 'the target is highlighted while the pointer is over it');
  h.drop('d', 450, 250);
  await Promise.resolve();
  assert.equal(h.changes.length, 1, 'one mapChange is one undo step');
  const after = h.saved();
  assert.equal(after.d.parentId, 'b'); assert.equal(after.b.collapsed, false);
  assert.deepEqual(h.lit(), [], 'the highlight is gone after the drop');
  assert.equal(h.cards.d.style.left, '400px', 'the card is put back for the re-layout to place');
});

test('the descendants of the dragged card go with it', () => {
  const h = harness();
  h.drag('a', 450, 450); h.drop('a', 450, 450);
  const after = h.saved();
  assert.equal(after.a.parentId, 'd'); assert.equal(after.c.parentId, 'a');
});

test('empty space, the card itself and the current parent only move the card', () => {
  for (const [x, y] of [[1500, 900], [450, 420], [50, 50]]) {
    const h = harness();
    h.drag('d', x, y); assert.deepEqual(h.lit(), [], `${x},${y}`);
    h.drop('d', x, y);
    assert.equal(h.changes.length, 1); const d = h.saved().d;
    assert.equal(d.parentId, 'root'); assert.equal(d.x, 400 + x - 410); assert.equal(d.y, 400 + y - 410);
    assert.equal(h.notes.length, 0);
  }
});

test('a descendant is not highlighted; dropping there puts the card back, writes nothing, and says why once', () => {
  const h = harness();
  h.drag('a', 850, 50);
  assert.deepEqual(h.lit(), []);
  h.drop('a', 850, 50);
  assert.equal(h.changes.length, 0); assert.deepEqual(h.notes, [CIRCULAR]);
  assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.cards.a.style.top, '0px');
});

test('a card that is merging stays put and cannot change parent', () => {
  const h = harness();
  h.view.mergeTasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: 'd', path: 'd.md' }], controller: new AbortController(), state: 'running' });
  h.drag('d', 450, 250); assert.deepEqual(h.lit(), []);
  h.drop('d', 450, 250);
  assert.equal(h.changes.length, 0); assert.deepEqual(h.notes, ['Merging; try again when it finishes']);
});

test('a target that is merging is refused with the existing Notice', () => {
  const h = harness();
  h.view.mergeTasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: 'b', path: 'b.md' }], controller: new AbortController(), state: 'running' });
  h.drag('d', 450, 250); h.drop('d', 450, 250);
  assert.equal(h.changes.length, 0); assert.deepEqual(h.notes, ['Merging; try again when it finishes']);
});

test('relevance sort keeps every card where it is', () => {
  const h = harness();
  h.view.relevanceSortOn = () => true; h.view.commitSelection = () => {}; // the drop falls through to a plain click
  h.drag('d', 450, 250); assert.deepEqual(h.lit(), []);
  h.drop('d', 450, 250);
  assert.equal(h.changes.length, 0);
});

test('a map that cannot select topics (AIM, read-only) never changes parent by drag', () => {
  const h = harness({ aim: true });
  h.drag('d', 450, 250); assert.deepEqual(h.lit(), []);
  h.drop('d', 450, 250);
  assert.equal(h.saved().d.parentId, 'root'); assert.equal(h.changes.length, 1, 'only the position is written');
});

test('protected AIM references refuse the move with the existing error and write nothing', () => {
  const h = harness();
  h.view.assertAimReferencesRemain = () => { throw new Error('AIM question and result nodes referenced by saved branches cannot be moved.'); };
  h.drag('d', 450, 250); h.drop('d', 450, 250);
  return Promise.resolve().then(() => {
    assert.equal(h.changes.length, 0);
    assert.deepEqual(h.errors, ['AIM question and result nodes referenced by saved branches cannot be moved.']);
  });
});

test('the highlight is removed on pointercancel and lostpointercapture, and nothing is written', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const h = harness();
    h.drag('d', 450, 250); assert.deepEqual(h.lit(), ['b']);
    h.fire('d', ending, 450, 250);
    assert.deepEqual(h.lit(), [], ending); assert.equal(h.changes.length, 0); assert.equal(h.cards.d.style.left, '400px');
  }
});

test('the highlight moves with the pointer and a drag onto the chat is still a reference', () => {
  const h = harness();
  h.drag('d', 450, 250); assert.deepEqual(h.lit(), ['b']);
  h.fire('d', 'pointermove', 450, 50); assert.deepEqual(h.lit(), ['a']);
  h.fire('d', 'pointermove', 6000, 0); assert.deepEqual(h.lit(), []);
  h.drop('d', 6000, 0);
  assert.equal(h.changes.length, 0); assert.deepEqual(h.references, ['d']);
});

test('a single-card drag keeps the picked cards picked', () => {
  const h = harness();
  h.view.multiSelected = new Set(['a']);
  h.drag('d', 450, 250); h.drop('d', 450, 250);
  assert.deepEqual([...h.view.multiSelected], ['a']);
});

test('group drag: dropping the picked branches on a card outside them moves them under it in one change', async () => {
  const h = harness();
  h.view.integrationMode = true; h.view.multiSelected = new Set(['a', 'c', 'b']);
  h.drag('a', 450, 450); assert.deepEqual(h.lit(), ['d']);
  h.drop('a', 450, 450);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.changes.length, 1);
  const after = h.saved();
  assert.equal(after.a.parentId, 'd'); assert.equal(after.b.parentId, 'd'); assert.equal(after.c.parentId, 'a', 'c travels inside a');
  assert.equal(h.view.multiSelected.size, 0, 'moving a group clears the selection, like Move to...');
});

test('group drag: a picked card or a descendant of one is refused with a Notice, nothing is written', () => {
  for (const [x, y] of [[450, 250], [850, 50]]) {
    const h = harness();
    h.view.integrationMode = true; h.view.multiSelected = new Set(['a', 'b']);
    h.drag('a', x, y); assert.deepEqual(h.lit(), [], `${x},${y}`);
    h.drop('a', x, y);
    assert.equal(h.changes.length, 0); assert.deepEqual(h.notes, [CIRCULAR]);
    assert.equal(h.cards.a.style.left, '400px'); assert.equal(h.cards.b.style.top, '200px');
  }
});

test('group drag: empty space still moves the whole group, and a timeline group may still drop on a card', () => {
  const h = harness();
  h.view.integrationMode = true; h.view.multiSelected = new Set(['a', 'b']);
  h.drag('a', 1500, 900); h.drop('a', 1500, 900);
  assert.equal(h.changes.length, 1); const after = h.saved();
  assert.equal(after.a.parentId, 'root'); assert.equal(after.a.x, 400 + 1500 - 410);
  const t = harness();
  t.doc.layout = { direction: 'timeline' };
  t.view.integrationMode = true; t.view.multiSelected = new Set(['a']);
  t.drag('a', 450, 450); t.drop('a', 450, 450);
  assert.equal(t.saved().a.parentId, 'd'); assert.deepEqual(t.notes, []);
});
