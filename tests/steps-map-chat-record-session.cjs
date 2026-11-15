// MapChatRecordSession (C1): the view's conversation-record session on fake ports and a fake writer. No UI, no vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');
const { MapChatRecordSession } = load('experiences/visual-map/map-chat-record-session.ts', { obsidian: S.obsidian });
const records = load('core/map-chat-records.ts');
const step = load('core/steps/map-chat/step.ts');

const ROOT = 'Maps/Steak';
const ID = '20261106-100000-000000';
const DIR = `${ROOT}/Chats/records`;
const TARGET = { root: ROOT, mapPath: `${ROOT}/Map.md`, mapId: 'm1' };
const REQUEST = { step: { id: 'map-chat', version: 15 }, model: 'claude:sonnet', reasoning: 'low', language: 'en', contentLanguage: 'en', message: 'hi', context: { json: '{}' } };

function fakeWriter() {
  const w = {
    calls: [], lines: [], unsaved: false, conversationId: 'conv-1',
    setTarget(t) { w.calls.push(['setTarget', t]); },
    newConversation() { w.calls.push(['newConversation']); w.conversationId = 'conv-2'; },
    backfill(turns) { w.calls.push(['backfill']); w.backfilled = turns; },
    write(line) { w.lines.push(JSON.parse(JSON.stringify(line))); },
    resume(...args) { w.calls.push(['resume', ...args]); },
    markEnded(turns) { w.calls.push(['markEnded', turns]); },
    close() { w.calls.push(['close']); },
    dispose() { w.calls.push(['dispose']); }
  };
  return w;
}
function rig(options = {}) {
  const state = { enabled: true, closed: false, disposed: false, target: TARGET, logs: [], created: 0, registered: 0, unregistered: 0, fs: new Map(), ...options };
  const writer = fakeWriter();
  const session = new MapChatRecordSession({
    enabled: () => state.enabled, closed: () => state.closed, disposed: () => state.disposed, target: () => state.target,
    createWriter: () => { state.created++; return writer; },
    register: () => { state.registered++; return () => { state.unregistered++; }; },
    log: message => state.logs.push(message),
    files: {
      exists: async p => (state.existsGate ? state.existsGate.then(() => state.fs.has(p) || [...state.fs.keys()].some(k => k.startsWith(`${p}/`))) : state.fs.has(p) || [...state.fs.keys()].some(k => k.startsWith(`${p}/`))),
      list: async d => ({ files: [...state.fs.keys()].filter(k => k.startsWith(`${d}/`)) }),
      read: async p => state.fs.get(p)
    },
    configDir: '.obsidian'
  });
  return { session, writer, state };
}
const plain = value => JSON.parse(JSON.stringify(value));
const msg = (text, extra = {}) => ({ text, lines: [], ...extra });
const turnOf = (q, a, extra = {}) => ({ question: msg(q), answer: msg(a, extra) });
const chatOf = (turns) => ({ conversationId: null, completedTurns: () => turns });
const handle = () => ({ assistant: msg('') , user: msg(''), retired: [] });
const origin = (extra = {}) => ({ text: 'hi', chips: [], selectedIds: [], ...extra });
const starts = writer => writer.lines.filter(l => l.type === 'turn_start');
const rec = (type, turn, extra = {}) => records.serializeLine({ type, turn, at: '2026-11-06T10:00:00.000Z', ...extra });
const fileText = () => [
  rec('turn_start', 1, { message: 'a', request: REQUEST }),
  rec('turn_end', 1, { status: 'done', raw: null, reply: 'r', lines: [], modelLabel: '' }),
  rec('turn_start', 2, { message: 'b', request: REQUEST }),
  rec('turn_end', 2, { status: 'done', raw: null, reply: 'r2', lines: [], modelLabel: '' })
].join('\n') + '\n';

test('switch off: ensure builds no writer, does not register, returns null; end and close do nothing', () => {
  const { session, state } = rig({ enabled: false });
  assert.equal(session.ensure(), null);
  assert.equal(session.writer, null);
  assert.equal(state.created, 0); assert.equal(state.registered, 0);
  session.end('done'); session.close();
  assert.equal(state.unregistered, 0);
});

