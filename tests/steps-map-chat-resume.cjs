// P4.8 resume summary: built only from this map's saved chat records (pure, read only, no provider); the record session reads and never writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { load, root } = require('./support-replay.cjs');
const S = require('./support.cjs');
const resume = load('core/map-chat-resume.ts');
const records = load('core/map-chat-records.ts');
const { MapChatRecordSession } = load('experiences/visual-map/map-chat-record-session.ts', { obsidian: S.obsidian });
const step = load('core/steps/map-chat/step.ts');

const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
const ROOT = 'Maps/Steak';
const DIR = `${ROOT}/Chats/records`;
const REQUEST = { step: { id: 'map-chat', version: 32 }, model: 'm', message: 'x', context: {} };
const at = n => `2026-11-2${n}T10:00:00.000Z`;
const line = (type, extra) => JSON.stringify({ v: 1, type, ...extra });
const head = (id, n, mapId = 'map-1') => line('conversation', { id, startedAt: at(n), mapPath: `${ROOT}/Map.md`, mapId, pluginVersion: '1' });
const start = (turn, n, message, extra = {}) => line('turn_start', { turn, at: at(n), message, request: REQUEST, ...extra });
const end = (turn, n, extra = {}) => line('turn_end', { turn, at: at(n), status: 'done', raw: null, reply: 'ok', lines: [], modelLabel: 'M', ...extra });
const event = (turn, n, kind, extra = {}) => line('event', { turn, at: at(n), kind, ...extra });
const file = (id, rows) => ({ id, path: `${DIR}/${id}.jsonl`, text: rows.join('\n') + '\n' });
const ID1 = '20261125-100000-aaaaaa';
const ID2 = '20261126-100000-bbbbbb';

const researchFile = () => file(ID2, [
  head(ID2, 6),
  start(1, 6, 'Research competitor prices'),
  event(1, 6, 'research_batch', { topics: [{ id: 'n1', title: 'Competitor prices' }, { id: 'n2', title: 'Company C' }], request: {} }),
  end(1, 6),
  event(1, 6, 'research_batch_topic', { id: 'n1', status: 'succeeded' }),
  event(1, 6, 'research_batch_topic', { id: 'n2', status: 'failed' }),
  event(1, 6, 'research_batch_end', { status: 'done' })
]);

test('with records: items name research, what did not finish and the recent request; each item carries the card to focus and its record', () => {
  const summary = resume.buildResumeSummary([researchFile()], 'map-1');
  assert.equal(summary.state, 'items');
  const kinds = summary.items.map(item => item.kind);
  same(kinds, ['research', 'unfinished']);
  const [research, open] = summary.items;
  assert.equal(research.subject, 'Competitor prices / Company C');
  assert.equal([research.done, research.total, research.nodeId].join('|'), '1|2|n1');
  assert.equal([open.subject, open.nodeId].join('|'), 'Company C|n2');
  for (const item of summary.items) assert.ok(item.recordId === ID2 && item.recordPath === `${DIR}/${ID2}.jsonl` && item.turn === 1 && item.at);
});

test('where it stopped: a failed newest turn and an interrupted continuation come first, newest conversation first', () => {
  const failed = file(ID2, [head(ID2, 6), start(1, 6, 'Add pricing cards', { origin: { chips: [], selectedIds: ['n9'] } }), end(1, 6, { status: 'failed', error: { text: 'x', technical: 'y' } })]);
  const older = file(ID1, [head(ID1, 5), start(1, 5, 'Summarise the market'), end(1, 5)]);
  const summary = resume.buildResumeSummary([older, failed], 'map-1');
  same(summary.items.map(item => [item.kind, item.subject, item.recordId]), [['stopped', 'Add pricing cards', ID2], ['recent', 'Summarise the market', ID1]]);
  assert.equal(summary.items[0].nodeId, 'n9');
  const chain = file(ID2, [head(ID2, 6), start(1, 6, 'Plan it', { origin: { chips: [], selectedIds: ['n3'] } }), end(1, 6), event(1, 6, 'chain_end', { reason: 'failed', round: 1, remaining: 'Fill the review part' })]);
  const stopped = resume.buildResumeSummary([chain], 'map-1').items.find(item => item.kind === 'remaining');
  assert.equal(stopped.subject, 'Fill the review part'); assert.equal(stopped.nodeId, 'n3');
});

