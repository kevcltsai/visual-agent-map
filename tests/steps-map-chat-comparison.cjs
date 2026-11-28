'use strict';
// V3.3 F08a (P4.5 Comparison table, no saving): map chat may answer with a top-level `comparison` (like F07a `suggestions`, no new
// action kind). The program checks the card ids, keeps at most 8 rows x 8 attributes, shows null/empty as "unknown", splits an
// attribute whose values carry different units into one column per unit (no conversion), and writes nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, fixture, DEFAULT_SETTINGS, normalizeReasoningLevel, obsidian, core, plain, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { parseMapChat, mapChatStep, MAP_CHAT_SCHEMA, MAP_CHAT_COMPARISON_LIMIT } = load('core/steps/map-chat/step.ts');
const { buildComparisonTable } = load('core/map-chat-comparison.ts');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';

// ---- parser ----
const ctx = (extra = {}) => ({ nodeIds: ['r', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], refIds: ['ref1'], parents: {}, ...extra });
const row = (nodeId, ...values) => ({ nodeId, values: values.map(v => (v && typeof v === 'object' ? v : { value: v })) });
const parse = (comparison, extra) => plain(parseMapChat(JSON.stringify({ reply: 'ok', actions: [], remaining: '', comparison }), ctx(extra)));

test('F08a parse: a valid comparison is kept as a top-level field, never an action', () => {
  const result = parse({ attributes: [{ name: 'Fee', unit: 'NT$' }, { name: 'Discount' }], rows: [row('a', { value: '290', unit: 'NT$' }, '15%'), row('b', { value: ' 350 ', unit: 'NT$' }, null)] });
  assert.equal(MAP_CHAT_COMPARISON_LIMIT, 8);
  assert.deepEqual(result.comparison, {
    attributes: [{ name: 'Fee', unit: 'NT$' }, { name: 'Discount' }],
    rows: [{ nodeId: 'a', values: [{ value: '290', unit: 'NT$' }, { value: '15%' }] }, { nodeId: 'b', values: [{ value: '350', unit: 'NT$' }, { value: null }] }]
  });
  assert.deepEqual(result.actions, []);
});

test('F08a parse (counter-example): a row whose nodeId is not a card of this map in this turn is dropped; so is a repeated card', () => {
  const result = parse({ attributes: [{ name: 'Fee' }], rows: [row('a', '1'), row('nope', '2'), row('new:x', '3'), row('ref1', '4'), row('', '5'), row(7, '6'), row('a', '7'), 'x', row('b', '8')] });
  assert.deepEqual(result.comparison.rows.map(r => r.nodeId), ['a', 'b'], 'unknown, new:, reference, empty, non-string ids and a repeat are dropped');
  assert.deepEqual(result.comparison.rows[0].values, [{ value: '1' }], 'the first of a repeated card wins');
});

test('F08a parse: more than 8 rows or 8 attributes are cut to 8 and the cut is recorded for the note', () => {
  const attributes = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(name => ({ name }));
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'r'].map(id => row(id, ...attributes.map(a => `${id}${a.name}`)));
  const result = parse({ attributes, rows });
  assert.equal(result.comparison.attributes.length, 8);
  assert.equal(result.comparison.rows.length, 8);
  assert.ok(result.comparison.rows.every(r => r.values.length === 8));
  assert.deepEqual(result.comparison.truncated, { rows: 2, attributes: 2 });
  assert.equal(parse({ attributes: [{ name: 'x' }], rows: [row('a', '1')] }).comparison.truncated, undefined, 'no cut, no note');
});

