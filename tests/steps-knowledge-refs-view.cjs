// Cross-map knowledge references (P4.3), the view layer: the reference card, its menu items and their gates, the copy Notice
// and the remove path. A real view over a fake vault, modelled on tests/steps-clipboard-view.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;

const HOST = 'Agent Workspace/Topics/map-host/Map.md';
const OTHER = 'Agent Workspace/Topics/map-other/Map.md';

async function harness({ aim = false } = {}) {
  const { repo, app, contents, files } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-host');
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-other');
  const other = { id: 'map-other', title: 'Other map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const original = await repo.createNote('Original card', 'gpt-6-luna', other, OTHER, 'workspace', { detail: 'ORIGINAL BODY' });
  Object.assign(original, { parentId: null, x: 0, y: 0 }); other.nodes.push(original);
  await app.vault.create(OTHER, core.serializeMap(other));
  const host = { id: 'map-host', title: 'Host map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const root = await repo.createNote('Root', 'gpt-6-luna', host, HOST, 'workspace');
  Object.assign(root, { parentId: null, x: 80, y: 80 }); host.nodes.push(root);
  const kid = await repo.createNote('Kid', 'gpt-6-luna', host, HOST, 'inherited');
  Object.assign(kid, { parentId: root.id, x: 400, y: 80 }); host.nodes.push(kid);
  host.knowledgeRefs = [{ id: 'ref-a', mapId: 'map-other', nodeId: original.id, parentId: kid.id, x: 300, y: 0, pathHint: OTHER }];
  if (aim) host.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  await app.vault.create(HOST, core.serializeMap(host));
  await repo.rebuildDerivedData();
  const notices = [], menus = [];
  const Notice = dom.makeNotice(notices);
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setWarning() { return this; }, setDisabled(v) { this.disabled = v; return this; }, onClick(h) { this.click = h; return this; } }; cb(item); this.items.push(item); return this; }
    addSeparator() { return this; } showAtMouseEvent() { return this; } showAtPosition() { return this; }
  }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice, Menu, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment, createSvg: dom.createSvg, setTimeout, clearTimeout });
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = HOST; view.map = await repo.readMap(HOST); view.stageEl = element('div'); view.contentEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.render = () => { view.paintKnowledgeRefs(); };
  await view.hydrate(); view.render();
  const viewOf = async (path, nodeKey) => { const v = new VisualAgentMapView({ app }, plugin); v.path = path; v.map = await repo.readMap(path); v.stageEl = element('div'); v.contentEl = element('div'); return v; };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
  return { viewOf, repo, app, contents, files, view, plugin, notices, menus, ids: { root: root.id, kid: kid.id, original: original.id }, settle, saved: () => repo.readMap(HOST), otherCard: original };
}
const refEls = h => h.view.stageEl.querySelectorAll('.vam-knowledge-ref');
const cardMenu = (h, nodeId) => { const node = h.view.map.nodes.find(n => n.id === nodeId); h.view.addCardMenuActions(new (h.view.newMenu().constructor)(), node); return h.menus.at(-1).items.map(i => i.title); };

test('the reference card is drawn as a read-only card with the source map title, from the vault now', async () => {
  const h = await harness();
  await h.settle();
  const els = refEls(h);
  assert.equal(els.length, 1);
  const el = els[0];
  assert.ok(el.hasClass('vam-knowledge-ref') && !el.hasClass('is-unavailable'));
  assert.equal(el.querySelector('.vam-knowledge-ref-source').text, '↗ Reference from “Other map” · read-only');
  assert.equal(el.querySelector('.vam-knowledge-ref-title').text, 'Original card');
  assert.equal(el.attrs.role, 'note');
  assert.equal(el.querySelector('textarea, input, [contenteditable]'), null, 'nothing to edit');
  assert.equal(h.view.map.nodes.length, 2, 'the reference is not a card of the map');
});

