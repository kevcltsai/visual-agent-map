'use strict';
// V3.3 E3 (P2.3): a plan that waits for the user's yes draws its new cards as dashed preview cards; one gate greys Apply when the plan
// is stale or the map is read-only. The preview is drawn only: never in map.nodes, the file, the history, search, export, share or records.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, normalizeReasoningLevel, obsidian, core, plain, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const preview = load('experiences/visual-map/chat-plan-preview.ts');

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
    refreshPlan() { chat.calls.push(['refreshPlan']); },
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
  await add('root', 'Beef'); await add('a', 'Ribeye', 'root'); await add('b', 'Filet', 'root');
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  app.workspace = { getLeavesOfType: () => [] };
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
    // A reply here is one the user asked for (decision 2026-11-28-vam-v3-3#33); a reply that says otherwise keeps its own flag.
    mapChat: { chat: async request => ({ changeRequested: true, ...(await control.reply(request)) }) }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.changed = () => {};
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.render = () => {}; view.focusNode = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {}; view.fit = () => {}; view.relocateMapChat = () => {};
  const chat = fakeChat();
  view.chat = chat;
  await view.hydrate();
  const send = async text => { chat.draft = text; await view.sendMapChat(); };
  return { repo, app, ids, control, view, chat, send, saved: () => repo.readMap(MAP), file: () => app.vault.read(app.vault.getAbstractFileByPath(MAP)) };
}

const child = (parentId, title, ref) => ({ kind: 'add_child', parentId, title, ...(ref ? { ref } : {}) });
const ghostLayer = h => dom.find(h.view.stageEl, i => i.hasClass('vam-plan-ghosts'));
const ghosts = h => dom.findAll(h.view.stageEl, i => i.hasClass('vam-plan-ghost'));
const ghostTexts = h => ghosts(h).map(g => dom.texts(g).join('|'));
/** A plan of 18 new cards in three groups (over the 15-action limit, so it waits for Apply). */
async function planned(extra = []) {
  const h = await harness();
  const actions = [];
  for (const [key, parent] of [['A', h.ids.a], ['B', h.ids.b], ['R', h.ids.root]])
    for (let i = 1; i <= 6; i++) actions.push(child(parent, `Ghost${key}${i}`));
  h.control.reply = async () => ({ reply: 'Plan', actions: [...actions, ...extra], rejected: [] });
  await h.send('add many');
  assert.equal(h.chat.plans.length, 1, 'the plan waits for Apply');
  return { h, card: h.chat.plans[0] };
}

test('E3 layout: at most 3 dashed cards per parent, the rest as one "… N more"; a card under a hidden planned card counts in that more; unknown parents draw nothing', () => {
  const boxes = new Map([['p', { x: 0, y: 0, width: 280, height: 80 }], ['q', { x: 0, y: 300, width: 280, height: 80 }]]);
  const specs = [
    ...[1, 2, 3, 4, 5].map(i => ({ parentId: 'p', title: `P${i}`, ref: `p${i}` })),
    { parentId: 'new:p5', title: 'under hidden' },
    { parentId: 'new:p1', title: 'under shown' },
    { parentId: 'gone', title: 'nowhere' },
    { parentId: 'new:unknown', title: 'no such ref' }
  ];
  const layout = preview.planGhostLayout(specs, boxes, id => (id === 'q' ? [{ x: 400, y: 300, width: 280, height: 80 }] : []));
  const titles = layout.cards.map(c => (c.more ? `more:${c.more}` : c.title));
  assert.deepEqual(plain(titles), ['P1', 'P2', 'P3', 'under shown', 'more:3']);
  assert.equal(preview.PLAN_GHOST_PER_GROUP, 3);
  assert.equal(layout.edges.length, layout.cards.length, 'one dashed line per drawn card to its parent');
  const p1 = layout.cards[0];
  assert.ok(p1.x >= 280, 'drawn to the right of the parent');
  const under = layout.cards[3];
  assert.ok(under.x >= p1.x + p1.width, 'a card under a planned card goes right of it');
  // Existing children: the new cards go below them, in their column.
  const q = preview.planGhostLayout([{ parentId: 'q', title: 'Q1' }], boxes, id => (id === 'q' ? [{ x: 400, y: 300, width: 280, height: 80 }] : []));
  assert.deepEqual(plain([q.cards[0].x, q.cards[0].y > 380]), [400, true]);
  // New roots: a column right of every card.
  const r = preview.planGhostLayout([{ parentId: '', title: 'R' }], boxes, () => []);
  assert.deepEqual(plain([r.cards[0].x > 280, r.edges.length]), [true, 0]);
  assert.deepEqual(plain(preview.planGhostSpecs([{ kind: 'rename_topic', nodeId: 'x', title: 'y' }, child('p', 'T', 'n1')])), [{ parentId: 'p', title: 'T', ref: 'n1' }]);
});

