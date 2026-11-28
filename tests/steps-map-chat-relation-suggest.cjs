'use strict';
// V3.3 F07a (P4.4 Connection, same map): map chat suggests at most 5 relations, each with a reason and a source. They are shown on
// the plan card (dashed lines on the canvas, P2.3) and nothing is written until one is adopted; adopting writes that one relation
// through the add_relation write as one undo step, and is refused while the map is read-only or one of its cards is merging.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, fixture, DEFAULT_SETTINGS, normalizeReasoningLevel, obsidian, core, plain, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { parseMapChat, MAP_CHAT_SCHEMA, MAP_CHAT_SUGGESTION_LIMIT } = load('core/steps/map-chat/step.ts');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';

// ---- parser ----
const ctx = (extra = {}) => ({ nodeIds: ['r', 'a', 'b', 'c', 'd', 'e', 'f', 'g'], parents: {}, ...extra });
const suggestion = (fromId, toId, extra = {}) => ({ fromId, toId, relationKind: 'prerequisite', reason: `why ${toId}`, source: '[S1]', ...extra });
const parse = (suggestions, extra) => plain(parseMapChat(JSON.stringify({ reply: 'ok', actions: [], remaining: '', suggestions }), ctx(extra)));

test('F07a parse: a reply with more than 5 suggestions keeps the first 5', () => {
  assert.equal(MAP_CHAT_SUGGESTION_LIMIT, 5);
  const result = parse(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => suggestion('r', id)));
  assert.deepEqual(result.suggestions.map(s => s.toId), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(result.suggestions[0], { fromId: 'r', toId: 'a', relationKind: 'prerequisite', reason: 'why a', source: '[S1]' });
  assert.deepEqual(result.actions, [], 'a suggestion is never an action');
});

test('F07a parse (counter-example): a suggestion without a reason or a source, or one the map cannot hold, is dropped', () => {
  const result = parse([
    suggestion('r', 'a', { reason: '' }),
    suggestion('r', 'b', { source: '  ' }),
    suggestion('r', 'c', { reason: undefined }),
    suggestion('r', 'd', { source: 7 }),
    suggestion('r', 'r'),
    suggestion('r', 'nope'),
    suggestion('r', 'new:x'),
    suggestion('r', 'e', { relationKind: 'loves' }),
    suggestion('r', 'f', { reason: 'x'.repeat(201) }),
    suggestion('a', 'b', {}),
    suggestion('b', 'a', {}),
    suggestion('r', 'g')
  ]);
  assert.deepEqual(result.suggestions.map(s => `${s.fromId}>${s.toId}`), ['a>b', 'r>g'], 'one per pair; the rest have no reason, no source, a bad end or kind, or a too long reason');
  // An existing relation on the pair, and an AIM map (no relations at all).
  assert.deepEqual(parse([suggestion('r', 'a')], { relations: [{ kind: 'related', from: 'a', to: 'r' }] }).suggestions, []);
  assert.deepEqual(parse([suggestion('r', 'a')], { aim: true }).suggestions, []);
  // Absent or malformed: none, never a failed reply.
  assert.equal(parse(undefined).suggestions, undefined);
  assert.equal(parse('x').suggestions, undefined);
});

test('F07a schema: suggestions is an optional list of fromId, toId, relationKind, reason and source', () => {
  const field = MAP_CHAT_SCHEMA.properties.suggestions;
  assert.equal(field.type, 'array');
  assert.deepEqual(plain(field.items.required), ['fromId', 'toId', 'relationKind', 'reason', 'source']);
  assert.equal(MAP_CHAT_SCHEMA.required.includes('suggestions'), false);
});

