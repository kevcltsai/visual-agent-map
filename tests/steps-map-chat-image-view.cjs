// Map chat with a selected canvas image, P3 (A5 and the Critical Path): the view's write path for add_anchor and link_anchor,
// the picture selection of the chat, and how a send reads, fits and carries the picture. A fake runner returns fixed replies;
// the contract (parser, plan rules) is tested in steps-map-chat-image.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, fixture, DEFAULT_SETTINGS, normalizeReasoningLevel, obsidian, core, plain, withExpansionCoordinator, deferred, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const DATA_URL = /data:image\//;
const anchorOf = (id, x = 0.5, y = 0.5, note) => ({ id, at: { kind: 'image-2d', x, y }, ...(note ? { note } : {}) });
const ANNOTATED = (over = {}) => ({ id: 'img1', kind: 'annotated-image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, note: 'Cow cuts', anchors: [], ...over });
const PLAIN = (over = {}) => ({ id: 'img2', kind: 'image', path: 'attachments/b.png', x: 0, y: 300, w: 200, h: 100, ...over });

/** A fake chat panel: the calls the send makes, recorded, with the busy state a real turn has. */
function fakeChat(control) {
  const chat = {
    draft: '', isBusy: false, marks: [], calls: [], turnsList: [], plans: [], lines: [], transcript: [],
    attachments: () => [], currentNote: () => null, turns: () => [], pendingPlan: () => chat.plans.find(p => p.state === 'pending') ?? null,
    begin(message, origin, again, stage) { chat.isBusy = true; const turn = { message, origin }; chat.turnsList.push(turn); chat.transcript.push({ role: 'user', text: message, origin }); chat.calls.push(['begin', message, stage]); return turn; },
    hasTurn: turn => chat.turnsList.includes(turn),
    retract(turn, draft) { if (!chat.turnsList.includes(turn)) return false; chat.turnsList.splice(chat.turnsList.indexOf(turn), 1); chat.isBusy = false; chat.calls.push(['retract', draft]); if (draft !== undefined) chat.draft = draft; return true; },
    setStage: stage => chat.calls.push(['stage', stage]), clearSlow() {}, showSlow() {}, restartWaiting() {}, streamReply() {},
    finish(reply, lines) { chat.isBusy = false; chat.lines.push(lines); chat.transcript.push({ role: 'assistant', text: reply, lines }); chat.calls.push(['finish', reply]); },
    fail(text) { chat.isBusy = false; chat.calls.push(['fail', text]); },
    markStopped() { chat.isBusy = false; chat.calls.push(['stopped']); },
    showPlan(card) { chat.plans.push(card); chat.calls.push(['plan']); },
    settlePlan(card, state, lines) { card.state = state; chat.calls.push(['settle', state]); if (lines) chat.lines.push(lines); },
    markTurn(extra) { chat.marks.push(extra); }, refreshReplyUndo() {},
    takeQueued: () => [], takeSteerTexts: () => [], addSteer: () => ({}), setSteerState() {}, restoreDraft(texts) { chat.calls.push(['restore', texts]); },
    setApplying() {}, focusInput() {}, reset() {}
  };
  return chat;
}

async function harness({ items, caps = { imageInput: { maxEdgePx: 1568, maxBytes: 5 * 1024 * 1024 } }, uuids = [] } = {}) {
  const { repo, app, contents, files } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'claude:sonnet' };
  repo.settings = settings;
  const doc = { id: 'map-a', title: 'Cuts', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(doc));
  const ids = {};
  const add = async (key, title, parent) => {
    const n = await repo.createNote(title, 'gpt-6-luna', doc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(n, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + doc.nodes.length * 200 });
    doc.nodes.push(n); ids[key] = n.id;
  };
  await add('root', 'Beef'); await add('a', 'Ribeye', 'root'); await add('b', 'Filet', 'root');
  doc.canvasItems = items ?? [ANNOTATED({ anchors: [anchorOf('old1', 0.1, 0.1, 'Chuck')] }), PLAIN()];
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  const control = { reads: 0, readGate: null, missing: new Set(), requests: [], confirms: 0, calls: [], reply: async () => ({ reply: 'ok', actions: [], rejected: [] }), caps, queue: [...uuids] };
  for (const path of ['attachments', 'attachments/a.png', 'attachments/b.png']) {
    if (path.endsWith('.png')) await app.vault.createBinary(path, PNG.buffer);
    else await app.vault.createFolder(path);
  }
  app.vault.readBinary = async file => { control.reads++; if (control.readGate) await control.readGate; if (control.readFails) throw new Error('disk gone'); return PNG.buffer; };
  const notices = [];
  const fakeCrypto = { ...crypto, randomUUID: () => control.queue.length ? control.queue.shift() : crypto.randomUUID() };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) }, 'node:crypto': fakeCrypto }, {
    requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {},
    // A picture that always loads, 4 x 4, so fitImageForInput leaves a small data URL alone.
    createEl: tag => tag === 'img' ? { set src(v) { this._src = v; Promise.resolve().then(() => this.onload?.()); }, naturalWidth: 4, naturalHeight: 4 } : { getContext: () => null }
  });
  let queue = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), releaseOutline() {}, syncOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    activeTasks: new Map(), quickExpandPending: new Set(), abortChartJobs() {}, addChartsAfterWrite() {}, views: () => [], modelLabel: id => id,
    currentModelChoice() { return { model: this.settings.cliModel, reasoning: normalizeReasoningLevel(this.settings.cliReasoning) }; },
    aiCalls: { capabilitiesFor: () => control.caps },
    // Like main.ts: a write made inside mutate() raises `writing`, and a vault modify event is passed to the view only when it is 0.
    writing: 0,
    mutate(work) { queue = queue.then(async () => { plugin.writing++; try { await work(); } finally { plugin.writing--; } }); return queue; },
    confirmAiUsage: async (model, run) => { control.confirms++; control.calls.push('confirm'); await run(); return true; },
    mapChat: { chat: async (request, signal, onReply, onProgress) => { control.calls.push('chat'); control.requests.push(request); return control.reply(request, signal, onReply, onProgress); } }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  // The outside-edit path of the view (changed() reloads the map and clears the history), recorded instead of run.
  control.outsideEdits = [];
  view.changed = file => control.outsideEdits.push(file.path);
  for (const name of ['modify', 'process']) {
    const original = app.vault[name]?.bind(app.vault);
    if (original) app.vault[name] = async (file, ...rest) => { const result = await original(file, ...rest); if (!plugin.writing) view.changed(file); return result; };
  }
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.render = () => {}; view.focusNode = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {}; view.fit = () => {}; view.relocateMapChat = () => {};
  const chat = fakeChat(control);
  view.chat = chat;
  await view.hydrate();
  const saved = async () => repo.readMap(MAP);
  /** Changes the canvas items on disk and in the view (an edit made outside the chat, before it applies). */
  const edit = async change => { const next = await repo.readMap(MAP); next.canvasItems = change(next.canvasItems); await repo.saveMap(MAP, next); view.map = await repo.readMap(MAP); };
  const image = async (id = 'img1') => (await saved()).canvasItems.find(i => i.id === id);
  const apply = async actions => (await view.applyMapChatActions({ actions, rejected: [] }, { mdHashes: {}, topicHashes: {} }));
  const select = id => { view.chatImageId = id; };
  const send = async text => { chat.draft = text; await view.sendMapChat(); };
  return { repo, app, contents, files, doc, ids, control, view, chat, plugin, notices, saved, edit, image, apply, select, send };
}

