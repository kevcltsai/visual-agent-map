// Map chat records (P1): schema v1 core (ids, paths, reading, restoring) and the writer on the fake vault. No UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');
const records = load('core/map-chat-records.ts');
const { MapChatRecordWriter } = load('experiences/visual-map/map-chat-record-writer.ts');

const ROOT = 'Maps/Steak';
const T0 = '2026-11-06T10:00:00.000Z';
const target = (root = ROOT) => ({ root, mapPath: `${root}/Map.md`, mapId: 'map-1' });
const REQUEST = { step: { id: 'map-chat', version: 15 }, model: 'claude:sonnet', reasoning: 'low', language: 'en', contentLanguage: 'en', message: 'hi', context: { json: '{}' } };
const turnStart = (turn, extra = {}) => ({ type: 'turn_start', turn, message: 'hi', request: REQUEST, ...extra });
const turnEnd = (turn, extra = {}) => ({ type: 'turn_end', turn, status: 'done', raw: '{"reply":"yo"}', reply: 'yo', lines: [{ status: 'done', text: 'renamed' }], modelLabel: 'Sonnet', ...extra });
function setup(options = {}) {
  const fx = S.fixture('en');
  const events = { logs: [], failures: 0 };
  let tick = 0;
  const state = { disposed: false };
  const writer = new MapChatRecordWriter({
    app: fx.app,
    log: (level, message) => events.logs.push({ level, message }),
    disposed: () => state.disposed,
    onFailure: () => { events.failures++; },
    pluginVersion: '9.9.9',
    now: () => new Date(Date.parse(T0) + (tick++) * 1000),
    random: () => 0.5,
    ...options
  });
  writer.setTarget(target());
  const recordFiles = () => [...fx.files.keys()].filter(path => path.endsWith('.jsonl'));
  const lines = path => (fx.contents.get(path) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { fx, writer, events, state, recordFiles, lines };
}

// ---- core ----
test('ids sort by time, are file-safe, and paths are whitelisted', () => {
  const a = records.newRecordId(new Date('2026-11-06T21:40:12Z'), () => 0);
  const b = records.newRecordId(new Date('2026-11-06T21:40:13Z'), () => 0);
  assert.match(a, /^20261106-214012-0{6}$/);
  assert.ok(a < b);
  assert.equal(records.isRecordId(records.newRecordId()), true);
  assert.equal(records.recordPath('Maps/Steak', a), `Maps/Steak/Chats/records/${a}.jsonl`);
  for (const root of ['../x', 'Maps/../x', '/abs', 'C:/x', '.obsidian/plugins', 'Maps/.obsidian/x', 'Maps//x', '', 'a\\b', 'Maps/.'])
    assert.throws(() => records.recordPath(root, a), error => error.name === 'RecordPathError', root);
  assert.throws(() => records.recordPath('Maps/x', '../evil'), error => error.name === 'RecordPathError');
  assert.throws(() => records.recordPath('Maps/x', '20261106-214012-ABCDEF'), error => error.name === 'RecordPathError');
  assert.throws(() => records.recordPath('Maps/.cfg/x', a, '.cfg'), error => error.name === 'RecordPathError');
});
test('reading: a cut last line is skipped, the rest restores; a v:2 line makes the file unrecoverable', () => {
  const full = [{ v: 1, type: 'conversation', id: 'x', startedAt: T0, mapPath: 'M', mapId: 'm' }, { v: 1, type: 'turn_start', turn: 1, at: T0, message: 'q' }, { v: 1, type: 'turn_end', turn: 1, at: T0, status: 'done', raw: null, reply: 'a', lines: [], modelLabel: 'L' }]
    .map(line => JSON.stringify(line)).join('\n');
  const cut = `${full}\n{"v":1,"type":"turn_start","turn":2,"at":"2026-11-06T1`;
  const parsed = records.parseRecord(cut);
  assert.equal(parsed.lines.length, 3);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.unrecoverable, false);
  const restored = records.restoreConversation('x', parsed.lines);
  assert.deepEqual(S.plain(restored.turns.map(turn => [turn.turn, turn.message, turn.reply])), [[1, 'q', 'a']]);
  const future = records.parseRecord(`${full}\n${JSON.stringify({ v: 2, type: 'turn_start', turn: 2 })}`);
  assert.equal(future.unrecoverable, true);
});
test('reading: a v:2 line with no type still makes the file unrecoverable; a typeless v:1 line is only skipped', () => {
  const head = JSON.stringify({ v: 1, type: 'conversation', id: 'x', startedAt: T0, mapPath: 'M', mapId: 'm' });
  const future = records.parseRecord(`${head}\n${JSON.stringify({ v: 2, turn: 1 })}`);
  assert.equal(future.unrecoverable, true);
  const odd = records.parseRecord(`${head}\n${JSON.stringify({ v: 1, turn: 1 })}\n${JSON.stringify({ turn: 2 })}`);
  assert.equal(odd.unrecoverable, false); assert.equal(odd.skipped, 2); assert.equal(odd.lines.length, 1);
});
test('latest conversation: greatest last-line time wins, ties compare the id, a v:2 latest is reported not skipped', () => {
  const line = at => `${JSON.stringify({ v: 1, type: 'event', turn: 1, at, kind: 'resend' })}\n`;
  const id = (n, s) => `2026110${n}-100000-${s}`;
  const files = [{ id: id(1, 'aaaaaa'), text: line('2026-11-05T10:00:00Z') }, { id: id(2, 'bbbbbb'), text: line('2026-11-05T12:00:00Z') }, { id: id(3, 'cccccc'), text: line('2026-11-05T12:00:00Z') }];
  assert.equal(records.pickLatest(files).id, id(3, 'cccccc'));
  assert.equal(records.pickLatest([files[0], { id: id(4, 'dddddd'), text: '' }]).id, id(1, 'aaaaaa'));
  const future = { id: '20261106-100000-eeeeee', text: `${JSON.stringify({ v: 2, type: 'x', at: '2026-11-06T00:00:00Z' })}\n` };
  const picked = records.pickLatest([...files, future]);
  assert.equal(picked.id, future.id);
  assert.equal(picked.parsed.unrecoverable, true);
  assert.equal(records.pickLatest([]), null);
});
test('restoring keeps only done and plan turns; a plan is stale; an undone reply still shows', () => {
  const at = n => `2026-11-06T10:0${n}:00.000Z`;
  const lines = [
    { v: 1, type: 'turn_start', turn: 1, at: at(0), message: 'one' }, { v: 1, type: 'turn_end', turn: 1, at: at(1), status: 'done', raw: '{}', reply: 'r1', lines: [], modelLabel: 'L' },
    { v: 1, type: 'event', turn: 1, at: at(2), kind: 'undo' },
    { v: 1, type: 'turn_start', turn: 2, at: at(2), message: 'two' }, { v: 1, type: 'turn_end', turn: 2, at: at(3), status: 'failed', raw: null, reply: '', lines: [], modelLabel: 'L' },
    { v: 1, type: 'turn_start', turn: 3, at: at(3), message: 'three' }, { v: 1, type: 'turn_end', turn: 3, at: at(4), status: 'plan', raw: '{}', reply: 'r3', lines: [], modelLabel: 'L' },
    { v: 1, type: 'plan', turn: 3, at: at(5), state: 'applied', lines: [] },
    { v: 1, type: 'turn_start', turn: 4, at: at(5), message: 'four' }, { v: 1, type: 'turn_end', turn: 4, at: at(6), status: 'stopped', raw: null, reply: '', lines: [], modelLabel: 'L' }
  ];
  const restored = records.restoreConversation('id', lines);
  assert.deepEqual(S.plain(restored.turns.map(turn => [turn.turn, turn.status, turn.stalePlan, turn.undone])), [[1, 'done', false, true], [3, 'plan', true, false]]);
  assert.equal(restored.restoredAt, at(4));
});

