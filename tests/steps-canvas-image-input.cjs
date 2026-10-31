// Map images P3b (ticket 30): the three ways to add a free image (drop, paste, "Insert image…") in the real view.
// Bytes are read first, then acceptImage decides, then a late-result fence, then one transaction writes the attachment
// and the canvas item together. A refusal, a map switch or a failed save leaves no new file and no change in Map.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator, deferred, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-i/Map.md`;
const MEDIA = 'Media';
const MIME = 'application/x-vam-branch';

const png = (w = 400, h = 200, extra = 0) => {
  const b = new Uint8Array(33 + extra);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b.buffer;
};
const file = (data, { type = 'image/png', name = 'pic.png' } = {}) => ({ name, type, size: data.byteLength, arrayBuffer: async () => data });

async function harness({ aim = false, builtIn = false, integration = false } = {}) {
  const { repo, app, contents, files } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-i', title: 'I', version: 1, nodes: [], viewport: { x: 50, y: 20, zoom: 2 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-i`);
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(root);
  await app.vault.create(MAP, core.serializeMap(doc));
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  app.vault.getResourcePath = f => `app://vault/${f.path}`;
  const counts = { createBinary: 0, trashFile: 0 };
  const createBinary = app.vault.createBinary;
  app.vault.createBinary = async (path, data) => { counts.createBinary++; const f = await createBinary(path, data); f.stat.size = data.byteLength; return f; };
  app.vault.readBinary = async f => contents.get(f.path);
  app.fileManager.trashFile = async f => {
    counts.trashFile++;
    const entry = files.get(f.path);
    files.delete(f.path); contents.delete(f.path);
    if (entry?.parent) entry.parent.children = entry.parent.children.filter(c => c !== entry);
  };
  app.fileManager.getAvailablePathForAttachment = async name => {
    if (!files.has(MEDIA)) await app.vault.createFolder(MEDIA);
    const dot = name.lastIndexOf('.'), base = name.slice(0, dot), ext = name.slice(dot);
    let path = `${MEDIA}/${name}`;
    for (let n = 1; files.has(path); n++) path = `${MEDIA}/${base} ${n}${ext}`;
    return path;
  };
  const notices = [], menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(cb) { const item = { title: '', click: null }; cb({ setTitle(v) { item.title = v; return this; }, setIcon() { return this; }, onClick(fn) { item.click = fn; return this; }, setWarning() { return this; } }); this.items.push(item); return this; } addSeparator() { return this; } showAtMouseEvent() { return this; } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Menu } }, { createFragment: dom.createFragment });
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.contentEl.contains = node => !!node?.inside;
  view.viewportEl = element('div');
  view.viewportEl.getBoundingClientRect = () => ({ left: 10, top: 5, right: 810, bottom: 605, width: 800, height: 600 });
  view.viewportEl.clientWidth = 800; view.viewportEl.clientHeight = 600;
  if (aim) view.map.aim = { version: 1 };
  view.builtIn = builtIn; view.integrationMode = integration;
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => { view.stageEl.children = []; view.stageEl.child('div', 'vam-node'); view.renderCanvasItems(); };
  const settle = async () => { await pending; await dom.tick(); await pending; await dom.tick(); };
  const fileText = () => contents.get(MAP);
  const onDisk = async () => { const items = (await repo.readMap(MAP)).canvasItems; return items === undefined ? undefined : plain(items); };
  const mediaFiles = () => [...files.values()].filter(f => f.parent?.path === MEDIA).map(f => f.path).sort();
  return { repo, app, view, counts, settle, fileText, onDisk, notices, menus, mediaFiles, contents, root };
}

const dropEvent = (files, clientX = 110, clientY = 45) => ({ clientX, clientY, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, dataTransfer: { files, types: ['Files'] } });
const clipboardEvent = (data = {}, files = [], target = { inside: true, closest: () => null }) => {
  const store = new Map(Object.entries(data));
  return { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, clipboardData: { files, getData: type => store.get(type) ?? '', setData() {} } };
};

test('counter-example 1: dropping a non-image writes no attachment and does not touch Map.md', async () => {
  const h = await harness();
  const before = h.fileText();
  for (const dropped of [
    file(new TextEncoder().encode('hello').buffer, { type: 'text/plain', name: 'a.txt' }),
    file(new TextEncoder().encode('<svg/>').buffer, { type: 'image/svg+xml', name: 'a.svg' }),
    file(new TextEncoder().encode('not really a png').buffer, { type: 'image/png', name: 'fake.png' })
  ]) {
    const event = dropEvent([dropped]);
    h.view.onCanvasDrop(event);
    await h.settle();
    assert.equal(event.defaultPrevented, true, 'the browser does not open the file');
  }
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.fileText(), before, 'Map.md is byte for byte the same');
  assert.deepEqual(h.mediaFiles(), []);
  assert.equal(h.notices.length, 3, 'each refusal says so');
});

