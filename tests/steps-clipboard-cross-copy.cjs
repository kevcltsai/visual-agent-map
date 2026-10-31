// 0.28 P6 (ticket 27): pasting a copy into a different map. The plugin session says the clipboard string is its own and
// the source is map A, so map B duplicates the source notes (title kept), rewrites their links from A's place, and
// writes one history step in B. Map A's files are only read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, tick } = dom;

const MIME = 'application/x-vam-branch';
const TOPICS = 'Agent Workspace/Topics';
const MAP_A = `${TOPICS}/map-a/Map.md`, MAP_B = `${TOPICS}/map-b/Map.md`;

const folderOf = (path = '') => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const shared = (a, b) => { const x = a.split('/'), y = b.split('/'); let n = 0; while (n < x.length && n < y.length && x[n] === y[n]) n++; return n; };
// Like Obsidian: a full path wins, else the file with that name in the nearest folder.
function resolverFor(listFiles) {
  return (linkPath, fromPath) => {
    if (!linkPath) return undefined;
    const files = listFiles();
    if (files.includes(linkPath)) return linkPath;
    if (files.includes(`${linkPath}.md`)) return `${linkPath}.md`;
    if (linkPath.includes('/')) return undefined;
    const named = files.filter(path => { const name = path.slice(path.lastIndexOf('/') + 1); return name === linkPath || name === `${linkPath}.md`; });
    if (!named.length) return undefined;
    const from = folderOf(fromPath);
    return named.reduce((best, path) => (shared(folderOf(path), from) > shared(folderOf(best), from) ? path : best), named[0]);
  };
}
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });

async function harness({ bHasSameTitle = false } = {}) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  app.metadataCache.getFirstLinkpathDest = (linkPath, fromPath) => {
    const path = resolverFor(() => [...contents.keys()])(linkPath, fromPath);
    return path === undefined ? null : app.vault.getAbstractFileByPath(path);
  };
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const docs = {};
  for (const [id, path] of [['map-a', MAP_A], ['map-b', MAP_B]]) {
    docs[id] = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders(`${TOPICS}/${id}`);
    await app.vault.create(path, core.serializeMap(docs[id]));
    await app.vault.create(`${TOPICS}/${id}/Attachments/img.png`, `png-${id}`);
  }
  const a = docs['map-a'], b = docs['map-b'];
  const top = await repo.createNote('Top', 'gpt-6-luna', a, MAP_A, 'workspace');
  const p = await repo.createNote('P', 'gpt-6-luna', a, MAP_A, 'workspace', { detail: 'P detail' });
  const q = await repo.createNote('Q', 'gpt-6-luna', a, MAP_A, 'workspace');
  p.parentId = top.id; q.parentId = p.id; p.x = 400; q.x = 700;
  a.nodes.push(top, p, q);
  await repo.saveMap(MAP_A, a);
  contents.set(p.path, `${contents.get(p.path)}\nNext: [[Q]]\n`);
  contents.set(q.path, `${contents.get(q.path)}\nImage: ![[img.png]]\n`);
  const anchor = await repo.createNote('Anchor', 'gpt-6-luna', b, MAP_B, 'workspace');
  b.nodes.push(anchor);
  if (bHasSameTitle) b.nodes.push(await repo.createNote('P', 'gpt-6-luna', b, MAP_B, 'workspace'));
  await repo.saveMap(MAP_B, b);
  await repo.rebuildDerivedData();
  const notices = [];
  const Notice = dom.makeNotice(notices);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); }
  });
  const open = async path => {
    const view = new VisualAgentMapView({ app }, plugin);
    const stage = make('div'), content = element('div');
    content.contains = node => !!node?.inside;
    view.path = path; view.map = await repo.readMap(path); view.stageEl = stage; view.contentEl = content;
    view.focusNode = () => {}; view.openDetails = () => {};
    view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
    view.render = () => { view.cardEls.clear(); stage.children = []; view.tabStopId = view.defaultTabStop(view.map.nodes); for (const n of view.map.nodes) view.renderNode(n); };
    await view.hydrate(); view.render();
    return view;
  };
  const viewA = await open(MAP_A), viewB = await open(MAP_B);
  return { repo, app, contents, plugin, viewA, viewB, notices, ids: { top: top.id, p: p.id, q: q.id, anchor: anchor.id }, paths: { p: p.path, q: q.path } };
}

const card = { inside: true, closest: () => null };
const clipboardEvent = (data = {}) => {
  const store = new Map(Object.entries(data));
  return { target: card, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    clipboardData: { getData: type => store.get(type) ?? '', setData: (type, value) => store.set(type, value), store } };
};
const copyBranch = (h, keys) => {
  const view = h.viewA;
  view.selected = null; view.multiSelected.clear();
  for (const key of keys) view.multiSelected.add(h.ids[key]);
  const event = clipboardEvent();
  view.onClipboardEvent('copy', event);
  return event.clipboardData.store.get(MIME);
};
const pasteIntoB = (h, raw, target = 'anchor') => {
  h.viewB.selected = h.ids[target]; h.viewB.multiSelected.clear();
  const event = clipboardEvent({ [MIME]: raw });
  h.viewB.onClipboardEvent('paste', event);
  return event;
};
const under = (h, prefix) => new Map([...h.contents].filter(([path]) => path.startsWith(prefix)));
const titleOf = (h, node) => h.viewB.notes.get(node.id)?.title;

