const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLivingSources } = require('./support.cjs').load('experiences/visual-map/living-node-sources.ts');
const nodes = [
  { id: 'root', path: 'root.md' }, { id: 'a', path: 'a.md', parentId: 'root' },
  { id: 'grandchild', path: 'grandchild.md', parentId: 'a' }, { id: 'b', path: 'b.md' }
];
const card = id => ({ kind: 'card', id });
const note = link => ({ kind: 'note', link });
const authorized = { A: { identity: 'a.md', path: 'a.md' }, B: { identity: 'b.md', path: 'b.md' },
  rootAlias: { identity: 'root.md', path: 'root.md' }, external: { identity: 'other/x.md', path: 'other/x.md' },
  externalAlias: { identity: 'other/x.md', path: 'other/x.md' } };
const port = { resolveAuthorized: link => authorized[link] };
const plain = x => JSON.parse(JSON.stringify(x));
const resolve = (explicit = [], mapLinks = [], items = nodes) => resolveLivingSources(items, 'root', explicit, mapLinks, port);

test('source resolution: direct children only and explicit same-map aliases deduplicate by stable identity', () => {
  const result = resolve([card('a'), note('A'), note('B'), note('external'), note('externalAlias')], ['A']);
  assert.deepEqual(plain(result.dependencyIds), ['a', 'b']);
  assert.deepEqual(plain(result.sources.map(s => [s.identity, s.roles])), [
    ['card:a', ['child', 'explicit', 'map']], ['card:b', ['explicit']], ['note:other/x.md', ['explicit']]
  ]);
  assert.equal(result.failures.length, 0);
});

test('source resolution: map-only same-map card and cross-map Markdown are not execution edges', () => {
  const result = resolve([], ['B', 'external']);
  assert.deepEqual(plain(result.dependencyIds), ['a']);
  assert.deepEqual(plain(result.sources.map(s => s.identity)), ['card:a', 'card:b', 'note:other/x.md']);
});

test('source resolution: dangling card IDs, self aliases and explicit missing notes remain blocking', () => {
  const result = resolve([card('deleted-id'), card('root'), note('rootAlias'), note('missing')], ['optionalMissing']);
  assert.deepEqual(plain(result.failures.map(f => [f.reason, f.required])), [
    ['missing-or-unauthorized', true], ['self-reference', true], ['self-reference', true],
    ['missing-or-unauthorized', true], ['missing-or-unauthorized', false]
  ]);
});

test('source resolution: renaming a referenced card preserves identity without guessing by name', () => {
  const moved = nodes.map(n => n.id === 'b' ? { ...n, path: 'renamed.md' } : n);
  const result = resolve([card('b')], [], moved);
  assert.equal(result.sources.find(s => s.identity === 'card:b').path, 'renamed.md');
  assert.equal(result.failures.length, 0);
});

test('source resolution: ambiguous path alias is refused', () => {
  const result = resolve([note('B')], [], [...nodes, { id: 'duplicate', path: 'b.md' }]);
  assert.equal(result.failures[0].reason, 'ambiguous');
  assert.equal(result.failures[0].required, true);
});
