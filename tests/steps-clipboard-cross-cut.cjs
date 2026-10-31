// 0.28 P7 (ticket 28): cutting branches in map A and pasting them into map B. B gets copies, A's originals park in
// A's Unassigned (D8), both maps change in one transaction, and undo or redo asked from either map's view runs once.
// Every counter-example here must fail when its guard is removed (mutations are listed in the handoff).
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

test('P7 cross-map cut: B gets copies, A parks the originals in its Unassigned, one history step in B, a proxy in A', async () => {
  const h = await harness();
  const aNotesBefore = [h.paths.p, h.paths.q];
  const { event } = await cutAndPaste(h);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.errors, []);
  assert.equal(h.viewB.map.nodes.length, 3);
  const copies = h.viewB.map.nodes.filter(n => n.id !== h.ids.anchor);
  assert.equal(copies.map(n => titleOf(h, h.viewB, n)).sort().join(), 'P,Q');
  const pCopy = copies.find(n => titleOf(h, h.viewB, n) === 'P'), qCopy = copies.find(n => titleOf(h, h.viewB, n) === 'Q');
  assert.equal(pCopy.parentId, h.ids.anchor);
  assert.equal(qCopy.parentId, pCopy.id);
  assert.ok(copies.every(n => n.path.startsWith(B_PREFIX)));
  assert.equal(await idsOn(h, MAP_A), [h.ids.top].sort().join(), 'A lost the branch');
  assert.equal(await idsOn(h, MAP_B), [h.ids.anchor, pCopy.id, qCopy.id].sort().join(), 'B saved');
  for (const path of aNotesBefore) assert.ok(!h.contents.has(path), `${path} left its place`);
  const parked = [...h.contents.keys()].filter(path => path.startsWith(`${A_PREFIX}Unassigned/`));
  assert.equal(parked.length, 2, 'both originals wait in A Unassigned');
  assert.equal(h.session.get(), null, 'the cut mark is gone');
  assert.equal(h.viewB.history.past.length, 1);
  assert.equal(h.viewA.history.past.length, 1, 'A cleared its history on reload, then got the proxy');
  assert.equal(h.ledger.entriesFor(MAP_A).length, 1);
  assert.equal(h.ledger.entriesFor(MAP_B)[0].status, 'applied');
});

test('P7 undo from B restores both maps; redo goes forward again', async () => {
  const h = await harness();
  const before = everything(h);
  await cutAndPaste(h);
  const after = everything(h);
  await h.viewB.travel(false); await h.idle();
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
  assert.equal(await idsOn(h, MAP_B), h.ids.anchor);
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'undone');
  assert.ok(h.contents.has(h.paths.p) && h.contents.has(h.paths.q), 'originals are back');
  assert.equal(h.contents.get(MAP_A), before.get(MAP_A), 'A Map.md as before the cut');
  await h.viewB.travel(true); await h.idle();
  assert.equal(await idsOn(h, MAP_A), h.ids.top);
  assert.equal(h.viewB.map.nodes.length, 3);
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'applied');
  assert.equal(await titlesIn(h, MAP_B), 'Anchor,P,Q');
  assert.equal(after.size, everything(h).size);
});

// ---- Counter-example 1: a failed cut leaves A byte for byte as it was -------------------------------------------------

/** A, B Map.md and the cut mark after a refused or failed paste. */
const assertCutKeptAndNothingMoved = (h, aBefore, bMapBefore, why) => {
  assertSameFiles(under(h, A_PREFIX), aBefore, `${why}: every file of A byte for byte`);
  assert.equal(h.contents.get(MAP_B), bMapBefore, `${why}: B Map.md unchanged`);
  assert.equal(h.session.get()?.mode, 'cut', `${why}: the cut mark stays so the paste can be retried`);
  assert.equal(h.ledger.entriesFor(MAP_A).length, 0, `${why}: nothing in the ledger`);
  assert.equal(h.viewB.history.past.length, 0, `${why}: no history step in B`);
};

test('P7 counter-example 1a: step 1 (duplicating the notes) fails on the second note: A is untouched', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const aBefore = under(h, A_PREFIX), bMap = h.contents.get(MAP_B);
  const writes = watchWrites(h, A_PREFIX);
  const original = h.repo.duplicateNote.bind(h.repo);
  let calls = 0;
  h.repo.duplicateNote = async (...args) => { if (++calls === 2) throw new Error('injected step 1'); return original(...args); };
  await pasteIntoB(h, raw);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /injected step 1/);
  assert.deepEqual(writes, [], 'nothing was written to A');
  assertCutKeptAndNothingMoved(h, aBefore, bMap, 'step 1');
});

