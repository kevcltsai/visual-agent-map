// Map chat batch interrupted: a research batch the chat started that stops (cancelled, failed, or cut by a reload) is told in the
// conversation, and the cards that were not done can be run again. Core summary, record read-back, the panel row, and the view's hooks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { load } = require('./support-replay.cjs');

const batchCore = load('core/map-chat-batch.ts');
const records = load('core/map-chat-records.ts');
const { t } = S.load('i18n.ts');
const plain = value => JSON.parse(JSON.stringify(value));

const REQUEST = { mapAiMode: 'standard', researchMode: 'research', researchDepth: 'normal', requirements: 'picture book voice', imageSearch: false };
const ids = count => Array.from({ length: count }, (_, i) => ({ id: `n${i + 1}`, title: `Topic ${i + 1}` }));
const batchOf = (count, done, extra = {}) => ({
  turn: 3, topics: ids(count), succeeded: ids(done).map(topic => topic.id), failed: [], ended: true, request: REQUEST, ...extra
});

// ---- core summary (counterexamples 1, 2, 3) ----
test('1 partial stop: 18 of 71 done, ended -> a summary with the first pending ones in order', () => {
  const summary = batchCore.summarizeChatBatch(batchOf(71, 18), false);
  assert.equal(summary.total, 71);
  assert.equal(summary.done, 18);
  assert.equal(summary.failed, 0);
  assert.equal(summary.notRun, 53);
  assert.equal(summary.pending.length, 53);
  assert.deepEqual(plain(summary.pending[0]), { id: 'n19', title: 'Topic 19' });
  assert.equal(summary.interrupted, false);
});
test('2 all succeeded -> no summary', () => {
  assert.equal(batchCore.summarizeChatBatch(batchOf(5, 5), false), null);
  assert.equal(batchCore.summarizeChatBatch(batchOf(5, 5, { ended: false }), true), null);
});
test('3 failures are counted apart from the cards that never ran; a later success clears a failure', () => {
  const batch = batchOf(71, 18, { failed: ['n19', 'n20', 'n21'] });
  const summary = batchCore.summarizeChatBatch(batch, false);
  assert.equal(summary.failed, 3);
  assert.equal(summary.notRun, 50);
  assert.equal(summary.pending.length, 53, 'a failed card is still to do');
  const again = batchCore.summarizeChatBatch({ ...batch, succeeded: [...batch.succeeded, 'n19'] }, false);
  assert.equal(again.done, 19);
  assert.equal(again.failed, 2);
});
test('restored and not ended -> interrupted', () => {
  assert.equal(batchCore.summarizeChatBatch(batchOf(10, 4, { ended: false }), true).interrupted, true);
  assert.equal(batchCore.summarizeChatBatch(batchOf(10, 4, { ended: false }), false).interrupted, false);
  assert.equal(batchCore.summarizeChatBatch(batchOf(10, 4), true).interrupted, false);
});

// ---- records (4, 5) ----
const T = '2026-11-14T10:00:00.000Z';
const startLine = turn => ({ v: 1, at: T, type: 'turn_start', turn, message: 'rewrite', request: {} });
const endLine = turn => ({ v: 1, at: T, type: 'turn_end', turn, status: 'done', raw: '{}', reply: 'ok', lines: [], modelLabel: 'M' });
const ev = (turn, kind, extra = {}) => ({ v: 1, at: T, type: 'event', turn, kind, ...extra });
const restore = lines => records.restoreConversation('20261114-100000-abcdef', lines);

