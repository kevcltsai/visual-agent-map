// ChatImageFinder (experiences/visual-map/chat-image-finder.ts) on its own: fake ports, deferred searches, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { ChatImageFinder, newChatImageBatch } = load('experiences/visual-map/chat-image-finder.ts');
const { t } = load('i18n.ts');

const plainOf = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const CANDIDATE = { url: 'https://example.org/a.png', title: 'A', source: 'https://example.org' };

function world(cardIds) {
  const chat = { name: 'chat' };
  const state = { closed: false, chat, path: 'map.md', mapId: 'm' };
  const map = { id: 'm', nodes: cardIds.map(id => ({ id, path: `${id}.md`, parentId: null })) };
  const searches = [], settles = [], probes = [], writes = [];
  const ports = {
    where: () => ({ ...state }),
    readNote: async path => ({ title: path.replace('.md', ''), model: 'claude:sonnet' }),
    modelLabel: model => model,
    preflight: async () => null,
    confirmUsage: async () => true,
    searchImages: (query, model, signal) => new Promise((resolve, reject) => searches.push({ query, signal, resolve, reject })),
    probe: async found => { probes.push(found); return found; },
    usedImageKeys: () => new Set(),
    coverWanted: () => false,
    fetchBytes: async () => new ArrayBuffer(0),
    write: async (...args) => { writes.push(args); return { ok: true }; },
    added: () => {},
    running: () => {},
    settle: (c, block, patch) => { settles.push({ block, patch }); },
    canvasModel: () => 'claude:sonnet',
    canvasPreflight: () => null,
    writeCanvas: async (block, candidate, file) => { writes.push(['canvas', block, candidate, file]); return { ok: true, id: 'img-1' }; }
  };
  const finder = new ChatImageFinder(ports);
  const find = (cards, batch = newChatImageBatch()) => finder.find(map, chat, cards, 'words', false, batch);
  return { finder, find, state, searches, settles, probes, writes, ports };
}

test('chat image finder: at most 3 searches at once, the 4th starts in order when one ends (also by an error)', async () => {
  const w = world(['a', 'b', 'c', 'd']);
  const result = await w.find(['a', 'b', 'c', 'd']);
  assert.equal(result.blocks.length, 4);
  await flush();
  assert.deepEqual(w.searches.map(s => s.query.slice(-1)), ['a', 'b', 'c'], 'first come, first served');
  assert.equal(w.searches.length, 3, 'the 4th card waits');
  assert.equal(w.finder.isRunning(), true);
  w.searches[1].reject(new Error('boom'));
  await flush();
  assert.equal(w.searches.length, 4, 'a thrown search hands its place to the waiting one');
  assert.match(w.searches[3].query, /d$/);
  assert.equal(w.settles.filter(s => s.patch.state === 'failed').length, 1);
  for (const s of w.searches) s.resolve([]);
  await flush();
  assert.equal(w.finder.running, 0);
  assert.equal(w.finder.isRunning(), false);
});

