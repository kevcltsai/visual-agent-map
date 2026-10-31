// P8 (44): file side of OPML / FreeMind exchange. A refused import (oversize, DOCTYPE) says why and creates nothing;
// an export never overwrites an existing file and is allowed for any map.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, fixture } = require('./support.cjs');

const notices = [];
const stubbed = { ...obsidian, Notice: class { constructor(message) { notices.push(String(message)); } } };
const io = load('experiences/visual-map/outline-exchange-io.ts', { obsidian: stubbed });
const plain = value => JSON.parse(JSON.stringify(value));
const opml = body => `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>T</title></head><body>${body}</body></opml>`;
const host = () => { const calls = []; return { calls, importOutline: async request => { calls.push(plain(request)); } }; };
const file = (name, text, size = Buffer.byteLength(text)) => ({ name, size, text: async () => text });

test('a DOCTYPE file is refused with the reason and creates no map', async () => {
  notices.length = 0; const h = host();
  const text = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><opml><body><outline text="&a;"/></body></opml>';
  assert.equal(await io.importExchangeFile(h, file('evil.opml', text)), false);
  assert.equal(h.calls.length, 0);
  assert.equal(notices.length, 1); assert.match(notices[0], /evil\.opml/); assert.match(notices[0], /DOCTYPE/);
});

test('an oversize file is refused from its size alone, without being read', async () => {
  notices.length = 0; const h = host(); let read = 0;
  const big = { name: 'big.opml', size: 6 * 1024 * 1024, text: async () => { read++; return ''; } };
  assert.equal(await io.importExchangeFile(h, big), false);
  assert.equal(read, 0); assert.equal(h.calls.length, 0);
  assert.match(notices[0], /larger than 5 MB/);
});

test('a text that grows past the limit after reading is still refused', async () => {
  notices.length = 0; const h = host();
  const text = opml('<outline text="a"/>'.repeat(10)) + ' '.repeat(5 * 1024 * 1024);
  assert.equal(await io.importExchangeFile(h, file('lying.opml', text, 10)), false);
  assert.equal(h.calls.length, 0); assert.match(notices[0], /larger than 5 MB/);
});

test('an unreadable file and a malformed file create nothing', async () => {
  notices.length = 0; const h = host();
  assert.equal(await io.importExchangeFile(h, { name: 'a.opml', size: 1, text: async () => { throw new Error('boom'); } }), false);
  assert.equal(await io.importExchangeFile(h, file('b.opml', '<opml><body><outline text="x"></body>')), false);
  assert.equal(h.calls.length, 0); assert.equal(notices.length, 2);
  assert.match(notices[0], /could not be read/); assert.match(notices[1], /not a valid/);
});

test('an accepted file reaches the new-map flow with its topics and the file name as source', async () => {
  notices.length = 0; const h = host();
  assert.equal(await io.importExchangeFile(h, file('plan.opml', opml('<outline text="Root"><outline text="Kid"/></outline>'))), true);
  assert.equal(h.calls.length, 1);
  const request = h.calls[0];
  assert.equal(request.source, 'plan.opml'); assert.equal(request.shallowResearch, false); assert.equal(request.placement, undefined);
  assert.deepEqual(request.nodes.map(n => [n.title, n.parent]), [['Root', null], ['Kid', 0]]);
  assert.equal(notices.length, 0);
});

test('an import that throws is reported and returns false', async () => {
  notices.length = 0;
  const failing = { importOutline: async () => { throw new Error('map folder exists'); } };
  assert.equal(await io.importExchangeFile(failing, file('p.opml', opml('<outline text="R"/>'))), false);
  assert.match(notices[0], /map folder exists/);
});

const MAP_PATH = 'Agent Workspace/Topics/map-x/Map.md';
const mapOf = () => ({ title: 'Plan: A/B?', nodes: [{ id: 'r', parentId: null }, { id: 'c', parentId: 'r' }] });
const notesOf = () => new Map([['r', { title: 'Root', detail: 'root text' }], ['c', { title: 'Kid', detail: '' }]]);

test('export writes next to the map and a second export takes a new name without touching the first', async () => {
  const { app, contents } = fixture('en');
  await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Topics'); await app.vault.createFolder('Agent Workspace/Topics/map-x');
  const request = format => ({ mapPath: MAP_PATH, map: mapOf(), notes: notesOf(), format });
  const first = await io.exportMapExchange(app.vault, request('opml'));
  assert.equal(first, 'Agent Workspace/Topics/map-x/Plan A B.opml');
  const original = contents.get(first);
  assert.match(original, /<outline text="Root" _note="root text">/);
  contents.set(first, 'user edited this');
  const second = await io.exportMapExchange(app.vault, request('opml'));
  assert.equal(second, 'Agent Workspace/Topics/map-x/Plan A B 2.opml');
  assert.equal(contents.get(first), 'user edited this');
  const third = await io.exportMapExchange(app.vault, request('opml'));
  assert.equal(third, 'Agent Workspace/Topics/map-x/Plan A B 3.opml');
  const mm = await io.exportMapExchange(app.vault, request('freemind'));
  assert.equal(mm, 'Agent Workspace/Topics/map-x/Plan A B.mm');
  assert.match(contents.get(mm), /<map version="1\.0\.1">/);
});

