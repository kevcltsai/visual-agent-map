// 0.28 P5 (ticket 25): plain-text paste in the real view. Text without the private format becomes an outline under the
// selected topic (or a new tree), as one history step; an oversize or malformed text is refused whole with the reason
// and the line number; empty text, read-only maps and text controls never reach the write.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, tick } = dom;

const MAP = 'Agent Workspace/Topics/map-p/Map.md';
const MIME = 'application/x-vam-branch';

// A DOM stand-in just big enough for the view: cards are plain objects, the content element knows its own.
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });

async function harness({ aim = false } = {}) {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const mapDoc = { id: 'map-p', title: 'Paste', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-p');
  const ids = {};
  const add = async (key, title, parent, initial = {}) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace', initial);
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', 'Root'); await add('leaf', 'Leaf', 'root', { detail: 'Leaf detail text' }); await add('branch', 'Branch', 'root'); await add('kid', 'Kid', 'branch');
  await add('other', 'Other');
  if (aim) mapDoc.aim = { version: 1 };
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const Notice = dom.makeNotice(notices);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const stage = make('div');
  // The "inside" flag stands for Element.contains: a card, the content element itself, or a control inside the view.
  const content = element('div');
  content.contains = node => !!node?.inside;
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = content;
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.render = () => { view.cardEls.clear(); stage.children = []; view.tabStopId = view.defaultTabStop(view.map.nodes); for (const n of view.map.nodes) view.renderNode(n); };
  await view.hydrate(); view.render();
  return { repo, app, contents, view, plugin, ids, notices, map: () => view.map, saved: () => repo.readMap(MAP), notes: () => view.notes, history: () => view.history.past.length };
}

const card = { inside: true, closest: () => null };
const textControl = { inside: true, closest: selector => (selector.includes('textarea') ? textControl : null) };
const chatPanel = { inside: true, closest: selector => (selector.includes('.vam-map-chat') ? chatPanel : null) };
const body = { inside: false, closest: () => null };
const clipboardEvent = (target, data = {}) => {
  const store = new Map(Object.entries(data));
  const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    clipboardData: { getData: type => store.get(type) ?? '', setData: (type, value) => store.set(type, value), store } };
  return event;
};
const copyOf = (h, ids, target = card) => {
  h.view.selected = null; h.view.multiSelected.clear();
  if (ids.length === 1) h.view.selected = h.ids[ids[0]]; else for (const key of ids) h.view.multiSelected.add(h.ids[key]);
  const event = clipboardEvent(target);
  h.view.onClipboardEvent('copy', event);
  h.lastRaw = event.clipboardData.store.get(MIME);
  return event;
};
const pasteOf = (h, data, target = card) => { const event = clipboardEvent(target, data); h.view.onClipboardEvent('paste', event); return event; };
const clipboardSession = load('experiences/visual-map/clipboard-session.ts', { obsidian });
const clipboardModule = load('experiences/visual-map/clipboard.ts', { obsidian });
const parse = text => JSON.parse(JSON.stringify(clipboardModule.parseClipboard(text)));
const files = h => [...h.contents.keys()].filter(p => p.endsWith('.md')).sort();
const names = h => h.map().nodes.filter(n => !Object.values(h.ids).includes(n.id));
const titleOf = (h, node) => h.notes().get(node.id).title;
const settled = async h => { await tick(); await tick(); await tick(); };

test('P5 text paste: every indentation style makes the same levels, under the selected card, as one history step', async () => {
  const styles = {
    tabs: 'Alpha\n\tBeta\n\t\tGamma\n\tDelta',
    spaces: 'Alpha\n  Beta\n    Gamma\n  Delta',
    dash: '- Alpha\n  - Beta\n    - Gamma\n  - Delta',
    star: '* Alpha\n\t* Beta\n\t\t* Gamma\n\t* Delta',
    numbered: '1. Alpha\n   1. Beta\n      1. Gamma\n   2. Delta'
  };
  for (const [name, text] of Object.entries(styles)) {
    const h = await harness();
    h.view.selected = h.ids.other; h.view.multiSelected.clear();
    const event = pasteOf(h, { 'text/plain': text });
    assert.equal(event.defaultPrevented, true, name);
    await until(() => h.map().nodes.length === 9); await settled(h);
    const fresh = names(h), byTitle = Object.fromEntries(fresh.map(n => [titleOf(h, n), n]));
    assert.equal(byTitle.Alpha.parentId, h.ids.other, `${name}: Alpha under the selected card`);
    assert.equal(byTitle.Beta.parentId, byTitle.Alpha.id, name);
    assert.equal(byTitle.Gamma.parentId, byTitle.Beta.id, name);
    assert.equal(byTitle.Delta.parentId, byTitle.Alpha.id, name);
    assert.equal(h.history(), 1, `${name}: one history step`);
    assert.equal((await h.saved()).nodes.length, 9, `${name}: saved`);
    await h.view.travel(false); await tick();
    assert.equal(h.map().nodes.length, 5, `${name}: undo removes the tree`);
  }
});

test('P5 text paste: with nothing selected the text becomes a new top-level tree', async () => {
  const h = await harness();
  h.view.selected = null; h.view.multiSelected.clear();
  pasteOf(h, { 'text/plain': 'Top\n\tChild' });
  await until(() => h.map().nodes.length === 7); await settled(h);
  const fresh = names(h);
  const top = fresh.find(n => titleOf(h, n) === 'Top');
  assert.equal(top.parentId, null);
  assert.equal(fresh.find(n => titleOf(h, n) === 'Child').parentId, top.id);
});

