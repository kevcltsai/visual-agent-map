// Click-to-edit on map cards: a click on the title or summary text turns it into a field in place; Enter or leaving saves,
// Esc cancels, a drag or a locked mode never opens one. Real view + repository; the DOM is the stand-in from tests/support-dom.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');
// Sets the selection through the selection module: mode on or off, then the ticked topics; the picked topic is kept.
const setSelection = (view, mode, ids = [...view.selection.state.multiSelected]) => {
  const s = view.selection, keep = s.state.selected;
  if (s.state.multiSelectMode !== mode) s.toggleMultiSelect();
  s.setSelected(keep);
  return s.replaceMulti(ids);
};
const { element, tick } = dom;
// A card-sized DOM stand-in (one handler per event name, like the view's own selection tests).
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: { ...(init.attr ?? {}) }, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true, closest() { return null; }, setCssProps(props) { Object.assign(this.style, props); }, classList: { add() {}, remove() {}, contains() { return false; } }, offsetLeft: 1e9, offsetTop: 1e9, offsetWidth: 1, offsetHeight: 1,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; make.last = this; make.onFocus?.(this); },
  select() { this.selectionStart = 0; this.selectionEnd = String(this.value ?? '').length; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector(selector) { if (!['.vam-card-title', '.vam-card-summary.is-inline-editable', '.vam-card-summary-add'].includes(selector)) return null; const wanted = selector.split('.').filter(Boolean); return findAll(this, i => i !== this && wanted.every(c => i.classes.has(c)))[0] ?? null; }, querySelectorAll() { return []; }, replaceWith() {}, after() {} });
const findAll = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(c => findAll(c, predicate))];

class Setting {
  constructor(el) { this.el = el; }
  setName() { return this; } setDesc() { return this; }
  addButton(callback) { const b = { setButtonText(text) { this.text = text; return this; }, onClick(fn) { this.run = fn; return this; }, setDestructive() { return this; }, setWarning() { return this; } }; callback(b); (this.el.choiceButtons ??= []).push(b); return this; }
}
const modalNames = h => h.modals.map(m => m.constructor.name);
const MAP = 'Agent Workspace/Topics/map-k/Map.md';

async function harness({ language = 'en' } = {}) {
  const { repo, app, contents } = fixture(language);
  const settings = { ...DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const mapDoc = { id: 'map-k', title: 'Keys', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-k');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', 'Root'); await add('leaf', 'Leaf', 'root'); await add('branch', 'Branch', 'root'); await add('kid', 'Kid', 'branch');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [], modals = [];
  const Base = dom.makeModal();
  class Modal extends Base { open() { modals.push(this); super.open(); } }
  const Notice = dom.makeNotice(notices);
  const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice, Setting, setTooltip() {} } }, { createFragment: dom.createFragment, requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  if (language !== 'en') {
    // This bundle has its own UI language; switch it the way a language change does.
    const lp = new Plugin(); lp.settings = { ...DEFAULT_SETTINGS, language: 'en' }; lp.saveData = async () => {}; lp.repo = { settings: lp.settings };
    lp.views = () => []; lp.coffeeViews = () => []; lp.refreshLocalizedEntrypoints = () => {}; lp.settingTab = { update() {}, refreshAfterLanguageChange() {} };
    await lp.changeLanguage(language);
  }
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const stage = make('div');
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  let renders = 0;
  view.hydrate = reload;
  // Like the real render's tail: the live field takes focus once the cards are drawn.
  view.render = () => { renders++; view.suspendInlineName?.(); view.suspendInlineSummary?.(); build(); view.focusInlineName(); view.focusInlineSummary(); };
  const build = () => { view.cardEls.clear(); stage.children = []; view.selection.resetTabStop(view.map.nodes.map(n => ({ id: n.id, parentId: n.parentId ?? null }))); for (const n of view.map.nodes) view.renderNode(n); };
  await reload(); build();
  const added = [];
  view.addNode = async (parent, title) => { added.push(parent ? parent.id : null); };
  const card = key => stage.children.find(c => c.dataset.nodeId === ids[key]);
  return { repo, app, contents, view, plugin, ids, notices, modals, stage, card, added, renders: () => renders, map: () => view.map, saved: () => repo.readMap(MAP), Notice, build };
}