test('a closed view builds no writer either', () => {
  const { session, state } = rig({ closed: true });
  assert.equal(session.ensure(), null);
  assert.equal(state.created, 0);
});

test('ensure makes one writer, sets its target and registers it once', () => {
  const { session, writer, state } = rig();
  assert.equal(session.ensure(), writer);
  assert.equal(session.ensure(), writer);
  assert.equal(state.created, 1); assert.equal(state.registered, 1);
  assert.deepEqual(writer.calls[0], ['setTarget', TARGET]);
});

test('switch turned on mid-conversation: first begin backfills 1..n then turn_start n+1; the second begin does not backfill', () => {
  const { session, writer } = rig();
  const turns = [turnOf('q1', 'a1'), turnOf('q2', 'a2')];
  const chat = chatOf(turns);
  session.ensure();
  const record = session.begin(chat, handle(), REQUEST, origin(), false);
  assert.deepEqual(writer.backfilled.map(t => t.turn), [1, 2]);
  assert.deepEqual(writer.backfilled.map(t => t.message), ['q1', 'q2']);
  assert.equal(starts(writer)[0].turn, 3);
  assert.equal(record.turn, 3);
  assert.equal(chat.conversationId, 'conv-1');
  assert.equal(session.last, record);
  assert.ok(turns.every(t => session.isLogged(t.answer)));
  writer.calls.length = 0;
  session.begin(chat, handle(), REQUEST, origin(), false);
  assert.equal(writer.calls.filter(c => c[0] === 'backfill').length, 0);
  assert.equal(starts(writer)[1].turn, 4);
});

test('backfill carries only live steers and the settled lines', () => {
  const { session, writer } = rig();
  const turn = { question: msg('q', { steers: [{ state: 'live', text: 'x' }, { state: 'queued', text: 'y' }] }), answer: msg('a', { modelLabel: 'Sonnet' }) };
  session.ensure();
  session.begin(chatOf([turn]), handle(), REQUEST, origin(), false);
  assert.deepEqual(writer.backfilled[0].steers, ['x']);
  assert.equal(writer.backfilled[0].modelLabel, 'Sonnet');
});

test('turn_start carries autoApply and the chain fields only when set', () => {
  const { session, writer } = rig();
  session.ensure();
  session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  const plain = starts(writer)[0];
  assert.equal('autoApply' in plain, false); assert.equal('auto' in plain, false);
  const chain = { state: { round: 2 }, continuation: { remaining: ' more ' }, resumed: true };
  session.begin(chatOf([]), handle(), REQUEST, origin({ chain }), true);
  const second = starts(writer)[1];
  assert.equal(second.autoApply, true); assert.equal(second.auto, true); assert.equal(second.round, 2);
  assert.equal(second.resumed, true); assert.equal(second.remaining, ' more ');
  session.begin(chatOf([]), handle(), REQUEST, origin({ chain: { state: { round: 1 }, continuation: { remaining: '  ' } } }), false);
  const third = starts(writer)[2];
  assert.equal('resumed' in third, false); assert.equal('remaining' in third, false);
});

test('turn_start chips: topic keeps id only, snippet path and text, file path only', () => {
  const { session, writer } = rig();
  session.ensure();
  const chips = [
    { kind: 'topic', id: 't1', title: 'T', path: 'p/t.md' },
    { kind: 'snippet', path: 'p/s.md', text: 'tx', extra: 1 },
    { kind: 'file', path: 'p/f.md', text: 'nope' }
  ];
  session.begin(chatOf([]), handle(), REQUEST, origin({ chips, selectedIds: ['a'] }), false);
  assert.deepEqual(plain(starts(writer)[0].origin), { chips: [{ kind: 'topic', id: 't1' }, { kind: 'snippet', path: 'p/s.md', text: 'tx' }, { kind: 'file', path: 'p/f.md' }], selectedIds: ['a'] });
  assert.deepEqual(plain(starts(writer)[0].request.step), { id: step.mapChatStep.id, version: step.mapChatStep.version });
});