// ---- writer ----
test('turn lines carry request, step id/version, model, raw output and visible rows', async () => {
  const { writer, recordFiles, lines, fx } = setup();
  writer.write(turnStart(1));
  writer.write(turnEnd(1));
  writer.write(turnStart(2, { message: 'bad' }));
  writer.write(turnEnd(2, { status: 'failed', raw: 'not json at all {', reply: '', lines: [], error: { text: 'invalid', technical: 'MapChatError: invalid' } }));
  await writer.idle();
  const [path, ...rest] = recordFiles();
  assert.equal(rest.length, 0);
  assert.equal(path, `${ROOT}/Chats/records/${writer.conversationId}.jsonl`);
  const all = lines(path);
  assert.ok(all.every(line => line.v === 1));
  assert.deepEqual(all.map(line => line.type), ['conversation', 'turn_start', 'turn_end', 'turn_start', 'turn_end']);
  assert.deepEqual({ id: all[0].id, mapPath: all[0].mapPath, mapId: all[0].mapId, pluginVersion: all[0].pluginVersion }, { id: writer.conversationId, mapPath: `${ROOT}/Map.md`, mapId: 'map-1', pluginVersion: '9.9.9' });
  assert.deepEqual(all[1].request.step, { id: 'map-chat', version: 15 });
  assert.equal(all[1].request.model, 'claude:sonnet');
  assert.equal(all[2].raw, '{"reply":"yo"}');
  assert.deepEqual(all[2].lines, [{ status: 'done', text: 'renamed' }]);
  assert.equal(all[4].raw, 'not json at all {');
  assert.ok(all.slice(1).every(line => typeof line.at === 'string'));
  assert.ok(fx.files.has(`${ROOT}/Chats`));
});
test('nothing is created before the first line; an unmanaged map keeps lines in memory until moveTo', async () => {
  const { writer, recordFiles, lines, fx } = setup();
  assert.equal(recordFiles().length, 0);
  writer.setTarget({ root: null, mapPath: '', mapId: '' });
  writer.write(turnStart(1));
  writer.write(turnEnd(1));
  await writer.idle();
  assert.equal(recordFiles().length, 0);
  assert.equal([...fx.files.keys()].filter(path => path.includes('Chats')).length, 0);
  assert.equal(writer.unsaved, true);
  assert.equal(await writer.moveTo(target('Maps/Created')), true);
  assert.deepEqual(recordFiles(), [`Maps/Created/Chats/records/${writer.conversationId}.jsonl`]);
  assert.deepEqual(lines(recordFiles()[0]).map(line => line.type), ['conversation', 'turn_start', 'turn_end']);
  assert.equal(writer.unsaved, false);
});
test('moveTo renames the file after queued lines, writes a moved line, and the next line goes to the new place', async () => {
  const { writer, recordFiles, lines, fx } = setup();
  writer.write(turnStart(1));
  writer.write(turnEnd(1));
  const moved = writer.moveTo(target('Maps/Other'));
  writer.write(turnStart(2));
  assert.equal(await moved, true);
  await writer.idle();
  assert.deepEqual(recordFiles(), [`Maps/Other/Chats/records/${writer.conversationId}.jsonl`]);
  assert.deepEqual(lines(recordFiles()[0]).map(line => line.type), ['conversation', 'turn_start', 'turn_end', 'moved', 'turn_start']);
  assert.deepEqual(lines(recordFiles()[0])[3].from, `${ROOT}/Map.md`);
  assert.equal(fx.files.has(`${ROOT}/Chats/records/${writer.conversationId}.jsonl`), false);
});
test('moveTo failing leaves the file in place and reports once', async () => {
  const { writer, recordFiles, events, fx } = setup();
  writer.write(turnStart(1));
  await writer.idle();
  const original = recordFiles()[0];
  fx.app.vault.rename = async () => { throw new Error('rename boom'); };
  assert.equal(await writer.moveTo(target('Maps/Other')), false);
  assert.deepEqual(recordFiles(), [original]);
  assert.equal(events.failures, 1);
  assert.equal(writer.failed, true);
});
test('path escape: a root with .. or .obsidian or an absolute path is refused and nothing is written', async () => {
  for (const root of ['../out', 'Maps/../../out', '.obsidian/plugins/x', '/abs/place']) {
    const { writer, recordFiles, events, fx } = setup();
    writer.setTarget(target(root));
    writer.write(turnStart(1));
    await writer.idle();
    assert.equal(recordFiles().length, 0, root);
    assert.equal([...fx.files.keys()].some(path => path.includes('Chats') || path.includes('..')), false, root);
    assert.equal(events.failures, 1, root);
  }
});
test('append failure retries once with a re-resolved file, then reports exactly once', async () => {
  const { writer, recordFiles, events, fx, lines } = setup();
  writer.write(turnStart(1));
  await writer.idle();
  const path = recordFiles()[0];
  const real = fx.app.vault.append;
  let calls = 0;
  fx.app.vault.append = async (file, data) => { calls++; if (calls === 1) throw new Error('once'); return real(file, data); };
  writer.write(turnEnd(1));
  await writer.idle();
  assert.equal(calls, 2);
  assert.equal(events.failures, 0);
  assert.equal(lines(path).at(-1).type, 'turn_end');
  fx.app.vault.append = async () => { calls++; throw new Error('always'); };
  calls = 0;
  writer.write(turnStart(2));
  writer.write(turnEnd(2));
  writer.write(turnStart(3));
  await writer.idle();
  assert.equal(events.failures, 1);
  assert.equal(events.logs.filter(entry => entry.level === 'error').length, 1);
  assert.equal(writer.failed, true);
  assert.ok(calls >= 4);
  // the lines that failed are kept and written with the next successful append
  fx.app.vault.append = real;
  writer.write(turnEnd(3));
  await writer.idle();
  assert.deepEqual(lines(path).slice(-4).map(line => `${line.type}${line.turn}`), ['turn_start2', 'turn_end2', 'turn_start3', 'turn_end3']);
  assert.equal(writer.failed, false);
  assert.equal(events.failures, 1);
});
test('a record deleted while the writer holds its handle is made again with the conversation header', async () => {
  const { writer, recordFiles, fx, lines } = setup();
  writer.write(turnStart(1));
  await writer.idle();
  const path = recordFiles()[0];
  // The user trashed the file: a real Vault.append on that handle would write the path again without any header.
  fx.files.delete(path); fx.contents.delete(path);
  writer.write(turnEnd(1));
  await writer.idle();
  assert.deepEqual(lines(path).map(line => line.type), ['conversation', 'turn_end']);
  assert.equal(lines(path)[0].id, path.split('/').at(-1).replace('.jsonl', ''));
  writer.write(turnStart(2));
  await writer.idle();
  assert.deepEqual(lines(path).map(line => line.type), ['conversation', 'turn_end', 'turn_start']);
});
test('turn fence: a late turn_start or turn_end of an ended turn adds no line; plan lines still follow', async () => {
  const { writer, recordFiles, lines } = setup();
  writer.write(turnStart(1));
  writer.write(turnEnd(1, { status: 'stopped', raw: null, reply: '', lines: [] }));
  writer.write(turnEnd(1));
  writer.write(turnStart(1));
  writer.write({ type: 'plan', turn: 1, state: 'cancelled', lines: [] });
  await writer.idle();
  assert.deepEqual(lines(recordFiles()[0]).slice(1).map(line => `${line.type}:${line.status ?? line.state}`), ['turn_start:undefined', 'turn_end:stopped', 'plan:cancelled']);
});
test('writer drops writes after dispose', async () => {
  const { writer, recordFiles, lines, state } = setup();
  writer.write(turnStart(1));
  await writer.idle();
  const path = recordFiles()[0];
  const before = lines(path).length;
  writer.write(turnEnd(1));
  writer.write(turnStart(2));
  writer.dispose();
  await writer.idle();
  assert.equal(lines(path).length, before, 'queued but not yet run work is dropped');
  writer.write(turnEnd(2));
  await writer.idle();
  assert.equal(lines(path).length, before);
  // the repository being disposed has the same effect
  const other = setup();
  other.writer.write(turnStart(1));
  other.state.disposed = true;
  await other.writer.idle();
  assert.equal(other.recordFiles().length, 0);
  assert.equal(state.disposed, false);
});
test('close and switch-off: queued lines run, new ones are dropped; idle waits for the chain', async () => {
  const { writer, recordFiles, lines } = setup();
  writer.write(turnStart(1));
  writer.write(turnEnd(1, { status: 'aborted', reason: 'view_closed', raw: null, reply: '', lines: [] }));
  writer.close();
  writer.write(turnStart(2));
  await writer.idle();
  assert.deepEqual(lines(recordFiles()[0]).map(line => line.type), ['conversation', 'turn_start', 'turn_end']);
  const off = setup();
  off.writer.write(turnStart(1));
  off.writer.setEnabled(false);
  off.writer.write(turnEnd(1));
  await off.writer.idle();
  assert.deepEqual(off.lines(off.recordFiles()[0]).map(line => line.type), ['conversation', 'turn_start']);
});
test('newConversation: the previous file is untouched and the next line opens a new one', async () => {
  const { writer, recordFiles, lines } = setup();
  writer.write(turnStart(1));
  const first = writer.conversationId;
  writer.newConversation();
  writer.write(turnStart(1));
  await writer.idle();
  assert.notEqual(writer.conversationId, first);
  const files = recordFiles();
  assert.equal(files.length, 2);
  assert.ok(files.every(path => lines(path).filter(line => line.type === 'turn_start').length === 1));
});
test('backfill writes finished turns as backfilled turn_start plus turn_end and fences them', async () => {
  const { writer, recordFiles, lines } = setup();
  writer.backfill([{ turn: 1, message: 'old q', reply: 'old a', lines: [], modelLabel: 'L' }]);
  writer.write(turnEnd(1));
  writer.write(turnStart(2));
  await writer.idle();
  const all = lines(recordFiles()[0]);
  assert.deepEqual(all.map(line => line.type), ['conversation', 'turn_start', 'turn_end', 'turn_start']);
  assert.equal(all[1].backfilled, true);
  assert.equal(all[1].request, undefined);
  assert.equal(all[2].raw, null);
});
test('records follow a folder rename: the writer holds the file handle, so the next append lands at the new path', async () => {
  const { writer, recordFiles, lines, fx } = setup();
  await fx.app.vault.createFolder('Maps');
  await fx.app.vault.createFolder(ROOT);
  writer.write(turnStart(1));
  await writer.idle();
  await fx.app.vault.rename(fx.files.get(ROOT), 'Maps/Renamed');
  writer.write(turnEnd(1));
  await writer.idle();
  assert.deepEqual(recordFiles(), [`Maps/Renamed/Chats/records/${writer.conversationId}.jsonl`]);
  assert.deepEqual(lines(recordFiles()[0]).map(line => line.type), ['conversation', 'turn_start', 'turn_end']);
  assert.equal(fx.files.has(`${ROOT}/Chats/records/${writer.conversationId}.jsonl`), false);
});
test('resume appends to an existing file and a v1 fixture with a cut last line restores', async () => {
  const { writer, recordFiles, fx } = setup();
  const id = records.newRecordId(new Date(T0), () => 0.1);
  const path = records.recordPath(ROOT, id);
  await fx.app.vault.createFolder(ROOT);
  await fx.app.vault.createFolder(`${ROOT}/Chats`);
  await fx.app.vault.createFolder(`${ROOT}/Chats/records`);
  const base = `${JSON.stringify({ v: 1, type: 'conversation', id, startedAt: T0, mapPath: `${ROOT}/Map.md`, mapId: 'map-1', pluginVersion: '1' })}\n${JSON.stringify({ v: 1, type: 'turn_start', turn: 1, at: T0, message: 'q' })}\n${JSON.stringify({ v: 1, type: 'turn_end', turn: 1, at: T0, status: 'done', raw: null, reply: 'a', lines: [], modelLabel: 'L' })}\n`;
  const file = await fx.app.vault.create(path, `${base}{"v":1,"type":"turn_sta`);
  const restored = records.restoreConversation(id, records.parseRecord(fx.contents.get(path)).lines);
  assert.equal(restored.turns.length, 1);
  const parsedFile = records.parseRecord(fx.contents.get(path));
  assert.equal(parsedFile.cleanEnd, false);
  writer.resume(id, file, target(), parsedFile.cleanEnd);
  writer.markEnded([1]);
  writer.write(turnStart(1));
  writer.write(turnStart(2));
  await writer.idle();
  assert.equal(recordFiles().length, 1);
  assert.equal(writer.conversationId, id);
  const after = records.parseRecord(fx.contents.get(path));
  assert.deepEqual(S.plain(after.lines.map(line => `${line.type}${line.turn ?? ''}`)), ['conversation', 'turn_start1', 'turn_end1', 'turn_start2']);
  assert.equal(after.skipped, 1, 'only the cut line is lost');
});
test('a record the Vault index does not list is appended and moved through the adapter', async () => {
  const { writer, fx, state } = setup();
  const id = records.newRecordId(new Date(T0), () => 0.2);
  const path = records.recordPath(ROOT, id);
  for (const folder of [ROOT, `${ROOT}/Chats`, `${ROOT}/Chats/records`]) await fx.app.vault.createFolder(folder);
  const line = `${JSON.stringify({ v: 1, type: 'conversation', id, startedAt: T0, mapPath: `${ROOT}/Map.md`, mapId: 'map-1', pluginVersion: '1' })}\n`;
  await fx.app.vault.adapter.write(path, line);
  fx.app.vault.getAbstractFileByPath = p => (p.endsWith('.jsonl') ? undefined : fx.files.get(p)); // the index hides it
  writer.resume(id, path, target(), true);
  assert.equal(writer.landed, true);
  writer.write(turnStart(1));
  await writer.moveTo(target('Maps/Moved'));
  writer.write(turnEnd(1));
  await writer.idle();
  const moved = records.recordPath('Maps/Moved', id);
  assert.equal(fx.contents.has(path), false, 'the old path is gone');
  assert.deepEqual(S.plain(records.parseRecord(fx.contents.get(moved)).lines.map(item => item.type)), ['conversation', 'turn_start', 'moved', 'turn_end']);
  assert.equal(writer.failed, false);
  void state;
});
test('the writer never calls plugin.mutate', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(S.root, 'experiences/visual-map/map-chat-record-writer.ts'), 'utf8');
  assert.equal(/mutate/.test(source), false);
});
