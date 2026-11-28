const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLivingSources, readLivingReferences, sameLivingTarget, reconcileLivingDraftReferences } = require('./support.cjs').load('experiences/visual-map/living-node-sources.ts');
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

const { planLivingMap, introducesLivingCycle } = require('./support.cjs').load('experiences/visual-map/living-node-map.ts');
const asAi = (node, refs = []) => ({ ...node, aiCard: true, prompt: 'p', hasKnowledge: true, explicitRefs: refs });

test('map planning: unresolved required Markdown blocks dependent branch while optional context does not', () => {
  const cards = [asAi(nodes[0], [card('b')]), asAi(nodes[1]), asAi(nodes[2]), asAi(nodes[3], [note('missing')])];
  const result = planLivingMap(cards, ['optionalMissing'], port);
  assert.equal(result.plan.blocked.get('b'), 'missing-source');
  assert.equal(result.plan.blocked.get('root'), 'dependency-blocked');
  assert.deepEqual(plain(result.plan.order.map(x => x.id)), ['grandchild', 'a']);
  assert.equal(result.sources.get('a').failures[0].required, false);
});

test('map planning: same-map Markdown alias participates in cycle detection', () => {
  const cards = [asAi(nodes[0], [note('B')]), asAi(nodes[1]), asAi(nodes[2]), asAi(nodes[3], [note('rootAlias')])];
  const result = planLivingMap(cards, [], port);
  assert.equal(result.plan.blocked.get('root'), 'cycle');
  assert.equal(result.plan.blocked.get('b'), 'cycle');
  assert.deepEqual(plain(result.plan.order.map(x => x.id)), ['grandchild', 'a']);
});

test('source metadata: only absent persisted references permit legacy fallback; corrupt values fail closed', () => {
  assert.deepEqual(plain(readLivingReferences(undefined, ['B'])), [note('B')]);
  assert.deepEqual(plain(readLivingReferences([], ['B'])), []);
  assert.deepEqual(plain(readLivingReferences(null, [])), []);
  assert.deepEqual(plain(readLivingReferences(['card:b', 'note:external'], ['A'])), [card('b'), note('external')]);
  for (const malformed of [null, 'card:b', {}, [42], ['card:'], ['note:  '], ['unknown:b']])
    assert.throws(() => readLivingReferences(malformed, ['B']), /invalid-source-reference/);
});

test('target snapshot: parent, path, identity and existence must remain stable; root null and omitted are equivalent', () => {
  const before = { id: 'a', path: 'a.md', parentId: 'root' };
  assert.equal(sameLivingTarget(before, { ...before }), true);
  assert.equal(sameLivingTarget(before, { ...before, parentId: 'b' }), false);
  assert.equal(sameLivingTarget(before, { ...before, parentId: null }), false);
  assert.equal(sameLivingTarget(before, { ...before, path: 'new.md' }), false);
  assert.equal(sameLivingTarget(before, { ...before, id: 'b' }), false);
  assert.equal(sameLivingTarget(before, undefined), false);
  assert.equal(sameLivingTarget({ id: 'a', path: 'a.md' }, { id: 'a', path: 'a.md', parentId: null }), true);
});

test('source resolution: copied foreign references remain missing even with a matching malformed ID in the destination', () => {
  const foreign = 'foreign:' + JSON.stringify(['old-map', 'b']);
  const result = resolve([card(foreign)], [], [...nodes, { id: foreign, path: 'other.md' }]);
  assert.equal(result.sources.some(s => s.cardId === foreign), false);
  assert.equal(result.failures[0].reason, 'missing-or-unauthorized');
  assert.equal(result.failures[0].required, true);
});

test('structural graph: moving an AI card under a consumer of its explicit reference would close a cycle', () => {
  const before = [asAi({ id: 'a', path: 'a.md' }, [card('b')]), asAi({ id: 'b', path: 'b.md' })];
  const after = before.map(n => n.id === 'a' ? { ...n, parentId: 'b' } : n);
  assert.equal(introducesLivingCycle(before, after, port), true);
  assert.equal(introducesLivingCycle(after, before, port), false, 'repair is permitted');
  assert.equal(introducesLivingCycle(after, [...after, asAi({ id: 'unrelated', path: 'u.md' })], port), false);
});