test('export skips a name that exists only on disk, and one that create reports as existing', async () => {
  const { app, contents } = fixture('en');
  const folder = 'Agent Workspace/Topics/map-x';
  const hidden = new Set([`${folder}/Plan A B.opml`]);
  const vault = { getAbstractFileByPath: () => null, adapter: { exists: async p => hidden.has(p) },
    create: async (p, text) => { if (p === `${folder}/Plan A B 2.opml`) throw new Error('File already exists.'); contents.set(p, text); return {}; } };
  const path = await io.exportMapExchange(vault, { mapPath: MAP_PATH, map: mapOf(), notes: notesOf(), format: 'opml' });
  assert.equal(path, `${folder}/Plan A B 3.opml`);
  void app;
});

test('export reports other write failures instead of retrying, and shows the path on success', async () => {
  notices.length = 0;
  const { app } = fixture('en');
  await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Topics'); await app.vault.createFolder('Agent Workspace/Topics/map-x');
  const request = { mapPath: MAP_PATH, map: mapOf(), notes: notesOf(), format: 'opml' };
  assert.equal(await io.exportMapWithNotice(app.vault, request), 'Agent Workspace/Topics/map-x/Plan A B.opml');
  assert.match(notices[0], /Exported to Agent Workspace\/Topics\/map-x\/Plan A B\.opml/);
  const broken = { ...app.vault, getAbstractFileByPath: () => null, adapter: { exists: async () => false }, create: async () => { throw new Error('disk full'); } };
  assert.equal(await io.exportMapWithNotice(broken, request), null);
  assert.match(notices[1], /Export failed: disk full/);
});

test('file stem: reserved characters go, empty becomes "map", length is capped', () => {
  assert.equal(io.exchangeFileStem('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(io.exchangeFileStem('///'), 'map'); assert.equal(io.exchangeFileStem('..hidden'), 'hidden');
  assert.equal(io.exchangeFileStem('x'.repeat(300)).length, 80);
});

// The real view: the tab's More-options menu carries the two export items, and a read-only (AIM) map has them too.
const { DEFAULT_SETTINGS, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
async function viewHarness({ aim }) {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en' }; repo.settings = settings;
  const mapDoc = { id: 'map-x', title: 'Exported', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-x');
  const root = await repo.createNote('Root', 'gpt-6-luna', mapDoc, MAP_PATH, 'workspace', { detail: 'Root detail' });
  Object.assign(root, { parentId: null, x: 80, y: 80 }); mapDoc.nodes.push(root);
  await app.vault.create(MAP_PATH, core.serializeMap(mapDoc));
  const ItemView = class { constructor(leaf) { this.app = leaf.app; } onPaneMenu() {} };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...stubbed, ItemView, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({ repo, settings, running: new Set(), logs: { appendLog() {} }, relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map() });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP_PATH; view.map = await repo.readMap(MAP_PATH);
  if (aim) view.map.aim = { version: 1 }; // read-only in the view; never serialized here
  view.notes = new Map([[root.id, await repo.readNote(root.path)]]);
  return { view, contents };
}
const paneMenu = view => { const items = []; const menu = { addSeparator() { items.push('---'); return this; }, addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, onClick(h) { this.click = h; return this; } }; cb(item); items.push(item); return this; } }; view.onPaneMenu(menu, 'more-options'); return items; };
for (const aim of [false, true])
  test(`view menu: export as OPML and FreeMind from ${aim ? 'a read-only AIM map' : 'an editable map'}`, async () => {
    notices.length = 0;
    const { view, contents } = await viewHarness({ aim });
    const items = paneMenu(view);
    assert.deepEqual(items.map(i => (i === '---' ? i : i.title)), ['---', 'Export as OPML', 'Export as FreeMind (.mm)']);
    const before = contents.get(MAP_PATH);
    items[1].click(); items[2].click();
    for (let i = 0; i < 20 && notices.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(notices, ['Exported to Agent Workspace/Topics/map-x/Exported.opml', 'Exported to Agent Workspace/Topics/map-x/Exported.mm']);
    assert.match(contents.get('Agent Workspace/Topics/map-x/Exported.opml'), /text="Root"/);
    assert.equal(contents.get(MAP_PATH), before, 'the map is not edited');
  });
test('view menu: no map, no export items', async () => {
  const { view } = await viewHarness({ aim: false }); view.map = null;
  assert.deepEqual(paneMenu(view), []);
});