test('an original that is gone shows the unavailable state with no old content, and a remove button', async () => {
  const h = await harness();
  await h.app.fileManager.trashFile(h.app.vault.getAbstractFileByPath(OTHER)); h.contents.delete(OTHER); h.app.vault.getAbstractFileByPath(OTHER) && h.files.delete(OTHER);
  h.view.refResolved = new Map(); h.view.paintKnowledgeRefs(); await h.settle();
  const el = refEls(h)[0];
  assert.ok(el.hasClass('is-unavailable'));
  assert.equal(el.querySelector('.vam-knowledge-ref-title').text, '⚠ Original card unavailable');
  assert.ok(!el.children.some(c => c.text === 'Original card' || /Other map/.test(c.text)), 'no old title, no map name');
  assert.equal(el.querySelector('.vam-knowledge-ref-remove').text, 'Remove reference');
});

test('menu items: Copy/Paste as reference appear on an editable map only; none on an AIM map', async () => {
  const h = await harness();
  assert.deepEqual(cardMenu(h, h.ids.root).filter(x => /reference/i.test(x)), ['Copy as reference']);
  h.view.copyAsKnowledgeRef(h.view.map.nodes[0]);
  assert.deepEqual(cardMenu(h, h.ids.kid).filter(x => /reference/i.test(x)), ['Copy as reference', 'Paste reference']);
  const aim = await harness({ aim: true });
  aim.view.copyAsKnowledgeRef(aim.view.map.nodes[0]);
  assert.deepEqual(cardMenu(aim, aim.ids.kid).filter(x => /reference/i.test(x)), [], 'AIM map: no reference items');
});

test('menu items are absent while a card is merging and while topics are being picked', async () => {
  const h = await harness();
  h.view.copyAsKnowledgeRef(h.view.map.nodes[0]);
  h.view.isMerging = id => id === h.ids.kid;
  assert.deepEqual(cardMenu(h, h.ids.kid).filter(x => /reference/i.test(x)), []);
  h.view.isMerging = () => false;
  h.view.selection.toggleMultiSelect();
  assert.deepEqual(cardMenu(h, h.ids.kid).filter(x => /reference/i.test(x)), []);
});

test('copying a branch tells about skipped reference cards only when some were skipped', async () => {
  const h = await harness();
  const event = () => ({ target: { inside: true, closest: () => null }, preventDefault() {}, clipboardData: { getData: () => '', setData() {} } });
  h.view.contentEl.contains = n => !!n?.inside;
  h.view.selection.setSelected(h.ids.root);
  h.view.onClipboardEvent('copy', event());
  assert.ok(h.notices.some(n => /1 reference cards were skipped/.test(n)), 'the branch holds a reference');
  const clean = await harness();
  clean.view.map.knowledgeRefs = undefined; delete clean.view.map.knowledgeRefs;
  clean.view.contentEl.contains = n => !!n?.inside;
  clean.view.selection.setSelected(clean.ids.root);
  clean.view.onClipboardEvent('copy', event());
  assert.equal(clean.notices.filter(n => /reference/i.test(n)).length, 0, 'no reference, no extra Notice');
});

test('paste gate: pasting a reference needs a remembered card; refused on a read-only map; self and duplicates are refused', async () => {
  const h = await harness();
  h.view.pasteKnowledgeRef(h.ids.kid); await h.settle();
  assert.equal((await h.saved()).knowledgeRefs.length, 1, 'nothing remembered: nothing pasted');
  // the remembered card is on this very map
  h.view.copyAsKnowledgeRef(h.view.map.nodes[0]);
  h.view.pasteKnowledgeRef(h.ids.kid); await h.settle();
  assert.ok(h.notices.includes('A map cannot hold a reference to its own card.'));
  // the card of the other map, already referenced on this card
  (await h.viewOf(OTHER)).copyAsKnowledgeRef({ id: h.ids.original });
  h.view.pasteKnowledgeRef(h.ids.kid); await h.settle();
  assert.ok(h.notices.includes('This card already holds a reference to that card.'));
  assert.equal((await h.saved()).knowledgeRefs.length, 1);
  // on another card it is added; read-only gate then refuses a second one
  h.view.pasteKnowledgeRef(h.ids.root); await h.settle();
  assert.equal((await h.saved()).knowledgeRefs.length, 2);
  const ro = await harness();
  ro.view.selection.toggleMultiSelect();
  await ro.view.addKnowledgeRef({ mapId: 'map-x', nodeId: 'n', mapPath: 'x.md' }, ro.ids.root);
  assert.equal((await ro.saved()).knowledgeRefs.length, 1, 'read-only: nothing added');
  assert.ok(ro.notices.length > 0);
});

