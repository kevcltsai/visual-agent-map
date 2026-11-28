// F07b: a relation added through the chat write path to a knowledge reference of the map writes Map.md only; the note of the
// card end gets exactly what the same relation to an ordinary card would write there (no line, heading or key about the reference).
// Real Repository, view and transaction (as steps-relation-refresh); the plugin's rebuild is the real one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, toggleClass() {}, addEventListener() {}, appendChild(c) { this.children.push(c); } });
const plain = value => JSON.parse(JSON.stringify(value));

async function harness() {
  const { repo, app, contents } = fixture('en');
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  const mapPath = await repo.createMap('Cross');
  const doc = await repo.readMap(mapPath);
  const ids = {}, paths = {};
  for (const key of ['root', 'alpha', 'beta']) {
    const node = await repo.createNote(key.toUpperCase(), 'gpt-6-luna', doc, mapPath, 'workspace');
    node.parentId = key === 'root' ? null : ids.root;
    doc.nodes.push(node);
    ids[key] = node.id;
    paths[key] = node.path;
  }
  doc.knowledgeRefs = [{ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: ids.alpha, x: 300, y: 0, pathHint: 'Mind Maps/Other/Map.md' }];
  await repo.saveMap(mapPath, doc);
  await repo.rebuildDerivedData();
  const plugin = withExpansionCoordinator({
    repo, settings: repo.settings, running: new Set(), logs: { appendLog() {} },
    rebuildDerivedData: scope => repo.rebuildDerivedData(scope ? { roots: [], paths: scope } : undefined),
    expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {};
  view.enqueue = work => work();
  await view.hydrate();
  return { contents, ids, paths, view, mapPath };
}
const relate = (h, fromId, toId) => h.view.chatWriter.chatChangeRelation({ kind: 'add_relation', fromId, toId, relationKind: 'supports' }, id => id);

test('F07b write path: add_relation card -> reference leaves the card note byte-identical and writes the relation in Map.md only', async () => {
  const h = await harness();
  const before = new Map(h.contents);
  assert.deepEqual(plain(await relate(h, h.ids.alpha, 'ref-1')), { status: 'done' });
  assert.deepEqual(plain((await h.view.plugin.repo.readMap(h.mapPath)).topicRelations), [{ kind: 'supports', from: h.ids.alpha, to: 'ref-1' }]);
  const changed = [...h.contents.keys()].filter(path => h.contents.get(path) !== before.get(path));
  assert.deepEqual(changed.filter(path => !path.endsWith('/Map.md')), [], `notes changed: ${changed.join(', ')}`);
  assert.ok(changed.some(path => path.endsWith('/Map.md')), 'Map.md carries the relation');
});

test('F07b write path: an ordinary card relation rewrites the two end notes only with its own Reference Links line (control)', async () => {
  const h = await harness();
  const before = new Map(h.contents);
  assert.deepEqual(plain(await relate(h, h.ids.alpha, h.ids.beta)), { status: 'done' });
  const changed = [...h.contents.keys()].filter(path => h.contents.get(path) !== before.get(path) && !path.endsWith('/Map.md'));
  assert.deepEqual(changed.sort(), [h.paths.alpha, h.paths.beta].sort());
  assert.match(h.contents.get(h.paths.alpha), /Supports: \[\[/);
});

// What changed in a live alpha.md was the note's own rebuild (a note whose derived Reference Links block was stale or absent is
// rewritten into the current shape by any relation write), not a line about the reference.
const stale = (h, path) => h.contents.set(path, h.contents.get(path).replace(/\n## Reference Links\n[\s\S]*?<!-- visual-agent-map:references:end -->\n?/, '\n'));

test('F07b write path: a note with a stale Reference Links block is refreshed the same way for a reference end and for a card end, and never mentions the reference', async () => {
  const h = await harness();
  stale(h, h.paths.alpha);
  const staleText = h.contents.get(h.paths.alpha);
  assert.doesNotMatch(staleText, /Reference Links/, 'precondition: block removed');
  await relate(h, h.ids.alpha, 'ref-1');
  const afterRef = h.contents.get(h.paths.alpha);
  assert.notEqual(afterRef, staleText, 'the rebuild restores the derived block');
  assert.doesNotMatch(afterRef, /ref-1|Supports:|Supported by:|Mind Maps\/Other/);
  const extra = afterRef.split('\n').filter(line => !staleText.split('\n').includes(line));
  assert.ok(extra.every(line => /Reference Links|Topic:|Mind map:|Parent topic:|Child topics:|references:|^\s*$|^- /.test(line) || line.includes('agent-map-references')), `unexpected lines: ${JSON.stringify(extra)}`);
  const c = await harness();
  stale(c, c.paths.alpha);
  await relate(c, c.ids.alpha, c.ids.beta);
  const afterCard = c.contents.get(c.paths.alpha).split('\n').filter(line => !/Supports: /.test(line)).join('\n');
  assert.equal(afterRef.replace(/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}/g, 'ID'), afterCard.replace(/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}/g, 'ID'), 'same as the ordinary-card relation minus its own relation line');
});