// ---- view: plan card, adopt ----
function fakeChat() {
  const chat = {
    draft: '', isBusy: false, calls: [], turnsList: [], plans: [], lines: [], transcriptList: [], transcript: () => chat.transcriptList,
    attachments: () => [], currentNote: () => null, turns: () => [], pendingPlan: () => chat.plans.find(p => p.state === 'pending') ?? null,
    begin(message, origin) { chat.isBusy = true; const turn = { message, origin }; chat.turnsList.push(turn); chat.transcriptList.push({ role: 'user', text: message, origin }); chat.calls.push(['begin', message]); return turn; },
    hasTurn: turn => chat.turnsList.includes(turn),
    retract(turn) { chat.isBusy = false; return chat.turnsList.includes(turn); },
    setStage() {}, clearSlow() {}, showSlow() {}, refreshSpeaker() {}, addOpening() {}, restartWaiting() {}, streamReply() {},
    finish(reply, lines) { chat.isBusy = false; chat.lines.push(lines); chat.transcriptList.push({ role: 'assistant', text: reply, lines }); chat.calls.push(['finish', reply]); },
    fail(text) { chat.isBusy = false; chat.calls.push(['fail', text]); },
    markStopped() { chat.isBusy = false; },
    showPlan(card) { chat.plans.push(card); chat.calls.push(['plan']); },
    settlePlan(card, state, lines) { card.state = state; chat.calls.push(['settle', state]); if (lines) chat.lines.push(lines); },
    refreshPlan() { chat.calls.push(['refreshPlan']); chat.painted = chat.plans.filter(p => p.state === 'pending').map(p => (p.suggestions ?? []).map(row => row.blocked())); },
    markTurn() {}, refreshReplyUndo() {}, setReplyBasis() {}, completedTurns: () => [], conversationId: undefined,
    takeQueued: () => [], takeSteerTexts: () => [], addSteer: () => ({}), setSteerState() {}, restoreDraft() {},
    setApplying() {}, focusInput() {}, reset() {},
    hasQueuedSteers: () => false, setChainWaiting() {}, endChain() {}, beginAutoRound(_r, _m, _rem, origin) { return chat.begin('auto', origin); }
  };
  return chat;
}

async function harness() {
  const { repo, app } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'claude:sonnet' };
  repo.settings = settings;
  const doc = { id: 'map-a', title: 'Steak', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(doc));
  const ids = {};
  const add = async (key, title, parent) => {
    const n = await repo.createNote(title, 'gpt-6-luna', doc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(n, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + doc.nodes.length * 200 });
    doc.nodes.push(n); ids[key] = n.id;
  };
  await add('root', 'Beef'); await add('a', 'Ribeye', 'root'); await add('b', 'Filet', 'root'); await add('c', 'Brisket', 'root');
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  const control = { reply: async () => ({ reply: 'ok', actions: [], rejected: [] }) };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice([]) } }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  let queue = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), releaseOutline() {}, syncOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    activeTasks: new Map(), quickExpandPending: new Set(), abortChartJobs() {}, addChartsAfterWrite() {}, views: () => [], modelLabel: id => id,
    currentModelChoice() { return { model: this.settings.cliModel, reasoning: normalizeReasoningLevel(this.settings.cliReasoning) }; },
    aiCalls: { capabilitiesFor: () => ({}) },
    writing: 0,
    mutate(work) { queue = queue.then(async () => { plugin.writing++; try { await work(); } finally { plugin.writing--; } }); return queue; },
    confirmAiUsage: async (model, run) => { await run(); return true; },
    mapChat: { chat: async request => control.reply(request) }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.changed = () => {};
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.render = () => {}; view.focusNode = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {}; view.fit = () => {}; view.relocateMapChat = () => {};
  const chat = fakeChat();
  view.chat = chat;
  await view.hydrate();
  const send = async text => { chat.draft = text; await view.sendMapChat(); };
  const file = () => app.vault.read(app.vault.getAbstractFileByPath(MAP));
  const hash = async () => crypto.createHash('sha256').update(await file()).digest('hex');
  return { repo, app, ids, control, view, chat, send, hash, saved: () => repo.readMap(MAP) };
}