const TITLE = { left: 20, right: 120, top: 30, bottom: 50 }, SUMMARY = { left: 20, right: 120, top: 60, bottom: 100 }, HINT = SUMMARY, ELSEWHERE = { x: 300, y: 300 };
const centre = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
const part = (h, key, cls) => findAll(h.card(key), i => i.classes.has(cls))[0];
const withSummary = async (h, key, summary) => { await h.repo.updateNote(h.view.map.nodes.find(n => n.id === h.ids[key]).path, { summary }); await h.view.hydrate(); h.build(); };
// Rects for the title and (when drawn) the summary or the add-summary line of one card.
const place = (h, key) => {
  const title = part(h, key, 'vam-card-title'); title.getBoundingClientRect = () => TITLE;
  for (const cls of ['vam-card-summary', 'vam-card-summary-add']) { const el = part(h, key, cls); if (el) el.getBoundingClientRect = () => SUMMARY; }
};
// A real press-and-release on the card (the pointer is captured by the card, so the target is the card itself).
const press = (h, key, at, { moveTo = null, mods = {} } = {}) => {
  const card = h.card(key);
  card.handlers.get('pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: at.x, clientY: at.y });
  const end = moveTo ?? at;
  if (moveTo) card.handlers.get('pointermove')({ type: 'pointermove', clientX: end.x, clientY: end.y });
  card.handlers.get('pointerup')({ type: 'pointerup', target: card, clientX: end.x, clientY: end.y, metaKey: false, ctrlKey: false, ...mods });
  return end;
};
const titleField = (h, key) => findAll(h.card(key), i => i.classes.has('vam-card-title-input'))[0];
const summaryField = (h, key) => findAll(h.card(key), i => i.classes.has('vam-card-summary-input'))[0];
const keys = (field, key, init = {}) => { const event = { key, isComposing: false, shiftKey: false, stopPropagation() {}, preventDefault() { this.prevented = true; }, ...init }; field.handlers.get('keydown')(event); return event; };
const noteOf = (h, key) => h.repo.readNote(h.view.map.nodes.find(n => n.id === h.ids[key]).path);
const spyWrites = h => { const calls = []; const real = h.repo.updateNote.bind(h.repo); h.repo.updateNote = (...args) => { calls.push(args); return real(...args); }; return calls; };
const nothingOpen = (h, key) => !titleField(h, key) && !summaryField(h, key) && !h.view.inlineName && !h.view.inlineSummary;

test('click on the title opens the title field in place with the caret at the end; Enter saves a changed title (one undo step) and reads back from the note', async () => {
  const h = await harness(); place(h, 'leaf');
  const past = h.view.history.past.length;
  press(h, 'leaf', centre(TITLE));
  const field = titleField(h, 'leaf');
  assert.ok(field, 'the title became a field'); assert.equal(field.value, 'Leaf'); assert.equal(make.last, field, 'DOM focus is on the field');
  assert.equal(h.view.inlineName.fresh, false, 'not select-all'); assert.equal(field.selectionStart, 4, 'caret at the end'); assert.equal(field.selectionEnd, 4);
  assert.deepEqual(modalNames(h), [], 'no rename dialog');
  field.value = 'Leaf renamed'; keys(field, 'Enter');
  await until(() => h.view.notes.get(h.ids.leaf).title === 'Leaf renamed'); await tick(); await tick();
  assert.equal((await noteOf(h, 'leaf')).title, 'Leaf renamed'); assert.equal(h.view.history.past.length, past + 1);
  assert.equal(nothingOpen(h, 'leaf'), true);
});

test('no key hint line under either field: the card holds only the field, and the hint strings are gone from every language', async () => {
  const h = await harness(); place(h, 'leaf');
  press(h, 'leaf', centre(TITLE));
  assert.ok(titleField(h, 'leaf'), 'title field open');
  assert.equal(part(h, 'leaf', 'vam-card-edit-hint'), undefined, 'no hint under the title field');
  keys(titleField(h, 'leaf'), 'Escape'); await tick(); await tick();
  await withSummary(h, 'leaf', 'Some summary'); place(h, 'leaf');
  press(h, 'leaf', centre(SUMMARY));
  assert.ok(summaryField(h, 'leaf'), 'summary field open');
  assert.equal(part(h, 'leaf', 'vam-card-edit-hint'), undefined, 'no hint under the summary field');
  const { translate } = load('i18n.ts');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const key of ['ui.card_edit_title_keys', 'ui.card_edit_summary_keys']) assert.equal(translate(lang, key), key, `${lang} ${key} no longer defined`);
});