const statuses = lines => plain(lines.map(l => l.status));
const addAnchor = (ref, x, y, note = '', imageId = 'img1') => ({ kind: 'add_anchor', imageId, ref, x, y, note });
const link = (anchorId, nodeId, relationKind = 'related', extra = {}, imageId = 'img1') => ({ kind: 'link_anchor', imageId, anchorId, nodeId, relationKind, ...extra });

test('A5 write: add_anchor and link_anchor place anchors with view-made ids, create new:<ref> topics first, link from the anchor to the topic', async () => {
  const h = await harness();
  const lines = await h.apply([
    addAnchor('p1', 0.2, 0.3, 'Ribeye cap'),
    addAnchor('p2', 0.7, 0.8),
    { kind: 'add_child', parentId: h.ids.root, title: 'Marbling', ref: 'n1' },
    link('anchor:p1', 'new:n1'),
    link('anchor:p2', h.ids.a, 'supports', { description: 'same cut' }),
    link('old1', h.ids.b, 'verifies')
  ]);
  assert.deepEqual(statuses(lines), ['done', 'done', 'done', 'done', 'done', 'done'], JSON.stringify(lines));
  const img = await h.image();
  assert.equal(img.anchors.length, 3);
  const [, p1, p2] = img.anchors;
  assert.match(p1.id, /^anc-[0-9a-f]{8}$/); assert.match(p2.id, /^anc-[0-9a-f]{8}$/); assert.notEqual(p1.id, p2.id);
  assert.deepEqual(plain(p1), { id: p1.id, at: { kind: 'image-2d', x: 0.2, y: 0.3 }, note: 'Ribeye cap' });
  assert.equal(p2.note, undefined, 'an empty note is no note');
  const marbling = (await h.saved()).nodes.find(n => n.id !== h.ids.root && ![h.ids.a, h.ids.b].includes(n.id));
  assert.ok(marbling, 'the new topic was created');
  assert.deepEqual(plain(img.relations), [
    { kind: 'related', from: p1.id, to: marbling.id },
    { kind: 'supports', from: p2.id, to: h.ids.a, description: 'same cut' },
    { kind: 'verifies', from: 'old1', to: h.ids.b }
  ]);
});

test('A5 undo: the whole reply is one step labelled "AI chat reply"; undo removes anchors, relations and the new topic, redo brings all back; a reopened map still has them', async () => {
  const h = await harness();
  const before = plain(await h.saved());
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'earlier' });
  await h.apply([addAnchor('p1', 0.2, 0.3, 'A'), addAnchor('p2', 0.4, 0.4, 'B'), { kind: 'add_child', parentId: h.ids.root, title: 'Marbling', ref: 'n1' }, link('anchor:p1', 'new:n1'), link('anchor:p2', h.ids.a)]);
  const after = plain(await h.saved());
  assert.equal(h.view.history.undoEntry.label, 'AI chat reply');
  assert.equal(h.view.isNewestUndoStep(h.view.chatReplyEntry()), true, 'the reply step is the newest undo step');
  // Reopen: what is on disk parses back with the anchors and relations (parseMap and sanitize keep them).
  const reopened = await h.repo.readMap(MAP);
  assert.equal(reopened.canvasItems.find(i => i.id === 'img1').anchors.length, 3);
  assert.equal(reopened.canvasItems.find(i => i.id === 'img1').relations.length, 2);
  await h.view.travel(false);
  assert.deepEqual(plain(await h.saved()), before, 'one undo takes back anchors, relations and the topic');
  assert.equal(h.view.history.undoEntry.label, 'earlier', 'only the reply was undone');
  await h.view.travel(true);
  assert.deepEqual(plain(await h.saved()), after, 'redo brings every part back');
});

