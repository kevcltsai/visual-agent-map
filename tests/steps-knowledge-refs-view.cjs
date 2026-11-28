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
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice, Menu, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment, setTimeout, clearTimeout });
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
