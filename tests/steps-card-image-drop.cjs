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

async function harness({ attachmentSetting = MEDIA } = {}) {
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
  // Obsidian's attachmentFolderPath; the fake getAvailablePathForAttachment below stands for this fixed folder.
  app.vault.getConfig = key => (key === 'attachmentFolderPath' ? attachmentSetting : undefined);
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
  view.selection.exitMultiSelect('emptyMap');
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
  h.view.selection.setSelected(null);
  const event = clipboardEvent([file(png())]);
  assert.equal(h.view.pasteCanvasImages(event), true);
  assert.equal(event.defaultPrevented, true);
  await h.settle();
  assert.equal((await h.onDisk()).length, 1, 'a canvas item was added');
  assert.equal(h.note(), before, 'no topic note was touched');
});

test('pasting a picture with a selected topic puts it on that card, not on the canvas', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.node.id);
  const event = clipboardEvent([file(png())]);
  assert.equal(h.view.pasteCanvasImages(event), true);
  assert.equal(event.defaultPrevented, true);
  await h.settle();
  assert.match(h.note(), /!\[\[Media\/pic\.png\]\]/);
  assert.equal(await h.onDisk(), undefined, 'no canvas item');
});

test('paste leaves everything else alone: text only', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.node.id);
  const textOnly = clipboardEvent([], { 'text/plain': 'hello' });
  assert.equal(h.view.pasteCanvasImages(textOnly), false);
  assert.equal(textOnly.defaultPrevented, false);
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

test('a drag that carries no files shows no highlight and is not consumed', async () => {
  const h = await harness();
  const c = card();
  const text = dragEvent([], { dataTransfer: { files: [], types: ['text/plain'] } });
  h.view.onCardDragOver(text, c, h.node);
  assert.equal(text.defaultPrevented, false);
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
  h.view.selection.setSelected(h.node.id);
  const event = clipboardEvent([file(png())], { 'text/plain': 'a\n b' });
  assert.equal(h.view.pasteCanvasImages(event), false);
  assert.equal(event.defaultPrevented, false);
  await h.settle();
  assert.equal(h.counts.createBinary, 0);
});

// Persona UX ticket 22 (the map chat puts the first found picture in by itself since 2026-11-07): a picture put in by the map chat (a web link) also becomes the card's cover. Covers read local files
// only, so the file is saved beside the note, embedded and set as `topic-cover`; the Detail keeps the picked link as before.
const pick = { url: 'https://example.org/a.png', title: 'A picture', source: 'https://example.org/page' };
const chatPick = async (h, fetchImage = async () => png()) => {
  h.view.plugin.topicRuns = { isBusy: () => false, hasTask: () => false, stopTask() {}, dropPending() {}, flushPending: async () => {} };
  h.view.chatFetchImage = fetchImage;
  const result = await h.view.chatPlaceImage({ mapPath: MAP, mapId: h.view.map.id, nodeId: h.node.id }, pick, () => true);
  await h.settle();
  return result;
};