test('E3 layout relations: a planned relation is a line when both ends are drawn (a card or a drawn planned card); an end that is hidden in a "more" or unknown drops it', () => {
  const boxes = new Map([['p', { x: 0, y: 0, width: 280, height: 80 }], ['q', { x: 0, y: 300, width: 280, height: 80 }]]);
  const specs = [1, 2, 3, 4].map(i => ({ parentId: 'p', title: `P${i}`, ref: `p${i}` }));
  const layout = preview.planGhostLayout(specs, boxes, () => [], [
    { fromId: 'p', toId: 'q' },
    { fromId: 'q', toId: 'new:p1' },
    { fromId: 'new:p1', toId: 'new:p2' },
    { fromId: 'new:p4', toId: 'q' },
    { fromId: 'gone', toId: 'q' },
    { fromId: 'new:nope', toId: 'p' }
  ]);
  assert.equal(layout.relations.length, 3, 'card-card, card-planned, planned-planned; hidden and unknown ends drop the line');
  const p1 = layout.cards[0];
  // q (x 0..280) is left of P1: the line leaves q's right side and reaches P1's left side, crossing neither card.
  assert.deepEqual(plain(layout.relations[1]), { from: { x: 280, y: 340 }, to: { x: p1.x, y: p1.y + p1.height / 2 } });
  assert.equal(layout.edges.length, layout.cards.length, 'relations add no parent lines');
  assert.deepEqual(plain(preview.planGhostRelations([{ kind: 'add_relation', fromId: 'a', toId: 'new:b', relationKind: 'related' }, child('p', 'T')])), [{ fromId: 'a', toId: 'new:b' }]);
});

test('E3 preview relations (counter-example): planned relations are dashed lines in the preview layer only, never in the edge layer, map, export or search, and go with the rest', async () => {
  const rel = (fromId, toId) => ({ kind: 'add_relation', fromId, toId, relationKind: 'related' });
  const build = async () => {
    const h = await harness();
    const actions = [];
    for (const [key, parent] of [['A', h.ids.a], ['B', h.ids.b], ['R', h.ids.root]])
      for (let i = 1; i <= 6; i++) actions.push(child(parent, `Ghost${key}${i}`));
    actions.push(child('', 'RelNew', 'n1'), child(h.ids.a, 'HiddenA', 'h1'));
    actions.push(rel(h.ids.a, h.ids.b), rel(h.ids.root, 'new:n1'), rel('new:h1', h.ids.b));
    h.control.reply = async () => ({ reply: 'Plan', actions, rejected: [] });
    h.writes = 0; const real = h.view.applyMapChatActions.bind(h.view);
    h.view.applyMapChatActions = (...args) => { h.writes++; return real(...args); };
    await h.send('add many');
    assert.equal(h.chat.plans.length, 1, 'the plan waits for Apply');
    return { h, card: h.chat.plans[0] };
  };
  const { h, card } = await build();
  const lines = () => dom.findAll(h.view.stageEl, i => i.hasClass('vam-plan-ghost-edge') && i.hasClass('is-relation'));
  assert.equal(lines().length, 2, 'card to card and card to planned card; the one to a card hidden in "more" is skipped');
  assert.ok(lines().every(line => ghostLayer(h).children.includes(line)), 'in the preview layer');
  assert.equal(JSON.stringify(h.view.map).includes('RelNew'), false, 'map');
  assert.equal(h.writes, 0, 'no relation is written while the plan waits');
  const source = h.view.mapExportSource();
  assert.equal(source.edges().some(e => e.hasClass?.('vam-plan-ghost-edge')), false, 'export edge layer');
  assert.equal(lines().some(line => (h.view.edgesEl?.children ?? []).includes(line)), false, 'not in the edge layer');
  h.view.mapSearch = { query: 'RelNew', currentId: null };
  assert.deepEqual(plain(h.view.mapSearchResult()?.matches ?? []), [], 'map-search');
  h.view.mapSearch = null;
  card.cancel();
  assert.equal(ghostLayer(h), undefined, 'cancel takes the lines too');
  assert.equal(lines().length, 0);
  // A preview of only relations between cards on the canvas still draws them (no planned card needed).
  h.view.chatPreview = { token: h.view.chatPlanToken, anchors: [], relations: [{ fromId: h.ids.a, toId: h.ids.b }] };
  h.view.paintPlanGhosts();
  assert.equal(lines().length, 1, 'a relations-only preview draws its line');
  assert.equal(ghosts(h).length, 0);
});