test('click on the summary opens a textarea with the whole summary; Enter saves it to the note; Shift+Enter is a new line and saves nothing', async () => {
  const h = await harness(); const long = '第一行很長的摘要。'.repeat(12);
  await withSummary(h, 'leaf', long); place(h, 'leaf');
  press(h, 'leaf', centre(SUMMARY));
  const area = summaryField(h, 'leaf');
  assert.ok(area, 'the summary became a textarea'); assert.equal(area.value, long, 'the full text, not the 3-line clamp'); assert.equal(make.last, area);
  const writes = spyWrites(h);
  area.value = `${long}x`; const shiftEnter = keys(area, 'Enter', { shiftKey: true });
  assert.equal(shiftEnter.prevented, undefined, 'Shift+Enter is left to the field (a newline)'); await tick(); await tick();
  assert.equal(writes.length, 0, 'Shift+Enter writes nothing'); assert.ok(summaryField(h, 'leaf'), 'still editing');
  const past = h.view.history.past.length; keys(area, 'Enter');
  await until(() => h.view.notes.get(h.ids.leaf).summary === `${long}x`); await tick(); await tick();
  assert.equal((await noteOf(h, 'leaf')).summary, `${long}x`); assert.equal(h.view.history.past.length, past + 1);
  assert.equal(nothingOpen(h, 'leaf'), true);
});

test('leaving the field (blur) saves like Enter', async () => {
  const h = await harness(); place(h, 'leaf');
  press(h, 'leaf', centre(TITLE)); const field = titleField(h, 'leaf'); field.value = 'By blur'; field.handlers.get('blur')();
  await until(() => h.view.notes.get(h.ids.leaf).title === 'By blur');
  await withSummary(h, 'leaf', 'old'); place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY));
  const area = summaryField(h, 'leaf'); area.value = 'new by blur'; area.handlers.get('blur')();
  await until(() => h.view.notes.get(h.ids.leaf).summary === 'new by blur');
});

test('negative: a drag (pointer moved) that ends on the title or summary never opens a field, even when the click event follows', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'some summary'); place(h, 'leaf');
  // The click follows the release at once (no await between), so the 250ms click-suppress window cannot lapse in between; the window is asserted open.
  for (const spot of [centre(TITLE), centre(SUMMARY)]) {
    place(h, 'leaf');
    press(h, 'leaf', spot, { moveTo: { x: spot.x + 80, y: spot.y + 80 } });
    assert.ok(h.view.suppressClickUntil > Date.now(), 'the click-suppress window is open when the click arrives');
    h.card('leaf').handlers.get('click')({ target: h.card('leaf'), clientX: spot.x, clientY: spot.y, metaKey: false, ctrlKey: false });
    assert.equal(nothingOpen(h, 'leaf'), true, 'no field after a drag');
    await tick(); await tick();
  }
});

