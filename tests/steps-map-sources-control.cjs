// MapSourcesControl (view.ts split M): the toolbar button, panel, vault and external source changes on fake ports. No view, no vault, no AI.
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The module is loaded in its own vm realm: compare by value across realms.
const plain = value => JSON.parse(JSON.stringify(value));
const assert = Object.assign(Object.create(strict), { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');

const notices = [];
const { MapSourcesControl } = load('experiences/visual-map/map-sources-control.ts', { obsidian: { ...S.obsidian, Notice: dom.makeNotice(notices) } });
const { TFile, TFolder } = S.obsidian;

const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let i = 0; i < 200 && !check(); i++) await nap(10); };
const mk = (...parts) => { const dir = path.join(...parts); fs.mkdirSync(dir, { recursive: true }); return dir; };
function world() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-msc-')));
  const home = mk(tmp, 'home'), vault = mk(home, 'Vault'), outside = mk(home, 'ext');
  const docs = mk(outside, 'docs'); fs.writeFileSync(path.join(docs, 'a.md'), 'x'); fs.writeFileSync(path.join(docs, 'b.md'), 'y');
  return { tmp, docs, scope: { vaultBase: vault, home } };
}
const FILE = n => ({ kind: 'file', path: `Notes/${n}.md` });

function rig(extra = {}) {
  const w = world();
  const state = { closed: false, path: 'Cur/Map.md', mapId: 'm1', epoch: 1, spoken: [], placed: 0, stored: [], writes: [], reads: 0, queue: [], writeFails: false, onWrite: null, activeElement: null, buttons: [], ...extra };
  const items = new Map(['a', 'b', 'c', 'd'].map(n => [`Notes/${n}.md`, new TFile(`Notes/${n}.md`)]));
  const local = new Map();
  const app = { vault: { getAbstractFileByPath: p => items.get(p) ?? null }, metadataCache: { getFileCache: () => null },
    loadLocalStorage: key => (local.has(key) ? JSON.parse(local.get(key)) : null), saveLocalStorage: (key, data) => { if (data === null) local.delete(key); else local.set(key, JSON.stringify(data)); } };
  const listeners = [];
  const doc = { get activeElement() { return state.activeElement; },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn, capture) { const at = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture); if (at >= 0) listeners.splice(at, 1); },
    fire(type, event) { for (const l of [...listeners]) if (l.type === type) l.fn(event); } };
  const count = type => listeners.filter(l => l.type === type && l.capture === true).length;
  const ports = {
    app: () => app, closed: () => state.closed, path: () => state.path, mapId: () => state.mapId, epoch: () => state.epoch,
    repo: () => ({ readMapSources: async () => { state.reads++; if (state.onRead) await state.onRead(); return state.stored.map(s => ({ ...s })); },
      writeMapSources: async (p, next) => { if (state.writeFails) throw new Error('disk full'); state.writes.push([p, plain(next)]); state.stored = plain(next); state.onWrite?.(); },
      mapSwitcherItems: async () => state.mapItems ? state.mapItems() : [] }),
    announce: text => state.spoken.push(text), doc: () => doc, enqueue: work => state.queue.push(work),
    button: (parent, action) => { const b = parent.createEl('button', { text: '' }); b.focusCalls = 0; const focus = b.focus.bind(b); b.focus = () => { b.focusCalls++; focus(); }; b.addEventListener('click', e => { e.stopPropagation?.(); action(); }); state.buttons.push(b); return b; },
    placeTools: () => { state.placed++; }, scope: () => w.scope
  };
  const control = new MapSourcesControl('panel-1', ports);
  const tools = dom.element('tools');
  const draw = () => { tools.children = []; control.renderMapSourcesControl(tools); return tools; };
  const button = () => state.buttons.at(-1);
  const panel = () => dom.find(tools, c => c.cls === 'vam-map-sources-panel');
  const drain = async () => { while (state.queue.length) await state.queue.shift()(); };
  const badge = () => dom.find(button(), c => (c.cls ?? '').split(' ').includes('vam-sources-button-badge'));
  return { w, state, items, local, app, control, tools, draw, button, panel, drain, badge, count, doc, listeners };
}
const open = r => { r.draw(); r.button().click(); };
const withRig = fn => async () => { const r = rig(); try { await fn(r); } finally { fs.rmSync(r.w.tmp, { recursive: true, force: true }); } };
const addDocs = async r => { assert.equal(await r.control.addExternalFolder(r.state.path, r.w.docs), null); };

