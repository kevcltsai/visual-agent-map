// 0.28 ticket 34 P2: in-map search (Mod+F). Real view + repository; the DOM is the stand-in from tests/support-dom.cjs.
// Covers the key interception rules, title matching, jumping with folds, screen-reader text, render survival, Esc focus.
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
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
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
  const visible = () => view.canvasNodes(); // what the canvas draws, including a branch the search opens for itself (B14)
  let renders = 0;
  const carets = [];
  const build = () => {
    view.contentEl.empty(); const overlay = view.contentEl.createDiv('vam-canvas-overlay');
    const makeDiv = overlay.createDiv.bind(overlay); // records caret restores on the search field
    overlay.createDiv = value => { const box = makeDiv(value); const makeEl = box.createEl.bind(box); box.createEl = (name, v) => { const el = makeEl(name, v); if (name === 'input') el.setSelectionRange = (a, b) => carets.push([a, b]); return el; }; return box; };
    view.cardEls.clear(); stage.children = []; view.selection.resetTabStop(view.map.nodes.map(n => ({ id: n.id, parentId: n.parentId ?? null })));
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

test('34: titles match case-insensitively in Chinese and English, Traditional matches Simplified; the title still matches without any body', async () => {
  const h = await harness();
  h.press(h.card('alpha'));
  h.type('ALPHA');
  assert.ok(h.card('alpha').classes.has('is-search-match'));
  assert.ok(!h.card('beta').classes.has('is-search-match'));
  h.type('市场'); // Simplified query against a Traditional-looking title
  assert.ok(h.card('beta').classes.has('is-search-match'), 'fold-insensitive');
  assert.ok(!h.card('alpha').classes.has('is-search-match'));
});

// C08: the summary and the Detail are searched too, from the notes the view already holds.
const withBodies = h => {
  h.view.notes.get(h.ids.beta).summary = '價格調查摘要';
  h.view.notes.get(h.ids.alpha).detail = 'Long detail mentioning the zebra crossing.';
  h.view.notes.get(h.ids.deep).detail = 'Hidden zebra inside two folded levels.';
};

test('C08: a word only in the Detail or summary finds the card; a word in neither finds nothing; Traditional and Simplified match in the body', async () => {
  const h = await harness();
  withBodies(h);
  h.press(h.card('alpha')); h.type('zebra');
  assert.ok(h.card('alpha').classes.has('is-search-match'), 'Detail hit');
  assert.ok(!h.card('beta').classes.has('is-search-match'));
  h.type('价格'); // Simplified query, Traditional summary
  assert.ok(h.card('beta').classes.has('is-search-match'), 'summary hit, fold-insensitive');
  h.type('nowhere-at-all');
  for (const key of ['root', 'alpha', 'beta', 'branch']) assert.ok(!h.card(key).classes.has('is-search-match'));
  assert.equal(h.bar().root.children.find(c => c.cls.includes('vam-map-search-count')).text, 'No matches');
});

test('C08: two cards with the same title in different files are both listed, not merged', async () => {
  const h = await harness({ collapse: false });
  h.view.notes.get(h.ids.deep2).title = 'Alpha plan';
  assert.notEqual(h.view.map.nodes.find(n => n.id === h.ids.deep2).path, h.view.map.nodes.find(n => n.id === h.ids.alpha).path);
  h.press(h.card('alpha')); h.type('alpha plan');
  assert.ok(h.card('alpha').classes.has('is-search-match'));
  assert.ok(h.card('deep2').classes.has('is-search-match'));
  assert.equal(h.view.mapSearchResult().matches.length, 2);
});

test('C08: a body hit inside folded branches opens them for the search only; Map.md is byte-identical afterwards; Enter speaks (in text)', async () => {
  const h = await harness();
  withBodies(h);
  const before = h.contents.get(MAP);
  assert.equal(h.card('deep'), undefined);
  h.press(h.card('alpha')); h.type('hidden zebra');
  h.keydown('Enter'); await h.settle();
  assert.ok(h.card('deep'), 'the card in the folded branch is drawn');
  assert.ok(h.card('deep').classes.has('is-search-current'));
  assert.equal(h.centred.at(-1).id, h.ids.deep);
  assert.match(h.spoken(), /^1\/1: Deep Needle \(in text\)$/);
  h.keydown('Escape'); await h.settle();
  assert.equal(h.card('deep'), undefined, 'folded again');
  assert.equal(h.contents.get(MAP), before, 'Map.md bytes unchanged');
});

test('C08: a title hit is spoken without (in text); a body-only hit is spoken with it', async () => {
  const h = await harness({ collapse: false });
  withBodies(h);
  h.press(h.card('alpha')); h.type('alpha');
  h.keydown('Enter'); await h.settle();
  assert.ok(!/in text/.test(h.spoken()), h.spoken());
  withBodies(h); // the harness reloads the notes after a jump; put the bodies back
  h.type('zebra');
  h.view.mapSearch.currentId = null;
  h.keydown('Enter'); await h.settle();
  assert.match(h.spoken(), /\(in text\)$/);
});

test('C08: a fresh view with the same notes gives the same result for the same query', async () => {
  const a = await harness(); withBodies(a); a.press(a.card('alpha')); a.type('zebra');
  const b = await harness(); withBodies(b); b.press(b.card('alpha')); b.type('zebra');
  const titles = h => h.view.mapSearchResult().matches.map(id => h.view.notes.get(id).title);
  assert.deepEqual([...titles(a)], [...titles(b)]);
  assert.ok(titles(a).length >= 2);
});

test('C08: one keystroke computes the search result once for marks, count and announcement', async () => {
  const h = await harness({ collapse: false });
  withBodies(h);
  const note = h.view.notes.get(h.ids.beta);
  let reads = 0; const title = note.title;
  Object.defineProperty(note, 'title', { get() { reads++; return title; }, configurable: true });
  h.press(h.card('alpha'));
  reads = 0; h.type('zebra');
  assert.equal(reads, 1, 'beta title read once while one keystroke marks cards and sets the count');
  h.flushTimers(); // the announcement reuses it
  assert.equal(reads, 1, 'and the delayed announcement does not search again');
  reads = 0; h.type('zebr');
  assert.equal(reads, 1, 'a new query computes again, once');
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

test('34: a match inside two folded levels opens them only for the search: no history, no file change, gone when the search closes', async () => {
  // B14: P1.6 search only opens folded ancestors temporarily; this replaces the old "one history step, undo folds again".
  const h = await harness();
  assert.equal(h.card('deep'), undefined, 'the match starts hidden');
  h.press(h.card('alpha')); h.type('needle');
  const before = h.view.history.past.length;
  const fileBefore = await h.saved();
  const nodesBefore = JSON.stringify(h.view.map.nodes);
  h.keydown('Enter'); await h.settle();
  const map = h.view.map;
  assert.equal(map.nodes.find(n => n.id === h.ids.branch).collapsed, true, 'still folded in the map');
  assert.equal(map.nodes.find(n => n.id === h.ids.inner).collapsed, true);
  assert.equal(h.view.history.past.length, before, 'no history entry');
  assert.equal(JSON.stringify(map.nodes), nodesBefore, 'the stored map (positions too) is untouched');
  assert.deepEqual((await h.saved()).nodes, fileBefore.nodes, 'Map.md reads back the same');
  assert.ok(h.card('deep'), 'the card is drawn');
  assert.ok(h.card('deep').classes.has('is-search-current'), 'and marked current');
  assert.ok(h.card('branch').classes.has('is-temp-open'), 'the opened branch is marked');
  assert.equal(h.centred.at(-1).id, h.ids.deep);
  h.keydown('Enter'); await h.settle();
  assert.equal(h.view.history.past.length, before, 'the second match is already visible: still no entry');
  assert.ok(h.card('deep2'));
  h.keydown('Escape'); await h.settle();
  assert.equal(h.card('deep'), undefined, 'closing the search folds the branch view again');
  assert.equal(h.card('deep2'), undefined);
  assert.equal(h.view.map.nodes.find(n => n.id === h.ids.branch).collapsed, true);
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
  const selectedBefore = h.view.selection.state.selected;
  const e = h.keydown('Escape');
  assert.equal(e.prevented, true);
  assert.equal(h.view.mapSearch, null);
  assert.equal(h.bar(), null);
  assert.ok(!h.card('alpha').classes.has('is-search-match'), 'marks cleared');
  assert.ok(!h.card('alpha').classes.has('is-search-current'));
  assert.equal(h.doc.activeElement, h.card('beta'), 'focus is back on the original card');
  assert.equal(h.view.selection.state.selected, selectedBefore, 'the selection is not changed');
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
  assert.match(source.slice(source.indexOf('async onClose()'), source.indexOf('async onClose()') + 600), /closeMapSearch\(false\)/);
  assert.match(source.slice(source.indexOf('private async openMapInMutation'), source.indexOf('private async openMapInMutation') + 700), /closeMapSearch\(false\)/);
  const renderNode = source.slice(source.indexOf('private renderNode('), source.indexOf('private renderNode(') + 4000);
  assert.equal(/is-search/.test(renderNode), false, 'renderNode knows nothing about the search');
});

test('34: the new CSS stays out of the share viewer: every rule starts with .vam-view', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Map search (Mod+F)'), css.indexOf('/* Topic chat:'));
  // The topic chat window's own block is appended after these and is not part of this check.
  const rules = block.split('\n').filter(l => l.trim() && !l.startsWith('/*'));
  assert.ok(rules.length >= 5);
  for (const rule of rules) assert.ok(rule.startsWith('.vam-view '), rule);
});

test('map search: detached field cannot change the current query or close the new bar', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha')); h.type('plan');
  const old = h.bar().input;
  h.view.render();
  old.value = 'needle'; old.fire('input', { target: old });
  old.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.view.mapSearch.query, 'plan');
  assert.equal(h.bar().input.value, 'plan');
  assert.ok(h.card('alpha').classes.has('is-search-match'));
});

test('map search: a queued jump from a closed session cannot jump in its replacement', async () => {
  const h = await harness({ collapse: false });
  const queued = [];
  h.view.enqueue = work => queued.push(work);
  h.press(h.card('alpha')); h.type('plan'); h.keydown('Enter');
  assert.equal(queued.length, 1);
  h.keydown('Escape');
  h.press(h.card('beta')); h.type('市場');
  await queued[0]();
  assert.equal(h.centred.length, 0);
  assert.equal(h.view.mapSearch.query, '市場');
});

test('map search: a canceled announcement callback cannot clear or speak for its replacement', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha')); h.type('a');
  const old = h.timers.at(-1).fn;
  h.type('plan');
  const live = h.timers.at(-1).fn;
  const before = h.spoken();
  old();
  assert.equal(h.spoken(), before);
  assert.ok(h.view.mapSearch.cancelAnnouncement);
  live();
  assert.equal(h.spoken(), '1 matches');
  assert.equal(h.view.mapSearch.cancelAnnouncement, null);
});

test('B14: starting a presentation repaints, so the search-only branch is not in the presentation', async () => {
  const h = await harness();
  h.press(h.card('alpha')); h.type('needle'); h.keydown('Enter'); await h.settle();
  assert.ok(h.card('deep'), 'the search opened the branch');
  h.view.selection.setSelected(h.ids.alpha);
  await h.view.startPresentation();
  assert.equal(h.card('deep'), undefined, 'the temporary cards are gone from the presentation');
  assert.equal(h.view.searchOpen, null);
});

test('B14: a search-opened branch carries a small label that disappears with the search', async () => {
  const h = await harness();
  h.press(h.card('alpha')); h.type('needle'); h.keydown('Enter'); await h.settle();
  const labels = () => h.card('branch').children.filter(c => c.classes.has('vam-search-temp-label') && !c.removed); // the stand-in keeps removed children listed
  assert.equal(labels().length, 1, 'one label on the opened ancestor');
  assert.equal(labels()[0].text, 'Opened for search');
  assert.equal(labels()[0].classes.has('is-search'), false);
  h.view.applySearchMarks();
  assert.equal(labels().length, 1, 'marks redone: still one');
  const kept = labels()[0];
  h.keydown('Escape'); await h.settle();
  assert.equal(kept.removed, true, 'the label is removed when the search closes');
});

test('B32: an outline reveal shows the same opened-for-now mark as search, and removes it when folded back', async () => {
  const h = await harness();
  h.view.viewportEl.toggleClass = () => {};
  const path = h.view.map.nodes.find(n => n.id === h.ids.deep).path;
  assert.equal(await h.view.revealPath(path), true); await h.settle();
  const labels = () => h.card('branch').children.filter(c => c.classes.has('vam-search-temp-label') && !c.removed);
  assert.ok(h.card('branch').classes.has('is-temp-open'), 'the opened ancestor has the dashed mark');
  assert.equal(labels().length, 1, 'one label on it');
  assert.equal(labels()[0].text, 'Opened for search');
  assert.equal(h.view.mapSearch, null, 'no search box is involved');
  const other = h.view.map.nodes.find(n => n.id === h.ids.alpha).path;
  assert.equal(await h.view.revealPath(other), true); await h.settle();
  assert.equal(h.card('branch').classes.has('is-temp-open'), false, 'folded back: mark gone');
  assert.equal(labels().length, 0, 'folded back: label gone');
});

test('B32-x: Esc folds an outline reveal back, and a click on a card off the opened path does too', async () => {
  const reveal = async h => { h.view.viewportEl.toggleClass = () => {}; h.doc.querySelector = () => null; const path = h.view.map.nodes.find(n => n.id === h.ids.deep).path; await h.view.revealPath(path); await h.settle(); };
  const marked = h => h.card('branch')?.classes.has('is-temp-open');
  const esc = h => { const e = { key: 'Escape', target: null, defaultPrevented: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} }; h.view.onMapKeydown(e); return e; };
  const click = (h, key) => h.view.onCardClick({ target: { closest: () => null }, metaKey: false, ctrlKey: false }, h.card(key), h.view.map.nodes.find(n => n.id === h.ids[key]));
  const h = await harness();
  await reveal(h);
  assert.ok(marked(h)); assert.equal(h.view.mapSearch, null);
  assert.equal(esc(h).prevented, true);
  await h.settle();
  assert.equal(h.view.searchOpen, null, 'Esc folded it back');
  assert.equal(h.card('deep'), undefined);
  assert.equal(marked(h), false, 'mark gone');
  const g = await harness();
  await reveal(g);
  click(g, 'deep'); await g.settle();
  assert.ok(g.view.searchOpen, 'a click inside the opened branch keeps it');
  click(g, 'alpha'); await g.settle();
  assert.equal(g.view.searchOpen, null, 'a click elsewhere folded it back');
  assert.equal(g.card('deep'), undefined);
});

test('B32-y: a real pointerdown, pointerup, click on a card off the opened path folds an outline reveal; a card on it keeps it', async () => {
  const reveal = async h => { h.view.viewportEl.toggleClass = () => {}; h.doc.querySelector = () => null; const path = h.view.map.nodes.find(n => n.id === h.ids.deep).path; await h.view.revealPath(path); await h.settle(); };
  const realClick = async (h, key) => {
    const card = h.card(key); const target = { closest: () => null };
    card.handlers.get('pointerdown')({ target, button: 0, clientX: 5, clientY: 5, pointerId: 1, metaKey: false, ctrlKey: false });
    card.handlers.get('pointerup')({ type: 'pointerup', target, button: 0, clientX: 5, clientY: 5, pointerId: 1, metaKey: false, ctrlKey: false });
    h.view.suppressClickUntil = Date.now() + 250; // what a finished press sets, so the click that follows is held back
    card.handlers.get('click')?.({ target, metaKey: false, ctrlKey: false });
    await h.settle();
  };
  const h = await harness();
  h.doc.addEventListener = () => {}; h.doc.removeEventListener = () => {};
  await reveal(h);
  await realClick(h, 'deep');
  assert.ok(h.view.searchOpen, 'a real click inside the opened branch keeps it');
  await realClick(h, 'alpha');
  assert.equal(h.view.searchOpen, null, 'a real click elsewhere folded it back');
  assert.equal(h.card('deep'), undefined);
});

test('B32-y: after a reveal focus is back on the map so Esc folds it; Esc in the chat input does not', async () => {
  const reveal = async h => { h.view.viewportEl.toggleClass = () => {}; h.doc.querySelector = () => null; const path = h.view.map.nodes.find(n => n.id === h.ids.deep).path; await h.view.revealPath(path); await h.settle(); };
  const esc = (h, target) => { const e = { key: 'Escape', target, defaultPrevented: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} }; h.view.onMapKeydown(e); return e; };
  const el = (match) => ({ closest: selector => (selector.split(',').some(s => match.includes(s.trim())) ? el(match) : null), classList: { contains: () => false } });
  const h = await harness();
  const chatButton = el(['.vam-map-chat', 'button']);
  h.doc.activeElement = chatButton;
  await reveal(h);
  assert.equal(h.doc.activeElement, h.view.contentEl, 'the reveal gave focus back to the map content');
  assert.ok(h.view.searchOpen, 'the reveal is open');
  assert.equal(esc(h, el(['.vam-map-chat', 'textarea'])).prevented, false, 'Esc in the chat input is the chat\'s');
  assert.equal(esc(h, chatButton).prevented, false, 'Esc on a chat control is still the chat\'s');
  assert.ok(h.view.searchOpen, 'still open after Esc inside the chat window');
  assert.equal(h.doc.activeElement, h.view.contentEl, 'focus still on the map content');
  assert.equal(esc(h, el([])).prevented, true, 'Esc on the map content is taken');
  await h.settle();
  assert.equal(h.view.searchOpen, null, 'folded back');
});

test('B14: a hit that is already on screen jumps without repainting', async () => {
  const h = await harness({ collapse: false });
  h.press(h.card('alpha')); h.type('plan');
  const before = h.renders();
  h.keydown('Enter'); await h.settle();
  assert.equal(h.renders(), before, 'no render for a visible hit');
  assert.equal(h.centred.at(-1).id, h.ids.alpha);
});

test('B14: the next hit in another folded branch folds the earlier one back and opens the new one', async () => {
  const h = await harness();
  const mapDoc = h.view.map;
  const make2 = async (title, parentId, y) => { const n = await h.repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'inherited'); Object.assign(n, { parentId, x: 400, y }); mapDoc.nodes.push(n); return n; };
  const other = await make2('Other', h.ids.root, 900); other.collapsed = true;
  const far = await make2('Zebra Needle', other.id, 900);
  await h.view.hydrate(); h.build();
  h.press(h.card('alpha')); h.type('needle');
  h.keydown('Enter'); await h.settle();
  assert.ok(h.card('deep'), 'first hit: first branch open');
  assert.equal(h.view.cardEls.get(far.id), undefined);
  h.keydown('Enter'); h.keydown('Enter'); await h.settle();
  assert.ok(h.view.cardEls.get(far.id), 'the new branch is open');
  assert.equal(h.card('deep'), undefined, 'the earlier branch folded back');
  assert.equal(h.card('deep2'), undefined);
  assert.equal(h.view.map.nodes.find(n => n.id === h.ids.branch).collapsed, true);
});

test('B14: an outline reveal into a folded branch opens it for the view only, no collapse write, no history', async () => {
  const h = await harness();
  h.view.viewportEl.toggleClass = () => {};
  const path = h.view.map.nodes.find(n => n.id === h.ids.deep).path;
  const before = h.view.history.past.length;
  const stored = JSON.stringify((await h.saved()).nodes);
  assert.equal(h.card('deep'), undefined);
  assert.equal(await h.view.revealPath(path), true); await h.settle();
  assert.ok(h.card('deep'), 'the card is drawn');
  assert.equal(h.view.map.nodes.find(n => n.id === h.ids.branch).collapsed, true);
  assert.equal(h.view.map.nodes.find(n => n.id === h.ids.inner).collapsed, true);
  assert.equal(h.view.history.past.length, before);
  assert.equal(JSON.stringify((await h.saved()).nodes), stored, 'Map.md unchanged');
  assert.equal(h.centred.at(-1).id, h.ids.deep, 'centered on the topic itself');
});