test('chat pick: the picked web picture becomes the card cover (saved file, embed, topic-cover) and stays in the Detail', async () => {
  const h = await harness();
  const result = await chatPick(h);
  assert.equal(result.ok, true);
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/A picture.png`]);
  const text = h.note();
  assert.match(text, /topic-cover: "\[\[Media\/A picture\.png\]\]"/);
  assert.match(text, /!\[\[Media\/A picture\.png\]\]/);
  assert.match(text, /!\[A picture\]\(<https:\/\/example\.org\/a\.png>\)/, 'the Detail still has the picked link');
});

test('chat pick: the note embed and the cover are ONE history entry, and running its undo takes the Detail picture, the cover embed and topic-cover out (the file stays, by design) and redo brings them back', async () => {
  const h = await harness();
  const before = h.note();
  const result = await chatPick(h);
  assert.equal(result.ok, true);
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/A picture.png`]);
  assert.equal(h.entries.length, 1, 'the note write and the cover reach the history as one entry: ' + h.entries.length);
  const after = h.note();
  assert.match(after, /topic-cover: "\[\[Media\/A picture\.png\]\]"/);
  let steps = 0;
  while (h.view.history.canUndo) { const entry = h.view.history.undo(); await entry.undo(); steps++; }
  await h.settle();
  assert.equal(steps, 1, 'one undo step for the picture');
  const stamp = text => text.replace(/^updated: .*\n/m, '');
  assert.equal(stamp(h.note()), stamp(before), 'the note is what it was, apart from its updated stamp (Detail, cover embed and topic-cover)');
  assert.doesNotMatch(h.note(), /topic-cover|A picture/);
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/A picture.png`], 'the saved file stays on disk (undo never trashes what the step created)');
  const redo = h.view.history.redo();
  await redo.redo();
  await h.settle();
  assert.equal(stamp(h.note()), stamp(after), 'redo puts the picture and the cover back');
  assert.deepEqual(h.mediaFiles(), [`${MEDIA}/A picture.png`]);
});

test('chat pick: a reply being applied at that moment (an open group, ownWrites) does not split the picture into two steps', async () => {
  const h = await harness();
  h.view.history.openGroup();
  const gate = deferred();
  const reply = h.view.history.ownWrites(() => gate.promise);
  const result = await chatPick(h);
  assert.equal(result.ok, true);
  const grouped = h.view.history.closeGroup();
  gate.resolve();
  await reply;
  let loose = 0;
  while (h.view.history.canUndo) { h.view.history.undo(); loose++; }
  assert.equal(grouped.length + loose, 1, 'the note write and the cover are one entry wherever it lands');
});

test('chat pick: a card locked against AI gets no cover file (the check is made again before the cover is written)', async () => {
  const h = await harness();
  const real = h.view.plugin.repo.readNote.bind(h.view.plugin.repo);
  let reads = 0;
  // The card is unlocked for the Detail write and locked by the time the cover is about to be written.
  h.view.plugin.repo.readNote = async (...args) => { const note = await real(...args); reads++; return reads >= 2 ? { ...note, aiLocked: true } : note; };
  const result = await chatPick(h);
  assert.equal(result.ok, true);
  assert.deepEqual(h.mediaFiles(), [], 'no attachment for a locked card');
  assert.doesNotMatch(h.note(), /topic-cover/);
});

test('chat pick: a cover set by hand, or turned off, is not replaced and nothing is downloaded', async () => {
  for (const key of ['"[[Media/mine.png]]"', 'none']) {
    const h = await harness();
    h.contents.set(h.node.path, h.note().replace(/^---\n/, `---\ntopic-cover: ${key}\n`));
    let fetched = 0;
    const result = await chatPick(h, async () => { fetched++; return png(); });
    assert.equal(result.ok, true);
    assert.equal(fetched, 0, key);
    assert.deepEqual(h.mediaFiles(), []);
    assert.match(h.note(), new RegExp(`topic-cover: ${key.replace(/[[\]]/g, '\\$&')}`));
  }
});

test('chat pick: a failed or non-image download still inserts the Detail picture and writes no cover', async () => {
  for (const fetchImage of [async () => { throw new Error('offline'); }, async () => new TextEncoder().encode('<html>').buffer]) {
    const h = await harness();
    const result = await chatPick(h, fetchImage);
    assert.equal(result.ok, true);
    assert.match(h.note(), /!\[A picture\]\(<https:\/\/example\.org\/a\.png>\)/);
    assert.doesNotMatch(h.note(), /topic-cover/);
    assert.deepEqual(h.mediaFiles(), []);
  }
});

test('default attachment setting (vault root): a picture dropped on a card goes to the map folder\'s Attachments, not Notes/ or the root', async () => {
  const h = await harness();
  h.app.vault.getConfig = () => undefined; // never set: the vault root
  let asked = 0;
  h.app.fileManager.getAvailablePathForAttachment = async () => { asked++; return 'pic.png'; };
  assert.equal(h.node.path.startsWith(`${TOPICS}/map-i/Notes/`), true, 'the card note lives in Notes/');
  h.view.onCardDrop(dragEvent([file(png())]), card(), h.node);
  await h.settle();
  assert.equal(asked, 0);
  const stored = `${TOPICS}/map-i/Attachments/pic.png`;
  assert.notEqual(h.app.vault.getAbstractFileByPath(stored), undefined);
  assert.equal(h.app.vault.getAbstractFileByPath('pic.png'), undefined);
  assert.ok(h.note().includes(`![[${stored}]]`), 'the embed points at the map Attachments file');
  assert.deepEqual(h.mediaFiles(), []);
  assert.equal(h.entries.length, 1, 'one undo step');
});
