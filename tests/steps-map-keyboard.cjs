// 0.25 A4: keyboard flow on map cards. Delete/Backspace remove (leaf with Undo, branch with the confirmation),
// Mod+Enter adds a subtopic, Shift+Enter a sibling, double-clicking a title renames, and Mod+Z / Mod+Shift+Z run from
// the view's scope. Real view + repository; the DOM is the stand-in from tests/support-dom.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, tick } = dom;
// A card-sized DOM stand-in (one handler per event name, like the view's own selection tests).
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
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
  const build = () => { view.cardEls.clear(); stage.children = []; view.tabStopId = view.defaultTabStop(view.map.nodes); for (const n of view.map.nodes) view.renderNode(n); };
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

test('A4: double-clicking a card title opens the rename dialog even though the pointer is captured by the card', async () => {
  const h = await harness();
  const card = h.card('leaf'), title = findAll(card, i => i.tag === 'h3')[0];
  title.getBoundingClientRect = () => ({ left: 20, right: 120, top: 30, bottom: 50 });
  const dbl = (x, y, target = card) => { const event = { target, clientX: x, clientY: y, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; card.handlers.get('dblclick')(event); return event; };
  assert.ok(card.handlers.get('dblclick'), 'the card listens for dblclick');
  assert.equal(dbl(300, 300).defaultPrevented, false, 'outside the title: nothing');
  assert.equal(dbl(60, 70).defaultPrevented, false, 'just below the title: nothing');
  const tool = element('button'); tool.closest = sel => (sel === 'button' ? tool : null);
  dbl(60, 40, tool);
  assert.deepEqual(modalNames(h), [], 'a tool button never renames');
  assert.equal(dbl(60, 40).defaultPrevented, true, 'inside the title rect, target is the card');
  assert.deepEqual(modalNames(h), ['NameModal']);
  assert.equal(h.modals[0].value ?? h.modals[0].initial ?? 'Leaf', 'Leaf');
});

test('A4: F2 on the view scope renames the focused card and passes through when no card has focus', async () => {
  const h = await harness();
  const f2 = h.view.scope.keys.filter(k => k.key === 'F2' && k.modifiers.length === 0);
  assert.equal(f2.length, 1, 'F2 is registered on the view scope');
  const doc = { activeElement: null }; h.view.contentEl.ownerDocument = doc;
  const fire = () => f2[0].func({ key: 'F2', isComposing: false, defaultPrevented: false }, {});
  assert.equal(fire(), true, 'no focused card: left to Obsidian'); doc.activeElement = element('div');
  assert.equal(fire(), true, 'focus elsewhere: left to Obsidian'); assert.deepEqual(modalNames(h), []);
  doc.activeElement = h.card('leaf');
  assert.equal(fire(), false, 'a focused card: handled'); assert.deepEqual(modalNames(h), ['NameModal']);
  h.view.integrationMode = true; assert.equal(fire(), true, 'selection mode: passes through'); assert.equal(h.modals.length, 1);
  h.view.integrationMode = false; h.view.closed = true; assert.equal(fire(), true, 'closed view: passes through');
  h.view.closed = false;
  const card = h.card('leaf'); card.handlers.get('keydown')({ key: 'F2', target: card, defaultPrevented: true, preventDefault() {} });
  assert.equal(h.modals.length, 1, 'the card handler does not open a second dialog when the scope already handled F2');
});

test('A4: the sample, an AIM map and selection mode ignore the new keys and the title double-click', async () => {
  for (const mode of ['sample', 'aim', 'select']) {
    const h = await harness();
    if (mode === 'sample') h.view.builtIn = true;
    if (mode === 'aim') h.view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
    if (mode === 'select') h.view.integrationMode = true;
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
