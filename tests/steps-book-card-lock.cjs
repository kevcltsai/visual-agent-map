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
// The right-click rows: title, whether it is greyed, and the hint lines drawn under it (menuHint).
const menuRows = (h, nodeKey) => {
  const items = [];
  const chain = it => ({ setTitle(x) { it.title = x; return this; }, setIcon() { return this; }, setDisabled(d) { it.disabled = d; return this; }, setChecked() { return this; }, setWarning() { return this; }, setSubmenu() { return { addItem() { return this; }, addSeparator() { return this; } }; }, onClick(fn) { it.fn = fn; return this; }, dom: { addClass(c) { it.cls = c; }, createSpan(o) { it.hints.push(o); } } });
  const menu = { addItem(build) { const it = { hints: [] }; build(chain(it)); items.push(it); return menu; }, addSeparator() { return menu; } };
  h.view.addCardMenuActions(menu, h.view.map.nodes.find(n => n.id === h.ids[nodeKey]));
  return items;
};
// The titles of the rows that can be used now.
const menuOf = (h, nodeKey) => menuRows(h, nodeKey).filter(i => !i.disabled).map(i => i.title);
const atPhase = (h, phase) => { h.plugin.getBookPipelineProgress = () => (phase ? progress({ phase }) : undefined); h.view.bookPipelineSeen = null; };

test('book lock: while the book writes, a card has no AI explore and no edge +; Style (B19b-x, decision #62), Note and More stay (the menu greys Research, the new topics, card settings and select subtopics, with the book lock as the reason)', async () => {
  const h = await harness({ book: true, stages: { a: 'planned', b: 'planned' } });
  for (const phase of ['planning', 'writing', 'gate2']) {
    atPhase(h, phase);
    const stage = h.paint();
    assert.equal(byCls(stage, 'vam-ai-explore').length, 0, `${phase}: no Research`);
    // B08: the toolbar has no Add; the edge + goes with the structure lock. B19b-x: Style is not structure, it stays.
    assert.equal(byCls(stage, 'vam-card-edge-add').length, 0, `${phase}: no edge +`);
    assert.equal(byCls(stage, 'vam-card-tool-style').length, 3, `${phase}: Style stays on every card`);
    assert.equal(byCls(stage, 'vam-detail-button').length, 3, `${phase}: Note stays on every card`);
    assert.equal(byCls(stage, 'vam-card-tool-more').length, 3, `${phase}: More stays on every card`);
    const rows = menuRows(h, 'root');
    const items = menuOf(h, 'root');
    for (const gone of [tr('ui.ai_explore'), tr('ui.card_menu_add_child'), tr('ui.card_menu_add_sibling'), tr('ui.card_settings_menu'), tr('ui.select_subtopics')]) {
      assert.ok(!items.includes(gone), `${phase}: ${gone} cannot be used`);
      const row = rows.find(i => i.title === gone);
      assert.ok(row?.disabled, `${phase}: ${gone} is greyed`);
      assert.deepEqual(row.hints.map(o => [o.cls, o.text]), [['vam-menu-reason', tr('ui.card_action_off_book_lock')]], `${phase}: ${gone} says why`);
      assert.equal(row.cls, 'vam-menu-has-reason', `${phase}: ${gone}'s row wraps the reason onto its own line`);
      assert.equal(row.fn, undefined, `${phase}: ${gone} has no click`);
    }
    assert.ok(items.includes(tr('ui.card_menu_style')), `${phase}: the right-click Style stays usable (B19b-x)`);
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
  assert.equal(byCls(stage, 'vam-card-edge-add').length, 0, 'stopped: no edge +');
  assert.equal(byCls(stage, 'vam-card-tool-style').length, 3, 'stopped: Style stays (B19b-x)');
  atPhase(h, 'gate1');
  stage = h.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 0, 'gate 1: no AI');
  assert.equal(byCls(stage, 'vam-card-edge-add').length, 3, 'gate 1: the edge + stays (the review detects hand edits)');
  assert.equal(byCls(stage, 'vam-card-tool-style').length, 3, 'gate 1: Style stays');
  assert.ok(menuOf(h, 'a').includes(tr('ui.card_settings_menu')), 'gate 1: card settings stay');
  assert.ok(menuOf(h, 'a').includes(tr('ui.card_menu_add_child')));
  assert.ok(!menuOf(h, 'a').includes(tr('ui.ai_explore')));
});