test('structural graph: a new cycle within previously blocked nodes is refused; locks do not hide cycles', () => {
  const before = [asAi({ id: 'a', path: 'a.md' }, [card('b')]),
    { ...asAi({ id: 'b', path: 'b.md' }, [card('a')]), aiLocked: true },
    asAi({ id: 'c', path: 'c.md' }, [card('a')])];
  const after = before.map(n => n.id === 'c' ? { ...n, parentId: 'b' } : n);
  assert.equal(introducesLivingCycle(before, after, port), true);
  assert.equal(introducesLivingCycle(before, before, port), false);
  const ordinary = after.map(n => n.id === 'c' ? { ...n, aiCard: false } : n);
  assert.equal(introducesLivingCycle(before, ordinary, port), false);
});

test('draft source edits preserve persisted identity rather than rebinding an unchanged display name', () => {
  const resolveNew = link => card('new:' + link);
  assert.deepEqual(plain(reconcileLivingDraftReferences(['Renamed', 'B'], [card('old'), card('b')], ['Renamed', 'B'], resolveNew)), [card('old'), card('b')]);
  assert.deepEqual(plain(reconcileLivingDraftReferences(['Renamed', 'B'], [card('old'), card('b')], ['B', 'Renamed', 'C'], resolveNew)), [card('b'), card('old'), card('new:C')]);
  assert.deepEqual(plain(reconcileLivingDraftReferences(['A'], [card('old')], [], resolveNew)), []);
  assert.deepEqual(plain(reconcileLivingDraftReferences(['A'], [card('old')], ['C'], resolveNew)), [card('new:C')]);
  assert.deepEqual(plain(reconcileLivingDraftReferences(['A', 'Alias'], [card('old')], ['A', 'Alias'], resolveNew)), [card('old')]);
  assert.throws(() => reconcileLivingDraftReferences(['A', 'Alias'], [card('old')], ['A', 'C'], resolveNew), /ambiguous-saved-references/);
});


test('canonical source references request exact path resolution, never legacy alias fallback', () => {
  const refs = readLivingReferences(['note-path:folder/source.md'], []);
  assert.deepEqual(plain(refs), [{ kind: 'note', link: 'folder/source.md', exact: true }]);
  const calls = [];
  const result = resolveLivingSources(nodes, 'root', refs, [], {
    resolveAuthorized(link, from, role, exact) {
      calls.push([link, from, role, exact]);
      return exact ? undefined : { identity: 'other/source.md', path: 'other/source.md' };
    }
  });
  assert.deepEqual(calls, [['folder/source.md', 'root.md', 'explicit', true]]);
  assert.equal(result.failures[0].reason, 'missing-or-unauthorized');
});

test('canonical source rename changes exact paths, retains card IDs, legacy aliases and invalid lists', () => {
  const { rebaseLivingNoteReferences } = require('./support.cjs').load('core/living-node-region.ts');
  const change = path => path === 'A.md' ? 'B.md' : path;
  assert.deepEqual(plain(rebaseLivingNoteReferences(['note-path:A.md', 'card:A.md', 'note:A.md'], change)),
    ['note-path:B.md', 'card:A.md', 'note:A.md']);
  assert.equal(rebaseLivingNoteReferences(['note-path:Other.md'], change), null);
  assert.equal(rebaseLivingNoteReferences([42, 'note-path:A.md'], change), null);
});