test('4 reload: research_batch plus 18 topic events and no end -> the turn restores with an unended batch', () => {
  const lines = [
    startLine(1), endLine(1),
    ev(1, 'research_batch', { topics: ids(71), request: REQUEST }),
    ...ids(18).map(topic => ev(1, 'research_batch_topic', { id: topic.id, status: 'succeeded' }))
  ];
  const turn = restore(lines).turns[0];
  assert.equal(turn.batch.topics.length, 71);
  assert.equal(turn.batch.succeeded.length, 18);
  assert.equal(turn.batch.ended, false);
  assert.deepEqual(plain(turn.batch.request), REQUEST);
  assert.equal(batchCore.summarizeChatBatch(turn.batch, true).interrupted, true);
});
test('4 a later research_batch of the same turn (a rerun) reopens the batch and unions the topics', () => {
  const lines = [
    startLine(1), endLine(1),
    ev(1, 'research_batch', { topics: ids(3), request: REQUEST }),
    ev(1, 'research_batch_topic', { id: 'n1', status: 'succeeded' }),
    ev(1, 'research_batch_topic', { id: 'n2', status: 'failed' }),
    ev(1, 'research_batch_end'),
    ev(1, 'research_batch', { topics: [{ id: 'n2', title: 'Topic 2' }, { id: 'n3', title: 'Topic 3' }], request: REQUEST }),
    ev(1, 'research_batch_topic', { id: 'n2', status: 'succeeded' })
  ];
  const batch = restore(lines).turns[0].batch;
  assert.equal(batch.ended, false);
  assert.deepEqual(plain(batch.topics.map(topic => topic.id)), ['n1', 'n2', 'n3']);
  assert.deepEqual(plain(batch.succeeded), ['n1', 'n2']);
  assert.deepEqual(plain(batch.failed), []);
});
test('5 not_started drops the batch; a file with no batch events restores without a batch', () => {
  const lines = [startLine(1), endLine(1), ev(1, 'research_batch', { topics: ids(2), request: REQUEST }), ev(1, 'research_batch_end', { status: 'not_started' })];
  assert.equal(restore(lines).turns[0].batch, undefined);
  assert.equal('batch' in restore([startLine(1), endLine(1)]).turns[0], false, 'an older file restores as before');
});
test('5 a hand-edited batch cannot crash the restore: titles, statuses, topic count and request fields are checked', () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ id: `x${i}`, title: 'T' }));
  const lines = [
    startLine(1), endLine(1),
    ev(1, 'research_batch', {
      topics: [{ id: 'a', title: 42 }, { id: 'b', title: 'y'.repeat(500) }, null, 'str', { title: 'no id' }, ...many],
      request: { mapAiMode: 'weird', researchMode: 'research', researchDepth: 7, requirements: { x: 1 }, imageSearch: 'yes', rewrite: false, model: 5, extra: 'x' }
    }),
    ev(1, 'research_batch_topic', { id: 'a', status: 'bogus' }),
    ev(1, 'research_batch_topic', { id: 'b', status: 'failed' }),
    ev(1, 'research_batch_topic', { status: 'succeeded' }),
    ev(1, 'research_batch_end', { status: 'zzz' })
  ];
  const batch = restore(lines).turns[0].batch;
  assert.ok(batch.topics.length <= 1000);
  const a = batch.topics.find(topic => topic.id === 'a');
  assert.equal(typeof a.title, 'string');
  assert.ok(batch.topics.find(topic => topic.id === 'b').title.length <= 200);
  assert.deepEqual(plain(batch.succeeded), []);
  assert.deepEqual(plain(batch.failed), ['b']);
  assert.equal(batch.ended, true, 'an end line with an unknown status still ends it');
  assert.equal(batch.request.researchMode, 'research');
  for (const key of ['mapAiMode', 'researchDepth', 'requirements', 'imageSearch', 'rewrite', 'model', 'extra'])
    assert.ok(!(key in batch.request) || ['mapAiMode', 'researchDepth', 'requirements', 'imageSearch'].includes(key), key);
  assert.ok(['quick', 'standard'].includes(batch.request.mapAiMode));
  assert.ok(['fast', 'normal', 'deep'].includes(batch.request.researchDepth));
  assert.equal(typeof batch.request.requirements, 'string');
  assert.equal(typeof batch.request.imageSearch, 'boolean');
});

