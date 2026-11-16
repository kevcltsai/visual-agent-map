// Packet 1 (characterization): the REAL VisualAgentMapView.render()/paint() runs over the focus-model DOM; only the heavy middle
// (card builder, pan, viewport, edges, chat, covers, outline, setViewState, layout settle) is replaced by instance overrides.
// The tail restorers are wrapped by spies, so these tests pin phase order and where keyboard focus lands after a redraw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { Doc, El } = require('./support-focus-dom.cjs');

// The shared El only knows `.class`, `tag` and `[tabindex]`; paint also asks for compounds, descendants and [data-*="x"].
const compound = (el, sel) => {
  const re = /(\.[\w-]+)|(\[[\w-]+(?:="[^"]*")?\])|([a-z][\w-]*)/gi;
  let m, any = false;
  while ((m = re.exec(sel))) {
    any = true;
    if (m[1]) { if (!el.classes.has(m[1].slice(1))) return false; }
    else if (m[2]) {
      const [, name, value] = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(m[2]);
      const data = name.startsWith('data-') ? name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()) : null;
      const have = data ? el.dataset[data] : el.attrs[name];
      if (value === undefined ? have === undefined : String(have) !== value) return false;
    } else if (el.tagName !== m[3].toUpperCase()) return false;
  }
  return any;
};
El.prototype.matches = function (selector) {
  return selector.split(',').map(s => s.trim()).some(s => compound(this, s));
};
El.prototype.querySelectorAll = function (selector) {
  const out = [];
  for (const part of selector.split(',').map(x => x.trim())) {
    const steps = part.split(/\s+/);
    for (const el of this.all()) {
      if (!compound(el, steps[steps.length - 1])) continue;
      let at = el.parent, ok = true;
      for (let i = steps.length - 2; i >= 0 && ok; i--) { while (at && at !== this.parent && !compound(at, steps[i])) at = at.parent; ok = !!at && at !== this.parent; at = at?.parent; }
      if (ok && !out.includes(el)) out.push(el);
    }
  }
  return out;
};
Object.defineProperties(El.prototype, Object.getOwnPropertyDescriptors({
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); },
  insertBefore(child, ref) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; const at = ref ? this.children.indexOf(ref) : -1; if (at < 0) this.children.push(child); else this.children.splice(at, 0, child); return child; },
  get childElementCount() { return this.children.length; },
  setCssProps() {}, setSelectionRange(a, b) { this.selection = [a, b]; },
  get selectionStart() { return this.selection?.[0] ?? null; }, get selectionEnd() { return this.selection?.[1] ?? null; }
}));

const MAP = 'Agent Workspace/Topics/map-p/Map.md';
let globalWin = {};
const chain = () => new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : chain()), apply: () => chain() });

