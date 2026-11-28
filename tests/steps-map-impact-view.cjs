// F09 impact analysis, the view layer: the card menu entry and the read-only result handed to the chat window (zero writes, this map only).
// Same harness as tests/steps-knowledge-refs-view.cjs.
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
  host.topicRelations = [{ kind: 'supports', from: root.id, to: kid.id }];
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
const cardMenu = (h, nodeId) => { const node = h.view.map.nodes.find(n => n.id === nodeId); h.view.addCardMenuActions(new (h.view.newMenu().constructor)(), node); return h.menus.at(-1).items; };
const snapshot = h => JSON.stringify([...h.contents.entries()]);

test('F09 the card right-click menu has Impact analysis; it is also there on an AIM map and while the topics are being picked (it writes nothing)', async () => {
  const h = await harness();
  assert.equal(cardMenu(h, h.ids.root).filter(i => i.title === 'Impact analysis').length, 1);
  const aim = await harness({ aim: true });
  assert.equal(cardMenu(aim, aim.ids.kid).filter(i => i.title === 'Impact analysis').length, 1, 'AIM map');
  h.view.selection.toggleMultiSelect();
  assert.equal(cardMenu(h, h.ids.kid).filter(i => i.title === 'Impact analysis').length, 1, 'picking');
});

test('F09 while the notes load the Impact analysis row is greyed with "notes loading" and does nothing; once loaded it is enabled (decision #35)', async () => {
  const h = await harness();
  const row = () => cardMenu(h, h.ids.root).find(i => i.title === 'Impact analysis');
  assert.ok(!row().disabled, 'loaded: enabled');
  h.view.noteLoad = { framed: false };
  assert.equal(row().disabled, true, 'loading: greyed');
  h.view.noteLoad = null;
  assert.ok(!row().disabled, 'loaded again: enabled');
});

test('F09 choosing it hands the chat window a read-only result: direct (relation, subtopic, reference card by the title already read) and speculative apart; no write', async () => {
  const h = await harness();
  await h.settle();
  const shown = [];
  h.view.chat = { showImpact: result => shown.push(result) };
  const before = snapshot(h);
  cardMenu(h, h.ids.kid).find(i => i.title === 'Impact analysis').click();
  await h.settle();
  assert.equal(shown.length, 1);
  const result = JSON.parse(JSON.stringify(shown[0]));
  assert.equal(result.targetId, h.ids.kid); assert.equal(result.targetTitle, 'Kid');
  assert.deepEqual(result.direct.map(i => [i.nodeId, i.kinds.join()]), [[h.ids.root, 'relation'], [h.ids.kid, 'reference']]);
  assert.equal(result.direct[1].title, 'Original card', 'the title the view already read; no other map is read here');
  assert.deepEqual(result.speculative, []);
  assert.equal(snapshot(h), before, 'zero writes: no file changed or was created');
  assert.equal(h.view.map.nodes.length, 2);
});

test('F09 a card that mentions the title is only a guess, labelled with what matched; with the panel gone nothing is shown and nothing breaks', async () => {
  const h = await harness();
  const root = h.view.notes.get(h.ids.root); root.summary = 'Depends on Kid for pricing';
  const shown = [];
  h.view.chat = { showImpact: result => shown.push(result) };
  await h.view.showCardImpact(h.ids.kid);
  const guess = JSON.parse(JSON.stringify(shown[0].speculative));
  assert.deepEqual(guess, []); // root is already direct through its relation
  h.view.map.topicRelations = [];
  await h.view.showCardImpact(h.ids.kid);
  const result = JSON.parse(JSON.stringify(shown[1]));
  assert.deepEqual(result.speculative.map(i => [i.nodeId, i.matched, i.section]), [[h.ids.root, 'Kid', 'speculative']]);
  assert.deepEqual(result.direct.map(i => i.kinds.join()), ['reference']);
  h.view.chat = undefined; await h.view.showCardImpact(h.ids.kid);
  assert.equal(shown.length, 2);
});
