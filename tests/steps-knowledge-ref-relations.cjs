// P4.4 (F07b): a relation to a card of ANOTHER map needs a read-only knowledge reference in this map first.
// Red until implemented: sanitizer accepts an end that is a reference id of this map; chat add_relation refuses a card of
// another map (unknown_node: the model is never given such ids; the user references it first) and accepts a reference id; removing a reference removes its relations;
// Reference Links and the share file never carry a relation to a reference.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, load, obsidian } = require('./support.cjs');
const { load: loadStep } = require('./support-replay.cjs');

const mm = load('map-model.ts', { obsidian });
const kr = load('experiences/visual-map/knowledge-refs.ts', { obsidian });
const format = load('experiences/sharing/share-format.ts', { obsidian });
const { parseMapChat } = loadStep('core/steps/map-chat/step.ts');
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const node = (id, parentId = null) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0 });
const ref = (over = {}) => ({ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: 'c', x: 300, y: 0, pathHint: 'Mind Maps/Other/Map.md', ...over });
const rel = (from, to, kind = 'supports') => ({ kind, from, to });
const doc = (extra = {}) => ({ id: 'm1', title: 'Host', version: 1, nodes: [node('r'), node('c', 'r'), node('d', 'r')], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const parse = (map, logs = []) => mm.parseMap(mm.serializeMap(map), (level, message) => logs.push({ level, message }));

// ---- sanitizer ---------------------------------------------------------------------------------------------------------

test('P4.4 sanitizer: an end that is a reference id of this map is kept, either side, and the file round-trips byte for byte', () => {
  const map = doc({ knowledgeRefs: [ref()], topicRelations: [rel('c', 'ref-1'), rel('ref-1', 'd', 'related')] });
  const logs = [];
  const parsed = parse(map, logs);
  assert.deepEqual(plain(parsed.topicRelations), [rel('c', 'ref-1'), rel('ref-1', 'd', 'related')]);
  assert.deepEqual(logs, []);
  const text = mm.serializeMap(parsed);
  assert.equal(mm.serializeMap(mm.parseMap(text, () => {})), text);
});

test('P4.4 sanitizer: an id that is neither a card nor a reference of this map is still dropped (counts unchanged)', () => {
  const logs = [];
  const parsed = parse(doc({ knowledgeRefs: [ref()], topicRelations: [rel('c', 'ref-1'), rel('c', 'n1'), rel('c', 'ref-zzz'), rel('other:n1', 'd')] }), logs);
  assert.deepEqual(plain(parsed.topicRelations), [rel('c', 'ref-1')]);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /\b3\b/);
});

test('P4.4 sanitizer: a relation between two references is dropped', () => {
  const parsed = parse(doc({ knowledgeRefs: [ref(), ref({ id: 'ref-2', nodeId: 'n2' })], topicRelations: [rel('ref-1', 'ref-2'), rel('c', 'ref-2')] }));
  assert.deepEqual(plain(parsed.topicRelations), [rel('c', 'ref-2')]);
});

test('P4.4 sanitizer: a reference entry that is malformed or missing does not corrupt the file; its relation is dropped', () => {
  const bad = parse(doc({ knowledgeRefs: [{ id: 'ref-1' }], topicRelations: [rel('c', 'ref-1'), rel('c', 'd')] }));
  assert.deepEqual(plain(bad.topicRelations), [rel('c', 'd')]);
  const none = parse(doc({ topicRelations: [rel('c', 'ref-1')] }));
  assert.equal('topicRelations' in none, false);
});

test('P4.4 sanitizer: a reference whose parent card is gone stays in the file and so does its relation (kept, not drawn)', () => {
  const parsed = parse(doc({ knowledgeRefs: [ref({ parentId: 'gone' })], topicRelations: [rel('c', 'ref-1')] }));
  assert.deepEqual(plain(parsed.topicRelations), [rel('c', 'ref-1')]);
  assert.equal(kr.rawKnowledgeRefs(parsed).length, 1);
});

test('P4.4 removing a reference removes the relations that end at it, in the same step', () => {
  const map = parse(doc({ knowledgeRefs: [ref(), ref({ id: 'ref-2', nodeId: 'n2' })], topicRelations: [rel('c', 'ref-1'), rel('d', 'ref-2'), rel('c', 'd', 'related')] }));
  assert.equal(kr.removeKnowledgeRef(map, 'ref-1'), true);
  assert.deepEqual(plain(map.topicRelations), [rel('d', 'ref-2'), rel('c', 'd', 'related')]);
  kr.removeKnowledgeRef(map, 'ref-2');
  assert.deepEqual(plain(map.topicRelations), [rel('c', 'd', 'related')]);
});

// ---- map chat plan -----------------------------------------------------------------------------------------------------

const context = (extra = {}) => ({ nodeIds: ['r', 'c', 'd'], parents: { r: null, c: 'r', d: 'r' }, relations: [], ...extra });
const reply = (...actions) => JSON.stringify({ reply: 'ok', actions });
const addRel = (fromId, toId, relationKind = 'supports') => ({ kind: 'add_relation', fromId, toId, relationKind, description: '' });

test('P4.4 chat: add_relation to a card of another map (an id the context never offered) is refused as unknown_node, nothing is planned', () => {
  const result = plain(parseMapChat(reply(addRel('c', 'other-card')), context({ refIds: [] })));
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.rejected, [{ index: 0, code: 'unknown_node' }]);
});

test('P4.4 chat: add_relation to a reference id of this map is planned as written', () => {
  const result = plain(parseMapChat(reply(addRel('c', 'ref-1')), context({ refIds: ['ref-1'] })));
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.actions, [{ kind: 'add_relation', fromId: 'c', toId: 'ref-1', relationKind: 'supports' }]);
});