test('counter-example 2: switching the map while the bytes are read writes nothing', async () => {
  const h = await harness();
  const before = h.fileText();
  const gate = deferred();
  const slow = { ...file(png()), arrayBuffer: async () => { await gate.promise; return png(); } };
  h.view.onCanvasDrop(dropEvent([slow]));
  await dom.tick();
  h.view.mapOpenEpoch++;
  gate.resolve();
  await h.settle();
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.fileText(), before);
  assert.deepEqual(h.mediaFiles(), []);
  // A different map path is a switch too, and so is a closed view.
  const other = await harness();
  const slow2 = { ...file(png()), arrayBuffer: async () => { await dom.tick(); other.view.closed = true; return png(); } };
  other.view.onCanvasDrop(dropEvent([slow2]));
  await other.settle();
  assert.equal(other.counts.createBinary, 0);
  const third = await harness();
  const slow3 = { ...file(png()), arrayBuffer: async () => { third.view.path = 'Agent Workspace/Topics/map-z/Map.md'; return png(); } };
  third.view.onCanvasDrop(dropEvent([slow3]));
  await third.settle();
  assert.equal(third.counts.createBinary, 0);
});

test('counter-example 3: Map.md save fails after the attachment exists: that file is trashed once and nothing is added', async () => {
  const h = await harness();
  const before = h.fileText();
  const saveMap = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async () => { throw new Error('injected saveMap'); };
  h.view.onCanvasDrop(dropEvent([file(png())]));
  await h.settle();
  assert.equal(h.counts.createBinary, 1);
  assert.equal(h.counts.trashFile, 1, 'only the new file is trashed, once');
  assert.deepEqual(h.mediaFiles(), []);
  assert.equal(h.fileText(), before);
  assert.ok(h.notices.some(n => /injected saveMap/.test(String(n))), 'the failure is shown');
  h.repo.saveMap = saveMap;
});

test('counter-example 4: the same picture dropped twice reuses one file and adds two items', async () => {
  const h = await harness();
  h.view.onCanvasDrop(dropEvent([file(png())], 110, 45));
  await h.settle();
  h.view.onCanvasDrop(dropEvent([file(png())], 210, 145));
  await h.settle();
  assert.equal(h.counts.createBinary, 1, 'the second drop created no file');
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/pic.png`]);
  const items = await h.onDisk();
  assert.equal(items.length, 2);
  assert.equal(items[0].path, `${MEDIA}/pic.png`);
  assert.equal(items[1].path, items[0].path);
  assert.notEqual(items[0].id, items[1].id);
});

test('a drop lands at the pointer in map units and keeps the picture ratio; undo removes the item and keeps the file', async () => {
  const h = await harness();
  const entries = h.view.history.past.length;
  // viewport {x:50,y:20,zoom:2}, rect at (10,5): client (110,45) is stage ((110-10-50)/2, (45-5-20)/2) = (25,10)
  h.view.onCanvasDrop(dropEvent([file(png(400, 200))], 110, 45));
  await h.settle();
  const [item] = await h.onDisk();
  assert.equal(item.kind, 'image');
  assert.deepEqual([item.x, item.y], [25, 10]);
  assert.ok(Math.abs(item.w / item.h - 2) < 0.01, 'ratio of the picture');
  assert.ok(item.w <= 320 && item.w >= 24);
  assert.equal(h.view.history.past.length, entries + 1, 'one undo step');
  assert.equal(find(h.view.stageEl, i => i.hasClass('vam-canvas-image')) !== undefined, true, 'drawn');
  await h.view.history.undoEntry.undo();
  assert.equal(await h.onDisk(), undefined, 'the item is gone and no empty field is written');
  assert.equal(h.counts.trashFile, 0, 'undo never trashes the file');
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/pic.png`]);
});

test('dragover accepts only files on a map that can be edited', async () => {
  const h = await harness();
  const over = dropEvent([file(png())]);
  h.view.onCanvasDragOver(over);
  assert.equal(over.defaultPrevented, true);
  const text = { ...dropEvent([]), dataTransfer: { files: [], types: ['text/plain'] } };
  h.view.onCanvasDragOver(text);
  assert.equal(text.defaultPrevented, false, 'plain text is not ours');
});

test('D11: AIM, the built-in sample and topic selection mode register no entry; a normal map registers all of them', async () => {
  for (const [name, options] of [['aim', { aim: true }], ['built-in', { builtIn: true }], ['integration', { integration: true }]]) {
    const h = await harness(options);
    h.view.setupCanvasImageInput();
    assert.deepEqual(Object.keys(h.view.viewportEl.listeners), [], name);
    const event = dropEvent([file(png())]);
    h.view.onCanvasDrop(event);
    await h.settle();
    assert.equal(h.counts.createBinary, 0, `${name}: even a direct call writes nothing`);
    const pasted = clipboardEvent({}, [file(png())]);
    h.view.onClipboardEvent('paste', pasted);
    await h.settle();
    assert.equal(h.counts.createBinary, 0, `${name}: paste writes nothing`);
  }
  const h = await harness();
  h.view.setupCanvasImageInput();
  for (const name of ['dragover', 'drop', 'contextmenu']) assert.ok(h.view.viewportEl.listeners[name]?.length, name);
});