/** Three suggestions from Beef; the reply has no actions. */
async function suggested(h0) {
  const h = h0 ?? (await harness());
  const s = (to, kind) => ({ fromId: h.ids.root, toId: h.ids[to], relationKind: kind, reason: `because ${to}`, source: '[S1]' });
  h.control.reply = async () => ({ reply: 'Here are some links', actions: [], rejected: [], remaining: '', suggestions: [s('a', 'prerequisite'), s('b', 'supports'), s('c', 'related')] });
  await h.send('Where else could Beef connect?');
  assert.equal(h.chat.plans.length, 1, 'the suggestions wait on a plan card');
  return { h, card: h.chat.plans[0] };
}
const relationLines = h => dom.findAll(h.view.stageEl, i => i.hasClass('vam-plan-ghost-edge') && i.hasClass('is-relation'));
const tick = () => new Promise(r => setTimeout(r, 20));

test('F07a card: each suggestion is a row with its link, reason and source and its own Adopt; the canvas draws them dashed; the card has no Apply', async () => {
  const { h, card } = await suggested();
  assert.equal(card.suggestions.length, 3);
  assert.deepEqual(plain(card.suggestions.map(s => [s.text, s.reason, s.source, s.state])), [
    ['Link “Beef” to “Ribeye” (Prerequisite)', 'because a', '[S1]', 'pending'],
    ['Link “Beef” to “Filet” (Supports)', 'because b', '[S1]', 'pending'],
    ['Link “Beef” to “Brisket” (Related)', 'because c', '[S1]', 'pending']
  ]);
  assert.equal(card.noApply, true, 'only the rows write; the card itself has nothing to apply');
  assert.equal(relationLines(h).length, 3, 'dashed preview lines (P2.3)');
});

test('F07a zero writes (counter-example): suggestions that are not adopted leave Map.md byte-identical, also after Cancel', async () => {
  const h0 = await harness();
  const before = await h0.hash();
  const { h, card } = await suggested(h0);
  assert.equal(await h.hash(), before, 'shown, not written');
  assert.equal((h.view.map.topicRelations ?? []).length, 0);
  assert.equal(h.view.history.undoEntry, undefined, 'no undo step');
  card.cancel(); await tick();
  assert.equal(await h.hash(), before, 'cancelled, not written');
  assert.equal(relationLines(h).length, 0, 'the dashed lines go with the card');
  card.suggestions[0].adopt(); await tick();
  assert.equal(await h.hash(), before, 'a row of a cancelled card does nothing');
});

test('F07a adopt: one row writes exactly that one relation as one undo step; the others stay suggestions', async () => {
  const { h, card } = await suggested();
  card.suggestions[1].adopt(); card.suggestions[1].adopt();
  await until(async () => ((await h.saved()).topicRelations ?? []).length === 1);
  await tick();
  assert.deepEqual(plain((await h.saved()).topicRelations), [{ kind: 'supports', from: h.ids.root, to: h.ids.b }], 'exactly one, once');
  assert.deepEqual(plain(card.suggestions.map(s => s.state)), ['pending', 'adopted', 'pending']);
  assert.equal(card.state, 'pending', 'the other rows can still be adopted');
  assert.equal(relationLines(h).length, 2, 'the adopted line is no longer a preview');
  assert.equal(h.view.history.undoEntry.label, 'AI chat reply');
  await h.view.travel(false);
  assert.deepEqual(plain((await h.saved()).topicRelations ?? []), [], 'one undo takes it back');
  assert.equal(h.view.history.undoEntry, undefined, 'and it was the only step');
});

test('F07a gate (counter-example): on a read-only map (presented, notes loading) or with a merging end, adopting writes nothing', async () => {
  const { h, card } = await suggested();
  const before = await h.hash();
  h.view.presentation = { order: [], currentId: null };
  card.suggestions[0].adopt(); await tick();
  assert.equal(await h.hash(), before, 'presented');
  assert.equal(card.suggestions[0].state, 'pending');
  assert.ok(card.blocked(), 'the card says why');
  h.view.presentation = null;
  const loading = h.view.notesLoading; h.view.notesLoading = () => true;
  card.suggestions[0].adopt(); await tick();
  assert.equal(await h.hash(), before, 'notes loading');
  h.view.notesLoading = loading;
  h.view.isMerging = id => id === h.ids.a;
  assert.equal(card.suggestions[0].blocked(), 'Merging; try again when it finishes');
  card.suggestions[0].adopt(); await tick();
  assert.equal(await h.hash(), before, 'merging');
  assert.equal(card.suggestions[1].blocked(), null, 'a row whose cards are not merging can be adopted');
});

