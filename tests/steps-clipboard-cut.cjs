// 0.28 P5 (ticket 24): cut and paste of branches inside one map, in the real view. A cut records the branches and marks
// their cards; a paste of the exact string moves them (same notes, new parent, one history entry); anything else that
// reaches the clipboard or a failed match drops the mark and moves nothing.
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
const cutOf = (h, ids, target = card) => {
  h.view.selected = null; h.view.multiSelected.clear();
  if (ids.length === 1) h.view.selected = h.ids[ids[0]]; else for (const key of ids) h.view.multiSelected.add(h.ids[key]);
  const event = clipboardEvent(target);
  h.view.onClipboardEvent('cut', event);
  h.lastRaw = event.clipboardData.store.get(MIME);
  return event;
};
const parentOf = (h, key) => h.map().nodes.find(n => n.id === h.ids[key]).parentId;
const marked = h => Object.keys(h.ids).filter(key => h.view.cardEls.get(h.ids[key])?.classes.has('is-cut'));

test('P5 cut: writes the private format, marks the source cards and names them "Cut", and changes nothing yet', async () => {
  const h = await harness();
  const event = cutOf(h, ['branch']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(parse(event.clipboardData.store.get(MIME)).ok, true);
  assert.equal(event.clipboardData.store.get('text/plain'), '- Branch\n\t- Kid');
  assert.equal(h.history(), 0); assert.equal(h.map().nodes.length, 5);
  h.view.render();
  assert.deepEqual(marked(h).sort(), ['branch', 'kid']);
  const branchCard = h.view.cardEls.get(h.ids.branch);
  const names = branchCard.attrs['aria-labelledby'].split(' ');
  assert.equal(names.length, 2, 'the accessible name has the title part and the cut part');
  const part = branchCard.children.find(c => c.id === names[1]);
  assert.equal(part.text, 'Cut'); assert.ok(part.classes.has('vam-card-label'));
  assert.equal(h.view.cardEls.get(h.ids.leaf).classes.has('is-cut'), false);
});

test('P5 cut then paste under another card moves the same notes: one history step, undo puts them back', async () => {
  const h = await harness();
  cutOf(h, ['branch']);
  const raw = h.lastRaw, filesBefore = files(h), pathsBefore = h.map().nodes.map(n => n.path);
  h.view.selected = h.ids.other; h.view.multiSelected.clear();
  const event = pasteOf(h, { [MIME]: raw });
  assert.equal(event.defaultPrevented, true);
  await until(() => parentOf(h, 'branch') === h.ids.other); await tick(); await tick();
  assert.equal(parentOf(h, 'kid'), h.ids.branch, 'the descendant stays with its branch');
  assert.equal(h.map().nodes.length, 5); assert.deepEqual(files(h), filesBefore, 'no file created or removed');
  assert.deepEqual(h.map().nodes.map(n => n.path), pathsBefore);
  assert.equal(h.history(), 1);
  assert.equal((await h.saved()).nodes.find(n => n.id === h.ids.branch).parentId, h.ids.other);
  assert.deepEqual(marked(h), [], 'the mark is gone after the move');
  await h.view.travel(false); await tick();
  assert.equal(parentOf(h, 'branch'), h.ids.root, 'undo restores the old parent');
});

test('P5 cut then paste with nothing selected moves the branch to the top level', async () => {
  const h = await harness();
  cutOf(h, ['branch']);
  const raw = h.lastRaw;
  h.view.selected = null; h.view.multiSelected.clear();
  pasteOf(h, { [MIME]: raw });
  await until(() => parentOf(h, 'branch') === null); await tick(); await tick();
  assert.equal(h.map().nodes.length, 5); assert.equal(h.history(), 1);
  const branch = h.map().nodes.find(n => n.id === h.ids.branch);
  assert.ok(branch.y > Math.max(...['root', 'leaf', 'other'].map(k => h.map().nodes.find(n => n.id === h.ids[k]).y)), 'laid out below the other trees');
  assert.equal(parentOf(h, 'kid'), h.ids.branch);
});

test('P5 cut, then copy something else, then paste: the source does not move and the mark is gone', async () => {
  const h = await harness();
  cutOf(h, ['branch']);
  const cutRaw = h.lastRaw;
  copyOf(h, ['leaf']);
  assert.deepEqual(marked(h), [], 'the mark goes at the copy');
  h.view.selected = h.ids.other; h.view.multiSelected.clear();
  // Pasting the old cut string now is not a match: it is only a payload, so it makes copies and moves nothing.
  pasteOf(h, { [MIME]: cutRaw });
  await until(() => h.map().nodes.length === 7); await tick(); await tick();
  assert.equal(parentOf(h, 'branch'), h.ids.root, 'the cut source stayed');
  assert.equal(h.history(), 1);
});

test('P5 cut, then a copy elsewhere in the window (outside the view), cancels the mark too', async () => {
  const h = await harness();
  cutOf(h, ['leaf']);
  h.view.render();
  assert.deepEqual(marked(h), ['leaf']);
  const outside = clipboardEvent(body); h.view.onClipboardEvent('copy', outside);
  assert.deepEqual(marked(h), []);
  h.view.selected = h.ids.other;
  pasteOf(h, { [MIME]: h.lastRaw });
  await until(() => h.map().nodes.length === 6); await tick(); await tick();
  assert.equal(parentOf(h, 'leaf'), h.ids.root, 'the leaf was copied, not moved');
});

test('P5 cut, then a paste of something else (a mismatch) drops the mark and moves nothing', async () => {
  const h = await harness();
  cutOf(h, ['leaf']);
  h.view.selected = h.ids.other;
  pasteOf(h, { 'text/plain': 'something else' });
  await tick(); await tick();
  assert.deepEqual(marked(h), []);
  assert.equal(parentOf(h, 'leaf'), h.ids.root);
});

test('P5 cut: pasting into its own branch or a descendant is refused and the map stays as it was', async () => {
  const h = await harness();
  for (const target of ['branch', 'kid']) {
    cutOf(h, ['branch']);
    const raw = h.lastRaw, before = JSON.stringify(h.map().nodes);
    h.view.selected = h.ids[target]; h.view.multiSelected.clear();
    pasteOf(h, { [MIME]: raw });
    await tick(); await tick();
    assert.equal(JSON.stringify(h.map().nodes), before, `${target}: map unchanged`);
    assert.equal(h.history(), 0, `${target}: no history`);
    assert.equal(h.notices.at(-1), 'A branch cannot be pasted into itself or its own sub-topics, so nothing was moved.');
  }
});

test('P5 cut: a read-only map (built-in sample, AIM, topic selection mode) cannot be cut', async () => {
  const cases = {
    builtIn: h => { h.view.builtIn = true; },
    aim: h => { h.view.map.aim = { version: 1 }; },
    integration: h => { h.view.integrationMode = true; }
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const h = await harness();
    arrange(h);
    const event = cutOf(h, ['leaf']);
    assert.equal(event.defaultPrevented, false, name);
    assert.equal(event.clipboardData.store.size, 0, `${name}: nothing written`);
    assert.equal(h.notices.at(-1), 'This map is read-only here, so nothing was cut.', name);
    assert.equal(sessionOf(h).get(), null, `${name}: no cut recorded`);
  }
});

test('P5 cut: events in a text control, the chat panel or outside the view are not intercepted', async () => {
  const h = await harness();
  for (const target of [body, textControl, chatPanel]) {
    const event = cutOf(h, ['leaf'], target);
    assert.equal(event.defaultPrevented, false); assert.equal(event.clipboardData.store.size, 0);
  }
  assert.equal(sessionOf(h).get(), null);
});

test('P5 cut: when the source changed after the cut, the paste moves nothing and the mark goes', async () => {
  const h = await harness();
  cutOf(h, ['branch']);
  const raw = h.lastRaw;
  h.view.map.nodes.find(n => n.id === h.ids.kid).parentId = h.ids.root;
  await h.repo.saveMap(MAP, h.view.map);
  h.view.selected = h.ids.other;
  pasteOf(h, { [MIME]: raw });
  await until(() => h.map().nodes.length === 7); await tick(); await tick();
  assert.equal(parentOf(h, 'branch'), h.ids.root, 'not moved');
  assert.deepEqual(marked(h), []);
});

function sessionOf(h) { return clipboardSession.sessionFor(h.plugin); }