test('negative: a press elsewhere on the card, with Cmd/Ctrl held, or on a button opens no field (it still selects)', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'some summary'); place(h, 'leaf');
  press(h, 'leaf', ELSEWHERE); assert.equal(nothingOpen(h, 'leaf'), true); assert.equal(h.view.selection.state.selected, h.ids.leaf, 'a click elsewhere still selects');
  press(h, 'leaf', centre(TITLE), { mods: { metaKey: true } }); assert.equal(nothingOpen(h, 'leaf'), true);
  const tool = element('button'); tool.closest = sel => (sel.includes('button') ? tool : null);
  h.card('leaf').handlers.get('click')({ target: tool, clientX: centre(TITLE).x, clientY: centre(TITLE).y, metaKey: false, ctrlKey: false });
  assert.equal(nothingOpen(h, 'leaf'), true);
});

test('negative: presentation, selection mode and a live AIM map never open a field from a click, F2 or the command', async () => {
  for (const mode of ['presentation', 'select', 'aim']) {
    const h = await harness(); await withSummary(h, 'leaf', 'some summary');
    if (mode === 'aim') h.view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
    if (mode === 'select') setSelection(h.view, true);
    if (mode === 'presentation') { h.view.selection.setSelected(h.ids.root); h.view.startPresentation(); }
    h.build(); place(h, 'leaf');
    for (const spot of [centre(TITLE), centre(SUMMARY)]) { try { press(h, 'leaf', spot); } catch { /* the mode's own pointer handling may differ */ } h.card('leaf').handlers.get('click')?.({ target: h.card('leaf'), clientX: spot.x, clientY: spot.y, metaKey: false, ctrlKey: false }); }
    h.view.startCardTitleEdit(h.view.map.nodes.find(n => n.id === h.ids.leaf)); h.view.startCardSummaryEdit(h.view.map.nodes.find(n => n.id === h.ids.leaf));
    assert.equal(nothingOpen(h, 'leaf'), true, `${mode}: nothing opens`); assert.deepEqual(modalNames(h), [], mode);
  }
});

test('negative: Enter while an input method is composing saves nothing, in the title and in the summary', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'abc'); place(h, 'leaf'); const writes = spyWrites(h);
  press(h, 'leaf', centre(TITLE)); const field = titleField(h, 'leaf'); field.value = 'ㄕㄡˇ'; keys(field, 'Enter', { isComposing: true }); await tick(); await tick();
  assert.equal(writes.length, 0); assert.equal(titleField(h, 'leaf'), field, 'the same field stays');
  keys(field, 'Escape'); await tick(); place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY));
  const area = summaryField(h, 'leaf'); area.value = 'ㄕㄡˇ'; keys(area, 'Enter', { isComposing: true }); await tick(); await tick();
  assert.equal(writes.length, 0); assert.equal(summaryField(h, 'leaf'), area, 'the same textarea stays');
});

test('negative: Enter or blur with an unchanged (or blank) value writes nothing and adds no history entry', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'keep me'); place(h, 'leaf'); const writes = spyWrites(h); const past = h.view.history.past.length;
  press(h, 'leaf', centre(TITLE)); keys(titleField(h, 'leaf'), 'Enter'); await tick(); await tick();
  assert.equal(nothingOpen(h, 'leaf'), true); place(h, 'leaf');
  press(h, 'leaf', centre(TITLE)); const blank = titleField(h, 'leaf'); blank.value = '   '; blank.handlers.get('blur')(); await tick(); await tick();
  place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); summaryField(h, 'leaf').handlers.get('blur')(); await tick(); await tick();
  place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); keys(summaryField(h, 'leaf'), 'Enter'); await tick(); await tick();
  assert.equal(writes.length, 0, 'no updateNote call'); assert.equal(h.view.history.past.length, past, 'no undo step'); assert.equal(nothingOpen(h, 'leaf'), true);
});

test('negative: Esc drops what was typed; the note is unchanged', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'keep me'); place(h, 'leaf'); const before = h.contents.get((await noteOf(h, 'leaf')).path ?? ''); const writes = spyWrites(h);
  press(h, 'leaf', centre(TITLE)); const field = titleField(h, 'leaf'); field.value = 'typed'; keys(field, 'Escape'); await tick(); await tick();
  place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); const area = summaryField(h, 'leaf'); area.value = 'typed too'; keys(area, 'Escape'); await tick(); await tick();
  assert.equal(writes.length, 0); assert.equal((await noteOf(h, 'leaf')).title, 'Leaf'); assert.equal((await noteOf(h, 'leaf')).summary, 'keep me');
  assert.equal(nothingOpen(h, 'leaf'), true); void before;
});

