// 0.28 ticket 34 P2: in-map search (Mod+F). Real view + repository; the DOM is the stand-in from tests/support-dom.cjs.
// Covers the key interception rules, title matching, jumping with folds, screen-reader text, render survival, Esc focus and the sample map.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;

const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() {}, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  contains(other) { return other === this; }, closest(selector) { return selector.split(',').some(s => this.classes.has(s.trim().slice(1))) ? this : null; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });
const MAP = 'Agent Workspace/Topics/map-s/Map.md';
const TITLES = { root: 'Root', alpha: 'Alpha plan', beta: '市場分析', branch: 'Branch', inner: 'Inner', deep: 'Deep Needle', deep2: 'Needle 二號' };

async function harness({ collapse = true } = {}) {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const mapDoc = { id: 'map-s', title: 'Search', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-s');
  const ids = {};
  const add = async (key, parent, y) => {
    const created = await repo.createNote(TITLES[key], 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', null, 80); await add('alpha', 'root', 80); await add('beta', 'root', 280); await add('branch', 'root', 480);
  await add('inner', 'branch', 480); await add('deep', 'inner', 480); await add('deep2', 'inner', 680);
  if (collapse) { mapDoc.nodes.find(n => n.id === ids.branch).collapsed = true; mapDoc.nodes.find(n => n.id === ids.inner).collapsed = true; }
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const timers = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), setTooltip() {} } },
    { createFragment: dom.createFragment, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const doc = { activeElement: null };
  const stage = make('div');
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = element('div');
  view.contentEl.root = doc; view.contentEl.ownerDocument = doc; view.contentEl.focus = () => { doc.activeElement = view.contentEl; };
  const contains = view.contentEl.contains; view.contentEl.contains = other => contains.call(view.contentEl, other) || other?.nodeId !== undefined; // cards live in the stage stand-in, which is part of the view
  view.viewportEl = { clientWidth: 800, clientHeight: 600 };
  view.announcer = element('div');
  view.openDetails = () => {};
  const centred = [];
  view.focusNode = (node, persist) => { centred.push({ id: node.id, persist }); };
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.hydrate = reload;
  const visible = () => view.map.nodes.filter(n => { for (let p = n.parentId; p;) { const a = view.map.nodes.find(x => x.id === p); if (a.collapsed) return false; p = a.parentId; } return true; });
  let renders = 0;
  const carets = [];
  const build = () => {
    view.contentEl.empty(); const overlay = view.contentEl.createDiv('vam-canvas-overlay');
    const makeDiv = overlay.createDiv.bind(overlay); // records caret restores on the search field
    overlay.createDiv = value => { const box = makeDiv(value); const makeEl = box.createEl.bind(box); box.createEl = (name, v) => { const el = makeEl(name, v); if (name === 'input') el.setSelectionRange = (a, b) => carets.push([a, b]); return el; }; return box; };
    view.cardEls.clear(); stage.children = []; view.tabStopId = view.defaultTabStop(view.map.nodes);
    for (const n of visible()) { view.renderNode(n); }
    for (const [id, card] of view.cardEls) { card.focus = () => { doc.activeElement = card; }; card.contains = other => other === card; card.nodeId = id; }
  };
  view.render = () => { renders++; const restore = view.holdMapSearch(); build(); restore(); };
  await reload(); build();
  const ids2 = ids;
  const card = key => view.cardEls.get(ids2[key]);
  const key = () => view.scope.keys.find(k => k.key === 'f' && k.modifiers.length === 1 && k.modifiers[0] === 'Mod');
  const press = (active, init = {}) => {
    doc.activeElement = active;
    const event = { key: 'f', isComposing: false, defaultPrevented: false, ...init };
    const handled = key().func(event, {});
    return { passedThrough: handled === true, handled };
  };
  const bar = () => view.mapSearchBar;
  const type = text => { const i = bar().input; i.value = text; i.fire('input', { target: i }); };
  const keydown = (name, init = {}) => { const e = { key: name, isComposing: false, shiftKey: false, ...init, prevented: false }; e.preventDefault = () => { e.prevented = true; }; e.stopPropagation = () => {}; bar().input.fire('keydown', e); return e; };
  const settle = async () => { for (let i = 0; i < 20; i++) await dom.tick(); };
  const flushTimers = () => { for (const t of timers.splice(0)) t.fn?.(); };
  return { carets, repo, app, contents, view, plugin, ids, doc, stage, card, press, bar, type, keydown, settle, centred, build, timers, flushTimers, renders: () => renders, saved: () => repo.readMap(MAP), spoken: () => view.announcer.text };
}

test('34: no Mod+F handler runs until the view registers it; the key lives on the view scope', async () => {
  const h = await harness();
  const found = h.view.scope.keys.filter(k => k.key === 'f' && k.modifiers.length === 1 && k.modifiers[0] === 'Mod');
  assert.equal(found.length, 1, 'Mod+F is registered once on the view scope');
});

test('34: Mod+F on a focused card opens the search box, takes the key, and focuses the field', async () => {
  const h = await harness();
  const result = h.press(h.card('alpha'));
  assert.equal(result.handled, false, 'handled: the browser/Obsidian default is suppressed');
  assert.ok(h.bar(), 'the box is built');
  assert.equal(h.bar().root.attrs.role, 'search');
  assert.ok(h.bar().input.attrs['aria-label'], 'the field has an accessible name');
  assert.equal(h.doc.activeElement, h.bar().input, 'focus is in the field');
});

test('34: Mod+F is not taken in a text field, the map chat, outside the view, on a prevented event, or while composing', async () => {
  const h = await harness();
  const inside = (selectorPart) => { const el = element('div'); el.closest = selector => (selector.includes(selectorPart) ? el : null); h.view.contentEl.children.push(el); el.parent = h.view.contentEl; return el; };
  assert.equal(h.press(inside('textarea')).passedThrough, true, 'text field: not intercepted');
  assert.equal(h.press(inside('.vam-map-chat')).passedThrough, true, 'map chat: not intercepted');
  assert.equal(h.press(element('div')).passedThrough, true, 'focus outside the view: not intercepted');
  assert.equal(h.press(h.card('alpha'), { defaultPrevented: true }).passedThrough, true, 'already handled by someone else');
  assert.equal(h.press(h.card('alpha'), { isComposing: true }).passedThrough, true, 'IME composition');
  assert.equal(h.press(null).passedThrough, true, 'no focus at all');
  assert.equal(h.view.mapSearch, null, 'no search was opened by any of them');
});

test('34: Mod+F while the box is open selects the field text instead of reopening or leaving the key to Obsidian', async () => {
  const h = await harness();
  h.press(h.card('alpha')); h.type('abc');
  let selected = 0; h.bar().input.select = () => { selected++; };
  const again = h.press(h.bar().input);
  assert.equal(again.handled, false, 'the key is taken from Obsidian');
  assert.equal(selected, 1, 'text selected');
  h.press(h.card('beta'));
  assert.equal(selected, 2, 'from a card too: focus moves to the field and selects');
  assert.equal(h.doc.activeElement, h.bar().input);
});

test('34: titles match case-insensitively in Chinese and English, Traditional matches Simplified; body text is not searched', async () => {
  const h = await harness();
  h.press(h.card('alpha'));
  h.type('ALPHA');
  assert.ok(h.card('alpha').classes.has('is-search-match'));
  assert.ok(!h.card('beta').classes.has('is-search-match'));
  h.type('市场'); // Simplified query against a Traditional-looking title
  assert.ok(h.card('beta').classes.has('is-search-match'), 'fold-insensitive');
  assert.ok(!h.card('alpha').classes.has('is-search-match'));
});

test('34: a regex-looking query is literal and a blank query matches nothing and says so', async () => {
  const h = await harness();
  h.press(h.card('alpha'));
  h.type('.*(');
  for (const key of ['root', 'alpha', 'beta', 'branch']) assert.ok(!h.card(key).classes.has('is-search-match'), `${key} not matched by a pattern`);
  assert.equal(h.bar().root.children.find(c => c.cls.includes('vam-map-search-count')).text, 'No matches');
  h.type('   ');
  for (const key of ['root', 'alpha', 'beta', 'branch']) assert.ok(!h.card(key).classes.has('is-search-match'), `${key} not highlighted for whitespace`);
  h.flushTimers();
  assert.equal(h.spoken(), 'No matches', 'whitespace only is announced as no matches');
});

test('34: typing is announced once after 300 ms with the count', async () => {
  const h = await harness();
  h.press(h.card('alpha'));
  h.type('a'); h.type('al'); h.type('alpha');
  assert.ok(h.timers.every(t => t.ms === 300), 'one debounce of 300 ms');
  assert.equal(h.timers.filter(t => t.fn).length, 1, 'earlier timers are cancelled');
  assert.notEqual(h.spoken(), '1 matches', 'not spoken before the pause');
  h.flushTimers();
  assert.equal(h.spoken(), '1 matches');
});

test('34: Enter and Shift+Enter jump to the next / previous match, cycle, centre without saving the viewport, and speak position and title', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha'));
  h.type('n'); // Alpha plan, Branch, Inner, Deep Needle, Needle 二號
  const matches = [...h.view.cardEls.entries()].filter(([, c]) => c.classes.has('is-search-match')).map(([id]) => id);
  assert.ok(matches.length >= 3, 'several matches');
  const saved = JSON.stringify((await h.saved()).viewport);
  h.keydown('Enter'); await h.settle();
  assert.equal(h.centred.at(-1).persist, false, 'viewport is not persisted');
  const first = h.centred.at(-1).id;
  assert.ok(h.view.cardEls.get(first).classes.has('is-search-current'));
  assert.match(h.spoken(), new RegExp(`^1/${matches.length}: `));
  assert.equal(h.doc.activeElement, h.bar().input, 'focus stays in the field');
  assert.equal(h.keydown('Enter').prevented, true);
  await h.settle();
  assert.match(h.spoken(), new RegExp(`^2/${matches.length}: `));
  h.keydown('Enter', { shiftKey: true }); await h.settle(); h.keydown('Enter', { shiftKey: true }); await h.settle();
  assert.match(h.spoken(), new RegExp(`^${matches.length}/${matches.length}: `), 'Shift+Enter from the first wraps to the last');
  assert.equal(JSON.stringify((await h.saved()).viewport), saved, 'Map.md viewport untouched');
});