test('P7 counter-example 1b: step 2 (the commit) fails while B is written: A is restored byte for byte', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const aBefore = under(h, A_PREFIX), bMap = h.contents.get(MAP_B);
  const original = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async (path, ...rest) => { if (path === MAP_B) throw new Error('injected commit failure'); return original(path, ...rest); };
  await pasteIntoB(h, raw);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /injected commit failure/);
  assertCutKeptAndNothingMoved(h, aBefore, bMap, 'commit');
});

test('P7 counter-example 1c: the conflict window of B is cancelled: nothing is written to A at all', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const aBefore = under(h, A_PREFIX), bMap = h.contents.get(MAP_B);
  const writes = watchWrites(h, A_PREFIX);
  h.viewB.resolveMapConflict = async () => { throw new Error('conflict window cancelled'); };
  await pasteIntoB(h, raw);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /conflict window cancelled/);
  assert.deepEqual(writes, [], 'A was never written, not even to be put back');
  assertCutKeptAndNothingMoved(h, aBefore, bMap, 'conflict');
});

// ---- Counter-example 2: A changed since the cut ---------------------------------------------------------------------

const lateChild = async h => {
  const doc = await h.repo.readMap(MAP_A);
  const late = await h.repo.createNote('Late', 'gpt-6-luna', doc, MAP_A, 'workspace');
  late.parentId = h.ids.q;
  doc.nodes.push(late);
  await h.repo.saveMap(MAP_A, doc);
};

test('P7 counter-example 2a: A lost a copied topic after the cut: refused before step 1, B gets no copy', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const doc = await h.repo.readMap(MAP_A);
  doc.nodes = doc.nodes.filter(n => n.id !== h.ids.q);
  await h.repo.saveMap(MAP_A, doc);
  const aBefore = under(h, A_PREFIX), bBefore = under(h, B_PREFIX), bMap = h.contents.get(MAP_B);
  await pasteIntoB(h, raw);
  assert.match(h.notices.at(-1), /changed since the cut/);
  assert.deepEqual(under(h, A_PREFIX), aBefore);
  assert.deepEqual(under(h, B_PREFIX), bBefore, 'no copy was even made in B');
  assert.equal(h.contents.get(MAP_B), bMap);
  assert.equal(h.session.get()?.mode, 'cut');
});

test('P7 counter-example 2b: A gets a new child during step 1: refused before any write', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const bMap = h.contents.get(MAP_B);
  const raw0 = { createNote: h.repo.createNote.bind(h.repo), saveMap: h.repo.saveMap.bind(h.repo) };
  const writes = watchWrites(h, A_PREFIX);
  const original = h.repo.duplicateNote.bind(h.repo);
  let aAfter;
  h.repo.duplicateNote = async (...args) => {
    const copy = await original(...args);
    const doc = await h.repo.readMap(MAP_A);
    const late = await raw0.createNote('Late', 'gpt-6-luna', doc, MAP_A, 'workspace');
    late.parentId = h.ids.q; doc.nodes.push(late);
    await raw0.saveMap(MAP_A, doc);
    await h.repo.rebuildDerivedData();
    aAfter = under(h, A_PREFIX);
    h.repo.duplicateNote = original;
    return copy;
  };
  await pasteIntoB(h, raw);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /changed since the cut/);
  assert.deepEqual(writes, [], 'the transaction wrote nothing to A (not even a move it had to undo)');
  assertSameFiles(under(h, A_PREFIX), aAfter, 'A holds exactly what the other writer left');
  assert.equal(h.contents.get(MAP_B), bMap);
  assert.equal(h.session.get()?.mode, 'cut');
  assert.equal(h.ledger.entriesFor(MAP_A).length, 0);
});

test('P7 counter-example 2c: A changes after the early check but before the commit reads it: the edit callback refuses and A is put back', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const bMap = h.contents.get(MAP_B);
  let aAfter;
  // B is checked after A, so this runs between A's check and the commit's read of both maps.
  h.viewB.resolveMapConflict = async () => { await lateChild(h); await h.repo.rebuildDerivedData(); aAfter = under(h, A_PREFIX); return false; };
  await pasteIntoB(h, raw);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /changed since the cut/);
  // The other writer's change is kept, so the snapshot taken before the transaction cannot be written back over the
  // notes it changed: those come back with the same values (a stamp and the front matter order may differ).
  const now = under(h, A_PREFIX);
  assert.deepEqual([...now.keys()].sort(), [...aAfter.keys()].sort(), 'the same files, originals back in place');
  for (const [path, text] of aAfter) {
    if (path === MAP_A || path.endsWith('/Late.md')) assert.equal(now.get(path), text, `${path} byte for byte`);
    else assert.ok(sameApartFromStamps(now.get(path), text), `${path} has the same values`);
  }
  assert.equal(h.contents.get(MAP_B), bMap);
  assert.equal(h.session.get()?.mode, 'cut');
  assert.equal(h.ledger.entriesFor(MAP_A).length, 0);
});