test('F07a mixed (counter-example): a small action next to suggestions is not written at once; it waits for Apply with the card', async () => {
  const h = await harness();
  const before = await h.hash();
  h.control.reply = async () => ({ reply: 'ok', actions: [{ kind: 'add_child', parentId: h.ids.a, title: 'Small one' }], rejected: [], remaining: '',
    suggestions: [{ fromId: h.ids.a, toId: h.ids.b, relationKind: 'related', reason: 'r', source: '[S1]' }] });
  await h.send('add one and suggest links');
  assert.equal(h.chat.plans.length, 1);
  const card = h.chat.plans[0];
  assert.equal(card.noApply, undefined, 'Apply is for the action');
  await tick();
  assert.equal(await h.hash(), before, 'nothing written yet');
  card.apply();
  await until(async () => (await h.saved()).nodes.length === 5);
  assert.deepEqual(plain((await h.saved()).topicRelations ?? []), [], 'Apply does not adopt a suggestion');
});

test('F07a-x merge gate: Adopt greys (with the reason) the moment a merge starts and wakes when it ends, with no click in between', async () => {
  const { h, card } = await suggested();
  const gate = [];
  h.view.plugin.askModel = async (_context, _model, _reasoning, signal, _exchange, accepted) => {
    accepted?.();
    await new Promise((resolve, reject) => { gate.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); });
    return { summary: 'AI summary', detail: 'AI detail', visualReferences: [], suggestions: [] };
  };
  h.view.plugin.mutate = async work => work();
  for (const key of ['a', 'b']) await h.repo.updateNote(h.view.map.nodes.find(n => n.id === h.ids[key]).path, { summary: `${key} summary`, detail: 'Source detail', status: 'completed' });
  await h.view.hydrate();
  h.view.mergeOpen = false;
  h.view.render = () => {};
  h.chat.painted = null;
  const sources = [h.ids.a, h.ids.b].map(id => ({ id, path: h.view.map.nodes.find(n => n.id === id).path }));
  assert.equal(await h.view.startMergeDraft('M', { path: MAP, mapId: h.view.map.id, parentId: null, targetId: null, sources }, () => {}, new AbortController().signal), true);
  assert.deepEqual(plain(h.chat.painted?.[0]), ['Merging; try again when it finishes', 'Merging; try again when it finishes', null], 'rows touching a merging card are greyed with the reason, painted at merge start');
  h.view.mergeDrafts.stop(h.view.mergeDrafts.tasks.get(MAP));
  assert.deepEqual(plain(h.chat.painted?.[0]), [null, null, null], 'wakes when the merge ends');
  assert.equal(card.state, 'pending');
});