test('34: Enter during IME composition does not jump', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha')); h.type('a');
  const before = h.centred.length;
  h.keydown('Enter', { isComposing: true }); await h.settle();
  assert.equal(h.centred.length, before);
});

test('34: a match inside two folded levels opens both in one history step, and undo folds them again', async () => {
  const h = await harness();
  assert.equal(h.card('deep'), undefined, 'the match starts hidden');
  h.press(h.card('alpha')); h.type('needle');
  const before = h.view.history.past.length;
  h.keydown('Enter'); await h.settle();
  const map = h.view.map;
  assert.equal(map.nodes.find(n => n.id === h.ids.branch).collapsed, false);
  assert.equal(map.nodes.find(n => n.id === h.ids.inner).collapsed, false);
  assert.equal(h.view.history.past.length, before + 1, 'exactly one history entry');
  assert.ok(h.card('deep'), 'the card is drawn');
  assert.ok(h.card('deep').classes.has('is-search-current'), 'and marked current');
  assert.equal(h.centred.at(-1).id, h.ids.deep);
  const disk = await h.saved();
  assert.equal(disk.nodes.find(n => n.id === h.ids.inner).collapsed, false, 'saved');
  h.keydown('Enter'); await h.settle();
  assert.equal(h.view.history.past.length, before + 1, 'the second match is already visible: no new entry');
  await h.view.travel(false);
  const undone = h.view.map;
  assert.equal(undone.nodes.find(n => n.id === h.ids.branch).collapsed, true);
  assert.equal(undone.nodes.find(n => n.id === h.ids.inner).collapsed, true);
});