// ---- Counter-example 3: pending changes of the view that shows A go out first ---------------------------------------

test('P7 counter-example 3: a pan pending in the view of A is written before A is judged, and survives the cut', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const events = [];
  const readMap = h.repo.readMap.bind(h.repo);
  h.repo.readMap = async (path, ...rest) => { if (path === MAP_A) events.push('read A'); return readMap(path, ...rest); };
  const flush = h.viewA.persistViewport.bind(h.viewA);
  h.viewA.persistViewport = async () => { events.push('flush'); return flush(); };
  h.viewA.map.viewport = { x: 55, y: 66, zoom: 1 };
  h.viewA.viewportTimer = setTimeout(() => {}, 60000);
  try {
    await pasteIntoB(h, raw);
  } finally { clearTimeout(h.viewA.viewportTimer); }
  assert.equal(h.viewA.viewportTimer, null, 'the timer was cleared');
  assert.equal(events[0], 'flush', `the flush comes before A is read for the decision: ${events.join()}`);
  assert.ok(events.includes('read A'));
  assert.deepEqual(h.errors, []);
  assert.deepEqual({ ...(await h.repo.readMap(MAP_A)).viewport }, { x: 55, y: 66, zoom: 1 }, 'the pan is in Map.md of A');
});

test('P7 counter-example 3b: a conflict window open in the view of A stops the cut', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const aBefore = under(h, A_PREFIX), bBefore = under(h, B_PREFIX);
  h.viewA.conflictOpen = true;
  await pasteIntoB(h, raw);
  assert.match(h.notices.at(-1), /conflict window/);
  assert.deepEqual(under(h, A_PREFIX), aBefore);
  assert.deepEqual(under(h, B_PREFIX), bBefore);
  assert.equal(h.session.get()?.mode, 'cut');
});

// ---- Counter-example 4: a Map.md changed outside makes undo refuse --------------------------------------------------

test('P7 counter-example 4a: A is edited outside after the cut: undo is refused and nothing at all changes', async () => {
  const h = await harness();
  await cutAndPaste(h);
  const doc = await h.repo.readMap(MAP_A);
  doc.title = 'edited outside';
  await h.repo.saveMap(MAP_A, doc);
  const all = everything(h);
  const error = await rejection(h.viewB.travel(false));
  assert.match(error.message, /touched two maps/);
  assertSameFiles(everything(h), all, 'both Map.md files and every note byte for byte');
  assert.equal(h.viewB.history.canUndo, true, 'the step stays available');
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'applied');
});

test('P7 counter-example 4b: B is edited outside, B reloads, undo from the restored proxy is refused and nothing changes', async () => {
  const h = await harness();
  await cutAndPaste(h);
  const doc = await h.repo.readMap(MAP_B);
  doc.title = 'edited outside';
  await h.repo.saveMap(MAP_B, doc);
  await h.viewB.synchronize();
  assert.equal(h.viewB.history.canUndo, true, 'the reload put the proxy back');
  const all = everything(h);
  const error = await rejection(h.viewB.travel(false));
  assert.match(error.message, /touched two maps/);
  assertSameFiles(everything(h), all, 'nothing changed');
  assert.equal(h.ledger.entriesFor(MAP_B)[0].status, 'applied');
});

// ---- Counter-example 5: switching maps and back ----------------------------------------------------------------------

test('P7 counter-example 5: after leaving B for another map and coming back, undo works and so does redo', async () => {
  const h = await harness();
  await cutAndPaste(h);
  await h.viewB.openMap(MAP_C);
  assert.equal(h.viewB.history.canUndo, false, 'map C has no such step');
  await h.viewB.openMap(MAP_B);
  assert.equal(h.viewB.history.canUndo, true, 'the proxy is back');
  await h.viewB.travel(false); await h.idle();
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
  assert.equal(await idsOn(h, MAP_B), h.ids.anchor);
  assert.equal(h.viewB.history.canRedo, true);
  await h.viewB.travel(true); await h.idle();
  assert.equal(await idsOn(h, MAP_A), h.ids.top);
  assert.equal(await titlesIn(h, MAP_B), 'Anchor,P,Q');
  assert.deepEqual(h.errors, []);
});

// ---- Counter-example 6: two views, one execution ---------------------------------------------------------------------

const countWrites = h => {
  const counts = { A: 0, B: 0 };
  const original = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async (path, ...rest) => { if (path === MAP_A) counts.A++; if (path === MAP_B) counts.B++; return original(path, ...rest); };
  return counts;
};