test('a card with no summary offers "Click to add a summary" (shown while selected); a click opens the textarea empty and saving writes the summary', async () => {
  const h = await harness(); place(h, 'leaf');
  const hint = part(h, 'leaf', 'vam-card-summary-add');
  assert.ok(hint, 'the add-summary line exists'); assert.equal(hint.text, 'Click to add a summary…'); assert.equal(part(h, 'leaf', 'vam-card-summary'), undefined, 'no empty summary paragraph');
  const { translate } = load('i18n.ts'); assert.equal(translate('zh-TW', 'ui.card_summary_add_hint'), '點這裡加摘要…');
  press(h, 'leaf', centre(HINT)); assert.equal(summaryField(h, 'leaf'), undefined, 'the first press only selects: the line was invisible');
  assert.equal(h.view.selection.state.selected, h.ids.leaf); place(h, 'leaf'); press(h, 'leaf', centre(HINT));
  const area = summaryField(h, 'leaf'); assert.ok(area, 'the editor opened'); assert.equal(area.value, '');
  const writes = spyWrites(h); area.handlers.get('blur')(); await tick(); await tick(); assert.equal(writes.length, 0, 'leaving it empty writes nothing');
  place(h, 'leaf'); press(h, 'leaf', centre(HINT)); const again = summaryField(h, 'leaf'); again.value = '新的摘要'; keys(again, 'Enter');
  await until(() => h.view.notes.get(h.ids.leaf).summary === '新的摘要'); assert.equal((await noteOf(h, 'leaf')).summary, '新的摘要');
});

test('F2, the title double-click and the rename command all open the inline title field, never the rename dialog', async () => {
  const h = await harness(); place(h, 'leaf'); const f2 = h.view.scope.keys.find(k => k.key === 'F2' && k.modifiers.length === 0);
  h.view.contentEl.ownerDocument = { activeElement: h.card('leaf') };
  assert.equal(f2.func({ key: 'F2', isComposing: false, defaultPrevented: false }, {}), false); assert.ok(titleField(h, 'leaf'), 'F2'); assert.equal(h.view.inlineName.fresh, true, 'F2 selects the whole title');
  titleField(h, 'leaf').handlers.get('keydown')({ key: 'Escape', isComposing: false, stopPropagation() {}, preventDefault() {} });
  place(h, 'leaf'); h.card('leaf').handlers.get('dblclick')({ target: h.card('leaf'), clientX: centre(TITLE).x, clientY: centre(TITLE).y, preventDefault() {} });
  assert.ok(titleField(h, 'leaf'), 'double-click'); titleField(h, 'leaf').handlers.get('keydown')({ key: 'Escape', isComposing: false, stopPropagation() {}, preventDefault() {} });
  h.view.selection.setSelected(h.ids.leaf); assert.equal(h.view.mapCommand('rename', false), true); assert.ok(titleField(h, 'leaf'), 'command');
  assert.deepEqual(modalNames(h), [], 'no rename dialog at all');
});

test('the card right-click menu and the floating card tools no longer list Rename (the tools have no More menu)', async () => {
  const h = await harness(); const items = [];
  const menu = { addItem(cb) { const it = { setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, onClick() { return this; }, setDisabled() { return this; }, setSection() { return this; } }; cb(it); items.push(it.title); return menu; }, addSeparator() { return menu; } };
  h.view.addCardMenuActions(menu, h.view.map.nodes.find(n => n.id === h.ids.leaf));
  assert.ok(items.length > 3 && !items.includes('Rename'), `right-click items: ${items.join(', ')}`);
  const tools = findAll(h.card('leaf'), i => i.tag === 'button' && i.classes.has('vam-node-tool'));
  const labels = tools.map(i => i.attrs['aria-label']);
  assert.ok(labels.length > 0 && !labels.includes('Rename'), `floating tools have no Rename: ${labels.join(', ')}`);
  assert.equal(tools.some(i => i.classes.has('vam-more-tool') || i.attrs['aria-haspopup']), false, 'no More button or menu on the card');
});

