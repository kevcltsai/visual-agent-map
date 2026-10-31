// 0.28 P4 (ticket 23 P2): copy and paste of branches inside one map, wired in the real view. The document-level
// handlers decide by target (a card or the content element yes; text controls, the chat panel and anything outside the
// view no), copy writes the private format plus a plain outline, and a paste duplicates the source notes when the
// clipboard string is exactly what the plugin wrote, else builds new notes from the payload's whitelisted fields.
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
const clipboardModule = load('experiences/visual-map/clipboard.ts', { obsidian });
// The module runs in its own vm realm; copy results into this one before deepEqual compares them.
const parse = text => JSON.parse(JSON.stringify(clipboardModule.parseClipboard(text)));
const payloadText = (nodes, extra = {}) => JSON.stringify({ format: 'vam-branch', version: 1, clipId: 'clip-external-1', relations: [], nodes, ...extra });
const files = h => [...h.contents.keys()].filter(p => p.endsWith('.md')).sort();

test('P4 copy: a selected card writes the private format and a plain outline, and the event is ours', async () => {
  const h = await harness();
  const event = copyOf(h, ['leaf']);
  assert.equal(event.defaultPrevented, true);
  const raw = event.clipboardData.store.get(MIME);
  const parsed = parse(raw);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload.nodes.map(n => [n.title, n.parent, n.body]), [['Leaf', null, 'Leaf detail text']]);
  assert.equal(event.clipboardData.store.get('text/plain'), '- Leaf');
  assert.equal(event.clipboardData.store.has('text/html'), false, 'no text/html');
  assert.equal(h.history(), 0, 'a copy writes no history');
});

test('P4 copy: a selected branch joins its selected descendant; several roots keep the map order', async () => {
  const h = await harness();
  const event = copyOf(h, ['kid', 'branch', 'leaf']);
  const parsed = parse(event.clipboardData.store.get(MIME));
  assert.deepEqual(parsed.payload.nodes.map(n => n.title), ['Leaf', 'Branch', 'Kid']);
  assert.equal(event.clipboardData.store.get('text/plain'), '- Leaf\n- Branch\n\t- Kid');
});

