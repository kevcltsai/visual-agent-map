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

test('ranking: more hits first (title and text count separately), ties keep corpus order, at most five, own map, skipped and AI-locked cards left out', async () => {
  const cards = await corpus.loadAuthorizedCards(fakeIo(SPEC(), { marked: ['Maps/A/Map.md', 'Maps/B/Map.md'] }), new AbortController().signal);
  const found = retrieval.findCards(cards, 'pricing tiers', NONE);
  same(found.map(c => c.nodeId), ['a1', 'b1'], 'both have two hits (title + text of the other word): corpus order; cooking has no hit');
  same(retrieval.findCards(cards, 'pricing tiers table', NONE).map(c => c.nodeId), ['b1', 'a1'], 'b1 has three words, a1 two');
  same(retrieval.findCards(cards, 'pricing tiers', { mapId: 'map-a', keys: new Set() }).map(c => c.nodeId), ['b1'], "the talked-to map's own cards are not 'other' cards");
  same(retrieval.findCards(cards, 'pricing tiers', { mapId: 'x', keys: new Set(['map-b\u0000b1']) }).map(c => c.nodeId), ['a1'], 'a card the user added is not found again');
  same(retrieval.findCards(cards, '定價 經濟', NONE).map(c => c.nodeId), ['a2']);
  same(retrieval.findCards(cards, 'ok', NONE), [], 'a message without words finds nothing');
  const many = Array.from({ length: 12 }, (_, i) => ({ mapId: `m${i}`, nodeId: `n${i}`, foldedTitle: i < 6 ? 'tiers' : 'zzz', foldedBody: i < 6 ? 'xyzzy' : 'zzz', aiLocked: false }));
  same(retrieval.findCards(many, 'tiers xyzzy', NONE).map(c => c.nodeId), ['n0', 'n1', 'n2', 'n3', 'n4']);
  many[0].aiLocked = true;
  same(retrieval.findCards(many, 'tiers xyzzy', NONE).map(c => c.nodeId), ['n1', 'n2', 'n3', 'n4', 'n5'], 'an AI-locked card never comes first, however well it matches');
});