test('end writes the turn end once and counts the answer as logged (a stopped turn with text is not backfilled again)', () => {
  const { session, writer } = rig();
  session.ensure();
  const h = handle();
  h.assistant.text = 'partial'; h.assistant.streaming = true;
  const record = session.begin(chatOf([]), h, REQUEST, origin(), false);
  assert.equal(session.isLogged(h.assistant), false);
  session.end('stopped');
  session.end('done');
  assert.equal(writer.lines.filter(l => l.type === 'turn_end').length, 1);
  assert.equal(writer.lines.find(l => l.type === 'turn_end').status, 'stopped');
  assert.equal(session.isLogged(h.assistant), true);
  assert.equal(record.isOpen, false);
  writer.calls.length = 0;
  const done = { question: msg('q'), answer: h.assistant };
  session.begin(chatOf([done]), handle(), REQUEST, origin(), false);
  assert.equal(writer.calls.filter(c => c[0] === 'backfill').length, 0);
});

test('end with no record, or one that already ended, does nothing and logs nothing', () => {
  const { session, writer } = rig();
  session.ensure();
  session.end('aborted');
  assert.equal(writer.lines.length, 0);
  const h = handle();
  const record = session.begin(chatOf([]), h, REQUEST, origin(), false);
  record.end('done');
  const before = writer.lines.length;
  session.end('stopped');
  assert.equal(writer.lines.length, before);
  assert.equal(session.isLogged(h.assistant), false);
});

test('end on a record whose writer moved to another conversation still counts as the first end only (no write, no double)', () => {
  const { session, writer } = rig();
  session.ensure();
  const h = handle();
  session.begin(chatOf([]), h, REQUEST, origin(), false);
  writer.conversationId = 'other';
  session.end('done');
  assert.equal(writer.lines.filter(l => l.type === 'turn_end').length, 0);
});

test('begin throws when the writer throws; last stays as it was', () => {
  const { session, writer } = rig();
  session.ensure();
  const first = session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  writer.write = () => { throw new Error('disk'); };
  // MapChatTurnRecord.write swallows into the log port; a throwing backfill is the propagating path.
  writer.backfill = () => { throw new Error('boom'); };
  assert.throws(() => session.begin(chatOf([turnOf('q', 'a')]), handle(), REQUEST, origin(), false), /boom/);
  assert.equal(session.last, first);
});

test('begin without a writer throws instead of writing', () => {
  const { session } = rig({ enabled: false });
  assert.throws(() => session.begin(chatOf([]), handle(), REQUEST, origin(), false));
});

test('a record write that fails is logged through the log port and the turn goes on', () => {
  const { session, writer, state } = rig();
  session.ensure();
  writer.write = () => { throw new Error('disk full'); };
  const record = session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  assert.ok(record);
  assert.deepEqual(plain(state.logs), ['Error: disk full']); // the vm realm's Error is not this realm's, so the record logs String(error)
});

test('saved: false with no writer, switch off, unsaved writer or an unrecorded finished turn; true without a chat', () => {
  const a = rig({ enabled: false });
  assert.equal(a.session.saved(undefined), false);
  const { session, writer, state } = rig();
  assert.equal(session.saved([]), false); // no writer yet
  session.ensure();
  assert.equal(session.saved(undefined), true);
  assert.equal(session.saved([]), true);
  const turn = turnOf('q', 'a');
  assert.equal(session.saved([turn]), false);
  session.markLogged(turn.answer);
  assert.equal(session.saved([turn]), true);
  writer.unsaved = true;
  assert.equal(session.saved([turn]), false);
  writer.unsaved = false;
  state.enabled = false;
  assert.equal(session.saved([turn]), false);
});

test('close: unregisters and closes, or disposes while the plugin unloads; nothing without a writer', () => {
  const a = rig();
  a.session.close();
  assert.equal(a.state.unregistered, 0);
  a.session.ensure();
  a.session.close();
  assert.equal(a.state.unregistered, 1);
  assert.deepEqual(a.writer.calls.filter(c => c[0] === 'close' || c[0] === 'dispose'), [['close']]);
  const b = rig({ disposed: true });
  b.session.ensure();
  b.session.close();
  assert.equal(b.state.unregistered, 1);
  assert.deepEqual(b.writer.calls.filter(c => c[0] === 'close' || c[0] === 'dispose'), [['dispose']]);
  b.session.close();
  assert.equal(b.state.unregistered, 1);
});