// ---- panel row (1, 2, 3, 4, 6) ----
const { MapChatPanel } = S.load('experiences/visual-map/map-chat.ts', { obsidian: { ...S.obsidian, Keymap: {}, setIcon() {} } });
function makePanel() {
  const calls = [];
  const panel = Object.create(MapChatPanel.prototype);
  Object.assign(panel, {
    built: true, busy: false, logEl: dom.element('div'), liveEl: dom.element('div'), messages: [], rows: new WeakMap(), messageEls: [], bodyEls: [],
    spokenLater: [], stage: null, chainWaitingState: null, chainWaitingLeft: '', host: { rerunBatch: message => calls.push(message), activeElement: () => null },
    cancelFrame() {}, atEnd: () => true, renderGuide() {}, refreshSave() {}, scrollToEnd() {}, markUnread() {}, renderBusy() {}
  });
  Object.defineProperty(panel, 'working', { get: () => false });
  const answer = { role: 'assistant', text: 'done', lines: [] };
  panel.messages.push({ role: 'user', text: 'rewrite', lines: [] }, answer);
  return { panel, answer, calls, box: () => dom.find(panel.logEl, el => dom.hasCls(el, 'vam-map-chat-batch')) };
}
const rerunButton = box => dom.find(box, el => el.tag === 'button');

test('1 panel: a partial stop shows the sentence, the first 5 titles in 「」 and "等 48 篇", and the button', () => {
  const { panel, answer, box } = makePanel();
  const message = panel.attachBatch(batchOf(71, 18));
  assert.equal(message, answer);
  panel.refreshBatch(message);
  const text = dom.texts(box()).join('\n');
  assert.match(text, /研究停了：做完 18／71 篇，53 篇沒做。|Research stopped: 18\/71 done, 53 not done\./);
  for (let i = 19; i <= 23; i++) assert.match(text, new RegExp(`「Topic ${i}」`));
  assert.doesNotMatch(text, /Topic 24/);
  assert.match(text, /等 48 篇|and 48 more/);
  assert.equal(box().attrs.role, 'status');
  assert.match(rerunButton(box()).text, /重跑沒做的 53 篇|Run the 53 not done again/);
});
test('2 panel: all succeeded, or a first run that has not ended -> no box', () => {
  const a = makePanel();
  a.panel.refreshBatch(a.panel.attachBatch(batchOf(4, 4)));
  assert.equal(a.box(), undefined);
  const b = makePanel();
  b.panel.refreshBatch(b.panel.attachBatch(batchOf(4, 1, { ended: false })));
  assert.equal(b.box(), undefined, 'the first run, still going: same as today');
});
test('3 panel: failures and never-run cards use the failure sentence', () => {
  const { panel, box } = makePanel();
  panel.refreshBatch(panel.attachBatch(batchOf(71, 18, { failed: ['n19', 'n20', 'n21'] })));
  assert.match(dom.texts(box()).join('\n'), /研究停了：做完 18／71 篇，3 篇失敗、50 篇沒跑到。|3 failed, 50 never ran/);
});
test('3 panel: a batch that ended with only failures says it finished', () => {
  const { panel, box } = makePanel();
  panel.refreshBatch(panel.attachBatch(batchOf(10, 7, { failed: ['n8', 'n9', 'n10'] })));
  assert.match(dom.texts(box()).join('\n'), /研究跑完了：做完 7／10 篇，3 篇失敗。|Research finished: 7\/10 done, 3 failed\./);
});
test('4 panel: a restored, unended batch says the plugin reload cut it', () => {
  const { panel, box } = makePanel();
  panel.refreshBatch(panel.attachBatch({ ...batchOf(10, 4, { ended: false }), restored: true }));
  assert.match(dom.texts(box()).join('\n'), /研究在外掛重新載入時中斷：做完 4／10 篇，6 篇沒做。|interrupted when the plugin reloaded/);
});
test('title text is untrusted: it is set as text, never parsed', () => {
  const { panel, box } = makePanel();
  const batch = batchOf(3, 0);
  batch.topics[0].title = '<img src=x onerror=alert(1)>';
  panel.refreshBatch(panel.attachBatch(batch));
  assert.ok(dom.texts(box()).some(text => text.includes('<img src=x onerror=alert(1)>')));
  assert.equal(dom.find(panel.logEl, el => el.tag === 'img'), undefined);
});
test('6 panel: the button calls host.rerunBatch with the message; running shows the running text and disables it', () => {
  const { panel, answer, calls, box } = makePanel();
  panel.refreshBatch(panel.attachBatch(batchOf(10, 4)));
  rerunButton(box()).click();
  assert.deepEqual(calls, [answer]);
  answer.batch.running = true;
  panel.refreshBatch(answer);
  const button = rerunButton(box());
  assert.match(button.text, /正在重跑 6 篇…|Running 6 again…/);
  assert.equal(button.disabled, true);
});
test('6 panel: when the rerun finishes everything the box goes away', () => {
  const { panel, answer, box } = makePanel();
  panel.refreshBatch(panel.attachBatch(batchOf(3, 1)));
  assert.ok(box());
  answer.batch.succeeded = ids(3).map(topic => topic.id);
  answer.batch.running = false;
  panel.refreshBatch(answer);
  assert.equal(box(), undefined);
});
test('panel restore: a restored turn carries its batch and marks it restored', () => {
  const { panel } = makePanel();
  panel.renderLog = () => {}; panel.refreshNote = () => {}; panel.renderHint = () => {}; panel.renderAutoApply = () => {}; panel.stopWaitTimer = () => {};
  panel.host = { stateChanged() {}, activeElement: () => null };
  panel.restore({ id: 'x', restoredAt: null, turns: [{ message: 'm', reply: 'r', lines: [], modelLabel: '', stalePlan: false, batch: batchOf(5, 2, { ended: false }) }] });
  const answer = panel.messages.find(message => message.role === 'assistant');
  assert.equal(answer.batch.restored, true);
  assert.equal(answer.batch.topics.length, 5);
});