test('chat image finder: stopAll stops the queued search too, and the places come back', async () => {
  const w = world(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const batch = newChatImageBatch();
  await w.find(['a', 'b', 'c', 'd'], batch);
  await flush();
  assert.equal(w.searches.length, 3);
  const controllers = [...w.finder.searches.values()];
  assert.equal(controllers.length, 4, 'the queued search counts as running');
  w.finder.stopAll();
  assert.equal(controllers.every(c => c.signal.aborted), true);
  assert.equal(w.finder.isRunning(), false);
  assert.equal(w.finder.isSearching('m', 'a'), false);
  assert.equal(w.finder.isSearching('m', 'd'), false);
  for (const s of w.searches) s.resolve([CANDIDATE]);
  await flush();
  assert.equal(w.searches.length, 3, 'the queued search never started');
  assert.equal(w.settles.length, 0, 'stopAll settles nothing');
  assert.equal(w.finder.running, 0);
  assert.equal(w.finder.waiters.length, 0);
  await w.find(['e', 'f', 'g'], newChatImageBatch());
  await flush();
  assert.equal(w.searches.length, 6, 'three new searches can start');
});

test('chat image finder: the map changed while a search was out, nothing is written and the block says so', async () => {
  const w = world(['a']);
  await w.find(['a']);
  await flush();
  assert.equal(w.searches.length, 1);
  w.state.path = 'other.md';
  w.searches[0].resolve([CANDIDATE]);
  await flush();
  assert.equal(w.writes.length, 0);
  assert.equal(w.settles.length, 1);
  assert.equal(w.settles[0].patch.state, 'failed');
  assert.equal(w.settles[0].patch.reason, t('ui.map_chat_images_stale_map'));
});

test('chat image finder: a result that arrives after Stop is neither probed nor written, the block stays stopped', async () => {
  const w = world(['a']);
  const result = await w.find(['a']);
  await flush();
  result.blocks[0].stop();
  assert.equal(w.searches[0].signal.aborted, true);
  w.searches[0].resolve([CANDIDATE]);
  await flush();
  assert.equal(w.probes.length, 0);
  assert.equal(w.writes.length, 0);
  assert.deepEqual(w.settles.map(s => s.patch.state), ['stopped']);
  assert.equal(w.finder.isRunning(), false);
});

// place_image (findCanvas): the same search, thumbnail check and download, but the picture goes on the canvas.
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).buffer;
const canvasWorld = () => {
  const w = world([]);
  w.ports.fetchBytes = async () => PNG.slice(0);
  w.canvas = (direction = 'a red barn', batch = newChatImageBatch()) => w.finder.findCanvas({ id: 'm', nodes: [] }, w.state.chat, direction, batch);
  return w;
};
const canvasWrites = w => w.writes.filter(x => x[0] === 'canvas');

test('findCanvas: search, thumbnail check, download, write ends ready with the new id and the block says canvas', async () => {
  const w = canvasWorld();
  const found = await w.canvas();
  assert.equal(found.block.canvas, true);
  assert.equal(found.block.nodeId, '');
  assert.equal(found.block.query, 'a red barn');
  await flush();
  assert.equal(w.searches.length, 1);
  w.searches[0].resolve([CANDIDATE]);
  assert.equal(await found.placed, 'img-1');
  assert.equal(w.probes.length, 1);
  assert.equal(canvasWrites(w).length, 1);
  assert.equal(canvasWrites(w)[0][3].name.endsWith('.png'), true);
  assert.equal(w.settles.at(-1).patch.state, 'ready');
  assert.equal(w.settles.at(-1).patch.items[0].candidate.url, CANDIDATE.url);
  assert.equal(w.finder.isRunning(), false);
  assert.equal(w.finder.running, 0);
});

test('findCanvas: Stop resolves null, writes nothing, the block stays stopped', async () => {
  const w = canvasWorld();
  const found = await w.canvas();
  await flush();
  found.block.stop();
  assert.equal(w.searches[0].signal.aborted, true);
  w.searches[0].resolve([CANDIDATE]);
  assert.equal(await found.placed, null);
  assert.equal(canvasWrites(w).length, 0);
  assert.equal(w.probes.length, 0);
  assert.deepEqual(w.settles.map(s => s.patch.state), ['stopped']);
  assert.equal(w.finder.running, 0);
});

test('findCanvas: the map changed while the search was out resolves null, writes nothing, the block says so', async () => {
  const w = canvasWorld();
  const found = await w.canvas();
  await flush();
  w.state.path = 'other.md';
  w.searches[0].resolve([CANDIDATE]);
  assert.equal(await found.placed, null);
  assert.equal(canvasWrites(w).length, 0);
  assert.equal(w.settles.at(-1).patch.state, 'failed');
  assert.equal(w.settles.at(-1).patch.reason, t('ui.map_chat_images_stale_map'));
});

test('findCanvas: the map changed during the download writes nothing', async () => {
  const w = canvasWorld();
  w.ports.fetchBytes = async () => { w.state.mapId = 'other'; return PNG.slice(0); };
  const found = await w.canvas();
  await flush();
  w.searches[0].resolve([CANDIDATE]);
  assert.equal(await found.placed, null);
  assert.equal(canvasWrites(w).length, 0);
});

