// F-3 (ticket 28, decisions #31/#35): cross-map undo/redo refuses when a Map.md's node coordinates are not the ones
// this plugin last wrote there. Coordinates written by the plugin itself (drag, auto layout, undo, redo) never count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, tick } = dom;
const nodePath = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('./build.cjs');

// One bundle that holds the view, the session and the ledger, so the test reads the same module state the view uses
// (a separate load of those modules would get its own, empty WeakMaps). Same sandbox as support.cjs's load().
function loadWithState(overrides, windowValues) {
  const root = nodePath.resolve(__dirname, '..');
  const contents = "export * from './main'; export { ledgerFor } from './experiences/visual-map/cross-map-history'; export { sessionFor } from './experiences/visual-map/clipboard-session';";
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: 'cross-cut-entry.ts' }, external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  const ob = { Component: class {}, MarkdownRenderChild: class {}, ...overrides.obsidian };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => (name === 'obsidian' ? ob : require(name)), console, TextDecoder, TextEncoder, Blob, crypto: require('node:crypto').webcrypto, process, AbortController, document: windowValues.document, createSvg: windowValues.createSvg,
    Option: class { constructor(text, value) { this.tag = 'option'; this.text = text; this.value = value; this.cls = ''; this.children = []; this.attrs = {}; } }, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, window: { setTimeout, clearTimeout, ...windowValues } });
  return module.exports;
}

const MIME = 'application/x-vam-branch';
const TOPICS = 'Agent Workspace/Topics';
const MAP_A = `${TOPICS}/map-a/Map.md`, MAP_B = `${TOPICS}/map-b/Map.md`, MAP_C = `${TOPICS}/map-c/Map.md`;
const A_PREFIX = `${TOPICS}/map-a/`, B_PREFIX = `${TOPICS}/map-b/`;

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


async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  app.metadataCache.getFirstLinkpathDest = (linkPath, fromPath) => {
    const path = resolverFor(() => [...contents.keys()])(linkPath, fromPath);
    return path === undefined ? null : app.vault.getAbstractFileByPath(path);
  };
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const docs = {};
  for (const [id, path] of [['map-a', MAP_A], ['map-b', MAP_B], ['map-c', MAP_C]]) {
    docs[id] = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders(`${TOPICS}/${id}`);
    await app.vault.create(path, core.serializeMap(docs[id]));
  }
  const a = docs['map-a'], b = docs['map-b'];
  const top = await repo.createNote('Top', 'gpt-6-luna', a, MAP_A, 'workspace');
  const p = await repo.createNote('P', 'gpt-6-luna', a, MAP_A, 'workspace', { detail: 'P detail' });
  const q = await repo.createNote('Q', 'gpt-6-luna', a, MAP_A, 'workspace');
  p.parentId = top.id; q.parentId = p.id; p.x = 400; q.x = 700;
  a.nodes.push(top, p, q);
  await repo.saveMap(MAP_A, a);
  contents.set(p.path, `${contents.get(p.path)}\nNext: [[Q]]\n`);
  const anchor = await repo.createNote('Anchor', 'gpt-6-luna', b, MAP_B, 'workspace');
  b.nodes.push(anchor);
  await repo.saveMap(MAP_B, b);
  await repo.rebuildDerivedData();
  const notices = [];
  const Notice = dom.makeNotice(notices);
  const bundle = loadWithState({ obsidian: { ...obsidian, Notice, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment });
  const { VisualAgentMapView } = bundle;
  app.workspace = { ...app.workspace, requestSaveLayout() {} };
  const h = { repo, app, contents, notices, errors: [], views: [], ids: { top: top.id, p: p.id, q: q.id, anchor: anchor.id }, paths: { top: top.path, p: p.path, q: q.path, anchor: anchor.path } };
  // Like the real plugin: writes run one after another, and every view re-reads when the queue step ends.
  let queue = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    closeStaleDetails() {}, syncOutline() {}, views: () => h.views,
    mutate(work) {
      const result = queue.then(async () => { await work(); for (const view of h.views) await view.synchronize(); });
      queue = result.catch(error => { h.errors.push(error); });
      return result;
    }
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
  h.plugin = plugin; h.session = bundle.sessionFor(plugin); h.ledger = bundle.ledgerFor(plugin);
  h.viewA = await open(MAP_A); h.viewB = await open(MAP_B);
  h.views = [h.viewA, h.viewB];
  h.idle = async () => { for (let i = 0; i < 3; i++) { await queue; await tick(); } };
  return h;
}

