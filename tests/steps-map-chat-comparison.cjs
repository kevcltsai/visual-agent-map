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
const { buildComparisonTable, comparisonMarkdown, comparisonCell, comparisonColumnHeader } = load('core/map-chat-comparison.ts');

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
    markTurn() {}, attached: [], attachComparison(table, anchor) { chat.attached.push(table); (chat.anchors ??= []).push(anchor); }, refreshReplyUndo() {}, completedTurns: () => [], conversationId: undefined,
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


// ---- F08b: save the comparison as one new card, only when asked ----
const headerWords = { withUnit: (n, u) => `${n} (${u})`, noUnit: n => `${n} (no unit)` };
const mdOf = (comparison, extra = {}) => comparisonMarkdown(buildComparisonTable(comparison, { titleOf: id => titles[id] ?? null, unknown: 'Unknown' }), { header: c => comparisonColumnHeader(c, headerWords), gone: '(gone)', notes: [], ...extra });

test('F08b markdown: the table is the displayed one (unknown cells, unit-split headers, row titles) as a GFM table', () => {
  const md = mdOf({ attributes: [{ name: 'Fee' }, { name: 'Discount' }], rows: [row('a', { value: '290', unit: 'NT$' }, '15%'), row('b', { value: '12', unit: 'US$' }, null), row('zz', '5', '1%')] });
  assert.equal(md, [
    '|  | Fee \\(NT\\$\\) | Fee \\(US\\$\\) | Fee \\(no unit\\) | Discount \\(\\%\\) |',
    '| --- | --- | --- | --- | --- |',
    '| A Co | 290 | Unknown | Unknown | 15\\% |',
    '| B Co | Unknown | 12 | Unknown | Unknown |',
    '| \\(gone\\) | Unknown | Unknown | 5 | 1\\% |'
  ].join('\n'));
});

test('F08b markdown (counter-example): pipes and line breaks in cells, titles and headers never break a row; a trailing backslash is kept', () => {
  assert.equal(comparisonCell('a|b'), 'a\\|b');
  assert.equal(comparisonCell('l1\nl2\r\nl3'), 'l1<br>l2<br>l3');
  assert.equal(comparisonCell('x\\'), 'x\\\\');
  assert.equal(comparisonCell('x\\|y'), 'x\\\\\\|y');
  assert.equal(comparisonCell('  pad  '), 'pad');
  assert.equal(comparisonCell('NT$290'), 'NT\\$290');
  assert.equal(comparisonCell('a<b>&c'), 'a&lt;b&gt;&amp;c');
  const md = comparisonMarkdown(buildComparisonTable({ attributes: [{ name: 'A|B' }], rows: [row('a', 'x|y\nz')] }, { titleOf: () => 'T|1', unknown: 'U' }), { header: c => c.name, gone: 'g', notes: [] });
  const lines = md.split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(line.replace(/\\\|/g, '').split('|').length, 4, `exactly 3 cells in: ${line}`);
  assert.match(lines[2], /T\\\|1 \| x\\\|y<br>z/);
});

const INJECTIONS = [
  '<!-- vam-living-node:begin v1 -->',
  '<!-- vam-living-node:begin v1 -->x<!-- vam-living-node:end v1 -->',
  '<!-- visual-agent-map:detail:end -->',
  '<!-- vam-book-open-issues -->',
  '[[x]]',
  '![[x]]',
  '<img src=x onerror=alert(1)>',
  '<iframe src=x></iframe>',
  '%%hidden%%',
  '<!-- c -->',
  'a<br>b'
];

