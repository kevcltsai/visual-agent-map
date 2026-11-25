// MapChatFiles (core/map-chat-files.ts) on its own: a fake read port, no view. Every gate of the read allow-list is checked here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { MapChatFiles } = load('core/map-chat-files.ts');
const { contentHash, MAP_CHAT_FILE_CHAR_LIMIT } = load('core/map-chat-context.ts');

const plain = value => JSON.parse(JSON.stringify(value));
// The module runs in its own vm realm, so what it returns is compared as plain data.
const eq = (actual, expected) => assert.deepStrictEqual(plain(actual), expected);
const IN = 'Maps/T';

function world(folder = IN) {
  const files = new Map();
  let reads = 0;
  const chat = new MapChatFiles({
    read: async key => { reads++; return files.has(key) ? { path: key, text: files.get(key) } : null; },
    mapFolder: () => folder
  });
  return { chat, files, reads: () => reads };
}

test('own file inside the map folder: carried, readable, accepted; editing it changes the version', async () => {
  const { chat, files } = world();
  files.set(`${IN}/a.md`, 'v1');
  chat.noteWrite(`${IN}/a.md`, 'v1', true);
  assert.equal(await chat.readableNow(`${IN}/a.md`), true);
  eq(plain(await chat.carry(new Set())), [{ path: `${IN}/a.md`, content: 'v1' }]);
  eq(plain(await chat.acceptRead(`${IN}/a.md`)), { path: `${IN}/a.md`, chars: 2 });
});

test('the user edited an own or attached file: not carried, not readable, acceptRead null', async () => {
  const { chat, files } = world();
  files.set(`${IN}/a.md`, 'v1');
  files.set('Other/b.md', 'b1');
  chat.noteWrite(`${IN}/a.md`, 'v1', true);
  chat.noteAttached('Other/b.md', 'b1');
  files.set(`${IN}/a.md`, 'hand edited');
  files.set('Other/b.md', 'hand edited too');
  eq(await chat.carry(new Set()), []);
  assert.equal(await chat.readableNow(`${IN}/a.md`), false);
  assert.equal(await chat.readableNow('Other/b.md'), false);
  assert.equal(await chat.acceptRead(`${IN}/a.md`), null);
  assert.equal(await chat.acceptRead('Other/b.md'), null);
});

test('hash mismatch after delete and recreate; a missing file answers null', async () => {
  const { chat, files } = world();
  files.set(`${IN}/a.md`, 'v1');
  chat.noteWrite(`${IN}/a.md`, 'v1', true);
  files.delete(`${IN}/a.md`);
  assert.equal(await chat.readableNow(`${IN}/a.md`), false);
  assert.equal(await chat.acceptRead(`${IN}/a.md`), null);
  files.set(`${IN}/a.md`, 'recreated');
  assert.equal(await chat.readableNow(`${IN}/a.md`), false);
  assert.equal(await chat.acceptRead(`${IN}/a.md`), null);
  eq(await chat.carry(new Set()), []);
});

test('an attached file outside the map folder is readable and carried, but an edit does not make it an own file', async () => {
  const { chat, files } = world();
  files.set('Other/b.md', 'b1');
  chat.noteAttached('Other/b.md', 'b1');
  assert.equal(chat.isAttached('Other/b.md'), true);
  assert.equal(await chat.readableNow('Other/b.md'), true);
  eq(plain(await chat.carry(new Set())), [{ path: 'Other/b.md', content: 'b1' }]);
  chat.noteWrite('Other/b.md', 'b2', false);
  files.set('Other/b.md', 'b2');
  assert.equal(await chat.readableNow('Other/b.md'), false);
  eq(chat.marksFor('c1').map(mark => mark.kind), ['file_attached']);
});

test('an attached file inside the map folder that the chat edits becomes an own version', async () => {
  const { chat, files } = world();
  files.set(`${IN}/b.md`, 'b1');
  chat.noteAttached(`${IN}/b.md`, 'b1');
  chat.noteWrite(`${IN}/b.md`, 'b2', false);
  files.set(`${IN}/b.md`, 'b2');
  assert.equal(await chat.readableNow(`${IN}/b.md`), true);
  eq(chat.marksFor('c1').map(mark => mark.kind), ['file_written', 'file_attached']);
});

