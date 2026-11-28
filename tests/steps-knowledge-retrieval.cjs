// P4.1 retrieval, exact step: the in-memory index of authorised cards, when it is dropped, how a message is split into words and
// ranked, and that found cards reach the chat context marked "AI found" and read again at send time. Meaning-ranking is not here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, load, core, obsidian, DEFAULT_SETTINGS, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;

const retrieval = load('experiences/visual-map/knowledge-retrieval.ts', { obsidian });
const corpus = load('experiences/visual-map/cross-map-corpus.ts', { obsidian });
const { buildMapChatContext } = load('core/map-chat-context.ts');
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function fakeIo(spec, state = {}) {
  const nodePath = (mapPath, id) => `${mapPath.replace('/Map.md', '')}/${id}.md`;
  const io = {
    loads: 0,
    mapPaths: async () => { io.loads++; if (state.hold) await state.hold; return state.marked ?? Object.keys(spec); },
    readMap: async p => { const m = spec[p]; return m ? { id: m.id, title: m.title, nodes: m.nodes.map(n => ({ id: n.id, path: nodePath(p, n.id) })) } : null; },
    noteFrontmatter: async p => { for (const [mp, m] of Object.entries(spec)) for (const n of m.nodes) if (nodePath(mp, n.id) === p) return n.fm ?? { 'agent-map-node': true }; return null; },
    readNote: async p => { for (const [mp, m] of Object.entries(spec)) for (const n of m.nodes) if (nodePath(mp, n.id) === p) return { title: n.title, summary: '', detail: n.body ?? '' }; return null; }
  };
  return io;
}
const SPEC = () => ({
  'Maps/A/Map.md': { id: 'map-a', title: 'Alpha', nodes: [{ id: 'a1', title: 'Pricing strategy', body: 'subscription tiers and discounts' }, { id: 'a2', title: '定價心理學', body: '行為經濟學的錨定效應' }, { id: 'a3', title: 'Archived pricing', body: 'pricing tiers', fm: { 'agent-map-node': true, 'topic-state': 'archived' } }] },
  'Maps/B/Map.md': { id: 'map-b', title: 'Beta', nodes: [{ id: 'b1', title: 'Competitor tiers', body: 'pricing table of rivals' }, { id: 'b2', title: 'Cooking', body: 'soup' }] },
  'Maps/C/Map.md': { id: 'map-c', title: 'Unmarked', nodes: [{ id: 'c1', title: 'Secret pricing tiers', body: 'pricing tiers' }] }
});
const NONE = { mapId: 'host', keys: new Set() };

// ---- the words and the ranking ----------------------------------------------------------------------------------------------