async function harness() {
  globalWin = { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: tag => new El(new Doc(), tag), makeDiv: cls => new El(new Doc(), 'div', typeof cls === 'string' ? { cls } : cls) };
  const { repo, app } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const mapDoc = { id: 'map-p', title: 'Paint', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-p');
  const ids = {};
  for (const [key, title, parent] of [['root', 'Root'], ['leaf', 'Leaf', 'root']]) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  }
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const Base = dom.makeModal();
  // paint calls the bare global createDiv(); the loader exposes only createEl/createSvg, so a banner (loader build option) routes it to a window value.
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: Base, Notice: dom.makeNotice([]), setTooltip() {} } }, globalWin, { banner: { js: 'var createDiv = c => window.makeDiv(c);' } });
  const plugin = withExpansionCoordinator({
    availableModels: () => ['gpt-6-luna'], modelLabel: m => m, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async () => {},
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    syncOutline() {}, mutate: async work => { await work(); }
  });
  const view = new VisualAgentMapView({ app, setViewState() {} }, plugin);
  const doc = new Doc();
  const contentEl = doc.body.add('div', { cls: 'view-content' });
  contentEl.focus = () => { doc.activeElement = contentEl; };
  view.contentEl = contentEl; view.path = MAP; view.map = await repo.readMap(MAP);
  view.leaf = { setViewState() {} };
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  contentEl.addEventListener('focusin', event => view.trackMapFocus?.(event.target));
  const mapWin = { name: 'map' };
  doc.defaultView = mapWin;
  globalWin.activeDocument = doc; globalWin.activeWindow = mapWin; globalWin.document = doc;
  const log = [];
  // Heavy middle parts, replaced (the real paint decides when they run).
  Object.assign(view, {
    renderNode(node) {
      const card = view.stageEl.add('div', { cls: 'vam-node', tabindex: 0 }); card.dataset.nodeId = node.id;
      card.add('button', { cls: 'vam-card-resize' }); card.add('button', { cls: 'vam-card-resize-y' });
      view.cardEls.set(node.id, card);
    },
    renderCanvasItems() {}, setupPan() { log.push('setupPan'); }, setupCanvasImageInput() {}, applyInitialViewport() { log.push('applyInitialViewport'); }, transform() { log.push('transform'); }, applyStageTransform() {},
    syncStatusBarClearance() { log.push('syncStatusBarClearance'); }, releaseCovers() {}, fillEmptyMap() {}, mountMapChat() {}, removeGoalBar() {}, lockWhileLoading() {}, settleCardHeights() {}, drawEdges() { log.push('drawEdges'); }
  });
  for (const name of ['lockWhileLoading', 'settleCardHeights']) view[name] = () => { log.push(name); };
  const proto = VisualAgentMapView.prototype;
  // Spies call the real method and log it; a restorer it returns logs under its own name when it runs.
  const spy = (name, label) => { view[name] = function (...args) { log.push(name); const r = proto[name].apply(view, args); return typeof r === 'function' ? () => { log.push(label); return r(); } : r; }; };
  for (const [name, label] of [['holdMapFocus', 'keepMapFocus'], ['keepRelevanceBarFocus', 'restoreRelevance'], ['keepArgumentBarFocus', 'restoreArgument'], ['detachMapChat', 'restoreChat'], ['holdMapSearch', 'restoreSearch']]) spy(name, label);
  for (const name of ['detachTopicChat', 'captureGoalEdit', 'remountTopicChat', 'focusInlineName', 'focusInlineSummary', 'focusGoalEdit', 'applyPresentationMarks', 'applySearchMarks']) spy(name, name);
  view.anchorDragCancel = arg => { log.push('anchorDragCancel(' + arg + ')'); };
  const emptyOnce = contentEl.empty.bind(contentEl); contentEl.empty = () => { log.push('contentEl.empty'); emptyOnce(); };
  const focused = [];
  contentEl.addEventListener('focusin', event => { focused.push({ el: event.target, restoring: view.restoringFocus }); if (view.restoringFocus) log.push('cardFocus'); });
  return { focused, view, repo, doc, contentEl, ids, mapWin, log, plugin, active: () => doc.activeElement, VisualAgentMapView };
}



const other = () => ({ win: { name: 'other' }, doc: new Doc() });
const ident = el => `${el.tagName}.${[...el.classes].join('.')}|${el.dataset.nodeId ?? ''}|${el.attrs['aria-label'] ?? ''}`;
const inMap = h => h.contentEl.contains(h.active());
const leafCard = h => h.view.cardEls.get(h.ids.leaf);
// activeWindow/activeDocument say another Obsidian window is active; the map's own document keeps whatever element it had.
const goOther = h => { const o = other(); globalWin.activeWindow = o.win; globalWin.activeDocument = o.doc; return o; };
const goMap = h => { globalWin.activeWindow = h.mapWin; globalWin.activeDocument = h.doc; };

test('P1 C1: paint runs its phases in this order (holds, empty, rebuild, restorers, tail), then render locks and settles', async () => {
  const h = await harness();
  h.view.render();
  leafCard(h).focus(); // a focused card, so paint's card handoff (cardFocus) is part of the sequence
  h.log.length = 0;
  h.view.render();
  // The second captureGoalEdit is mountGoalBar's own redraw, inside the rebuild (observed, not in paint's own list).
  assert.deepEqual(h.log, [
    'anchorDragCancel(false)', 'holdMapFocus', 'keepRelevanceBarFocus', 'keepArgumentBarFocus', 'detachMapChat', 'detachTopicChat', 'holdMapSearch', 'captureGoalEdit',
    'contentEl.empty', 'captureGoalEdit', 'cardFocus', 'setupPan', 'applyInitialViewport', 'transform', 'drawEdges',
    'restoreRelevance', 'restoreArgument', 'restoreChat', 'remountTopicChat', 'keepMapFocus', 'focusInlineName', 'focusInlineSummary', 'focusGoalEdit',
    'syncStatusBarClearance', 'applyPresentationMarks', 'restoreSearch', 'lockWhileLoading', 'settleCardHeights'
  ]);
});

test('P1 C2: a focused leaf card is focused again as the NEW element (same data-node-id), restoringFocus true only during that focus', async () => {
  const h = await harness();
  h.view.render();
  const old = leafCard(h); old.focus(); h.focused.length = 0;
  h.view.render();
  const now = leafCard(h);
  assert.ok(now !== old);
  assert.ok(h.active() === now);
  assert.equal(now.dataset.nodeId, h.ids.leaf);
  assert.equal(h.view.focusNodeId, null);
  assert.deepEqual(h.focused.filter(f => f.el === now).map(f => f.restoring), [true]);
  assert.equal(h.view.restoringFocus, false);
});