test('addKnowledgeRef re-checks the edit gate when it runs: an AIM map and presentation mode write nothing', async () => {
  const target = { mapId: 'map-x', nodeId: 'n', mapPath: 'x.md' };
  const aim = await harness({ aim: true });
  await aim.view.addKnowledgeRef(target, aim.ids.root); await aim.settle();
  assert.equal((await aim.saved()).knowledgeRefs.length, 1, 'AIM: nothing added');
  const pres = await harness();
  pres.view.presentation = true;
  await pres.view.addKnowledgeRef(target, pres.ids.root); await pres.settle();
  assert.equal((await pres.saved()).knowledgeRefs.length, 1, 'presentation: nothing added');
});

test('remove reference (Delete key and the menu) removes only this map\'s reference, never the original', async () => {
  const h = await harness();
  await h.settle();
  const before = await h.repo.readMap(OTHER);
  const el = refEls(h)[0];
  const menuEvent = { target: el, preventDefault() {}, clientX: 5, clientY: 5 };
  el.closest = sel => (sel === '.vam-knowledge-ref' ? el : null);
  h.view.onCanvasContextMenu(menuEvent);
  assert.deepEqual(h.menus.at(-1).items.map(i => i.title), ['Open original card (read-only)', 'Remove reference']);
  el.fire('keydown', { key: 'Delete', target: el });
  await h.settle(); await h.settle();
  const saved = await h.saved();
  assert.equal('knowledgeRefs' in saved, false, 'the last reference takes the key with it');
  assert.equal(saved.nodes.length, 2);
  assert.deepEqual(await h.repo.readMap(OTHER), before, 'the original map is untouched');
  assert.equal(h.view.history.past.length >= 1, true, 'one undo step');
});

// Real pointer sequences (F01 UI FAIL 1, 2): the press goes to the reference card first, then bubbles to the canvas
// viewport, whose pan handler is wired by setupPan; the last setPointerCapture takes the moves and the up, and a click
// lands on the element that holds the capture (the viewport when it panned).
function pointerRig(h) {
  const viewport = dom.element('div', 'vam-viewport');
  let captor = null;
  viewport.setPointerCapture = () => { captor = viewport; };
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600 });
  viewport.stageAncestor = true;
  h.view.viewportEl = viewport;
  h.view.transform = () => {}; h.view.saveViewport = () => {}; h.view.markCanvasHintSeen = () => {};
  h.view.setupPan();
  const el = refEls(h)[0];
  el.setPointerCapture = () => { captor = el; };
  // Class selectors only (the pan guard's list); the card and its ancestors are checked like Element.closest.
  el.closest = sel => sel.split(',').map(x => x.trim()).some(x => { if (!x.startsWith('.')) return false; for (let up = el; up; up = up.parent) if (dom.hasCls(up, x.slice(1))) return true; return false; }) ? el : null;
  const send = (target, name, event) => {
    let stopped = false;
    const e = { button: 0, pointerId: 1, altKey: false, shiftKey: false, target: el, preventDefault() {}, stopPropagation() { stopped = true; }, stopImmediatePropagation() { stopped = true; }, ...event };
    for (const fn of [...(target.listeners[name] ?? [])]) fn(e);
    if (target === el && !stopped) for (const fn of [...(viewport.listeners[name] ?? [])]) fn(e);
  };
  const sequence = points => {
    captor = null;
    const [first, ...rest] = points;
    send(el, 'pointerdown', { clientX: first[0], clientY: first[1] });
    const panned = viewport.hasClass('is-panning');
    for (const [x, y] of rest) send(captor ?? el, 'pointermove', { clientX: x, clientY: y });
    const last = points.at(-1);
    send(captor ?? el, 'pointerup', { clientX: last[0], clientY: last[1] });
    send(captor ?? el, 'click', { clientX: last[0], clientY: last[1], target: captor ?? el });
    return { panned };
  };
  return { el, viewport, sequence };
}

