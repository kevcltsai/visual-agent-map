// Map images P5 (ticket 32): a picture dropped or pasted onto a topic card becomes an embed in the topic note and its
// cover, in one undoable transaction (attachment + note rewrite). Real view, real transaction, fake vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator, deferred } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-i/Map.md`;
const MEDIA = 'Media';

const cover = load('experiences/visual-map/card-cover.ts', { obsidian: { parseYaml: () => ({}), stringifyYaml: () => '', normalizePath: p => p } });

const png = (w = 400, h = 200) => {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b.buffer;
};
const file = (data, { type = 'image/png', name = 'pic.png' } = {}) => ({ name, type, size: data.byteLength, arrayBuffer: async () => data });

async function harness({ aim = false, builtIn = false } = {}) {
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
  app.vault.createBinary = async (p, data) => { counts.createBinary++; const f = await createBinary(p, data); f.stat.size = data.byteLength; return f; };
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
    let p = `${MEDIA}/${name}`;
    for (let n = 1; files.has(p); n++) p = `${MEDIA}/${base} ${n}${ext}`;
    return p;
  };
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
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
  view.builtIn = builtIn; view.integrationMode = false;
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => { view.stageEl.children = []; view.renderCanvasItems(); };
  const entries = [];
  const push = view.history.push.bind(view.history);
  view.history.push = entry => { entries.push(entry); push(entry); };
  const settle = async () => { await pending; await dom.tick(); await pending; await dom.tick(); };
  const node = view.map.nodes[0];
  const note = () => contents.get(node.path);
  const mediaFiles = () => [...files.values()].filter(f => f.parent?.path === MEDIA).map(f => f.path).sort();
  const onDisk = async () => { const items = (await repo.readMap(MAP)).canvasItems; return items === undefined ? undefined : plain(items); };
  return { repo, app, view, counts, settle, notices, mediaFiles, contents, node, note, entries, onDisk };
}

const dragEvent = (files, extra = {}) => ({ clientX: 110, clientY: 45, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, dataTransfer: { files, types: ['Files'], dropEffect: '' }, ...extra });
const clipboardEvent = (files = [], data = {}) => ({ target: { inside: true, closest: () => null }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, clipboardData: { files, getData: type => data[type] ?? '', setData() {} } });
const card = () => element('div', 'vam-node');

