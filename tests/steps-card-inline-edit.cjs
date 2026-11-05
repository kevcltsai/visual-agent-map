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
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true, closest() { return null; }, setCssProps(props) { Object.assign(this.style, props); }, classList: { add() {}, remove() {}, contains() { return false; } }, offsetLeft: 1e9, offsetTop: 1e9, offsetWidth: 1, offsetHeight: 1,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; make.last = this; },
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
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice, Setting, setTooltip() {} } }, { createFragment: dom.createFragment, requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
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
  for (const spot of [centre(TITLE), centre(SUMMARY)]) {
    press(h, 'leaf', spot, { moveTo: { x: spot.x + 80, y: spot.y + 80 } }); await tick(); await tick(); place(h, 'leaf');
    h.card('leaf').handlers.get('click')({ target: h.card('leaf'), clientX: spot.x, clientY: spot.y, metaKey: false, ctrlKey: false });
    assert.equal(nothingOpen(h, 'leaf'), true, 'no field after a drag');
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

test('the card right-click menu and the "More" tool menu no longer list Rename', async () => {
  const h = await harness(); const items = [];
  const menu = { addItem(cb) { const it = { setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, onClick() { return this; }, setDisabled() { return this; }, setSection() { return this; } }; cb(it); items.push(it.title); return menu; }, addSeparator() { return menu; } };
  h.view.addCardMenuActions(menu, h.view.map.nodes.find(n => n.id === h.ids.leaf));
  assert.ok(items.length > 3 && !items.includes('Rename'), `right-click items: ${items.join(', ')}`);
  let more = null; h.view.openCardMoreMenu = (_event, _node, entries) => { more = entries; };
  const tool = findAll(h.card('leaf'), i => i.classes.has('vam-more-tool'))[0]; tool.handlers.get('click')({ stopPropagation() {} });
  assert.ok(more && more.length > 0 && !more.some(m => m.title === 'Rename'), 'More has no Rename');
});