test('F01 FAIL 1: a real mouse click on a reference card opens it and does not pan the canvas', async () => {
  const h = await harness();
  await h.settle(); h.view.paintKnowledgeRefs();
  const opened = [];
  h.view.openKnowledgeRef = ref => { opened.push(ref.id); return Promise.resolve(); };
  const rig = pointerRig(h);
  const { panned } = rig.sequence([[100, 100]]);
  assert.equal(panned, false, 'the press on the reference card must not start a canvas pan');
  assert.deepEqual(opened, ['ref-a'], 'the click opens the reference');
});

test('F01 FAIL 2: a real mouse drag on a reference card moves the reference, not the canvas', async () => {
  const h = await harness();
  await h.settle(); h.view.paintKnowledgeRefs();
  const rig = pointerRig(h);
  const before = { ...h.view.map.viewport }, steps = h.view.history.past.length;
  const { panned } = rig.sequence([[100, 100], [130, 110], [160, 120]]);
  await h.settle(); await h.settle();
  assert.equal(panned, false, 'no canvas pan');
  assert.equal(h.view.history.past.length, steps + 1, 'the drag is one undo step');
  assert.deepEqual({ x: h.view.map.viewport.x, y: h.view.map.viewport.y }, { x: before.x, y: before.y }, 'the canvas stays put');
  const ref = (await h.saved()).knowledgeRefs.find(r => r.id === 'ref-a');
  assert.deepEqual({ x: ref.x, y: ref.y }, { x: 360, y: 20 }, 'the reference moved by the drag');
});

test('F01 FAIL 3: a pasted reference sits clear of the parent card\'s existing child cards', async () => {
  const h = await harness();
  (await h.viewOf(OTHER)).copyAsKnowledgeRef({ id: h.ids.original });
  h.view.pasteKnowledgeRef(h.ids.root); await h.settle(); await h.settle();
  const saved = await h.saved();
  const root = saved.nodes.find(n => n.id === h.ids.root), kid = saved.nodes.find(n => n.id === h.ids.kid);
  const ref = saved.knowledgeRefs.find(r => r.parentId === h.ids.root);
  // The widest a reference card is drawn (styles.css max-width 260px) and a two-line height.
  const refBox = { x: root.x + ref.x, y: root.y + ref.y, w: 260, h: 60 };
  const kidBox = { x: kid.x, y: kid.y, w: kid.width ?? 280, h: kid.height ?? 180 };
  const overlap = refBox.x < kidBox.x + kidBox.w && kidBox.x < refBox.x + refBox.w && refBox.y < kidBox.y + kidBox.h && kidBox.y < refBox.y + refBox.h;
  assert.equal(overlap, false, `reference at ${JSON.stringify(refBox)} overlaps the child card at ${JSON.stringify(kidBox)}`);
});

test('F01 review: a pasted reference avoids every visible card, also a later sibling\'s children in the same column', async () => {
  const h = await harness();
  // Root's sibling B sits below Root, and B's child b1 sits right where "below Root's lowest child" would put the reference.
  const b = await h.repo.createNote('B', 'gpt-6-luna', h.view.map, HOST, 'workspace');
  Object.assign(b, { parentId: null, x: 80, y: 300 }); h.view.map.nodes.push(b);
  const b1 = await h.repo.createNote('B one', 'gpt-6-luna', h.view.map, HOST, 'inherited');
  Object.assign(b1, { parentId: b.id, x: 400, y: 300 }); h.view.map.nodes.push(b1);
  await h.repo.saveMap(HOST, h.view.map); h.view.map = await h.repo.readMap(HOST); await h.view.hydrate();
  (await h.viewOf(OTHER)).copyAsKnowledgeRef({ id: h.ids.original });
  h.view.pasteKnowledgeRef(h.ids.root); await h.settle(); await h.settle();
  const saved = await h.saved();
  const root = saved.nodes.find(n => n.id === h.ids.root), kid = saved.nodes.find(n => n.id === h.ids.kid);
  const ref = saved.knowledgeRefs.find(r => r.parentId === h.ids.root);
  const refBox = { x: root.x + ref.x, y: root.y + ref.y, w: 260, h: 60 };
  const others = [
    ...saved.nodes.map(n => ({ name: n.title ?? n.id, x: n.x, y: n.y, w: n.width ?? 280, h: n.height ?? 180 })),
    ...saved.knowledgeRefs.filter(r => r !== ref).map(r => { const p = saved.nodes.find(n => n.id === r.parentId); return { name: r.id, x: p.x + r.x, y: p.y + r.y, w: 260, h: 60 }; })
  ];
  for (const o of others) {
    const overlap = refBox.x < o.x + o.w && o.x < refBox.x + refBox.w && refBox.y < o.y + o.h && o.y < refBox.y + refBox.h;
    assert.equal(overlap, false, `reference at ${JSON.stringify(refBox)} overlaps ${o.name} at ${JSON.stringify(o)}`);
  }
  assert.ok(kid, 'the child card is still there');
});

