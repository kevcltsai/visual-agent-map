// Opening another map draws its cards before the notes are read (grey bars for the summaries), reads on in the queue,
// writes nothing until the last note is read, and ends with the same state a one-shot open leaves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-o/Map.md`;
const FRAME_MS = 150;

// A fake clock and animation-frame queue the view reaches through `window` (support.cjs puts windowValues on it).
const clock = { timers: [], raf: [], next: 1 };
const resetClock = () => { clock.timers = []; clock.raf = []; };
const windowValues = {
  createFragment: dom.createFragment,
  setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.push({ id, fn, ms }); return id; },
  clearTimeout: id => { clock.timers = clock.timers.filter(timer => timer.id !== id); },
  requestAnimationFrame: fn => { const id = clock.next++; clock.raf.push({ id, fn }); return id; },
  cancelAnimationFrame: id => { clock.raf = clock.raf.filter(frame => frame.id !== id); },
  activeDocument: { activeElement: null },
  createSvg: tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } })
};
const MODULES = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice([]) } }, windowValues);
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;
const frameTimers = () => clock.timers.filter(timer => timer.ms === FRAME_MS);
const fireFrame = () => { const due = frameTimers(); clock.timers = clock.timers.filter(timer => timer.ms !== FRAME_MS); for (const timer of due) timer.fn(); };
const flushRaf = () => { const due = clock.raf; clock.raf = []; for (const frame of due) frame.fn(); };
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };

// A DOM stand-in just big enough for renderNode: cards are plain objects.
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, hasClass(name) { return this.classes.has(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; } });
// A card is rebuilt with replaceWith: the new one (appended last by createDiv) takes the old one's place.
make.replace = (old, fresh) => { const siblings = old.parent.children; const at = siblings.indexOf(old); siblings.splice(siblings.indexOf(fresh), 1); siblings.splice(at, 1, fresh); old.isConnected = false; };
const wrapReplace = el => { el.replaceWith = function (fresh) { make.replace(this, fresh); }; return el; };
const findAll = (el, test, out = []) => { if (test(el)) out.push(el); for (const child of el.children ?? []) findAll(child, test, out); return out; };
const hasCls = cls => el => el.classes?.has(cls);
const textOf = el => [el.text ?? '', ...(el.children ?? []).map(textOf)].join(' ');