test('no usable record: empty, never a made-up item (no files, other map, unreadable version, no turns)', () => {
  const none = { state: 'empty', items: [] };
  same(resume.buildResumeSummary([], 'map-1'), none);
  same(resume.buildResumeSummary([researchFile()], 'other-map'), none);
  same(resume.buildResumeSummary([file(ID1, [head(ID1, 5)])], 'map-1'), none);
  const future = file(ID1, [JSON.stringify({ v: 2, type: 'turn_start', turn: 1 })]);
  same(resume.buildResumeSummary([future], 'map-1'), none);
  same(resume.buildResumeSummary([{ id: '../bad', text: researchFile().text }], 'map-1'), none);
});

test('the list is capped, and a hand-edited huge message is cut', () => {
  const rows = [head(ID2, 6)];
  for (let turn = 1; turn <= 20; turn++) rows.push(start(turn, 6, 'm'.repeat(500)), end(turn, 6));
  const summary = resume.buildResumeSummary([file(ID2, rows)], 'map-1');
  assert.equal(summary.items.length, resume.RESUME_TURNS_PER_CONVERSATION);
  assert.ok(summary.items.every(item => item.subject.length <= 120));
});

test('the summary is pure: it reads no module that can call a provider, and the record format and action kinds are unchanged', () => {
  const source = fs.readFileSync(`${root}/core/map-chat-resume.ts`, 'utf8');
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
  same(imports, ['./map-chat-records']);
  assert.equal(records.RECORD_VERSION, 1);
  assert.equal(step.MAP_CHAT_ACTION_KINDS.length, 31);
});

test('the session reads every record file of the map and writes nothing (contents unchanged)', async () => {
  const fs2 = new Map([[`${DIR}/${ID1}.jsonl`, 'a\n'], [`${DIR}/${ID2}.jsonl`, researchFile().text], [`${DIR}/notes.txt`, 'skip'], [`Other/Chats/records/${ID1}.jsonl`, 'skip']]);
  const before = crypto.createHash('sha256').update(JSON.stringify([...fs2])).digest('hex');
  const calls = [];
  const session = new MapChatRecordSession({
    enabled: () => true, closed: () => false, disposed: () => false, target: () => ({ root: ROOT, mapPath: `${ROOT}/Map.md`, mapId: 'map-1' }),
    createWriter: () => { calls.push('createWriter'); throw new Error('no writer'); }, register: () => () => {}, log: () => {},
    files: { exists: async p => [...fs2.keys()].some(k => k.startsWith(`${p}/`)), list: async d => ({ files: [...fs2.keys()].filter(k => k.startsWith(`${d}/`)) }), read: async p => { calls.push(`read ${p}`); return fs2.get(p); } },
    configDir: '.obsidian'
  });
  const files = await session.readAll(ROOT);
  same(files.map(item => item.id), [ID1, ID2]);
  assert.equal(session.writer, null);
  assert.ok(calls.every(call => call.startsWith('read ')));
  assert.equal(crypto.createHash('sha256').update(JSON.stringify([...fs2])).digest('hex'), before);
  same(await new MapChatRecordSession({ ...{ enabled: () => true, closed: () => false, disposed: () => false, target: () => null, createWriter: () => null, register: () => () => {}, log: () => {}, configDir: '.obsidian' }, files: { exists: async () => false, list: async () => ({ files: [] }), read: async () => '' } }).readAll(ROOT), []);
});
