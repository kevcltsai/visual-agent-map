// Argument map arrangement (P7): the five layers, child order by role and stance, no overlap, stable. Pure; no UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const layout = S.load('core/argument-map/layout.ts');
const machine = S.load('core/argument-map/machine.ts');
const plain = value => JSON.parse(JSON.stringify(value));

const ROLES = { proposition: 'P', situation: 'S', conclusion: 'C', verified: 'V', eliminated: 'E' };
const node = (id, parentId, extra = {}) => ({ id, path: `${id}.md`, parentId, x: 999, y: 999, collapsed: false, ...extra });
const need = (id, state, stance) => ({ id, text: id, addedRound: 1, state, ...(stance ? { stance } : {}) });
const proof = { url: 'https://a.example/x', quote: 'q', claim: 'c', check: 'page_match', checkedAt: 'now' };
const found = (id, stance) => ({ ...need(id, 'found', stance), proof });

/** Hypotheses h1 (verified), h2 (verifying, mixed evidence), h3 (verifying), h4 (eliminated). */
function build(order = 'normal') {
  const state = plain(machine.newArgumentMap(ROLES, 'run-1'));
  state.situation.data = [
    { id: 'd-missing', need: 'm', attempts: 1, state: 'not_found' },
    { id: 'd-no', need: 'n', attempts: 1, state: 'found', stance: 'opposes', proof },
    { id: 'd-yes', need: 'y', attempts: 1, state: 'found', stance: 'supports', proof }
  ];
  state.hypotheses = [
    { id: 'h3', citedData: [], round: 1, location: 'verifying', needs: [found('n3a', 'supports'), need('n3b', 'pending')] },
    { id: 'h1', citedData: [], round: 1, location: 'verifying', aiVerdict: 'supported', needs: [found('n1a', 'uncertain'), found('n1b', 'contradicts'), found('n1c', 'supports')] },
    { id: 'h2', citedData: [], round: 2, location: 'verifying', needs: [need('n2a', 'not_found'), found('n2b', 'uncertain'), found('n2c', 'supports'), need('n2d', 'searching')] },
    { id: 'h4', citedData: [], round: 3, location: 'eliminated', eliminationReason: 'x', needs: [found('n4a', 'supports')] }
  ];
  const nodes = [
    node('P', null), node('S', 'P'), node('C', 'P'), node('V', 'C'), node('E', 'C'),
    node('h3', 'V'), node('h1', 'V'), node('h2', 'V'), node('h4', 'E'),
    node('n3b', 'h3'), node('n3a', 'h3'),
    node('n1a', 'h1'), node('n1b', 'h1'), node('n1c', 'h1'),
    node('n2d', 'h2'), node('n2a', 'h2'), node('n2b', 'h2'), node('n2c', 'h2'),
    node('n4a', 'h4'),
    node('d-missing', 'S'), node('d-no', 'S'), node('d-yes', 'S')
  ];
  if (order === 'reversed') nodes.reverse();
  return { state, nodes };
}
const HEIGHT = { P: 90, S: 110, C: 120, V: 80, E: 80, h1: 130, h2: 130, h3: 130, h4: 100 };
const heightOf = id => HEIGHT[id] ?? 70;
const run = (order, h = heightOf) => { const { state, nodes } = build(order); return { state, nodes, out: layout.arrangeArgumentMap(nodes, state, h) }; };
const at = (out, id) => out.find(n => n.id === id);
const childrenByY = (out, parentId) => out.filter(n => n.parentId === parentId).sort((a, b) => a.y - b.y).map(n => n.id);