test('1 button paint: no sources, three, one unreadable, then fixed', withRig(r => {
  r.draw();
  assert.equal(r.button().attrs['aria-label'], 'Data sources'); assert.equal(r.badge(), undefined);
  assert.equal(dom.find(r.button(), c => c.cls === 'vam-sources-button-icon').iconName, 'files');
  r.control.loadForMap([FILE('a'), FILE('b'), FILE('c')]); r.draw();
  assert.equal(r.button().attrs['aria-label'], 'Data sources · 3'); assert.equal(r.badge().text, '3'); assert.equal(r.badge().attrs['aria-hidden'], 'true');
  r.items.delete('Notes/c.md'); r.control.refreshMapSourcesUi();
  assert.equal(r.badge().text, '!'); assert.ok(r.badge().classes.includes('is-bad')); assert.equal(r.button().attrs['aria-description'], '1 unreadable'); assert.ok(r.button().hasClass('has-unreadable'));
  r.items.set('Notes/c.md', new TFile('Notes/c.md')); r.control.refreshMapSourcesUi();
  assert.equal(r.badge().text, '3'); assert.equal(r.button().attrs['aria-description'], undefined); assert.equal(r.button().hasClass('has-unreadable'), false);
}));

test('2 open and toggle: expanded, new session, panel id equals aria-controls', withRig(r => {
  r.draw(); const before = r.control.mapSourcesSession;
  assert.equal(r.button().attrs['aria-haspopup'], 'dialog'); assert.equal(r.button().attrs['aria-expanded'], 'false');
  r.button().click();
  assert.equal(r.button().attrs['aria-expanded'], 'true'); assert.notEqual(r.control.mapSourcesSession, before);
  assert.equal(r.panel().attrs.id, r.button().attrs['aria-controls']); assert.equal(r.control.mapSourcesOpen, true);
  r.button().click();
  assert.equal(r.panel(), undefined); assert.equal(r.button().attrs['aria-expanded'], 'false'); assert.equal(r.control.mapSourcesOpen, false);
}));

test('3 focusout: inside the panel or a drag source keeps it open; outside closes without refocus; picker open keeps it', withRig(r => {
  open(r);
  r.button().fire('focusout', { relatedTarget: dom.find(r.panel(), c => c.tag === 'button') }); assert.ok(r.panel());
  const drag = dom.element('li'); drag.closest = () => ({});
  r.button().fire('focusout', { relatedTarget: drag }); assert.ok(r.panel());
  r.button().fire('focusout', { relatedTarget: r.button() }); assert.ok(r.panel());
  r.control.mapSourcesPickerOpen = true; r.button().fire('focusout', { relatedTarget: dom.element('canvas') }); assert.ok(r.panel(), 'a picker list that is open does not close it');
  r.control.mapSourcesPickerOpen = false;
  r.button().fire('focusout', { relatedTarget: dom.element('canvas') });
  assert.equal(r.panel(), undefined); assert.equal(r.button().focusCalls, 0);
}));

test('4 Escape: closes and refocuses; a replaced button does nothing', withRig(r => {
  open(r); const old = r.button();
  old.fire('keydown', { key: 'a' }); assert.ok(r.panel());
  r.draw(); assert.ok(r.panel(), 'the repaint keeps the panel open');
  old.fire('keydown', { key: 'Escape' }); old.fire('focusout', { relatedTarget: dom.element('canvas') });
  assert.ok(r.panel(), 'the old button acts on nothing'); assert.equal(r.control.mapSourcesOpen, true);
  r.button().fire('keydown', { key: 'Escape' });
  assert.equal(r.panel(), undefined); assert.equal(r.button().focusCalls, 1);
}));