// Accessible name of an edit field: aria-label, or the text of the element aria-labelledby points to.
const accessibleName = (h, key, field) => field.attrs['aria-label'] ?? findAll(h.card(key), i => i.id && i.id === field.attrs['aria-labelledby'])[0]?.text;

test('bug bash #27 (moved from map-chat): the existing card\'s title field is named 重新命名 (zh-TW) by ui.rename_topic, not the new-topic label; the summary field has its own name; neither uses aria-label (no hover tooltip over the hint)', async () => {
  const h = await harness({ language: 'zh-TW' }); const { translate } = load('i18n.ts'); place(h, 'leaf');
  h.view.startCardTitleEdit(h.view.map.nodes.find(n => n.id === h.ids.leaf), { select: true });
  const title = titleField(h, 'leaf'); assert.ok(title, 'the title field is open');
  assert.equal(accessibleName(h, 'leaf', title), '重新命名'); assert.equal(accessibleName(h, 'leaf', title), translate('zh-TW', 'ui.rename_topic'));
  assert.notEqual(accessibleName(h, 'leaf', title), translate('zh-TW', 'ui.new_topic'), 'not the new-topic label');
  assert.equal(title.attrs['aria-label'], undefined, 'no aria-label: Obsidian would show it as a tooltip over the key hint');
  keys(title, 'Escape');
  h.view.startCardSummaryEdit(h.view.map.nodes.find(n => n.id === h.ids.leaf));
  const area = summaryField(h, 'leaf'); assert.equal(accessibleName(h, 'leaf', area), translate('zh-TW', 'ui.card_edit_summary_label')); assert.equal(area.attrs['aria-label'], undefined);
});

// A stand-in for the geometry the tool row is placed by: a card jammed in a corner of the canvas, where no spot fits, so a real placement pans.
const jam = h => {
  const view = h.view, card = h.card('leaf');
  const tools = { style: { removeProperty() {}, setProperty() {} }, getBoundingClientRect: () => ({ width: 170, height: 34, left: 0, top: 0, right: 170, bottom: 34 }), toggleClass() {} };
  const search = card.querySelector.bind(card); card.matches = () => false;
  card.querySelector = selector => (selector === ':scope > .vam-node-tools' ? tools : search(selector));
  // The card sits where the viewport puts it: panning moves it, so a placement settles after a pan or two, as in the app. Each repaint also changes where the row fits.
  card.getBoundingClientRect = () => { const dy = view.map.viewport.y + 290 - 10 * h.renders(); return { left: 5, right: 990, top: 20 + dy, bottom: 790 + dy }; };
  for (const other of h.stage.children) if (other !== card) other.getBoundingClientRect = () => ({ left: 2000, right: 2010, top: 0, bottom: 10 });
  view.viewportEl = { getBoundingClientRect: () => ({ left: 0, right: 1000, top: 0, bottom: 800 }) };
  view.floatingControlRects = () => [];
  view.map.viewport = { x: -197, y: -290, zoom: 0.62 };
  view.transform = () => {};
  // The browser focuses the field inside the card -> the card's focusin handler measures the tool row (the pan the UI test saw).
  make.onFocus = el => { if (el.tag === 'input' || el.tag === 'textarea') card.handlers.get('focusin')({ target: el }); };
  return card;
};