async function harness({ count = 3, running = [], gate = true, heights = 100 } = {}) {
  resetClock();
  const { repo, app } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-o', title: 'O', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-o`);
  await app.vault.create(MAP, core.serializeMap(doc));
  for (let i = 0; i < count; i++) {
    const n = await repo.createNote(`Topic ${i}`, 'gpt-6-luna', doc, MAP, 'workspace');
    await repo.updateNote(n.path, { summary: `Summary ${i}`, detail: `Detail ${i}`, status: running.includes(i) ? 'running' : 'idea' });
    Object.assign(n, { x: 0, y: i * 60 });
    doc.nodes.push(n);
  }
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  const nodes = doc.nodes;
  // Titles the metadata cache knows before the note is read: a level-1 heading, a frontmatter title, nothing (file name).
  const caches = { [nodes[0]?.path]: { headings: [{ level: 2, heading: 'Not this' }, { level: 1, heading: 'Heading Zero' }], frontmatter: { title: 'Ignored' } }, [nodes[1]?.path]: { frontmatter: { title: 'FM One' } } };
  const cache = app.metadataCache ?? (app.metadataCache = {});
  const baseCache = cache.getFileCache?.bind(cache);
  cache.getFileCache = file => caches[file.path] ?? baseCache?.(file) ?? null;
  // Every read waits for its own release; reads and writes are logged in order.
  const log = [], waits = new Map();
  const baseRead = repo.readNote.bind(repo);
  const reads = [];
  repo.readNote = async (path, ...rest) => {
    reads.push(path);
    if (gate) { if (!waits.has(path)) { let release; const promise = new Promise(resolve => (release = resolve)); waits.set(path, { promise, release }); } await waits.get(path).promise; }
    log.push(`read:${path}`);
    return baseRead(path, ...rest);
  };
  const release = (...indexes) => { for (const i of indexes) { const key = nodes[i].path; if (!waits.has(key)) { let r; const promise = new Promise(resolve => (r = resolve)); waits.set(key, { promise, release: r }); } waits.get(key).release(); } };
  const writes = [];
  for (const host of [app.vault, app.vault.adapter]) for (const name of ['modify', 'create', 'process', 'append', 'delete', 'rename', 'trash', 'write', 'writeBinary', 'remove'])
    if (typeof host?.[name] === 'function') { const base = host[name].bind(host); host[name] = (...args) => { writes.push(name); return base(...args); }; }
  const marks = [];
  const baseMark = repo.markInterruptedRun.bind(repo);
  repo.markInterruptedRun = async (...args) => { marks.push(args[0]); log.push(`mark:${args[0]}`); return baseMark(...args); };
  let chain = Promise.resolve(), mutateCalls = 0;
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), pendingSuggestions: new Map(),
    releaseOutline() {}, setOutlineActive() {}, detailsShown: () => true, closeStaleDetails() {}, releaseWarmClaude() {}, syncOutline() {},
    mutate: work => { mutateCalls++; return (chain = chain.then(work)); }
  });
  plugin.isNoteTaskBusy = p => Plugin.prototype.isNoteTaskBusy.call(plugin, p);
  const view = new VisualAgentMapView({ app }, plugin);
  const stage = wrapReplace(make('div'));
  Object.assign(view, { contentEl: dom.element('div'), stageEl: stage });
  view.app.workspace = { requestSaveLayout() {} };
  const wrapDiv = el => { const base = el.createEl.bind(el); el.createEl = (name, value) => wrapReplace(base(name, value)); return el; };
  wrapDiv(stage);
  view.hiddenTab = () => false;
  view.cardHeightOf = () => 180;
  let edgeDraws = 0, opened = 0, menus = 0;
  view.drawEdges = () => { edgeDraws++; };
  view.openDetails = () => { opened++; };
  view.newMenu = () => { menus++; return { addItem() { return this; }, addSeparator() { return this; }, showAtMouseEvent() { return this; }, showAtPosition() { return this; } }; };
  view.renders = [];
  const cards = () => stage.children.filter(c => c.dataset?.nodeId);
  const snapshot = () => cards().map(c => ({ id: c.dataset.nodeId, loading: c.classes.has('vam-node-loading'), status: c.dataset.status, text: textOf(c) }));
  let heightNow = heights;
  const setHeights = value => { heightNow = value; for (const c of cards()) c.offsetHeight = value; };
  view.render = () => {
    view.paintCount++;
    stage.children = []; view.cardEls.clear();
    const shown = view.canvasNodes();
    view.selection.resetTabStop(shown.map(node => ({ id: node.id, parentId: node.parentId ?? null })));
    for (const node of shown) view.renderNode(node);
    for (const c of cards()) c.offsetHeight = heightNow;
    view.renders.push(snapshot());
    view.lockWhileLoading();
    view.settleCardHeights();
  };
  const open = () => { chain = chain.then(() => view.openMapInMutation(MAP)); return chain; };
  return { repo, app, plugin, view, nodes, doc, open, release, log, reads, writes, marks, snapshot, cards, setHeights, stage,
    mutateCalls: () => mutateCalls, edgeDraws: () => edgeDraws, opened: () => opened, menus: () => menus, chainDone: () => chain };
}
const flush = async () => { await tick(); flushRaf(); await tick(); };

test('a: no frame before the delay; then unread cards are grey placeholders titled from the cache or the file name', async () => {
  const h = await harness();
  const done = h.open();
  await tick();
  assert.equal(h.view.renders.length, 0, 'nothing is drawn before the delay');
  assert.equal(frameTimers().length, 1, 'one delayed frame is waiting');
  fireFrame();
  assert.equal(h.view.renders.length, 1);
  const frame = h.cards();
  assert.equal(frame.length, 3);
  for (const card of frame) {
    assert.ok(card.classes.has('vam-node-loading'));
    assert.equal(card.attrs['aria-busy'], 'true');
    const bars = findAll(card, hasCls('vam-card-loading-bars'));
    assert.equal(bars.length, 1);
    assert.equal(bars[0].attrs['aria-hidden'], 'true');
    assert.equal(findAll(bars[0], hasCls('vam-loading-bar')).length, 2);
    assert.notEqual(card.dataset.status, 'error');
    assert.equal(findAll(card, hasCls('vam-status')).length, 0, 'no status chip, no "note missing"');
    assert.doesNotMatch(textOf(card), /moved or deleted|missing/i);
  }
  const titles = frame.map(c => findAll(c, hasCls('vam-card-title'))[0].text);
  assert.deepEqual(titles, ['Heading Zero', 'FM One', h.nodes[2].path.split('/').pop().replace(/\.md$/, '')]);
  h.release(0, 1, 2);
  await done;
});