test('5 document pointerdown: outside closes; inside, a drag source or an open picker does not', withRig(r => {
  open(r);
  r.doc.fire('pointerdown', { target: dom.find(r.panel(), c => c.tag === 'button') }); assert.ok(r.panel());
  r.doc.fire('pointerdown', { target: r.button() }); assert.ok(r.panel());
  const drag = dom.element('li'); drag.closest = () => ({}); r.doc.fire('pointerdown', { target: drag }); assert.ok(r.panel());
  r.control.mapSourcesPickerOpen = true; r.doc.fire('pointerdown', { target: dom.element('canvas') }); assert.ok(r.panel());
  r.control.mapSourcesPickerOpen = false; r.doc.fire('pointerdown', { target: dom.element('canvas') });
  assert.equal(r.panel(), undefined);
}));

test('6 document listeners return to the baseline after redraws, close, detach and dispose', withRig(r => {
  assert.equal(r.count('pointerdown'), 0); assert.equal(r.count('dragend'), 0);
  open(r); assert.equal(r.count('pointerdown'), 1); assert.equal(r.count('dragend'), 1);
  for (let i = 0; i < 3; i++) r.control.refreshMapSourcesUi(), r.control.drawMapSourcesPanelEl(null);
  assert.equal(r.count('pointerdown'), 1); assert.equal(r.count('dragend'), 1);
  r.button().click(); assert.equal(r.count('pointerdown'), 0); assert.equal(r.count('dragend'), 0);
  r.button().click(); r.control.detach(); assert.equal(r.count('pointerdown'), 0); assert.equal(r.count('dragend'), 0); assert.equal(r.control.mapSourcesPanelEl, null);
  r.draw(); assert.equal(r.count('pointerdown'), 1, 'the open panel is drawn again after the repaint');
  r.control.dispose(); assert.equal(r.count('pointerdown'), 0); assert.equal(r.count('dragend'), 0);
}));

test('7 changeMapSources: add writes through the repo, announces and redraws; a repeat writes nothing; quiet does not announce', withRig(async r => {
  open(r); const before = r.panel();
  r.control.changeMapSources('Cur/Map.md', 'add', FILE('a')); await r.drain();
  assert.deepEqual(r.state.writes, [['Cur/Map.md', [FILE('a')]]]); assert.deepEqual(r.state.spoken, ['Added "a.md"']);
  assert.notEqual(r.panel(), before); assert.ok(dom.find(r.panel(), c => c.text === 'a.md')); assert.equal(r.badge().text, '1');
  r.control.changeMapSources('Cur/Map.md', 'add', { ...FILE('a') }); await r.drain();
  assert.equal(r.state.writes.length, 1); assert.deepEqual(r.state.spoken.at(-1), '"a.md" is already added');
  const spoken = r.state.spoken.length;
  r.control.changeMapSources('Cur/Map.md', 'add', FILE('b'), true); await r.drain();
  assert.equal(r.state.writes.length, 2); assert.equal(r.state.spoken.length, spoken);
  r.control.changeMapSources('Cur/Map.md', 'add', FILE('a'), true); await r.drain(); assert.equal(r.state.spoken.length, spoken, 'a quiet repeat is silent');
  r.control.changeMapSources('Cur/Map.md', 'remove', FILE('b'), true); await r.drain(); assert.equal(r.state.spoken.at(-1), 'Removed b.md', 'a remove always announces');
}));

test('8 changeMapSources late work: path or closed before the queue runs; closed after the write; a failed write', withRig(async r => {
  open(r);
  r.control.changeMapSources('Cur/Map.md', 'add', FILE('a')); r.state.path = 'Other/Map.md'; await r.drain();
  assert.equal(r.state.reads, 0); assert.equal(r.state.writes.length, 0);
  r.state.path = 'Cur/Map.md'; r.control.changeMapSources('Cur/Map.md', 'add', FILE('a')); r.state.closed = true; await r.drain();
  assert.equal(r.state.reads, 0); assert.equal(r.state.writes.length, 0);
  r.state.closed = false; const panel = r.panel();
  r.state.onWrite = () => { r.state.closed = true; };
  r.control.changeMapSources('Cur/Map.md', 'add', FILE('a')); await r.drain();
  assert.equal(r.state.writes.length, 1, 'the write happened'); assert.equal(r.panel(), panel, 'no repaint after close');
  assert.equal(r.control.mapSourcesButtonEl.children.some(c => c.text === '1'), false);
  r.state.closed = false; r.state.onWrite = null; r.state.writeFails = true; notices.length = 0;
  r.control.changeMapSources('Cur/Map.md', 'add', FILE('b')); await r.drain();
  assert.equal(notices.length, 1); assert.match(notices[0], /disk full/); assert.equal(r.panel(), panel);
}));

