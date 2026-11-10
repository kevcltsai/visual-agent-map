// 0.25 A4: keyboard flow on map cards. Delete/Backspace remove (leaf with Undo, branch with the confirmation),
// Mod+Enter adds a subtopic, Shift+Enter a sibling, double-clicking a title renames, and Mod+Z / Mod+Shift+Z run from
// the view's scope. Real view + repository; the DOM is the stand-in from tests/support-dom.cjs.
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
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; make.last = this; },
  select() { this.selectionStart = 0; this.selectionEnd = String(this.value ?? '').length; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });
const findAll = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(c => findAll(c, predicate))];

class Setting {
  constructor(el) { this.el = el; }
  setName() { return this; } setDesc() { return this; }
  addButton(callback) { const b = { setButtonText(text) { this.text = text; return this; }, onClick(fn) { this.run = fn; return this; }, setDestructive() { return this; }, setWarning() { return this; } }; callback(b); (this.el.choiceButtons ??= []).push(b); return this; }
}
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
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice, Setting, setTooltip() {} } }, { createFragment: dom.createFragment });
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
  view.render = () => { renders++; build(); };
  const build = () => { view.cardEls.clear(); stage.children = []; view.selection.resetTabStop(view.map.nodes.map(n => ({ id: n.id, parentId: n.parentId ?? null }))); for (const n of view.map.nodes) view.renderNode(n); };
  await reload(); build();
  const added = [];
  view.addNode = async (parent, title) => { added.push(parent ? parent.id : null); };
  const card = key => stage.children.find(c => c.dataset.nodeId === ids[key]);
  return { repo, app, contents, view, plugin, ids, notices, modals, stage, card, added, renders: () => renders, map: () => view.map, saved: () => repo.readMap(MAP), Notice, build };
}

