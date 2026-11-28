// V3.3 A6: the selected card's edge entry "+ Topic card" (show/hide matrix, one card per click, blank new name cancels). Real view + repository; DOM stand-in from support-dom.cjs.
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
  querySelector(selector) { if (!['.vam-card-title', '.vam-card-summary.is-inline-editable', '.vam-card-summary-add'].includes(selector)) return null; const wanted = selector.split('.').filter(Boolean); return findAll(this, i => i !== this && wanted.every(c => i.classes.has(c)))[0] ?? null; }, querySelectorAll() { return []; }, replaceWith() {}, after(el) { (this.afterEls ??= []).push(el); }, prepend(el) { this.children.unshift(el); }, appendChild(el) { this.children.push(el); } });
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
  const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice, Setting, setTooltip() {} } }, { createFragment: dom.createFragment, createSpan: value => make('span', typeof value === 'string' ? { cls: value } : value), createEl: (tag, value) => make(tag, value), requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  if (language !== 'en') {
    // This bundle has its own UI language; switch it the way a language change does.
    const lp = new Plugin(); lp.settings = { ...DEFAULT_SETTINGS, language: 'en' }; lp.saveData = async () => {}; lp.repo = { settings: lp.settings };
    lp.views = () => []; lp.coffeeViews = () => []; lp.refreshLocalizedEntrypoints = () => {}; lp.settingTab = { update() {}, refreshAfterLanguageChange() {} };
    await lp.changeLanguage(language);
  }
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    recordFailure: (_l, e) => String(e?.message ?? e), invalidateLivingTrial() {}, restoreLivingOfficial: async () => {}, showLivingTrial: async () => {},
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

const edgeOf = (h, key) => findAll(h.card(key), i => i.classes.has('vam-card-edge'))[0];
const addBtn = (h, key) => findAll(h.card(key), i => i.tag === 'button' && i.classes.has('vam-card-edge-add'))[0];
const click = btn => btn.handlers.get('click')({ stopPropagation() {}, preventDefault() {} });
const titleField = (h, key) => findAll(h.card(key), i => i.classes.has('vam-card-title-input'))[0];
const keys = (field, key) => field.handlers.get('keydown')({ key, isComposing: false, stopPropagation() {}, preventDefault() {} });
const realAdd = h => { delete h.view.addNode; };
const notesCount = h => [...h.contents.keys()].filter(p => p.startsWith('Agent Workspace/Topics/map-k/Notes/') && p.endsWith('.md')).length;

test('edge entry shows on a single editable selected card, with label, aria-label and the A7-ready container', async () => {
  const h = await harness();
  const btn = addBtn(h, 'leaf');
  assert.ok(btn, 'button exists'); assert.equal(btn.text, '+ Topic card');
  assert.ok(btn.attrs['aria-label'] && btn.attrs['aria-label'] !== 'ui.card_edge_add_label', 'aria-label is translated');
  assert.ok(edgeOf(h, 'leaf').children.includes(btn), 'button lives in the edge container');
  const zh = await harness({ language: 'zh-TW' });
  assert.equal(addBtn(zh, 'leaf').text, '＋ 議題卡片');
  const cn = await harness({ language: 'zh-CN' });
  assert.equal(addBtn(cn, 'leaf').text, '＋ 议题卡片');
});

test('edge entry is hidden in multi-select, presentation, book structure lock, notes loading and unmanaged maps', async () => {
  let h = await harness(); setSelection(h.view, true, [h.ids.leaf]); h.build();
  assert.equal(addBtn(h, 'leaf'), undefined, 'multi-select');
  h = await harness(); h.view.bookLock = () => ({ ai: false, structure: true }); h.build();
  assert.equal(addBtn(h, 'leaf'), undefined, 'book structure lock');
  h = await harness(); h.view.noteLoad = {}; h.build();
  assert.equal(addBtn(h, 'leaf'), undefined, 'notes loading');
  h = await harness(); h.view.path = 'Elsewhere/Map.md'; h.build();
  assert.equal(addBtn(h, 'leaf'), undefined, 'unmanaged map');
  h = await harness(); h.view.selection.setSelected(h.ids.root); h.view.startPresentation(); h.build();
  assert.equal(addBtn(h, 'root'), undefined, 'presentation');
  h = await harness(); h.view.notes.delete(h.ids.leaf); h.build();
  assert.equal(addBtn(h, 'leaf'), undefined, 'note not loaded');
});

test('clicking the edge entry adds a subtopic under the card with the real addNode; the toolbar has no Add (B08)', async () => {
  const h = await harness(); realAdd(h);
  const before = h.view.map.nodes.length;
  click(addBtn(h, 'leaf'));
  await until(() => h.view.map.nodes.length === before + 1);
  const made = h.view.map.nodes.find(n => n.parentId === h.ids.leaf);
  assert.ok(made, 'child under the clicked card');
  const h2 = await harness();
  // B08 (P1.8): the toolbar Add is gone; the edge + (above) and Cmd-Enter add a subtopic.
  assert.equal(findAll(h2.card('leaf'), i => i.classes.has('vam-add-child-tool')).length, 0, 'no toolbar Add');
  assert.ok(findAll(h2.card('leaf'), i => i.classes.has('vam-card-tool-style')).length === 1, 'the toolbar is drawn (its Style is there)');
});

test('two quick clicks make one card and one note; a stale old button after the repaint does nothing', async () => {
  const h = await harness(); realAdd(h);
  let creates = 0; const real = h.repo.createNote.bind(h.repo); h.repo.createNote = (...a) => { creates++; return real(...a); };
  const before = h.view.map.nodes.length, files = notesCount(h);
  const old = addBtn(h, 'leaf');
  click(old); click(old);
  await until(() => h.view.map.nodes.length === before + 1); await tick(); await tick();
  assert.equal(h.view.map.nodes.length, before + 1); assert.equal(creates, 1); assert.equal(notesCount(h), files + 1);
  click(old); await tick(); await tick();
  assert.equal(h.view.map.nodes.length, before + 1, 'stale button while the new name field is open'); assert.equal(creates, 1);
  assert.equal(h.view.edgeAddPending, false, 'flag released after addNode');
});

test('blank new-card name: Enter and blur both cancel the card and its file, with no redo', async () => {
  for (const how of ['enter', 'blur']) {
    const h = await harness(); realAdd(h);
    const before = h.view.map.nodes.length, files = notesCount(h);
    click(addBtn(h, 'leaf'));
    await until(() => h.view.map.nodes.length === before + 1 && h.view.inlineName?.createdStep);
    const made = h.view.map.nodes.find(n => n.parentId === h.ids.leaf);
    const field = titleField(h, made.id === undefined ? 'leaf' : 'leaf') ?? findAll(h.stage, i => i.classes.has('vam-card-title-input'))[0];
    field.value = '   ';
    if (how === 'enter') keys(field, 'Enter'); else field.handlers.get('blur')();
    await until(() => h.view.map.nodes.length === before); await tick(); await tick();
    assert.equal(h.view.map.nodes.length, before, how); assert.equal(notesCount(h), files, `${how}: no file left`);
    assert.equal(h.view.history.canRedo, false, `${how}: no redo`);
  }
});

test('Esc on a new card still cancels it (existing behaviour)', async () => {
  const h = await harness(); realAdd(h);
  const before = h.view.map.nodes.length;
  click(addBtn(h, 'leaf'));
  await until(() => h.view.map.nodes.length === before + 1 && h.view.inlineName?.createdStep);
  const field = findAll(h.stage, i => i.classes.has('vam-card-title-input'))[0];
  keys(field, 'Escape');
  await until(() => h.view.map.nodes.length === before); await tick(); await tick();
  assert.equal(h.view.history.canRedo, false);
});

test('the edge container sits on the side the children grow toward (layout direction), right by default', async () => {
  const h = await harness();
  assert.ok(edgeOf(h, 'leaf').classes.has('is-edge-right'), 'default right');
  for (const side of ['left', 'down', 'up']) {
    h.view.directionOf = () => side; h.build();
    assert.ok(edgeOf(h, 'leaf').classes.has(`is-edge-${side}`), side);
  }
  h.view.directionOf = () => 'balanced'; h.build();
  assert.ok(edgeOf(h, 'leaf').classes.has('is-edge-right'), 'non-axis layouts fall back to right');
});

// ---- V3.3 A7: the edge "✦ AI card" and the empty canvas "✦ AI root" open the existing AI card setup (the card is made only on save) ----
const aiBtn = (h, key) => findAll(h.card(key), i => i.tag === 'button' && i.classes.has('vam-card-edge-ai'))[0];
const withPopover = h => {
  const overlay = element('div', { cls: 'vam-canvas-overlay' });
  overlay.ownerDocument = element('div');
  h.view.contentEl.appendChild(overlay);
  const pop = () => h.view.aiCardOpen?.win.el;
  const question = () => findAllDom(pop(), i => i.tag === 'textarea')[0];
  const saveButton = () => findAllDom(pop(), i => i.tag === 'button' && i.cls?.includes('mod-cta'))[0];
  return { pop, question, saveButton };
};
const findAllDom = (root, predicate) => [...(predicate(root) ? [root] : []), ...(root.children ?? []).flatMap(c => findAllDom(c, predicate))];
// Everything that could change on disk or in history when nothing should be written.
const snapshot = h => ({ map: h.contents.get(MAP), notes: notesCount(h), files: [...h.contents.keys()].sort().join('|'), past: h.view.history.past.length, nodes: h.view.map.nodes.length });

test('A7: the AI card entry sits beside "+ Topic card" in the same container, with translated labels', async () => {
  for (const [language, label] of [['en', '✦ AI card'], ['zh-TW', '✦ AI 卡片'], ['zh-CN', '✦ AI 卡片']]) {
    const h = await harness({ language });
    const btn = aiBtn(h, 'leaf');
    assert.ok(btn, language); assert.equal(btn.text, label);
    assert.ok(btn.attrs['aria-label'] && btn.attrs['aria-label'] !== 'ui.card_edge_ai_label', 'aria-label is translated');
    assert.deepEqual(edgeOf(h, 'leaf').children.map(c => [...c.classes].find(x => /^vam-card-edge-(add|ai)$/.test(x))), ['vam-card-edge-add', 'vam-card-edge-ai']);
  }
});

test('A7: the AI card entry is hidden in multi-select, presentation, bookLock.ai, bookLock.structure and while notes load', async () => {
  let h = await harness(); setSelection(h.view, true, [h.ids.leaf]); h.build();
  assert.equal(aiBtn(h, 'leaf'), undefined, 'multi-select');
  h = await harness(); h.view.selection.setSelected(h.ids.root); h.view.startPresentation(); h.build();
  assert.equal(aiBtn(h, 'root'), undefined, 'presentation');
  h = await harness(); h.view.bookLock = () => ({ ai: true, structure: false }); h.build();
  assert.equal(aiBtn(h, 'leaf'), undefined, 'bookLock.ai'); assert.ok(addBtn(h, 'leaf'), 'bookLock.ai keeps "+ Topic card"');
  h = await harness(); h.view.bookLock = () => ({ ai: false, structure: true }); h.build();
  assert.equal(aiBtn(h, 'leaf'), undefined, 'bookLock.structure');
  h = await harness(); h.view.noteLoad = {}; h.build();
  assert.equal(aiBtn(h, 'leaf'), undefined, 'notes loading');
});

test('A7: clicking the AI card entry opens the setup popover for a new card under that card; cancel writes nothing at all', async () => {
  const h = await harness(); const p = withPopover(h);
  const before = snapshot(h);
  const opened = []; const real = h.view.openAiCardPopover.bind(h.view);
  h.view.openAiCardPopover = (...a) => { opened.push(a); return real(...a); };
  click(aiBtn(h, 'branch'));
  assert.equal(opened.length, 1); assert.equal(opened[0][0], null, 'no existing card'); assert.equal(opened[0][1].id, h.ids.branch, 'parent is the clicked card');
  assert.ok(p.pop(), 'popover is open');
  assert.equal(snapshot(h).notes, before.notes, 'opening makes no note');
  p.pop().keydown({ key: 'Escape' });
  assert.equal(h.view.aiCardOpen, null, 'closed');
  await tick(); await tick();
  assert.deepEqual(snapshot(h), before, 'Map.md, notes, files, history and node count are unchanged');
  assert.equal(h.view.history.canRedo, false);
});

test('A7: an empty question cannot be saved (button disabled, nothing written); a filled one saves once and one undo removes card and note', async () => {
  const h = await harness(); const p = withPopover(h);
  const before = snapshot(h);
  click(aiBtn(h, 'leaf'));
  assert.equal(p.saveButton().disabled, true, 'save disabled while empty');
  assert.equal(await h.view.saveAiCard(null, h.view.map.nodes.find(n => n.id === h.ids.leaf), undefined, { title: '', question: '   ', sources: [], keepOld: true }, undefined, undefined, () => true), undefined, 'saveAiCard refuses a blank question');
  await tick();
  assert.deepEqual(snapshot(h), before, 'blank question wrote nothing');
  p.question().value = 'What is next?'; p.question().input();
  assert.equal(p.saveButton().disabled, false);
  p.pop().keydown({ key: 'Enter', ctrlKey: true });
  await until(() => h.view.map.nodes.length === before.nodes + 1); await until(() => h.view.history.past.length > before.past);
  assert.equal(h.view.history.past.length, before.past + 1, 'exactly one history step');
  const made = h.view.map.nodes.find(n => n.parentId === h.ids.leaf);
  assert.ok(made, 'child under the clicked card');
  assert.match(h.contents.get(made.path), /^ai-card: true$/m); assert.match(h.contents.get(made.path), /What is next\?/);
  assert.equal(notesCount(h), before.notes + 1);
  await h.view.history.undo().undo();
  await h.view.hydrate();
  assert.equal(h.contents.has(made.path), false, 'note file removed by one undo');
  assert.equal(h.contents.get(MAP), before.map, 'Map.md is back to its content');
  assert.equal(notesCount(h), before.notes);
});

test('A7: the empty canvas shows "+ Add first topic" and "✦ AI root" side by side; AI root opens the popover with no parent and cancel writes nothing', async () => {
  const h = await harness(); const p = withPopover(h);
  const before = snapshot(h);
  const nodes = h.view.map.nodes; h.view.map.nodes = [];
  const box = make('div'); h.view.fillEmptyMap(box);
  h.view.map.nodes = nodes;
  const btn = c => findAll(box, i => i.tag === 'button' && i.classes.has(c))[0];
  const add = btn('vam-empty-add'), root = btn('vam-empty-add-ai');
  assert.ok(add && root, 'both buttons'); assert.equal(root.text, '✦ AI root'); assert.ok(root.attrs['aria-label']);
  assert.ok(box.children.indexOf(add) < box.children.indexOf(root) && box.children.indexOf(root) < box.children.findIndex(c => c.tag === 'div'), 'order: add, AI root, hint');
  const opened = []; const real = h.view.openAiCardPopover.bind(h.view);
  h.view.openAiCardPopover = (...a) => { opened.push(a); return real(...a); };
  root.handlers.get('click')({ stopPropagation() {} });
  assert.deepEqual(opened, [[null, null]]); assert.ok(p.pop());
  p.pop().keydown({ key: 'Escape' }); await tick(); await tick();
  assert.equal(h.view.aiCardOpen, null);
  assert.deepEqual(snapshot(h), before, 'cancel wrote nothing');
  const zh = await harness({ language: 'zh-TW' }); zh.view.map.nodes = [];
  const zbox = make('div'); zh.view.fillEmptyMap(zbox);
  assert.equal(findAll(zbox, i => i.classes.has('vam-empty-add-ai'))[0].text, '✦ AI 根');
});

test('A7: the empty canvas hides "✦ AI root" in presentation and under bookLock.ai, but keeps the first-topic button', async () => {
  for (const setup of [h => { h.view.bookLock = () => ({ ai: true, structure: false }); }, h => { h.view.presentation = {}; }]) {
    const h = await harness(); setup(h); h.view.map.nodes = [];
    const box = make('div'); h.view.fillEmptyMap(box);
    assert.equal(findAll(box, i => i.classes.has('vam-empty-add-ai')).length, 0);
    assert.equal(findAll(box, i => i.classes.has('vam-empty-add')).length, 1);
  }
});

// ---- B28-x: a name field that is hidden (zoom overview used to hide it) or never gets focus must not block later adds ----
test('B28-x: a new name field that never gets focus is closed after the grace period, so ten clicks in a row add ten cards', async () => {
  const h = await harness(); realAdd(h);
  const other = { tag: 'body' };
  const real = h.view.createInlineNameInput.bind(h.view);
  // The field is "hidden" like under is-zoom-overview before the fix: not visible, focus stays elsewhere.
  h.view.createInlineNameInput = (...a) => { const input = real(...a); input.ownerDocument = { activeElement: other }; input.checkVisibility = () => false; return input; };
  const before = h.view.map.nodes.length;
  for (let i = 1; i <= 10; i++) {
    click(addBtn(h, 'leaf'));
    await until(() => h.view.map.nodes.length === before + i);
    assert.ok(h.view.inlineName?.created, `card ${i}: naming is open right after the add`);
    click(addBtn(h, 'leaf')); await tick();
    assert.equal(h.view.map.nodes.length, before + i, `card ${i}: a click while the first is still being named adds nothing`);
    for (let w = 0; w < 40 && h.view.inlineName; w++) await new Promise(r => setTimeout(r, 25));
    assert.equal(h.view.inlineName, null, `card ${i}: the stuck name field was closed`);
  }
  assert.equal(h.view.map.nodes.length, before + 10);
  assert.equal(h.view.inlineNameGuardTimer, null, 'no timer left');
});

test('B28-x: a focused, visible name field is left alone; closing the view clears the guard timer', async () => {
  const h = await harness(); realAdd(h);
  const real = h.view.createInlineNameInput.bind(h.view);
  let field;
  h.view.createInlineNameInput = (...a) => { field = real(...a); field.ownerDocument = { get activeElement() { return field; } }; field.checkVisibility = () => true; return field; };
  click(addBtn(h, 'leaf'));
  await until(() => h.view.inlineName?.created && h.view.inlineNameGuardTimer !== null);
  await new Promise(r => setTimeout(r, 450));
  assert.ok(h.view.inlineName?.created, 'still naming after the grace period');
  h.view.render();
  assert.notEqual(h.view.inlineNameGuardTimer, null, 'a repaint re-arms the guard');
  h.view.onClose?.();
  await Promise.resolve();
  await new Promise(r => setTimeout(r, 450));
  assert.ok(h.view.inlineName?.created, 'closed view: the guard did not fire');
});