test('E3 preview: a waiting plan draws its new cards dashed and marked Preview, 3 per parent then "… 3 more"; the text list stays', async () => {
  const { h, card } = await planned();
  const layer = ghostLayer(h);
  assert.ok(layer, 'the preview layer is drawn');
  assert.equal(layer.attrs['aria-hidden'], 'true', 'the plan card list is what a reader hears');
  assert.equal(ghosts(h).length, 12, 'three groups: 3 cards and one "more" each');
  assert.deepEqual(ghostTexts(h).filter(t => t.includes('more')), ['Preview|… 3 more', 'Preview|… 3 more', 'Preview|… 3 more']);
  assert.ok(ghostTexts(h).includes('Preview|GhostA1'));
  assert.equal(dom.findAll(h.view.stageEl, i => i.hasClass('vam-plan-ghost-edge')).length, 12);
  assert.equal(card.items.length, 18, 'the text list keeps every card');
  assert.ok(card.previewNote, 'the card says the dashed cards are these and the map is checked again');
  assert.equal(card.blocked(), null, 'Apply can be pressed');
  // Not a card: no node id, no tab stop, no drag handle.
  for (const g of ghosts(h)) { assert.equal(g.attrs['data-node-id'], undefined); assert.equal(g.tabIndex, undefined); }
});

test('E3 preview (counter-example): an untrusted title goes in as text, never as an element', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { h } = await planned([child('', evil)]);
  assert.equal(dom.findAll(ghostLayer(h), i => i.tag === 'img' || i.tag === 'script').length, 0);
  assert.ok(ghostTexts(h).some(t => t.includes(evil)), 'shown as plain text');
});

test('E3 leaks (counter-example): while the preview is drawn, map.nodes, the saved file, the undo history, the reply undo, search, export, share and the plan record hold no preview card', async () => {
  const { h, card } = await planned();
  assert.ok(ghosts(h).length);
  const has = value => JSON.stringify(value ?? null).includes('GhostA1');
  // map.nodes and the file on disk.
  assert.equal(h.view.map.nodes.length, 3); assert.equal(has(h.view.map), false, 'map.nodes / canvasItems');
  await h.view.persist();
  assert.equal((await h.file()).includes('GhostA1'), false, 'saveMap');
  assert.equal((await h.saved()).nodes.length, 3);
  // History and the reply's undo step.
  assert.equal(h.view.history.undoEntry, undefined, 'history');
  let replyEntries = 0; const push = h.view.pushChatReplyEntry.bind(h.view);
  h.view.pushChatReplyEntry = (...args) => { replyEntries++; return push(...args); };
  h.view.paintPlanGhosts();
  assert.equal(replyEntries, 0, 'pushChatReplyEntry');
  // Search matches only map cards.
  h.view.mapSearch = { query: 'GhostA1', currentId: null };
  assert.deepEqual(plain(h.view.mapSearchResult()?.matches ?? []), [], 'map-search');
  h.view.mapSearch = null;
  // Export reads the cards, texts and edge layer: none is a preview.
  const source = h.view.mapExportSource();
  assert.equal([...source.cards().keys()].length <= 3, true); assert.equal(has([...source.texts()].map(t => dom.texts(t))), false);
  assert.equal(source.edges().some(e => e.hasClass?.('vam-plan-ghost-edge')), false, 'map-export');
  // Share snapshot.
  const snapshot = h.view.shareSnapshot();
  assert.equal(has(typeof snapshot === 'object' ? { map: snapshot.map, notes: [...snapshot.notes.values()].map(n => n.title) } : snapshot), false, 'share-exporter');
  // The plan record gets the state and the result lines only.
  const calls = []; h.view.chatRecordSession.plans.set(card, { plan: (...args) => calls.push(args) });
  card.cancel();
  assert.deepEqual(plain(calls), [['cancelled']], 'map-chat-records');
});