test('P1 C3: a focused resize handle returns to the same-axis handle of the new card; focusResizeNodeId is cleared', async () => {
  for (const [cls, axis] of [['vam-card-resize', 'width'], ['vam-card-resize-y', 'height']]) {
    const h = await harness();
    h.view.render();
    const handle = leafCard(h).querySelector('.' + cls); handle.focus();
    h.focused.length = 0;
    h.view.render();
    const now = leafCard(h).querySelector('.' + cls);
    assert.ok(now !== handle, axis);
    assert.ok(h.active() === now, `${axis} handle`);
    assert.equal(h.view.focusResizeNodeId, null);
    assert.equal(h.view.focusNodeId, null, 'the card itself is not what gets focus');
    assert.deepEqual(h.focused.map(f => f.restoring), [true]);
  }
});

test('P1 C4: renderCanvasItems clearing focusNodeId (text editor owns focus, 7d1382eb) means paint hands no card focus back', async () => {
  const h = await harness();
  h.view.renderCanvasItems = () => { h.view.focusNodeId = null; };
  h.view.render();
  leafCard(h).focus(); h.focused.length = 0;
  h.view.render();
  assert.ok(h.active() === h.doc.body);
  assert.equal(h.focused.length, 0);
});

test('P1 C5: a non-card control (map title button) is handed back by holdMapFocus as the new button', async () => {
  const h = await harness();
  h.view.render();
  const old = h.contentEl.querySelector('.vam-map-title-button'); old.focus();
  h.view.render();
  const now = h.contentEl.querySelector('.vam-map-title-button');
  assert.ok(now !== old);
  assert.ok(h.active() === now);
  assert.ok(h.log.includes('keepMapFocus'));
});

test('P1 C6: with a text editor open (editingTextId) holdMapFocus does not restore; focus ends on the body', async () => {
  const h = await harness();
  h.view.render();
  h.contentEl.querySelector('.vam-map-title-button').focus();
  h.view.editingTextId = 'text-1';
  h.view.render();
  assert.ok(h.active() === h.doc.body);
});

test('P1 C7: the map\'s own redraw (renderPreservingFocus) restores even when activeWindow is another window; nothing is left pending', async () => {
  const h = await harness();
  h.view.render();
  const old = h.contentEl.querySelector('.vam-map-title-button'); old.focus();
  goOther(h);
  h.view.renderPreservingFocus();
  const now = h.contentEl.querySelector('.vam-map-title-button');
  assert.ok(now !== old);
  assert.ok(h.active() === now);
  assert.equal(h.view.focusRestorePending, false, '07c0070c: only refreshFromPlugin is gated');
});

// Each start returns the element to focus; `setup` runs once before the first render.
function starts(h) {
  return {
    'title button': { pick: () => h.contentEl.querySelector('.vam-map-title-button') },
    'card': { pick: () => leafCard(h) },
    'search input': {
      setup: () => { h.view.mapSearch = { query: 'le', currentId: null, announceTimer: null }; },
      pick: () => { const i = h.view.mapSearchBar.input; i.setSelectionRange(2, 4); return i; }
    },
    'goal edit field': {
      setup: () => { h.view.goalEdit = { path: MAP, goal: 'sleep', context: '', showContext: false, caret: 2, contextCaret: null, field: 'goal', refocus: true, warmed: false }; },
      pick: () => h.view.goalEditInput
    },
    'relevance bar button': {
      setup: () => { h.plugin.relevanceGrades.set(MAP, { status: 'failed', message: 'x' }); },
      pick: () => h.contentEl.querySelector('.vam-relevance-statusbar').querySelector('button')
    }
  };
}

test('P1 C8: refreshFromPlugin while another window is active moves no map focus, remembers it, and gives it back once on window focus', async () => {
  for (const name of Object.keys(starts(await harness()))) {
    const h = await harness();
    const s = starts(h)[name];
    s.setup?.();
    h.view.render();
    const el = s.pick(); assert.ok(el, name);
    el.focus();
    const id = ident(el);
    goOther(h);
    h.focused.length = 0;
    await h.view.refreshFromPlugin();
    assert.equal(inMap(h) && h.active() !== h.contentEl, false, `${name}: no map element focused`);
    assert.equal(h.view.focusRestorePending, true, name);
    assert.equal(h.view.externalRefresh, false, name);
    assert.equal(h.focused.length, 0, `${name}: no focus event at all`);
    goMap(h);
    h.view.onMapWindowFocus();
    assert.equal(h.view.focusRestorePending, false, name);
    assert.equal(ident(h.active()), id, `${name}: same identity, new element`);
    assert.ok(h.active() !== el, name);
    const after = h.active(); const count = h.focused.length;
    h.view.onMapWindowFocus();
    assert.ok(h.active() === after, `${name}: a second window focus is a no-op`);
    assert.equal(h.focused.length, count);
  }
});