test('F1 regression: opening and closing the title or summary field (Esc, Enter, blur) does not move the canvas', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'some summary'); place(h, 'leaf'); const card = jam(h);
  try {
    const at = () => JSON.stringify(h.view.map.viewport);
    const start = at();
    // The control: the user selecting this card pans the canvas (twice here) until the tool row fits; then it is stable.
    for (let i = 0; i < 4; i++) card.handlers.get('focusin')({ target: card });
    const before = at(); assert.notEqual(before, start, 'the jammed card pans when the user selects it'); card.handlers.get('focusin')({ target: card }); assert.equal(at(), before, 'and then it is settled');
    press(h, 'leaf', centre(TITLE)); assert.ok(titleField(h, 'leaf'), 'title field open'); assert.equal(at(), before, 'opening the title field');
    keys(titleField(h, 'leaf'), 'Escape'); assert.equal(at(), before, 'Esc on the title');
    place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); assert.ok(summaryField(h, 'leaf'), 'summary field open'); assert.equal(at(), before, 'opening the summary field');
    keys(summaryField(h, 'leaf'), 'Escape'); assert.equal(at(), before, 'Esc on the summary');
    place(h, 'leaf'); press(h, 'leaf', centre(TITLE)); const input = titleField(h, 'leaf'); input.value = 'Leaf 2'; keys(input, 'Enter'); await tick(); await tick();
    assert.equal(at(), before, 'Enter on the title (saved)');
    place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); const area = summaryField(h, 'leaf'); area.value = 'changed'; keys(area, 'Enter'); await tick(); await tick();
    assert.equal(at(), before, 'Enter on the summary (saved)');
    place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); summaryField(h, 'leaf').handlers.get('blur')(); await tick(); await tick(); assert.equal(at(), before, 'blur');
  } finally { make.onFocus = null; }
});

test('negative (F1 consumers): a plain focus restore that is not a field open/close (Alt+arrow reorder, delete moving focus, restoreMapFocus) still pans the canvas so the tool row fits', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'some summary'); place(h, 'leaf'); const card = jam(h);
  try {
    const at = () => JSON.stringify(h.view.map.viewport); const start = at();
    // What render's focusNodeId restore does: focus the card while restoringFocus is set (but no field is opening or closing).
    h.view.restoringFocus = true; try { card.handlers.get('focusin')({ target: card }); } finally { h.view.restoringFocus = false; }
    assert.notEqual(at(), start, 'the restored focus on a jammed card pans');
    // The field open/close repaint keeps the canvas still, and clears its flag afterwards.
    for (let i = 0; i < 4; i++) card.handlers.get('focusin')({ target: card }); const settled = at(); press(h, 'leaf', centre(TITLE)); keys(titleField(h, 'leaf'), 'Escape'); assert.equal(at(), settled, 'field open and close do not pan');
    assert.equal(h.view.keepCanvasOnFieldRestore, false, 'the flag is cleared');
  } finally { make.onFocus = null; }
});

test('a fixed-height card is not clipped while its summary is being typed: no height, no fade; saving or Esc brings the height back', async () => {
  const h = await harness(); await withSummary(h, 'leaf', 'some summary'); place(h, 'leaf');
  const node = h.view.map.nodes.find(n => n.id === h.ids.leaf); node.height = 120; h.build();
  assert.equal(h.card('leaf').style.height, '120px', 'the set height shows normally'); assert.ok(findAll(h.card('leaf'), i => i.classes.has('vam-card-fade')).length, 'with its fade');
  place(h, 'leaf'); press(h, 'leaf', centre(SUMMARY)); assert.ok(summaryField(h, 'leaf'), 'editing');
  assert.equal(h.card('leaf').style.height, undefined, 'the card grows with the field'); assert.equal(findAll(h.card('leaf'), i => i.classes.has('vam-card-fade')).length, 0, 'no fade over the text');
  keys(summaryField(h, 'leaf'), 'Escape'); assert.equal(h.card('leaf').style.height, '120px', 'height is back after Esc');
  place(h, 'leaf'); press(h, 'leaf', centre(TITLE)); assert.equal(h.card('leaf').style.height, '120px', 'a title edit leaves the height alone');
});