test('9 removing a source that is not stored writes nothing and takes the read list', withRig(async r => {
  r.control.loadForMap([FILE('b')]); r.state.stored = [FILE('a')];
  r.control.changeMapSources('Cur/Map.md', 'remove', FILE('c')); await r.drain();
  assert.equal(r.state.writes.length, 0); assert.deepEqual(r.control.mapSources, [FILE('a')]);
}));

test('10 addExternalFolder: no map id, a refusal, and a success', withRig(async r => {
  r.state.mapId = undefined; assert.equal(await r.control.addExternalFolder('Cur/Map.md', r.w.docs), 'stale'); r.state.mapId = 'm1';
  assert.equal(await r.control.addExternalFolder('Cur/Map.md', 'research'), 'relative'); assert.equal(r.state.spoken.length, 0);
  r.control.mapSourcesSession.pathDraft = 'x'; r.control.mapSourcesSession.externalRejected = 'y';
  assert.equal(await r.control.addExternalFolder('Cur/Map.md', r.w.docs), null);
  assert.equal(r.control.mapSourcesSession.pathDraft, ''); assert.equal(r.control.mapSourcesSession.externalRejected, '');
  assert.deepEqual(r.state.spoken, ['Added "docs"']); assert.ok(r.control.externalStatusRun); assert.equal(r.control.externalSources.length, 1);
  await until(() => r.control.externalStatuses.size > 0); assert.deepEqual(r.control.externalStatuses.get('docs'), { count: 2 });
}));

for (const [name, change] of [['closed', s => { s.closed = true; }], ['epoch', s => { s.epoch++; }], ['mapId', s => { s.mapId = 'm2'; }], ['path', s => { s.path = 'Other/Map.md'; }]])
  test(`11 addExternalFolder is stale when ${name} changes during the check`, withRig(async r => {
    const result = r.control.addExternalFolder('Cur/Map.md', r.w.docs); change(r.state);
    assert.equal(await result, 'stale'); assert.equal(r.control.externalSources.length, 0); assert.equal(r.state.spoken.length, 0);
  }));

test('12 removeExternalFolder: the sync check, a changed epoch, and a source that is no longer listed', withRig(async r => {
  await addDocs(r); await until(() => r.control.externalStatuses.size > 0); const source = r.control.externalSources[0]; const key = [...r.local.keys()][0];
  r.state.spoken.length = 0;
  r.state.mapId = undefined; r.control.removeExternalFolder('Cur/Map.md', source); r.state.mapId = 'm1';
  r.state.closed = true; r.control.removeExternalFolder('Cur/Map.md', source); r.state.closed = false;
  r.control.removeExternalFolder('Other/Map.md', source);
  await nap(40); assert.equal(plain(JSON.parse(r.local.get(key))).length, 1, 'nothing was removed'); assert.equal(r.control.externalSources.length, 1);
  r.control.removeExternalFolder('Cur/Map.md', source); r.state.epoch++;
  await until(() => !r.local.has(key) || JSON.parse(r.local.get(key)).length === 0); await nap(20);
  assert.equal(r.control.externalSources.length, 1, 'a changed epoch drops the result'); assert.equal(r.state.spoken.length, 0);
  r.control.removeExternalFolder('Cur/Map.md', { label: 'docs', path: '/not/the/same' }); await nap(40);
  assert.equal(r.state.spoken.length, 0, 'removed false does not announce'); assert.equal(r.control.externalSources.length, 0);
}));

test('12b removeExternalFolder removes by label, announces the label and drops its status', withRig(async r => {
  await addDocs(r); await until(() => r.control.externalStatuses.size > 0); r.state.spoken.length = 0;
  r.control.removeExternalFolder('Cur/Map.md', r.control.externalSources[0]);
  await until(() => r.control.externalSources.length === 0);
  assert.deepEqual(r.state.spoken, ['Removed docs']); assert.equal(r.control.externalStatuses.has('docs'), false);
}));