// The stub DOM in tests/support-dom.cjs keeps listeners in arrays on `.listeners`; send an event to the card.
const send = (h, cardKey, key, init = {}) => {
  const target = h.card(cardKey);
  const event = { key, target, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  target.handlers.get('keydown')?.(event);
  return event;
};
const unassignedHas = (h, title) => [...h.contents.entries()].some(([p, text]) => p.includes('/Unassigned/') && text.includes(title));
const modalNames = h => h.modals.map(m => m.constructor.name);

test('A4: Delete on a leaf moves it to Unassigned with one history entry and an Undo notice; Undo restores it', async () => {
  const h = await harness();
  const before = h.view.history.past.length;
  const event = send(h, 'leaf', 'Delete');
  assert.equal(event.defaultPrevented, true);
  await until(() => !h.map().nodes.some(n => n.id === h.ids.leaf));
  await tick(); await tick();
  assert.equal(h.view.history.past.length, before + 1, 'exactly one history entry');
  assert.equal(h.map().nodes.some(n => n.id === h.ids.leaf), false, 'the card left the map');
  assert.ok([...h.contents.keys()].some(p => p.includes('/Unassigned/')), 'its note is in Unassigned');
  const notice = h.Notice.all.at(-1);
  assert.match(String(notice.message), /Leaf/); assert.deepEqual(notice.actions.map(b => b.text), ['Undo']);
  assert.equal(modalNames(h).length, 0, 'no confirmation for a leaf');
  notice.actions[0].click();
  await until(() => h.map().nodes.some(n => n.id === h.ids.leaf));
  await tick(); await tick();
  assert.equal(h.view.history.canRedo, true);
  assert.equal(h.map().nodes.some(n => n.id === h.ids.leaf), true, 'Undo brings the card back');
  assert.equal([...h.contents.keys()].some(p => p.includes('/Unassigned/')), false, 'Unassigned is empty again');
});

test('A4: a held or doubled Delete removes the card once: one history entry, one Undo notice', async () => {
  const h = await harness();
  // One write at a time, like the plugin's own queue: the second press runs after the first removal has landed.
  let queue = Promise.resolve();
  h.plugin.mutate = work => (queue = queue.then(async () => { await work(); await h.view.hydrate(); }));
  const before = h.view.history.past.length, notices = h.Notice.all.length;
  send(h, 'leaf', 'Delete');
  // The card stays on screen until the save and repaint, so a key repeat and a second press both reach it.
  assert.equal(send(h, 'leaf', 'Delete', { repeat: true }).defaultPrevented, true, 'the repeat is still swallowed');
  send(h, 'leaf', 'Delete');
  await until(() => !h.map().nodes.some(n => n.id === h.ids.leaf));
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(h.view.history.past.length, before + 1, 'exactly one history entry');
  assert.equal(h.Notice.all.length, notices + 1, 'exactly one Undo notice');
});

test('A4: removals in a row share one notice with the count and "Undo all", which brings every card back', async () => {
  const h = await harness();
  const before = h.view.history.past.length;
  send(h, 'leaf', 'Delete');
  await until(() => !h.map().nodes.some(n => n.id === h.ids.leaf)); await tick(); await tick();
  const first = h.Notice.all.at(-1);
  send(h, 'kid', 'Delete');
  await until(() => !h.map().nodes.some(n => n.id === h.ids.kid)); await tick(); await tick();
  const merged = h.Notice.all.at(-1);
  assert.equal(first.hidden, true, 'the first notice gives way');
  assert.equal(merged.hidden, false);
  assert.equal(String(merged.message), 'Removed 2 cards (Leaf, Kid). Undo to bring them back.');
  assert.deepEqual(merged.actions.map(b => b.text), ['Undo all']);
  assert.equal(h.view.history.past.length, before + 2, 'Mod+Z still has one step per card');
  merged.actions[0].click();
  await until(() => h.map().nodes.some(n => n.id === h.ids.leaf) && h.map().nodes.some(n => n.id === h.ids.kid));
  await tick(); await tick();
  assert.equal(h.view.history.past.length, before, 'both steps undone');
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.removed_0_cards_1_undo_available', '2', 'Leaf、Kid'), '已移除 2 張卡片（Leaf、Kid），可復原');
  assert.equal(translate('zh-TW', 'ui.undo_all'), '全部復原');
});

test('A4: a removal after another change starts a new notice instead of joining the last one', async () => {
  const h = await harness();
  send(h, 'leaf', 'Delete');
  await until(() => !h.map().nodes.some(n => n.id === h.ids.leaf)); await tick(); await tick();
  const first = h.Notice.all.at(-1);
  await h.plugin.mutate(() => h.view.mapChange(map => { map.title = 'Renamed'; }));
  send(h, 'kid', 'Delete');
  await until(() => !h.map().nodes.some(n => n.id === h.ids.kid)); await tick(); await tick();
  const second = h.Notice.all.at(-1);
  assert.equal(String(second.message), 'Removed "Kid". Undo to bring it back.');
  assert.deepEqual(second.actions.map(b => b.text), ['Undo']);
  assert.equal(first.hidden, true, 'only one removal notice shows at a time');
});

test('A4: Backspace removes the same way; the notice is translated', async () => {
  const h = await harness();
  const event = send(h, 'leaf', 'Backspace');
  assert.equal(event.defaultPrevented, true);
  await until(() => !h.map().nodes.some(n => n.id === h.ids.leaf)); await tick(); await tick();
  assert.equal(String(h.Notice.all.at(-1).message), 'Removed "Leaf". Undo to bring it back.');
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.removed_0_undo_available', 'Leaf'), '已移除「Leaf」，可復原');
});

test('A4: Delete on a card with subtopics opens the existing confirmation and removes nothing yet', async () => {
  const h = await harness();
  send(h, 'branch', 'Delete');
  assert.deepEqual(modalNames(h), ['ChoiceModal']);
  assert.equal(h.map().nodes.length, 4); await tick();
  assert.equal(h.map().nodes.some(n => n.id === h.ids.branch), true);
});

test('A4: a merging card is refused with the merge Notice and nothing is removed', async () => {
  const h = await harness();
  h.view.mergeTasks.set(MAP, { mapPath: MAP, sources: [{ id: h.ids.leaf }], controller: new AbortController() });
  send(h, 'leaf', 'Delete'); await tick(); await tick();
  assert.equal(h.map().nodes.some(n => n.id === h.ids.leaf), true);
  assert.equal(String(h.Notice.all.at(-1).message), 'Merging; try again when it finishes');
  assert.equal(h.view.history.past.length, 0);
});

test('A4: keys typed in a field or during IME composition never reach a card action', async () => {
  const h = await harness();
  const input = element('input');
  // Backspace in an input inside the card: the card handler ignores events whose target is not the card.
  for (const key of ['Backspace', 'Delete']) { const event = send(h, 'leaf', key, { target: input }); assert.equal(event.defaultPrevented, false); }
  send(h, 'leaf', 'Enter', { target: input, ctrlKey: true }); send(h, 'leaf', 'Enter', { target: input, shiftKey: true });
  // IME composition on the card itself.
  for (const [key, init] of [['Delete', {}], ['Backspace', {}], ['Enter', { ctrlKey: true }], ['Enter', { shiftKey: true }]]) {
    const event = send(h, 'leaf', key, { ...init, isComposing: true });
    assert.equal(event.defaultPrevented, false, `${key} during composition is left alone`);
  }
  await tick();
  assert.equal(h.map().nodes.length, 4); assert.deepEqual(h.added, []); assert.deepEqual(modalNames(h), []);
});

test('A4: Mod+Enter adds a subtopic of the focused card; Shift+Enter adds a sibling (a new root for a root card); Tab and plain Enter are unchanged', async () => {
  const h = await harness();
  let details = 0; h.view.openDetails = () => { details++; };
  assert.equal(send(h, 'leaf', 'Enter', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(send(h, 'leaf', 'Enter', { metaKey: true }).defaultPrevented, true);
  assert.deepEqual(h.added, [h.ids.leaf, h.ids.leaf], 'Ctrl or Cmd+Enter: child of the card');
  h.added.length = 0;
  send(h, 'kid', 'Enter', { shiftKey: true });
  send(h, 'root', 'Enter', { shiftKey: true });
  assert.deepEqual(h.added, [h.ids.branch, null], 'Shift+Enter: parent of the card, or null (a new root) for a root');
  h.added.length = 0;
  const tab = send(h, 'leaf', 'Tab');
  assert.equal(tab.defaultPrevented, false, 'Tab keeps moving focus into the card tools'); assert.deepEqual(h.added, []);
  send(h, 'leaf', 'Enter');
  assert.equal(details, 1, 'plain Enter still opens details'); assert.deepEqual(h.added, []);
});

test('A4: double-clicking a card title opens the inline title field even though the pointer is captured by the card', async () => {
  const h = await harness();
  const card = h.card('leaf'), title = findAll(card, i => i.tag === 'h3')[0];
  title.getBoundingClientRect = () => ({ left: 20, right: 120, top: 30, bottom: 50 });
  const dbl = (x, y, target = card) => { const event = { target, clientX: x, clientY: y, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; card.handlers.get('dblclick')(event); return event; };
  assert.ok(card.handlers.get('dblclick'), 'the card listens for dblclick');
  assert.equal(dbl(300, 300).defaultPrevented, false, 'outside the title: nothing');
  assert.equal(dbl(60, 70).defaultPrevented, false, 'just below the title: nothing');
  const tool = element('button'); tool.closest = sel => (sel === 'button' ? tool : null);
  dbl(60, 40, tool);
  assert.equal(h.view.inlineName, null, 'a tool button never edits');
  assert.equal(dbl(60, 40).defaultPrevented, true, 'inside the title rect, target is the card');
  assert.deepEqual(modalNames(h), [], 'no rename dialog');
  assert.equal(h.view.inlineName?.id, h.ids.leaf); assert.equal(h.view.inlineName.draft, 'Leaf');
});

test('A4: F2 on the view scope edits the focused card title in place and passes through when no card has focus', async () => {
  const h = await harness();
  const f2 = h.view.scope.keys.filter(k => k.key === 'F2' && k.modifiers.length === 0);
  assert.equal(f2.length, 1, 'F2 is registered on the view scope');
  const doc = { activeElement: null }; h.view.contentEl.ownerDocument = doc;
  const fire = () => f2[0].func({ key: 'F2', isComposing: false, defaultPrevented: false }, {});
  assert.equal(fire(), true, 'no focused card: left to Obsidian'); doc.activeElement = element('div');
  assert.equal(fire(), true, 'focus elsewhere: left to Obsidian'); assert.equal(h.view.inlineName, null);
  doc.activeElement = h.card('leaf');
  assert.equal(fire(), false, 'a focused card: handled'); assert.equal(h.view.inlineName?.id, h.ids.leaf); assert.deepEqual(modalNames(h), []); h.view.inlineName = null;
  setSelection(h.view, true); assert.equal(fire(), true, 'selection mode: passes through'); assert.equal(h.view.inlineName, null);
  setSelection(h.view, false); h.view.closed = true; assert.equal(fire(), true, 'closed view: passes through');
  h.view.closed = false;
  const card = h.card('leaf'); card.handlers.get('keydown')({ key: 'F2', target: card, defaultPrevented: true, preventDefault() {} });
  assert.equal(h.view.inlineName, null, 'the card handler does not start a second edit when the scope already handled F2');
});

test('A4: selection mode ignores the new keys and the title double-click', async () => {
  for (const mode of ['select']) {
    const h = await harness();
    if (mode === 'select') setSelection(h.view, true);
    h.build();
    for (const [key, init] of [['Delete', {}], ['Backspace', {}], ['Enter', { ctrlKey: true }], ['Enter', { shiftKey: true }]]) {
      const event = send(h, 'leaf', key, init);
      if (key === 'Enter') continue; // plain Enter behaviour varies by mode and is covered elsewhere; only the new keys matter
      assert.equal(event.defaultPrevented, false, `${mode}: ${key} is not handled`);
    }
    assert.equal(h.card('leaf').handlers.has('dblclick'), false, `${mode}: no card dblclick`);
    assert.deepEqual(h.added, [], `${mode}: nothing added`); assert.equal(h.map().nodes.length, 4); assert.deepEqual(modalNames(h), []);
  }
});

test('A4: Mod+Z / Mod+Shift+Z live on the view scope, run travel once from any focus, and pass through in a text field', async () => {
  const h = await harness();
  const scope = h.view.scope;
  assert.ok(scope && scope.keys.length, 'the view has its own scope');
  assert.equal(scope.parent, h.app.scope, 'chained to the app scope');
  const travels = [];
  h.view.travel = async redo => { travels.push(redo); };
  const fire = (modifiers, key, init = {}) => {
    const handlers = scope.keys.filter(k => k.key === key && k.modifiers.length === modifiers.length && modifiers.every(m => k.modifiers.includes(m)));
    const event = { key, target: element('div'), isComposing: false, ...init };
    return handlers.map(k => k.func(event, {}));
  };
  assert.deepEqual(fire(['Mod'], 'z'), [false]); await tick();
  assert.deepEqual(travels, [false], 'undo from the map with focus on the body');
  fire(['Mod', 'Shift'], 'z'); await tick();
  assert.deepEqual(travels, [false, true], 'redo');
  // The same key event reaching both registered shift variants undoes one step only.
  travels.length = 0;
  const shared = { key: 'Z', target: element('div'), isComposing: false };
  for (const k of scope.keys.filter(k => k.modifiers.includes('Shift'))) k.func(shared, {});
  await tick();
  assert.deepEqual(travels, [true], 'no double undo');
  // A text control keeps its own undo: not handled, no travel.
  travels.length = 0;
  for (const tag of ['input', 'textarea', 'select']) {
    const field = element(tag); field.closest = selector => (selector.includes(tag) ? field : null);
    assert.equal(fire(['Mod'], 'z', { target: field })[0], true, `${tag}: passed through`);
  }
  const typing = element('div'); typing.closest = selector => (selector.includes('contenteditable') ? typing : null);
  assert.equal(fire(['Mod'], 'z', { target: typing })[0], true, 'contenteditable: passed through');
  assert.equal(fire(['Mod'], 'z', { isComposing: true })[0], true, 'IME composition: passed through');
  await tick();
  assert.deepEqual(travels, []);
});

test('A4: the old contentEl Mod+Z branch is gone (no double undo with the scope)', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal(/key\.toLowerCase\(\) === "z"/.test(source), false);
  assert.equal(source.slice(source.indexOf('async onOpen()'), source.indexOf('private installUndoScope')).includes('installUndoScope'), false, 'onOpen does not replace the scope');
  assert.match(source.slice(source.indexOf('constructor(\n    leaf: WorkspaceLeaf'), source.indexOf('async onOpen()')), /this\.installUndoScope\(\)/, 'the constructor installs the scope once');
  assert.equal((source.match(/this\.travel\(redo\)/g) ?? []).length, 1, 'one undo/redo entry point from the keyboard');
});

test('0.25 retest: Mod+Enter and Shift+Enter live on the view scope (Obsidian eats Mod+Enter before the card), act only on a focused card, and the card handler does not add twice', async () => {
  const h = await harness();
  const scope = h.view.scope;
  const find = (modifiers, key) => scope.keys.filter(k => k.key === key && k.modifiers.length === modifiers.length && modifiers.every(m => k.modifiers.includes(m)));
  assert.equal(find(['Mod'], 'Enter').length, 1, 'Mod+Enter is registered on the view scope');
  assert.equal(find(['Shift'], 'Enter').length, 1, 'Shift+Enter is registered on the view scope');
  const doc = { activeElement: null }; h.view.contentEl.ownerDocument = doc;
  const fire = (modifiers, init = {}) => find(modifiers, 'Enter')[0].func({ key: 'Enter', isComposing: false, defaultPrevented: false, ...init }, {});
  // Pass-through branches: Obsidian's own command still runs.
  assert.equal(fire(['Mod']), true, 'no focused card'); doc.activeElement = element('div');
  assert.equal(fire(['Mod']), true, 'focus elsewhere'); await tick();
  assert.deepEqual(h.added, []);
  doc.activeElement = h.card('leaf');
  assert.equal(fire(['Mod'], { isComposing: true }), true, 'IME composition'); assert.equal(fire(['Mod'], { defaultPrevented: true }), true, 'already handled');
  for (const mode of ['integrationMode']) { h.view.selection.toggleMultiSelect(); assert.equal(fire(['Mod']), true, mode); h.view.selection.exitMultiSelect('emptyMap'); }
  h.view.closed = true; assert.equal(fire(['Mod']), true, 'closed view'); h.view.closed = false;
  await tick(); assert.deepEqual(h.added, [], 'no pass-through branch added anything');
  // Handled branches.
  assert.equal(fire(['Mod']), false, 'a focused card: handled'); await tick();
  assert.deepEqual(h.added, [h.ids.leaf], 'Mod+Enter: child of the focused card');
  assert.equal(fire(['Shift']), false); await tick();
  assert.deepEqual(h.added, [h.ids.leaf, h.ids.root], 'Shift+Enter: sibling (the parent as the new parent)');
  doc.activeElement = h.card('root'); assert.equal(fire(['Shift']), false); await tick();
  assert.deepEqual(h.added.at(-1), null, 'Shift+Enter on a root: a new root');
  // The card handler sees the same key after the scope already handled it: no second topic.
  h.added.length = 0;
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const target = h.card('leaf');
    const event = { key: 'Enter', target, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init, defaultPrevented: true, preventDefault() {} };
    target.handlers.get('keydown')(event);
  }
  await tick(); assert.deepEqual(h.added, [], 'defaultPrevented key: the card handler adds nothing');
});

// Ticket 36: the real addNode (NameModal and all). Only the camera (focusNode) stays a stub, counted per call.
const realAdd = h => { delete h.view.addNode; h.cameraMoves = []; h.view.focusNode = (node, persist) => { h.cameraMoves.push([node.id, persist]); }; };
const nameModal = h => h.modals.filter(m => m.constructor.name === 'NameModal').at(-1);
const typeAndSave = (modal, text) => { const input = findAll(modal.contentEl, i => i.tag === 'input')[0]; input.value = text; input.keydown({ key: 'Enter', isComposing: false }); };
const cardOf = (h, id) => h.stage.children.find(c => c.dataset.nodeId === id);
const noteCount = h => [...h.contents.keys()].filter(p => p.endsWith('.md') && !p.endsWith('Map.md')).length;

// Ticket 21: a new card needs no name first. It appears at once as "New topic" (1, 2, ...) with its title open for typing.
const nameField = (h, id) => findAll(cardOf(h, id), i => i.classes.has('vam-card-title-input'))[0];
const press = (field, key, init = {}) => field.handlers.get('keydown')({ key, isComposing: false, stopPropagation() {}, preventDefault() {}, ...init });
const freshCard = h => h.map().nodes.find(n => !Object.values(h.ids).includes(n.id));
const modCtrlEnter = h => h.view.scope.keys.find(k => k.key === 'Enter' && k.modifiers.includes('Mod')).func({ key: 'Enter', isComposing: false, defaultPrevented: false }, {});

test('21: Mod+Enter makes a card named "New topic" at once (no dialog); its title field is focused with the name selected, and one undo step removes the card (redo restores it)', async () => {
  const h = await harness(); realAdd(h);
  const notesBefore = noteCount(h), past = h.view.history.past.length;
  h.view.contentEl.ownerDocument = { activeElement: h.card('leaf') };
  modCtrlEnter(h);
  await until(() => h.map().nodes.length === 5); await tick(); await tick();
  assert.equal(h.modals.filter(m => m.constructor.name === 'NameModal').length, 0, 'no name dialog');
  const fresh = freshCard(h);
  assert.equal(fresh.parentId, h.ids.leaf, 'a child of the focused card');
  assert.equal(h.view.notes.get(fresh.id).title, 'New topic');
  assert.equal(h.view.history.past.length, past + 1, 'one history entry');
  const field = nameField(h, fresh.id);
  assert.ok(field, 'the card shows a title field'); assert.equal(field.value, 'New topic');
  assert.equal(make.last, field, 'DOM focus is on the title field'); assert.equal(h.view.inlineName.fresh, true, 'the name stays selected until the user types');
  await h.view.travel(false); await tick();
  assert.equal(h.map().nodes.some(n => n.id === fresh.id), false, 'one undo removes the whole card');
  await h.view.travel(true); await tick();
  assert.equal(h.map().nodes.some(n => n.id === fresh.id), true, 'redo brings the card back');
  assert.equal(noteCount(h), notesBefore + 1);
});

test('21: typing in the field and Enter renames the card (one more undo step); the type row is gone once the edit ends', async () => {
  const h = await harness(); realAdd(h);
  await h.view.addNode(h.map().nodes.find(n => n.id === h.ids.leaf));
  const fresh = freshCard(h), past = h.view.history.past.length;
  const field = nameField(h, fresh.id); field.value = '手機設計';
  press(field, 'Enter');
  await until(() => h.view.notes.get(fresh.id).title === '手機設計'); await tick(); await tick();
  assert.equal(h.view.history.past.length, past + 1);
  assert.equal(h.view.inlineName, null, 'the edit ended');
  assert.equal(nameField(h, fresh.id), undefined);
});

// A blank name is not a cancel: it keeps the default name and the card (unchanged).
test('21: a blank name keeps the default name and adds no empty card', async () => {
  const h = await harness(); realAdd(h);
  await h.view.addNode(h.map().nodes.find(n => n.id === h.ids.leaf));
  const fresh = freshCard(h), past = h.view.history.past.length, notes = noteCount(h);
  const field = nameField(h, fresh.id); field.value = '   '; press(field, 'Enter'); await tick(); await tick();
  assert.equal(h.view.notes.get(fresh.id).title, 'New topic', 'the default name stays');
  assert.equal(h.map().nodes.length, 5); assert.equal(noteCount(h), notes); assert.equal(h.view.history.past.length, past, 'no history entry for the ended edit');
  assert.equal(h.view.inlineName, null); assert.equal(nameField(h, fresh.id), undefined);
});

// UI audit bugfix-2 (add-topic-esc-keeps-card): Esc cancels the add, so the new topic leaves the map and its note is gone.
test('21: Esc in the name field of a new topic takes the add back: no card, no Map.md node, no note', async () => {
  const h = await harness(); realAdd(h);
  await h.view.addNode(h.map().nodes.find(n => n.id === h.ids.leaf));
  const fresh = freshCard(h), notes = noteCount(h);
  // The fixture's trashFile only records the path; Obsidian also removes the file, so the trash here does too.
  const trashed = [], trashFile = h.app.fileManager.trashFile;
  h.app.fileManager.trashFile = async file => { trashed.push(file.path); await trashFile(file); h.contents.delete(file.path); };
  press(nameField(h, fresh.id), 'Escape');
  await until(() => h.map().nodes.length === 4); await tick(); await tick();
  assert.equal(h.view.notes.get(fresh.id), undefined, 'the card is gone');
  assert.equal(noteCount(h), notes - 1, 'the note is gone');
  assert.equal(trashed.length, 1, 'only the new note is trashed');
  assert.match(trashed[0], /\/Unassigned\//, 'it is the note undo had parked in Unassigned');
  assert.equal(h.view.inlineName, null);
});

test('21: Enter while an input method is composing does not end the edit', async () => {
  const h = await harness(); realAdd(h);
  await h.view.addNode(null);
  const fresh = freshCard(h), field = nameField(h, fresh.id); field.value = 'ㄕㄡˇ';
  press(field, 'Enter', { isComposing: true }); await tick(); await tick();
  assert.ok(h.view.inlineName, 'still editing'); assert.equal(h.view.notes.get(fresh.id).title, 'New topic'); assert.equal(h.view.history.past.length > 0, true);
  assert.equal(nameField(h, fresh.id), field, 'the same field stays');
});

test('21: new cards of one map are "New topic", "New topic 1", "New topic 2" in order', async () => {
  const h = await harness(); realAdd(h);
  const leaf = h.map().nodes.find(n => n.id === h.ids.leaf);
  for (let n = 0; n < 3; n++) { h.view.inlineName = null; await h.view.addNode(leaf); }
  const titles = h.map().nodes.filter(n => !Object.values(h.ids).includes(n.id)).map(n => h.view.notes.get(n.id).title);
  assert.equal(JSON.stringify(titles), JSON.stringify(['New topic', 'New topic 1', 'New topic 2']));
});

test('21: the card "+" and the toolbar "+ Topic" open a type list (six types and a text block) instead of a name dialog; a pick adds with that type', async () => {
  const h = await harness(); realAdd(h);
  const menus = [];
  h.view.newMenu = () => { const m = { items: [], addItem(cb) { const it = { setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, onClick(f) { this.run = f; return this; } }; cb(it); m.items.push(it); return m; }, showAtMouseEvent() { m.shown = true; }, select(n) { m.selected = n; } }; menus.push(m); return m; };
  h.view.canEditText = () => true;
  const textUnder = []; h.view.addTextNodeUnder = parent => textUnder.push(parent?.id ?? null);
  const leaf = h.map().nodes.find(n => n.id === h.ids.leaf);
  h.view.openAddMenu({}, leaf);
  const menu = menus[0];
  assert.equal(menu.shown, true); assert.equal(menu.selected, 0, 'Enter takes the first row');
  assert.equal(menu.items.length, 7, 'six types then the text block');
  assert.equal(menu.items[0].title, 'Topic'); assert.equal(menu.items.at(-1).title, 'Add text');
  assert.equal(h.modals.filter(m => m.constructor.name === 'NameModal').length, 0);
  assert.equal(h.map().nodes.length, 4, 'nothing is made before a pick');
  menu.items[0].run(); await until(() => h.map().nodes.length === 5); await tick();
  const fresh = freshCard(h);
  assert.equal(fresh.parentId, h.ids.leaf); assert.equal(h.view.notes.get(fresh.id).title, 'New topic'); assert.ok(h.view.inlineName, 'the title is open for typing');
  menu.items.at(-1).run(); await tick();
  assert.equal(JSON.stringify(textUnder), JSON.stringify([h.ids.leaf]), 'the text block goes under the card');
});

test('21: the undo key in a pristine new-card field removes the card in one step; after typing it is left to the field', async () => {
  const h = await harness(); realAdd(h);
  await h.view.addNode(h.map().nodes.find(n => n.id === h.ids.leaf));
  const fresh = freshCard(h), field = nameField(h, fresh.id);
  const undo = h.view.scope.keys.find(k => k.key === 'z' && k.modifiers.length === 1);
  field.closest = selector => (selector.includes('vam-card-title-input') || selector.includes('input') ? field : null);
  h.view.inlineName.draft = 'typed';
  assert.equal(undo.func({ key: 'z', isComposing: false, target: field }, {}), true, 'typed text: native undo');
  h.view.inlineName.draft = 'New topic';
  assert.equal(undo.func({ key: 'z', isComposing: false, target: field }, {}), false, 'pristine: handled');
  await until(() => !h.map().nodes.some(n => n.id === fresh.id)); await tick();
  assert.equal(h.map().nodes.length, 4); assert.equal(h.view.inlineName, null);
});

test('21: Shift+Enter on a root adds a new root named "New topic" and its field has the focus', async () => {
  const h = await harness(); realAdd(h);
  const roots = h.map().nodes.filter(n => !n.parentId).length;
  h.view.contentEl.ownerDocument = { activeElement: h.card('root') };
  h.view.scope.keys.find(k => k.key === 'Enter' && k.modifiers.length === 1 && k.modifiers[0] === 'Shift').func({ key: 'Enter', isComposing: false, defaultPrevented: false }, {});
  await until(() => h.map().nodes.length === 5); await tick(); await tick();
  const fresh = freshCard(h);
  assert.equal(fresh.parentId ?? null, null); assert.equal(h.map().nodes.filter(n => !n.parentId).length, roots + 1);
  assert.equal(make.last, nameField(h, fresh.id)); assert.equal(h.view.notes.get(fresh.id).title, 'New topic');
  assert.equal(h.modals.filter(m => m.constructor.name === 'NameModal').length, 0);
});

// F21: the field's real selection (not just the "fresh" flag) must cover the whole default name after every entry point settles.
const assertAllSelected = (h, label) => {
  const field = nameField(h, freshCard(h).id);
  assert.equal(make.last, field, `${label}: the title field has the focus`);
  assert.equal(field.value, 'New topic');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 'New topic'.length], `${label}: the whole default name is selected, so typing replaces it`);
};

test('F21: Mod+Enter, Shift+Enter, the type list and the card "+" all leave the new card\'s whole name selected after the repaints settle', async () => {
  for (const entry of ['mod', 'shift', 'menu']) {
    const h = await harness(); realAdd(h);
    if (entry === 'menu') {
      const menus = [];
      h.view.newMenu = () => { const m = { items: [], addItem(cb) { const it = { setTitle() { return this; }, setIcon() { return this; }, onClick(f) { this.run = f; return this; } }; cb(it); m.items.push(it); return m; }, showAtMouseEvent() {}, select() {} }; menus.push(m); return m; };
      h.view.canEditText = () => true;
      h.view.openAddMenu({}, h.map().nodes.find(n => n.id === h.ids.leaf));
      menus[0].items[0].run();
    } else if (entry === 'mod') { h.view.contentEl.ownerDocument = { activeElement: h.card('leaf') }; modCtrlEnter(h); }
    else { h.view.contentEl.ownerDocument = { activeElement: h.card('root') }; h.view.scope.keys.find(k => k.key === 'Enter' && k.modifiers.length === 1 && k.modifiers[0] === 'Shift').func({ key: 'Enter', isComposing: false, defaultPrevented: false }, {}); }
    await until(() => h.map().nodes.length === 5); await tick(); await tick();
    assertAllSelected(h, entry);
    // Every later focus of the field (addNode focuses it again after the paint, so does each repaint) must keep the untouched default name selected.
    h.view.focusInlineName(); await tick(); await tick();
    assertAllSelected(h, entry + ' after a second focus');
    // Once the user types, a re-focus keeps the caret at the end instead of selecting again.
    const field = nameField(h, freshCard(h).id);
    field.value = 'New topic!'; field.handlers.get('input')({});
    h.view.focusInlineName(); await tick();
    const typed = nameField(h, freshCard(h).id);
    assert.deepEqual([typed.selectionStart, typed.selectionEnd], [10, 10], entry + ': after typing the caret stays at the end');
  }
});

test('36: addNode with focus=false (AI suggestion, outline import, map chat) does not take focus', async () => {
  const h = await harness(); realAdd(h);
  const last = make.last;
  await h.view.addNode(h.map().nodes.find(n => n.id === h.ids.leaf), 'Quiet', true, false);
  await tick(); assert.equal(h.map().nodes.length, 5);
  assert.equal(make.last, last, 'focus unchanged'); assert.deepEqual(h.cameraMoves, [], 'camera unchanged');
});

test('36 R1 F1: the structure review "strengthen" apply adds the card without taking DOM focus (its dialog stays open)', async () => {
  const h = await harness(); realAdd(h);
  const last = make.last;
  const leaf = h.card('leaf'); h.view.contentEl.ownerDocument = { activeElement: leaf };
  const ok = await h.view.applyStructureSuggestion({ kind: 'strengthen', targetId: h.ids.leaf, title: 'Reinforce', reason: 'Thin.', basis: {} }, 'Reinforce', () => null);
  await tick(); await tick();
  assert.equal(ok, true); assert.equal(h.map().nodes.length, 5, 'the card was added');
  assert.equal(make.last, last, 'no card took DOM focus');
  assert.equal(h.view.contentEl.ownerDocument.activeElement, leaf, 'activeElement unchanged');
  assert.equal(h.cameraMoves.length, 1, 'the camera still moved to the new card');
});