// ---- view hooks (6, 7) ----
const view = async () => {
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: S.obsidian });
  return VisualAgentMapView;
};
function chatStub() {
  const messages = [];
  return {
    messages,
    transcript: () => [],
    appendLines() {},
    attachBatch(batch) { const message = { batch }; messages.push(message); return message; },
    refreshBatch() {}
  };
}
async function rig(options = {}) {
  const View = await view();
  const instance = Object.create(View.prototype);
  const notices = [];
  const starts = [];
  const chat = chatStub();
  const nodes = ids(6).map(topic => ({ ...topic, path: `Maps/${topic.id}.md` }));
  Object.assign(instance, {
    closed: false, chat, chatConversation: 1, chatLastRecord: null, chatResearched: new Map(), map: { nodes },
    selection: { state: { multiSelected: new Set() }, chatSelect(list) { this.state.multiSelected = new Set(list); } },
    plugin: { settings: { mapChatRecords: false }, expansionCoordinator: { isRunning: () => options.running === true } },
    notes: new Map(nodes.map(node => [node.id, { title: node.title }])),
    multiResearchKey: () => 'k',
    canSelectTopics: () => true,
    readMapSourceGroups: async () => [],
    chatTurnReferences: [],
    markResearchRecorded() {},
    render() {},
    startMultiResearch: async (request, _retry, _settled, outcome, _signal, onTopic) => {
      starts.push({ request: plain(request), selected: [...instance.selection.state.multiSelected], onTopic, outcome });
    }
  });
  globalThis.__notices = notices;
  return { instance, chat, starts, nodes };
}