test('F3 (D5) an unreadable private payload falls back to the plain text beside it; with no text the notice stays', async () => {
  const h = await harness();
  h.view.selected = null; h.view.multiSelected.clear();
  const before = h.map().nodes.length;
  const event = pasteOf(h, { 'application/x-vam-branch': '{not json', 'text/plain': 'Fallback\n\tKid' });
  assert.equal(event.defaultPrevented, true);
  await until(() => h.map().nodes.length === before + 2); await settled(h);
  const top = names(h).find(n => titleOf(h, n) === 'Fallback');
  assert.equal(top.parentId, null);
  assert.equal(names(h).find(n => titleOf(h, n) === 'Kid').parentId, top.id);
  const count = h.map().nodes.length, notices = h.notices.length;
  pasteOf(h, { 'application/x-vam-branch': '{not json' });
  await settled(h);
  assert.equal(h.map().nodes.length, count, 'no text: nothing is written');
  assert.equal(h.notices.length, notices + 1, 'no text: the invalid-payload notice');
});

test('P5 text paste: one line makes one topic', async () => {
  const h = await harness();
  h.view.selected = h.ids.root;
  pasteOf(h, { 'text/plain': 'Just one idea' });
  await until(() => h.map().nodes.length === 6); await settled(h);
  const fresh = names(h);
  assert.equal(fresh.length, 1); assert.equal(titleOf(h, fresh[0]), 'Just one idea'); assert.equal(fresh[0].parentId, h.ids.root);
});

test('P5 text paste: an empty or blank string does nothing and says nothing', async () => {
  const h = await harness();
  h.view.selected = h.ids.root;
  for (const text of ['', '   ', '\n\n\t\n']) {
    const event = pasteOf(h, { 'text/plain': text });
    assert.equal(event.defaultPrevented, false, JSON.stringify(text));
  }
  await settled(h);
  assert.equal(h.notices.length, 0); assert.equal(h.map().nodes.length, 5); assert.equal(h.history(), 0);
});

test('P5 text paste: line 101 refuses the whole text, names the line, and creates no note', async () => {
  const h = await harness();
  h.view.selected = h.ids.root;
  const filesBefore = files(h);
  const text = Array.from({ length: 101 }, (_, i) => `Topic ${i + 1}`).join('\n');
  const event = pasteOf(h, { 'text/plain': text });
  assert.equal(event.defaultPrevented, true);
  await settled(h);
  assert.equal(h.map().nodes.length, 5); assert.deepEqual(files(h), filesBefore); assert.equal(h.history(), 0);
  assert.match(h.notices.at(-1), /Line 101/); assert.match(h.notices.at(-1), /100 topics/);
  // Exactly 100 lines are fine.
  pasteOf(h, { 'text/plain': text.split('\n').slice(0, 100).join('\n') });
  await until(() => h.map().nodes.length === 105, 6000); await settled(h);
  assert.equal(h.history(), 1);
});

test('P5 text paste: more than 100,000 characters is refused before anything is read', async () => {
  const h = await harness();
  const filesBefore = files(h);
  pasteOf(h, { 'text/plain': 'x'.repeat(100001) });
  await settled(h);
  assert.equal(h.map().nodes.length, 5); assert.deepEqual(files(h), filesBefore); assert.equal(h.history(), 0);
  assert.equal(h.notices.at(-1), 'The pasted text is longer than 100000 characters, so nothing was pasted.');
});

test('P5 text paste: a bad line refuses the whole text with its line number', async () => {
  const h = await harness();
  h.view.selected = h.ids.root;
  const cases = [
    ['Fine\n\tbad\u0007title', /^Line 2: .*characters or markup/],
    ['Fine\n' + 'y'.repeat(201), /^Line 2: a title can be at most 200 characters/],
    ['Fine\n<!-- visual-agent-map: x -->', /Visual Agent Map/],
    ['Fine\n-', /^Line 2: this line has no title text/]
  ];
  for (const [text, expected] of cases) {
    pasteOf(h, { 'text/plain': text });
    await settled(h);
    assert.match(h.notices.at(-1), expected, JSON.stringify(text.slice(0, 30)));
  }
  assert.equal(h.map().nodes.length, 5); assert.equal(h.history(), 0);
});

test('P5 text paste: a read-only map (built-in sample, AIM, topic selection mode) writes nothing and says so', async () => {
  const cases = {
    builtIn: h => { h.view.builtIn = true; },
    aim: h => { h.view.map.aim = { version: 1 }; },
    integration: h => { h.view.integrationMode = true; }
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const h = await harness();
    h.view.selected = h.ids.root;
    arrange(h);
    const filesBefore = files(h);
    pasteOf(h, { 'text/plain': 'Alpha\n\tBeta' });
    await settled(h);
    assert.equal(h.map().nodes.length, 5, name); assert.deepEqual(files(h), filesBefore, name); assert.equal(h.history(), 0, name);
    assert.equal(h.notices.at(-1), 'This map is read-only here, so nothing was pasted.', name);
  }
});

test('P5 text paste: text controls, the chat panel and anywhere outside the view keep their own paste', async () => {
  const h = await harness();
  h.view.selected = h.ids.root;
  for (const target of [body, textControl, chatPanel]) {
    const event = pasteOf(h, { 'text/plain': 'Alpha' }, target);
    assert.equal(event.defaultPrevented, false);
  }
  await settled(h);
  assert.equal(h.map().nodes.length, 5); assert.equal(h.history(), 0);
});

test('P5 text paste: the private format wins over text/plain when both are present', async () => {
  const h = await harness();
  h.view.selected = h.ids.other;
  copyOf(h, ['leaf']);
  const raw = h.lastRaw;
  h.view.selected = h.ids.other;
  pasteOf(h, { [MIME]: raw, 'text/plain': 'Wrong\n\tTitles' });
  await until(() => h.map().nodes.length === 6); await settled(h);
  assert.equal(titleOf(h, names(h)[0]), 'Leaf');
});