// F01-x: a reference card hangs from its parent card by a dashed connector drawn by drawEdges.
const connectorHarness = async ({ parent = true } = {}) => {
  const h = await harness();
  await h.settle();
  const host = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  h.view.edgesEl = host; h.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  const box = (el, left, top, w, hh) => Object.assign(el, { offsetLeft: left, offsetTop: top, offsetWidth: w, offsetHeight: hh });
  for (const n of h.view.map.nodes) h.view.cardEls.set(n.id, box({}, n.x, n.y, 200, 60));
  if (!parent) h.view.map.knowledgeRefs[0].parentId = 'gone';
  h.view.paintKnowledgeRefs();
  const ref = h.view.refCardEls.get('ref-a');
  if (ref) { box(ref.el, 700, 80, 160, 50); }
  const connectors = () => host.children.filter(c => c.classes.includes('vam-ref-connector'));
  return { h, host, ref, connectors };
};
const endOf = d => { const nums = d.match(/-?\d+(\.\d+)?/g).map(Number); return { x: nums.at(-2), y: nums.at(-1) }; };

test('F01-x a visible reference gets one connector from its parent card whose end sits on the reference card edge', async () => {
  const { h, connectors } = await connectorHarness();
  h.view.drawEdges();
  const lines = connectors();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].attrs['data-ref-id'], 'ref-a');
  const end = endOf(lines[0].attrs.d);
  assert.ok(Math.abs(end.x - 700) <= 12 || Math.abs(end.x - 860) <= 12, `end x ${end.x} at a ref card edge`);
  assert.ok(end.y >= 80 - 12 && end.y <= 130 + 12, `end y ${end.y} within the ref card`);
});

test('F01-x the connector follows a moved reference card and a moved parent card', async () => {
  const { h, ref, connectors } = await connectorHarness();
  h.view.drawEdges();
  const before = connectors()[0].attrs.d;
  Object.assign(ref.el, { offsetLeft: 700, offsetTop: 400 });
  h.view.placeRefConnector('ref-a');
  const afterRef = connectors()[0].attrs.d;
  assert.notEqual(afterRef, before);
  assert.ok(endOf(afterRef).y >= 400 - 12);
  h.view.placeRefConnector('ref-a', { x: 0, y: 900, width: 200, height: 60 });
  assert.notEqual(connectors()[0].attrs.d, afterRef);
  h.view.drawEdges();
  assert.equal(connectors().length, 1, 'a redraw replaces it rather than adding another');
});

test('F01-x a reference whose parent card is gone draws no connector; an unavailable reference still does', async () => {
  const orphan = await connectorHarness({ parent: false });
  orphan.h.view.drawEdges();
  assert.equal(orphan.connectors().length, 0);
  const { h, connectors } = await connectorHarness();
  h.view.refResolved.set('ref-a', { ok: false, reason: 'missing' });
  h.view.paintKnowledgeRefs();
  Object.assign(h.view.refCardEls.get('ref-a').el, { offsetLeft: 700, offsetTop: 80, offsetWidth: 160, offsetHeight: 50 });
  h.view.drawEdges();
  assert.equal(connectors().length, 1);
});