test('P4.4 chat: two references cannot be linked to each other', () => {
  const result = plain(parseMapChat(reply(addRel('ref-1', 'ref-2')), context({ refIds: ['ref-1', 'ref-2'] })));
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.rejected, [{ index: 0, code: 'relation_not_allowed' }]);
});

test('P4.4 chat: an unknown id stays unknown_node; a reference id is not accepted by the other actions', () => {
  const unknown = plain(parseMapChat(reply(addRel('c', 'zzz')), context({ refIds: ['ref-1'] })));
  assert.deepEqual(unknown.rejected, [{ index: 0, code: 'unknown_node' }]);
  const rename = plain(parseMapChat(reply({ kind: 'rename_topic', nodeId: 'ref-1', title: 'x' }), context({ refIds: ['ref-1'] })));
  assert.deepEqual(rename.rejected, [{ index: 0, code: 'unknown_node' }]);
});

test('P4.4 chat: remove_relation accepts a reference id end like add_relation; one the context did not send is unknown_node', () => {
  const have = context({ refIds: ['ref-1'], relations: [rel('c', 'ref-1')] });
  const removed = plain(parseMapChat(reply({ kind: 'remove_relation', fromId: 'c', toId: 'ref-1' }), have));
  assert.deepEqual(removed.rejected, []);
  assert.deepEqual(removed.actions, [{ kind: 'remove_relation', fromId: 'c', toId: 'ref-1' }]);
  const unsent = plain(parseMapChat(reply({ kind: 'remove_relation', fromId: 'c', toId: 'ref-1' }), context({ refIds: [], relations: [rel('c', 'ref-1')] })));
  assert.deepEqual(unsent.rejected, [{ index: 0, code: 'unknown_node' }]);
  const none = plain(parseMapChat(reply({ kind: 'remove_relation', fromId: 'd', toId: 'ref-1' }), have));
  assert.deepEqual(none.rejected, [{ index: 0, code: 'unknown_relation' }]);
});

// ---- context builder ---------------------------------------------------------------------------------------------------

test('P4.4 context: relations with a sent reference end are kept, one whose reference was not sent is filtered, AIM sends none', () => {
  const { buildMapChatContext } = load('core/map-chat-context.ts', { obsidian });
  const base = { mapTitle: 'M', outline: [{ id: 'c', title: 'C', summary: '', parentId: null, depth: 0 }, { id: 'd', title: 'D', summary: '', parentId: null, depth: 0 }], selected: [], references: [], snippets: [], files: [], activeFile: null, history: [] };
  const relations = [rel('c', 'ref-1'), rel('d', 'ref-2'), rel('c', 'd', 'related')];
  const parsed = input => JSON.parse(buildMapChatContext({ ...base, ...input }).json);
  const sent = parsed({ relations, knowledgeRefs: [{ id: 'ref-1' }] });
  assert.deepEqual(plain(sent.relations).map(link => `${link.from}>${link.to}`), ['c>ref-1', 'c>d']);
  assert.deepEqual(parsed({ relations }).relations.map(link => `${link.from}>${link.to}`), ['c>d'], 'no refs sent: the ref relation is filtered');
  const aim = parsed({ aim: true, relations, knowledgeRefs: [{ id: 'ref-1' }] });
  assert.equal('knowledgeRefs' in aim, false);
  assert.ok(!aim.relations || aim.relations.length === 0);
  assert.deepEqual(plain(buildMapChatContext({ ...base, knowledgeRefs: [{ id: 'ref-1' }, { id: 'ref-2' }] }).refIds), ['ref-1', 'ref-2']);
  assert.equal((buildMapChatContext({ ...base, aim: true, knowledgeRefs: [{ id: 'ref-1' }] }).refIds ?? []).length, 0);
});

// ---- Reference Links (notes) -------------------------------------------------------------------------------------------

test('P4.4 Reference Links: a relation that ends at a reference is kept in Map.md but writes no line in either note', async () => {
  const data = fixture('en');
  const mapPath = await data.repo.createMap('Cross');
  const map = await data.repo.readMap(mapPath);
  const a = await data.repo.createNote('Alpha', 'model-a', map, mapPath, 'workspace');
  a.parentId = null;
  map.nodes.push(a);
  map.knowledgeRefs = [ref({ parentId: a.id })];
  map.topicRelations = [rel(a.id, 'ref-1')];
  await data.repo.saveMap(mapPath, map);
  await data.repo.rebuildDerivedData();
  const again = await data.repo.readMap(mapPath);
  assert.deepEqual(plain(again.topicRelations), [rel(a.id, 'ref-1')], 'the relation survives a read');
  const note = data.contents.get(a.path);
  assert.doesNotMatch(note, /Supports:|ref-1|Mind Maps\/Other/, 'no relation line, no path of the other map');
});

// ---- share -------------------------------------------------------------------------------------------------------------

test('P4.4 share: a relation to a reference is not in the payload; relations between cards still are', () => {
  const map = doc({ knowledgeRefs: [ref()], topicRelations: [rel('c', 'ref-1'), rel('c', 'd', 'related')] });
  const notes = Object.fromEntries(['r', 'c', 'd'].map(id => [id, { title: id, summary: '', status: 'idea' }]));
  const payload = format.buildSharePayload(map, notes, { includeDetail: true, includeImages: false, language: 'en', vamVersion: '1', exportedAt: '2026-11-28T00:00:00Z' });
  assert.deepEqual(plain(payload.relations).map(r => [r.from, r.to]), [['c', 'd']]);
  assert.equal(JSON.stringify(payload).includes('"to":"ref-1"'), false);
});