test('F07b-y adopt: a suggestion from a never-touched card to a knowledge reference writes Map.md only, no note changes', async () => {
  const h = await harness();
  const doc = await h.repo.readMap(MAP);
  doc.knowledgeRefs = [{ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: h.ids.a, x: 300, y: 0, pathHint: 'Mind Maps/Other/Map.md' }];
  await h.repo.saveMap(MAP, doc);
  await h.repo.rebuildDerivedData();
  h.view.map = await h.repo.readMap(MAP);
  await h.view.hydrate();
  const notes = h.app.vault.getMarkdownFiles().filter(f => f.path !== MAP);
  for (const f of notes) await h.app.vault.process(f, text => text.replace(/\n## Reference Links\n[\s\S]*?<!-- visual-agent-map:references:end -->\n?/, '\n'));
  const snap = async () => { const m = new Map(); for (const f of notes) m.set(f.path, await h.app.vault.read(f)); return m; };
  const before = await snap();
  assert.ok([...before.values()].every(text => !/Reference Links/.test(text)), 'precondition: no derived block in any note');
  h.control.reply = async () => ({ reply: 'ok', actions: [], rejected: [], remaining: '', suggestions: [{ fromId: h.ids.root, toId: 'ref-1', relationKind: 'supports', reason: 'why', source: '[S1]' }] });
  await h.send('link to the reference');
  const card = h.chat.plans[0];
  assert.equal(card.suggestions.length, 1, 'the reference suggestion is offered');
  card.suggestions[0].adopt();
  await until(async () => ((await h.saved()).topicRelations ?? []).length === 1);
  await tick();
  const after = await snap();
  assert.deepEqual([...after.keys()].filter(path => after.get(path) !== before.get(path)), [], 'no note of either end changed');
});

// ---- F07a-y: an end of a suggestion left the map ----
const GONE = 'This card is no longer on the map.';
/** The view's real render (its tail refreshes the waiting plan, as after any map change) with the canvas painting left out. */
function useRealRender(h) {
  delete h.view.render;
  h.view.paint = () => {}; h.view.lockWhileLoading = () => {}; h.view.settleCardHeights = () => {};
}
/** Takes the card out of the map the way a finished merge or a delete does (Map.md and memory), and lets the view repaint. */
async function removeCard(h, key) {
  const doc = await h.repo.readMap(MAP);
  doc.nodes = doc.nodes.filter(n => n.id !== h.ids[key]);
  await h.repo.saveMap(MAP, doc);
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids[key]);
}

test('F07a-y card gone: the row is greyed with the card-gone reason the moment the map changes; the other rows stay adoptable', async () => {
  const { h, card } = await suggested();
  h.chat.painted = null;
  await removeCard(h, 'a');
  useRealRender(h);
  h.view.render();
  assert.deepEqual(plain(h.chat.painted?.[0]), [GONE, null, null], 'painted without a click');
  assert.equal(card.suggestions[0].blocked(), GONE);
  assert.equal(card.suggestions[1].blocked(), null);
});

test('F07a-y card gone (counter-example): clicking Adopt writes nothing, never a relation to a missing id, and says why', async () => {
  const { h, card } = await suggested();
  const before = await (async () => { await removeCard(h, 'a'); return h.hash(); })();
  card.suggestions[0].adopt(); await tick();
  assert.equal(await h.hash(), before, 'Map.md byte-identical');
  assert.deepEqual(plain((await h.saved()).topicRelations ?? []), []);
  assert.equal(card.suggestions[0].state, 'pending', 'a refused click is not a failed write; the row stays greyed');
  assert.equal(h.view.history.undoEntry, undefined, 'no undo step');
  // Even if the gate were skipped, the write re-checks the ends on the map being edited.
  const row = card.suggestions[0];
  const blocked = row.blocked; row.blocked = () => null;
  row.adopt(); await tick();
  assert.equal(await h.hash(), before, 'write-time check: nothing written');
  assert.match(row.note ?? '', /no longer on the map/);
  row.blocked = blocked;
});

test('F07a-y knowledge reference removed: a row ending on it greys; an existing reference stays adoptable', async () => {
  const h = await harness();
  const doc = await h.repo.readMap(MAP);
  doc.knowledgeRefs = [{ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: h.ids.a, x: 300, y: 0, pathHint: 'Mind Maps/Other/Map.md' }];
  await h.repo.saveMap(MAP, doc);
  await h.repo.rebuildDerivedData();
  h.view.map = await h.repo.readMap(MAP);
  await h.view.hydrate();
  h.control.reply = async () => ({ reply: 'ok', actions: [], rejected: [], remaining: '', suggestions: [{ fromId: h.ids.root, toId: 'ref-1', relationKind: 'supports', reason: 'why', source: '[S1]' }] });
  await h.send('link to the reference');
  const card = h.chat.plans[0];
  assert.equal(card.suggestions[0].blocked(), null, 'the reference is on the map');
  useRealRender(h);
  const saved = await h.repo.readMap(MAP); saved.knowledgeRefs = []; await h.repo.saveMap(MAP, saved);
  h.view.map.knowledgeRefs = [];
  h.chat.painted = null;
  h.view.render();
  assert.deepEqual(plain(h.chat.painted?.[0]), [GONE], 'greyed when the reference is removed');
  const before = await h.hash();
  card.suggestions[0].adopt(); await tick();
  assert.equal(await h.hash(), before, 'nothing written');
});