test('E3 cleanup (counter-example): Cancel, Apply, the next message, a map switch and closing the view each leave no preview DOM and no preview state', async () => {
  let o = await planned(); o.card.cancel();
  assert.equal(ghostLayer(o.h), undefined, 'cancelled'); assert.equal(o.h.view.chatPreview, null);
  o = await planned(); o.card.apply(); await until(() => o.h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  assert.equal(ghostLayer(o.h), undefined, 'applied');
  o = await planned(); o.h.control.reply = async () => ({ reply: 'No change', actions: [], rejected: [] });
  await o.h.send('and then?');
  assert.equal(ghostLayer(o.h), undefined, 'superseded by a new message');
  o = await planned();
  o.h.view.map = { ...o.h.view.map, id: 'map-b' }; o.h.view.placeChatPanel = () => {}; o.h.view.syncChatNarrow = () => {};
  o.h.view.mountMapChat(dom.element('div'), dom.element('div'));
  assert.equal(ghostLayer(o.h), undefined, 'map switched'); assert.equal(o.h.view.chatPreview, null);
  o = await planned(); o.h.view.abortMapChat();
  assert.equal(ghostLayer(o.h), undefined, 'view closing (onClose aborts the chat)');
  // A full repaint after the plan is gone draws nothing again.
  o.h.view.paintPlanGhosts(); assert.equal(ghostLayer(o.h), undefined);
});

test('E3 #14 (counter-example): a plan with cards but no anchors keeps the anchors-only shape legal and draws no dots; clearing takes dots and cards together', async () => {
  const { h, card } = await planned();
  assert.deepEqual(plain(h.view.chatPreview.anchors), []); assert.equal(h.view.chatPreview.cards.length, 18);
  assert.equal(dom.findAll(h.view.stageEl, i => i.hasClass('is-preview')).length, 0, 'no dashed dots');
  h.view.chatPreview = { token: h.view.chatPlanToken, anchors: [] };
  h.view.paintPlanGhosts();
  assert.equal(ghostLayer(h), undefined, 'an anchors-only preview draws no cards');
  void card;
});

test('E3 gate: presented or notes still loading greys Apply with a reason, Apply writes nothing then; the map is checked again before the write; Apply writes once', async () => {
  const { h, card } = await planned();
  h.view.presentation = { order: [], currentId: null };
  assert.equal(card.blocked(), 'Apply is off: the map is read-only while it is presented.');
  card.apply(); await new Promise(r => setTimeout(r, 20));
  assert.equal(card.state, 'pending', 'nothing applied'); assert.equal((await h.saved()).nodes.length, 3);
  assert.ok(ghosts(h).length, 'the preview stays while the plan waits');
  h.view.presentation = null;
  const loading = h.view.notesLoading; h.view.notesLoading = () => true;
  assert.equal(card.blocked(), 'Apply is off: the map is read-only until its notes finish loading.');
  h.view.notesLoading = loading;
  // Stale: the plan's map is not the open one.
  const path = h.view.path; h.view.path = 'other.md';
  assert.equal(card.blocked(), 'Apply is off: this plan was made for a map that is no longer open.');
  h.view.path = path;
  assert.equal(card.blocked(), null);
  // Applied once: a second press with the same card does not write again.
  let applied = 0; const real = h.view.applyMapChatActions.bind(h.view);
  h.view.applyMapChatActions = (...args) => { applied++; return real(...args); };
  card.apply(); card.apply();
  await until(() => h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  assert.equal(applied, 1);
  assert.equal((await h.saved()).nodes.length, 21);
});

test('E3 gate: entering and leaving a presentation redraws the waiting plan card', async () => {
  const { h } = await planned();
  h.view.applyPresentationMarks = () => {}; h.view.canPresent = () => true; h.view.presentationOrder = () => [h.ids.root];
  h.view.closeMapSearch = () => {}; h.view.closeTopicChatWindow = () => {}; h.view.stashSelection = () => ({});
  h.view.contentEl.ownerDocument = { activeElement: null };
  h.view.startPresentation();
  assert.ok(h.view.presentation, 'presenting');
  const enter = h.chat.calls.filter(c => c[0] === 'refreshPlan').length;
  assert.equal(enter, 1, 'entering redraws the card');
  h.view.exitPresentation(false);
  assert.equal(h.chat.calls.filter(c => c[0] === 'refreshPlan').length, enter + 1, 'leaving redraws the card');
});

test('E3 gate: a plan waiting while the map\'s notes load is redrawn enabled once loading ends', async () => {
  const { h, card } = await planned();
  h.view.noteLoad = { epoch: 1, read: 0, total: 3, framed: true, pending: new Set(), frameTimer: null, raf: null, isCurrent: () => true };
  assert.equal(card.blocked(), 'Apply is off: the map is read-only until its notes finish loading.');
  const before = h.chat.calls.filter(c => c[0] === 'refreshPlan').length;
  h.view.endNoteLoad();
  assert.equal(card.blocked(), null, 'Apply can be pressed');
  assert.equal(h.chat.calls.filter(c => c[0] === 'refreshPlan').length, before + 1, 'the card is redrawn');
});

test('E3 small actions (counter-example): a reply that needs no confirming is written at once and draws no preview', async () => {
  const h = await harness();
  h.control.reply = async () => ({ reply: 'Done', actions: [child(h.ids.a, 'Small one')], rejected: [] });
  await h.send('add one');
  assert.equal(h.chat.plans.length, 0, 'no plan card');
  assert.equal(ghostLayer(h), undefined, 'no preview');
  await until(async () => (await h.saved()).nodes.length === 4);
  assert.equal(h.view.chatPreview, null);
});

test('E4a question only: the same one card the user did not ask for waits as a plan labelled "You did not ask for changes", drawn dashed; Map.md untouched until Apply', async () => {
  const h = await harness();
  const before = await h.file();
  h.control.reply = async () => ({ reply: 'One card is missing.', actions: [child(h.ids.a, 'Small one')], rejected: [], changeRequested: false });
  await h.send('what is missing here?');
  assert.equal(h.chat.plans.length, 1, 'a plan card');
  assert.deepEqual([...h.chat.plans[0].reasons], ['You did not ask for changes']);
  assert.ok(ghostLayer(h), 'the dashed preview is drawn');
  assert.equal(await h.file(), before, 'Map.md byte for byte');
  assert.equal((await h.saved()).nodes.length, 3);
});

test('E3-x layout (counter-example): two parents previewed at once at 25% zoom: no dashed card crosses another or a card on the canvas, and nothing is written', async () => {
  const { h } = await planned();
  // A card already on the canvas where the first parent's dashed column would go, and measured card sizes, as drawn at 25%.
  const map = h.view.map;
  map.viewport = { ...map.viewport, zoom: 0.25 };
  map.nodes.push({ ...map.nodes.find(n => n.id === h.ids.b), id: 'in-the-way', title: 'In the way', parentId: h.ids.root, x: 760, y: 380 });
  const sized = (w, ht) => Object.assign(dom.element('div'), { offsetWidth: w, offsetHeight: ht });
  h.view.cardEls = new Map(map.nodes.map(n => [n.id, sized(280, 120)]));
  let writes = 0;
  const realApply = h.view.applyMapChatActions.bind(h.view);
  h.view.applyMapChatActions = (...args) => { writes++; return realApply(...args); };
  const realSave = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = (...args) => { writes++; return realSave(...args); };
  const file = await h.file();
  const before = JSON.stringify(map.nodes);
  h.view.paintPlanGhosts();
  const px = v => Number(String(v).replace('px', ''));
  const rect = el => {
    const l = px(el.style.left), t = px(el.style.top);
    return { l, t, r: l + px(el.style.width), b: t + px(el.style.height || el.style.minHeight) };
  };
  const ghostRects = ghosts(h).map(rect);
  const cardRects = map.nodes.map(n => ({ l: n.x, t: n.y, r: n.x + 280, b: n.y + 120 }));
  const cross = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  assert.equal(ghostRects.length, 12);
  for (let i = 0; i < ghostRects.length; i++)
    for (let j = i + 1; j < ghostRects.length; j++)
      assert.equal(cross(ghostRects[i], ghostRects[j]), false, `ghost ${i} crosses ghost ${j}: ${JSON.stringify([ghostRects[i], ghostRects[j]])}`);
  for (const [i, g] of ghostRects.entries())
    for (const [j, c] of cardRects.entries())
      assert.equal(cross(g, c), false, `ghost ${i} crosses card ${map.nodes[j].id}: ${JSON.stringify([g, c])}`);
  assert.equal(writes, 0, 'the preview writes nothing');
  assert.equal(await h.file(), file, 'Map.md unchanged');
  assert.equal(JSON.stringify(map.nodes), before, 'no card on the map moved');
});

test('E3-x layout: with a card in the way the dashed cards step past it in any arrangement (radial too); a planned card under a planned card and the lines follow', () => {
  const N = (id, parentId, x, y) => ({ id, parentId, x, y, width: 280, title: id, path: `${id}.md` });
  const nodes = [N('p', null, 0, 0), N('w', null, 360, 0)];
  const boxes = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y, width: 280, height: 100 }]));
  const specs = [{ parentId: 'p', title: 'P1', ref: 'p1' }, { parentId: 'new:p1', title: 'Under P1' }];
  const cross = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const direction of ['right', 'radial']) {
    const layout = preview.planGhostLayout(specs, boxes, () => [], [{ fromId: 'w', toId: 'new:p1' }], {
      nodes, boxOf: id => (boxes.has(id) ? { dx: 0, dy: 0, w: 280, h: 100 } : undefined), direction, gap: 24
    });
    assert.equal(layout.cards.length, 2, direction);
    for (const card of layout.cards) for (const box of boxes.values()) assert.equal(cross(card, box), false, `${direction}: ${card.title}`);
    assert.equal(cross(layout.cards[0], layout.cards[1]), false, direction);
    const [p1] = layout.cards;
    assert.deepEqual(plain(layout.edges[0].to), { x: p1.x, y: p1.y + p1.height / 2 }, `${direction}: the parent line reaches the moved card`);
    assert.equal(layout.relations.length, 1);
    assert.ok([p1.x, p1.x + p1.width].includes(layout.relations[0].to.x), `${direction}: the relation reaches the moved card`);
  }
  assert.equal(nodes[1].x, 360, 'no card on the canvas moves');
});

