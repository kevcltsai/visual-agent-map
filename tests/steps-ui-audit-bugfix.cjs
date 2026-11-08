// UI audit bugfix batch (full-20261107): drag re-parent target order, removing a card whose note file is gone, summary range change in selection mode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-t/Map.md`;

// Root with three children (A, B, C) in a map; the view is wired the way tests/steps-after-text-view.cjs does it.
async function harness() {
  const { repo, app, contents, files } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-t', title: 'T', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-t`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const notes = {};
  for (const [i, title] of ['Root', 'A', 'B', 'C'].entries()) {
    const n = await repo.createNote(title, 'gpt-6-luna', doc, MAP, 'workspace');
    if (i) n.parentId = notes.Root.id;
    Object.assign(n, { x: 80 + i * 340, y: 80 });
    doc.nodes.push(n);
    notes[title] = n;
  }
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  let pending = Promise.resolve();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.mergeUnlocked = () => true;
  view.hydrate = async () => {
    view.notes = new Map();
    for (const n of view.map.nodes) { try { view.notes.set(n.id, await repo.readNote(n.path)); } catch { /* a missing note stays missing */ } }
  };
  await view.hydrate();
  view.render = () => {};
  view.announcer = element('div');
  view.announcer.setText = text => { view.announced = text; };
  const node = title => view.map.nodes.find(n => n.path.includes(`${title}.md`));
  return { repo, app, view, contents, files, notices, node, disk: async () => plain(await repo.readMap(MAP)) };
}

test('S1: dragging onto an EARLIER card in map order finds that card, not the dragged card that sorts later', async () => {
  const h = await harness();
  const [a, b, c] = ['A', 'B', 'C'].map(h.node);
  // Card A (earlier) and the dragged card C (later) overlap under the pointer; C is dragged so it is under the pointer too.
  h.view.cardEls = new Map([
    [a.id, { offsetLeft: 0, offsetTop: 0, offsetWidth: 300, offsetHeight: 180 }],
    [b.id, { offsetLeft: 1000, offsetTop: 0, offsetWidth: 300, offsetHeight: 180 }],
    [c.id, { offsetLeft: 100, offsetTop: 50, offsetWidth: 300, offsetHeight: 180 }]
  ]);
  a.parentId = b.id; // so that dropping C on A is a real change
  const hit = h.view.reparentTargetAt(150, 100, [c], c.id);
  assert.ok(hit, 'a target is found');
  assert.equal(hit.node.id, a.id);
  assert.equal(hit.invalid, false);
  // Only the dragged card under the pointer: no target.
  assert.equal(h.view.reparentTargetAt(380, 220, [c], c.id), null);
});
