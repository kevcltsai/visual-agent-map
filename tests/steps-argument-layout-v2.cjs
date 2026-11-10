// Version 2 argument map arrangement (packet V7): child order by role and state, no overlap, positions only, stable. Pure; no UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const layout = S.load('core/argument-map/layout-v2.ts');
const { cardsOverlapAny } = S.load('map-layout.ts');
const { v2State } = require('./fixtures/argument-map-v2-state.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

const node = (id, parentId, extra = {}) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed: false, ...extra });
const datum = (id, state, stance) => ({ id, need: id, attempts: 1, state, ...(stance ? { stance } : {}) });
const need = (id, state, stance) => ({ id, predictionId: 'pr1', text: id, criteria: { supports: 'a', refutes: 'b', irrelevant: 'c' }, registered: 'pre', addedRound: 1, state, ...(state === 'found' ? { assessment: { relevant: true, stance, scopeFit: true, scopeNote: '', sourceType: 's', underlyingSource: 'u', alsoRelevantTo: [] } } : {}) });

/** The tree of the fixture; the hypothesis is listed before the comparison card and the evidence is saved in the worst order. */
function build() {
  const state = plain(v2State());
  state.claims[0].data = [datum('d-pending', 'pending'), datum('d-no', 'found', 'opposes'), datum('d1', 'found', 'supports'), datum('d-miss', 'not_found')];
  state.hypotheses[0].needs = [need('n-miss', 'not_found'), need('n-ref', 'found', 'refutes'), need('n-sup', 'found', 'supports'), need('n-search', 'searching')];
  const nodes = [
    node('p', null), node('c', 'p'), node('pr', 'p'),
    node('q2', 'c'), node('h1', 'q2'), node('cmp', 'q2'),
    node('n-miss', 'h1'), node('n-ref', 'h1'), node('n-sup', 'h1'), node('n-search', 'h1'),
    node('q1', 'pr'), node('d-pending', 'q1'), node('d-no', 'q1'), node('d1', 'q1'), node('d-miss', 'q1')
  ];
  return { state, nodes };
}
const arranged = () => { const { state, nodes } = build(); return { state, nodes, out: layout.arrangeArgumentMapV2(nodes, state) }; };
const at = (out, id) => out.find(n => n.id === id);
const childrenByY = (out, parent) => out.filter(n => n.parentId === parent).sort((a, b) => a.y - b.y).map(n => n.id);

test('the premises group comes before the conclusion; the comparison card comes before the hypotheses', () => {
  const { out } = arranged();
  assert.deepEqual(childrenByY(out, 'p'), ['pr', 'c']);
  assert.deepEqual(childrenByY(out, 'q2'), ['cmp', 'h1']);
});

test('evidence order: supports, refutes, then the dashed missing ones (searching before not found)', () => {
  const { out } = arranged();
  assert.deepEqual(childrenByY(out, 'h1'), ['n-sup', 'n-ref', 'n-search', 'n-miss']);
});

test('premise data order: supports, opposes, then pending, then not found', () => {
  const { out } = arranged();
  assert.deepEqual(childrenByY(out, 'q1'), ['d1', 'd-no', 'd-pending', 'd-miss']);
});

test('the map grows to the right: each child sits to the right of its parent', () => {
  const { out, nodes } = arranged();
  for (const n of nodes) if (n.parentId) assert.ok(at(out, n.id).x > at(out, n.parentId).x, `${n.id} right of ${n.parentId}`);
});

test('no two cards overlap, with the default and with tall measured heights', () => {
  const { state, nodes, out } = arranged();
  const all = new Set(nodes.map(n => n.id));
  assert.equal(cardsOverlapAny(out, all), false);
  const tall = id => (id.startsWith('n-') ? 420 : 160);
  assert.equal(cardsOverlapAny(layout.arrangeArgumentMapV2(nodes, state, tall), all, tall), false);
});

test('positions only: ids, parents, other fields and array order stay; the input is not changed; a stored branch layout is ignored', () => {
  const { state, nodes } = build();
  nodes[0].layout = 'down';
  nodes[0].customField = 'keep';
  const before = plain(nodes);
  const out = layout.arrangeArgumentMapV2(nodes, state);
  assert.deepEqual(plain(nodes), before, 'input untouched');
  assert.deepEqual(out.map(n => n.id), nodes.map(n => n.id));
  assert.deepEqual(out.map(n => n.parentId), nodes.map(n => n.parentId));
  assert.equal(out[0].layout, 'down');
  assert.equal(out[0].customField, 'keep');
  const plainOut = layout.arrangeArgumentMapV2(nodes.map(n => ({ ...n, layout: undefined })), state);
  assert.deepEqual(out.map(n => [n.x, n.y]), plainOut.map(n => [n.x, n.y]), 'layout field does not change the result');
});

test('stable: arranging twice gives the same positions', () => {
  const { state, out } = arranged();
  const again = layout.arrangeArgumentMapV2(out, state);
  assert.deepEqual(again.map(n => [n.x, n.y]), out.map(n => [n.x, n.y]));
});

test('counterexample: a node the flow does not know keeps its saved place among its siblings; hidden cards stay where they are', () => {
  const { state, nodes } = build();
  nodes.push(node('stray', 'c', { x: 7, y: 7 }));
  const out = layout.arrangeArgumentMapV2(nodes, state, undefined, { hidden: new Set(['stray']) });
  assert.deepEqual([at(out, 'stray').x, at(out, 'stray').y], [7, 7]);
  assert.ok(out.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('counterexample: a premise that failed does not move anything else (the order is the state order, not a result)', () => {
  const { state, nodes } = build();
  const base = layout.arrangeArgumentMapV2(nodes, state);
  state.claims[0].result = 'fails';
  state.claims[1].status = 'not_evaluated';
  const out = layout.arrangeArgumentMapV2(nodes, state);
  assert.deepEqual(out.map(n => [n.x, n.y]), base.map(n => [n.x, n.y]));
});

test('arrangeUnarrangedArgumentMapV2: stacked cards are arranged once; an arranged map is left alone', () => {
  const { state, nodes } = build();
  const first = layout.arrangeUnarrangedArgumentMapV2(nodes, state);
  assert.ok(first, 'stacked at 0,0 needs arranging');
  assert.equal(layout.arrangeUnarrangedArgumentMapV2(first, state), null);
});