test('siblings are ordered: situation above conclusion, verified above eliminated', () => {
  const { out } = run();
  assert.deepEqual(childrenByY(out, 'P'), ['S', 'C']);
  assert.deepEqual(childrenByY(out, 'C'), ['V', 'E']);
});
test('hypotheses: verified first, the others in the order they were proposed', () => {
  const { out } = run();
  assert.deepEqual(childrenByY(out, 'V'), ['h1', 'h3', 'h2']);
});
test('evidence is ordered supports, contradicts, uncertain, then the dashed missing ones (searching, pending, not found)', () => {
  const { out } = run();
  assert.deepEqual(childrenByY(out, 'h1'), ['n1c', 'n1b', 'n1a']);
  assert.deepEqual(childrenByY(out, 'h2'), ['n2c', 'n2b', 'n2d', 'n2a']);
  assert.deepEqual(childrenByY(out, 'h3'), ['n3a', 'n3b']);
});
test('situation data: supporting, opposing, then the missing one', () => {
  const { out } = run();
  assert.deepEqual(childrenByY(out, 'S'), ['d-yes', 'd-no', 'd-missing']);
});
test('five layers: each layer sits in its own column, left to right', () => {
  const { out } = run();
  const x = id => at(out, id).x;
  assert.equal(x('P') < x('S'), true);
  assert.equal(x('S'), x('C'));
  assert.equal(x('C') < x('V'), true);
  assert.equal(x('V'), x('E'));
  assert.equal(x('V') < x('h1'), true);
  assert.equal(x('h1'), x('h4'));
  assert.equal(x('h1') < x('n1a'), true);
  assert.equal(x('n1a'), x('n4a'));
  // The situation data share the hypotheses' column (layer 3 under situation).
  assert.equal(x('d-yes') > x('S'), true);
});
test('situation is above conclusion in the picture', () => {
  const { out } = run();
  assert.equal(at(out, 'S').y < at(out, 'C').y, true);
});
test('no two cards overlap, with real heights', () => {
  const { out } = run();
  const WIDTH = 280;
  for (const a of out) for (const b of out) {
    if (a.id >= b.id) continue;
    const apart = a.x + WIDTH <= b.x || b.x + WIDTH <= a.x || a.y + heightOf(a.id) <= b.y || b.y + heightOf(b.id) <= a.y;
    assert.equal(apart, true, `${a.id} overlaps ${b.id}`);
  }
});
test('stable: arranging twice, or from a shuffled array, gives the same positions', () => {
  const first = run().out;
  const again = layout.arrangeArgumentMap(first, build().state, heightOf);
  assert.deepEqual(plain(again), plain(first));
  const shuffled = run('reversed').out;
  const pos = list => Object.fromEntries(list.map(n => [n.id, [n.x, n.y]]));
  assert.deepEqual(pos(shuffled), pos(first));
});
test('positions only: ids, parents, order of the array and other fields come back as given', () => {
  const { nodes, out } = run();
  assert.deepEqual(out.map(n => n.id), nodes.map(n => n.id));
  for (const n of out) {
    const before = nodes.find(m => m.id === n.id);
    assert.equal(n.parentId, before.parentId);
    assert.equal(n.path, before.path);
  }
});
test("a card's own branch layout is ignored: the map is always arranged to the right", () => {
  const { state, nodes } = build();
  const a = layout.arrangeArgumentMap(nodes, state, heightOf);
  const b = layout.arrangeArgumentMap(nodes.map(n => (n.id === 'h1' ? { ...n, layout: { direction: 'down' } } : n)), state, heightOf);
  assert.deepEqual(plain(b.map(n => [n.x, n.y])), plain(a.map(n => [n.x, n.y])));
});
test('the ordinary arrange path is untouched: a map without argumentMap lays out exactly as before', () => {
  const ordinary = S.load('map-layout.ts');
  const list = [node('r', null), node('a', 'r'), node('b', 'r'), node('c', 'a')];
  const before = JSON.stringify(ordinary.arrangeMap(list, undefined, undefined, 'right'));
  layout.arrangeArgumentMap(build().nodes, build().state, heightOf);
  assert.equal(JSON.stringify(ordinary.arrangeMap(list, undefined, undefined, 'right')), before);
});

test('facet map: under the situation the definitions card comes first, then the facets in state order; data under a facet follow itemRank', () => {
  const state = plain(machine.newArgumentMap(ROLES, 'run-1'));
  state.situation.assumptions = { id: 'as', items: [{ label: 'a', value: 'b', reason: 'c' }] };
  state.situation.facets = ['f1', 'f2', 'f3'].map(id => ({ id, title: id, verdict: 'pending', reason: '', citedData: [], summary: '' }));
  state.situation.data = [
    { id: 'dm', need: 'm', attempts: 1, state: 'not_found', facetId: 'f1' },
    { id: 'do', need: 'o', attempts: 1, state: 'found', stance: 'opposes', proof, facetId: 'f1' },
    { id: 'ds', need: 's', attempts: 1, state: 'found', stance: 'supports', proof, facetId: 'f1' },
    { id: 'dx', need: 'x', attempts: 1, state: 'pending', facetId: 'f3' }
  ];
  const nodes = [node('P', null), node('S', 'P'), node('C', 'P'), node('V', 'C'), node('E', 'C'), node('f3', 'S'), node('f1', 'S'), node('f2', 'S'), node('as', 'S'), node('dm', 'f1'), node('do', 'f1'), node('ds', 'f1'), node('dx', 'f3')];
  for (const order of [nodes, [...nodes].reverse()]) {
    const ordered = layout.orderArgumentNodes(order, state);
    const kids = parent => ordered.filter(n => n.parentId === parent).map(n => n.id);
    assert.deepEqual(plain(kids('S')), ['as', 'f1', 'f2', 'f3']);
    assert.deepEqual(plain(kids('f1')), ['ds', 'do', 'dm']);
  }
  const arranged = layout.arrangeArgumentMap(nodes, state);
  const at = id => arranged.find(n => n.id === id);
  assert.ok(at('as').y < at('f1').y && at('f1').y < at('f2').y && at('f2').y < at('f3').y);
});