test('A5 skip: a picture that was deleted, turned back into an ordinary one, a full picture, an existing pair and a topic that was never created skip only their own item', async () => {
  // deleted
  let h = await harness();
  await h.edit(items => items.filter(i => i.id !== 'img1'));
  let lines = await h.apply([addAnchor('p1', 0.2, 0.2, 'A'), { kind: 'add_child', parentId: h.ids.root, title: 'Kept', ref: 'n1' }, link('anchor:p1', h.ids.a)]);
  assert.deepEqual(statuses(lines), ['skipped', 'done', 'skipped'], JSON.stringify(lines));
  assert.match(lines[0].text, /no longer on the canvas/); assert.match(lines[2].text, /no longer on the canvas/);
  assert.equal((await h.saved()).nodes.length, 4, 'the topic of the same reply was still made');
  // turned back into an ordinary image
  h = await harness();
  await h.edit(items => items.map(i => i.id === 'img1' ? { id: 'img1', kind: 'image', path: i.path, x: i.x, y: i.y, w: i.w, h: i.h } : i));
  lines = await h.apply([addAnchor('p1', 0.2, 0.2, 'A'), link('old1', h.ids.a)]);
  assert.deepEqual(statuses(lines), ['skipped', 'skipped']); assert.match(lines[0].text, /no longer an annotated image/);
  // full
  h = await harness({ items: [ANNOTATED({ anchors: Array.from({ length: 200 }, (_, i) => anchorOf(`f${i}`, 0.5, 0.5)) })] });
  lines = await h.apply([addAnchor('p1', 0.2, 0.2, 'A'), link('f0', h.ids.a)]);
  assert.deepEqual(statuses(lines), ['skipped', 'done'], JSON.stringify(lines)); assert.match(lines[0].text, /most anchors/);
  assert.equal((await h.image()).anchors.length, 200);
  // a pair that already has a relation (either direction), then a topic of this reply that was never created
  h = await harness({ items: [ANNOTATED({ anchors: [anchorOf('old1', 0.1, 0.1, 'Chuck')] })] });
  await h.edit(items => items.map(i => ({ ...i, relations: [{ kind: 'related', from: h.ids.a, to: 'old1' }] })));
  lines = await h.apply([link('old1', h.ids.a, 'supports'), { kind: 'add_child', parentId: 'gone-parent', title: 'Lost', ref: 'n9' }, link('old1', 'new:n9'), link('old1', h.ids.b)]);
  assert.deepEqual(statuses(lines), ['skipped', 'skipped', 'skipped', 'done'], JSON.stringify(lines));
  assert.match(lines[0].text, /does not allow that relation/);
  assert.equal((await h.image()).relations.length, 2, 'only the last link was written');
});

test('A5 skip: an anchor of this reply that was skipped cannot be linked; an unknown anchor id is skipped', async () => {
  const h = await harness({ items: [ANNOTATED({ anchors: Array.from({ length: 200 }, (_, i) => anchorOf(`f${i}`)) })] });
  const lines = await h.apply([addAnchor('p1', 0.2, 0.2, 'A'), link('anchor:p1', h.ids.a), link('nope', h.ids.a)]);
  assert.deepEqual(statuses(lines), ['skipped', 'skipped', 'skipped'], JSON.stringify(lines));
  assert.match(lines[1].text, /anchor is no longer/);
});

test('A5 ids: a made id that collides with a topic id or an anchor of the picture is not used', async () => {
  const h = await harness({ uuids: ['old10000-x', 'aaaaaaaa-x', 'aaaaaaaa-x', 'bbbbbbbb-x'] });
  // The first candidate is an anchor that is there already, the second is used by p1, so p2 draws it again and must take the third.
  await h.edit(items => items.map(i => i.id === 'img1' ? { ...i, anchors: [...i.anchors, anchorOf('anc-old10000', 0.3, 0.3, 'taken')] } : i));
  await h.apply([addAnchor('p1', 0.2, 0.2, 'A'), addAnchor('p2', 0.4, 0.4, 'B')]);
  const ids = plain((await h.image()).anchors.map(a => a.id));
  assert.deepEqual(ids, ['old1', 'anc-old10000', 'anc-aaaaaaaa', 'anc-bbbbbbbb'], 'the taken candidate and the repeated one were both skipped');
});

test('A5 lock: link_anchor to an AI-locked topic is skipped, the anchor itself is still placed', async () => {
  const h = await harness();
  await h.view.setAiLock([h.view.map.nodes.find(n => n.id === h.ids.a)], true);
  const lines = await h.apply([addAnchor('p1', 0.2, 0.2, 'A'), link('anchor:p1', h.ids.a), link('anchor:p1', h.ids.b)]);
  assert.deepEqual(statuses(lines), ['done', 'skipped', 'done'], JSON.stringify(lines));
  assert.equal((await h.image()).relations.length, 1);
});

// ---- the send: reading the picture, the request, the abandon paths ----------------------------------------------------

const asked = h => h.control.calls.filter(c => c === 'chat' || c === 'confirm');
const anchorAction = [addAnchor('p1', 0.25, 0.5, 'Ribeye')];

test('send: no picture selected, the request is the one it is today (no selectedImage in the context, no imageDataUrl, no image read)', async () => {
  const h = await harness();
  await h.send('hello');
  const request = h.control.requests[0];
  assert.equal(h.control.reads, 0);
  assert.equal('imageDataUrl' in request, false);
  assert.equal(request.context.selectedImage, undefined);
  assert.equal(request.context.json.includes('selectedImage'), false);
  assert.equal('imageId' in h.chat.transcript[0].origin, false, 'origin has no picture');
});