test('while a card is being edited its hover preview is not shown (it would float over the neighbours)', async () => {
  const h = await harness(); place(h, 'leaf'); let shown = 0;
  h.view.contentEl = { querySelector: () => { shown++; return null; } };
  const note = h.view.notes.get(h.ids.leaf);
  h.view.showHoverCard(h.card('leaf'), note); assert.equal(shown, 1, 'without an edit the preview looks for its canvas');
  h.view.startCardTitleEdit(h.view.map.nodes.find(n => n.id === h.ids.leaf)); h.view.showHoverCard(h.card('leaf'), note); assert.equal(shown, 1, 'title edit: no preview');
  keys(titleField(h, 'leaf'), 'Escape'); h.view.startCardSummaryEdit(h.view.map.nodes.find(n => n.id === h.ids.leaf)); h.view.showHoverCard(h.card('leaf'), note); assert.equal(shown, 1, 'summary edit: no preview');
});

test('Enter or Esc in the summary field hands focus back to the card; leaving by blur does not claim it', async () => {
  const h = await harness(); place(h, 'leaf');
  for (const [how, expected] of [['Escape', h.ids.leaf], ['Enter', h.ids.leaf], ['blur', null]]) {
    h.view.focusNodeId = null; place(h, 'leaf'); press(h, 'leaf', centre(HINT)); press(h, 'leaf', centre(HINT));
    const area = summaryField(h, 'leaf'); assert.ok(area, `editing before ${how}`); h.view.focusNodeId = null;
    let seen; const render = h.view.render; h.view.render = function () { seen = h.view.focusNodeId; return render.call(this); };
    if (how === 'blur') area.handlers.get('blur')(); else keys(area, how);
    await tick(); await tick(); h.view.render = render;
    assert.equal(seen ?? null, expected, `focus target at the repaint after ${how}`);
  }
});

test('the summary field reads like the summary text: same font size and line height (no jump when editing starts)', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../styles.css'), 'utf8');
  const rule = selector => css.split('\n').find(line => line.startsWith(selector)) ?? '';
  const field = rule('.vam-view .vam-node .vam-card-summary-input'), text = rule('.vam-card-summary {');
  for (const decl of ['font-size: var(--font-ui-small)', 'line-height: 1.55']) { assert.ok(text.includes(decl), `summary has ${decl}`); assert.ok(field.includes(decl), `field has ${decl}`); }
  assert.ok(!/font:\s*inherit/.test(field), 'not the editor font');
});
// UI audit bugfix-2 P2: a card title with [[ ]] or a fence is refused with its reason (never rewritten), and a map that is open in another pane is brought forward.
test('P2: a card title with [[ ]] or a fence is refused with a reason; the field stays open with the typed text and nothing is saved', async () => {
  const h = await harness(); place(h, 'leaf');
  press(h, 'leaf', centre(TITLE));
  const field = titleField(h, 'leaf');
  assert.ok(field, 'the title became a field');
  const before = (await noteOf(h, 'leaf')).title, past = h.view.history.past.length;
  const typed = 'Bad [[x]] ``` ';
  field.value = typed; keys(field, 'Enter');
  await tick(); await tick();
  assert.equal((await noteOf(h, 'leaf')).title, before, 'nothing saved to the note or its H1');
  assert.equal(h.view.history.past.length, past, 'no undo step');
  assert.equal(h.view.inlineName?.draft, typed, 'the field stays open with the typed text');
  assert.ok(titleField(h, 'leaf'), 'the field is still on the card');
  assert.match(h.notices.map(String).join('\n'), /\[\[|```|backtick|反引號/, 'a notice says why');
});

test('P2: switching to a map open in another pane brings that pane forward once the switcher has closed', async () => {
  const h = await harness();
  const leaf = { id: 'other-pane' }, shown = [];
  h.plugin.findMapLeaf = () => leaf;
  h.plugin.showLeaf = async item => { shown.push(item); };
  h.view.switchToMap('Agent Workspace/Topics/map-b/Map.md');
  assert.deepEqual(shown, [], 'not yet: the closing switcher would take the focus back');
  // The show is deferred with setTimeout(0), which is not ordered against setImmediate (tick): wait for it.
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(shown, [leaf]);
});