test('words: Latin words of 3+ letters (no stop words), Han characters in neighbouring pairs, folded, no repeats', () => {
  same(retrieval.queryTokens('The Pricing of an ox, pricing!'), ['pricing']);
  same(retrieval.queryTokens('定價心理學'), [...new Set(['定價', '價心', '心理', '理學'].map(corpus.foldSearchText))]);
  same(retrieval.queryTokens('我 a b 好'), [], 'a lone Han character and short Latin words are not looked up');
  assert.ok(retrieval.queryTokens(Array.from({ length: 300 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0))}`).join(' ')).length <= 64, 'a pasted page is capped');
  assert.equal(corpus.foldSearchText('定價'), retrieval.queryTokens('定價 ')[0], 'Traditional and Simplified fold to one token');
});

test('ranking: more hits first (title and text count separately), ties keep corpus order, at most five, own map and skipped cards left out', async () => {
  const cards = await corpus.loadAuthorizedCards(fakeIo(SPEC(), { marked: ['Maps/A/Map.md', 'Maps/B/Map.md'] }), new AbortController().signal);
  const found = retrieval.findCards(cards, 'pricing tiers', NONE);
  same(found.map(c => c.nodeId), ['a1', 'b1'], 'both have two hits (title + text of the other word): corpus order; cooking has no hit');
  same(retrieval.findCards(cards, 'tiers table', NONE).map(c => c.nodeId), ['b1', 'a1'], 'b1: tiers in title and table in text; a1: tiers in text only');
  same(retrieval.findCards(cards, 'pricing tiers', { mapId: 'map-a', keys: new Set() }).map(c => c.nodeId), ['b1'], "the talked-to map's own cards are not 'other' cards");
  same(retrieval.findCards(cards, 'pricing tiers', { mapId: 'x', keys: new Set(['map-b\u0000b1']) }).map(c => c.nodeId), ['a1'], 'a card the user added is not found again');
  same(retrieval.findCards(cards, '定價 經濟', NONE).map(c => c.nodeId), ['a2']);
  same(retrieval.findCards(cards, 'ok', NONE), [], 'a message without words finds nothing');
  const many = Array.from({ length: 9 }, (_, i) => ({ mapId: `m${i}`, nodeId: `n${i}`, foldedTitle: 'tiers', foldedBody: '' }));
  same(retrieval.findCards(many, 'tiers', NONE).map(c => c.nodeId), ['n0', 'n1', 'n2', 'n3', 'n4']);
});

// ---- the index --------------------------------------------------------------------------------------------------------------

test('index: only authorised cards (marked map, not archived) are in it; it is read once and kept until invalidated', async () => {
  const io = fakeIo(SPEC(), { marked: ['Maps/A/Map.md', 'Maps/B/Map.md'] });
  const index = new retrieval.KnowledgeIndex(() => io);
  const cards = await index.get();
  same(cards.map(c => c.nodeId).sort(), ['a1', 'a2', 'b1', 'b2'], 'no unmarked map card, no archived card');
  for (const card of cards) { assert.equal(/Secret|Archived/.test(card.title + card.foldedBody), false); }
  await index.get(); await index.get();
  assert.equal(io.loads, 1, 'one read for any number of messages');
  index.invalidate(); await index.get();
  assert.equal(io.loads, 2, 'a dropped index is read again, on the next use (no watcher reads by itself)');
});

test('index: a rename, a delete and a revoked marker show in the next result; a build dropped while it runs is not kept', async () => {
  const spec = SPEC(); const state = { marked: ['Maps/A/Map.md', 'Maps/B/Map.md'] };
  const index = new retrieval.KnowledgeIndex(() => fakeIo(spec, state));
  const ids = async () => retrieval.findCards(await index.get(), 'pricing tiers', NONE).map(c => c.nodeId);
  same(await ids(), ['a1', 'b1']);
  spec['Maps/A/Map.md'].nodes[0].title = 'Plans'; index.invalidate();
  same(await ids(), ['b1', 'a1'], 'renamed: a1 lost "pricing" in its title, so it ranks lower');
  spec['Maps/A/Map.md'].nodes.shift(); index.invalidate();
  same(await ids(), ['b1'], 'deleted');
  state.marked = ['Maps/A/Map.md']; index.invalidate();
  same(await ids(), [], 'the marker of map B was revoked');
  let release; state.hold = new Promise(r => { release = r; }); state.marked = ['Maps/A/Map.md', 'Maps/B/Map.md'];
  const pending = index.get(); await tick();
  state.marked = ['Maps/A/Map.md']; state.hold = null; index.invalidate(); release();
  same((await pending).map(c => c.nodeId).sort(), ['a2'], 'the waiting caller gets the rebuilt index, not the stale one');
});

// ---- the chat context --------------------------------------------------------------------------------------------------------

const ctxInput = (extra = {}) => ({ mapTitle: 'Map', outline: [{ id: 'n1', title: 'Root', summary: '', parentId: null, depth: 0 }], selected: [], references: [], snippets: [], files: [], history: [], ...extra });

test('context: found cards carry foundByAi and their own fixed note; user-added cards and no cards give what they gave before', () => {
  const card = extra => ({ mapTitle: 'Other', title: 'T', summary: '', detail: 'body', notePath: 'Maps/O/T.md', ...extra });
  assert.equal(buildMapChatContext(ctxInput({ otherMapCards: [] })).json, buildMapChatContext(ctxInput()).json, 'no candidates: same bytes');
  const added = JSON.parse(buildMapChatContext(ctxInput({ otherMapCards: [card()] })).json);
  assert.equal('foundByAi' in added.otherMapCards[0], false); assert.equal('otherMapCardsFoundNote' in added, false);
  const ctx = buildMapChatContext(ctxInput({ otherMapCards: [card({ foundByAi: true }), card({ title: 'U' })] }));
  const sent = JSON.parse(ctx.json);
  assert.equal(sent.otherMapCards[0].foundByAi, true); assert.equal('foundByAi' in sent.otherMapCards[1], false);
  assert.match(sent.otherMapCardsFoundNote, /not added by the user/);
  assert.equal(sent.otherMapCards[0].readOnly, true); assert.equal('notePath' in sent.otherMapCards[0], false);
  assert.ok(ctx.mapSourcePaths.includes('Maps/O/T.md'), 'a found card note cannot be written');
});

// ---- the view -----------------------------------------------------------------------------------------------------------------

const HOST = 'Agent Workspace/Topics/map-host/Map.md';
const OTHER = 'Agent Workspace/Topics/map-other/Map.md';

async function harness() {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-host');
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-other');
  const other = { id: 'map-other', title: 'Other map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const original = await repo.createNote('Pricing tiers', 'gpt-6-luna', other, OTHER, 'workspace', { detail: 'Starter and Team' });
  Object.assign(original, { parentId: null, x: 0, y: 0 }); other.nodes.push(original);
  await app.vault.create(OTHER, core.serializeMap(other));
  const host = { id: 'map-host', title: 'Host map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const root = await repo.createNote('Pricing tiers root', 'gpt-6-luna', host, HOST, 'workspace');
  Object.assign(root, { parentId: null, x: 80, y: 80 }); host.nodes.push(root);
  await app.vault.create(HOST, core.serializeMap(host));
  await repo.rebuildDerivedData();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment, setTimeout, clearTimeout });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    knowledgeIndex: new retrieval.KnowledgeIndex(() => repo.knowledgeRefIO())
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = HOST; view.map = await repo.readMap(HOST); view.stageEl = element('div'); view.contentEl = element('div');
  return { view, plugin, repo, app, notices, ids: { original: original.id }, notePath: original.path };
}

test('view: a found card is read again at send time, marked foundByAi, named in a notice; a card revoked after indexing is not sent; the user-added one is not repeated', async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const found = await h.view.findPastCards('what about the pricing tiers', signal);
  same(found.map(c => c.title), ['Pricing tiers'], 'the host map\'s own card is not found');
  const sent = await h.view.takeOtherMapCards(found);
  assert.equal(sent.length, 1); assert.equal(sent[0].foundByAi, true); assert.equal(sent[0].detail, 'Starter and Team'); assert.equal(sent[0].notePath, h.notePath);
  assert.ok(h.notices.some(n => /AI found 1/.test(String(n.message ?? n))), 'the user is told what was found');
  const again = await h.view.findPastCards('pricing tiers', signal);
  h.app.metadataCache.getFileCache = () => ({ frontmatter: { 'agent-map-node': true, 'topic-state': 'archived' } });
  same(await h.view.takeOtherMapCards(again), [], 'archived after it was indexed: dropped at send time');
  h.view.addCrossMapCardToChat({ mapId: 'map-other', mapPath: OTHER, nodeId: h.ids.original, title: 'Pricing tiers' });
  same(await h.view.findPastCards('pricing tiers', signal), [], 'already added by the user: not found again');
  same(await h.view.findPastCards('pricing tiers', (() => { const c = new AbortController(); c.abort(); return c.signal; })()), [], 'a cancelled send finds nothing');
  const bare = await harness(); bare.plugin.knowledgeIndex = undefined;
  same(await bare.view.findPastCards('pricing tiers', signal), []);
});

test('wiring: the new code stays out of map-search.ts and the files that must not know references; the vault events drop the index; nothing is written', () => {
  const root = path.join(__dirname, '..');
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.equal(/knowledge-retrieval|KnowledgeIndex/.test(read('experiences/visual-map/map-search.ts')), false);
  for (const name of fs.readdirSync(path.join(root, 'experiences/visual-map')).filter(n => /^(map-chat|living-node|run-all|topic-run|argument-run)/.test(n) && n.endsWith('.ts')))
    assert.equal(/knowledge-retrieval|KnowledgeIndex/.test(read(`experiences/visual-map/${name}`)), false, name);
  const source = read('experiences/visual-map/knowledge-retrieval.ts');
  assert.equal(/\.(write|modify|create|process|trash|delete)\(|setInterval|registerEvent|\.on\(/.test(source), false, 'no write, no watcher');
  assert.match(read('main.ts'), /for \(const event of \["modify", "create", "delete", "rename"\][\s\S]{0,200}knowledgeIndex\.invalidate\(\)/);
  assert.equal(/MAP_CHAT_ACTION_KINDS/.test(source), false);
});