test('an own file written outside the map folder is neither readable nor carried', async () => {
  const { chat, files } = world();
  files.set('Other/c.md', 'c1');
  chat.noteWrite('Other/c.md', 'c1', true);
  assert.equal(await chat.readableNow('Other/c.md'), false);
  assert.equal(await chat.acceptRead('Other/c.md'), null);
  eq(await chat.carry(new Set()), []);
  // The mapFolder port is read each time: moving the folder changes the answer.
  let folder = IN;
  const moving = new MapChatFiles({ read: async key => ({ path: key, text: 'x' }), mapFolder: () => folder });
  moving.noteWrite(`${IN}/m.md`, 'x', true);
  assert.equal(await moving.readableNow(`${IN}/m.md`), true);
  folder = 'Elsewhere';
  assert.equal(await moving.readableNow(`${IN}/m.md`), false);
  folder = null;
  assert.equal(await moving.readableNow(`${IN}/m.md`), false);
});

test('an existing file never written nor attached: noteWrite(created=false) is ignored, not readable', async () => {
  const { chat, files } = world();
  files.set(`${IN}/old.md`, 'old');
  chat.noteWrite(`${IN}/old.md`, 'new', false);
  assert.equal(await chat.readableNow(`${IN}/old.md`), false);
  eq(chat.marksFor('c1'), []);
  eq(chat.readablePaths(), []);
});

test('noteAttached ignores ../, dot parts, and non-md; noteWrite ignores an escaping path', async () => {
  const { chat, files } = world();
  for (const path of ['../x.md', '.obsidian/x.md', 'a/.hidden/x.md', 'Other/x.txt', 'Other/x.md.bak'])
    chat.noteAttached(path, 'x');
  chat.noteWrite('../x.md', 'x', true);
  eq(chat.readablePaths(), []);
  eq(chat.marksFor('c1'), []);
  files.set('Other/ok.MD', 'x');
  chat.noteAttached('Other/ok.MD', 'x');
  eq(chat.readablePaths(), ['Other/ok.MD']);
});

test('over the char limit refused; the version the last context carried is refused; a new version is accepted', async () => {
  const { chat, files } = world();
  const big = 'x'.repeat(MAP_CHAT_FILE_CHAR_LIMIT + 1);
  files.set(`${IN}/big.md`, big);
  chat.noteWrite(`${IN}/big.md`, big, true);
  assert.equal(await chat.acceptRead(`${IN}/big.md`), null);
  const exact = 'y'.repeat(MAP_CHAT_FILE_CHAR_LIMIT);
  files.set(`${IN}/ok.md`, exact);
  chat.noteWrite(`${IN}/ok.md`, exact, true);
  assert.equal((await chat.acceptRead(`${IN}/ok.md`)).chars, MAP_CHAT_FILE_CHAR_LIMIT);
  // The next context carries it first; asking for the same version again is refused.
  const carried = plain(await chat.carry(new Set()));
  assert.equal(carried[0].requested, true);
  assert.equal(await chat.acceptRead(`${IN}/ok.md`), null);
  // A newer version of its own is a read again.
  chat.noteWrite(`${IN}/ok.md`, 'short', false);
  files.set(`${IN}/ok.md`, 'short');
  assert.equal((await chat.acceptRead(`${IN}/ok.md`)).chars, 5);
  // Asking twice before a context queues once.
  await chat.acceptRead(`${IN}/ok.md`);
  assert.equal((await chat.carry(new Set())).filter(file => file.requested).length, 1);
});

test('order: requested, then 進度 and the latest round, then the rest newest first; skip is left out', async () => {
  const { chat, files } = world();
  const add = (name, created = true) => { files.set(`${IN}/${name}`, name); chat.noteWrite(`${IN}/${name}`, name, created); };
  chat.startRound(); add('r1-a.md'); add('r1-b.md');
  chat.startRound(); add('r2-a.md'); add('進度.md');
  chat.startRound(); add('r3-a.md'); add('r3-b.md');
  files.set('Other/att.md', 'att');
  chat.noteAttached('Other/att.md', 'att');
  await chat.acceptRead(`${IN}/r1-a.md`);
  const out = plain(await chat.carry(new Set([`${IN}/r2-a.md`])));
  eq(out.map(file => file.path), [
    `${IN}/r1-a.md`, // requested
    `${IN}/r3-b.md`, `${IN}/r3-a.md`, `${IN}/進度.md`, // 進度 and latest round, newest first
    `${IN}/r1-b.md`, 'Other/att.md' // the rest: older write first-in-time last
  ]);
  assert.equal(out[0].requested, true);
  assert.equal(out.some(file => file.path === `${IN}/r2-a.md`), false);
  // Attached (seq 0, round 0) goes after the written files of the older round.
  assert.equal(out.at(-1).path, 'Other/att.md');
  assert.equal(out.length, 6);
  // The queue was emptied.
  assert.equal((await chat.carry(new Set())).some(file => file.requested), false);
});