test('findCanvas: a non-https candidate and a bytes-refused one fall through to the next', async () => {
  const w = canvasWorld();
  const bad = { url: 'https://example.org/bad.png', title: 'Bad', source: '' };
  const good = { url: 'https://example.org/good.png', title: 'Good', source: '' };
  const fetched = [];
  w.ports.fetchBytes = async url => { fetched.push(url); return url === bad.url ? new Uint8Array([1, 2, 3, 4]).buffer : PNG.slice(0); };
  const found = await w.canvas();
  await flush();
  w.searches[0].resolve([{ url: 'http://example.org/plain.png', title: 'Plain', source: '' }, bad, good]);
  assert.equal(await found.placed, 'img-1');
  assert.deepEqual(fetched, [bad.url, good.url], 'http never downloaded, bad bytes refused, the next one used');
  assert.equal(canvasWrites(w)[0][2].url, good.url);
});

test('findCanvas: nothing usable settles empty and resolves null (no results, or all refused)', async () => {
  const w = canvasWorld();
  const found = await w.canvas();
  await flush();
  w.searches[0].resolve([]);
  assert.equal(await found.placed, null);
  assert.equal(w.settles.at(-1).patch.state, 'empty');
  const v = canvasWorld();
  v.ports.fetchBytes = async () => new ArrayBuffer(0);
  const again = await v.canvas();
  await flush();
  v.searches[0].resolve([CANDIDATE]);
  assert.equal(await again.placed, null);
  assert.equal(canvasWrites(v).length, 0);
  assert.equal(v.settles.at(-1).patch.state, 'empty');
});

test('findCanvas: an empty or link-only direction is skipped and starts nothing', async () => {
  for (const direction of ['', '   ', 'https://example.org/x.png']) {
    const w = canvasWorld();
    const found = await w.canvas(direction);
    assert.deepEqual(plainOf(found), { skipped: 'ui.map_chat_skip_unavailable' }, JSON.stringify(direction));
    await flush();
    assert.equal(w.searches.length, 0);
  }
});

test('findCanvas: a declined usage notice skips this and the next search of the reply', async () => {
  const w = canvasWorld();
  let asked = 0;
  w.ports.confirmUsage = async () => { asked += 1; return false; };
  const batch = newChatImageBatch();
  assert.deepEqual(plainOf(await w.canvas('a', batch)), { skipped: 'ui.map_chat_skip_not_started' });
  assert.deepEqual(plainOf(await w.canvas('b', batch)), { skipped: 'ui.map_chat_skip_not_started' });
  assert.equal(asked, 1);
  assert.equal(batch.declined, true);
  assert.equal(w.searches.length, 0);
});

test('findCanvas: a refusing preflight is a failure at once; a usage notice that throws is a failure', async () => {
  const w = canvasWorld();
  w.ports.canvasPreflight = () => 'locked';
  assert.deepEqual(plainOf(await w.canvas()), { failed: 'locked' });
  const v = canvasWorld();
  v.ports.confirmUsage = async () => { throw new Error('nope'); };
  assert.deepEqual(plainOf(await v.canvas()), { failed: 'nope' });
  assert.equal(v.searches.length, 0);
});

test('findCanvas: placed never rejects (search, probe or write throwing all give null)', async () => {
  const a = canvasWorld();
  const first = await a.canvas();
  await flush();
  a.searches[0].reject(new Error('boom'));
  assert.equal(await first.placed, null);
  assert.equal(a.settles.at(-1).patch.state, 'failed');
  const b = canvasWorld();
  b.ports.probe = async () => { throw new Error('probe'); };
  const second = await b.canvas();
  await flush();
  b.searches[0].resolve([CANDIDATE]);
  assert.equal(await second.placed, null);
  const c = canvasWorld();
  c.ports.writeCanvas = async () => { throw new Error('write'); };
  const third = await c.canvas();
  await flush();
  c.searches[0].resolve([CANDIDATE]);
  assert.equal(await third.placed, null);
  assert.equal(c.finder.running, 0);
  assert.equal(c.finder.isRunning(), false);
});

test('findCanvas: a write that is refused settles the block empty with the reason and resolves null', async () => {
  const w = canvasWorld();
  w.ports.writeCanvas = async () => ({ ok: false, reason: 'refused' });
  const found = await w.canvas();
  await flush();
  w.searches[0].resolve([CANDIDATE]);
  assert.equal(await found.placed, null);
  assert.deepEqual(plainOf(w.settles.at(-1).patch), { state: 'empty', reason: 'refused' });
});