test('34: the sample map opens folds in memory only (no file, no history)', async () => {
  const h = await harness();
  h.view.builtIn = true;
  const before = h.view.history.past.length;
  const diskBefore = JSON.stringify(await h.saved());
  h.press(h.card('alpha')); h.type('needle');
  h.keydown('Enter'); await h.settle();
  assert.equal(h.view.map.nodes.find(n => n.id === h.ids.inner).collapsed, false, 'opened in memory');
  assert.ok(h.card('deep'));
  assert.equal(h.view.history.past.length, before, 'no history');
  assert.equal(JSON.stringify(await h.saved()), diskBefore, 'nothing written');
});

test('34: a render during the search keeps the query, the current match, the field focus and the caret', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha')); h.type('plan');
  h.keydown('Enter'); await h.settle();
  const input = h.bar().input;
  input.selectionStart = 1; input.selectionEnd = 3;
  h.view.render();
  const rebuilt = h.bar();
  assert.notEqual(rebuilt.input, input, 'the box is rebuilt');
  assert.equal(rebuilt.input.value, 'plan', 'query kept');
  assert.equal(h.view.mapSearch.query, 'plan');
  assert.ok(h.card('alpha').classes.has('is-search-current'), 'current match kept');
  assert.equal(h.doc.activeElement, rebuilt.input, 'the new field has focus');
  assert.deepEqual(h.carets.at(-1), [1, 3], 'caret restored');
});