const card = { inside: true, closest: () => null };
const clipboardEvent = (data = {}) => {
  const store = new Map(Object.entries(data));
  return { target: card, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    clipboardData: { getData: type => store.get(type) ?? '', setData: (type, value) => store.set(type, value), store } };
};
const cutInA = (h, keys) => {
  const view = h.viewA;
  view.selected = null; view.multiSelected.clear();
  for (const key of keys) view.multiSelected.add(h.ids[key]);
  const event = clipboardEvent();
  view.onClipboardEvent('cut', event);
  return event.clipboardData.store.get(MIME);
};
const pasteIntoB = async (h, raw, target = 'anchor') => {
  h.viewB.selected = h.ids[target]; h.viewB.multiSelected.clear();
  const event = clipboardEvent({ [MIME]: raw });
  h.viewB.onClipboardEvent('paste', event);
  await h.idle();
  return event;
};
const under = (h, prefix) => new Map([...h.contents].filter(([path]) => path.startsWith(prefix)));
const everything = h => new Map(h.contents);
const titleOf = (h, view, node) => view.notes.get(node.id)?.title;
const titlesIn = async (h, path) => { const map = await h.repo.readMap(path); return Promise.all(map.nodes.map(async n => (await h.repo.readNote(n.path)).title)).then(list => list.sort().join()); };
/** The mapA.nodes saved on disk: ids that are still in Map.md. */
const idsOn = async (h, path) => (await h.repo.readMap(path)).nodes.map(n => n.id).sort().join();
/** Records every write the repository is asked to make to maps in `prefix`; returns the log. */
const watchWrites = (h, prefix) => {
  const log = [];
  for (const name of ['moveUnique', 'moveExact', 'setLifecycle', 'saveMap']) {
    const original = h.repo[name].bind(h.repo);
    h.repo[name] = async (...args) => { if (typeof args[0] === 'string' && args[0].startsWith(prefix)) log.push(`${name} ${args[0]}`); return original(...args); };
  }
  return log;
};
/** Byte-for-byte comparison of two file maps; the failure names each differing file and its first differing line. */
const assertSameFiles = (actual, expected, why) => {
  const problems = [];
  for (const path of new Set([...actual.keys(), ...expected.keys()])) {
    if (!actual.has(path)) problems.push(`missing: ${path}`);
    else if (!expected.has(path)) problems.push(`extra: ${path}`);
    else if (actual.get(path) !== expected.get(path)) {
      const a = actual.get(path).split('\n'), e = expected.get(path).split('\n');
      const at = a.findIndex((line, i) => line !== e[i]);
      problems.push(`differs: ${path} line ${at}: ${JSON.stringify(a[at])} vs ${JSON.stringify(e[at])}`);
    }
  }
  assert.deepEqual(problems, [], why);
};
const { sameApartFromStamps, cutSourceProblem } = load('experiences/visual-map/cross-map-history.ts', { obsidian });
const rejection = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };

const cutAndPaste = async (h, keys = ['p']) => {
  const raw = cutInA(h, keys);
  assert.ok(raw, 'cut wrote the private format');
  assert.equal(h.session.get()?.mode, 'cut');
  return { raw, event: await pasteIntoB(h, raw) };
};


/** Like another program: changes Map.md through the raw vault, so the repository does not learn of it. */
const outside = async (h, path, change) => {
  await h.app.vault.process(h.repo.file(path), content => {
    const match = content.match(/```agent-map\s*\n([\s\S]*?)\n```/);
    const doc = JSON.parse(match[1]);
    change(doc);
    return content.replace(match[1], () => JSON.stringify(doc, null, 2));
  });
};
const refused = async h => {
  const all = everything(h);
  const error = await rejection(h.viewB.travel(false));
  assert.match(error.message, /touched two maps/);
  assertSameFiles(everything(h), all, 'both Map.md files and every note byte for byte');
  assert.equal(h.viewB.history.canUndo, true, 'the step stays available');
};
const coordsOf = async (h, path) => (await h.repo.readMap(path)).nodes.map(n => [n.id, n.x, n.y]).sort();