test('F08a parse: null, empty, blank, missing and non-string values are null; a blank unit is no unit; a short row is filled with null', () => {
  const result = parse({ attributes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E', unit: '  ' }], rows: [{ nodeId: 'a', values: [{ value: null }, { value: '' }, { value: '   ' }, { value: 5, unit: '' }] }] });
  assert.deepEqual(result.comparison.rows[0].values, [{ value: null }, { value: null }, { value: null }, { value: null }, { value: null }]);
  assert.deepEqual(result.comparison.attributes[4], { name: 'E' });
});

test('F08a parse: nothing usable (no attribute, no valid row, malformed) leaves the field out and never fails the reply', () => {
  assert.equal(parse({ attributes: [], rows: [row('a', '1')] }).comparison, undefined);
  assert.equal(parse({ attributes: [{ name: '' }, { name: 3 }], rows: [row('a', '1')] }).comparison, undefined);
  assert.equal(parse({ attributes: [{ name: 'x' }], rows: [row('nope', '1')] }).comparison, undefined);
  assert.equal(parse('x').comparison, undefined);
  assert.equal(parse(null).comparison, undefined);
  assert.equal(parse(undefined).comparison, undefined);
  assert.equal(parse({ attributes: 'x', rows: 'y' }).comparison, undefined);
});

test('F08a schema and version: comparison is optional with attributes and rows; the step is version 37', () => {
  const field = MAP_CHAT_SCHEMA.properties.comparison;
  assert.equal(field.type, 'object');
  assert.deepEqual(plain(field.required), ['attributes', 'rows']);
  assert.equal(MAP_CHAT_SCHEMA.required.includes('comparison'), false);
  assert.equal(mapChatStep.version, 37);
});

// ---- pure builder ----
const titles = { a: 'A Co', b: 'B Co', c: 'C Co' };
const build = comparison => plain(buildComparisonTable(comparison, { titleOf: id => titles[id] ?? null, unknown: 'unknown' }));

test('F08a builder: null becomes the unknown word; one unit stays one column', () => {
  const t = build({ attributes: [{ name: 'Fee' }, { name: 'Discount' }], rows: [row('a', { value: '290', unit: 'NT$' }, '15%'), row('b', { value: '350', unit: 'NT$' }, null)] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: 'Fee', unit: 'NT$', split: false }, { attribute: 1, name: 'Discount', unit: '%', split: false }]);
  assert.deepEqual(t.rows, [{ nodeId: 'a', title: 'A Co', cells: ['290', '15%'] }, { nodeId: 'b', title: 'B Co', cells: ['350', 'unknown'] }]);
});

test('F08a builder: different units in one attribute split into one column per unit, in first-seen order, with no conversion', () => {
  const t = build({ attributes: [{ name: 'Fee' }], rows: [row('a', { value: '290', unit: 'NT$' }), row('b', { value: '12', unit: 'US$' }), row('c', { value: null, unit: 'US$' })] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: 'Fee', unit: 'NT$', split: true }, { attribute: 0, name: 'Fee', unit: 'US$', split: true }]);
  assert.deepEqual(t.rows.map(r => r.cells), [['290', 'unknown'], ['unknown', '12'], ['unknown', 'unknown']], 'the value sits in its own unit column only; 12 is never turned into NT$');
});

test('F08a builder: a value with no unit next to values with a unit gets its own no-unit column', () => {
  const t = build({ attributes: [{ name: 'Fee' }], rows: [row('a', { value: '290', unit: 'NT$' }), row('b', '350'), row('c', { value: '', unit: 'NT$' })] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: 'Fee', unit: 'NT$', split: true }, { attribute: 0, name: 'Fee', unit: null, split: true }]);
  assert.deepEqual(t.rows.map(r => r.cells), [['290', 'unknown'], ['unknown', '350'], ['unknown', 'unknown']]);
});

test('F08a builder: an attribute with only unknown values keeps one column; a gone card has a null title; a declared unit heads a column with no value units', () => {
  const t = build({ attributes: [{ name: 'Fee', unit: 'NT$' }], rows: [row('zzz', null)] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: 'Fee', unit: 'NT$', split: false }]);
  assert.deepEqual(t.rows, [{ nodeId: 'zzz', title: null, cells: ['unknown'] }]);
  const u = build({ attributes: [{ name: 'Fee', unit: 'NT$' }], rows: [row('a', '290'), row('b', '350')] });
  assert.deepEqual(u.columns, [{ attribute: 0, name: 'Fee', unit: 'NT$', split: false }]);
});

test('F08a builder (live payload): currencies written inside values with no unit split the column by currency', () => {
  const t = build({ attributes: [{ name: '月費' }], rows: [row('a', 'NT$290'), row('b', 'NT$350'), row('c', 'US$12')] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: '月費', unit: 'NT$', split: true }, { attribute: 0, name: '月費', unit: 'US$', split: true }]);
  assert.deepEqual(t.rows.map(r => r.cells), [['NT$290', 'unknown'], ['NT$350', 'unknown'], ['unknown', 'US$12']], 'the value text is kept exactly as given, in its own column only');
});