test('6 view: rerunChatBatch runs only the pending cards still on the map and counts them', async () => {
  const { instance, chat, starts } = await rig();
  const batch = batchOf(6, 2);
  const message = { batch };
  instance.map.nodes = instance.map.nodes.filter(node => node.id !== 'n6');
  await instance.rerunChatBatch(message);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].selected, ['n3', 'n4', 'n5'], 'n6 was deleted from the map and is skipped');
  assert.equal(starts[0].request.requirements, 'picture book voice');
  assert.equal(starts[0].request.researchMode, 'research');
  assert.equal(message.batch.running, true);
  starts[0].onTopic({ id: 'n3', title: 'Topic 3', status: 'succeeded' });
  starts[0].onTopic({ id: 'n4', title: 'Topic 4', status: 'failed' });
  starts[0].outcome({ kind: 'settled', succeeded: 1, failed: 1, stopped: 1, topics: [{ id: 'n5', title: 'Topic 5', status: 'stopped' }] });
  assert.equal(message.batch.running, false);
  assert.deepEqual(plain(message.batch.succeeded), ['n1', 'n2', 'n3']);
  assert.deepEqual(plain(message.batch.failed), ['n4']);
  void chat;
});
test('6 view: a rerun that finishes every pending card leaves nothing to summarise', async () => {
  const { instance, starts } = await rig();
  const message = { batch: batchOf(4, 2) };
  await instance.rerunChatBatch(message);
  for (const id of ['n3', 'n4']) starts[0].onTopic({ id, title: id, status: 'succeeded' });
  starts[0].outcome({ kind: 'settled', succeeded: 2, failed: 0, stopped: 0, topics: [] });
  assert.equal(batchCore.summarizeChatBatch(message.batch, false), null);
});
test('7 view: a batch already running -> no start, a Notice, nothing changes', async () => {
  const notices = [];
  const { instance, starts } = await rig({ running: true });
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...S.obsidian, Notice: class { constructor(message) { notices.push(message); } } } });
  const other = Object.assign(Object.create(VisualAgentMapView.prototype), instance);
  const message = { batch: batchOf(4, 1) };
  await other.rerunChatBatch(message);
  assert.equal(starts.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0], t('ui.multi_research_already_running'));
  assert.equal(message.batch.running, undefined);
});

// ---- the chat's own research action ----
async function chatRig() {
  const r = await rig();
  const writes = [];
  Object.assign(r.instance, {
    aiLockReason: () => null, chatStartedResearch: false, chatLastRecord: { turn: 3 },
    chatRecords: { conversationId: 'c1', write: line => writes.push(JSON.parse(JSON.stringify(line))) },
    freshNotesOf: async () => new Map(), chatSelectionIds: () => [],
    map: { aiMode: 'standard', nodes: r.nodes }
  });
  r.instance.plugin.settings.mapChatRecords = true;
  r.instance.plugin.topicRuns = { isBusy: () => false, hasTask: () => false };
  const action = { kind: 'run_map_action', action: 'research_standard', nodeIds: ['n1', 'n2', 'n3', 'n6'], direction: 'picture book' };
  const run = async () => { r.chat.messages.length = 0; r.chat.messages.push(); return r.instance.runChatSelection(action); };
  return { ...r, writes, run };
}
test('chat research: the batch hangs on the answer with the cards that will run, and the record gets the batch lines', async () => {
  const { chat, starts, writes, run } = await chatRig();
  assert.equal((await run()).status, 'done');
  assert.equal(starts.length, 1);
  const batch = chat.messages[0].batch;
  assert.deepEqual(plain(batch.topics.map(topic => topic.id)), ['n1', 'n2', 'n3', 'n6'], 'every card the chat asked for');
  assert.equal(batch.turn, 3);
  assert.equal(batch.request.requirements, 'picture book');
  assert.equal('referenceGroups' in batch.request, false);
  assert.equal(writes[0].kind, 'research_batch');
  assert.equal(writes[0].turn, 3);
  starts[0].onTopic({ id: 'n1', title: 'Topic 1', status: 'succeeded' });
  starts[0].onTopic({ id: 'n2', title: 'Topic 2', status: 'failed' });
  starts[0].outcome({ kind: 'settled', succeeded: 1, failed: 1, stopped: 2, topics: [{ id: 'n3', title: 'Topic 3', status: 'stopped' }] });
  assert.equal(batch.ended, true);
  assert.deepEqual(plain(batch.succeeded), ['n1']);
  assert.deepEqual(plain(batch.failed), ['n2']);
  assert.deepEqual(writes.map(line => line.kind), ['research_batch', 'research_batch_topic', 'research_batch_topic', 'research_batch_end']);
  assert.deepEqual(plain(writes[2]), { type: 'event', turn: 3, kind: 'research_batch_topic', id: 'n2', status: 'failed' });
});
test('chat research: a batch that never started leaves no batch and records not_started; a changed conversation writes nothing', async () => {
  const a = await chatRig();
  await a.run();
  a.starts[0].outcome({ kind: 'not_started' });
  assert.equal(a.chat.messages[0].batch, undefined);
  assert.deepEqual(a.writes.map(line => line.status ?? line.kind), ['research_batch', 'not_started']);
  const b = await chatRig();
  await b.run();
  const before = b.writes.length;
  b.instance.chatConversation++;
  b.starts[0].onTopic({ id: 'n1', title: 'Topic 1', status: 'succeeded' });
  b.starts[0].outcome({ kind: 'settled', succeeded: 1, failed: 0, stopped: 0, topics: [] });
  assert.equal(b.writes.length, before);
  assert.deepEqual(plain(b.chat.messages[0].batch.succeeded), []);
});
test('chat research: records off -> nothing written, the panel still follows the batch', async () => {
  const { instance, chat, starts, writes, run } = await chatRig();
  instance.plugin.settings.mapChatRecords = false;
  await run();
  starts[0].outcome({ kind: 'settled', succeeded: 0, failed: 0, stopped: 3, topics: [] });
  assert.equal(writes.length, 0);
  assert.equal(chat.messages[0].batch.ended, true);
});