test('F3 1: coordinates of A changed outside: undo from B is refused, nothing changes', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await outside(h, MAP_A, doc => { doc.nodes[0].x += 7; });
  await refused(h);
});
test('F3 2: coordinates of B changed outside (B reloads first): undo is refused, nothing changes', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await outside(h, MAP_B, doc => { doc.nodes[0].y += 7; });
  await h.viewB.synchronize();
  assert.equal(h.viewB.history.canUndo, true, 'the reload put the proxy back');
  await refused(h);
});
test('F3 3: the plugin drags a card in A after the cut: undo from B is not treated as an outside change', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await h.viewA.mapChange(map => { const n = map.nodes.find(x => x.id === h.ids.top); n.x += 11; n.y += 5; });
  await h.idle();
  await h.viewB.travel(false);
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join(), 'the branch is back in A');
});
test('F3 4: an auto layout written by the plugin in A does not count as outside', async () => {
  const h = await harness();
  await cutAndPaste(h);
  const doc = await h.repo.readMap(MAP_A);
  for (const n of doc.nodes) { n.x += 40; n.y += 40; }
  await h.repo.saveMap(MAP_A, doc);
  await h.repo.updateMap(MAP_A, map => { map.nodes[0].x += 3; });
  await h.viewB.travel(false);
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
});
test('F3 5: only the viewport changed outside: undo still runs', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await outside(h, MAP_A, doc => { doc.viewport = { x: 123, y: 45, zoom: 2 }; });
  await outside(h, MAP_B, doc => { doc.viewport = { x: 9, y: 8, zoom: 1.5 }; });
  await h.viewB.travel(false);
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
});
test('F3 6: undo, then redo: redo is not treated as an outside change (undo refreshed the written coordinates)', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await h.viewB.travel(false);
  const afterUndo = await coordsOf(h, MAP_A);
  assert.equal(afterUndo.length, 3);
  await h.viewB.travel(true);
  assert.equal(await idsOn(h, MAP_A), [h.ids.top].sort().join(), 'redo cut the branch again');
  await h.viewB.travel(false);
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
});
test('F3 7: a map this plugin has not written since it started is never refused for its coordinates', async () => {
  const h = await harness();
  const fresh = new (h.repo.constructor)(h.app, h.repo.settings);
  assert.equal(await fresh.coordinatesChangedOutside(MAP_A), false);
  assert.equal(await h.repo.coordinatesChangedOutside(MAP_A), false);
  await outside(h, MAP_A, doc => { doc.nodes[0].x += 7; });
  assert.equal(await h.repo.coordinatesChangedOutside(MAP_A), true);
  assert.equal(await fresh.coordinatesChangedOutside(MAP_A), false);
});
test('F3 8: outside coordinate change, then a background updateMap that only changes state: undo is still refused', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await outside(h, MAP_A, doc => { doc.nodes[0].x += 7; });
  await h.repo.updateMap(MAP_A, map => { map.title = 'renamed in the background'; });
  assert.equal(await h.repo.coordinatesChangedOutside(MAP_A), true);
  const all = everything(h);
  const error = await rejection(h.viewB.travel(false));
  assert.match(error.message, /touched two maps/);
  assertSameFiles(everything(h), all, 'nothing changed');
});
test('F3 9: outside coordinate change, then a background saveMap of the map as read: undo is still refused', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await outside(h, MAP_B, doc => { doc.nodes[0].y += 7; });
  const doc = await h.repo.readMap(MAP_B);
  doc.title = 'saved in the background';
  await h.repo.saveMap(MAP_B, doc);
  assert.equal(await h.repo.coordinatesChangedOutside(MAP_B), true);
  await h.viewB.synchronize();
  await refused(h);
});
test('F3 10: outside coordinate change, then the plugin itself moves a node: the plugin write is the new baseline', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await outside(h, MAP_A, doc => { doc.nodes[0].x += 7; });
  await h.repo.updateMap(MAP_A, map => { map.nodes[0].x += 5; });
  assert.equal(await h.repo.coordinatesChangedOutside(MAP_A), false);
  await h.viewB.travel(false);
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
});