test('b: a note arriving rebuilds only its own card in place; the lines are drawn once per batch; read counts follow', async () => {
  const h = await harness({ count: 4 });
  const done = h.open();
  await tick(); fireFrame();
  const before = h.cards();
  const draws = h.edgeDraws();
  h.release(1);
  await flush();
  assert.equal(h.view.renders.length, 1, 'no full repaint');
  const after = h.cards();
  assert.equal(after[0], before[0]); assert.equal(after[2], before[2]); assert.equal(after[3], before[3]);
  assert.notEqual(after[1], before[1], 'card 1 was rebuilt');
  assert.equal(after[1].classes.has('vam-node-loading'), false);
  assert.equal(findAll(after[1], hasCls('vam-card-title'))[0].text, 'Topic 1');
  assert.match(textOf(after[1]), /Summary 1/);
  assert.equal(h.edgeDraws(), draws + 1);
  assert.equal(h.view.noteLoad.read, 1);
  h.release(0, 2);
  await flush();
  assert.equal(h.edgeDraws(), draws + 2, 'two notes in one frame batch redraw the lines once');
  assert.equal(h.cards().filter(c => c.classes.has('vam-node-loading')).length, 1);
  assert.equal(h.view.noteLoad.read, 3);
  h.release(3);
  await done;
});

test('c: nothing is written before the last note is read (settle, cover resize, drop, interrupted-run mark)', async () => {
  const h = await harness({ running: [2] });
  const done = h.open();
  await tick(); fireFrame();
  h.release(0, 1);
  await flush();
  // Cards grow and overlap while the notes are still being read: nothing may tidy or save.
  h.setHeights(300);
  h.view.afterCoverSized(h.cards()[0]);
  h.view.settleCardHeights();
  h.view.enqueueDrop(async () => { h.writes.push('drop'); });
  await tick();
  assert.deepEqual(h.writes, []);
  assert.equal(h.mutateCalls(), 1, 'only the fenced drop waits in the queue; settling queued no tidy');
  assert.deepEqual(h.marks, [], 'the interrupted run is marked only after every read');
  assert.equal(h.view.heightsSeenMap, null, 'heights are not recorded while reading');
  h.release(2);
  await done;
  const lastRead = Math.max(...h.nodes.map(n => h.log.indexOf(`read:${n.path}`))), mark = h.log.indexOf(`mark:${h.nodes[2].path}`);
  assert.ok(lastRead >= 0 && mark > lastRead, `mark after the last read: ${h.log.join(' | ')}`);
  assert.equal(h.view.heightsSeenMap, h.doc.id);
});