test('E3-y stale (counter-example): a target card\'s note changed after the proposal: Apply is refused, greyed with the reason, 0 writes', async () => {
  const { h, card } = await planned();
  let writes = 0; const real = h.view.applyMapChatActions.bind(h.view);
  h.view.applyMapChatActions = (...args) => { writes++; return real(...args); };
  const file = await h.file();
  const target = h.app.vault.getAbstractFileByPath(h.view.map.nodes.find(n => n.id === h.ids.a).path);
  await h.app.vault.process(target, text => text + '\nuser edit after the proposal\n');
  card.apply(); await new Promise(r => setTimeout(r, 30));
  assert.equal(writes, 0, 'no write at all');
  assert.equal(card.state, 'pending', 'the plan is not applied');
  assert.equal(card.blocked(), 'Apply is off: a target card was changed after this proposal. Send your message again to get a new one.');
  assert.equal((await h.saved()).nodes.length, 3);
  assert.equal(await h.file(), file, 'Map.md untouched');
  assert.ok(h.chat.calls.some(c => c[0] === 'refreshPlan'), 'the card is drawn again with the reason');
});

test('E3-y stale: with the targets unchanged (and a card the plan does not name edited) Apply writes', async () => {
  const h = await harness();
  const actions = [];
  for (let i = 1; i <= 16; i++) actions.push(child(h.ids.a, `OnlyA${i}`));
  h.control.reply = async () => ({ reply: 'Plan', actions, rejected: [] });
  await h.send('add many');
  const card = h.chat.plans[0];
  const b = h.app.vault.getAbstractFileByPath(h.view.map.nodes.find(n => n.id === h.ids.b).path);
  await h.app.vault.process(b, text => text + '\nunrelated edit\n');
  card.apply();
  await until(() => h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  assert.equal(card.state, 'applied');
  assert.equal((await h.saved()).nodes.length, 19);
});

test('E3-y merge: a card of the plan is merging: Apply is greyed with the reason and writes nothing; when the merge ends it can be pressed', async () => {
  const { h, card } = await planned();
  let writes = 0; const real = h.view.applyMapChatActions.bind(h.view);
  h.view.applyMapChatActions = (...args) => { writes++; return real(...args); };
  h.view.mergeDrafts.tasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: h.ids.a }, { id: h.ids.b }] });
  assert.equal(card.blocked(), 'Merging; try again when it finishes');
  card.apply(); await new Promise(r => setTimeout(r, 30));
  assert.equal(writes, 0); assert.equal(card.state, 'pending'); assert.equal((await h.saved()).nodes.length, 3);
  h.view.mergeDrafts.tasks.clear();
  assert.equal(card.blocked(), null);
  card.apply();
  await until(() => h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  assert.equal(card.state, 'applied'); assert.equal(writes, 1);
  assert.equal((await h.saved()).nodes.length, 21);
});

test('E3-y merge (counter-example): a merge of cards the plan does not name leaves Apply on', async () => {
  const { h, card } = await planned();
  h.view.mergeDrafts.tasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: 'unrelated' }] });
  assert.equal(card.blocked(), null);
});