test('F08b markdown (counter-example): every cell, header, unit and title is literal text; no marker, link, embed, comment or tag survives', () => {
  const { splitLivingNodeRegion } = load('core/living-node-region.ts');
  for (const bad of INJECTIONS) {
    const md = comparisonMarkdown(buildComparisonTable({ attributes: [{ name: bad, unit: bad }], rows: [row('a', { value: bad, unit: bad })] }, { titleOf: () => bad, unknown: 'U' }), { header: c => comparisonColumnHeader(c, headerWords), gone: bad, notes: [] });
    assert.equal(md.split('\n').length, 3, `still a 3-line table: ${bad}`);
    assert.equal(splitLivingNodeRegion(md).region, '', `no region: ${bad}`);
    assert.doesNotMatch(md.replace(/<br>/g, '').replace(/\\./g, ''), /[[\]%!<>]/, `every punctuation is escaped and only our own br remains: ${bad}`);
  }
  assert.equal(comparisonCell('a<br>b'), 'a&lt;br&gt;b', 'a model-written <br> is text, not a line break');
  assert.equal(comparisonCell('NT$290'), 'NT\\$290', 'a normal value reads the same in reading mode');
});

for (const where of ['cell', 'attribute name', 'unit', 'card title']) {
  test(`F08b save (counter-example): hostile text in a ${where} saves a plain card (no Living Node region, no link, no embed, no comment)`, async () => {
    const { splitLivingNodeRegion } = load('core/living-node-region.ts');
    for (const bad of INJECTIONS) {
      const h = await harness();
      await h.view.hydrate();
      if (where === 'card title') h.view.notes.get(h.ids.a).title = bad;
      const cmp = {
        attributes: [{ name: where === 'attribute name' ? bad : 'Fee', ...(where === 'unit' ? { unit: bad } : {}) }],
        rows: [row(h.ids.a, { value: where === 'cell' ? bad : 'NT$290', ...(where === 'unit' ? { unit: bad } : {}) }), row(h.ids.b, '5')]
      };
      const result = await h.view.saveComparison(cmp, anchorOf(h));
      assert.equal(result.ok, true, `saved: ${bad}`);
      const made = (await h.saved()).nodes.find(n => n.id === result.nodeId);
      const text = await h.app.vault.read(h.app.vault.getAbstractFileByPath(made.path));
      assert.equal(splitLivingNodeRegion(text).region, '', `no region: ${bad}`);
      const table = text.split('\n').filter(line => line.startsWith('|')).join('\n');
      const plainText = table.replace(/\\./g, '');
      assert.doesNotMatch(plainText, /<!--|\[\[|!\[|<img|<iframe|%%/, `no unescaped marker in the table: ${bad}`);
      assert.doesNotMatch(text, /<img|<iframe|%%hidden|<!-- c -->|<!--\s*vam-book-open-issues/, `none in the whole note: ${bad}`);
    }
  });
}

test('F08b markdown: the cut notes the chat shows follow the table, as plain italic lines', () => {
  const md = mdOf({ attributes: [{ name: 'Fee' }], rows: [row('a', '1')] }, { notes: ['3 more rows are not shown', '2 more *attributes*\nnot shown'] });
  assert.match(md, /\n\n\*3 more rows are not shown\*\n\n\*2 more attributes not shown\*$/);
  assert.equal(mdOf({ attributes: [{ name: 'Fee' }], rows: [row('a', '1')] }).split('\n\n').length, 1, 'no cut, no notes');
});

const anchorOf = h => ({ path: MAP, id: h.view.map.id });
const noteOf = (h, key) => h.app.vault.read(h.app.vault.getAbstractFileByPath(h.view.map.nodes.find(n => n.id === h.ids[key]).path));
async function otherFileHashes(h, except = []) {
  const out = {};
  for (const file of h.app.vault.getMarkdownFiles()) if (!except.includes(file.path)) out[file.path] = crypto.createHash('sha256').update(await h.app.vault.read(file)).digest('hex');
  return out;
}
const cmpFor = h => ({ attributes: [{ name: 'Fee' }, { name: 'Discount' }], rows: [row(h.ids.a, { value: '290', unit: 'NT$' }, '15%'), row(h.ids.b, { value: '12', unit: 'US$' }, null)] });

test('F08b save: one click makes exactly one new top-level card with the table and source links; the originals are byte-identical; one undo removes it', async () => {
  const h = await harness();
  await h.view.hydrate();
  const mapBefore = await h.saved();
  const before = await otherFileHashes(h, [MAP]);
  const result = await h.view.saveComparison(cmpFor(h), anchorOf(h));
  assert.equal(result.ok, true);
  const after = await h.saved();
  assert.equal(after.nodes.length, mapBefore.nodes.length + 1, 'exactly one new card');
  const made = after.nodes.find(n => !mapBefore.nodes.some(o => o.id === n.id));
  assert.equal(made.parentId, null, 'top level');
  assert.equal(result.nodeId, made.id);
  const others = after.nodes.filter(n => n.id !== made.id);
  assert.deepEqual(plain(others.map(n => [n.id, n.x, n.y])), plain(mapBefore.nodes.map(n => [n.id, n.x, n.y])), 'no existing card moved');
  const rect = n => ({ l: n.x, r: n.x + (n.width ?? 300), t: n.y, b: n.y + (h.view.cardHeightOf(n.id) ?? 180) });
  const clash = others.filter(n => { const p = rect(n), q = rect(made); return p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b; });
  assert.deepEqual(plain(clash.map(n => n.id)), [], 'placed clear of every other card (P1.4)');
  const text = await h.app.vault.read(h.app.vault.getAbstractFileByPath(made.path));
  assert.match(text, /\| {2}\| Fee \\\(NT\\\$\\\) \| Fee \\\(US\\\$\\\) \| Discount \\\(\\%\\\) \|/);
  assert.match(text, /\| Ribeye \| 290 \| Unknown \| 15\\% \|/);
  assert.match(text, /\| Filet \| Unknown \| 12 \| Unknown \|/);
  for (const key of ['a', 'b']) {
    const node = mapBefore.nodes.find(n => n.id === h.ids[key]);
    assert.ok(text.includes(`[[${node.path.replace(/\.md$/, '')}`), `a wikilink to ${key}'s note`);
  }
  assert.doesNotMatch(text, /Brisket/, 'a card that is not in the comparison is not linked');
  const mapAfter = await h.saved();
  assert.deepEqual(plain({ ...mapAfter, nodes: mapAfter.nodes.filter(n => n.id !== made.id) }.nodes.map(n => n.id)), plain(mapBefore.nodes.map(n => n.id)));
  const now = await otherFileHashes(h, [MAP, made.path]);
  const newNotes = Object.keys(now).filter(path => !(path in before));
  for (const path of Object.keys(before)) assert.equal(now[path], before[path], `unchanged: ${path}`);
  assert.deepEqual(newNotes.filter(p => p !== made.path), [], 'no other new file');
  assert.equal(h.view.history.undoEntry.label, 'Save comparison as a new card');
  await h.view.travel(false);
  assert.equal((await h.saved()).nodes.some(n => n.id === made.id), false, 'one undo removes the card');
  assert.equal(h.view.history.undoEntry, undefined, 'and it was the only step');
});

test('F08b save: the originals notes are byte-identical before and after (with and without undo)', async () => {
  const h = await harness();
  await h.view.hydrate();
  const orig = {};
  for (const key of ['root', 'a', 'b', 'c']) orig[key] = await noteOf(h, key);
  await h.view.saveComparison(cmpFor(h), anchorOf(h));
  for (const key of Object.keys(orig)) assert.equal(await noteOf(h, key), orig[key], `${key} note unchanged`);
  await h.view.travel(false);
  for (const key of Object.keys(orig)) assert.equal(await noteOf(h, key), orig[key], `${key} note unchanged after undo`);
});

test('F08b save (counter-example): a click while one is saving or twice in a row creates at most one card per click-through (no duplicates)', async () => {
  const h = await harness();
  await h.view.hydrate();
  const first = h.view.saveComparison(cmpFor(h), anchorOf(h));
  const second = h.view.saveComparison(cmpFor(h), anchorOf(h));
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1, 'only one of two simultaneous calls writes');
  assert.equal((await h.saved()).nodes.length, 5);
  assert.equal((await h.view.saveComparison(cmpFor(h), anchorOf(h))).ok, true, 'a later, separate press (the panel allows it only after a failure) is its own card');
  assert.equal((await h.saved()).nodes.length, 6);
});

test('F08b gate (counter-example): read-only (presenting, notes loading), merging, AIM or another map write nothing and say why', async () => {
  const h = await harness();
  await h.view.hydrate();
  const before = await h.hash();
  const cmp = cmpFor(h);
  const tries = async () => h.view.saveComparison(cmp, anchorOf(h));
  h.view.presentation = { order: [], currentId: null };
  assert.ok(h.view.comparisonSaveBlock(cmp, anchorOf(h)), 'presenting is blocked with a reason');
  assert.equal((await tries()).ok, false);
  h.view.presentation = null;
  const loading = h.view.notesLoading; h.view.notesLoading = () => true;
  assert.ok(h.view.comparisonSaveBlock(cmp, anchorOf(h)));
  assert.equal((await tries()).ok, false);
  h.view.notesLoading = loading;
  h.view.isMerging = id => id === h.ids.b;
  assert.equal(h.view.comparisonSaveBlock(cmp, anchorOf(h)), 'Merging; try again when it finishes');
  assert.equal((await tries()).ok, false);
  h.view.isMerging = () => false;
  assert.equal(h.view.comparisonSaveBlock(cmp, anchorOf(h)), null, 'free again');
  h.view.map.aim = { kind: 'research' };
  assert.match(h.view.comparisonSaveBlock(cmp, anchorOf(h)), /AIM/);
  assert.equal((await tries()).ok, false);
  delete h.view.map.aim;
  assert.ok(h.view.comparisonSaveBlock(cmp, { path: MAP, id: 'another-map' }), 'a comparison of another map');
  assert.equal(await h.hash(), before, 'nothing was written by any of them');
  assert.equal(h.view.history.undoEntry, undefined);
  assert.equal((await h.view.saveComparison(cmp, anchorOf(h))).ok, true, 'and it works once the block is gone');
});

test('F08b save: a comparison whose cards are gone from the map still saves its table; the gone row has no link', async () => {
  const h = await harness();
  await h.view.hydrate();
  const cmp = { attributes: [{ name: 'Fee' }], rows: [row(h.ids.a, '1'), row('gone-id', '2')] };
  const result = await h.view.saveComparison(cmp, anchorOf(h));
  assert.equal(result.ok, true);
  const made = (await h.saved()).nodes.find(n => n.id === result.nodeId);
  const text = await h.app.vault.read(h.app.vault.getAbstractFileByPath(made.path));
  assert.match(text, /\\\(card no longer on the map\\\) \| 2 \|/);
  assert.equal((text.match(/\[\[[^\]]*Notes\/[^\]]*\]\]/g) ?? []).length >= 1, true);
});

test('F08b save: it never calls the AI', async () => {
  const h = await harness();
  await h.view.hydrate();
  let calls = 0; h.control.reply = async () => { calls++; return { reply: '', actions: [], rejected: [] }; };
  h.view.plugin.askModel = async () => { calls++; throw new Error('no AI'); };
  await h.view.saveComparison(cmpFor(h), anchorOf(h));
  assert.equal(calls, 0);
});

test('F08b wiring: the reply hands the chat the map the table is about, and the host methods the button uses exist on the view', async () => {
  const h = await harness();
  h.control.reply = async () => ({ reply: 'Here is the table', actions: [], rejected: [], remaining: '', comparison: comparison(h.ids) });
  await h.send('Compare Ribeye and Filet');
  await tick();
  assert.deepEqual(plain(h.chat.anchors), [{ path: MAP, id: h.view.map.id }]);
  const host = h.view.chatHost();
  assert.equal(host.comparisonSaveBlock(h.chat.attached[0], h.chat.anchors[0]), null);
  assert.equal((await host.saveComparison(h.chat.attached[0], h.chat.anchors[0])).ok, true);
});