test('34: a render while focus is NOT in the field does not steal focus', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha')); h.type('plan');
  h.doc.activeElement = h.card('beta');
  h.view.render();
  assert.notEqual(h.doc.activeElement, h.bar().input, 'the field did not take focus');

});

test('34: Esc closes the box, clears the marks and returns focus to the card search began on', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('beta')); h.type('plan');
  assert.ok(h.card('alpha').classes.has('is-search-match'));
  const selectedBefore = h.view.selected;
  const e = h.keydown('Escape');
  assert.equal(e.prevented, true);
  assert.equal(h.view.mapSearch, null);
  assert.equal(h.bar(), null);
  assert.ok(!h.card('alpha').classes.has('is-search-match'), 'marks cleared');
  assert.ok(!h.card('alpha').classes.has('is-search-current'));
  assert.equal(h.doc.activeElement, h.card('beta'), 'focus is back on the original card');
  assert.equal(h.view.selected, selectedBefore, 'the selection is not changed');
});

test('34: Esc after the original card was deleted returns focus to the map pane', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('beta')); h.type('plan');
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.beta);
  h.view.render();
  h.keydown('Escape');
  assert.equal(h.doc.activeElement, h.view.contentEl);
});

test('34: the close button closes like Esc, and switching maps or closing the view clears the search', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('beta')); h.type('plan');
  h.bar().root.children.find(c => c.tag === 'button').click();
  assert.equal(h.view.mapSearch, null);
  h.press(h.card('beta')); h.type('plan');
  await h.view.openMap('Agent Workspace/Topics/other/Map.md').catch(() => {});
  assert.equal(h.view.mapSearch, null, 'another map: closed');
  h.press(h.card('beta') ?? h.view.contentEl);
  const open = h.view.mapSearch;
  await h.view.onClose();
  assert.equal(h.view.mapSearch, null, 'closing the view: cleared');
  void open;
});

test('34: wiring in view.ts: render() restores the search after painting; the search is reset in openMap and onClose; renderNode is untouched', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences', 'visual-map', 'view.ts'), 'utf8');
  const paint = source.slice(source.indexOf('private paint(): void'), source.indexOf('/** What the empty canvas says'));
  assert.match(paint, /const restoreSearch = this\.holdMapSearch\(\);/);
  assert.ok(paint.trimEnd().endsWith('restoreSearch();\n  }'), 'called at the very end of the paint');
  assert.match(source.slice(source.indexOf('async onClose()'), source.indexOf('async onClose()') + 200), /closeMapSearch\(false\)/);
  assert.match(source.slice(source.indexOf('private async openMapInMutation'), source.indexOf('private async openMapInMutation') + 700), /closeMapSearch\(false\)/);
  const renderNode = source.slice(source.indexOf('private renderNode('), source.indexOf('private renderNode(') + 4000);
  assert.equal(/is-search/.test(renderNode), false, 'renderNode knows nothing about the search');
});

test('34: the new CSS stays out of the share viewer: every rule starts with .vam-view', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Map search (Mod+F)'));
  const rules = block.split('\n').filter(l => l.trim() && !l.startsWith('/*'));
  assert.ok(rules.length >= 5);
  for (const rule of rules) assert.ok(rule.startsWith('.vam-view '), rule);
});