test('send: a selected annotated image goes with its words in the context and its picture as imageDataUrl; origin keeps only the id', async () => {
  const h = await harness();
  h.select('img1');
  await h.send('place anchors');
  const request = h.control.requests[0];
  assert.match(request.imageDataUrl, /^data:image\/png;base64,/);
  const sent = JSON.parse(request.context.json).selectedImage;
  assert.deepEqual(plain(sent), { id: 'img1', kind: 'annotated-image', note: 'Cow cuts', anchors: [{ id: 'old1', x: 0.1, y: 0.1, note: 'Chuck' }], relations: [], imageAttached: true });
  assert.equal(request.context.json.includes('data:image'), false, 'the picture is not in the prompt text');
  assert.equal(h.chat.transcript[0].origin.imageId, 'img1');
  assert.equal(JSON.stringify(h.chat.transcript[0].origin).includes('data:image'), false);
  assert.equal(request.context.selectedImage.kind, 'annotated');
});

test('send: a selected ordinary image sends only that it is ordinary, no picture, no read', async () => {
  const h = await harness();
  h.select('img2');
  await h.send('what is this');
  const request = h.control.requests[0];
  assert.equal(h.control.reads, 0);
  assert.equal('imageDataUrl' in request, false);
  assert.deepEqual(plain(JSON.parse(request.context.json).selectedImage), { id: 'img2', kind: 'image', imageAttached: false });
});

test('send D5: a picture that cannot be read abandons the turn with a Notice: no AI call, the draft is back', async () => {
  const h = await harness();
  h.select('img1'); h.control.readFails = true;
  await h.send('place anchors');
  assert.deepEqual(asked(h), [], 'no usage notice and no request');
  assert.equal(h.chat.draft, 'place anchors', 'the draft is back in the field');
  assert.equal(h.chat.isBusy, false);
  assert.equal(h.chat.turnsList.length, 0, 'the messages were taken back');
  assert.deepEqual(plain(h.notices), ['The selected picture could not be read. Nothing was sent.']);
  // A file that is not there at all
  const g = await harness(); g.select('img1'); g.files.delete('attachments/a.png');
  await g.send('x'); assert.deepEqual(asked(g), []); assert.equal(g.chat.draft, 'x');
});

test('send: a runtime without image input abandons the turn with a Notice (nothing read, nothing sent)', async () => {
  const h = await harness({ caps: {} });
  h.select('img1');
  await h.send('place anchors');
  assert.deepEqual(asked(h), []); assert.equal(h.control.reads, 0); assert.equal(h.chat.draft, 'place anchors');
  assert.deepEqual(plain(h.notices), ['This model cannot read pictures. Pick another model or select no picture. Nothing was sent.']);
});

test('send: Stop while the picture is being prepared abandons the turn: no AI call, draft back, the late read changes nothing', async () => {
  const h = await harness();
  h.select('img1');
  const gate = deferred(); h.control.readGate = gate.promise;
  h.chat.draft = 'place anchors';
  const sending = h.view.sendMapChat();
  await until(() => h.control.reads === 1);
  h.view.stopMapChat();
  assert.equal(h.chat.draft, 'place anchors', 'taken back at once');
  gate.resolve();
  await sending;
  assert.deepEqual(asked(h), [], 'no usage notice, no request');
  assert.deepEqual(plain(h.notices), [], 'Stop is the user\'s own act: no Notice');
  assert.equal(h.chat.calls.filter(c => c[0] === 'retract').length, 1);
});

test('send: a reply that arrives after Stop writes nothing', async () => {
  const h = await harness();
  h.select('img1');
  const reply = deferred(); h.control.reply = () => reply.promise;
  h.chat.draft = 'place anchors';
  const sending = h.view.sendMapChat();
  await until(() => h.control.requests.length === 1);
  h.view.stopMapChat();
  reply.resolve({ reply: 'done', actions: anchorAction, rejected: [] });
  await sending;
  assert.equal((await h.image()).anchors.length, 1, 'no anchor was written');
  assert.equal(h.chat.plans.length, 0, 'and no plan was offered');
});

test('send (M9): Stop, then a second message at once, then the first reply comes back late: the first writes nothing and offers no plan; the second is untouched', async () => {
  for (const imageMode of ['direct', 'preview']) {
    const h = await harness();
    h.plugin.settings.mapChatImageMode = imageMode;
    h.select('img1');
    const replies = [deferred(), deferred()];
    h.control.reply = () => replies[h.control.requests.length - 1].promise;
    h.chat.draft = 'first';
    const first = h.view.sendMapChat();
    await until(() => h.control.requests.length === 1);
    h.view.stopMapChat();
    h.chat.draft = 'second';
    const second = h.view.sendMapChat();
    await until(() => h.control.requests.length === 2);
    replies[0].resolve({ reply: 'late', actions: [...anchorAction, link('anchor:p1', h.ids.a)], rejected: [] });
    await first;
    assert.equal((await h.image()).anchors.length, 1, `${imageMode}: the first reply wrote no anchor`);
    assert.equal(h.chat.plans.length, 0, `${imageMode}: and offered no plan`);
    assert.equal(h.view.history.undoEntry, undefined, `${imageMode}: no undo step`);
    assert.equal(h.chat.calls.some(c => c[0] === 'finish' && c[1] === 'late'), false, 'the late text is not shown');
    replies[1].resolve({ reply: 'second answer', actions: [], rejected: [] });
    await second;
    assert.equal(h.chat.calls.some(c => c[0] === 'finish' && c[1] === 'second answer'), true, 'the second message finishes normally');
  }
});

