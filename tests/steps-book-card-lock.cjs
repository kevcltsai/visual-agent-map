// Owner 2026-11-23: while a picture-book run owns the map, card AI and structure edits are taken away (bookCardLock): AI until the
// book is done; structure while it plans, writes or checks (gate 1, the plan review, keeps them). Done gives everything back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');
const MAP = 'Agent Workspace/Topics/map-bk1/Map.md';
const notices = [];
const timers = { hold: false, held: [] };
class OptionStub { constructor(text, value) { const o = dom.element('option', { text }); o.optionValue = value; o.value = value; o.disabled = false; return o; } }
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export { bookChapterCalls, bookWholeCalls, bookStartEstimate, bookStartEstimateText, bookSettingsPatch, BookStartModal, BOOK_SUGGEST_TIMEOUT_MS } from "./experiences/visual-map/book-pipeline-start-modal";
export { deletedChapterTitles, mentionedDeletedChapters, renderBookSettingsFields } from "./experiences/visual-map/book-pipeline-start-modal";
export { BookStepError } from "./core/steps/book-pipeline/base";
export { BookPipelineRunError, stepCounts } from "./experiences/visual-map/book-pipeline-run";
export { readBookPipeline } from "./core/book-pipeline/model";
export { fixAgainPlan } from "./core/book-pipeline/machine";
export { bookStructure } from "./core/book-pipeline/structure";
export { OPEN_ISSUES_MARKER } from "./core/book-pipeline/open-issues";
export { reviewEntries, putProgramCallout, collapseReviewCallouts, markReviewHandled } from "./experiences/visual-map/book-pipeline-review";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage, t } from "./i18n";
`, { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice(notices), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Option: OptionStub, window: { setTimeout: (fn, ms) => (ms === 20000 && timers.hold ? (timers.held.push(fn), 99) : setTimeout(fn, ms)), clearTimeout, setInterval, clearInterval } });
const { setUiLanguage, t: tr } = bundle;
const legacy = require('./support-legacy-boxes.cjs')(bundle);
const { OPEN_ISSUES_MARKER } = bundle;
const ui = bundle, runModule = bundle, model = bundle, bundleStart = bundle;
const flat = text => text.replace(/\s+/g, ' ');
const view_ts = flat(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'));
const main_ts = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const lang = language => { setUiLanguage(language); };
const texts = el => dom.findAll(el, i => i.text).map(i => i.text);
const bookData = (over = {}) => ({
  v: 1, runId: 'r1', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd'], globalPlanned: true, attempts: { global: 1 }, revisions: {},
  budget: { used: 12, limit: 300 }, revision: 1, startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z', ...over
});
const progress = (over = {}) => ({
  runId: 'r1', phase: 'writing', status: 'running', active: true, total: 4,
  counts: { pending: 0, planned: 1, written: 1, checked: 1, 'needs-review': 1 }, budget: { used: 12, limit: 300 },
  startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z', ...over
});
const noStage = () => undefined;
async function harness({ book, stages = {}, issue, phase }) {
  const { repo, app } = support.fixture('zh-TW', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-bk1', title: 'BK', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-bk1');
  const ids = {};
  for (const [key, parent] of [['root', null], ['a', 'root'], ['b', 'root']]) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace', { summary: `summary of ${key}` });
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: 0, y: mapDoc.nodes.length * 100 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  }
  if (book) mapDoc.bookPipeline = bookData({ order: [ids.root, ids.a, ids.b], ...(phase ? { phase } : {}) });
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  notices.length = 0;
  setUiLanguage('zh-TW');
  const { VisualAgentMapView } = bundle;
  const entries = [];
  const ctl = { calls: [], saves: [], impl: async () => ({}) };
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => Promise.resolve().then(work),
    getBookPipelineProgress: () => undefined,
    argumentRuns: { isRunning: () => false },
    modelLabel: model => `M:${model}`,
    availableModels: () => ['claude:sonnet', 'claude:opus', 'claude:haiku'],
    saveSettings: async () => { ctl.saves.push({ ...settings }); },
    suggestBookSettings: (input, signal) => { ctl.calls.push({ input, signal }); return ctl.impl(input, signal); },
    startBookPipeline: async (p, o) => { entries.push(o ? ['start', p, o] : ['start', p]); },
    stopBookPipeline: async p => { entries.push(['stop', p]); },
    resumeBookPipeline: async (p, o) => { entries.push(['resume', p, o]); },
    confirmBookGate1: async p => { entries.push(['confirm', p]); },
    abandonBookPipeline: async p => { entries.push(['abandon', p]); },
    fixBookAgain: async p => { entries.push(['again', p]); }
  });
  support.attachTopicRuns(plugin);
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = dom.element('div'); view.contentEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.labelCard = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  for (const [key, stage] of Object.entries(stages)) Object.assign(view.notes.get(ids[key]), { pipelineStage: stage, bookRole: key === 'root' ? 'intro' : 'body', ...(stage === 'needs-review' ? { pipelineIssue: issue } : {}) });
  view.render = () => { view.rendered = (view.rendered ?? 0) + 1; };
  view.selection.moveTabStop(view.defaultTabStop(view.map.nodes));
  const paint = () => { view.stageEl = dom.element('div'); view.cardEls.clear(); for (const n of view.map.nodes) view.renderNode(n); return view.stageEl; };
  return { view, ids, paint, entries, notices, plugin, ctl };
}

const named = (stage, label) => dom.findAll(stage, i => i.tag === 'button' && i.attrs?.['aria-label'] === label);
const byCls = (stage, cls) => dom.findAll(stage, i => i.classes?.includes?.(cls) || i.cls?.split?.(' ').includes(cls));
const menuOf = (h, nodeKey) => {
  const items = [];
  const chain = it => ({ setTitle(x) { it.title = x; return this; }, setIcon() { return this; }, setDisabled() { return this; }, setChecked() { return this; }, setWarning() { return this; }, setSubmenu() { return { addItem() { return this; } }; }, onClick(fn) { it.fn = fn; return this; } });
  const menu = { addItem(build) { const it = {}; build(chain(it)); items.push(it); return menu; }, addSeparator() { return menu; } };
  h.view.addCardMenuActions(menu, h.view.map.nodes.find(n => n.id === h.ids[nodeKey]));
  return items.map(i => i.title);
};
const atPhase = (h, phase) => { h.plugin.getBookPipelineProgress = () => (phase ? progress({ phase }) : undefined); h.view.bookPipelineSeen = null; };

test('book lock: while the book writes, a card has no Research and no Add button; Note and More stay (More has no card settings or select subtopics: they are structure-locked)', async () => {
  const h = await harness({ book: true, stages: { a: 'planned', b: 'planned' } });
  for (const phase of ['planning', 'writing', 'gate2']) {
    atPhase(h, phase);
    const stage = h.paint();
    assert.equal(byCls(stage, 'vam-ai-explore').length, 0, `${phase}: no Research`);
    assert.equal(byCls(stage, 'vam-add-child-tool').length, 0, `${phase}: no Add`);
    assert.equal(byCls(stage, 'vam-detail-button').length, 3, `${phase}: Note stays on every card`);
    assert.equal(byCls(stage, 'vam-card-tool-more').length, 3, `${phase}: More stays on every card`);
    const items = menuOf(h, 'root');
    for (const gone of [tr('ui.card_menu_research'), tr('ui.card_menu_add_child'), tr('ui.card_menu_add_sibling'), tr('ui.card_settings_menu'), tr('ui.select_subtopics')])
      assert.ok(!items.includes(gone), `${phase}: menu has no ${gone}`);
    assert.ok(items.includes(tr('ui.card_menu_open_note')), `${phase}: read-only items stay`);
    assert.ok(items.includes(tr('ui.book_card_menu')), `${phase}: the book's own submenu (chapter role) stays`);
  }
});