test('P4 copy: a read-only map (built-in sample) can still be copied (D4)', async () => {
  const h = await harness();
  h.view.builtIn = true;
  const event = copyOf(h, ['leaf']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(parse(event.clipboardData.store.get(MIME)).ok, true);
});

test('P4 scope: events outside the view, in a text control, in the chat panel, or with nothing selected are not intercepted', async () => {
  const h = await harness();
  for (const target of [body, textControl, chatPanel]) {
    const copy = copyOf(h, ['leaf'], target);
    assert.equal(copy.defaultPrevented, false); assert.equal(copy.clipboardData.store.size, 0);
    const paste = pasteOf(h, { [MIME]: payloadText([{ id: 'n1', parent: null, title: 'X', kind: 'topic', body: '' }]) }, target);
    assert.equal(paste.defaultPrevented, false);
  }
  h.view.selected = null; h.view.multiSelected.clear();
  const none = clipboardEvent(card); h.view.onClipboardEvent('copy', none);
  assert.equal(none.defaultPrevented, false, 'nothing selected: the default copy runs');
  await tick(); await tick();
  assert.equal(h.map().nodes.length, 5); assert.equal(h.history(), 0);
  const text = pasteOf(h, { 'text/plain': '   ' }, body);
  assert.equal(text.defaultPrevented, false, 'outside the view, plain text is left alone (P5 handles plain text inside it)');
});

test('P4 paste: the same map under the selected card duplicates the notes with the same title, one history step, and undo removes them', async () => {
  const h = await harness();
  copyOf(h, ['leaf']);
  const raw = h.lastRaw;
  h.view.selected = h.ids.other; h.view.multiSelected.clear();
  const filesBefore = files(h);
  const event = pasteOf(h, { [MIME]: raw });
  assert.equal(event.defaultPrevented, true);
  await until(() => h.map().nodes.length === 6); await tick(); await tick();
  const added = h.map().nodes.find(n => !Object.values(h.ids).includes(n.id));
  assert.equal(added.parentId, h.ids.other, 'under the selected card');
  assert.equal(h.notes().get(added.id).title, 'Leaf', 'no copy suffix');
  assert.equal(h.notes().get(added.id).detail, 'Leaf detail text');
  assert.notEqual(added.path, h.map().nodes.find(n => n.id === h.ids.leaf).path, 'its own file');
  assert.equal(files(h).length, filesBefore.length + 1);
  assert.equal(h.history(), 1, 'one history step');
  assert.equal((await h.saved()).nodes.length, 6);
  await h.view.travel(false); await tick();
  assert.equal(h.map().nodes.length, 5, 'undo takes the copy off the map');
});

test('P4 paste: with no selection the branch becomes new top-level trees below the existing ones', async () => {
  const h = await harness();
  copyOf(h, ['branch']);
  const raw = h.lastRaw;
  h.view.selected = null; h.view.multiSelected.clear();
  pasteOf(h, { [MIME]: raw });
  await until(() => h.map().nodes.length === 7); await tick(); await tick();
  const fresh = h.map().nodes.filter(n => !Object.values(h.ids).includes(n.id));
  const top = fresh.find(n => n.parentId === null);
  assert.ok(top, 'a new root');
  assert.equal(h.notes().get(top.id).title, 'Branch');
  const kid = fresh.find(n => n.parentId === top.id);
  assert.equal(h.notes().get(kid.id).title, 'Kid', 'the child follows its copied parent');
  assert.ok(top.y > Math.max(...h.map().nodes.filter(n => Object.values(h.ids).includes(n.id)).map(n => n.y)), 'below the old trees');
  assert.equal(h.history(), 1);
});

test('P4 paste: a copy keeps the relations between copied topics', async () => {
  const h = await harness();
  const doc = h.map();
  doc.topicRelations = [{ kind: 'related', from: h.ids.branch, to: h.ids.kid }];
  await h.repo.saveMap(MAP, doc);
  copyOf(h, ['branch', 'kid']);
  const raw = h.lastRaw;
  h.view.selected = h.ids.other; h.view.multiSelected.clear();
  pasteOf(h, { [MIME]: raw });
  await until(() => h.map().nodes.length === 7); await tick(); await tick();
  const fresh = h.map().nodes.filter(n => !Object.values(h.ids).includes(n.id));
  const link = h.map().topicRelations.find(r => fresh.some(n => n.id === r.from));
  assert.ok(link, 'a relation between the copies');
  assert.ok(fresh.some(n => n.id === link.to));
  assert.equal(h.map().topicRelations.length, 2);
});

test('P4 paste: the source is copied only when the string is byte for byte what the plugin wrote (D2)', async () => {
  const h = await harness();
  const leafPath = h.map().nodes.find(n => n.id === h.ids.leaf).path;
  h.contents.set(leafPath, h.contents.get(leafPath).replace('---\n', '---\ncustom-marker: from-source\n'));
  copyOf(h, ['leaf']);
  const raw = h.lastRaw;
  h.view.selected = h.ids.other;
  pasteOf(h, { [MIME]: raw });
  await until(() => h.map().nodes.length === 6); await tick(); await tick();
  const exact = h.map().nodes.at(-1);
  assert.match(h.contents.get(exact.path), /custom-marker: from-source/, 'a matched paste duplicates the file');
  // One extra space: valid JSON, but not the recorded string, so only the payload's fields are used.
  pasteOf(h, { [MIME]: `${raw} ` });
  await until(() => h.map().nodes.length === 7); await tick(); await tick();
  const loose = h.map().nodes.at(-1);
  assert.doesNotMatch(h.contents.get(loose.path), /custom-marker/, 'no frontmatter from the source');
  assert.equal(h.notes().get(loose.id).title, 'Leaf');
  assert.equal(h.notes().get(loose.id).detail, 'Leaf detail text', 'the body travels in the payload');
});

test('P4 paste: an external payload makes new notes with kind, strength and body; paths in it are ignored', async () => {
  const h = await harness();
  const leafPath = h.map().nodes.find(n => n.id === h.ids.leaf).path;
  const before = h.contents.get(leafPath);
  h.view.selected = h.ids.root;
  const text = payloadText([
    { id: 'a', parent: null, title: 'Claim', kind: 'hypothesis', strength: 'strong', body: 'Why it holds', path: leafPath, mapId: 'other-map' },
    { id: 'b', parent: 'a', title: 'Evidence', kind: 'topic', body: '' }
  ], { sourceMapPath: MAP, notePaths: [leafPath] });
  pasteOf(h, { [MIME]: text });
  await until(() => h.map().nodes.length === 7); await tick(); await tick();
  const fresh = h.map().nodes.filter(n => !Object.values(h.ids).includes(n.id));
  const claim = fresh.find(n => n.parentId === h.ids.root);
  const note = h.notes().get(claim.id);
  assert.equal(note.title, 'Claim'); assert.equal(note.topicKind, 'hypothesis'); assert.equal(note.hypothesisStrength, 'strong');
  assert.equal(note.detail, 'Why it holds');
  assert.equal(fresh.find(n => n.parentId === claim.id) && h.notes().get(fresh.find(n => n.parentId === claim.id).id).title, 'Evidence');
  assert.equal(h.contents.get(leafPath), before, 'the named source file is not touched');
  assert.equal(h.history(), 1);
});

test('P4 paste: read-only situations (built-in sample, AIM map, topic selection mode) write nothing and say so', async () => {
  const valid = payloadText([{ id: 'a', parent: null, title: 'Claim', kind: 'topic', body: '' }]);
  const cases = {
    builtIn: h => { h.view.builtIn = true; },
    aim: h => { h.view.map.aim = { version: 1 }; },
    integration: h => { h.view.integrationMode = true; }
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const h = await harness();
    h.view.selected = h.ids.root;
    arrange(h);
    const filesBefore = files(h), nodes = h.map().nodes.length;
    const event = pasteOf(h, { [MIME]: valid });
    await tick(); await tick();
    assert.equal(event.defaultPrevented, true, name);
    assert.equal(h.map().nodes.length, nodes, `${name}: no node`);
    assert.deepEqual(files(h), filesBefore, `${name}: no file`);
    assert.equal(h.history(), 0, `${name}: history unchanged`);
    assert.equal(h.notices.at(-1), 'This map is read-only here, so nothing was pasted.', name);
  }
});

test('P4 paste: hostile payloads write no file and add no node', async () => {
  const h = await harness();
  h.view.selected = h.ids.root;
  const good = { id: 'a', parent: null, title: 'T', kind: 'topic', body: '' };
  const bad = [
    '{not json',
    '[]',
    JSON.stringify({ format: 'other', version: 1 }),
    payloadText([{ ...good, title: 'two\nlines' }]),
    payloadText([{ ...good, title: '' }]),
    payloadText([{ ...good, parent: 'missing' }]),
    payloadText([{ ...good, kind: 'evil' }]),
    payloadText([{ ...good, body: '---\nagent-map-node: true\n---\nx' }]),
    payloadText([{ ...good, body: 'x <!-- visual-agent-map: {} -->' }]),
    payloadText([good, { ...good }]),
    payloadText([]),
    payloadText([{ ...good, id: '../../etc' }]),
    payloadText(Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, parent: null, title: `t${i}`, kind: 'topic', body: '' })))
  ];
  const filesBefore = files(h), nodes = h.map().nodes.length;
  for (const raw of bad) {
    const event = pasteOf(h, { [MIME]: raw });
    assert.equal(event.defaultPrevented, true);
  }
  await tick(); await tick();
  assert.equal(h.map().nodes.length, nodes, 'no new node');
  assert.deepEqual(files(h), filesBefore, 'no new file');
  assert.equal(h.history(), 0);
  assert.equal(h.notices.length, bad.length);
  assert.ok(h.notices.every(m => m === 'The clipboard does not hold a valid branch, so nothing was pasted.'));
  assert.equal(h.view.cardEls.size, nodes, 'no new card on screen');
});