test('send: a retry reads the picture again (origin carries only the id)', async () => {
  const h = await harness();
  h.select('img1');
  await h.send('place anchors');
  const origin = h.chat.transcript[0].origin;
  h.view.chatImageId = null; // the selection moved on; the retry is about the same picture
  await h.view.sendMapChat(origin);
  assert.equal(h.control.reads, 2);
  assert.match(h.control.requests[1].imageDataUrl, /^data:image\//);
});

// ---- plan and mode -------------------------------------------------------------------------------------------------

test('plan: "show me first" offers a plan for anchors and writes nothing; Apply writes them; the picture and its data URL are in no card, line or transcript', async () => {
  const h = await harness();
  h.select('img1');
  h.control.reply = async () => ({ reply: 'Here are anchors', actions: [...anchorAction, { kind: 'add_child', parentId: h.ids.root, title: 'Marbling', ref: 'n1' }, link('anchor:p1', 'new:n1')], rejected: [] });
  await h.send('place anchors');
  assert.equal(h.chat.plans.length, 1);
  const card = h.chat.plans[0];
  assert.deepEqual(plain(card.reasons), ['Places or links anchors on the picture. Check it first.']);
  assert.equal((await h.image()).anchors.length, 1, 'nothing written yet');
  card.apply();
  await until(() => h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  assert.equal((await h.image()).anchors.length, 2);
  assert.equal((await h.image()).relations.length, 1);
  for (const part of [h.chat.transcript, h.chat.plans.map(c => ({ ...c, apply: undefined, cancel: undefined })), h.chat.lines, h.chat.calls]) assert.equal(DATA_URL.test(JSON.stringify(part)), false);
  assert.equal(DATA_URL.test(JSON.stringify(h.view.history.undoEntry)), false);
});

test('plan: "apply at once" writes at once when the reply only places anchors', async () => {
  const h = await harness();
  h.select('img1'); h.view.chatImageMode = () => 'direct';
  h.control.reply = async () => ({ reply: 'Placed', actions: anchorAction, rejected: [] });
  await h.send('place anchors');
  assert.equal(h.chat.plans.length, 0);
  assert.equal((await h.image()).anchors.length, 2);
  assert.equal(h.view.history.undoEntry.label, 'AI chat reply');
});

test('plan A4 (counter-example): a turn that sent a picture and also asks for delete_topic or edit_md_file gets a plan even in "apply at once"; a turn without a picture does not', async () => {
  for (const [action, reason] of [[{ kind: 'delete_topic', nodeId: 'x', branch: false }, 'image_other_actions'], [{ kind: 'rename_topic', nodeId: 'x', title: 'No' }, 'image_other_actions']]) {
    const h = await harness();
    h.select('img1'); h.view.chatImageMode = () => 'direct';
    h.control.reply = async () => ({ reply: 'r', actions: [{ ...action, nodeId: h.ids.a }], rejected: [] });
    await h.send('go');
    assert.equal(h.chat.plans.length, 1, action.kind);
    assert.match(h.chat.plans[0].reasons[0], /came with a picture/);
    assert.equal((await h.saved()).nodes.find(n => n.id === h.ids.a) !== undefined, true, 'nothing was changed');
  }
  const h = await harness();
  h.view.chatImageMode = () => 'direct';
  h.control.reply = async () => ({ reply: 'r', actions: [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Rib' }], rejected: [] });
  await h.send('go');
  assert.equal(h.chat.plans.length, 0, 'no picture sent: the rule of today (applied at once)');
});

test('plan: a picture deleted while the plan waits skips its anchors on Apply, the rest of the plan still runs', async () => {
  const h = await harness();
  h.select('img1');
  h.control.reply = async () => ({ reply: 'plan', actions: [...anchorAction, { kind: 'add_child', parentId: h.ids.root, title: 'Marbling', ref: 'n1' }, link('anchor:p1', 'new:n1')], rejected: [] });
  await h.send('place');
  const card = h.chat.plans[0];
  await h.edit(items => items.filter(i => i.id !== 'img1'));
  card.apply();
  await until(() => h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  const lines = h.chat.lines.at(-1);
  assert.deepEqual(statuses(lines.filter(l => l.text.startsWith('Skipped') || l.text.startsWith('Done'))), ['skipped', 'done', 'skipped'], JSON.stringify(lines));
  assert.equal((await h.saved()).nodes.length, 4, 'the new topic was made');
});

// ---- the picture selection of the chat (D7) -----------------------------------------------------------------------

test('D7 selection: chatImage() names the selected picture; a card choice, Esc, a delete and a map switch clear it; a listener hears each change', async () => {
  const h = await harness();
  const heard = []; const stop = h.view.watchChatImage(() => heard.push(h.view.chatImage()?.id ?? null));
  h.view.setChatImage('img1');
  assert.deepEqual(plain(h.view.chatImage()), { id: 'img1', kind: 'annotated', note: 'Cow cuts', name: 'a.png' });
  h.view.setChatImage('img2');
  assert.deepEqual(plain(h.view.chatImage()), { id: 'img2', kind: 'plain', note: '', name: 'b.png' });
  h.view.applySelectionChange({ touched: [h.ids.a], multiSelectModeChanged: false, relationChanged: false });
  assert.equal(h.view.chatImage(), null, 'choosing a card clears it');
  h.view.setChatImage('img1'); h.view.clearChatImage();
  assert.equal(h.view.chatImage(), null);
  h.view.setChatImage('img2');
  await h.view.removeCanvasItem('img2');
  assert.equal(h.view.chatImage(), null, 'deleting the picture clears it');
  h.view.setChatImage('img1');
  await h.edit(items => items.filter(i => i.id !== 'img1'));
  assert.equal(h.view.chatImage(), null, 'a picture that is gone from the map is not selected');
  stop(); h.view.setChatImage('img1'); h.view.clearChatImage();
  assert.deepEqual(plain(heard), ['img1', 'img2', null, 'img1', null, 'img2', null, 'img1'].slice(0, heard.length));
  assert.ok(heard.length >= 6);
});

test('D7 selection: a picture that is gone when the message is sent is simply not part of the request', async () => {
  const h = await harness();
  h.select('img1');
  await h.edit(items => items.filter(i => i.id !== 'img1'));
  await h.send('hello');
  assert.equal(h.control.reads, 0); assert.equal(h.control.requests[0].context.selectedImage, undefined);
});

// ---- P4a: the chat panel's switch, "AI looked at this picture" and "Undo this reply" (the view side) ----------------------------
const placeAnchor = [addAnchor('p1', 0.6, 0.6, 'Brisket')];

test('P4a mode: chatImageMode reads the setting (preview unless "direct"); the host switch remembers it at once', async () => {
  const h = await harness();
  let saves = 0; h.plugin.saveSettings = async () => { saves++; };
  const host = h.view.chatHost();
  assert.equal(host.imageMode(), 'preview');
  host.setImageMode('direct');
  assert.equal(h.plugin.settings.mapChatImageMode, 'direct'); assert.equal(saves, 1, 'saved right after the switch');
  assert.equal(host.imageMode(), 'direct');
  host.setImageMode('direct'); assert.equal(saves, 1, 'no change, no save');
  h.plugin.settings.mapChatImageMode = 'rubbish'; assert.equal(host.imageMode(), 'preview', 'an unknown value reads as the default');
  h.select('img1'); assert.equal(host.image().id, 'img1');
});

test('P4a seen: only a turn that really sent a picture is marked "seen", with the words (or the file name when there are none); the next turn without a picture is not', async () => {
  const h = await harness();
  h.control.reply = async () => ({ reply: 'No change', actions: [], rejected: [] });
  h.select('img1'); await h.send('look');
  assert.deepEqual(plain(h.chat.marks), [{ seenImage: { note: 'Cow cuts' } }], 'preview mode: seen only, no undo button');
  await h.edit(items => items.map(i => i.id === 'img1' ? { ...i, note: '' } : i));
  await h.send('look again');
  assert.deepEqual(plain(h.chat.marks.at(-1)), { seenImage: { note: 'a.png' } });
  h.select('img2'); await h.send('ordinary'); // an ordinary picture is never sent as a picture
  h.view.clearChatImage(); await h.send('no picture');
  assert.equal(h.chat.marks.length, 2, 'ordinary picture and no picture: no seen line');
});

test('P4a undo: "apply at once" gives the turn the undo step of its reply; "show me first" never does, nor does a reply that wrote nothing', async () => {
  const h = await harness();
  h.plugin.settings.mapChatImageMode = 'direct'; h.select('img1');
  h.control.reply = async () => ({ reply: 'Placed', actions: placeAnchor, rejected: [] });
  await h.send('place');
  const mark = h.chat.marks.at(-1);
  assert.equal(mark.replyUndo.token, h.view.history.undoEntry, 'the token is the reply step');
  assert.equal(h.view.chatHost().replyUndoState(mark.replyUndo.token), 'top');
  h.control.reply = async () => ({ reply: 'Nothing to do', actions: [], rejected: [] });
  await h.send('again');
  assert.equal(h.chat.marks.at(-1).replyUndo, undefined, 'a reply that wrote nothing has no button');
  const p = await harness(); p.select('img1');
  p.control.reply = async () => ({ reply: 'Placed', actions: placeAnchor, rejected: [] });
  await p.send('place');
  assert.equal(p.chat.plans.length, 1); assert.equal(p.chat.marks.every(m => m.replyUndo === undefined), true, 'preview mode: no button');
  assert.equal(p.view.history.undoEntry, undefined);
});

test('P4a undo (counter-example): the button undoes one step only while the reply is the newest step; otherwise nothing changes and a Notice says how', async () => {
  const h = await harness();
  h.plugin.settings.mapChatImageMode = 'direct'; h.select('img1');
  h.control.reply = async () => ({ reply: 'Placed', actions: placeAnchor, rejected: [] });
  await h.send('place');
  const host = h.view.chatHost(); const token = h.chat.marks.at(-1).replyUndo.token;
  const placed = plain(await h.saved());
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'later edit' });
  assert.equal(host.replyUndoState(token), 'other');
  assert.equal(await host.undoReply(token), 'later');
  assert.deepEqual(plain(await h.saved()), placed, 'data is unchanged');
  assert.equal(h.view.history.undoEntry.label, 'later edit', 'no undo step was taken');
  assert.deepEqual(plain(h.notices), ['Other changes came after this reply. Press Cmd/Ctrl+Z to undo them in order.']);
  // The later step goes away by hand: now the reply is on top and the button works.
  await h.view.travel(false);
  assert.equal(host.replyUndoState(token), 'top');
  assert.equal(await host.undoReply(token), 'undone');
  assert.equal((await h.image()).anchors.length, 1, 'the anchor of the reply is gone');
  assert.equal(host.replyUndoState(token), 'undone', 'undone: the button is disabled');
  assert.equal(await host.undoReply(token), 'later'); assert.equal(h.notices.length, 1, 'a second press does nothing and says nothing more');
  await h.view.travel(true);
  assert.equal(host.replyUndoState(token), 'top', 'redo brings the button back');
  assert.equal((await h.image()).anchors.length, 2);
});

test('F-a B2 undo button goes through the write queue: the save raises no outside-edit reload, so the history survives, redo works and the button is disabled', async () => {
  const h = await harness();
  h.plugin.settings.mapChatImageMode = 'direct'; h.select('img1');
  h.control.reply = async () => ({ reply: 'Placed', actions: placeAnchor, rejected: [] });
  await h.send('place');
  const host = h.view.chatHost(); const token = h.chat.marks.at(-1).replyUndo.token;
  h.control.outsideEdits.length = 0;
  assert.equal(await host.undoReply(token), 'undone');
  assert.equal((await h.image()).anchors.length, 1, 'the anchor of the reply is gone');
  assert.deepEqual(plain(h.control.outsideEdits), [], 'the undo save is VAM\'s own write: no modify event reaches changed(), which would clear the history');
  assert.equal(h.view.history.canRedo, true, 'the history is intact, so redo is possible');
  assert.equal(host.replyUndoState(token), 'undone', 'the button is disabled');
  await h.plugin.mutate(async () => { await h.view.travel(true); });
  assert.equal(host.replyUndoState(token), 'top', 'redo brings the button back');
  assert.equal((await h.image()).anchors.length, 2);
});

test('F-a B2 the top-of-stack check runs inside the queue: a step pushed while the undo waits is not undone', async () => {
  const h = await harness();
  h.plugin.settings.mapChatImageMode = 'direct'; h.select('img1');
  h.control.reply = async () => ({ reply: 'Placed', actions: placeAnchor, rejected: [] });
  await h.send('place');
  const host = h.view.chatHost(); const token = h.chat.marks.at(-1).replyUndo.token;
  const gate = deferred();
  const busy = h.plugin.mutate(() => gate.promise);
  const pressed = host.undoReply(token);
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'later edit' });
  gate.resolve(); await busy;
  assert.equal(await pressed, 'later');
  assert.equal(h.view.history.undoEntry.label, 'later edit');
  assert.equal((await h.image()).anchors.length, 2, 'the reply was not undone');
});

test('F-a M1 a follow-up that waited is sent with the picture the chip still shows', async () => {
  const h = await harness(); h.select('img1');
  h.chat.takeQueued = () => h.chat.pendingSteers.splice(0);
  h.chat.pendingSteers = ['and the brisket?'];
  h.view.flushSteers(true);
  await until(() => h.control.requests.length === 1);
  assert.equal(h.chat.turnsList.at(-1).origin.imageId, 'img1', 'the origin carries the picture');
  assert.match(h.control.requests[0].imageDataUrl ?? '', DATA_URL, 'the model gets the picture');
  assert.equal(h.control.requests[0].context.selectedImage.id, 'img1');
  // No chip, no picture.
  const g = await harness();
  g.chat.takeQueued = () => g.chat.pendingSteers.splice(0);
  g.chat.pendingSteers = ['plain follow-up'];
  g.view.flushSteers(true);
  await until(() => g.control.requests.length === 1);
  assert.equal('imageId' in g.chat.turnsList.at(-1).origin, false);
  assert.equal(g.control.requests[0].imageDataUrl, undefined);
});

// ---- P4b: the dashed preview dots on the canvas ------------------------------------------------------------------------
/** Draws the canvas into a stage the test can read (the harness stubs render), and returns the annotated picture's element. */
function canvas(h) {
  h.view.stageEl = dom.element('div'); h.app.vault.getResourcePath = () => 'app://x';
  h.view.renderCanvasItems();
  return () => dom.find(h.view.stageEl, i => i.hasClass('vam-canvas-image') && i.dataset.itemId === 'img1');
}
const dots = el => dom.findAll(el, i => i.hasClass('is-preview'));
const solid = el => dom.findAll(el, i => i.hasClass('vam-anchor') && !i.hasClass('is-preview'));
const countText = el => dom.find(el, i => i.hasClass('vam-annotated-count')).text;
const threeAnchors = [addAnchor('p1', 0.1, 0.2, 'A'), addAnchor('p2', 0.5, 0.5, 'B'), addAnchor('p3', 1, 0, 'C')];
async function planned(actions = threeAnchors) {
  const h = await harness(); const el = canvas(h); h.select('img1');
  h.control.reply = async () => ({ reply: 'Plan', actions, rejected: [] });
  await h.send('place');
  return { h, el, card: h.chat.plans[0] };
}

test('P4b preview: one dashed dot per add_anchor, drawn without changing the map or the undo stack; the bar and the group name say how many', async () => {
  const { h, el, card } = await planned();
  assert.equal(h.chat.plans.length, 1);
  assert.equal(dots(el()).length, 3, 'one dot per add_anchor');
  assert.equal(solid(el()).length, 1, 'the real anchor is still the only solid one');
  assert.equal(countText(el()), '1 anchor(s) · 3 in preview');
  assert.equal(el().attrs['aria-label'], 'Annotated image: Cow cuts. 3 anchor(s) in the plan preview.');
  for (const dot of dots(el())) { assert.equal(dot.tag, 'span'); assert.equal(dot.attrs['aria-hidden'], 'true'); assert.equal(dot.children.length, 0, 'a fixed span: nothing inside'); assert.match(dot.style.left, /^[\d.]+%$/); assert.match(dot.style.top, /^[\d.]+%$/); }
  assert.deepEqual(plain(dots(el()).map(d => [d.style.left, d.style.top])), [['10%', '20%'], ['50%', '50%'], ['100%', '0%']]);
  assert.ok(dom.find(el(), i => i.hasClass('vam-anchor-preview-note')), 'the ghost note is there');
  assert.equal((await h.image()).anchors.length, 1, 'the map is untouched');
  assert.equal(h.view.history.undoEntry, undefined, 'and nothing went on the undo stack');
  h.view.stageEl = dom.element('div'); h.view.renderCanvasItems();
  assert.equal(dots(dom.find(h.view.stageEl, i => i.hasClass('is-annotated'))).length, 3, 'a full redraw keeps the preview');
  assert.deepEqual(plain(card.groups ?? []).map(g => g.label), ['Add or create (3)']);
});

test('P4b preview: no add_anchor in the plan, no dots; another picture gets none of the dots', async () => {
  const h = await harness(); const el = canvas(h); h.select('img1');
  h.control.reply = async () => ({ reply: 'Plan', actions: [{ kind: 'add_child', parentId: h.ids.root, title: 'T', ref: 'n1' }], rejected: [] });
  await h.send('x');
  assert.equal(dots(el()).length, 0); assert.equal(countText(el()), '1 anchor(s)');
  const o = await planned([addAnchor('p1', 0.3, 0.3, 'Z', 'img2')]);
  assert.equal(dots(o.el()).length, 0, 'an ordinary picture has no anchors to preview on');
});

test('P4b preview (counter-example): Apply, Cancel, the next message, abort, a picture change and a map switch each take every dot away', async () => {
  // Apply: the dots give way to solid anchors.
  let o = await planned();
  o.card.apply(); await until(() => o.h.chat.calls.filter(c => c[0] === 'settle').length >= 2);
  assert.equal(dots(o.el()).length, 0, 'applied'); assert.equal((await o.h.image()).anchors.length, 4);
  o.h.view.stageEl = dom.element('div'); o.h.view.renderCanvasItems();
  assert.equal(solid(dom.find(o.h.view.stageEl, i => i.hasClass('is-annotated'))).length, 4); assert.equal(countText(dom.find(o.h.view.stageEl, i => i.hasClass('is-annotated'))), '4 anchor(s)');
  // Cancel.
  o = await planned(); o.card.cancel();
  assert.equal(dots(o.el()).length, 0, 'cancelled'); assert.equal(countText(o.el()), '1 anchor(s)'); assert.equal(o.el().attrs['aria-label'], 'Annotated image: Cow cuts');
  assert.equal((await o.h.image()).anchors.length, 1);
  // Superseded by the next message.
  o = await planned(); o.h.chat.isBusy = false;
  o.h.control.reply = async () => ({ reply: 'No change', actions: [], rejected: [] });
  await o.h.send('and then?');
  assert.equal(dots(o.el()).length, 0, 'superseded');
  // Abort (view closing).
  o = await planned(); o.h.view.abortMapChat();
  assert.equal(dots(o.el()).length, 0, 'aborted');
  // Another picture is chosen.
  o = await planned(); o.h.view.setChatImage('img2');
  assert.equal(dots(o.el()).length, 0, 'picture changed');
  // A late Apply of an old plan does not bring the dots back.
  o.card.apply(); await until(() => true);
  assert.equal(dots(o.el()).length, 0);
  // Map switch: the chat of another map starts empty.
  o = await planned();
  o.h.view.map = { ...o.h.view.map, id: 'map-b' }; o.h.view.placeChatPanel = () => {}; o.h.view.syncChatNarrow = () => {};
  o.h.view.mountMapChat(dom.element('div'), dom.element('div'));
  assert.equal(dots(o.el()).length, 0, 'map switched');
  assert.equal(o.h.view.chatPreview, null, 'no orphan state');
});

test('P4b preview (counter-example): the plan has priority over the dots: a stale preview whose plan is gone is never drawn', async () => {
  const { h, el } = await planned();
  h.view.chatPlanToken++;
  h.view.stageEl = dom.element('div'); h.view.renderCanvasItems();
  assert.equal(dots(dom.find(h.view.stageEl, i => i.hasClass('is-annotated'))).length, 0);
  void el;
});

test('P4b preview whitelist (counter-example): a note of <img onerror> is no element and no attribute on the canvas; positions are numbers in 0-100%', async () => {
  const evil = '<img src=x onerror=alert(1)>"><script>';
  const { h, el } = await planned([addAnchor('p1', 0, 1, evil), addAnchor('p2', 0.5, 0.5, evil)]);
  const all = dom.findAll(el(), () => true);
  assert.equal(all.filter(i => i.tag === 'img' || i.tag === 'script').length <= 1, true, 'at most the picture itself');
  for (const node of all) { if (node.hasClass('is-preview') || node.hasClass('vam-anchor-preview-note')) { assert.equal(JSON.stringify([node.text, node.attrs, node.style.left, node.style.top]).includes('onerror'), false); } }
  assert.equal(JSON.stringify([el().attrs, countText(el())]).includes('onerror'), false);
  // Extreme or broken numbers still stay inside the picture; non-numbers are not drawn.
  h.view.chatPreview = { token: h.view.chatPlanToken, anchors: [{ imageId: 'img1', x: 5, y: -3, note: '' }, { imageId: 'img1', x: Number.NaN, y: 0.5, note: '' }, { imageId: 'img1', x: Infinity, y: 0, note: '' }] };
  h.view.syncAnchorPreview();
  assert.equal(dots(el()).length, 1, 'only the finite one is drawn');
  assert.deepEqual(plain([dots(el())[0].style.left, dots(el())[0].style.top]), ['100%', '0%'], 'clamped to 0-100%');
});