test('13 refreshExternalStatuses: none to check, a new round aborts the old, and four kinds of late result are dropped', withRig(async r => {
  r.control.refreshExternalStatuses(); assert.equal(r.control.externalStatusRun, null);
  const source = { path: r.w.docs, label: 'docs' };
  const start = () => { r.control.externalSources = [source]; r.control.externalMapId = 'm1'; r.control.externalStatuses = new Map(); r.control.refreshExternalStatuses(); };
  start(); const first = r.control.externalStatusRun; r.control.refreshExternalStatuses(); assert.equal(first.signal.aborted, true);
  await until(() => r.control.externalStatuses.size > 0); assert.deepEqual(r.control.externalStatuses.get('docs'), { count: 2 }, 'the control: an untouched round writes');
  for (const change of [() => { r.state.closed = true; }, () => { r.state.epoch++; }, () => { r.control.externalMapId = 'm2'; }, () => { r.control.externalStatusRun.abort(); }]) {
    r.state.closed = false; start(); change(); await nap(60);
    assert.equal(r.control.externalStatuses.size, 0);
  }
}));

test('14 repaintExternalStatus: a picker keeps the panel; typing redraws with input focus', withRig(r => {
  open(r); r.control.externalSources = [{ path: '/x', label: 'x' }];
  const panel = r.panel(); r.control.mapSourcesPickerOpen = true; r.control.repaintExternalStatus();
  assert.equal(r.panel(), panel); assert.equal(r.button().attrs['aria-label'], 'Data sources · 1', 'the button still repaints');
  r.control.mapSourcesPickerOpen = false;
  const draws = []; r.control.drawMapSourcesPanelEl = focus => draws.push(focus);
  r.control.repaintExternalStatus(); assert.deepEqual(draws, [null]);
  r.state.activeElement = dom.find(r.panel(), c => dom.hasCls(c, 'vam-map-sources-path')); assert.ok(r.state.activeElement);
  r.control.repaintExternalStatus(); assert.deepEqual(draws, [null, { input: true }]);
  r.state.closed = true; r.control.repaintExternalStatus(); assert.equal(draws.length, 2);
}));

test('15 loadForMap and reset', withRig(r => {
  const status = { count: 1 }; r.control.externalMapId = 'm1'; r.control.externalStatuses = new Map([['x', status]]);
  r.control.loadForMap([FILE('a')]); assert.equal(r.control.externalStatuses.get('x'), status, 'the same map keeps what it knew'); assert.deepEqual(r.control.mapSources, [FILE('a')]);
  const run = new AbortController(); r.control.externalStatusRun = run; r.state.mapId = 'm2';
  r.control.loadForMap([FILE('b')]); assert.equal(r.control.externalStatuses.size, 0); assert.equal(run.signal.aborted, true); assert.equal(r.control.externalMapId, 'm2');
  const again = new AbortController(); r.control.externalStatusRun = again; r.control.externalStatuses = new Map([['x', status]]); r.control.externalSources = [{ path: '/x', label: 'x' }];
  r.control.reset(); assert.deepEqual(r.control.mapSources, []); assert.equal(r.control.externalSources.length, 0); assert.equal(r.control.externalStatuses.size, 0); assert.equal(again.signal.aborted, true);
}));

test('16 dispose aborts the status run, cleans the listeners and later results are ignored', withRig(async r => {
  open(r); r.control.externalSources = [{ path: r.w.docs, label: 'docs' }]; r.control.externalMapId = 'm1'; r.control.refreshExternalStatuses();
  const run = r.control.externalStatusRun; r.control.dispose();
  assert.equal(run.signal.aborted, true); assert.equal(r.count('pointerdown'), 0); assert.equal(r.control.mapSourcesPanelCleanup, null);
  await nap(60); assert.equal(r.control.externalStatuses.size, 0); assert.equal(r.control.externalSources.length, 0);
}));

