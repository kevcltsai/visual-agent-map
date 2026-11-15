// ChatImageFinder (experiences/visual-map/chat-image-finder.ts) on its own: fake ports, deferred searches, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { ChatImageFinder, newChatImageBatch } = load('experiences/visual-map/chat-image-finder.ts');
const { t } = load('i18n.ts');

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
    settle: (c, block, patch) => { settles.push({ block, patch }); }
  };
  const finder = new ChatImageFinder(ports);
  const find = (cards, batch = newChatImageBatch()) => finder.find(map, chat, cards, 'words', false, batch);
  return { finder, find, state, searches, settles, probes, writes };
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