test('P6 cross-map paste: the copies live in B with their titles, parent and one history step; A is not written', async () => {
  const h = await harness();
  const raw = copyBranch(h, ['p']);
  assert.ok(raw, 'copy wrote the private format');
  const aBefore = under(h, `${TOPICS}/map-a/`);
  const mapABefore = h.contents.get(MAP_A);
  const pasted = pasteIntoB(h, raw);
  assert.equal(pasted.defaultPrevented, true);
  await until(() => h.viewB.map.nodes.length === 3); await tick(); await tick();
  const copies = h.viewB.map.nodes.filter(n => n.id !== h.ids.anchor);
  assert.equal(copies.map(n => titleOf(h, n)).sort().join(), 'P,Q');
  const pCopy = copies.find(n => titleOf(h, n) === 'P'), qCopy = copies.find(n => titleOf(h, n) === 'Q');
  assert.equal(pCopy.parentId, h.ids.anchor);
  assert.equal(qCopy.parentId, pCopy.id);
  assert.ok(pCopy.path.startsWith(`${TOPICS}/map-b/`) && qCopy.path.startsWith(`${TOPICS}/map-b/`), 'files belong to B');
  assert.equal(h.viewB.history.past.length, 1, 'one history step in B');
  assert.equal(h.viewA.history.past.length, 0, 'none in A');
  assert.equal(h.contents.get(MAP_A), mapABefore);
  assert.deepEqual(under(h, `${TOPICS}/map-a/`), aBefore, 'A files byte for byte');
  assert.equal((await h.repo.readMap(MAP_B)).nodes.length, 3, 'saved');
  assert.match(h.contents.get(pCopy.path), new RegExp(`Next: \\[\\[${qCopy.path.replace(/^.*\//, '').replace(/\.md$/, '')}\\]\\]`), 'link follows the copy of Q');
});

test('P6 counter-example: both maps have img.png, the copy in B still resolves to A\'s file', async () => {
  const h = await harness();
  const raw = copyBranch(h, ['p']);
  pasteIntoB(h, raw);
  await until(() => h.viewB.map.nodes.length === 3); await tick(); await tick();
  const qCopy = h.viewB.map.nodes.find(n => titleOf(h, n) === 'Q');
  const text = h.contents.get(qCopy.path);
  assert.ok(text.includes(`![[${TOPICS}/map-a/Attachments/img.png]]`), text);
  assert.equal(h.app.metadataCache.getFirstLinkpathDest(`${TOPICS}/map-a/Attachments/img.png`, qCopy.path).path, `${TOPICS}/map-a/Attachments/img.png`);
  assert.equal(h.contents.get(`${TOPICS}/map-a/Attachments/img.png`), 'png-map-a');
  assert.equal(h.contents.get(`${TOPICS}/map-b/Attachments/img.png`), 'png-map-b');
});

test('P6 counter-example: undo in B leaves every A file byte for byte and the A file count unchanged', async () => {
  const h = await harness();
  const raw = copyBranch(h, ['p']);
  const aBefore = under(h, `${TOPICS}/map-a/`);
  pasteIntoB(h, raw);
  await until(() => h.viewB.map.nodes.length === 3); await tick(); await tick();
  await h.viewB.travel(false); await tick();
  assert.equal(h.viewB.map.nodes.length, 1, 'undo takes the copies off B');
  const aAfter = under(h, `${TOPICS}/map-a/`);
  assert.equal(aAfter.size, aBefore.size, 'A file count');
  assert.deepEqual(aAfter, aBefore, 'A bytes');
});

test('P6 counter-example: B already has a note with the same title, the copy gets a name that does not collide', async () => {
  const h = await harness({ bHasSameTitle: true });
  const existing = h.viewB.map.nodes.find(n => n.id !== h.ids.anchor);
  const existingPath = existing.path, existingText = h.contents.get(existingPath);
  const raw = copyBranch(h, ['p']);
  pasteIntoB(h, raw);
  await until(() => h.viewB.map.nodes.length === 4); await tick(); await tick();
  const pCopy = h.viewB.map.nodes.find(n => n.id !== existing.id && titleOf(h, n) === 'P');
  assert.ok(pCopy, 'the copy exists');
  assert.notEqual(pCopy.path, existingPath);
  assert.equal(h.contents.get(existingPath), existingText, 'the existing note is untouched');
  assert.equal(new Set(h.viewB.map.nodes.map(n => n.path)).size, 4, 'every path unique');
});

test('P6 fallback: when the source map no longer has the copied topics, B builds new notes from the payload only', async () => {
  const h = await harness();
  const raw = copyBranch(h, ['p']);
  const doc = await h.repo.readMap(MAP_A);
  doc.nodes = doc.nodes.filter(n => n.id !== h.ids.q);
  await h.repo.saveMap(MAP_A, doc);
  await h.repo.rebuildDerivedData();
  const aBefore = under(h, `${TOPICS}/map-a/`);
  pasteIntoB(h, raw);
  await until(() => h.viewB.map.nodes.length === 3); await tick(); await tick();
  const pCopy = h.viewB.map.nodes.find(n => titleOf(h, n) === 'P');
  assert.ok(pCopy);
  assert.ok(!h.contents.get(pCopy.path).includes('Next: [['), 'only whitelisted fields: no link text from the source file');
  assert.deepEqual(under(h, `${TOPICS}/map-a/`), aBefore);
});