test('book lock: done, and a map without a book, give every tool back', async () => {
  const h = await harness({ book: true, stages: { a: 'checked' } });
  atPhase(h, 'done');
  let stage = h.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 3);
  assert.equal(byCls(stage, 'vam-card-edge-add').length, 3);
  assert.equal(byCls(stage, 'vam-card-tool-style').length, 3);
  assert.ok(menuOf(h, 'a').includes(tr('ui.ai_explore')));
  const plain = await harness({ book: false });
  stage = plain.paint();
  assert.equal(byCls(stage, 'vam-ai-explore').length, 3);
  assert.equal(byCls(stage, 'vam-card-edge-add').length, 3);
  assert.equal(byCls(stage, 'vam-card-tool-style').length, 3);
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

test('book lock: a structure lock adds no text block from any entry (the panel and palette add, a free block, the canvas right-click): Map.md is not written', async () => {
  const h = await harness({ book: true, stages: { a: 'planned' } });
  atPhase(h, 'writing');
  let pending = Promise.resolve();
  h.plugin.mutate = work => (pending = pending.then(work));
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const file = h.view.app.vault.getAbstractFileByPath(MAP);
  const before = await h.view.app.vault.read(file);
  const node = h.view.map.nodes.find(n => n.id === h.ids.a);
  // The add list's Text row and the add-text-node command both call addTextNodeUnder (with and without a selected card).
  h.view.addTextNodeUnder(node);
  await settle();
  h.view.selection.setSelected(null);
  h.view.viewportEl = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }) };
  h.view.addTextNodeUnder();
  await settle();
  assert.equal(await h.view.app.vault.read(file), before, 'no text block is written while the book writes');
  assert.equal((h.view.map.canvasItems ?? []).length, 0);
  assert.equal(h.view.textAddLocked?.(), true, 'the add-text-node command is not offered (its checkCallback asks textAddLocked)');
  assert.ok(main_ts.includes('if (!view || view.textAddLocked()) return false;'), 'the palette command checks textAddLocked');
  // The canvas right-click keeps "Add text here", greyed with the book lock as the reason.
  const items = [];
  const chain = it => ({ setTitle(x) { it.title = x; return this; }, setIcon() { return this; }, setDisabled(d) { it.disabled = d; return this; }, onClick(fn) { it.fn = fn; return this; }, dom: { addClass() {}, createSpan(o) { it.hints.push(o.text); } } });
  h.view.newMenu = () => ({ setUseNativeMenu() {}, addItem(build) { const it = { hints: [] }; build(chain(it)); items.push(it); return this; }, addSeparator() { return this; }, showAtMouseEvent() {} });
  h.view.stagePoint = () => ({ x: 10, y: 10 });
  h.view.onCanvasContextMenu({ target: { closest: () => null }, clientX: 5, clientY: 5, preventDefault() {} });
  const row = items.find(i => i.title === tr('ui.text_node_add_here'));
  assert.ok(row, 'the row stays');
  assert.equal(row.disabled, true);
  assert.equal(row.fn, undefined, 'a click does nothing');
  assert.deepEqual(row.hints, [tr('ui.card_action_off_book_lock')]);
  // Done gives it back: the same call writes one block.
  atPhase(h, 'done');
  assert.equal(h.view.textAddLocked(), false);
  h.view.addTextNodeUnder(node);
  await settle();
  assert.notEqual(await h.view.app.vault.read(file), before, 'once the book is done a text block is added');
});

// V3.3 G04-z: the right-click goes through the real viewport binding (setupCanvasImageInput), which used to be bound only while the
// canvas was editable, so a card never got its menu while the notes loaded although its ⋯ did.
const cardMenus = h => {
  const opened = [];
  const chain = it => ({ setTitle(x) { it.title = x; return this; }, setIcon() { return this; }, setDisabled(d) { it.disabled = d; return this; }, setChecked() { return this; }, setWarning() { return this; }, setSubmenu() { return { addItem() { return this; }, addSeparator() { return this; } }; }, onClick(fn) { it.fn = fn; return this; }, dom: { addClass(c) { it.cls = c; }, createSpan(o) { it.hints.push(o.text); } } });
  h.view.newMenu = () => { const items = []; opened.push(items); return { setUseNativeMenu() {}, addItem(build) { const it = { hints: [] }; build(chain(it)); items.push(it); return this; }, addSeparator() { return this; }, showAtPosition() {}, showAtMouseEvent() {} }; };
  return opened;
};
const boundCardRightClick = (h, target) => {
  h.view.viewportEl = dom.element('div');
  h.view.setupCanvasImageInput();
  h.view.viewportEl.fire('contextmenu', { target: { closest: sel => (sel === '.vam-node' ? target : null) }, clientX: 5, clientY: 5 });
};
test('G04-z: while the notes load the real contextmenu binding opens the card list, rows greyed with the reason, same as ⋯; selection mode, presentation and other targets open nothing', async () => {
  const h = await harness({ book: false });
  h.plugin.mutate = async () => { throw new Error('nothing may be written'); };
  h.view.noteLoad = { framed: false };
  h.paint();
  // Re-render while loading, then right-click through the binding.
  const stage = h.paint();
  h.view.contentEl = stage;
  const card = h.view.cardEls.get(h.ids.a);
  const more = byCls(card, 'vam-card-tool-more')[0];
  more.getBoundingClientRect = () => ({ left: 0, bottom: 0 });
  const opened = cardMenus(h);
  boundCardRightClick(h, card);
  assert.equal(opened.length, 1, 'the right-click opens while the notes load');
  more.fire('click', { metaKey: false, ctrlKey: false });
  assert.equal(opened.length, 2, '⋯ opens too');
  const [context, moreRows] = [opened[0], opened[1]];
  for (const row of context) {
    assert.equal(row.disabled, true, `${row.title} greyed`);
    assert.deepEqual(row.hints, [tr('ui.card_action_off_notes_loading')], `${row.title} gives the reason`);
    assert.equal(row.fn, undefined, `${row.title} has no click`);
  }
  // ⋯ is the right-click list minus the toolbar's own actions (one registry, addCardActions): same state, same reason.
  assert.ok(context.length >= moreRows.length, 'the right-click list has every ⋯ row');
  for (const row of moreRows) {
    assert.equal(row.disabled, true, `⋯ ${row.title} greyed`);
    assert.deepEqual(row.hints, [tr('ui.card_action_off_notes_loading')], `⋯ ${row.title}: same reason as the right-click`);
  }
  // Another target while loading (the empty canvas) still opens nothing.
  h.view.viewportEl.fire('contextmenu', { target: { closest: () => null }, clientX: 5, clientY: 5 });
  assert.equal(opened.length, 2, 'the empty canvas stays shut');
  // Topic selection: ⋯ is not drawn, so no menu.
  h.view.selection.toggleMultiSelect();
  boundCardRightClick(h, card);
  assert.equal(opened.length, 2, 'no card menu in topic selection');
  h.view.selection.toggleMultiSelect();
  // Presenting opens none.
  h.view.presentation = {};
  boundCardRightClick(h, card);
  assert.equal(opened.length, 2, 'no card menu while presenting');
});