test('dropping a picture on a card appends the embed under User Notes and sets the cover, in one history entry', async () => {
  const h = await harness();
  const before = h.note();
  const c = card();
  h.view.onCardDrop(dragEvent([file(png())]), c, h.node);
  await h.settle();
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/pic.png`]);
  const text = h.note();
  assert.match(text, /\n## User Notes\n[\s\S]*!\[\[Media\/pic\.png\]\]\n$/);
  assert.match(text, /^---\n[\s\S]*topic-cover: "\[\[Media\/pic\.png\]\]"\n---/);
  assert.ok(text.length > before.length);
  assert.equal(h.entries.length, 1, 'one undo step');
  assert.equal(await h.onDisk(), undefined, 'no free canvas image was made');
});

test('an existing User Notes section keeps its text and receives the embed at its end, before the next heading', () => {
  const body = '---\ntype: topic\n---\n\n# T\n\n## User Notes\n\nmy words\n\n## Other\n\nx\n';
  const out = cover.appendImageEmbed(body, 'Media/p.png');
  assert.equal(out, '---\ntype: topic\n---\n\n# T\n\n## User Notes\n\nmy words\n\n![[Media/p.png]]\n\n## Other\n\nx\n');
  assert.equal(cover.appendImageEmbed('# T\n\n## User Notes\n', 'a.png'), '# T\n\n## User Notes\n\n![[a.png]]\n');
  assert.equal(cover.appendImageEmbed('# T\n\ntext', 'a.png'), '# T\n\ntext\n\n## User Notes\n\n![[a.png]]\n');
  assert.equal(cover.appendImageEmbed('# T\n\n## User Notes\n\nlast', 'a.png'), '# T\n\n## User Notes\n\nlast\n\n![[a.png]]\n');
  assert.doesNotMatch(cover.appendImageEmbed('# T\n', 'bad]]|\nname.png'), /\|\n|\]\]\|/, 'a link cannot break out of the embed');
});

test('counterexample 1: rewriteNote throws -> the attachment is trashed and the note is byte for byte unchanged', async () => {
  const h = await harness();
  const before = h.note();
  const process = h.app.vault.process;
  h.app.vault.process = async () => { throw new Error('injected write failure'); };
  h.view.onCardDrop(dragEvent([file(png())]), card(), h.node);
  await h.settle();
  h.app.vault.process = process;
  assert.equal(h.note(), before);
  assert.deepEqual(h.mediaFiles(), [], 'the new file is gone');
  assert.equal(h.counts.trashFile, 1);
  assert.equal(h.entries.length, 0);
  assert.equal(h.notices.length, 1, 'the failure is said');
});

test('counterexample 1b: a non-image, an SVG or a fake PNG writes nothing', async () => {
  const h = await harness();
  const before = h.note();
  for (const dropped of [
    file(new TextEncoder().encode('hello').buffer, { type: 'text/plain', name: 'a.txt' }),
    file(new TextEncoder().encode('<svg/>').buffer, { type: 'image/svg+xml', name: 'a.svg' }),
    file(new TextEncoder().encode('not really a png').buffer, { type: 'image/png', name: 'fake.png' })
  ]) {
    const event = dragEvent([dropped]);
    h.view.onCardDrop(event, card(), h.node);
    await h.settle();
    assert.equal(event.defaultPrevented, true, 'the browser does not open the file');
  }
  assert.equal(h.note(), before);
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.notices.length, 3);
});

test('counterexample 1c: switching the map while the bytes are read writes nothing', async () => {
  const h = await harness();
  const before = h.note();
  const gate = deferred();
  h.view.onCardDrop(dragEvent([{ ...file(png()), arrayBuffer: async () => { await gate.promise; return png(); } }]), card(), h.node);
  await dom.tick();
  h.view.mapOpenEpoch++;
  gate.resolve();
  await h.settle();
  assert.equal(h.note(), before);
  assert.equal(h.counts.createBinary, 0);
});

test('counterexample 2: undo removes the embed and topic-cover and keeps the file', async () => {
  const h = await harness();
  const before = h.note();
  h.view.onCardDrop(dragEvent([file(png())]), card(), h.node);
  await h.settle();
  await h.entries[0].undo();
  assert.equal(h.note(), before, 'note is byte for byte as before');
  assert.doesNotMatch(h.note(), /topic-cover|!\[\[/);
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/pic.png`], 'the picture file stays in the vault');
});