test('restored files are round 0: they do not count as the latest reply', async () => {
  const { chat, files } = world();
  files.set(`${IN}/old.md`, 'o');
  files.set(`${IN}/new.md`, 'n');
  chat.restore('c1', [{ path: `${IN}/old.md`, hash: contentHash('o') }], []);
  chat.startRound();
  chat.noteWrite(`${IN}/new.md`, 'n', true);
  eq(plain(await chat.carry(new Set())).map(file => file.path), [`${IN}/new.md`, `${IN}/old.md`]);
  assert.equal(await chat.readableNow(`${IN}/old.md`), true);
});

test('marksFor: once per conversation, all again on another, restored keys not re-marked, own before attached', async () => {
  const { chat } = world();
  chat.noteAttached('Other/a.md', 'a');
  chat.noteWrite(`${IN}/w.md`, 'w', true);
  chat.noteWrite(`${IN}/w.md`, 'w2', false);
  const first = plain(chat.marksFor('c1'));
  eq(first, [
    { kind: 'file_written', path: `${IN}/w.md`, hash: contentHash('w') },
    { kind: 'file_written', path: `${IN}/w.md`, hash: contentHash('w2') },
    { kind: 'file_attached', path: 'Other/a.md', hash: contentHash('a') }
  ]);
  eq(chat.marksFor('c1'), []);
  assert.equal(chat.marksFor('c2').length, 3);
  eq(chat.marksFor('c2'), []);
  const other = world().chat;
  other.restore('r1', [{ path: `${IN}/w.md`, hash: contentHash('w') }], [{ path: 'Other/a.md', hash: contentHash('a') }]);
  other.noteWrite(`${IN}/w.md`, 'w2', false);
  eq(plain(other.marksFor('r1')), [{ kind: 'file_written', path: `${IN}/w.md`, hash: contentHash('w2') }]);
});

test('restore adds to what is held and does not clear', async () => {
  const { chat, files } = world();
  files.set(`${IN}/a.md`, 'a');
  files.set(`${IN}/b.md`, 'b');
  chat.noteWrite(`${IN}/a.md`, 'a', true);
  chat.restore('c1', [{ path: `${IN}/b.md`, hash: contentHash('b') }], []);
  eq(chat.readablePaths(), [`${IN}/a.md`, `${IN}/b.md`]);
});

test('reset clears everything but the counters do not go back to zero', async () => {
  const { chat, files } = world();
  files.set(`${IN}/a.md`, 'a');
  chat.startRound(); chat.startRound();
  chat.noteWrite(`${IN}/a.md`, 'a', true);
  chat.noteAttached('Other/z.md', 'z');
  await chat.acceptRead(`${IN}/a.md`);
  chat.marksFor('c1');
  chat.reset();
  eq(chat.readablePaths(), []);
  assert.equal(chat.isAttached('Other/z.md'), false);
  eq(await chat.carry(new Set()), []);
  assert.equal(await chat.acceptRead(`${IN}/a.md`), null);
  // marks start over, and the old queue is gone.
  chat.noteWrite(`${IN}/a.md`, 'a', true);
  assert.equal(chat.marksFor('c1').length, 1);
  assert.equal((await chat.carry(new Set())).some(file => file.requested), false);
  // Counters: rounds keep counting (round 3 now), so a 2-round-old file is not "latest" against the new write.
  files.set(`${IN}/b.md`, 'b');
  chat.startRound();
  chat.noteWrite(`${IN}/b.md`, 'b', true);
  eq(plain(await chat.carry(new Set())).map(file => file.path), [`${IN}/b.md`, `${IN}/a.md`]);
});

test('path normalization: ./ and double-slash forms reach the same key', async () => {
  const { chat, files } = world();
  files.set(`${IN}/a.md`, 'a');
  chat.noteWrite(`${IN}/./a.md`, 'a', true);
  assert.equal(await chat.readableNow(`${IN}/a.md`), true);
  assert.equal((await chat.acceptRead(`${IN}//a.md`))?.path, `${IN}/a.md`);
});

test('restoring another version keeps all own hashes while resetting its write order', async () => {
  const { chat, files } = world();
  const a = `${IN}/a.md`, b = `${IN}/b.md`;
  chat.startRound();
  chat.noteWrite(a, 'first', true);
  chat.noteWrite(a, 'second', false);
  chat.noteWrite(b, 'other', true);
  chat.restore('c1', [{ path: a, hash: contentHash('restored') }], []);
  files.set(a, 'first'); files.set(b, 'other');
  assert.equal(await chat.readableNow(a), true);
  eq((await chat.carry(new Set())).map(file => file.path), [b, a]);
  files.set(a, 'restored');
  assert.equal(await chat.readableNow(a), true);
  eq(chat.marksFor('c1').filter(mark => mark.path === a).map(mark => mark.hash), [contentHash('first'), contentHash('second')]);
});