test('notes loading (decision #35, P1.1): the card ⋯ and right-click open, every row greyed with "notes loading" and no click; nothing is written', async () => {
  const h = await harness({ book: false });
  let pending = Promise.resolve(), mutations = 0;
  h.plugin.mutate = work => { mutations++; return (pending = pending.then(work)); };
  h.view.noteLoad = { framed: false };
  const stage = h.paint();
  const more = byCls(stage, 'vam-card-tool-more');
  assert.equal(more.length, 3, 'every card keeps its ⋯ while loading');
  // lockWhileLoading greys the other buttons, not ⋯.
  h.view.contentEl = stage;
  for (const button of more) button.getBoundingClientRect = () => ({ left: 0, bottom: 0 });
  for (const button of more) button.closest = sel => (sel.split(', ').includes('.vam-card-tool-more') ? button : null);
  h.view.lockWhileLoading();
  assert.equal(more[0].disabled, false, 'lockWhileLoading keeps ⋯ usable');
  assert.ok(byCls(stage, 'vam-detail-button').every(b => b.disabled), 'the other card buttons are still locked');
  // ⋯ opens its menu; the right-click opens the card's list.
  const opened = [];
  const chain = it => ({ setTitle(x) { it.title = x; return this; }, setIcon() { return this; }, setDisabled(d) { it.disabled = d; return this; }, setChecked() { return this; }, setWarning() { return this; }, setSubmenu() { return { addItem() { return this; }, addSeparator() { return this; } }; }, onClick(fn) { it.fn = fn; return this; }, dom: { addClass(c) { it.cls = c; }, createSpan(o) { it.hints.push(o.text); } } });
  h.view.newMenu = () => { const items = []; opened.push(items); return { setUseNativeMenu() {}, addItem(build) { const it = { hints: [] }; build(chain(it)); items.push(it); return this; }, addSeparator() { return this; }, showAtPosition() {}, showAtMouseEvent() {} }; };
  more[0].fire('click', { metaKey: false, ctrlKey: false });
  assert.equal(opened.length, 1, '⋯ opens while the notes load');
  const card = h.view.cardEls.get(h.ids.a);
  h.view.onCanvasContextMenu({ target: { closest: sel => (sel === '.vam-node' ? card : null) }, clientX: 5, clientY: 5, preventDefault() {} });
  assert.equal(opened.length, 2, 'the right-click opens while the notes load');
  for (const [name, rows] of [['⋯', opened[0]], ['right-click', opened[1]]]) {
    assert.ok(rows.length > 3, `${name}: the card's whole list is drawn`);
    for (const row of rows) {
      assert.equal(row.disabled, true, `${name}: ${row.title} is greyed`);
      assert.deepEqual(row.hints, [tr('ui.card_action_off_notes_loading')], `${name}: ${row.title} says the notes are loading`);
      assert.equal(row.fn, undefined, `${name}: ${row.title} has no click`);
    }
  }
  assert.equal(tr('ui.card_action_off_notes_loading'), '筆記載入中');
  await pending;
  assert.equal(mutations, 0, 'nothing is written');
  // Presenting still opens neither.
  h.view.presentation = true;
  more[0].fire('click', { metaKey: false, ctrlKey: false });
  h.view.onCanvasContextMenu({ target: { closest: sel => (sel === '.vam-node' ? card : null) }, clientX: 5, clientY: 5, preventDefault() {} });
  assert.equal(opened.length, 2, 'no menu while presenting');
});