test('context menu on the empty canvas offers Insert image; on a card it does not', async () => {
  const h = await harness();
  const picked = [];
  h.view.openCanvasImagePicker = point => picked.push(point);
  const onCard = { clientX: 1, clientY: 1, preventDefault() {}, target: { closest: selector => (selector.includes('.vam-node') ? {} : null) } };
  h.view.onCanvasContextMenu(onCard);
  assert.equal(h.menus.length, 0);
  const empty = { clientX: 110, clientY: 45, preventDefault() {}, target: { closest: () => null } };
  h.view.onCanvasContextMenu(empty);
  assert.equal(h.menus.length, 1);
  assert.deepEqual(h.menus[0].items.map(i => i.title), ['Insert image…']);
  h.menus[0].items[0].click();
  assert.deepEqual(plain(picked), [{ x: 25, y: 10 }]);
});

test('picked files go through the same path: refused and accepted alike', async () => {
  const h = await harness();
  await h.view.insertCanvasImages([file(new TextEncoder().encode('x').buffer, { type: 'image/png', name: 'x.png' })], { x: 0, y: 0 });
  assert.equal(h.counts.createBinary, 0);
  await h.view.insertCanvasImages([file(png(100, 50), { name: 'ok.png' })], { x: 5, y: 6 });
  assert.equal((await h.onDisk()).length, 1);
});

test('D6 counter-example 5: a clipboard with the private format goes to the clipboard group even when it carries an image file', async () => {
  const h = await harness();
  const calls = [];
  h.view.pasteBranches = async (payload, raw) => { calls.push(raw); };
  const payload = JSON.stringify({ v: 1 });
  const event = clipboardEvent({ [MIME]: payload, 'text/plain': 'Root' }, [file(png())]);
  h.view.onClipboardEvent('paste', event);
  await h.settle();
  assert.equal(h.counts.createBinary, 0, 'no canvas image');
  assert.equal(await h.onDisk(), undefined);
  assert.equal(event.defaultPrevented, true, 'the clipboard group consumed it (invalid payload notice or branches)');
});

test('D6: image file without a selected topic becomes a canvas image at the last pointer, else the viewport centre; the keydown is never touched', async () => {
  const h = await harness();
  h.view.selected = null;
  // No pointer seen yet: viewport centre (400,300) in viewport pixels -> ((400-50)/2, (300-20)/2) = (175,140)
  const first = clipboardEvent({}, [file(png(300, 150), { name: 'a.png' })]);
  h.view.onClipboardEvent('paste', first);
  await h.settle();
  assert.equal(first.defaultPrevented, true);
  let items = await h.onDisk();
  assert.deepEqual([items[0].x, items[0].y], [175, 140]);
  // After the pointer moved over the canvas: client (110,45) -> (25,10)
  h.view.onCanvasPointerMove({ clientX: 110, clientY: 45 });
  const second = clipboardEvent({}, [file(png(300, 150, 4), { name: 'b.png' })]);
  h.view.onClipboardEvent('paste', second);
  await h.settle();
  items = await h.onDisk();
  assert.deepEqual([items[1].x, items[1].y], [25, 10]);
});

test('D6: image file with a selected topic is left for the card flow (P5) and no canvas image is made; text still reaches the outline', async () => {
  const h = await harness();
  h.view.selected = h.root.id;
  const imageOnly = clipboardEvent({}, [file(png())]);
  h.view.onClipboardEvent('paste', imageOnly);
  await h.settle();
  assert.equal(h.counts.createBinary, 0);
  assert.equal(await h.onDisk(), undefined);
  const texts = [];
  h.view.pasteText = (event, text) => texts.push(text);
  h.view.onClipboardEvent('paste', clipboardEvent({ 'text/plain': 'Alpha\n  Beta' }, [file(png())]));
  assert.deepEqual(texts, ['Alpha\n  Beta'], 'the clipboard group keeps plain text');
});

test('D6: text only goes to the clipboard group', async () => {
  const h = await harness();
  const texts = [];
  h.view.pasteText = (event, text) => texts.push(text);
  h.view.onClipboardEvent('paste', clipboardEvent({ 'text/plain': 'Alpha' }));
  assert.deepEqual(texts, ['Alpha']);
  assert.equal(h.counts.createBinary, 0);
});

test('imageSize reads PNG, GIF, JPEG and WebP headers and gives null for anything else', () => {
  const { imageSize } = load('experiences/visual-map/image-input.ts', { obsidian });
  assert.deepEqual(plain(imageSize(png(640, 480))), { width: 640, height: 480 });
  const gif = new Uint8Array(10); gif.set([71, 73, 70, 56, 57, 97, 0x20, 0x01, 0x10, 0x00]);
  assert.deepEqual(plain(imageSize(gif)), { width: 288, height: 16 });
  const jpg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 20, 0, 30, 1, 1, 1, 0, 0]);
  assert.deepEqual(plain(imageSize(jpg)), { width: 30, height: 20 });
  const webp = new Uint8Array(30); webp.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
  assert.deepEqual(plain(imageSize(webp)), { width: 100, height: 50 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
  assert.equal(imageSize(new Uint8Array(0)), null);
});