test('P4 paste: when a copied topic is gone the paste still works from the payload', async () => {
  const h = await harness();
  copyOf(h, ['leaf']);
  const raw = h.lastRaw;
  h.map().nodes = h.map().nodes.filter(n => n.id !== h.ids.leaf);
  await h.repo.saveMap(MAP, h.map());
  h.view.selected = h.ids.other;
  pasteOf(h, { [MIME]: raw });
  await until(() => h.map().nodes.length === 5); await tick(); await tick();
  const added = h.map().nodes.at(-1);
  assert.equal(h.notes().get(added.id).title, 'Leaf');
  assert.equal(added.parentId, h.ids.other);
});

test('P4 binding: listeners go on the window document, one set, and move with the view to a popout window', async () => {
  const h = await harness();
  const makeDoc = () => { const log = { added: [], removed: [] }; return { log, addEventListener: (n, f) => log.added.push([n, f]), removeEventListener: (n, f) => log.removed.push([n, f]) }; };
  const main = makeDoc(), popout = makeDoc();
  h.view.contentEl.doc = main;
  h.view.bindClipboard();
  assert.deepEqual(main.log.added.map(([n]) => n), ['copy', 'cut', 'paste']);
  h.view.contentEl.doc = popout;
  h.view.bindClipboard();
  assert.equal(main.log.removed.length, 3, 'the old window is released');
  assert.deepEqual(popout.log.added.map(([n]) => n), ['copy', 'cut', 'paste']);
  // The registered listener runs the same handler.
  const paste = popout.log.added.find(([n]) => n === 'paste')[1];
  h.view.selected = h.ids.root;
  const event = clipboardEvent(card, { [MIME]: payloadText([{ id: 'a', parent: null, title: 'Pop', kind: 'topic', body: '' }]) });
  paste(event);
  assert.equal(event.defaultPrevented, true);
  await until(() => h.map().nodes.length === 6);
  h.view.unbindClipboard();
  assert.equal(popout.log.removed.length, 3);
});

test('P4 Copy to…: the copy keeps the "copy" suffix; only a paste keeps the title', async () => {
  const h = await harness();
  h.view.multiSelected.add(h.ids.leaf);
  await h.view.copySelected(h.map().nodes.find(n => n.id === h.ids.other));
  const added = h.map().nodes.at(-1);
  assert.equal(h.notes().get(added.id).title, 'Leaf copy');
  const plain = await h.repo.duplicateNote(h.map().nodes.find(n => n.id === h.ids.leaf).path, h.map(), MAP);
  assert.match(h.contents.get(plain.path), /title: Leaf copy/);
  const kept = await h.repo.duplicateNote(h.map().nodes.find(n => n.id === h.ids.leaf).path, h.map(), MAP, { keepTitle: true });
  assert.match(h.contents.get(kept.path), /title: Leaf\n/);
});