test('d: while reading, the edit switches are off and edit keys, menus, details and chat do nothing', async () => {
  const h = await harness();
  const done = h.open();
  await tick(); fireFrame();
  const { view } = h;
  assert.equal(view.cardTextEditable(), false);
  assert.equal(view.canEditSummary(), false);
  assert.equal(view.canEditCanvasItems(), false);
  assert.equal(view.canPresent(), false);
  let ran = 0;
  view.whenEditing(() => { ran++; });
  assert.equal(ran, 0);
  const card = h.cards()[0];
  const key = (name, extra = {}) => card.handlers.get('keydown')({ target: card, key: name, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra });
  key('Delete'); key('Backspace'); key('Enter', { ctrlKey: true }); key('Enter', { shiftKey: true }); key('ArrowDown', { altKey: true });
  key('Enter');
  card.handlers.get('click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  view.onCanvasContextMenu({ target: { closest: sel => (sel === '.vam-node' ? card : null) }, preventDefault() {}, clientX: 1, clientY: 1 });
  let draftRead = false;
  view.chat = { isBusy: false, get draft() { draftRead = true; return 'hello'; } };
  await view.sendMapChat();
  assert.equal(draftRead, false, 'the chat message is not even read');
  assert.equal(view.searchKey({ isComposing: false, defaultPrevented: false }), false, 'Mod+F is swallowed');
  assert.equal(view.mapSearch, null);
  await tick();
  assert.equal(h.mutateCalls(), 0);
  assert.equal(h.opened(), 0, 'no details sidebar for a card that is not read');
  assert.equal(h.menus(), 0);
  h.release(0, 1, 2);
  await done;
  assert.equal(view.canEditSummary(), true);
  assert.equal(view.canEditCanvasItems(), true);
  assert.equal(view.cardTextEditable(), true);
});

test('e: after the last note the loading state is gone, one full render follows, and the first look only records heights', async () => {
  const h = await harness();
  const done = h.open();
  await tick(); fireFrame();
  assert.equal(h.view.heightsSeenMap, null);
  h.release(0, 1, 2);
  await flush();
  // The cards were first drawn short (grey bars) and end up tall and overlapping: opening still moves nothing.
  h.setHeights(300);
  await done;
  assert.equal(h.view.noteLoad, null);
  assert.equal(h.view.renders.length, 2, 'one frame and one final render');
  assert.equal(h.view.renders[1].some(c => c.loading), false);
  assert.equal(h.view.heightsSeenMap, h.doc.id);
  assert.equal(h.view.heightsSeen.size, 3);
  assert.equal(h.mutateCalls(), 0, 'no tidy for a map that was just opened');
  assert.deepEqual(h.writes, []);
  assert.equal(h.view.notes.size, 3);
  assert.equal(h.view.canEditSummary(), true);
  assert.equal(frameTimers().length, 0); assert.equal(clock.raf.length, 0);
});

test('f: closing the view while reading: no card, no render, no new read, no timer', async () => {
  const h = await harness({ count: 10 });
  const done = h.open();
  await tick();
  assert.equal(h.reads.length, 8, 'eight reads in flight');
  h.view.closed = true; h.view.aimViewEpoch++; h.view.mapOpenEpoch++; h.view.endNoteLoad();
  assert.equal(frameTimers().length, 0, 'the delayed frame was cancelled');
  fireFrame();
  h.release(...h.nodes.keys());
  await done;
  flushRaf();
  assert.equal(h.reads.length, 8, 'no further note is read');
  assert.equal(h.view.renders.length, 0);
  assert.deepEqual(h.writes, []);
  assert.equal(h.view.noteLoad, null);
});

test('f2: a frame batch queued before the close does nothing after it', async () => {
  const h = await harness();
  const done = h.open();
  await tick(); fireFrame();
  h.release(0);
  await tick();
  assert.equal(clock.raf.length, 1);
  const rebuilt = h.cards()[0];
  h.view.closed = true; h.view.mapOpenEpoch++; h.view.endNoteLoad();
  flushRaf();
  assert.equal(h.cards()[0], rebuilt);
  h.release(1, 2);
  await done;
});

test('g: opening the map that is already on screen keeps its cards and does not use the loading frame', async () => {
  const h = await harness({ gate: false });
  await h.open();
  assert.equal(h.view.renders.length, 1);
  const notes = h.view.notes;
  const gated = await harness();
  gated.view.paintCount = 1; gated.view.path = MAP; gated.view.notes = notes;
  const done = gated.open();
  await tick();
  assert.equal(gated.view.noteLoad, null);
  assert.equal(frameTimers().length, 0);
  assert.equal(gated.view.notes, notes, 'the cards stay until the read ends');
  gated.release(0, 1, 2);
  await done;
  assert.equal(gated.view.renders.length, 1);
});

test('h: a note left at running is a grey placeholder in every frame, never "AI running"', async () => {
  const h = await harness({ running: [1] });
  const done = h.open();
  await tick(); fireFrame();
  const seen = [...h.snapshot()];
  h.release(1);
  await flush();
  seen.push(...h.snapshot());
  const runningCard = h.snapshot()[1];
  assert.equal(runningCard.loading, true, 'still a placeholder although its note is read');
  h.release(0, 2);
  await flush();
  seen.push(...h.snapshot());
  for (const card of seen) {
    assert.notEqual(card.status, 'running');
    assert.doesNotMatch(card.text, /AI running/i);
  }
  await done;
  seen.push(...h.view.renders.flat());
  for (const card of seen) assert.notEqual(card.status, 'running');
  assert.equal(h.view.notes.get(h.nodes[1].id).status, 'error');
  assert.equal(h.view.renders.at(-1)[1].status, 'error');
});

test('i: a fast read draws once, as before, and leaves no timer or frame behind', async () => {
  const h = await harness({ gate: false });
  await h.open();
  assert.equal(h.view.renders.length, 1);
  assert.equal(frameTimers().length, 0);
  assert.equal(clock.raf.length, 0);
  assert.equal(h.view.noteLoad, null);
  assert.equal(h.view.renders[0].some(c => c.loading), false);
});

test('j: a card dropped while reading is written after the read, unless the view was closed or moved to another map', async () => {
  const closed = await harness();
  let ran = 0;
  const done = closed.open();
  await tick(); fireFrame();
  closed.view.enqueueDrop(async () => { ran++; });
  closed.release(0, 1, 2);
  closed.view.closed = true; closed.view.mapOpenEpoch++;
  await done;
  await closed.chainDone();
  assert.equal(ran, 0, 'closed: not written');
  const live = await harness();
  const done2 = live.open();
  await tick(); fireFrame();
  live.view.enqueueDrop(async () => { ran++; });
  assert.equal(ran, 0, 'waits for the read');
  live.release(0, 1, 2);
  await done2;
  await live.chainDone();
  assert.equal(ran, 1, 'still the same map: written once the read has ended');
  const other = await harness();
  const done3 = other.open();
  await tick(); fireFrame();
  other.view.enqueueDrop(async () => { ran++; });
  other.view.path = 'Agent Workspace/Topics/other/Map.md';
  other.release(0, 1, 2);
  await done3;
  await other.chainDone();
  assert.equal(ran, 1, 'another map: not written');
});

test('k: a failing read ends the loading state, draws what is known and passes the error on', async () => {
  const h = await harness();
  h.view.hydrate = async () => { throw new Error('boom'); };
  const done = h.open();
  await assert.rejects(done, /boom/);
  assert.equal(h.view.noteLoad, null);
  assert.equal(frameTimers().length, 0);
  assert.equal(h.view.renders.length, 1, 'the map is drawn once, not left half read');
});

test('l: the previous map\'s goal, sources and failed reports are gone before the first frame', async () => {
  const h = await harness();
  Object.assign(h.view, { relevanceGoal: 'old goal', relevanceContext: 'old context', mapSources: [{ id: 'x' }], path: 'Agent Workspace/Topics/other/Map.md' });
  h.view.aimFailedReports.set('q', { path: 'p' });
  const done = h.open();
  await tick(); fireFrame();
  assert.equal(h.view.relevanceGoal, undefined);
  assert.equal(h.view.relevanceContext, undefined);
  assert.equal(h.view.mapSources.length, 0);
  assert.equal(h.view.aimFailedReports.size, 0);
  h.release(0, 1, 2);
  await done;
});

test('m: wiring: the outline waits, settle returns first, the open clears its state in finally, onClose cancels it', () => {
  const source = fs.readFileSync(nodePath.join(__dirname, '..', 'experiences', 'visual-map', 'view.ts'), 'utf8');
  assert.match(source, /if \(!this\.noteLoad\) this\.plugin\.syncOutline\(this\.map, this\.notes, this\);/);
  const settle = source.slice(source.indexOf('private settleCardHeights('));
  assert.ok(settle.indexOf('if (this.noteLoad) return;') > 0 && settle.indexOf('if (this.noteLoad) return;') < settle.indexOf('const now = new Map'));
  const open = source.slice(source.indexOf('private async openMapInMutation('), source.indexOf('private async recoverInterruptedNotes('));
  assert.ok(open.indexOf('await this.hydrate(') < open.indexOf('await this.recoverInterruptedNotes(isCurrent)'));
  assert.ok(open.indexOf('await this.recoverInterruptedNotes(isCurrent)') < open.indexOf('this.endNoteLoad(load);\n      this.render();'));
  assert.match(open, /finally \{\s*this\.endNoteLoad\(load\);\s*\}/);
  const close = source.slice(source.indexOf('async onClose('), source.indexOf('async onClose(') + 5000);
  assert.match(close, /this\.mapOpenEpoch\+\+;\s*this\.endNoteLoad\(\);/);
});