test('F08a builder: a unit written as a suffix inside the value: same unit stays one column, different units split', () => {
  const same = build({ attributes: [{ name: 'Rate' }], rows: [row('a', '15%'), row('b', '20%')] });
  assert.deepEqual(same.columns, [{ attribute: 0, name: 'Rate', unit: '%', split: false }]);
  assert.deepEqual(same.rows.map(r => r.cells), [['15%'], ['20%']]);
  const mixed = build({ attributes: [{ name: 'Weight' }], rows: [row('a', '12 kg'), row('b', '300 g')] });
  assert.deepEqual(mixed.columns.map(c => c.unit), ['kg', 'g']);
  assert.deepEqual(mixed.rows.map(r => r.cells), [['12 kg', 'unknown'], ['unknown', '300 g']]);
});

test('F08a builder: values that are not a single number with a recognizable prefix or suffix stay unitless', () => {
  const t = build({ attributes: [{ name: 'Fee' }], rows: [row('a', '約 300'), row('b', '100-200'), row('c', '免費')] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: 'Fee', unit: null, split: false }]);
  assert.deepEqual(t.rows.map(r => r.cells), [['約 300'], ['100-200'], ['免費']]);
  const odd = build({ attributes: [{ name: 'Fee' }], rows: [row('a', 'NT$290 起'), row('b', 'NT$100~200'), row('c', '290')] });
  assert.deepEqual(odd.columns.map(c => c.unit), [null]);
});

test('F08a builder: an explicit unit from the model wins over one found inside the value', () => {
  const t = build({ attributes: [{ name: 'Fee' }], rows: [row('a', { value: 'NT$290', unit: 'TWD' }), row('b', { value: 'US$12', unit: 'TWD' })] });
  assert.deepEqual(t.columns, [{ attribute: 0, name: 'Fee', unit: 'TWD', split: false }]);
  assert.deepEqual(t.rows.map(r => r.cells), [['NT$290'], ['US$12']]);
});

test('F08a prompt: values must come from the cards content, null when unsupported, never invented', () => {
  const text = mapChatStep.render({ message: 'compare', context: { json: '{}' }, language: 'en' });
  assert.match(text, /"comparison"/);
  assert.match(text, /null/);
  assert.match(text, /never invent/i);
  const zh = mapChatStep.render({ message: 'compare', context: { json: '{}' }, language: 'zh-TW' });
  assert.match(zh, /"comparison"/);
  assert.match(zh, /null/);
});

// ---- view harness (same as F07a) ----
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
    markTurn() {}, attached: [], attachComparison(table) { chat.attached.push(table); }, refreshReplyUndo() {}, completedTurns: () => [], conversationId: undefined,
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


const tick = () => new Promise(r => setTimeout(r, 20));
const comparison = ids => ({ attributes: [{ name: 'Fee' }], rows: [row(ids.a, { value: '290', unit: 'NT$' }), row(ids.b, { value: '12', unit: 'US$' })] });

test('F08a view: a comparison reply is handed to the chat as a table and writes nothing (Map.md byte-identical, no undo step, no plan)', async () => {
  const h = await harness();
  const before = await h.hash();
  h.control.reply = async () => ({ reply: 'Here is the table', actions: [], rejected: [], remaining: '', comparison: comparison(h.ids) });
  await h.send('Compare Ribeye and Filet');
  await tick();
  assert.equal(h.chat.attached.length, 1);
  assert.equal(h.chat.plans.length, 0, 'no plan card: nothing to apply');
  assert.equal(h.chat.attached[0].rows.length, 2);
  assert.equal(await h.hash(), before);
  assert.equal(h.view.history.undoEntry, undefined);
});

test('F08a view: a reply without a comparison attaches nothing', async () => {
  const h = await harness();
  h.control.reply = async () => ({ reply: 'plain', actions: [], rejected: [], remaining: '' });
  await h.send('hi');
  assert.equal(h.chat.attached.length, 0);
});