test('counterexample 3: redo points at the same path and adds no second file', async () => {
  const h = await harness();
  h.view.onCardDrop(dragEvent([file(png())]), card(), h.node);
  await h.settle();
  const done = h.note();
  await h.entries[0].undo();
  await h.entries[0].redo();
  assert.equal(h.note(), done);
  assert.match(h.note(), /!\[\[Media\/pic\.png\]\]/);
  assert.match(h.note(), /topic-cover: "\[\[Media\/pic\.png\]\]"/);
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/pic.png`]);
});

test('counterexample 4: pasting a picture with no selected topic takes the free-image path of ticket 30', async () => {
  const h = await harness();
  const before = h.note();
  h.view.selected = null;
  const event = clipboardEvent([file(png())]);
  assert.equal(h.view.pasteCanvasImages(event), true);
  assert.equal(event.defaultPrevented, true);
  await h.settle();
  assert.equal((await h.onDisk()).length, 1, 'a canvas item was added');
  assert.equal(h.note(), before, 'no topic note was touched');
});

test('pasting a picture with a selected topic puts it on that card, not on the canvas', async () => {
  const h = await harness();
  h.view.selected = h.node.id;
  const event = clipboardEvent([file(png())]);
  assert.equal(h.view.pasteCanvasImages(event), true);
  assert.equal(event.defaultPrevented, true);
  await h.settle();
  assert.match(h.note(), /!\[\[Media\/pic\.png\]\]/);
  assert.equal(await h.onDisk(), undefined, 'no canvas item');
});

test('paste leaves everything else alone: text only, a selection that cannot take covers, or a read-only map', async () => {
  const h = await harness();
  h.view.selected = h.node.id;
  const textOnly = clipboardEvent([], { 'text/plain': 'hello' });
  assert.equal(h.view.pasteCanvasImages(textOnly), false);
  assert.equal(textOnly.defaultPrevented, false);
  const aim = await harness({ aim: true });
  aim.view.selected = aim.node.id;
  assert.equal(aim.view.pasteCanvasImages(clipboardEvent([file(png())])), false);
  const sample = await harness({ builtIn: true });
  sample.view.selected = sample.node.id;
  assert.equal(sample.view.pasteCanvasImages(clipboardEvent([file(png())])), false);
  await sample.settle();
  assert.equal(sample.counts.createBinary, 0);
});

test('dragover highlights the card with is-drop-target until it leaves or drops; the canvas hint is replaced meanwhile', async () => {
  const h = await harness();
  const c = card(), vp = h.view.viewportEl;
  h.view.onCanvasDragOver(dragEvent([]));
  assert.ok(vp.hasClass('is-image-drop'), 'the canvas shows its dashed hint');
  const over = dragEvent([]);
  h.view.onCardDragOver(over, c, h.node);
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.equal(over.stopped, true, 'the canvas handler does not also take it');
  assert.ok(c.hasClass('is-drop-target'));
  assert.ok(!vp.hasClass('is-image-drop'), 'only one hint at a time');
  h.view.onCardDragLeave(dragEvent([], { relatedTarget: null }), c);
  assert.ok(!c.hasClass('is-drop-target'));
  h.view.onCardDragOver(dragEvent([]), c, h.node);
  h.view.onCardDrop(dragEvent([]), c, h.node);
  assert.ok(!c.hasClass('is-drop-target'), 'a drop clears it');
  h.view.onCanvasDragOver(dragEvent([]));
  h.view.onCanvasDragLeave(dragEvent([], { relatedTarget: null }));
  assert.ok(!vp.hasClass('is-image-drop'));
});

test('a drag that carries no files, or a card that cannot take covers, shows no highlight and is not consumed', async () => {
  const h = await harness();
  const c = card();
  const text = dragEvent([], { dataTransfer: { files: [], types: ['text/plain'] } });
  h.view.onCardDragOver(text, c, h.node);
  assert.equal(text.defaultPrevented, false);
  assert.ok(!c.hasClass('is-drop-target'));
  const aim = await harness({ aim: true });
  const over = dragEvent([]);
  aim.view.onCardDragOver(over, c, aim.node);
  assert.equal(over.defaultPrevented, false);
  assert.ok(!c.hasClass('is-drop-target'));
});

test('renderNode wires the three drag listeners, and the styles exist', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const body = source.match(/private renderNode\([\s\S]*?\n  }\n/)[0];
  for (const name of ['dragover', 'dragleave', 'drop']) assert.match(body, new RegExp(`addEventListener\\("${name}"`));
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-node\.is-drop-target\s*\{[^}]*outline/);
  assert.match(css, /\.vam-viewport\.is-image-drop\s*\{[^}]*dashed/);
});

test('a clipboard with text next to the picture is not taken by the card (the outline keeps it)', async () => {
  const h = await harness();
  h.view.selected = h.node.id;
  const event = clipboardEvent([file(png())], { 'text/plain': 'a\n b' });
  assert.equal(h.view.pasteCanvasImages(event), false);
  assert.equal(event.defaultPrevented, false);
  await h.settle();
  assert.equal(h.counts.createBinary, 0);
});