test('17 refreshMapSourcesUi: closed, no sources and no button do nothing; an open panel redraws unless a picker is open', withRig(r => {
  const draws = []; const paints = [];
  r.control.drawMapSourcesPanelEl = focus => draws.push(focus); r.control.paintMapSourcesButton = () => paints.push(1);
  r.control.mapSources = [FILE('a')]; r.control.refreshMapSourcesUi(); assert.equal(paints.length, 0, 'no button yet');
  r.draw(); paints.length = 0;
  r.state.closed = true; r.control.refreshMapSourcesUi(); r.state.closed = false;
  r.control.mapSources = []; r.control.refreshMapSourcesUi(); assert.equal(paints.length, 0);
  r.control.mapSources = [FILE('a')]; r.control.refreshMapSourcesUi(); assert.equal(paints.length, 1); assert.equal(draws.length, 0, 'closed panel: no redraw');
  r.control.mapSourcesOpen = true; r.control.mapSourcesPickerOpen = true; r.control.refreshMapSourcesUi(); assert.equal(draws.length, 0);
  r.control.mapSourcesPickerOpen = false; r.control.refreshMapSourcesUi(); assert.deepEqual(draws, [null]);
}));

test('18 repainting the toolbar while open keeps the panel open and leaves one set of listeners', withRig(r => {
  open(r); for (let i = 0; i < 3; i++) r.draw();
  assert.ok(r.panel()); assert.equal(r.control.mapSourcesOpen, true); assert.equal(r.button().attrs['aria-expanded'], 'true');
  assert.equal(r.count('pointerdown'), 1); assert.equal(r.count('dragend'), 1);
}));

test('19 source scan: no activeTasks, FileSystemAdapter or view import', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/map-sources-control.ts'), 'utf8');
  for (const word of ['activeTasks', 'FileSystemAdapter', 'from "./view"']) assert.equal(source.includes(word), false, word);
  assert.match(source, /export class MapSourcesControl/); assert.match(source, /export interface MapSourcesControlPorts/);
});

test('20 queued source mutation is fenced by epoch before read, after read and after write', withRig(async r => {
  open(r);
  r.control.changeMapSources(r.state.path, 'add', FILE('a'));
  r.state.epoch++;
  await r.drain();
  assert.equal(r.state.reads, 0, 'same path reopened before the queue starts');
  r.state.onRead = async () => { r.state.epoch++; };
  r.control.changeMapSources(r.state.path, 'add', FILE('a'));
  await r.drain();
  assert.equal(r.state.writes.length, 0, 'stale read cannot start a write');
  r.state.onRead = null;
  r.state.onWrite = () => { r.state.epoch++; r.control.loadForMap([FILE('b')]); };
  r.control.changeMapSources(r.state.path, 'add', FILE('a'));
  await r.drain();
  assert.equal(r.state.writes.length, 1, 'in-flight write may complete');
  assert.deepEqual(r.control.mapSources, [FILE('b')], 'late write cannot replace the new map cache');
  assert.equal(r.state.spoken.length, 0);
}));

test('21 delayed source search is single-flight and cannot reopen a closed session', withRig(async r => {
  open(r);
  let release;
  let calls = 0;
  r.state.mapItems = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const search = dom.find(r.panel(), c => c.cls === 'vam-map-sources-search');
  search.click(); search.click();
  assert.equal(calls, 1);
  assert.equal(r.control.mapSourcesPickerOpen, true);
  r.button().click();
  assert.equal(r.control.mapSourcesPickerOpen, false);
  r.button().click();
  release([]);
  await nap(0);
  assert.ok(r.panel());
  assert.equal(r.control.mapSourcesPickerOpen, false, 'old search cannot claim the new panel');
}));

test('22 disposal and reset cancel the owned picker without affecting the next session', withRig(r => {
  open(r);
  let closes = 0;
  r.control.closePicker = () => { closes++; };
  r.control.mapSourcesPickerOpen = true;
  r.control.reset();
  assert.equal(closes, 1);
  assert.equal(r.control.mapSourcesPickerOpen, false);
  r.control.closePicker = () => { closes++; };
  r.control.mapSourcesPickerOpen = true;
  r.control.dispose();
  assert.equal(closes, 2);
  assert.equal(r.control.mapSourcesOpen, false);
  assert.equal(r.control.mapSourcesPickerOpen, false);
  assert.equal(r.control.mapSourcesPanelEl, null);
}));