test('A05: a deleted source card leaves a blocking dangling ID that resolves again when the same ID returns; a same-name card never substitutes', () => {
  const withoutB = nodes.filter(n => n.id !== 'b');
  const gone = resolve([card('b')], [], withoutB);
  assert.deepEqual(plain(gone.failures.map(f => [f.reason, f.required])), [['missing-or-unauthorized', true]]);
  assert.equal(gone.sources.some(s => s.cardId === 'b'), false);
  const lookalike = resolve([card('b')], [], [...withoutB, { id: 'b2', path: 'b.md' }]);
  assert.equal(lookalike.failures[0].reason, 'missing-or-unauthorized');
  assert.equal(lookalike.sources.some(s => s.cardId === 'b2'), false);
  const restored = resolve([card('b')]);
  assert.equal(restored.failures.length, 0);
  assert.deepEqual(plain(restored.dependencyIds), ['a', 'b']);
});

test('D2-4 dependency highlight: a plain card that is both a child and an explicit ref is read once', () => {
  const { livingDependencyGraph, livingHighlight } = require('./support.cjs').load('experiences/visual-map/living-node-map.ts');
  const n = (id, parentId, refs) => ({ id, path: `${id}.md`, parentId, ...(refs ? { aiCard: true, prompt: 'p', hasKnowledge: true, explicitRefs: refs } : { hasKnowledge: false, explicitRefs: [] }) });
  const cards = [n('A', null, [card('O'), { kind: 'note', link: 'O' }]), n('O', 'A')];
  const portWithO = { resolveAuthorized: link => (link === 'O' ? { identity: 'O.md', path: 'O.md' } : port.resolveAuthorized(link)) };
  const graph = livingDependencyGraph(cards, planLivingMap(cards, [], portWithO));
  assert.deepEqual(plain(livingHighlight(graph, 'A').read.map(([c, d]) => `${c}>${d}`)), ['A>O']);
});

test('D2-4 dependency highlight: the planner\'s own edges (diamond once, explicit AI refs), plain cards as read, locked deps not expanded, cycles empty', () => {
  const { planLivingNodes } = require('./support.cjs').load('experiences/visual-map/living-node-plan.ts');
  const { livingDependencyGraph, livingHighlight } = require('./support.cjs').load('experiences/visual-map/living-node-map.ts');
  const n = (id, parentId, refs, extra = {}) => ({ id, path: `${id}.md`, parentId, ...(refs ? { aiCard: true, prompt: 'p', hasKnowledge: true, explicitRefs: refs } : { hasKnowledge: false, explicitRefs: [] }), ...extra });
  const cards = [
    n('A', null, [card('E'), card('P'), card('L')]), n('B', 'A', [card('D')]), n('C', 'A', []), n('O', 'A'), n('D', 'C', []),
    n('E', null, []), n('P', null), n('L', null, [], { aiLocked: true }), n('M', 'L', []),
    n('X', null, [card('Y')]), n('Y', null, [card('X')])
  ];
  const planned = planLivingMap(cards, [], port);
  const graph = livingDependencyGraph(cards, planned);
  const pairs = list => plain(list.map(([c, d]) => `${c}>${d}`).sort());
  const a = livingHighlight(graph, 'A');
  // Run pairs are exactly the planner's dependencies when A alone is requested.
  const nodesForPlan = cards.map(card => card.aiCard ? { ...card, explicitCardIds: planned.sources.get(card.id)?.dependencyIds ?? [] } : card);
  const expected = [...planLivingNodes(nodesForPlan, ['A']).dependencies].flatMap(([c, deps]) => deps.map(d => [c, d]));
  assert.deepEqual(pairs(a.run), pairs(expected));
  assert.deepEqual(pairs(a.run), ['A>B', 'A>C', 'A>E', 'A>L', 'B>D', 'C>D']);
  assert.deepEqual(pairs(a.read), ['A>O', 'A>P'], 'plain child and plain explicit ref are read-only');
  assert.deepEqual(pairs(livingHighlight(graph, 'C').run), ['C>D']);
  assert.deepEqual(pairs(livingHighlight(graph, 'L').run), [], 'a locked card is not expanded');
  for (const id of ['X', 'Y', 'O', 'P', 'missing']) {
    const h = livingHighlight(graph, id);
    assert.equal(h.run.length + h.read.length, 0, id);
  }
});