// ---- map-chat-hard-rules: what the chat asks for is a rule, not left to the AI ----
test('chat research: images the user asked for start the batch with imagesRequired; the batch runs on the chat menu model', async () => {
  const { instance, chat, starts } = await chatRig();
  instance.plugin.settings.cliModel = 'claude:opus';
  const action = { kind: 'run_map_action', action: 'research_standard', nodeIds: ['n1', 'n2'], direction: 'with pictures', images: true };
  chat.messages.length = 0;
  await instance.runChatSelection(action);
  assert.equal(starts[0].request.imageSearch, true);
  assert.equal(starts[0].request.imagesRequired, true, 'asked for images: VISUAL_ON, not "auto"');
  assert.equal(starts[0].request.batchModel, 'claude:opus', 'the batch is fixed to the model the chat menu shows when it starts');
  assert.equal('model' in starts[0].request, false, 'a topic with its own model keeps it');
  assert.equal(chat.messages[0].batch.request.batchModel, 'claude:opus', 'kept with the batch for a rerun');
  // No images asked: nothing is required.
  const other = await chatRig();
  await other.run();
  assert.equal(other.starts[0].request.imagesRequired, false);
});
test('chat research: a rerun keeps the batch model and the required images even after the menu changed', async () => {
  const { instance, starts } = await rig();
  instance.plugin.settings.cliModel = 'claude:sonnet';
  const message = { batch: batchOf(4, 2, { request: { ...REQUEST, imageSearch: true, batchModel: 'claude:opus' } }) };
  await instance.rerunChatBatch(message);
  assert.equal(starts[0].request.batchModel, 'claude:opus');
  assert.equal(starts[0].request.imagesRequired, true);
});
test('chat research: the batch model is read back from the record; a bad value is dropped', () => {
  const read = batchModel => restore([startLine(1), endLine(1), ev(1, 'research_batch', { topics: [{ id: 'a', title: 'A' }], request: { ...REQUEST, batchModel } })]).turns[0].batch.request;
  assert.equal(read('claude:opus').batchModel, 'claude:opus');
  for (const bad of [5, '', 'x'.repeat(201)]) assert.equal('batchModel' in read(bad), false, String(bad));
});