test('book lock: the saved phase counts when the runner knows nothing (after a reload, a stopped run); the plan review keeps structure, not AI', async () => {
  const h = await harness({ book: true, phase: 'writing', stages: { a: 'planned' } });
  h.view.map.bookPipeline.status = 'stopped';
  atPhase(h, undefined);
  let stage = h.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 0, 'stopped but not abandoned: still locked');
  assert.equal(byCls(stage, 'vam-add-child-tool').length, 0);
  atPhase(h, 'gate1');
  stage = h.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 0, 'gate 1: no AI');
  assert.equal(byCls(stage, 'vam-add-child-tool').length, 3, 'gate 1: Add stays (the review detects hand edits)');
  assert.ok(menuOf(h, 'a').includes(tr('ui.card_settings_menu')), 'gate 1: card settings stay');
  assert.ok(menuOf(h, 'a').includes(tr('ui.card_menu_add_child')));
  assert.ok(!menuOf(h, 'a').includes(tr('ui.card_menu_research')));
});

test('book lock: done, and a map without a book, give every tool back', async () => {
  const h = await harness({ book: true, stages: { a: 'checked' } });
  atPhase(h, 'done');
  let stage = h.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 3);
  assert.equal(byCls(stage, 'vam-add-child-tool').length, 3);
  assert.ok(menuOf(h, 'a').includes(tr('ui.card_menu_research')));
  const plain = await harness({ book: false });
  stage = plain.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 3);
  assert.equal(byCls(stage, 'vam-add-child-tool').length, 3);
});

test('book lock: the entries refuse too while the book writes (AI chat, the + list, Delete key, drag onto a card)', async () => {
  const h = await harness({ book: true, stages: { a: 'planned' } });
  atPhase(h, 'writing');
  const node = h.view.map.nodes.find(n => n.id === h.ids.a);
  h.view.openTopicChat(node);
  assert.equal(h.view.topicChatOpen ?? null, null, 'no topic chat opens');
  let menus = 0;
  h.view.newMenu = () => { menus++; return { addItem() { return this; }, addSeparator() { return this; }, showAtMouseEvent() {}, select() {} }; };
  h.view.openAddMenu({ clientX: 1, clientY: 1, preventDefault() {}, stopPropagation() {} }, node);
  assert.equal(menus, 0, 'the + list does not open');
  const count = h.view.map.nodes.length;
  const card = (h.paint(), h.view.cardEls.get(h.ids.a));
  let removed = 0;
  h.view.removeByKey = () => { removed++; };
  card.fire('keydown', { key: 'Delete', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, currentTarget: card });
  await dom.tick();
  assert.equal(removed, 0, 'Delete removes nothing');
  assert.equal(h.view.map.nodes.length, count);
  atPhase(h, 'done');
  card.fire('keydown', { key: 'Delete', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, currentTarget: card });
  assert.equal(removed, 1, 'once the book is done the Delete key works again (the test reaches the real handler)');
  // Drag: the reparent target check refuses while locked (source: the one check sits in targetAt).
  assert.ok(view_ts.includes('if (!this.canSelectTopics() || !this.map || this.bookLock().structure) return null;'), 'targetAt finds no new parent while locked');
});