test('P1 C9: refreshFromPlugin with the map window active returns focus to the same identity in every start', async () => {
  for (const name of Object.keys(starts(await harness()))) {
    const h = await harness();
    const s = starts(h)[name];
    s.setup?.();
    h.view.render();
    const el = s.pick(); el.focus();
    const id = ident(el);
    await h.view.refreshFromPlugin();
    assert.ok(h.active() !== el, `${name}: a new element`);
    assert.equal(ident(h.active()), id, name);
    assert.equal(h.view.focusRestorePending, false, name);
  }
});

test('P1 C10: an open search box keeps focus and its 2-4 selection; the marks are applied after the presentation marks', async () => {
  const h = await harness();
  h.view.mapSearch = { query: 'le', currentId: null, announceTimer: null };
  h.view.render();
  const input = h.view.mapSearchBar.input; input.focus(); input.setSelectionRange(2, 4);
  h.log.length = 0;
  h.view.render();
  const now = h.view.mapSearchBar.input;
  assert.ok(now !== input);
  assert.ok(h.active() === now);
  assert.deepEqual(now.selection, [2, 4]);
  assert.ok(h.log.indexOf('applyPresentationMarks') < h.log.indexOf('restoreSearch'));
  assert.ok(h.log.indexOf('restoreSearch') < h.log.indexOf('applySearchMarks'), 'applySearchMarks runs inside the search restorer, after the presentation marks');
});

test('P1 C11: in presentation mode the leaf card is marked, the new leaf card is focused, and the marks see every card', async () => {
  const h = await harness();
  h.view.focusNode = () => {};
  h.view.render();
  h.view.presentation = { order: [], currentId: h.ids.leaf, viewport: { x: 0, y: 0, zoom: 1 }, returnNodeId: null, returnEl: null };
  leafCard(h).focus();
  let seen = 0;
  const real = h.view.applyPresentationMarks;
  h.view.applyPresentationMarks = function (...a) { seen = h.view.cardEls.size; return real.apply(this, a); };
  h.view.render();
  assert.equal(seen, 2);
  assert.ok(leafCard(h).classes.has('is-presenting'));
  assert.equal(h.contentEl.dataset.presenting, 'true');
  assert.ok(h.active() === leafCard(h));
});

function fakeChat(h) {
  const chat = {
    button: h.contentEl.add('button', { cls: 'vam-chat-send' }),
    isInput: () => false, holdsFocus: el => el === chat.button, relabel() {}, refreshReplyUndo() {}, detach() { chat.button.detach(); },
    captureFocus: () => () => { chat.button = h.contentEl.add('button', { cls: 'vam-chat-send' }); h.log.push('chat.restore'); chat.button.focus(); }
  };
  return chat;
}

test('P1 C12a: a held chat button gets focus back after render; under an external refresh with another window active it does not (8663ed4a)', async () => {
  const h = await harness();
  h.view.chat = fakeChat(h);
  h.view.render();
  h.view.chat.button.focus();
  h.view.render();
  assert.ok(h.active() === h.view.chat.button);
  assert.ok(h.log.includes('chat.restore'));
  const h2 = await harness();
  h2.view.chat = fakeChat(h2);
  h2.view.render();
  h2.view.chat.button.focus();
  goOther(h2);
  h2.log.length = 0;
  await h2.view.refreshFromPlugin();
  assert.ok(!h2.log.includes('chat.restore'));
  assert.equal(h2.active(), h2.doc.body);
  assert.equal(h2.view.focusRestorePending, true);
});

test('P1 C12b: a focused card removed from map.nodes leaves focus on the body; restoreMapFocus(null) then lands on contentEl', async () => {
  const h = await harness();
  h.view.render();
  leafCard(h).focus();
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.leaf);
  h.view.render();
  assert.ok(h.active() === h.doc.body);
  h.view.restoreMapFocus(null);
  assert.ok(h.active() === h.contentEl);
});

// Observed inconsistency, recorded as-is: only some restore paths consult mapWindowIsActive. The card handoff in paint reads
// activeDocument (not the gate), so when activeDocument is still the map's document but activeWindow is another window, an external
// refresh still takes focus for the card, which the gated paths (title button, search, goal edit, chat) would not.
test('P1 observed: the card handoff is not gated by mapWindowIsActive (title button is)', async () => {
  const h = await harness();
  h.view.render();
  leafCard(h).focus();
  globalWin.activeWindow = other().win;
  await h.view.refreshFromPlugin();
  assert.ok(h.active() === leafCard(h), 'ungated: the card took focus although another window is active');
  h.contentEl.querySelector('.vam-map-title-button').focus();
  await h.view.refreshFromPlugin();
  assert.ok(h.active() === h.doc.body, 'gated: the title button did not');
});