test('restart bumps the epoch, resets turn numbers and last, starts a new conversation on the target', () => {
  const { session, writer, state } = rig();
  session.ensure();
  session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  const epoch = session.epoch;
  state.target = { ...TARGET, mapId: 'm2' };
  session.restart();
  assert.equal(session.epoch, epoch + 1);
  assert.equal(session.last, null);
  const tail = writer.calls.slice(-2);
  assert.deepEqual(tail, [['newConversation'], ['setTarget', state.target]]);
  session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  assert.equal(starts(writer)[1].turn, 1);
});

test('restart without a writer still bumps the epoch and clears last', () => {
  const { session } = rig({ enabled: false });
  session.restart();
  assert.equal(session.epoch, 1);
  assert.equal(session.last, null);
});

test('only restart moves the epoch: begin, end, markLogged and resume do not', async () => {
  const { session, state } = rig();
  session.ensure();
  state.fs.set(`${DIR}/${ID}.jsonl`, fileText());
  session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  session.end('done');
  session.markLogged(msg('x'));
  const latest = await session.readLatest(ROOT);
  session.resume(latest, records.restoreConversation(latest.id, latest.parsed.lines), `${DIR}/${ID}.jsonl`);
  assert.equal(session.epoch, 0);
});

test('a restart while the files are read changes the epoch the restore captured', async () => {
  const { session, state } = rig();
  let open; state.existsGate = new Promise(resolve => { open = resolve; });
  state.fs.set(`${DIR}/${ID}.jsonl`, fileText());
  const epoch = session.epoch;
  const reading = session.readLatest(ROOT);
  session.restart();
  open();
  const latest = await reading;
  assert.ok(latest);
  assert.notEqual(epoch, session.epoch);
});

test('readLatest: folder missing gives null; sub-folder files and non-record files are ignored', async () => {
  const { session, state } = rig();
  assert.equal(await session.readLatest(ROOT), null);
  state.fs.set(`${DIR}/sub/${ID}.jsonl`, fileText());
  state.fs.set(`${DIR}/notes.txt`, 'x');
  state.fs.set(`${DIR}/not-an-id.jsonl`, fileText());
  assert.equal(await session.readLatest(ROOT), null);
  state.fs.set(`${DIR}/${ID}.jsonl`, fileText());
  const latest = await session.readLatest(ROOT);
  assert.equal(latest.id, ID);
  assert.equal(latest.path, `${DIR}/${ID}.jsonl`);
});

test('resume: writer resumes on the file, turns of the file are marked ended, numbering goes on from the highest', async () => {
  const { session, writer } = rig();
  session.ensure();
  const path = `${DIR}/${ID}.jsonl`;
  const latest = records.pickLatest([{ id: ID, path, text: fileText() }]);
  const restored = records.restoreConversation(ID, latest.parsed.lines);
  session.resume(latest, restored, path);
  const resume = writer.calls.find(c => c[0] === 'resume');
  assert.deepEqual(resume.slice(1, 3), [ID, path]);
  assert.deepEqual(resume[3], TARGET);
  assert.equal(resume[4], latest.parsed.cleanEnd);
  assert.deepEqual(plain(writer.calls.find(c => c[0] === 'markEnded')[1]), [1, 1, 2, 2]);
  session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  assert.equal(starts(writer)[0].turn, 3);
});

test('resume with a file that has no turns starts numbering at 1', () => {
  const { session, writer } = rig();
  session.ensure();
  const text = records.serializeLine({ type: 'event', turn: 0, kind: 'research_started', at: '2026-11-06T10:00:00.000Z' }) + '\n';
  const latest = records.pickLatest([{ id: ID, path: `${DIR}/${ID}.jsonl`, text }]);
  session.resume(latest, records.restoreConversation(ID, latest.parsed.lines), `${DIR}/${ID}.jsonl`);
  session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  assert.equal(starts(writer)[0].turn, 1);
});

test('plans and images map a card to its turn record', () => {
  const { session } = rig();
  session.ensure();
  const record = session.begin(chatOf([]), handle(), REQUEST, origin(), false);
  const card = {}, block = {};
  session.plans.set(card, record); session.images.set(block, record);
  assert.equal(session.plans.get(card), record);
  assert.equal(session.images.get(block), record);
});