test('relevance floor: one word is no evidence, and a word most cards have says nothing (a message of common words brings no card)', () => {
  const card = (i, body, title = `Card ${i}`) => ({ mapId: `m${i}`, nodeId: `n${i}`, foldedTitle: corpus.foldSearchText(title), foldedBody: corpus.foldSearchText(body), aiLocked: false });
  const cards = [card(0, '這張卡片的想法'), card(1, '這張卡片要一點時間'), card(2, '這張卡片放在這裡'), card(3, 'shorter cooking times'), card(4, 'a card about soup', 'Soup')];
  same(retrieval.findCards(cards, '把這張卡片改短一點', NONE), [], 'common Chinese words that most cards share bring nothing');
  same(retrieval.findCards(cards, 'make this card shorter', NONE), [], 'one matching word (shorter) is not enough');
  const rare = [...cards, card(5, 'Quarterly budget review with finance')];
  same(retrieval.findCards(rare, 'budget quarterly please', NONE).map(c => c.nodeId), ['n5'], 'two different rare words are enough');
  same(retrieval.findCards(rare, 'budget', NONE), [], 'a single word is never enough');
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

test('index: a revoked marker, a rename and a delete show in the next result; a build dropped while it runs is not kept', async () => {
  const spec = SPEC(); const state = { marked: ['Maps/A/Map.md', 'Maps/B/Map.md'] };
  const index = new retrieval.KnowledgeIndex(() => fakeIo(spec, state));
  const ids = async () => retrieval.findCards(await index.get(), 'pricing tiers', NONE).map(c => c.nodeId);
  same(await ids(), ['a1', 'b1']);
  state.marked = ['Maps/A/Map.md']; index.invalidate();
  same(await ids(), ['a1'], 'the marker of map B was revoked');
  state.marked = ['Maps/A/Map.md', 'Maps/B/Map.md'];
  spec['Maps/A/Map.md'].nodes[0].title = 'Plans'; index.invalidate();
  same(await ids(), ['b1'], 'renamed: a1 lost "pricing" in its title, so only one word hits');
  spec['Maps/B/Map.md'].nodes.shift(); index.invalidate();
  same(await ids(), [], 'deleted');
  let release; state.hold = new Promise(r => { release = r; }); state.marked = ['Maps/A/Map.md', 'Maps/B/Map.md'];
  index.invalidate(); const pending = index.get(); await tick();
  state.marked = ['Maps/A/Map.md']; state.hold = null; index.invalidate(); release();
  same((await pending).map(c => c.nodeId).sort(), ['a1', 'a2'], 'the waiting caller gets the rebuilt index, not the stale one');
});

test('index: only a map file, a card note or a note in a map folder drops it; any other note leaves it (and a note that just became a map does)', async () => {
  const io = fakeIo(SPEC(), { marked: ['Maps/A/Map.md', 'Maps/B/Map.md'] });
  const index = new retrieval.KnowledgeIndex(() => io);
  assert.equal(index.changed(['Maps/A/Map.md'], false), false, 'nothing read yet: nothing to drop');
  await index.get(); await tick();
  assert.equal(index.changed(['Notes/Meeting.md'], false), false, 'a plain note');
  assert.equal(index.changed(['Maps/A/Archived card.md', 'Notes/Old.md'], false), true, 'a note in a map folder (an archived card can come back)');
  await index.get();
  assert.equal(io.loads, 2);
  assert.equal(index.changed(['Maps/B/b1.md'], false), true, 'a card note');
  await index.get(); assert.equal(index.changed(['Maps/A/Map.md'], false), true, 'a map file');
  await index.get(); assert.equal(index.changed(['Notes/New map.md'], true), true, 'a note that is a map now');
  await index.get(); assert.equal(index.changed(['Notes/Meeting.md'], false), false);
  assert.equal(io.loads, 5, 'only the real changes caused a new read');
});

test('index: stopping a wait for the index returns at once, without the cards', async () => {
  const never = new Promise(() => {});
  const ctl = new AbortController();
  const waiting = retrieval.raceAbort(never, ctl.signal, []);
  ctl.abort();
  same(await waiting, []);
  same(await retrieval.raceAbort(Promise.resolve(['x']), new AbortController().signal, []), ['x']);
  const done = new AbortController(); done.abort();
  same(await retrieval.raceAbort(never, done.signal, []), [], 'already stopped');
});

test('excerpt: a long text is sent as the places where the words are, within the limit, and says it was cut; a short one goes whole', () => {
  const long = `${'a '.repeat(1500)}the pricing tiers matter here ${'b '.repeat(1500)}`;
  const part = retrieval.excerptOf('Summary', long, 'pricing tiers matter');
  assert.ok(part.cut); assert.ok(part.detail.includes('pricing tiers matter')); assert.ok(part.summary.length + part.detail.length <= retrieval.FOUND_CARD_CHAR_LIMIT);
  assert.ok(part.detail.length < long.length / 4, 'not the whole text');
  const none = retrieval.excerptOf('', long, 'zzzzz qqqqq');
  assert.ok(none.cut && none.detail.length > 0 && none.detail.length <= retrieval.FOUND_CARD_CHAR_LIMIT, 'a title-only match gets the start of the text');
  same(retrieval.excerptOf('S', 'short body', 'body'), { summary: 'S', detail: 'short body', cut: false });
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

async function harness({ detail = 'Starter and Team', locked = false } = {}) {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-host');
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-other');
  const other = { id: 'map-other', title: 'Other map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const original = await repo.createNote('Pricing tiers', 'gpt-6-luna', other, OTHER, 'workspace', { detail });
  Object.assign(original, { parentId: null, x: 0, y: 0 }); other.nodes.push(original);
  for (const [i, title] of ['Gardening', 'Soup recipes'].entries()) {
    const filler = await repo.createNote(title, 'gpt-6-luna', other, OTHER, 'workspace', { detail: 'plants and water' });
    Object.assign(filler, { parentId: original.id, x: 100 * (i + 1), y: 0 }); other.nodes.push(filler);
  }
  await app.vault.create(OTHER, core.serializeMap(other));
  const host = { id: 'map-host', title: 'Host map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const root = await repo.createNote('Pricing tiers root', 'gpt-6-luna', host, HOST, 'workspace');
  Object.assign(root, { parentId: null, x: 80, y: 80 }); host.nodes.push(root);
  await app.vault.create(HOST, core.serializeMap(host));
  await repo.rebuildDerivedData();
  if (locked) await repo.writeAiLocked(original.path, true);
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
const live = () => new AbortController().signal;
const MESSAGE = 'what about the pricing tiers';

test('view: a found card is read again at send time, marked foundByAi, and sent without a notice (the notice waits for the request to go through)', async () => {
  const h = await harness();
  const found = await h.view.findPastCards(MESSAGE, live());
  same(found.map(c => c.title), ['Pricing tiers'], "the host map's own card is not found");
  const sent = await h.view.takeOtherMapCards(found, MESSAGE);
  assert.equal(sent.length, 1); assert.equal(sent[0].foundByAi, true); assert.equal(sent[0].detail, 'Starter and Team'); assert.equal(sent[0].notePath, h.notePath);
  assert.equal(h.notices.length, 0, 'building the request tells nothing yet');
  const context = {};
  h.view.chatFound.set(context, h.view.foundSent);
  h.view.markChatTurn({}, { context });
  assert.equal(h.notices.length, 1, 'the request went through: now the user is told');
  assert.match(h.notices[0], /AI found 1/);
  h.view.markChatTurn({}, { context });
  assert.equal(h.notices.length, 1, 'told once');
  const lost = {};
  h.view.chatFound.set(lost, h.view.foundSent);
  assert.equal(h.notices.length, 1, 'a request that failed or was stopped never reaches markChatTurn: no notice');
});

test('view: the record gets one cards_found line (title and map name), only when cards were found', async () => {
  const h = await harness();
  const found = await h.view.findPastCards(MESSAGE, live());
  await h.view.takeOtherMapCards(found, MESSAGE);
  const context = {}; h.view.chatFound.set(context, h.view.foundSent);
  const lines = [];
  h.view.markFoundRecorded({ event: (kind, extra) => lines.push([kind, extra]) }, { context });
  same(lines, [['cards_found', { topics: [{ id: 'Other map', title: 'Pricing tiers' }] }]]);
  h.view.markFoundRecorded({ event: (...a) => lines.push(a) }, { context: {} });
  assert.equal(lines.length, 1, 'nothing found: no line');
});

test('view: a long text is sent as an excerpt only, and the notice says it was cut', async () => {
  const long = `${'plants and water. '.repeat(300)}The pricing tiers decision was Starter, Team. ${'more filler text. '.repeat(300)}`;
  const h = await harness({ detail: long });
  const found = await h.view.findPastCards(MESSAGE, live());
  const sent = await h.view.takeOtherMapCards(found, MESSAGE);
  assert.ok(sent[0].detail.length <= 800 && sent[0].detail.includes('pricing tiers decision'), 'the part that matched, not the whole text');
  assert.equal(h.view.foundSent.cut, true);
  const context = {}; h.view.chatFound.set(context, h.view.foundSent);
  const lines = []; h.view.markFoundRecorded({ event: (kind, extra) => lines.push(extra.reason) }, { context });
  same(lines, ['cut'], 'the record line (written when the turn starts) says it was cut');
  h.view.markChatTurn({}, { context });
  assert.match(h.notices[0], /cut down/);
});

test('view: an archived card and a card whose map lost its marker are each dropped at send time, even though the index still holds them', async () => {
  const archived = await harness();
  const a = await archived.view.findPastCards(MESSAGE, live());
  assert.equal(a.length, 1);
  archived.app.metadataCache.getFileCache = () => ({ frontmatter: { 'agent-map-node': true, 'topic-state': 'archived' } });
  same(await archived.view.takeOtherMapCards(a, MESSAGE), [], 'archived after it was indexed');
  assert.equal(archived.view.foundSent.cards.length, 0);
  const missing = await harness();
  const m = await missing.view.findPastCards(MESSAGE, live());
  assert.equal(m.length, 1);
  const base = missing.repo.knowledgeRefIO.bind(missing.repo);
  missing.repo.knowledgeRefIO = () => ({ ...base(), mapPaths: async () => [HOST] });
  same(await missing.view.takeOtherMapCards(m, MESSAGE), [], "the other map's marker is gone");
  same(missing.view.foundSent.cards, []);
});

test('view: a note locked for the AI is never found, never sent and never in the prompt, however well it matches; a lock set after indexing also keeps it out', async () => {
  const locked = await harness({ locked: true });
  same(await locked.view.findPastCards(MESSAGE, live()), [], 'locked before indexing: not found');
  const late = await harness();
  const found = await late.view.findPastCards(MESSAGE, live());
  assert.equal(found.length, 1);
  await late.repo.writeAiLocked(late.notePath, true);
  const sent = await late.view.takeOtherMapCards(found, MESSAGE);
  same(sent, [], 'locked after indexing: dropped at send time');
  const ctx = buildMapChatContext(ctxInput({ otherMapCards: sent }));
  assert.equal(ctx.json.includes('otherMapCards') || ctx.json.includes('Starter and Team'), false, 'nothing of it reaches the prompt');
});

test('view: a card the user added is not found again; a stopped send finds nothing and does not wait for the index; no index means no find', async () => {
  const h = await harness();
  h.view.addCrossMapCardToChat({ mapId: 'map-other', mapPath: OTHER, nodeId: h.ids.original, title: 'Pricing tiers' });
  same(await h.view.findPastCards(MESSAGE, live()), [], 'already added by the user');
  const slow = await harness();
  slow.plugin.knowledgeIndex = { get: () => new Promise(() => {}) };
  const ctl = new AbortController();
  const waiting = slow.view.findPastCards(MESSAGE, ctl.signal);
  ctl.abort();
  same(await waiting, [], 'stopped while the index was being read');
  const bare = await harness(); bare.plugin.knowledgeIndex = undefined;
  same(await bare.view.findPastCards(MESSAGE, live()), []);
});

test('wiring: the new code stays out of map-search.ts and the files that must not know references; the vault events ask the index; nothing is written', () => {
  const root = path.join(__dirname, '..');
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.equal(/knowledge-retrieval|KnowledgeIndex/.test(read('experiences/visual-map/map-search.ts')), false);
  for (const name of fs.readdirSync(path.join(root, 'experiences/visual-map')).filter(n => /^(map-chat|living-node|run-all|topic-run|argument-run)/.test(n) && n.endsWith('.ts')))
    assert.equal(/knowledge-retrieval|KnowledgeIndex/.test(read(`experiences/visual-map/${name}`)), false, name);
  const source = read('experiences/visual-map/knowledge-retrieval.ts');
  assert.equal(/\.(write|modify|create|process|trash|delete)\(|setInterval|registerEvent|\.on\(/.test(source), false, 'no write, no watcher');
  const main = read('main.ts');
  for (const event of ['modify', 'create', 'delete', 'rename']) assert.match(main, new RegExp(`vault\\.on\\("${event}", \\(?file[^)]*\\)? => this\\.dropKnowledgeIndex\\(file`));
  assert.match(main, /knowledgeIndex\.changed\([\s\S]{0,80}this\.isMap\(file\)/);
  assert.equal(/MAP_CHAT_ACTION_KINDS/.test(source), false);
});
