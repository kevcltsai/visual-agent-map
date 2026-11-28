// P4.7 impact: pure, read only, this map only. Direct (wired) and speculative (text match) stay apart.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const impact = load('core/map-impact.ts');

const card = (id, title, parentId = null, summary = '') => ({ id, title, parentId, summary });
const cards = [
  card('t', 'Target audience'),
  card('c1', 'Pricing', 't'),
  card('c2', 'Channels', 'c1'),
  card('r', 'Linked'),
  card('l', 'Living summary'),
  card('m', 'Brand voice', null, 'Written for the same Target audience'),
  card('o', 'Unrelated')
];
const build = (extra = {}) => impact.buildImpact({ targetId: 't', cards, relations: [], livingConsumerIds: [], refs: [], ...extra });
const ids = list => JSON.parse(JSON.stringify(list.map(item => item.nodeId)));
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

test('F09 impact: direct = relations (either end), the whole subtree, Living consumers and reference cards; speculative = text mentions only', () => {
  const result = build({
    relations: [{ kind: 'premise', from: 'r', to: 't' }, { kind: 'cause', from: 't', to: 'o' }, { from: 'o', to: 'm' }],
    livingConsumerIds: ['l'],
    refs: [{ id: 'ref-1', parentId: 't', title: 'Original' }, { id: 'ref-2', parentId: 'c1' }]
  });
  assert.equal(result.state, 'items');
  assert.deepEqual(ids(result.direct), ['r', 'o', 'c1', 'c2', 'l', 't']);
  same(result.direct.map(item => item.kinds), [['relation'], ['relation'], ['descendant'], ['descendant'], ['living'], ['reference']]);
  const ref = result.direct.at(-1); assert.equal(ref.refId, 'ref-1'); assert.equal(ref.title, 'Original');
  assert.deepEqual(ids(result.speculative), ['m']);
  assert.equal(result.speculative[0].matched, 'Target audience'); same(result.speculative[0].kinds, []);
  assert.ok(result.direct.every(item => item.section === 'direct') && result.speculative.every(item => item.section === 'speculative'));
});

test('F09 impact: a card that is direct is never also speculative; a card with several links appears once with all its kinds', () => {
  const result = build({ relations: [{ from: 'c1', to: 't' }], livingConsumerIds: ['c1', 'm'] });
  same(result.direct.find(item => item.nodeId === 'c1').kinds, ['relation', 'descendant', 'living']);
  assert.deepEqual(ids(result.speculative), [], 'm names the target but is a Living consumer: already direct');
  assert.equal(ids(result.direct).filter(id => id === 'c1').length, 1);
});

test('F09 impact: self relations, a parent cycle, dangling ids and a one-letter title never loop, repeat or match', () => {
  const loop = [card('t', 'Target audience', 'c2'), card('c1', 'A', 't'), card('c2', 'B', 'c1')];
  const result = impact.buildImpact({ targetId: 't', cards: loop, relations: [{ from: 't', to: 't' }, { from: 't', to: 'ghost' }], livingConsumerIds: ['t', 'ghost'], refs: [] });
  assert.deepEqual(ids(result.direct), ['c1', 'c2'], 'the target itself and ghosts are left out; the loop ends');
  const short = impact.buildImpact({ targetId: 'a', cards: [card('a', 'A'), card('b', 'A big plan')], relations: [], livingConsumerIds: [], refs: [] });
  assert.equal(short.state, 'empty'); same(short.speculative, []);
});

test('F09 impact: a deleted target is missing, a lone card is empty, and long lists are capped with the rest counted', () => {
  assert.equal(impact.buildImpact({ targetId: 'gone', cards, relations: [], livingConsumerIds: [], refs: [] }).state, 'missing');
  assert.equal(build().state, 'items', 'm mentions it');
  assert.equal(impact.buildImpact({ targetId: 'o', cards, relations: [], livingConsumerIds: [], refs: [] }).state, 'empty');
  const many = [card('t', 'Root topic'), ...Array.from({ length: 35 }, (_, i) => card(`k${i}`, `Kid ${i}`, 't'))];
  const capped = impact.buildImpact({ targetId: 't', cards: many, relations: [], livingConsumerIds: [], refs: [] });
  assert.equal(capped.direct.length, impact.IMPACT_LIST_LIMIT); assert.equal(capped.hidden.direct, 5);
});

test('F09 impact: zero writes, no other map: the input is not changed and the module has no I/O imports', () => {
  const input = { targetId: 't', cards: JSON.parse(JSON.stringify(cards)), relations: [{ from: 'r', to: 't' }], livingConsumerIds: ['l'], refs: [{ id: 'x', parentId: 't' }] };
  const before = JSON.stringify(input); impact.buildImpact(input); assert.equal(JSON.stringify(input), before);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'core', 'map-impact.ts'), 'utf8');
  assert.ok(!/^import /m.test(source), 'no import: no vault, no provider, no other map');
});