test('P7 counter-example 6a: both views press undo one after the other: it runs once and the second is a quiet no-op', async () => {
  const h = await harness();
  await cutAndPaste(h);
  assert.equal(h.viewA.history.canUndo, true);
  // A has not reloaded yet (no write queue step between the two presses), so its own conflict check must not interfere.
  h.viewA.resolveMapConflict = async () => false;
  const counts = countWrites(h);
  await h.viewB.travel(false);
  await h.viewA.travel(false);
  assert.deepEqual(counts, { A: 1, B: 1 }, 'each map was written once');
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'undone');
  assert.equal(await idsOn(h, MAP_A), [h.ids.top, h.ids.p, h.ids.q].sort().join());
  assert.equal(h.viewA.history.canUndo, false, 'the proxy of A is gone');
});

test('P7 counter-example 6b: both views press undo at the same moment: it runs once', async () => {
  const h = await harness();
  await cutAndPaste(h);
  h.viewA.resolveMapConflict = async () => false;
  const counts = countWrites(h);
  await Promise.all([h.viewB.travel(false), h.viewA.travel(false)]);
  assert.deepEqual(counts, { A: 1, B: 1 });
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'undone');
});

// ---- Counter-example 7: a failed rollback breaks the entry -------------------------------------------------------------

test('P7 counter-example 7: undo fails and cannot be rolled back: the entry is broken and refuses every further undo', async () => {
  const h = await harness();
  await cutAndPaste(h);
  const original = h.repo.saveMap.bind(h.repo);
  let writesToA = 0;
  h.repo.saveMap = async (path, ...rest) => {
    if (path === MAP_B) throw new Error('injected: B cannot be written');
    if (path === MAP_A && ++writesToA >= 2) throw new Error('injected: A cannot be put back');
    return original(path, ...rest);
  };
  const first = await rejection(h.viewB.travel(false));
  assert.equal(first.kind, 'rollback-failed');
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'broken');
  const calls = writesToA;
  const second = await rejection(h.viewB.travel(false));
  assert.match(second.message, /could not be fully restored|rollback/i);
  assert.equal(writesToA, calls, 'a broken entry writes nothing');
  assert.equal(h.ledger.entriesFor(MAP_A)[0].status, 'broken');
});

test('P7 counter-example 1d: a note edited while the commit rolls back is never overwritten by the exact-bytes restore', async () => {
  const h = await harness();
  const raw = cutInA(h, ['p']);
  const original = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async (path, ...rest) => {
    if (path === MAP_B) {
      const parked = [...h.contents.keys()].find(file => file.startsWith(`${A_PREFIX}Unassigned/`) && file.endsWith('/Q.md'));
      assert.ok(parked, 'Q is parked in A Unassigned when the commit fails');
      h.contents.set(parked, `${h.contents.get(parked)}\nWritten by someone else.\n`);
      throw new Error('injected commit failure');
    }
    return original(path, ...rest);
  };
  await pasteIntoB(h, raw);
  assert.equal(h.errors.length, 1);
  assert.ok(h.contents.get(h.paths.q).includes('Written by someone else.'), 'the edit survives the rollback');
  assert.ok(h.contents.has(h.paths.p) && h.contents.has(h.paths.q), 'both originals are back in A');
});

test('P7 pure checks: what stops a cut at the source, and what counts as the same note apart from its stamp', () => {
  const node = (id, parentId, extra = {}) => ({ id, parentId, ...extra });
  const record = { sourceMapId: 'm', nodeIds: ['p', 'q'] };
  const map = (nodes, extra = {}) => ({ id: 'm', nodes, ...extra });
  const base = [node('top', null), node('p', 'top'), node('q', 'p')];
  const found = { branch: [base[1], base[2]] };
  assert.equal(cutSourceProblem(map(base), record, found), null);
  assert.equal(cutSourceProblem(map(base, { aim: {} }), record, found), 'aim');
  assert.equal(cutSourceProblem(map([...base, node('late', 'q')]), record, found), 'changed', 'a new child would be cut off from its parent');
  assert.equal(cutSourceProblem(map(base), record, null), 'changed');
  assert.equal(cutSourceProblem(map([node('top', null)]), record, null), 'gone');
  assert.equal(cutSourceProblem({ id: 'other', nodes: base }, record, found), 'gone');
  assert.equal(cutSourceProblem(map(base), record, { branch: [node('p', 'top', { aimKind: 'question' }), base[2]] }), 'aim');
  const note = (lines, body = 'text\n') => `---\n${lines.join('\n')}\n---\n${body}`;
  assert.equal(sameApartFromStamps(note(['a: 1', 'b: 2']), note(['b: 2', 'updated: now', 'a: 1'])), true);
  assert.equal(sameApartFromStamps(note(['a: 1']), note(['a: 2'])), false);
  assert.equal(sameApartFromStamps(note(['a: 1'], 'one'), note(['a: 1'], 'two')), false);
  assert.equal(sameApartFromStamps('no front matter', 'no front matter'), false);
});
