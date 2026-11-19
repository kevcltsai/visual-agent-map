// Picture-book pipeline runner (03a): the gates, retries, budget pause, stop/resume, stale fence, dispose, guarded writes and the picture
// allow-list of BookPipelineRuns, with fake ports over the real repository fixture. The provider, probe and step runner are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load: loadReplay } = require('./support-replay.cjs');
const { BookPipelineRuns, BookPipelineRunError, bodyImageUrls, replaceBodyImages, unsafeBody, convertSourceAnchors } = S.load('experiences/visual-map/book-pipeline-run.ts');
const { BudgetExhaustedError } = S.load('core/admission.ts');
const { readBookPipeline } = S.load('core/book-pipeline/model.ts');
const { cardRevision } = S.load('core/book-pipeline/machine.ts');
const { proofKey, evaluateProof, composeProofRecord } = S.load('core/book-pipeline/proof.ts');
const { findStoredProof, withoutResearchNotes, chapterBody, appendResearchNote, dropPlaceholderSections, markOldProofRecords } = S.load('core/book-pipeline/note-sections.ts');
const { parseChecklist } = S.load('core/book-pipeline/plan-text.ts');
const { stampDetail } = S.load('core/book-pipeline/body-integrity.ts');

const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
const TITLES = ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB'];
const bodyOf = title => `SecretBody ${title}`;
const stageOf = raw => /^pipeline-stage: "?([a-z-]+)"?$/m.exec(raw)?.[1];

/** A map of one root and two child cards (reading order: root, A, B), the fake ports and call counters. `over` replaces ports/script. */
const confirmDone = async (runs, mapPath) => { await runs.confirmGate1(mapPath); while (runs.isRunning(mapPath)) await new Promise(resolve => setImmediate(resolve)); };
async function rig(over = {}) {
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of over.titles ?? TITLES) nodes.push(await repo.createNote(title, 'model-a', doc, mapPath, 'workspace', { summary: `summary of ${title}` }));
  nodes.forEach((node, i) => { node.x = i * 300; node.y = 0; if (i) node.parentId = nodes[0].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { logs: [], plan: [], author: [], proof: [], probes: [], backups: [], writes: 0 };
  let queue = Promise.resolve();
  let ids = 0;
  const script = { global: () => ({ thread: 'one thread', cards: nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } }),
    card: request => ({ covers: `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }] }),
    author: async input => { await input.admission.reserve(); const note = await repo.readNote(input.path); const r = await repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return r === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
    proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked' }),
    probe: async () => ({ ok: true }), ...over.script };
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: path => repo.readMap(path),
    // Most tests here pin the older run without a trial (every card planned before gate 1): the run's `trial` is dropped unless `over.trial`.
    updateMap: (path, change) => repo.updateMap(path, d => { change(d); if (!over.trial && d.bookPipeline) delete d.bookPipeline.trial; }),
    readCard: async path => {
      const note = await repo.readNote(path);
      return { path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(path), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineRole ? { pipelineRole: note.pipelineRole } : {}), ...(note.bookRoleBy ? { bookRoleBy: note.bookRoleBy } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}) } };
    },
    writePipelineFields: (path, patch) => { stat.writes++; return repo.writePipelineFields(path, patch); },
    ...(over.noRolePort ? {} : { writePipelineRole: (path, role) => repo.writePipelineRole(path, role) }),
    updateNoteGuarded: (path, patch, options) => repo.updateNoteGuarded(path, patch, options),
    updateNoteRawGuarded: (path, transform, options) => repo.updateNoteRawGuarded(path, transform, options),
    runPlan: async (step, request, run) => {
      if (step.id === 'book-pipeline.global-plan') { stat.plan.push('global'); await run.admission.reserve(); return script.global(request, stat.plan.filter(x => x === 'global').length); }
      stat.plan.push(request.card.id); await run.admission.reserve(); return script.card(request, stat.plan.filter(x => x === request.card.id).length);
    },
    runProofread: async (request, run) => { stat.proof.push(request); await run.admission.reserve(); return script.proof(request, stat.proof.length); },
    author: input => { stat.author.push(input.nodeId); return script.author(input, stat.author.filter(x => x === input.nodeId).length); },
    probeImage: async (url, signal) => { stat.probes.push(url); return script.probe(url, signal, stat.probes.length); },
    backupNote: async path => { stat.backups.push(path); return { ok: true, path: `${path}.bak` }; },
    blocked: () => false,
    config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z',
    newId: () => `run-${++ids}`,
    log: line => stat.logs.push(line),
    ...over.ports
  };
  const runs = new BookPipelineRuns(ports);
  const state = async () => readBookPipeline(await repo.readMap(mapPath)).data;
  const note = async i => repo.readNote(nodes[i].path);
  const raw = i => contents.get(nodes[i].path);
  return { ...data, runs, ports, stat, script, mapPath, nodes, state, note, raw, mapRaw: () => contents.get(mapPath) };
}
/** Lowers the saved call limit (the pipeline has no port for it; the file is the owner's control). */
const setLimit = (r, limit) => r.repo.updateMap(r.mapPath, d => { d.bookPipeline.budget.limit = limit; });

test('three cards run to gate 1, wait there, then write and proof to gate 2 after confirmGate1', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running'); assert.equal(s.globalPlanned, true);
  assert.deepEqual(r.stat.plan, ['global', ...r.nodes.map(n => n.id)]);
  assert.equal(r.stat.author.length, 0, 'nothing is written before the owner confirms gate 1');
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'planned');
  assert.ok((await r.note(0)).detail === '' || !(await r.note(0)).detail.includes('SecretBody'));
  assert.equal((await r.note(0)).bookRole, 'intro');
  assert.match(r.raw(0), /> \[!vam-book\]- 全書企劃\n> ### 全書主線/);
  assert.doesNotMatch(r.raw(0), /^## 全書企劃/m, 'the book plan is hidden in reading and live preview');
  assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.equal(r.runs.getProgress(r.mapPath).counts.planned, 3);
  await confirmDone(r.runs, r.mapPath);
  await assert.rejects(() => r.runs.confirmGate1(r.mapPath), e => e instanceof BookPipelineRunError && e.code === 'not_gate1');
  s = await r.state();
  assert.equal(s.phase, 'gate2');
  assert.equal(r.stat.author.length, 3);
  for (let i = 0; i < 3; i++) { assert.equal(stageOf(r.raw(i)), 'checked'); assert.ok((await r.note(i)).detail.includes(bodyOf(TITLES[i]))); }
  assert.equal(s.budget.used, 1 + 3 + 3 + 3);
  assert.equal(r.runs.getProgress(r.mapPath).counts.checked, 3);
  assert.deepEqual([...new Set(r.stat.backups)].length, 3);
});

test('a step that fails three times marks the card needs-review with a neutral code; the other cards go on', async () => {
  const bad = { id: '' };
  const r = await rig({ script: { author: async (input, n) => { if (input.nodeId === bad.id) throw new Error('boom'); await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } } });
  bad.id = r.nodes[1].id;
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'gate2');
  assert.equal(r.stat.author.filter(id => id === bad.id).length, 3);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: failed');
  assert.equal(stageOf(r.raw(0)), 'checked'); assert.equal(stageOf(r.raw(2)), 'checked');
});

test('a failed whole-book plan three times holds the run at planning; no card is planned', async () => {
  const r = await rig({ script: { global: () => { throw new Error('nope'); } } });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'planning'); assert.equal(s.attempts.global, 3); assert.equal(s.globalPlanned, false);
  assert.deepEqual(r.stat.plan, ['global', 'global', 'global']);
  assert.equal(r.runs.isRunning(r.mapPath), false);
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), undefined);
});

const planRoles = (r, roles) => ({ thread: 't', cards: r.nodes.map((n, i) => ({ id: n.id, role: roles[i] })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } });
/** Card 2 becomes a child of card 1 (a second level), so its default role is body; card 1 (first level) defaults to intro. */
const deepen = r => r.repo.updateMap(r.mapPath, d => { d.nodes.find(n => n.id === r.nodes[2].id).parentId = r.nodes[1].id; });

test('book roles: a default written before an interrupted global plan stays overridable after resume', async () => {
  let ok = false;
  const holder = {};
  const r = await rig({ script: { global: () => { if (!ok) throw new Error('nope'); return planRoles(holder.r, ['intro', 'intro', 'intro']); } } });
  holder.r = r;
  await deepen(r);
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(2)).bookRole, 'body');
  assert.deepEqual([...(await r.state()).autoRoles].sort(), r.nodes.map(n => n.id).sort());
  ok = true;
  await r.runs.resume(r.mapPath); await settle();
  assert.equal((await r.note(2)).bookRole, 'intro');
});

test('book roles: an owner-set role is never overwritten, on the first run, after resume or on a later run', async () => {
  const holder = {};
  let roles = ['intro', 'body', 'intro'];
  const r = await rig({ script: { global: () => planRoles(holder.r, roles) } });
  holder.r = r;
  await deepen(r);
  await r.repo.writePipelineFields(r.nodes[1].path, { bookRole: 'body' });
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(1)).bookRole, 'body');
  assert.equal((await r.note(2)).bookRole, 'intro', 'the plan overrode the default');
  assert.ok(!(await r.state()).autoRoles.includes(r.nodes[1].id));
  await r.runs.stop(r.mapPath, { saved: true }); await r.runs.resume(r.mapPath); await settle();
  assert.equal((await r.note(1)).bookRole, 'body');
  // A later run: the plan's own choice from the first run is not frozen as the owner's; the owner's still is.
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'done'; });
  roles = ['intro', 'intro', 'body'];
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(2)).bookRole, 'body', 'the earlier plan role is not frozen');
  assert.equal((await r.note(1)).bookRole, 'body', 'the owner role is kept');
});

test('book roles: a role changed by hand after the first run survives a rerun (pipeline-role differs), even with only the older id list', async () => {
  const holder = {};
  let roles = ['intro', 'body', 'body'];
  const r = await rig({ script: { global: () => planRoles(holder.r, roles) } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(1)).bookRole, 'body');
  assert.equal((await r.note(1)).pipelineRole, 'body', 'the pipeline records what it wrote');
  // the owner edits the frontmatter by hand: book-role only
  await r.repo.writePipelineFields(r.nodes[1].path, { bookRole: 'gallery' });
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'done'; });
  roles = ['intro', 'body', 'closing'];
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(1)).bookRole, 'gallery', 'the hand-changed role is kept');
  assert.equal((await r.note(1)).pipelineRole, 'body', 'the record is not touched');
  assert.equal((await r.note(2)).bookRole, 'closing', 'a pipeline-owned role is still reassigned');
  assert.equal((await r.note(2)).pipelineRole, 'closing');
});

test('T14 owner roles: a menu choice (also the same value as the pipeline\'s) survives later drives and a new runner; handing back to AI lets the next plan reassign; the hand-edit difference is recorded as the owner\'s', async () => {
  const holder = {};
  let roles = ['intro', 'body', 'body'];
  const r = await rig({ script: { global: () => planRoles(holder.r, roles) } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  const done = () => r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'done'; });
  // same value as the pipeline wrote (body): still the owner's
  assert.equal((await r.note(1)).bookRoleBy, undefined);
  assert.equal(await r.repo.writeBookRoleChoice(r.nodes[1].path, 'body'), 'written');
  assert.equal((await r.note(1)).bookRoleBy, 'owner');
  roles = ['intro', 'closing', 'closing'];
  await done();
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(1)).bookRole, 'body', 'same-value choice is protected');
  assert.equal((await r.note(2)).bookRole, 'closing');
  // a reopen: a new runner on the same files
  const again = new r.runs.constructor(r.ports);
  roles = ['intro', 'gallery', 'gallery'];
  await done();
  await again.start(r.mapPath);
  assert.equal((await r.note(1)).bookRole, 'body', 'kept across a new runner');
  // handed back to AI: the next global plan may reassign it
  await r.repo.writeBookRoleChoice(r.nodes[1].path, 'ai');
  assert.equal((await r.note(1)).bookRoleBy, 'ai');
  assert.equal((await r.note(1)).pipelineRole, 'body');
  await done();
  await again.start(r.mapPath);
  assert.equal((await r.note(1)).bookRole, 'gallery', 'reassigned by the plan');
  assert.equal((await r.note(1)).bookRoleBy, 'ai');
  // a hand edit of book-role is recorded as the owner's (card 2 keeps its role afterwards)
  await r.repo.writePipelineFields(r.nodes[2].path, { bookRole: 'intro' });
  roles = ['intro', 'gallery', 'closing'];
  await done();
  await again.start(r.mapPath);
  assert.equal((await r.note(2)).bookRole, 'intro');
  assert.equal((await r.note(2)).bookRoleBy, 'owner', 'the hand edit is now written down');
});

test('T14 owner roles: a choice made before any run (no drive) is kept by the first plan; the owner mark is read from book-role-by first, even when pipeline-role equals book-role', async () => {
  const holder = {};
  const r = await rig({ script: { global: () => planRoles(holder.r, ['intro', 'closing', 'closing']) } });
  holder.r = r;
  await r.repo.writeBookRoleChoice(r.nodes[2].path, 'gallery');
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(2)).bookRole, 'gallery');
  assert.equal((await r.note(1)).bookRole, 'closing');
  // the no-role-port fallback path respects it too
  const holder2 = {};
  const q = await rig({ noRolePort: true, script: { global: () => planRoles(holder2.r, ['intro', 'closing', 'closing']) } });
  holder2.r = q;
  await q.repo.writeBookRoleChoice(q.nodes[1].path, 'body');
  await q.runs.start(q.mapPath);
  assert.equal((await q.note(1)).bookRole, 'body');
  assert.equal((await q.note(2)).bookRole, 'closing');
});

test('book roles: the role changed while the global plan is awaited is not overwritten (decided at the write)', async () => {
  for (const noRolePort of [false, true]) {
    const holder = {};
    const r = await rig({ noRolePort, script: { global: async () => { await holder.r.repo.writePipelineFields(holder.r.nodes[2].path, { bookRole: 'gallery' }); return planRoles(holder.r, ['intro', 'body', 'closing']); } } });
    holder.r = r;
    await r.runs.start(r.mapPath);
    assert.equal((await r.note(2)).bookRole, 'gallery', `kept (rolePort ${!noRolePort})`);
    assert.equal((await r.note(2)).pipelineRole, 'intro', 'the default the pipeline had written');
    assert.equal((await r.note(1)).bookRole, 'body');
  }
});

test('book roles: older data without pipeline-role keeps the old behaviour (the id list decides; the plan writes pipeline-role)', async () => {
  const holder = {};
  const r = await rig({ script: { global: () => planRoles(holder.r, ['intro', 'body', 'closing']) } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  // simulate a run saved by an older version: the id list stays, the pipeline-role keys are gone
  for (let i = 0; i < 3; i++) await r.repo.writePipelineFields(r.nodes[i].path, { pipelineRole: null });
  assert.ok((await r.state()).autoRoles.includes(r.nodes[2].id));
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'done'; });
  holder.r = r;
  const g = r.script.global;
  r.script.global = () => planRoles(r, ['intro', 'body', 'gallery']);
  await r.runs.start(r.mapPath);
  assert.equal((await r.note(2)).bookRole, 'gallery', 'an id-listed pipeline role is still overridable');
  assert.equal((await r.note(2)).pipelineRole, 'gallery');
});

test('gate 1 bar: progressed is called after the drive ended (the run no longer running), so the toolbar redraws without reopening the view', async () => {
  const seen = [];
  const r = await rig({ ports: { progressed: () => seen.push({ running: ports().runs.isRunning(r.mapPath), phase: r.runs.getProgress(r.mapPath)?.phase }) } });
  const ports = () => r;
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).phase, 'gate1');
  assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.ok(seen.length > 0 && seen.at(-1).running === false, `the last progressed call comes after the drive ended: ${JSON.stringify(seen.at(-1))}`);
  seen.length = 0;
  await r.runs.confirmGate1(r.mapPath);
  while (r.runs.isRunning(r.mapPath)) await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.at(-1)?.running, false, 'the same at the end of the write drive (gate 2)');
});

test('book roles: data without autoRoles behaves as before (every existing role is the owner\'s; nothing is added to the saved shape)', async () => {
  const holder = {};
  const r = await rig({ script: { global: () => planRoles(holder.r, ['body', 'body', 'body']) } });
  holder.r = r;
  for (const [i, role] of ['intro', 'intro', 'body'].entries()) await r.repo.writePipelineFields(r.nodes[i].path, { bookRole: role });
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).autoRoles, undefined, 'no pipeline-written role: the key stays absent');
  assert.equal((await r.note(0)).bookRole, 'intro');
  await r.runs.stop(r.mapPath, { saved: true });
  await r.runs.resume(r.mapPath); await settle();
  assert.deepEqual(await Promise.all([0, 1, 2].map(async i => (await r.note(i)).bookRole)), ['intro', 'intro', 'body']);
});

test('the budget running out pauses without marking a card; addBudget resumes and finishes; another map is not touched', async () => {
  const r = await rig();
  const other = await rig();
  await r.runs.start(r.mapPath);
  await setLimit(r, 6); // 4 used by planning: two more calls
  await confirmDone(r.runs, r.mapPath);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget'); assert.equal(s.phase, 'writing');
  assert.equal(r.runs.getProgress(r.mapPath).pauseReason, 'budget');
  for (let i = 0; i < 3; i++) assert.notEqual(stageOf(r.raw(i)), 'needs-review');
  assert.ok(Object.values(s.attempts).every(a => typeof a === 'number' || (a.write <= 1 && a.plan <= 1)));
  // the other map (its own budget gate) and a call without a gate are unaffected
  await other.runs.start(other.mapPath); await confirmDone(other.runs, other.mapPath);
  assert.equal((await other.state()).phase, 'gate2');
  assert.equal((await other.state()).budget.used, 10);
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e instanceof BookPipelineRunError && e.code === 'budget');
  await r.runs.resume(r.mapPath, { addBudget: 100 });
  s = await r.state();
  assert.equal(s.phase, 'gate2'); assert.equal(s.status, 'running');
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'checked');
});

test('stop, then resume: finished steps are not redone, and a late result of the old drive is dropped', async () => {
  const hold = defer();
  let first = true;
  const r = await rig({ script: { author: async (input, n) => {
    if (input.nodeId === r.nodes[1].id && first) { first = false; await hold.promise; const out = await r.repo.updateNoteGuarded(input.path, { detail: 'LATE' }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; }
    await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' };
  } } });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(stageOf(r.raw(0)), 'checked'); // cards 0 and 2 finished while card 1 hangs
  await r.runs.stop(r.mapPath); await running;
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, undefined);
  const authored = [...r.stat.author];
  const proofs = r.stat.proof.length;
  await r.runs.resume(r.mapPath);
  hold.resolve(); await settle();
  assert.equal((await r.note(1)).detail.includes('LATE'), false, 'the old drive wrote nothing');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal(r.stat.author.filter(id => id === r.nodes[0].id).length, 1);
  assert.equal(r.stat.author.filter(id => id === r.nodes[1].id).length, 2);
  assert.equal(authored.length, 3);
  assert.equal(r.stat.proof.length, 3);
  assert.ok(r.stat.proof.length >= proofs);
  s = await r.state();
  assert.equal(s.phase, 'gate2');
});

test('dispose: nothing is written afterwards, not even the map file; a new session resumes the interrupted run', async () => {
  const hold = defer();
  const r = await rig({ script: { author: async (input, n) => {
    if (input.nodeId === r.nodes[2].id && n === 1) { await hold.promise; await r.repo.updateNoteGuarded(input.path, { detail: 'AFTER DISPOSE' }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; }
    await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' };
  } } });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  r.runs.dispose();
  const mapBefore = r.mapRaw(); const cardsBefore = [0, 1, 2].map(i => r.raw(i));
  hold.resolve(); await running.catch(() => undefined); await settle();
  assert.equal(r.mapRaw(), mapBefore);
  assert.deepEqual([0, 1, 2].map(i => r.raw(i)), cardsBefore);
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e.code === 'disposed');
  assert.equal((await r.state()).status, 'running', 'the file still says running: an interrupted run');
  // the map file closes and reopens: a new session continues from the cards' stages
  const again = new BookPipelineRuns(r.ports);
  const before = r.stat.author.length;
  await again.resume(r.mapPath);
  assert.equal((await r.state()).phase, 'gate2');
  assert.equal(r.stat.author.slice(before).filter(id => id === r.nodes[0].id).length, 0, 'a finished card is not written again');
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'checked');
});

test('while the author runs, its card frontmatter is not written; the owner editing after the last read is kept and the result discarded', async () => {
  const seen = [];
  const r = await rig({ script: { author: async (input, n) => {
    const key = () => `${stageOf(r.contents.get(input.path))}`;
    const start = key();
    await tick(); await tick();
    seen.push([start, key()]);
    await input.admission.reserve(); const note = await r.repo.readNote(input.path);
    await r.repo.updateNoteGuarded(input.path, { detail: `${bodyOf(note.title)}\n\n![](https://img.example/a.png)` }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  }, probe: async (url, signal, n) => {
    if (n === 1) await r.repo.updateNote(r.nodes[0].path, { summary: 'owner summary' }); // the owner edits after the runner's last read
    return n === 1 ? { ok: false, reason: 'gone' } : { ok: true };
  } } });
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  assert.ok(seen.length >= 3 && seen.every(([a, b]) => a === b && a === 'planned'));
  assert.equal((await r.note(0)).summary, 'owner summary', 'the owner text survived');
  assert.ok(r.stat.author.filter(id => id === r.nodes[0].id).length >= 2, 'the discarded step was tried again');
  assert.equal((await r.state()).phase, 'gate2');
});

test('pictures: a non-https address is not probed; an https failure becomes "無圖：原因"; a good https picture stays', async () => {
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve(); const note = await r.repo.readNote(input.path);
    const text = `${bodyOf(note.title)}\n\n![a](http://plain.example/a.png)\n\n![b](javascript:alert(1))\n\n![c](https://dead.example/c.png)\n\n![d](https://ok.example/d.png)`;
    await r.repo.updateNoteGuarded(input.path, { detail: text }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  }, probe: async url => (url.includes('dead') ? { ok: false, reason: '404' } : { ok: true }) } });
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  assert.ok(r.stat.probes.every(u => u.startsWith('https://')), 'only https is probed');
  assert.ok(!r.stat.probes.some(u => u.includes('plain') || u.startsWith('javascript')));
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes('無圖：404') && detail.includes('無圖：網址不安全'));
  assert.ok(!detail.includes('http://plain') && !detail.includes('javascript:') && !detail.includes('dead.example'));
  assert.ok(detail.includes('![d](https://ok.example/d.png)'));
});

test('write: an author result whose Detail has only sources and notes (no chapter text) is refused, the card keeps its body and says no_body in a write failure', async () => {
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve();
    await r.repo.updateNoteGuarded(input.path, { detail: '### 來源\n\n- [S](https://s.example/a)\n\n### 研究備註\n\n> [!note]- 研究備註\n> x' }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  } } });
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  const note = await r.note(1);
  assert.ok(!note.detail.includes('s.example'), 'the body-less result is not written');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal(note.pipelineIssue, 'write failed: no_body');
});

test('pictures: when the exit check finds an unsafe body nothing is written, the card needs review with a neutral code and the log has no body', async () => {
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve(); const note = await r.repo.readNote(input.path);
    await r.repo.updateNoteGuarded(input.path, { detail: `${bodyOf(note.title)}\n\n![d](https://ok.example/d.png)\n\n![e](http://e.example/e.png)` }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  } } });
  r.runs.exitCheck = () => true;
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  assert.ok(!(await r.note(1)).detail.includes('無圖'), 'the cleaned result is not written');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: unsafe_body');
  const log = r.stat.logs.join('\n');
  assert.ok(log.includes('unsafe_body') && !/Secret|ok\.example|e\.example/.test(log));
});

/** The saved card text must hold only https standard pictures and no HTML tag, whatever way the step ended. */
const MALICIOUS = bodyText => `${bodyText}\n\n![](http://evil.example/x.png)\n\n<img src="http://evil.example/i.png">\n\n<svg><image href="http://evil.example/s.svg"/></svg>\n\n<style>@import url(http://evil.example/c.css)</style>\n\n![ok](https://ok.example/d.png)`;
const assertSafeCard = (r, i) => {
  // the program's own hidden fingerprint record (a comment line) is not author text
  const detail = r.raw(i).replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^> <!-- book-body:v1 \{[^<]*\} -->\n/m, '');
  assert.ok(!unsafeBody(detail, new Set(['https://ok.example/d.png'])), 'only https standard pictures and no HTML tag');
  assert.ok(!/<img|<svg|<style|!\[[^\]]*\]\(http:/.test(r.raw(i)), 'no tag and no http picture left');
};
const evilAuthor = async (r, input) => {
  await input.admission.reserve(); const note = await r.repo.readNote(input.path);
  await r.repo.updateNoteGuarded(input.path, { detail: MALICIOUS(bodyOf(note.title)) }, { authorize: input.authorize, finalize: input.finalize });
  return { outcome: 'written' };
};

test('exit safety: the author write itself is cleaned, so stop during the probe leaves only https standard pictures', async () => {
  const hold = defer();
  const r = await rig({ script: { author: input => evilAuthor(r, input), probe: async (url, signal) => { await hold.promise; return { ok: true }; } } });
  await r.runs.start(r.mapPath);
  const confirm = r.runs.confirmGate1(r.mapPath);
  await settle();
  assertSafeCard(r, 1); // already cleaned before any probe finished
  await r.runs.stop(r.mapPath); hold.resolve(); await confirm.catch(() => undefined);
  assertSafeCard(r, 1);
});

test('exit safety: the probe-result write being discarded leaves the cleaned text', async () => {
  let armed = false;
  const r = await rig({ script: { author: async input => { const out = await evilAuthor(r, input); armed = true; return out; }, probe: async () => ({ ok: false, reason: 'load_failed' }) },
    ports: { updateNoteRawGuarded: async (path, transform, options) => (armed ? 'discarded' : r.repo.updateNoteRawGuarded(path, transform, options)) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assertSafeCard(r, 1);
});

test('exit safety: the card leaving the map, or readCard throwing, after the author write leaves the cleaned text', async () => {
  let removeAfter = false;
  const a = await rig({ script: { author: async input => { const out = await evilAuthor(a, input); await a.repo.updateMap(a.mapPath, d => { d.nodes = d.nodes.filter(n => n.path !== input.path); }); return out; } } });
  await a.runs.start(a.mapPath); await confirmDone(a.runs, a.mapPath);
  assertSafeCard(a, 1);
  let reads = 0, armed = false;
  const b = await rig({ script: { author: async input => { const out = await evilAuthor(b, input); armed = true; return out; } },
    ports: { readCard: async path => { if (armed) throw new Error('read boom'); return b.__readCard(path); } } });
  b.__readCard = path => b.repo.readNote(path).then(note => ({ path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: b.contents.get(path), settings: note.bookSettings ?? {}, fields: {} }));
  await b.runs.start(b.mapPath); await confirmDone(b.runs, b.mapPath);
  assertSafeCard(b, 1);
});

test('exit safety: a body the exit check refuses is not written at all (the card keeps its earlier text) and needs review', async () => {
  const r = await rig({ script: { author: input => evilAuthor(r, input) } });
  r.runs.exitCheck = () => true;
  // T1: the only addition is the proof-result section saying the step failed (no model); the card text itself is unchanged.
  const FAIL_SECTION = '\n> [!vam-book]- 校對結果（最新一次）\n> - 失敗：unsafe\\_body\n';
  const before = () => r.raw(1).replace(/^---\n[\s\S]*?\n---\n/, '');
  await r.runs.start(r.mapPath);
  const earlier = before();
  await confirmDone(r.runs, r.mapPath);
  assert.equal(before().includes('evil.example'), false);
  assert.ok(before().endsWith(FAIL_SECTION)); assert.equal(before().slice(0, -FAIL_SECTION.length), earlier);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: unsafe_body');
});

test('probe failure reasons are words in the output language (zh: 無法載入 / 空圖 / 逾時 / 已中止; en: English)', async () => {
  for (const [language, expected] of [['zh-TW', ['無圖：無法載入', '無圖：空圖', '無圖：逾時', '無圖：已中止']], ['en', ['No picture: could not load', 'No picture: empty image', 'No picture: timed out', 'No picture: aborted']]]) {
    const reasons = ['load_failed', 'empty', 'timeout', 'aborted'];
    const r = await rig({ titles: ['SecretRootTitle', 'Chapter'], script: { author: async input => {
      await input.admission.reserve();
      await r.repo.updateNoteGuarded(input.path, { detail: reasons.map((_, i) => `![p${i}](https://x.example/${i}.png)`).join('\n\n') }, { authorize: input.authorize, finalize: input.finalize });
      return { outcome: 'written' };
    }, probe: async url => ({ ok: false, reason: reasons[Number(/(\d)\.png/.exec(url)[1])] }) }, ports: { config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language }) } });
    await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
    const detail = (await r.note(0)).detail;
    for (const text of expected) assert.ok(detail.includes(text), `${language}: ${text}`);
  }
});

test('stop with no drive and `saved` writes the stop (budget pause and a saved "running" become stopped); without `saved` or a run it writes nothing', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.status = 'stopped'; d.bookPipeline.pauseReason = 'budget'; });
  await r.runs.stop(r.mapPath);
  assert.equal((await r.state()).pauseReason, 'budget', 'a plain stop with no drive changes nothing');
  await r.runs.stop(r.mapPath, { saved: true });
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, undefined);
  assert.equal(r.runs.isRunning(r.mapPath), false);
  const none = await rig();
  await none.runs.stop(none.mapPath, { saved: true }); // no bookPipeline: refused quietly
});

test('picture allow-list: every form that could load a remote resource is rewritten, whatever its shape', () => {
  const none = new Map();
  // scanner: after neutralizing there is no "<tag", and every "![...](url)" is an https address that was probed (here: all in `probed`)
  const probed = new Set(['https://ok.example/a.png', 'https://ok.example/b.png', 'https://ok.example/a_(1).png', 'https://evil.example/p.png']);
  const nonCode = out => out;
  const loads = out => {
    const text = nonCode(out.replace(/^---\n[\s\S]*?\n---\n/, ''));
    if (/<\/?[a-z!?]/i.test(text) || /!\[\[\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(text)) return true;
    for (const m of text.matchAll(/!\[[^\]\n]*\]\(([^)\n]*(?:\([^)\n]*\))?[^)\n]*)\)/g)) if (!probed.has(m[1])) return true;
    return /!\[(?!\[)[^\]\n]*\](?!\()/.test(text) || /^ {0,3}\[[^\]\n]+\]:\s*\S/m.test(text);
  };
  const cases = {
    'inline http': '![x](http://e.example/a.png)',
    'inline angle brackets': '![x](<http://e.example/a b.png>)',
    'inline angle brackets https with a space': '![x](<https://ok.example/a b.png>)',
    'inline angle containing > and <': '![x](<https://ok.example/a>b<c>)',
    'inline nested parens http': '![x](http://e.example/a_(1).png)',
    'inline backslash': '![x](https://ok.example/a\\).png)',
    'inline javascript': '![x](javascript:alert(1))',
    'inline data': '![x](data:image/svg+xml;base64,AAAA)',
    'inline file': '![x](file:///etc/passwd)',
    'inline title carrying img onerror': '![x](https://ok.example/a.png "<img src=x onerror=alert(1)>")',
    'inline title with an angle address': '![x](<http://e.example/a.png> \'<img src=//e.example/x>\')',
    'alt holding html': '![<img src=//e.example/x>](http://e.example/a.png)',
    'alt with a bracket (not understood)': '![a [b]](https://ok.example/a.png)',
    'reference': '![x][r]\n\n[r]: http://e.example/a.png',
    'reference angle': '![x][r]\n\n[r]: <http://e.example/a.png> "t"',
    'reference collapsed': '![r][]\n\n[r]: http://e.example/a.png',
    'reference shortcut': '![r]\n\n[r]: javascript:alert(1)',
    'reference with several candidate definitions': '![x][r]\n\n[r]: http://e.example/1.png\n[r]: https://ok.example/a.png\n\n[R]: http://e.example/2.png',
    'reference definition inside a fence is not a definition': '```\n[r]: http://e.example/in-fence.png\n```\n\n![x][r]\n\n[r]: http://e.example/real.png',
    'reference definition then a paragraph continuation': '![x][r]\n\n[r]: http://e.example/a.png\ncontinued paragraph <img src=//e.example/x>',
    'reference to a missing definition': '![x][missing]',
    'html img': '<img src="https://ok.example/a.png">',
    'html img split over lines': '<img\n  src="https://ok.example/a.png"\n>',
    'html IMG upper case': '<IMG SRC=https://ok.example/a.png>',
    'html entity-encoded attribute': '<img &#x73;rc="https://ok.example/a.png">',
    'html picture': '<picture><source srcset="https://ok.example/a.webp"><img src="https://ok.example/a.png"></picture>',
    'html iframe': '<iframe src="https://ok.example/"></iframe>',
    'html svg': '<svg><image href="https://ok.example/a.png"/></svg>',
    'html video': '<video src="https://ok.example/a.mp4" poster="https://ok.example/p.png"></video>',
    'html audio': '<audio src="https://ok.example/a.mp3"></audio>',
    'html object': '<object data="https://ok.example/a.swf"></object>',
    'html embed': '<embed src="https://ok.example/a.swf">',
    'html style element': '<style>@import url(https://ok.example/a.css);</style>',
    'html style attribute url()': '<p style="background:url(https://ok.example/a.png)">text</p>',
    'html comment': '<!-- <img src="https://ok.example/a.png"> -->',
    'obsidian embed https': '![[https://ok.example/a.png]]',
    'obsidian embed http': '![[http://e.example/a.png]]',
    'obsidian embed data': '![[data:image/png;base64,AAAA]]',
    'obsidian embed javascript': '![[javascript:alert(1)]]'
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.ok(/!\[|</.test(input), `${name}: the sample is a picture form`);
    const out = replaceBodyImages(`---\ntitle: t\n---\n${input}\n`, none);
    assert.ok(!loads(out), `${name}: ${JSON.stringify(out)}`);
    assert.ok(out.startsWith('---\ntitle: t\n---\n'), `${name}: frontmatter kept`);
  }
  for (const name of ['inline http', 'inline javascript', 'inline data', 'inline file', 'obsidian embed https', 'reference shortcut', 'reference to a missing definition']) {
    assert.ok(replaceBodyImages(cases[name], none).includes('無圖：'), `${name}: says why`);
  }
  assert.ok(replaceBodyImages(cases['html img'], none).includes('&lt;img'));
  assert.equal(replaceBodyImages(cases['inline title carrying img onerror'], none), '![x](https://ok.example/a.png)');
  assert.equal(replaceBodyImages('<!-- visual-agent-map:detail:start -->\nbody\n<!-- visual-agent-map:detail:end -->', none), '<!-- visual-agent-map:detail:start -->\nbody\n<!-- visual-agent-map:detail:end -->');
  assert.ok(!replaceBodyImages(cases['inline angle containing > and <'], none).includes('b<c'));
  // an https address is rebuilt in the standard form: the title is dropped, the alt is escaped, the original text is not kept
  assert.equal(replaceBodyImages('![x](<https://ok.example/a.png> "a title")', none), '![x](https://ok.example/a.png)');
  assert.equal(replaceBodyImages('![a<b>c](https://ok.example/a.png)', none), '![a＜b＞c](https://ok.example/a.png)');
  // all the definitions a reference image used are removed (also with several candidates); a probed reference image becomes the inline form
  assert.equal(replaceBodyImages('![x][r]\n\n[r]: https://ok.example/a.png\n[R]: http://e.example/2.png\n\ntext', none), '![x](https://ok.example/a.png)\n\n\ntext');
  assert.equal(replaceBodyImages('![x][]\n![x]\n\n[x]: https://ok.example/a.png', none), '![x](https://ok.example/a.png)\n![x](https://ok.example/a.png)\n\n');
  // code is not exempt: an image or tag in a fence or in inline code is rewritten like any other
  const code = '```\n![x](http://e.example/a.png)\n<img src=x>\n```\n\n~~~\n![y](http://e.example/b.png)\n~~~\n\n`![z](http://e.example/c.png)` and `<img src=x>`';
  const codeOut = replaceBodyImages(code, none);
  assert.ok(!loads(codeOut) && codeOut.includes('&lt;img') && !codeOut.includes('http://'));
  const codeForms = {
    'backslash-escaped backtick': '\\`\n![x](http://e.example/a.png)\n<img src=//e.example/x>\n\\`',
    'fence inside a container': '> ```\n> ![x](http://e.example/a.png)\n> <img src=//e.example/x>\n> ```',
    'indented fence': '    ```\n    ![x](http://e.example/a.png)\n    <img src=//e.example/x>\n    ```',
    'list item fence': '- item\n\n      ```\n      ![x](http://e.example/a.png) <img src=//e.example/x>',
    'unclosed fence': '```\n![x](http://e.example/a.png)\n<img src=//e.example/x>',
    'inline code': '`![x](http://e.example/a.png)` `<img src=//e.example/x>`',
    'nested wikilink': '![[x![y](https://evil.example/p.png)]]',
    'wikilink https': '![[https://evil.example/p.png]]',
    'wikilink paren': '![[a)b]] ![[a(b]]',
    'wikilink newline': '![[a\nb]]![x](http://e.example/a.png)',
    'wikilink angle': '![[a<img src=//e.example/x>]]',
    'wikilink then image': '![[a\\]] ![x](http://e.example/a.png)',
    'wikilink bang': '![[a!b]]',
    'angle right before an image': '<![x](http://e.example/a.png) <![[a]]'
  };
  for (const [name, input] of Object.entries(codeForms)) {
    const out = replaceBodyImages(input, none);
    assert.ok(!loads(out), `${name}: ${JSON.stringify(out)}`);
    assert.ok(!unsafeBody(out, probed), `${name}: the exit check agrees`);
    assert.ok(unsafeBody(input, probed), `${name}: the exit check sees the original as unsafe`);
  }
  assert.equal(replaceBodyImages('![[x![y](https://ok.example/a.png)]]', none), '無圖：形式不支援[[x![y](https://ok.example/a.png)]]');
  assert.equal(replaceBodyImages('![[a b#c|d.png]]', none), '![[a b#c|d.png]]');
  // exit check: a tag, an unprobed address, a scheme embed, any other `![` form
  const ok = new Set(['https://ok.example/a.png', 'https://ok.example/a_(1).png']);
  assert.equal(unsafeBody('![x](https://ok.example/a.png) ![y](https://ok.example/a_(1).png) ![[l.png]]\n<!-- visual-agent-map:detail:start -->', ok), false);
  assert.equal(unsafeBody('![a\\[b\\]](https://ok.example/a.png)', ok), false);
  assert.equal(unsafeBody('<img src=x>', ok), true);
  assert.equal(unsafeBody('<!-- visual-agent-map:detail:start --><b>', ok), true);
  assert.equal(unsafeBody('![x](https://ok.example/other.png)', ok), true);
  assert.equal(unsafeBody('![x][r]', ok), true);
  assert.equal(unsafeBody('![[https://e.example/a.png]]', ok), true);
  assert.equal(unsafeBody('---\nimg: "<img>"\n---\nbody', ok), false);
  const fenced = replaceBodyImages(cases['reference definition inside a fence is not a definition'], none);
  assert.ok(!loads(fenced));
  // an unpaired backtick does not hide a picture in another paragraph
  assert.ok(!loads(replaceBodyImages('a ` b\n\n![x](http://e.example/a.png)\n\nc ` d', none)));
  // what stays: a good https image (inline, reference), a local embed, a callout, plain text; frontmatter is never changed
  const good = '![x](https://ok.example/a.png)\n\n![[local.png]]\n\n> [!note] title\n> text\n\nplain text';
  assert.equal(replaceBodyImages(good, none), good);
  assert.deepEqual([...bodyImageUrls('![x](https://ok.example/a.png)\n\n![y][r]\n\n[r]: https://ok.example/b.png\n\n![z](http://e.example/c.png)')].sort(), ['https://ok.example/a.png', 'https://ok.example/b.png']);
  const failed = new Map([['https://ok.example/b.png', '無圖：404']]);
  const out = replaceBodyImages('![x](https://ok.example/a.png)\n\n![y][r]\n\n[r]: https://ok.example/b.png', failed);
  assert.ok(out.includes('無圖：404') && !out.includes('b.png') && out.includes('![x](https://ok.example/a.png)'));
  assert.equal(replaceBodyImages('---\nimg: "![](http://e.example/a.png)"\n---\nbody', none), '---\nimg: "![](http://e.example/a.png)"\n---\nbody');
  // idempotent
  const once = replaceBodyImages(Object.values(cases).join('\n\n'), none);
  assert.equal(replaceBodyImages(once, none), once);
});

test('log lines carry ids, counts and codes only: no title and no body text', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const log = r.stat.logs.join('\n');
  assert.ok(r.stat.logs.length > 5 && log.includes('run=run-1'));
  assert.ok(!/Secret/.test(log) && !log.includes('summary of') && !log.includes('one thread'));
});

test('a proof already stored under the same key is reused: no second AI call', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal(r.stat.proof.length, 3);
  // send card 1 back to "written" and the run back to the writing phase; its revision and text are unchanged, so the key is the same
  await r.repo.writePipelineFields(r.nodes[1].path, { pipelineStage: 'written' });
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; d.bookPipeline.attempts[r.nodes[1].id].proof = 0; });
  await r.runs.resume(r.mapPath);
  assert.equal(r.stat.proof.length, 3, 'the stored result was used');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal((await r.state()).phase, 'gate2');
});

test('the proof record callout survives the real repository: the key and the body hash are stable after a reopen and another write', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const s = await r.state();
  const keyOf = async () => {
    const note = await r.note(1);
    const checklist = parseChecklist(note.prompt);
    const body = withoutResearchNotes(note.detail);
    return { key: proofKey({ runId: s.runId, nodeId: r.nodes[1].id, revision: cardRevision(s, r.nodes[1].id), body, checklist }), detail: note.detail, body };
  };
  const first = await keyOf();
  assert.equal(first.body, bodyOf(TITLES[1]), 'the proof record is not part of the body');
  assert.ok(findStoredProof(first.detail, first.key), 'the record is found again after the write');
  assert.match(r.raw(1), />\s?\[!vam-book\]-/);
  // another real write through the repository (the owner changes the summary), then the file is read again
  await r.repo.updateNote(r.nodes[1].path, { summary: 'changed' });
  const second = await keyOf();
  assert.equal(second.key, first.key);
  assert.equal(second.body, first.body);
  assert.ok(findStoredProof(second.detail, second.key));
  // appending a second record keeps the first
  const reopened = new BookPipelineRuns(r.ports);
  assert.equal(reopened.isRunning(r.mapPath), false);
  assert.equal((r.raw(1).match(/book-proof:v1/g) ?? []).length, 1);
});

test('start is refused while a conversation holds the map, and a busy map refuses a second drive', async () => {
  const r = await rig({ ports: { blocked: () => true } });
  await assert.rejects(() => r.runs.start(r.mapPath), e => e.code === 'blocked');
  assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.equal(readBookPipeline(await r.repo.readMap(r.mapPath)).kind, 'absent');
  const hold = defer();
  const q = await rig({ script: { global: async () => { await hold.promise; throw new Error('x'); } } });
  const running = q.runs.start(q.mapPath);
  await settle();
  await assert.rejects(() => q.runs.resume(q.mapPath), e => e.code === 'busy');
  await q.runs.stop(q.mapPath); hold.resolve(); await running;
});

test('a proof that opened pages but verified no fact keeps the judged structure items in the research notes and still needs a person (not a failure)', async () => {
  const facts = [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'fact', text: 'a date' }];
  const r = await rig({ script: {
    card: request => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: facts }),
    proof: async request => evaluateProof(request.checklist.map(c => ({ id: c.id, status: 'met', note: 'judged ' + c.id, sources: [] })), request.checklist, ['https://example.org/p']) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const raw = r.raw(1);
  assert.equal(stageOf(raw), 'needs-review');
  assert.equal(r.stat.proof.length, r.nodes.length * 2, 'no proofread retry for unverified facts; the one automatic redo adds one proofread per card (T4)');
  assert.equal((await r.note(1)).pipelineIssue, 'proof unmet: facts_unverified');
  assert.ok(!/校對失敗/.test(raw));
  assert.match(raw, /C1 達成：judged C1/);
  assert.equal((raw.match(/book-proof:v1/g) ?? []).length, 1, 'the result is recorded once');
});

test('a whole-book plan that fails three times stops the run with a neutral code the map file keeps; retry (resume) runs it again from zero attempts', async () => {
  let broken = true;
  const r = await rig({ script: { global: (request, n) => { if (broken) throw new Error('nope SecretBody'); return { thread: 'one thread', cards: [], materials: [], decisions: {} }; } } });
  const original = r.script.global;
  r.script.global = (request, n) => broken ? original(request, n) : { thread: 'one thread', cards: r.nodes.map((n2, i) => ({ id: n2.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: {} };
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'failed'); assert.equal(s.failureCode, 'failed'); assert.equal(s.attempts.global, 3);
  assert.equal(r.runs.getProgress(r.mapPath).failureCode, 'failed');
  assert.ok(r.stat.logs.some(l => /step=plan attempt=\d result=failed:failed/.test(l)));
  broken = false;
  await r.runs.resume(r.mapPath);
  s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.pauseReason, undefined); assert.equal(s.failureCode, undefined); assert.equal(s.attempts.global, 1);
});

test('first-start failures each leave a code: backup failed, root card unreadable, an unexpected error in the map write', async () => {
  // the backup port fails (the global plan writes the root card first)
  let r = await rig({ ports: { backupNote: async () => ({ ok: false }) } });
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.failureCode, 'backup_failed'); assert.equal(s.attempts.global, 3);
  assert.equal(r.stat.plan.length, 3, 'the plan is asked each attempt (the backup comes after the call)');
  // the backup port throws
  r = await rig({ ports: { backupNote: async () => { throw new Error('boom'); } } });
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).failureCode, 'backup_failed');
  // readCard of the root fails on the first read after start
  let reads = 0;
  r = await rig();
  const inner = r.ports.readCard;
  r.ports.readCard = async path => { if (path === r.nodes[0].path && ++reads > 1) throw new Error('gone'); return inner(path); };
  await r.runs.start(r.mapPath);
  s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'failed'); assert.ok(/^[A-Za-z0-9_.:-]+$/.test(s.failureCode));
  // an unexpected error while the run state is saved: stopped with an internal code naming the class only
  r = await rig();
  let updates = 0;
  const upd = r.ports.updateMap;
  r.ports.updateMap = async (path, change) => { if (++updates === 2) throw new TypeError('secret path /Users/x SecretTitleA'); return upd(path, change); };
  await r.runs.start(r.mapPath).catch(() => undefined);
  s = await r.state().catch(() => undefined);
  assert.ok(r.stat.logs.every(l => !/Secret|Users/.test(l)), 'no message text in the log');
  assert.deepEqual([s.status, s.pauseReason, s.failureCode], ['stopped', 'failed', 'internal_TypeError']);
  assert.ok(r.stat.logs.some(l => /^book-pipeline error .* result=internal_TypeError/.test(l)));
});

test('a proofread call logs openedPages and searches as numbers only; the log carries no title or body', async () => {
  const r = await rig({ script: { proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked', counts: { openedPages: 2, searches: 3 } }) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const lines = r.stat.logs.filter(l => l.includes('proof_calls'));
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /^book-pipeline proof_calls run=run-1 card=\S+ step=proof attempt=1 result=ok ms=0 openedPages=2 searches=3$/);
  assert.ok(!/Secret/.test(r.stat.logs.join('\n')));
  assert.match(r.raw(1), /開頁 2 次、搜尋 3 次/);
});

test('a proofread call with source diagnostics logs sourcesCited, sourcesMatched, eventUrls and the unmatched hosts only', async () => {
  const sources = { sourcesCited: 3, sourcesMatched: 1, eventUrls: 2, unmatchedHosts: ['a.example', 'b.example'] };
  const r = await rig({ script: { proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked', counts: { openedPages: 2, searches: 3, sources } }) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const lines = r.stat.logs.filter(l => l.includes('proof_calls'));
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /openedPages=2 searches=3 sourcesCited=3 sourcesMatched=1 eventUrls=2 unmatchedHosts=a\.example,b\.example$/);
  assert.match(r.raw(1), /開頁 2 次、搜尋 3 次/);
  assert.ok(!/sourcesCited/.test(r.raw(1)), 'the diagnostics are not stored in the note');
});

// Real wiring: main.mutate() reads every view back after each write, and the view's repaint asks getProgress while the first start is
// still inside its own mutate (the drive exists, its store does not yet). That read used to throw "reading 'state'" of undefined.
test('first start on a map with no bookPipeline: a repaint (getProgress) during the start write does not break the run', async () => {
  let runs;
  let mapPath;
  let queue = Promise.resolve();
  const seen = [];
  const r = await rig({ ports: { mutate: work => { const next = queue.then(async () => { await work(); seen.push(runs.getProgress(mapPath)); }); queue = next.catch(() => undefined); return next; } } });
  runs = r.runs; mapPath = r.mapPath;
  assert.equal(readBookPipeline(await r.repo.readMap(r.mapPath)).kind, 'absent');
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.failureCode, undefined);
  assert.equal(r.stat.plan[0], 'global');
  assert.ok(!r.stat.logs.some(line => /internal_/.test(line)));
  assert.ok(seen.length > 0);
});

test('an unexpected error before the store exists still saves its code (stopped, failureCode) so the bar can show a reason and retry', async () => {
  let queue = Promise.resolve();
  let first = true;
  const r = await rig({ ports: { mutate: work => { const next = queue.then(async () => { await work(); if (first) { first = false; throw new TypeError('late repaint failed'); } }); queue = next.catch(() => undefined); return next; } } });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'failed'); assert.equal(s.failureCode, 'internal_TypeError');
  assert.equal(r.runs.getProgress(r.mapPath).failureCode, 'internal_TypeError');
  assert.equal(r.stat.plan.length, 0, 'no call was made');
});

test('a written chapter whose Prompt has no image plan gets no "no picture" line and no search (body untouched); the log has no pictures event', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  for (let i = 0; i < 3; i++) {
    const detail = (await r.note(i)).detail;
    assert.ok(!/無圖：/.test(detail), `card ${i}: no picture line`);
    assert.equal(withoutResearchNotes(detail).replace(/\s+$/, ''), bodyOf(TITLES[i]) + '', 'the body text is as the author wrote it');
  }
  assert.ok(!r.stat.logs.some(line => /book-pipeline (pictures|slots) /.test(line)));
  assert.ok(!r.stat.logs.some(line => /SecretBody|SecretTitle/.test(line)));
});

test('a chapter whose body already carries a picture is not given the no-picture line', async () => {
  const body = title => `SecretBody ${title}\n\n![x](https://upload.wikimedia.org/a.jpg)`;
  const r = await rig();
  r.script.author = async input => { await input.admission.reserve(); const note = await r.repo.readNote(input.path); const w = await r.repo.updateNoteGuarded(input.path, { detail: body(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return w === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  for (let i = 0; i < 3; i++) assert.ok(!(await r.note(i)).detail.includes('無圖：'));
});

test('every accepted card plan logs one checklist_dropped line with counts only (zero included)', async () => {
  const r = await rig({ script: { card: request => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], ...(request.card.position === 2 ? { droppedSubjective: 2, droppedPicture: 1 } : {}) }) } });
  await r.runs.start(r.mapPath);
  const lines = r.stat.logs.filter(line => /book-pipeline checklist_dropped /.test(line));
  assert.equal(lines.length, 3);
  assert.equal(lines.filter(line => / subjective=0 picture=0 kept=1$/.test(line)).length, 2);
  assert.equal(lines.filter(line => / subjective=2 picture=1 kept=1$/.test(line)).length, 1);
});

// Gate 1 confirm answers once writing has begun; the drive goes on in the background (the chat is not left busy for the whole writing).
test('confirmGate1 resolves when the phase is writing while the drive still runs; a second press (panel or chat) is refused and starts no second drive', async () => {
  const hold = defer();
  const r = await rig({ script: { author: async () => { await hold.promise; return { ok: false, reason: 'cancelled' }; } } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  assert.equal((await r.state()).phase, 'writing');
  assert.equal(r.runs.isRunning(r.mapPath), true);
  await settle();
  const authors = r.stat.author.length;
  await assert.rejects(() => r.runs.confirmGate1(r.mapPath), e => e instanceof BookPipelineRunError && e.code === 'busy');
  await assert.rejects(() => r.runs.confirmGate1(r.mapPath), e => e instanceof BookPipelineRunError && e.code === 'busy');
  assert.equal(r.stat.author.length, authors, 'no second drive started');
  await r.runs.stop(r.mapPath); hold.resolve();
});

test('a drive failing in the background after confirm: no unhandled rejection, the failure code is written', async () => {
  const unhandled = []; const on = e => unhandled.push(e); process.on('unhandledRejection', on);
  try {
    const r = await rig();
    await r.runs.start(r.mapPath);
    let confirmed = false;
    const upd = r.ports.updateMap;
    r.ports.updateMap = async (path, change) => { if (confirmed) { confirmed = false; throw new TypeError('boom'); } return upd(path, change); };
    const logged = r.ports.log; r.ports.log = line => { if (/gate1/.test(line)) confirmed = true; return logged(line); };
    await r.runs.confirmGate1(r.mapPath);
    while (r.runs.isRunning(r.mapPath)) await tick();
    await settle();
    const s = await r.state();
    assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'failed'); assert.equal(s.failureCode, 'internal_TypeError');
    assert.equal(r.runs.getProgress(r.mapPath).failureCode, s.failureCode);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', on); }
});

test('chat "continue" confirms gate 1: the reply shows and the chat is free again while a long writing still runs', async () => {
  const { MapChatConversation } = loadReplay('experiences/visual-map/map-chat-conversation.ts', { obsidian: S.obsidian });
  const hold = defer();
  const r = await rig({ script: { author: async () => { await hold.promise; return { ok: false, reason: 'cancelled' }; } } });
  await r.runs.start(r.mapPath);
  const log = [];
  const panel = {
    isBusy: false, draft: '繼續', transcript: () => [], clearDraft: () => log.push('clearDraft'),
    begin(text) { this.isBusy = true; log.push('begin'); return { text }; }, attachments: () => [], hasTurn: () => true,
    finish(reply) { this.isBusy = false; log.push(['finish', reply]); }, pendingPlan: () => null, hasQueuedSteers: () => false
  };
  const ports = {
    panel: () => panel, closed: () => false, path: () => 'Maps/A/Map.md', map: () => ({ id: 'm1' }), notesLoading: () => false,
    selectionIds: () => [], imageId: () => null,
    chain: () => ({ current: null, resumeChatChain: () => false, interruptChain: () => log.push('interrupt'), chainForRound: () => { throw new Error('went on to the AI path'); } }),
    bookGate1Confirm: () => r.runs.confirmGate1(r.mapPath).then(() => 'confirmed')
  };
  const conv = new MapChatConversation(ports);
  await conv.sendMapChat();
  assert.deepEqual(log.at(-1), ['finish', 'confirmed']);
  assert.equal(panel.isBusy, false);
  assert.equal(r.runs.isRunning(r.mapPath), true, 'the writing is still going');
  panel.draft = 'another message';
  ports.bookGate1Confirm = () => null;
  await assert.rejects(() => conv.sendMapChat(), /went on to the AI path/);
  await r.runs.stop(r.mapPath); hold.resolve();
});

test('the config port is read on every start and resume, so a settings change applies to the next run and never to a drive in progress', async () => {
  const cfg = { planModel: 'plan-A', authorModel: 'author-A', imageModel: 'image-A', proofModel: 'proof-A', reasoning: 'low', language: 'zh-TW' };
  const seen = [];
  const hold = defer();
  const r = await rig({
    ports: { config: () => ({ ...cfg }) },
    script: { author: async input => {
      seen.push(input.model);
      if (input.nodeId === r.nodes[0].id) await hold.promise;
      await input.admission.reserve(); const note = await r.repo.readNote(input.path);
      const out = await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize });
      return out === 'written' ? { outcome: 'written' } : { outcome: 'dropped' };
    } }
  });
  await r.runs.start(r.mapPath);
  cfg.authorModel = 'author-B'; // changed after start, before the writing drive begins: that drive is a new entry and reads it
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.deepEqual([...new Set(seen)], ['author-B']);
  cfg.authorModel = 'author-C'; // changed while the drive is running: calls of this drive keep author-B
  hold.resolve(); await running;
  while (r.runs.isRunning(r.mapPath)) await tick();
  assert.deepEqual([...new Set(seen)], ['author-B']);
});

// ---- T1: card content fixes (proof-result section, latest-only records, anchors, placeholders, models) ----
const SECTION = '> [!vam-book]- 校對結果（最新一次）';
const count = (text, needle) => text.split(needle).length - 1;
const finish = async r => { await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath); };
const rerun = async (r, i) => { await r.runs.rerunCard(r.mapPath, r.nodes[i].id); while (r.runs.isRunning(r.mapPath)) await tick(); await settle(); };

test('T1 proof section: one "校對結果（最新一次）" section after the Detail block, with the author and proof model lines; frontmatter model unchanged; the log has no section text or model id', async () => {
  const r = await rig({ ports: { modelLabel: id => `Label<${id}>` } });
  await finish(r);
  for (let i = 0; i < 3; i++) {
    const raw = r.raw(i);
    assert.equal(count(raw, SECTION), 1);
    assert.ok(raw.indexOf(SECTION) > raw.indexOf('visual-agent-map:detail:end'), 'outside the Detail block');
    const section = raw.slice(raw.indexOf(SECTION));
    assert.match(section, /> - C1 達成\n> - C2 達成/);
    assert.ok(!section.includes('fine'), 'a met item shows no note');
    assert.match(section, /> - 作者模型：Label＜m2＞/); assert.match(section, /> - 校對模型：Label＜m3＞/);
    assert.match(raw, /^model: "?model-a"?$/m);
  }
  for (const line of r.stat.logs) { assert.ok(!/校對結果|Label|m2|m3|SecretBody/.test(line), line); }
});

test('T1 proof section: an unmet item shows its note; a rerun replaces the section and the record (not accumulated) and the proof never sees the section', async () => {
  const r = await rig({ script: { proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: c.id === 'C2' ? 'unmet' : 'met', note: 'needs an end', sources: [] })), aggregate: 'needs-review' }) } });
  await finish(r);
  assert.match(r.raw(0), /> - C2 未達成：needs an end/);
  await rerun(r, 0);
  const raw = r.raw(0);
  assert.equal(count(raw, SECTION), 1);
  assert.equal(count(raw, 'book-proof:v1'), 1, 'the research notes keep the latest record only');
  assert.ok(!raw.includes('（舊版）'));
  for (const request of r.stat.proof) assert.ok(!request.body.includes('校對結果') && !request.body.includes('作者模型'));
});

test('T1 models: the author model is the id actually dispatched (not the frontmatter model); a Haiku author shows Haiku and frontmatter model stays', async () => {
  const r = await rig({ ports: { config: () => ({ planModel: 'm1', authorModel: 'claude-haiku-4-5', imageModel: 'claude-haiku-4-5', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }) } });
  const before = /^model: .*$/m.exec(r.raw(1))[0];
  await finish(r);
  assert.match(r.raw(1), /> - 作者模型：claude-haiku-4-5/);
  assert.equal(/^model: .*$/m.exec(r.raw(1))[0], before);
  assert.ok(r.raw(1).includes(`"authorModel":"claude-haiku-4-5"`));
});

test('T1 failure: a failed proof writes "失敗：原因" in the section with no model line; the card needs review', async () => {
  const r = await rig({ script: { proof: async () => { throw new Error('nope'); } } });
  await finish(r);
  const raw = r.raw(1);
  assert.equal(count(raw, SECTION), 1);
  assert.match(raw, /校對結果（最新一次）\n> - 失敗：failed\n/);
  assert.ok(!/作者模型|校對模型/.test(raw.slice(raw.indexOf(SECTION))));
  assert.equal(stageOf(raw), 'needs-review');
});

test('T1 failure: a failed author step (write) shows its code in the section; discarded / removed reasons write no section', async () => {
  const r = await rig({ script: { author: async () => { throw new Error('boom'); } } });
  await finish(r);
  assert.match(r.raw(1), /校對結果（最新一次）\n> - 失敗：failed\n/);
  const d = await rig({ script: { author: async input => { await input.admission.reserve(); return { outcome: 'discarded' }; } } });
  await finish(d);
  assert.equal(count(d.raw(1), SECTION), 0);
});

test('T1 dedupe (R1-5): a stored result under the same key refreshes the section; its stored model is shown, an old record with none shows 未記錄, never today\'s config', async () => {
  const r = await rig();
  await finish(r);
  const s = await r.state();
  const note = await r.note(1);
  const key = proofKey({ runId: s.runId, nodeId: r.nodes[1].id, revision: cardRevision(s, r.nodes[1].id), body: withoutResearchNotes(note.detail), checklist: parseChecklist(note.prompt) });
  const result = findStoredProof(note.detail, key);
  assert.ok(result);
  // an old record (no model ids) and no section at all, as a card from before T1 has it
  const old = appendResearchNote(note.detail.split('\n').slice(0, -1).join('\n').replace(/\s*> \[!.*[\s\S]*$/, ''), composeProofRecord(key, result)).text;
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: old }, {});
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, ''), {});
  assert.equal(count(r.raw(1), SECTION), 0);
  await r.repo.writePipelineFields(r.nodes[1].path, { pipelineStage: 'written' });
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; d.bookPipeline.attempts[r.nodes[1].id].proof = 0; });
  const calls = r.stat.proof.length;
  await r.runs.resume(r.mapPath);
  assert.equal(r.stat.proof.length, calls, 'the stored result was reused');
  const section = r.raw(1).slice(r.raw(1).indexOf(SECTION));
  assert.equal(count(r.raw(1), SECTION), 1);
  assert.match(section, /- 作者模型：未記錄/); assert.match(section, /- 校對模型：未記錄/);
  assert.ok(!section.includes('m2') && !section.includes('m3'));
});

test('T1 anchors: an anchor inside a fenced code block or an inline code span stays verbatim; one outside is still converted', () => {
  const a = '<a href="https://e.com/a">x</a>';
  const link = '[x](https://e.com/a)';
  assert.equal(convertSourceAnchors('```html\n' + a + '\n```\n' + a), '```html\n' + a + '\n```\n' + link, 'fenced block');
  assert.equal(convertSourceAnchors('~~~\n' + a + '\n~~~'), '~~~\n' + a + '\n~~~', 'tilde fence');
  assert.equal(convertSourceAnchors('用 `' + a + '` 與 ' + a), '用 `' + a + '` 與 ' + link, 'inline code span');
  assert.equal(convertSourceAnchors('``' + a + '`` ' + a), '``' + a + '`` ' + link, 'double-backtick span');
  assert.equal(convertSourceAnchors(a + ' `code`'), link + ' `code`', 'an anchor before a span is converted');
});

test('T1 failure section: its write is refused once the run is aborted (authorize checks the abort signal)', async () => {
  let seen;
  const r = await rig({ script: { proof: async () => { throw new Error('nope'); } } });
  const orig = r.ports.updateNoteRawGuarded;
  r.ports.updateNoteRawGuarded = (path, transform, options) => {
    if (options?.authorize && seen === undefined && transform('x') !== undefined) {
      r.runs.stop(r.mapPath).catch(() => undefined);
      seen = options.authorize();
      return Promise.resolve('discarded');
    }
    return orig(path, transform, options);
  };
  await r.runs.start(r.mapPath); await r.runs.confirmGate1(r.mapPath).catch(() => undefined); await settle();
  assert.equal(seen, false, 'the section write must not be authorized after an abort');
});

test('T1 dedupe: a stored result whose card left the map is not written to (card_removed, no backup, no section)', async () => {
  const r = await rig();
  await finish(r);
  const s = await r.state();
  const note = await r.note(1);
  const key = proofKey({ runId: s.runId, nodeId: r.nodes[1].id, revision: cardRevision(s, r.nodes[1].id), body: withoutResearchNotes(note.detail), checklist: parseChecklist(note.prompt) });
  assert.ok(findStoredProof(note.detail, key));
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, ''), {});
  assert.equal(count(r.raw(1), SECTION), 0);
  await r.repo.writePipelineFields(r.nodes[1].path, { pipelineStage: 'written' });
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; d.bookPipeline.attempts[r.nodes[1].id].proof = 0; });
  const backups = r.stat.backups.length;
  const orig = r.ports.readCard;
  r.ports.readCard = async path => {
    const card = await orig(path);
    if (path === r.nodes[1].path) await r.repo.updateMap(r.mapPath, d => { d.nodes = d.nodes.filter(n => n.path !== path); });
    return card;
  };
  await r.runs.resume(r.mapPath); await settle();
  assert.equal(count(r.raw(1), SECTION), 0, 'no section written for a card that left the map');
  assert.equal(r.stat.backups.length, backups);
});

test('T1 placeholders: no "no new information" sentence in any language survives in a written card; real sections stay', async () => {
  const { translate } = S.load('i18n.ts');
  const text = `正文。\n\n### 補充\n\n本次無新增內容。\n\n### 更多\n\n${translate('en', 'note.no_new_information')}\n\n### 保留\n\n真正的內容。\n\n### 空\n\n${translate('zh-TW', 'note.no_new_information')}\n`;
  const r = await rig({ script: { author: async input => { await input.admission.reserve(); await r.repo.updateNoteGuarded(input.path, { detail: text }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } } });
  await finish(r);
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes('### 保留') && detail.includes('真正的內容。'));
  for (const heading of ['### 補充', '### 更多', '### 空']) assert.ok(!detail.includes(heading), heading);
  for (const locale of ['en', 'zh-TW']) assert.ok(!r.raw(1).includes(translate(locale, 'note.no_new_information').replace(/[.。]$/, '')), locale);
  assert.equal(dropPlaceholderSections('正文。\n\n### 保留\n\n文字\n'), '正文。\n\n### 保留\n\n文字\n');
  assert.equal(dropPlaceholderSections('## 補\n\nNo new information.\n'), '## 補\n\nNo new information.\n', 'a ## heading is never dropped');
  const fenced = '```\n### x\n\nNo new content this time\n```\n';
  assert.equal(dropPlaceholderSections(fenced), fenced);
});

test('T1 carry-over: a rewrite keeps the card\'s latest proof record only and the old `### 圖像` section verbatim; a textbook card with old (舊版) records and no section reruns fine', async () => {
  const r = await rig();
  await finish(r);
  const images = '### 圖像\n\n![A](https://e.com/a.jpg)\nA';
  const k = ['k1', 'k2', 'k3'];
  const result = { items: [{ id: 'C1', type: 'structure', status: 'met', note: 'ok', sources: [] }], aggregate: 'checked', factsUnverified: false };
  let detail = `舊內文。\n\n${images}\n`;
  for (const key of k) detail = appendResearchNote(detail, composeProofRecord(key, result)).text;
  detail = markOldProofRecords(detail, 'k3');
  assert.ok(detail.includes('（舊版）校對'));
  await r.repo.updateNoteRawGuarded(r.nodes[0].path, c => c.replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, '\n'), {});
  await r.repo.updateNoteGuarded(r.nodes[0].path, { detail: stampDetail(detail) }, {});
  await r.repo.updateNoteGuarded(r.nodes[0].path, {}, { detailTemplate: undefined });
  await rerun(r, 0);
  const out = (await r.note(0)).detail;
  assert.ok(out.includes(images), 'the picture section is verbatim');
  assert.equal(count(out, 'book-proof:v1'), 1);
  assert.ok(!out.includes('"key":"k') && !out.includes('（舊版）'));
  assert.equal(count(r.raw(0), SECTION), 1);
});

test('T1 anchors: a strict https anchor becomes a markdown link (entity forms too); every counterexample stays plain text', () => {
  const ok = [
    ['<a href="https://example.com/x">Example</a>', '[Example](https://example.com/x)'],
    ['&lt;a href=&quot;https://example.com/?a=1&amp;b=2&quot;&gt;E&lt;/a&gt;', '[E](https://example.com/?a=1&b=2)'],
    ['見 <a href="https://example.com/p(1)">p [1]</a> 。', '見 [p \\[1\\]](https://example.com/p%281%29) 。']
  ];
  for (const [input, expected] of ok) assert.equal(convertSourceAnchors(input), expected, input);
  assert.equal(convertSourceAnchors('!<a href="https://e.com/p.png">x</a>'), '! [x](https://e.com/p.png)', 'a preceding ! never forms an image');
  assert.equal(convertSourceAnchors('\\<a href="https://e.com/p">x</a>'), '\\ [x](https://e.com/p)', 'a preceding backslash never escapes the link');
  assert.equal(bodyImageUrls(convertSourceAnchors('!<a href="https://e.com/p.png">x</a>')).length, 0);
  const plain = [
    '<a href="javascript:alert(1)">x</a>', '<a href="http://e.com/a">x</a>', '<a href="HTTP://e.com/a">x</a>', '<a href="//e.com/a">x</a>',
    '<a href="https://e.com/a" onclick="x()">x</a>', '<a onclick="x()" href="https://e.com/a">x</a>', "<a href='https://e.com/a'>x</a>",
    '<a href="https://e.com/a"><b>x</b></a>', '<a href="https://e.com/a">x <a href="https://e.com/b">y</a></a>',
    '<a href="https://e.com/a">x', '<a href="https://e.com/a>x</a>', '<a href="https://u:p@e.com/a">x</a>',
    '&amp;lt;a href=&amp;quot;https://e.com/a&amp;quot;&amp;gt;x&amp;lt;/a&amp;gt;', '<a href="https://e.com/a"></a>',
    '<a href="https://e.com/a">x\ny</a>', '<a href="https://e.com/a">&lt;img src=x&gt;</a>'
  ];
  for (const input of plain) assert.ok(!convertSourceAnchors(input).includes(']('), input);
  assert.equal(convertSourceAnchors('---\ntitle: <a href="https://e.com/a">x</a>\n---\n文'), '---\ntitle: <a href="https://e.com/a">x</a>\n---\n文', 'the frontmatter is never touched');
  const evil = convertSourceAnchors('<a href="https://e.com/a">![x](https://evil.example/i.png)</a>');
  assert.ok(evil.includes('\\!') && evil.startsWith('[') && evil.endsWith('](https://e.com/a)'), evil);
  assert.equal(bodyImageUrls(evil).length, 0, 'text inside an anchor never becomes an image');
});

test('T1 anchors (integration): the author write turns anchors into links; a tag the author writes stays cleaned; unsafe forms stay plain text and pass the exit check', async () => {
  const text = '來源 <a href="https://example.com/s">Site</a> 與 &lt;a href=&quot;https://example.org/t&quot;&gt;T&lt;/a&gt;，不轉 <a href="javascript:x">bad</a>、<a href="https://e.com/a" onclick="x">on</a>、!<a href="https://e.com/i.png">img</a>。';
  const r = await rig({ script: { author: async input => { await input.admission.reserve(); await r.repo.updateNoteGuarded(input.path, { detail: text }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } } });
  await finish(r);
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes('[Site](https://example.com/s)') && detail.includes('[T](https://example.org/t)'), detail);
  assert.ok(detail.includes('! [img](https://e.com/i.png)'));
  assert.ok(!detail.includes('](javascript') && !/<a /i.test(detail) && !detail.includes('](https://e.com/a)'));
  assert.equal(bodyImageUrls(detail).length, 0);
  assert.equal(stageOf(r.raw(1)), 'checked');
});

test('T1 data compatibility: text with no anchor and no placeholder passes the new cleaning byte for byte; a map with no bookPipeline and a plain note write are unchanged', async () => {
  const sample = '# T\n\n正文 [a](https://e.com) <!-- visual-agent-map:detail:start -->\n\n### 來源\n- s\n';
  assert.equal(convertSourceAnchors(sample), sample);
  assert.equal(dropPlaceholderSections(sample), sample);
  const r = await rig();
  const mapBefore = r.mapRaw();
  assert.ok(!mapBefore.includes('bookPipeline'));
  const before = r.raw(1);
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: 'x' }, {});
  const guarded = r.raw(1);
  await r.repo.updateNote(r.nodes[1].path, { detail: 'x' });
  const stamp = text => text.replace(/^updated: .*$/m, '');
  assert.equal(stamp(r.raw(1)), stamp(guarded));
  assert.notEqual(before, guarded);
  assert.ok(!guarded.includes(SECTION));
  assert.equal(r.mapRaw(), mapBefore);
  assert.equal(r.runs.getProgress(r.mapPath), undefined);
  assert.equal(r.mapRaw(), mapBefore);
});

// T2 P2a: the planner's image plan lands in the card's Prompt and reaches the author; an older card (no image plan) gives the author none.
test('image plan: the plan result is written to the Prompt and the author receives the card\'s slots; a plan result without images (older shape) writes no image plan and the author gets no slots', async () => {
  const { parseImageSlots } = S.load('core/book-pipeline/plan-text.ts');
  const plain = value => JSON.parse(JSON.stringify(value));
  const seen = new Map();
  const images = [{ index: 1, kind: 'map', explains: 'the route', anchor: 'after paragraph 1' }, { index: 2, kind: 'photo', explains: 'a port', anchor: 'end' }];
  const r = await rig({ script: {
    card: request => ({ covers: `covers ${request.card.position}`, entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], ...(request.card.position === 2 ? { images } : request.card.position === 3 ? { images: [] } : {}) }),
    author: async input => { seen.set(input.nodeId, plain(input.slots)); await input.admission.reserve(); return { outcome: 'discarded' }; }
  } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  await settle();
  const prompts = [await r.note(0), await r.note(1), await r.note(2)].map(n => n.prompt);
  assert.equal(parseImageSlots(prompts[0]), undefined, 'older shape: no image plan line');
  assert.deepEqual(plain(parseImageSlots(prompts[1])), images);
  assert.deepEqual(plain(parseImageSlots(prompts[2])), [], 'planned none');
  assert.deepEqual(plain(seen.get(r.nodes[0].id)), []); assert.deepEqual(plain(seen.get(r.nodes[1].id)), images); assert.deepEqual(plain(seen.get(r.nodes[2].id)), []);
});

test('progress: a card whose step ended is no longer in current (the in-memory sub-step is dropped with the step)', async () => {
  const stale = [];
  let samples = 0;
  const holder = {};
  const sample = () => {
    const p = holder.r.runs.getProgress(holder.r.mapPath);
    samples++;
    for (const c of p?.current ?? []) if (c.nodeId !== 'global' && !p.busyCards.includes(c.nodeId)) stale.push(c.nodeId);
  };
  const r = await rig({
    ports: { progressed: () => sample() },
    script: {
      author: async input => { await input.admission.reserve(); const note = await holder.r.repo.readNote(input.path); const out = await holder.r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
      proof: async request => { sample(); return { items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked' }; }
    }
  });
  holder.r = r;
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  assert.ok(samples > 3, 'sampled while the run progressed');
  assert.deepEqual(stale, [], 'a finished card is not left in current');
});

test('progress (memory only): current walks write, images, proof; steps end 3/3/3/3; no eta under 5 cards; the map file has neither key; nothing once the run is not active', async () => {
  const seen = [];
  const holder = {};
  const sample = () => { const p = holder.r.runs.getProgress(holder.r.mapPath); for (const c of p?.current ?? []) seen.push(c.step); };
  const r = await rig({
    ports: { progressed: () => sample() },
    script: {
      author: async input => { sample(); await input.admission.reserve(); const note = await holder.r.repo.readNote(input.path); const out = await holder.r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
      proof: async request => { sample(); return { items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked' }; }
    }
  });
  holder.r = r;
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  const first = (step) => seen.indexOf(step);
  assert.ok(first('write') >= 0 && first('images') > first('write') && first('proof') > first('images'), `order write, images, proof: ${seen.join(',')}`);
  const p = r.runs.getProgress(r.mapPath);
  assert.equal(p.active, false);
  assert.equal(p.current, undefined, 'no current once the run is not active');
  assert.deepEqual({ ...p.steps }, { plan: 3, write: 3, images: 3, proof: 3 });
  assert.equal(p.etaSeconds, undefined, 'three cards: no estimate');
  assert.equal(/"current"|"steps"/.test(r.mapRaw()), false, 'the map file keeps its shape');
  const filed = (await r.repo.readMap(r.mapPath)).bookPipeline;
  assert.equal('current' in filed, false); assert.equal('steps' in filed, false);
});

test('write: a hidden callout the author wrote is saved as a visible note (its text stays in the chapter text); the sources the author wrote survive the write', async () => {
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve(); const note = await r.repo.readNote(input.path);
    const text = `${bodyOf(note.title)}\n\n> [!vam-book]- 備註\n> 被藏起來的文字 SPAM\n\n第二段。\n\n### 來源\n\n- [S](https://s.example/a)\n`;
    await r.repo.updateNoteGuarded(input.path, { detail: text }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  } } });
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  const detail = (await r.note(1)).detail;
  assert.ok(!detail.includes('[!vam-book]- 備註') && detail.includes('[!note]- 備註'), 'the forged block is a visible note');
  assert.ok(chapterBody(detail).includes('SPAM'), 'the proofreading input sees the text');
  assert.ok(detail.includes('### 來源') && detail.includes('[S](https://s.example/a)'), 'the sources the author wrote are kept');
});

const holder = {};
const authorWrites = extra => ({ author: async input => {
  await input.admission.reserve(); const note = await holder.r.repo.readNote(input.path);
  await holder.r.repo.updateNoteGuarded(input.path, { detail: `${bodyOf(note.title)}\n\n${extra}\n` }, { authorize: input.authorize, finalize: input.finalize });
  return { outcome: 'written' };
} });
/** The lines of a Detail that sit inside a hidden callout (the `> ` quote lines after a `[!vam-book]` head). */
const hiddenLines = detail => { const out = []; let on = false; for (const l of detail.split('\n')) { if (/^\s*>\s*\[!vam-book\]/i.test(l)) on = true; else if (!/^\s*>/.test(l)) on = false; if (on) out.push(l); } return out; };

test('B2 run: hidden-looking text the author writes is saved visible; chapter text reaches the proofreading input, system sections stay readable', async () => {
  const cases = [
    ['indented head', ' > [!vam-book]- x\n >  SPAM3', true],
    ['no space head', '>[!vam-book]\n>SPAM4', true],
    ['upper case head', '> [!VAM-BOOK]- y\n> SPAM5', true],
    ['nested head', '> > [!vam-book]- z\n> > SPAM6', true],
    ['spaced type', '> [! vam-book]- s\n> SPAM9', true],
    ['metadata type', '> [!VAM-BOOK|x]- m\n> SPAM10', true],
    ['space before metadata', '> [!vam-book |meta]- n\n> SPAM11', true],
    ['lazy continuation', '> [!vam-book]- l\n> a\nSPAM7 lazy', true],
    ['inside a fence', '```\n> [!vam-book]- f\n> SPAM8\n```', true],
    ['research section', '### 研究備註\n\n> [!note]- 研究備註\n> SPAM1', false],
    ['update log section', '### 更新紀錄\n\n- 2026-01-01 SPAM2 任意文字', false]
  ];
  for (const [name, extra, inBody] of cases) {
    const r = await rig({ script: authorWrites(extra) });
    holder.r = r;
    await finish(r);
    const detail = (await r.note(1)).detail;
    const spam = /SPAM\d/.exec(extra)[0];
    assert.ok(detail.includes(spam), `${name}: the text is kept`);
    assert.ok(!hiddenLines(detail).some(l => l.includes(spam)), `${name}: the author's text is not hidden`);
    assert.ok(!/\[!\s*vam-book\s*(?:\|[^\]]*)?\]- (?:x|y|z|l|f|s|m|n)\b/i.test(r.raw(1)) && !/>\s*\[!vam-book\]\s*\n>\s*SPAM/i.test(r.raw(1)), `${name}: no hidden block of the author's`);
    if (inBody) assert.ok(chapterBody(detail).includes(spam), `${name}: the proofreading input sees it`);
  }
});

test('B2 run: the card\'s own old log and records still become hidden; the log does not grow on later reruns', async () => {
  const r = await rig();
  holder.r = r;
  await finish(r);
  let detail = '舊內文。\n\n### 更新紀錄\n\n- 2026-01-01\u3000OLDLOG\n';
  await r.repo.updateNoteRawGuarded(r.nodes[0].path, c => c.replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, '\n'), {});
  await r.repo.updateNoteGuarded(r.nodes[0].path, { detail: stampDetail(detail) }, {});
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    await rerun(r, 0);
    const d = (await r.note(0)).detail;
    assert.equal(count(d, 'OLDLOG'), 1, 'old log kept once');
    assert.ok(hiddenLines(d).some(l => l.includes('OLDLOG')), 'old log is hidden');
    assert.ok(!/^\s*(?:- )?2026-01-01\u3000OLDLOG/m.test(d), 'no visible copy');
    assert.equal(count(d, 'book-proof:v1'), 1);
    sizes.push(d.split('\n').filter(l => /\d{4}-\d\d-\d\d/.test(l)).length);
  }
  assert.ok(sizes[1] === sizes[0] && sizes[2] === sizes[0], `log lines: ${sizes}`);
});

test('B2 run: an author who keeps the old `### 研究備註` section loses no text; at most one visible and one hidden proof record', async () => {
  const r = await rig();
  holder.r = r;
  await finish(r);
  const old = (await r.note(0)).detail;
  const keep = '### 研究備註\n\n> [!note]- 研究備註\n> KEEPME';
  const keepOld = { author: async input => {
    await input.admission.reserve(); const note = await holder.r.repo.readNote(input.path);
    await holder.r.repo.updateNoteGuarded(input.path, { detail: `${note.detail}\n\n${keep}` }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  } };
  r.script.author = keepOld.author;
  await rerun(r, 0);
  const out = (await r.note(0)).detail;
  assert.ok(old.includes('book-proof:v1') && out.includes('KEEPME'), 'no text lost');
  const hiddenProof = hiddenLines(out).filter(l => l.includes('book-proof:v1')).length;
  assert.equal(hiddenProof, 1, 'exactly one hidden record');
  assert.equal(count(out, 'book-proof:v1') - hiddenProof, 0, 'no visible copy of a stored record (the author\'s kept copy is cut)');
  assert.ok(!hiddenLines(out).some(l => l.includes('KEEPME')));
});

// ---- T4 (P4a, minimal): one automatic redo of a card's text after a proofread named unmet points ----
const FACTS = [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'fact', text: 'a date' }];
const factCard = { card: () => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: FACTS }) };
const verdictOf = (request, factStatus, note = 'judged') => evaluateProof(request.checklist.map(c => ({ id: c.id, status: c.type === 'fact' ? factStatus : 'met', note: c.type === 'fact' ? note : 'ok', sources: c.type === 'fact' ? ['https://example.org/p'] : [] })), request.checklist, ['https://example.org/p']);
const writeAs = (r, seen) => async input => { seen.push([input.nodeId, input.instruction]); await input.admission.reserve(); const note = await r.repo.readNote(input.path); const out = await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };

test('T4 autofix: an unmet fact is redone once by the author alone, after every card had its first round; the reason goes to the author, never the plan or the proofread; the second verdict ends it', async () => {
  const seen = [];
  const planSeen = [];
  let proofs = 0;
  const r = await rig({ script: { ...factCard,
    proof: async request => (request.body.includes(TITLES[1]) && ++proofs === 1 ? verdictOf(request, 'unmet', 'WRONGDATE') : verdictOf(request, 'met')),
    author: (input, n) => writeAs(r, seen)(input) } });
  const orig = r.ports.runPlan;
  r.ports.runPlan = async (step, request, run) => { planSeen.push(request.instruction); return orig(step, request, run); };
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'gate2');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal(s.autoFixes[r.nodes[1].id], 1);
  assert.equal(s.autoFixes[r.nodes[0].id], undefined);
  assert.equal(r.stat.plan.filter(x => x === r.nodes[1].id).length, 1, 'no new plan: the plan and checklist stay');
  assert.ok(planSeen.every(x => x === undefined));
  assert.equal(seen.length, 4, 'three first rounds and one redo');
  assert.ok(seen.slice(0, 3).every(([, instruction]) => instruction === undefined), 'the redo starts only after every card finished its first round');
  assert.equal(seen[3][0], r.nodes[1].id);
  assert.match(seen[3][1], /"a date \/ WRONGDATE"/);
  assert.ok(r.stat.proof.every(request => !JSON.stringify(request).includes('WRONGDATE') && !JSON.stringify(request).includes('failed the fact check')));
  assert.equal(r.stat.proof.length, 4);
  assert.doesNotMatch(r.raw(1), /book-fix/);
});

test('T4 autofix: a verdict that is still unmet after the redo ends needs-review with the plain issue code; no second redo', async () => {
  const seen = [];
  const r = await rig({ script: { ...factCard, proof: async request => verdictOf(request, 'unmet', 'bad'), author: (input, n) => writeAs(r, seen)(input) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const s = await r.state();
  for (const n of r.nodes) assert.equal(s.autoFixes[n.id], 1);
  assert.equal(seen.length, 6);
  assert.equal(r.stat.proof.length, 6);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'proof unmet: C2');
  assert.equal(s.phase, 'gate2');
});

test('T4 autofix: a network or provider error, a discarded write, or a proofread that failed is never a content problem: no redo, no use counted', async () => {
  const d = await rig({ script: { author: async input => { await input.admission.reserve(); return { outcome: 'discarded' }; } } });
  await finish(d);
  assert.equal(d.stat.author.filter(id => id === d.nodes[1].id).length, 3, 'only the usual three attempts');
  assert.equal((await d.state()).autoFixes, undefined);
  const e = await rig({ script: { author: async () => { throw new Error('network down'); } } });
  await finish(e);
  assert.equal(e.stat.author.filter(id => id === e.nodes[1].id).length, 3);
  assert.equal((await e.note(1)).pipelineIssue, 'write failed: failed');
  assert.equal((await e.state()).autoFixes, undefined);
  const p = await rig({ script: { proof: async () => { throw new Error('provider down'); } } });
  await finish(p);
  assert.equal((await p.state()).autoFixes, undefined);
  assert.equal(stageOf(p.raw(1)), 'needs-review');
  assert.equal(p.stat.author.filter(id => id === p.nodes[1].id).length, 1, 'the author never ran again');
});

test('T4 autofix: stop and reopen during the redo keep the use: no second free redo; and a proofread that comes back after the redo began is dropped by the revision', async () => {
  const hold = defer();
  let held = false;
  const seen = [];
  const r = await rig({ script: { ...factCard, proof: async request => verdictOf(request, 'unmet', 'bad'),
    author: async input => { if (input.nodeId === r.nodes[1].id && seen.filter(([id]) => id === input.nodeId).length === 1 && !held) { held = true; seen.push([input.nodeId, 'held']); await hold.promise; } return writeAs(r, seen)(input); } } });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1);
  await r.runs.stop(r.mapPath); await running;
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1, 'the stop keeps the use');
  await r.runs.resume(r.mapPath);
  hold.resolve(); await settle();
  while (r.runs.isRunning(r.mapPath)) await tick();
  const s = await r.state();
  assert.equal(s.autoFixes[r.nodes[1].id], 1, 'never more than one redo');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'proof unmet: fix interrupted', 'the instruction was only in memory: the card is back at needs-review, not rewritten without it');
  assert.equal(r.stat.proof.filter(p => p.body.includes(TITLES[1])).length, 1, 'only the first proofread');
});

test('T4 autofix: a card whose write needed its third attempt and whose proofread is unmet gets no redo: it stays needs-review with its proof result', async () => {
  const seen = [];
  const r = await rig({ script: { ...factCard, proof: async request => verdictOf(request, 'unmet', 'bad'),
    author: (input, n) => (input.nodeId === r.nodes[1].id && n < 3 ? Promise.reject(new Error('network down')) : writeAs(r, seen)(input)) } });
  await finish(r);
  const s = await r.state();
  assert.equal(r.stat.author.filter(id => id === r.nodes[1].id).length, 3, 'the write took all its attempts');
  assert.equal(s.autoFixes?.[r.nodes[1].id], undefined, 'no redo was counted');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'proof unmet: C2', 'its proof result, not "write failed"');
});

test('T4 autofix: a single-card rerun never starts the automatic redo', async () => {
  let bad = false;
  const r = await rig({ script: { ...factCard, proof: async request => verdictOf(request, bad ? 'unmet' : 'met') } });
  await finish(r);
  bad = true;
  const proofs = r.stat.proof.length;
  await rerun(r, 1);
  assert.equal((await r.state()).autoFixes, undefined);
  assert.equal(r.stat.proof.length, proofs + 1);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
});

// ---- T5: the trial before gate 1 ----
const idle = async r => { await settle(); while (r.runs.isRunning(r.mapPath)) await tick(); };
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const T5_TITLES = ['T0', 'T1', 'T2', 'T3', 'T4'];
const trialRig = (over = {}) => {
  const models = { plan: 'm1', author: 'm2', proof: 'm3' };
  return rig({ trial: true, titles: T5_TITLES, ...over, ports: { config: () => ({ planModel: models.plan, authorModel: models.author, imageModel: 'm4', proofModel: models.proof, reasoning: 'low', language: 'zh-TW' }), ...over.ports } }).then(r => ({ ...r, models }));
};

test('T5 trial: only the first three cards are planned, written and proofread before gate 1; after confirm the rest run and the trial cards get no more calls', async () => {
  const r = await trialRig();
  const trial = r.nodes.slice(0, 3).map(n => n.id);
  await r.runs.start(r.mapPath);
  let s = await r.state();
  same(s.trial, trial);
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  same(r.stat.plan, ['global', ...trial]);
  same(r.stat.author, trial);
  assert.equal(r.stat.proof.length, 3);
  for (let i = 0; i < 3; i++) { assert.equal(stageOf(r.raw(i)), 'checked'); assert.ok((await r.note(i)).detail.includes(bodyOf(T5_TITLES[i]))); }
  for (let i = 3; i < 5; i++) { assert.equal(stageOf(r.raw(i)), undefined, 'a card outside the trial is untouched'); assert.ok(!(await r.note(i)).detail.includes('SecretBody')); }
  await confirmDone(r.runs, r.mapPath);
  s = await r.state();
  assert.equal(s.phase, 'gate2');
  same(r.stat.plan, ['global', ...r.nodes.map(n => n.id)], 'each card planned once');
  same(r.stat.author, r.nodes.map(n => n.id), 'each card written once: the trial cards are not written again');
  assert.equal(r.stat.proof.length, 5);
  for (let i = 0; i < 5; i++) assert.equal(stageOf(r.raw(i)), 'checked');
});

test('T5 trial: retryTrial reruns only the trial cards with the models read again; the others are untouched; a second retry works; it is refused outside gate 1', async () => {
  const r = await trialRig();
  r.stat.models = [];
  const base = r.script.author;
  r.script.author = async input => { r.stat.models.push(input.model); return base(input); };
  const planModels = [];
  const planPort = r.ports.runPlan;
  r.runs.ports.runPlan = async (step, request, run) => { planModels.push(request.model); return planPort(step, request, run); };
  await assert.rejects(() => r.runs.retryTrial(r.mapPath), e => e.code === 'missing', 'no run yet');
  await r.runs.start(r.mapPath);
  const trial = r.nodes.slice(0, 3).map(n => n.id);
  const outside = [3, 4].map(i => r.raw(i));
  same(r.stat.models, ['m2', 'm2', 'm2']);
  const planned = r.stat.plan.length, authored = r.stat.author.length, proofs = r.stat.proof.length, used = (await r.state()).budget.used;
  r.models.plan = 'n1'; r.models.author = 'n2'; r.models.proof = 'n3';
  await r.runs.retryTrial(r.mapPath); await idle(r);
  const s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  same(r.stat.plan.slice(planned), trial, 'the whole-book plan is not redone');
  same(r.stat.author.slice(authored), trial);
  assert.equal(r.stat.proof.length, proofs + 3);
  same(r.stat.models.slice(3), ['n2', 'n2', 'n2'], 'the new author model');
  same(planModels.slice(-3), ['n1', 'n1', 'n1'], 'the new plan model');
  assert.ok(r.stat.proof.slice(proofs).every(request => request.model === 'n3'), 'the new proofread model');
  assert.equal(s.budget.used, used + 9);
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'checked');
  same([3, 4].map(i => r.raw(i)), outside);
  await r.runs.retryTrial(r.mapPath); await idle(r);
  assert.equal(r.stat.author.length, authored + 6, 'a second retry runs the trial again');
  await confirmDone(r.runs, r.mapPath);
  await assert.rejects(() => r.runs.retryTrial(r.mapPath), e => e.code === 'not_gate1', 'gate 2');
});

test('T5 trial: a run without a trial (older data) refuses retryTrial and keeps planning every card before gate 1', async () => {
  const r = await rig({ titles: T5_TITLES });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.trial, undefined);
  assert.equal(s.phase, 'gate1');
  same(r.stat.plan, ['global', ...r.nodes.map(n => n.id)]);
  assert.equal(r.stat.author.length, 0);
  await assert.rejects(() => r.runs.retryTrial(r.mapPath), e => e.code === 'not_gate1');
});

test('T5 trial: fewer than three cards: the trial is every card, and gate 1 shows them all finished', async () => {
  const r = await trialRig({ titles: ['A', 'B'] });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  same(s.trial, r.nodes.map(n => n.id));
  assert.equal(s.phase, 'gate1');
  assert.equal(r.stat.author.length, 2);
  await confirmDone(r.runs, r.mapPath);
  assert.equal((await r.state()).phase, 'gate2');
  assert.equal(r.stat.author.length, 2, 'nothing is written twice');
});

test('T5 trial: retry while a trial card is needs-review: its counters start over and it is tried again', async () => {
  let fail = true;
  const r = await trialRig({ script: { author: async (input) => { if (fail && input.nodeId === r0.id) throw new Error('boom'); await input.admission.reserve(); const note = await rr.repo.readNote(input.path); await rr.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } } });
  const rr = r; const r0 = { id: r.nodes[1].id };
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(s.phase, 'gate1', 'a trial card that needs a person still lets the run reach gate 1');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal(s.attempts[r0.id].write, 3);
  fail = false;
  await r.runs.retryTrial(r.mapPath); await idle(r);
  s = await r.state();
  assert.equal(s.phase, 'gate1');
  assert.equal(stageOf(r.raw(1)), 'checked', 'the retry gave it a fresh try');
  assert.equal((await r.note(1)).pipelineIssue ?? '', '', 'the old issue is gone');
});

test('T5 trial: stop during the trial keeps the trial; resume finishes it without redoing the finished cards', async () => {
  const hold = defer();
  const r = await trialRig();
  const base = r.script.author;
  let first = true;
  r.script.author = async (input, n) => { if (first && input.nodeId === r.nodes[1].id) { first = false; await hold.promise; return { outcome: 'cancelled' }; } return base(input, n); };
  const starting = r.runs.start(r.mapPath); await settle();
  await r.runs.stop(r.mapPath); hold.resolve(); await starting.catch(() => undefined); await settle();
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.phase, 'planning'); assert.equal(s.trial.length, 3);
  await r.runs.resume(r.mapPath); await settle();
  s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'checked');
  assert.equal(r.stat.author.filter(id => id === r.nodes[0].id).length, 1, 'a card finished before the stop is not written again');
  assert.equal(stageOf(r.raw(3)), undefined);
});

test('restart: a run stopped in planning is replaced by a fresh run with the models read again; the old drive\'s late plan is dropped; a running run and a plain start are refused', async () => {
  const hold = defer();
  let held = false;
  const models = { author: 'm2' };
  const authorModels = [];
  const r = await rig({ script: {
    global: (request) => { if (!held) { held = true; return hold.promise.then(() => ({ thread: 'LATE thread', cards: r.nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [], decisions: {} })); } return { thread: 'new thread', cards: r.nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: {} }; },
    author: async (input) => { authorModels.push(input.model); await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; }
  }, ports: { config: () => ({ planModel: 'm1', authorModel: models.author, imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }) } });
  const started = r.runs.start(r.mapPath);
  await settle();
  await assert.rejects(() => r.runs.start(r.mapPath, { restart: true }), e => e.code === 'busy');
  await r.runs.stop(r.mapPath); await started.catch(() => undefined);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.phase, 'planning');
  const oldId = s.runId;
  await assert.rejects(() => r.runs.start(r.mapPath), e => e.code === 'exists', 'a plain start still refuses a stopped run');
  models.author = 'm9';
  await r.runs.start(r.mapPath, { restart: true });
  hold.resolve(); await settle();
  s = await r.state();
  assert.notEqual(s.runId, oldId, 'a new run replaced the stopped one');
  assert.equal(s.phase, 'gate1');
  assert.equal(JSON.stringify(s).includes('LATE thread'), false, 'the old drive\'s late plan was dropped');
  await r.runs.confirmGate1(r.mapPath); await settle();
  assert.ok(authorModels.length > 0 && authorModels.every(m => m === 'm9'), `the new run uses the models read again: ${authorModels}`);
});

test('restart: a running gate run is not replaced by a restart; a run stopped at a gate is', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).phase, 'gate1');
  await assert.rejects(() => r.runs.start(r.mapPath, { restart: true }), e => e.code === 'exists', 'a gate that is not stopped keeps its own flow');
  await r.runs.stop(r.mapPath, { saved: true });
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.phase, 'gate1', 'stop at a gate holds the same gate');
  const oldId = s.runId;
  await assert.rejects(() => r.runs.start(r.mapPath), e => e.code === 'exists', 'a plain start still refuses a stopped run');
  await r.runs.start(r.mapPath, { restart: true });
  s = await r.state();
  assert.notEqual(s.runId, oldId, 'the gate-stopped run was replaced by a new one');
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
});

test('stop at gate 1 and gate 2: the run holds the same gate; continue returns to it with no card work redone', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  await r.runs.stop(r.mapPath, { saved: true });
  let s = await r.state();
  assert.deepEqual([s.phase, s.status], ['gate1', 'stopped']);
  const authored = r.stat.author.length;
  await r.runs.resume(r.mapPath);
  s = await r.state();
  assert.deepEqual([s.phase, s.status], ['gate1', 'running'], 'continue returns to gate 1');
  assert.equal(r.stat.author.length, authored);
  await r.runs.confirmGate1(r.mapPath); await settle();
  assert.equal((await r.state()).phase, 'gate2');
  await r.runs.stop(r.mapPath, { saved: true });
  s = await r.state();
  assert.deepEqual([s.phase, s.status], ['gate2', 'stopped']);
  await r.runs.resume(r.mapPath);
  s = await r.state();
  assert.deepEqual([s.phase, s.status], ['gate2', 'running'], 'continue returns to gate 2');
});

test('abandon: a stopped run (planning or a gate) and a done run lose bookPipeline; every note is byte-identical; a plain start works after; a running gate and a drive refuse', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  await assert.rejects(() => r.runs.abandon(r.mapPath), e => e.code === 'not_stopped', 'a gate that is waiting is not abandoned');
  await r.runs.stop(r.mapPath, { saved: true });
  const before = r.nodes.map((n, i) => JSON.stringify(r.raw(i)));
  await r.runs.abandon(r.mapPath);
  const map = await r.repo.readMap(r.mapPath);
  assert.equal(map.bookPipeline, undefined, 'the map is a normal mind map');
  assert.equal(r.runs.getProgress(r.mapPath), undefined, 'the progress record is dropped');
  assert.deepEqual(r.nodes.map((n, i) => JSON.stringify(r.raw(i))), before, 'notes untouched');
  await assert.rejects(() => r.runs.abandon(r.mapPath), e => e.code === 'missing');
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).phase, 'gate1', 'a plain start works afterwards');
  await confirmDone(r.runs, r.mapPath);
  await r.runs.finishRun(r.mapPath);
  assert.equal((await r.state()).phase, 'done');
  const doneBefore = r.nodes.map((n, i) => JSON.stringify(r.raw(i)));
  await r.runs.abandon(r.mapPath);
  assert.equal((await r.repo.readMap(r.mapPath)).bookPipeline, undefined, 'done: the book is removed');
  assert.deepEqual(r.nodes.map((n, i) => JSON.stringify(r.raw(i))), doneBefore, 'done: notes untouched');
});

test('abandon: a drive of the map refuses (busy) and an interrupted run (saved running, no drive) is abandoned', async () => {
  const hold = defer();
  const r = await rig({ script: { global: () => hold.promise.then(() => ({ thread: 't', cards: r.nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [], decisions: {} })) } });
  const started = r.runs.start(r.mapPath);
  await settle();
  await assert.rejects(() => r.runs.abandon(r.mapPath), e => e.code === 'busy');
  await r.runs.stop(r.mapPath); await started.catch(() => undefined);
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.status = 'running'; });
  await r.runs.abandon(r.mapPath);
  assert.equal((await r.repo.readMap(r.mapPath)).bookPipeline, undefined);
  hold.resolve(); await settle();
  assert.equal((await r.repo.readMap(r.mapPath)).bookPipeline, undefined, 'the old drive\'s late result writes nothing');
});

test('start: a map with only a root topic and no chapter cards is refused with "empty" and nothing is written', async () => {
  const r = await rig({ titles: ['Only root'] });
  await assert.rejects(() => r.runs.start(r.mapPath), e => e.code === 'empty');
  assert.equal((await r.repo.readMap(r.mapPath)).bookPipeline, undefined);
});

// ---- the callout port (T4): the runner asks the notes to follow the run and clears them before a run is replaced ----
const calloutPort = r => { const log = []; return { log, port: { reconcile: async path => { log.push(['reconcile', path, (await r.state())?.phase]); }, clear: async path => { log.push(['clear', path, !!(await r.repo.readMap(path)).bookPipeline]); return true; } } }; };
test('callouts: entering gate 1, entering gate 2 and a rerun at gate 2 each ask for a reconcile; a plain phase of writing does not', async () => {
  const spy = { log: [], port: null };
  const r = await rig({ ports: { callouts: { reconcile: async path => { spy.log.push(['reconcile', path]); }, clear: async () => true } } });
  await r.runs.start(r.mapPath); await settle();
  const atGate1 = spy.log.length;
  assert.ok(atGate1 >= 1, 'gate 1 asked');
  await confirmDone(r.runs, r.mapPath); await settle();
  assert.equal((await r.state()).phase, 'gate2');
  const atGate2 = spy.log.length;
  assert.ok(atGate2 > atGate1, 'writing then gate 2 asked again');
  assert.ok(spy.log.every(([, path]) => path === r.mapPath));
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id); await settle();
  assert.ok(spy.log.length > atGate2, 'a rerun at gate 2 redrew the box');
});
test('callouts: a throwing or rejecting port never stops the run', async () => {
  const r = await rig({ ports: { callouts: { reconcile: () => { throw new Error('x'); }, clear: async () => true } } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal((await r.state()).phase, 'gate2');
});
test('callouts: abandon and a restart clear the notes while bookPipeline still exists (nothing is left to find them by afterwards)', async () => {
  const r = await rig(); const spy = calloutPort(r);
  const runs = new BookPipelineRuns({ ...r.ports, callouts: spy.port });
  await runs.start(r.mapPath); await runs.stop(r.mapPath, { saved: true }); await settle();
  spy.log.length = 0;
  await runs.abandon(r.mapPath);
  assert.deepEqual(spy.log.filter(x => x[0] === 'clear').map(x => x[2]), [true], 'cleared first, then the run was removed');
  assert.equal(readBookPipeline(await r.repo.readMap(r.mapPath)).kind, 'absent');
  await runs.start(r.mapPath); await runs.stop(r.mapPath, { saved: true }); await settle();
  spy.log.length = 0;
  await runs.start(r.mapPath, { restart: true });
  assert.ok(spy.log.some(x => x[0] === 'clear' && x[2] === true), 'a restart clears the old run first');
});

// ---- T6b: applying the reader's notes (the notes slot of BookPipelineRuns) ------------------------------------------------------------
const { createNoteWriter } = S.load('experiences/visual-map/book-pipeline-callouts.ts');
const { SKIP_MARK } = S.load('core/book-pipeline/notes-apply.ts');
const NW = (text, n, note) => `==${text}==%%備註#${n}：${note}%%`;
const P1 = `Alpha ${NW('beta', 1, 'shorter')} gamma.`;
const reply = request => ({ paragraphs: request.items.map(item => ({ id: item.id, text: 'Alpha BETA2 gamma.' })), refused: [] });

/** A run waiting at gate 1 whose card A (nodes[1]) has one annotated paragraph; the notes ports write through the real writer with no editor open. */
async function notesRig(over = {}) {
  const r = await rig(over);
  await r.runs.start(r.mapPath);
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${P1}\n\nA plain paragraph.` }, { authorize: () => true, finalize: c => c });
  const calls = [];
  const writer = createNoteWriter({ openViews: () => [], rawGuarded: (p, t, o) => r.repo.updateNoteRawGuarded(p, t, o) });
  r.ports.notes = { readText: async path => r.contents.get(path), write: writer };
  const planned = r.ports.runPlan;
  r.ports.runPlan = async (step, request, run) => {
    if (step.id !== 'book-pipeline.apply-notes') return planned(step, request, run);
    calls.push(request);
    await run.admission.reserve();
    return (over.notes ?? reply)(request, run);
  };
  r.calls = calls;
  r.cardRaw = () => r.contents.get(r.nodes[1].path);
  return r;
}
const refusal = code => error => error instanceof BookPipelineRunError && error.code === code;

test('apply notes: rewrites the paragraph once, spends one unit, keeps phase and status, marks both neighbour seams, logs no content (no map tab open)', async () => {
  const r = await notesRig();
  const before = await r.state();
  const result = await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const after = await r.state();
  assert.equal(result.applied, 1); assert.equal(result.skipped, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.edits.map(e => [e.before, e.after]))), [[P1, 'Alpha BETA2 gamma.']]);
  assert.ok(r.cardRaw().includes('Alpha BETA2 gamma.') && !r.cardRaw().includes('%%備註#1'));
  assert.equal(after.budget.used, before.budget.used + 1);
  assert.equal(after.phase, before.phase); assert.equal(after.status, before.status);
  assert.equal(r.calls.length, 1);
  assert.equal(r.stat.backups.at(-1), r.nodes[1].path);
  assert.ok((await r.note(0)).pipelineSeam, 'the previous card is marked');
  assert.ok((await r.note(2)).pipelineSeam, 'the next card is marked');
  const line = r.stat.logs.find(x => x.includes('notes_applied'));
  assert.ok(line && /applied=1/.test(line) && !line.includes('Alpha') && !line.includes('Secret'));
});

test('apply notes (review-a B4, plan 7-2): each apply writes a new seam line, so an accepted tick of the neighbour\'s box is void again', async () => {
  const { attentionFingerprint } = S.load('experiences/visual-map/book-pipeline-review.ts');
  const r = await notesRig();
  await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const first = (await r.note(2)).pipelineSeam;
  const accepted = attentionFingerprint({ stage: 'needs-review', issue: 'x', seam: first });
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${P1}\n\nA plain paragraph.` }, { authorize: () => true, finalize: c => c });
  await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const second = (await r.note(2)).pipelineSeam;
  assert.ok(first && second && first !== second, 'the seam line changed');
  assert.notEqual(attentionFingerprint({ stage: 'needs-review', issue: 'x', seam: second }), accepted, 'the old tick no longer counts');
});

test('apply notes (review-a M1): a cancel that arrives after the writer wrote still finishes normally (edits kept for undo, both seams marked)', async () => {
  const r = await notesRig();
  const real = r.ports.notes.write;
  r.ports.notes = { ...r.ports.notes, write: async (path, transform) => { const out = await real(path, transform); r.runs.cancelNotes(r.mapPath); return out; } };
  const result = await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  assert.equal(result.applied, 1);
  assert.equal(result.edits.length, 1, 'the undo record is there');
  assert.ok(r.cardRaw().includes('Alpha BETA2 gamma.'));
  assert.ok((await r.note(0)).pipelineSeam && (await r.note(2)).pipelineSeam, 'both seams are marked');
});

test('apply notes: a stopped book stays stopped (phase and status untouched, one unit spent)', async () => {
  const r = await notesRig();
  await r.runs.stop(r.mapPath, { saved: true }); await settle();
  const before = await r.state();
  assert.equal(before.status, 'stopped');
  await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const after = await r.state();
  assert.equal(after.status, 'stopped'); assert.equal(after.phase, before.phase);
  assert.equal(after.budget.used, before.budget.used + 1);
});

test('apply notes: a drive refuses it, and while it runs every drive entry and a second job are refused', async () => {
  const gate = defer();
  const r = await notesRig({ notes: async request => { await gate.promise; return reply(request); } });
  const job = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  await settle();
  assert.equal(r.runs.isApplyingNotes(r.mapPath), true);
  await assert.rejects(r.runs.confirmGate1(r.mapPath), refusal('busy'));
  await assert.rejects(r.runs.start(r.mapPath, { restart: true }), refusal('busy'));
  await assert.rejects(r.runs.resume(r.mapPath), refusal('busy'));
  await assert.rejects(r.runs.rerunCard(r.mapPath, r.nodes[1].id, 'again'), refusal('busy'));
  await assert.rejects(r.runs.applyNotes(r.mapPath, r.nodes[1].id), refusal('notes_busy'));
  gate.resolve();
  assert.equal((await job).applied, 1);
  assert.equal(r.runs.isApplyingNotes(r.mapPath), false);
  // A drive holds the map: refused with its own code, nothing spent.
  const hold = defer();
  const q = await notesRig({ script: { author: async () => { await hold.promise; return { outcome: 'cancelled' }; } } });
  const used = (await q.state()).budget.used;
  const running = q.runs.confirmGate1(q.mapPath);
  await settle();
  assert.equal(q.runs.isRunning(q.mapPath), true);
  await assert.rejects(q.runs.applyNotes(q.mapPath, q.nodes[1].id), refusal('drive_running'));
  assert.equal(q.calls.length, 0);
  hold.resolve(); await running.catch(() => undefined); await q.runs.stop(q.mapPath); await settle();
  assert.ok((await q.state()).budget.used >= used);
});

test('apply notes: the last budget unit goes to one of two concurrent jobs, then the next is refused as budget', async () => {
  const gate = defer();
  const r = await notesRig({ notes: async request => { await gate.promise; return reply(request); } });
  await setLimit(r, (await r.state()).budget.used + 1);
  const first = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const second = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  await assert.rejects(second, refusal('notes_busy'));
  gate.resolve();
  assert.equal((await first).applied, 1);
  const s = await r.state();
  assert.equal(s.budget.used, s.budget.limit);
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${P1}\n\nA plain paragraph.` }, { authorize: () => true, finalize: c => c });
  await assert.rejects(r.runs.applyNotes(r.mapPath, r.nodes[1].id), refusal('budget'));
  assert.equal(r.calls.length, 1);
});

test('apply notes: a failed backup replaces nothing, spends nothing and never asks the model', async () => {
  const r = await notesRig({ ports: { backupNote: async () => ({ ok: false }) } });
  const raw = r.cardRaw(); const used = (await r.state()).budget.used;
  await assert.rejects(r.runs.applyNotes(r.mapPath, r.nodes[1].id), refusal('backup_failed'));
  assert.equal(r.cardRaw(), raw); assert.equal(r.calls.length, 0);
  assert.equal((await r.state()).budget.used, used);
  assert.equal(r.runs.isApplyingNotes(r.mapPath), false, 'the slot is released');
});

test('apply notes: a replaced run or a card taken out of the order before the commit writes nothing', async () => {
  for (const change of [
    d => { d.bookPipeline.runId = 'another-run'; },
    d => { d.bookPipeline.order = d.bookPipeline.order.filter(id => id !== d.nodes[1].id); },
    d => { d.nodes = d.nodes.filter(n => n.id !== d.nodes[1].id); }
  ]) {
    const gate = defer();
    let r;
    r = await notesRig({ notes: async request => { await gate.promise; return reply(request); } });
    const raw = r.cardRaw();
    const job = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
    await settle();
    await r.repo.updateMap(r.mapPath, change);
    gate.resolve();
    await assert.rejects(job, error => error instanceof BookPipelineRunError && (error.code === 'stale' || error.code === 'missing'));
    assert.equal(r.cardRaw(), raw);
    assert.ok(!(await r.note(0)).pipelineSeam, 'no seam is marked either');
  }
});

test('apply notes: cancel, a late answer after dispose, and the caller signal write nothing', async () => {
  for (const stop of [
    (r, controller) => r.runs.cancelNotes(r.mapPath),
    (r, controller) => r.runs.dispose(),
    (r, controller) => controller.abort()
  ]) {
    const gate = defer();
    const r = await notesRig({ notes: async request => { await gate.promise; return reply(request); } });
    const raw = r.cardRaw();
    const controller = new AbortController();
    const job = r.runs.applyNotes(r.mapPath, r.nodes[1].id, { signal: controller.signal });
    await settle();
    stop(r, controller);
    gate.resolve();
    await assert.rejects(job, error => error instanceof BookPipelineRunError && (error.code === 'cancelled' || error.code === 'disposed'));
    assert.equal(r.cardRaw(), raw);
    assert.equal(r.runs.isApplyingNotes(r.mapPath), false);
  }
});

test('apply notes: a paragraph edited during the call is skipped (marked in its note), no body change means no seam', async () => {
  const gate = defer();
  const r = await notesRig({ notes: async request => { await gate.promise; return reply(request); } });
  const job = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  await settle();
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${P1} edited.\n\nA plain paragraph.` }, { authorize: () => true, finalize: c => c });
  gate.resolve();
  const result = await job;
  assert.equal(result.applied, 0); assert.equal(result.skipped, 1);
  assert.ok(r.cardRaw().includes(SKIP_MARK) && r.cardRaw().includes('edited.'));
  assert.ok(!(await r.note(0)).pipelineSeam && !(await r.note(2)).pipelineSeam);
});

test('apply notes: no note, no run and a missing card are refused without a call', async () => {
  const r = await notesRig();
  await r.repo.updateNoteGuarded(r.nodes[2].path, { detail: 'No notes here.' }, { authorize: () => true, finalize: c => c });
  await assert.rejects(r.runs.applyNotes(r.mapPath, r.nodes[2].id), refusal('nothing'));
  await assert.rejects(r.runs.applyNotes(r.mapPath, 'no-such-card'), refusal('missing'));
  assert.equal(r.calls.length, 0);
});

// ---- T9: the reader's hand on a chapter (the program never overwrites it without the reader's one-time permission) ----
const { bodyStateRaw, integrityFpRaw, keepRaw, readBodyRecord } = S.load('core/book-pipeline/body-integrity.ts');
const { detailBlockOf } = S.load('core/book-pipeline/note-sections.ts');
const HAND = ' HAND-EDIT';
const handEdit = (r, i, extra = HAND) => r.repo.updateNoteRawGuarded(r.nodes[i].path, c => c.replace(bodyOf(TITLES[i]), bodyOf(TITLES[i]) + extra), {});
/** The book is back in the writing phase with the named chapters planned again (what a whole-book redo or an interrupted run leaves), then resumed to the checkpoint. */
async function redo(r, indexes, stage = 'planned') {
  for (const i of indexes) await r.repo.writePipelineFields(r.nodes[i].path, { pipelineStage: stage, pipelineIssue: null });
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  await r.runs.resume(r.mapPath);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
}

test('T9 stamp: every program write of a chapter leaves its fingerprint, so a finished book reads as untouched', async () => {
  const r = await rig();
  await finish(r);
  for (let i = 0; i < 3; i++) {
    const detail = detailBlockOf(r.raw(i));
    assert.equal(readBodyRecord(detail).fp, require('node:crypto') && readBodyRecord(detail).fp, 'a record exists');
    assert.equal(bodyStateRaw(r.raw(i)), 'clean', `chapter ${i} is as the program left it`);
  }
});

test('T9 commit point: the author write itself carries the fingerprint (stop during the picture probe still leaves a clean chapter)', async () => {
  const hold = defer();
  const r = await rig({ script: { probe: async () => { await hold.promise; return { ok: true }; }, author: async input => { await input.admission.reserve(); await r.repo.updateNoteGuarded(input.path, { detail: `${bodyOf('x')}\n\n![ok](https://ok.example/d.png)` }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } } });
  await r.runs.start(r.mapPath);
  const confirm = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'text and fingerprint were one write');
  await r.runs.stop(r.mapPath); hold.resolve(); await confirm.catch(() => undefined);
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
});

test('T9 auto skip: a whole-book redo skips the hand-edited chapter (needs-review, text untouched, no author call for it) and the other chapters still run', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  const before = r.raw(1);
  const authors = r.stat.author.length;
  await redo(r, [1, 2]);
  assert.equal(r.stat.author.length, authors + 1, 'only the untouched chapter was written again');
  assert.equal(r.stat.author.at(-1), r.nodes[2].id);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
  assert.ok((await r.note(1)).detail.includes(HAND), 'the reader\'s text is still there');
  assert.equal(detailBlockOf(r.raw(1)), detailBlockOf(before), 'nothing of the chapter was written');
  assert.equal(stageOf(r.raw(2)), 'checked');
  assert.equal((await r.state()).phase, 'gate2');
  assert.ok(r.stat.logs.some(l => l.includes('hand_edit_skipped')));
});

test('T9 unknown: an older chapter with text and no fingerprint (and no stored proof to vouch for it) is skipped like a hand-edited one', async () => {
  const r = await rig();
  await finish(r);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/\n> <!-- book-body:v1 .*-->/, '').replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, '\n'), {});
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown');
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'not written');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
});

test('T9 keep (review-b B1): keeping a note that has no record stays kept: a whole-book redo does not write it and the record holds no program fingerprint', async () => {
  const r = await rig();
  await finish(r);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/\n> <!-- book-body:v1 .*-->/, '').replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, '\n'), {});
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown');
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  assert.equal(readBodyRecord(detailBlockOf(r.raw(1))).fp, undefined, 'no program fingerprint is stored');
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown');
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'author not called');
  assert.ok(r.stat.logs.some(l => l.includes('hand_edit_kept')));
  const { isKeptRaw } = S.load('core/book-pipeline/body-integrity.ts');
  assert.equal(isKeptRaw(r.raw(1)), true, 'the view still asks (G) for a manual rerun');
});

test('T9 keep: "keep my version" makes a whole-book redo leave the chapter alone and send it on to its proofread', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  const before = detailBlockOf(r.raw(1));
  const authors = r.stat.author.length;
  const proofs = r.stat.proof.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'not written');
  assert.equal(r.stat.proof.length, proofs + 1, 'proofread though');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.ok((await r.note(1)).detail.includes(HAND));
  assert.ok(r.stat.logs.some(l => l.includes('hand_edit_kept')));
  assert.ok(detailBlockOf(r.raw(1)).includes(HAND) && before.includes(HAND));
  // typing again after the keep is a new edit: the keep no longer covers it
  await handEdit(r, 1, ' MORE');
  assert.equal(bodyStateRaw(r.raw(1)), 'edited');
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'still not written');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
});

test('review-b S3: a redo of the whole book makes no plan call for a hand-edited or kept chapter, and a kept chapter gets no proof the second time and no auto-fix', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  await handEdit(r, 2);
  await r.repo.updateNoteRawGuarded(r.nodes[2].path, keepRaw, {});
  const plans = r.stat.plan.length;
  const authors = r.stat.author.length;
  await redo(r, [0, 1, 2], null);
  const planned = r.stat.plan.slice(plans);
  assert.ok(planned.includes(r.nodes[0].id), 'a clean chapter is planned (the test really replans)');
  assert.ok(!planned.includes(r.nodes[1].id), 'hand-edited: no plan call');
  assert.ok(!planned.includes(r.nodes[2].id), 'kept: no plan call');
  assert.ok(!r.stat.author.slice(authors).some(id => id === r.nodes[1].id || id === r.nodes[2].id), 'neither is written');
  const calls = () => r.stat.plan.length + r.stat.proof.length + r.stat.author.length;
  const first = calls();
  await redo(r, [0, 1, 2], null);
  const again = r.stat.plan.slice(plans).filter(id => id === r.nodes[1].id || id === r.nodes[2].id);
  assert.equal(again.length, 0, 'still no plan call on the next redo');
  assert.ok(calls() - first <= 2 * (r.nodes.length), 'no per-chapter retry storm');
  assert.ok(r.stat.logs.some(l => l.includes('plan_skipped')));
});

test('T9 rerun: without permission a single-card rerun leaves a hand-edited chapter alone', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  const authors = r.stat.author.length;
  await rerun(r, 1);
  assert.equal(r.stat.author.length, authors);
  assert.ok((await r.note(1)).detail.includes(HAND));
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
});

test('T9 F: a rerun with the reader\'s permission for this text backs the chapter up first, rewrites it once and the chapter is clean again', async () => {
  const seen = { backupsAtAuthor: -1 };
  const r = await rig({ script: { author: async (input, n) => {
    seen.backupsAtAuthor = r.stat.backups.filter(p => p === input.path).length;
    await input.admission.reserve(); const note = await r.repo.readNote(input.path);
    const out = await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) + ` v${n}` }, { authorize: input.authorize, finalize: input.finalize });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  } } });
  await finish(r);
  await handEdit(r, 1);
  const fingerprint = integrityFpRaw(r.raw(1));
  const authors = r.stat.author.length;
  const used = (await r.state()).budget.used;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id, { overwrite: { operation: 'op-1', fingerprint } });
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.equal(r.stat.author.length, authors + 1, 'written once');
  assert.ok(seen.backupsAtAuthor >= 1, 'the backup came first');
  assert.ok(!(await r.note(1)).detail.includes(HAND));
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
  assert.ok((await r.state()).budget.used > used, 'it costs calls');
  assert.notEqual((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
  // the permission was for that one rerun: the next hand edit is protected again
  await handEdit(r, 1, ' AGAIN');
  await rerun(r, 1);
  assert.equal(r.stat.author.length, authors + 1);
});

test('T9 F: a permission bound to older text is refused (text_changed) with nothing written and no call', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  const fingerprint = integrityFpRaw(r.raw(1));
  await handEdit(r, 1, ' TYPED-AFTER');
  const authors = r.stat.author.length;
  const used = (await r.state()).budget.used;
  await assert.rejects(r.runs.rerunCard(r.mapPath, r.nodes[1].id, { overwrite: { operation: 'op-2', fingerprint } }), e => e instanceof BookPipelineRunError && e.code === 'text_changed');
  assert.equal(r.stat.author.length, authors);
  assert.equal((await r.state()).budget.used, used, 'nothing was charged');
  assert.ok((await r.note(1)).detail.includes('TYPED-AFTER'));
});

test('T9 F: with no budget left the permission rewrites nothing and the chapter keeps the reader\'s text', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  const fingerprint = integrityFpRaw(r.raw(1));
  await setLimit(r, (await r.state()).budget.used);
  const authors = r.stat.author.length;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id, { overwrite: { operation: 'op-3', fingerprint } }).catch(() => undefined);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.equal(r.stat.author.length, authors, 'no author call without budget');
  assert.ok((await r.note(1)).detail.includes(HAND));
});

test('T9 callback window: typing after the check but before the write is not overwritten (the write checks the text it is about to replace)', async () => {
  const r = await rig({ script: { author: async (input, n) => {
    await input.admission.reserve();
    if (n === 2) await handEdit(r, 1, ' TYPED-IN-THE-WINDOW');
    const out = await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(TITLES[1]) + ` v${n}` }, { authorize: input.authorize, finalize: input.finalize });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  } } });
  await finish(r);
  await rerun(r, 1);
  assert.ok((await r.note(1)).detail.includes('TYPED-IN-THE-WINDOW'), 'the typing survived');
  assert.ok(!(await r.note(1)).detail.includes(' v2'));
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
});

test('T9 callback window: a permission bound to one text does not cover text typed after it was given', async () => {
  const r = await rig({ script: { author: async (input, n) => {
    await input.admission.reserve();
    if (n === 2) await handEdit(r, 1, ' LATER');
    const out = await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(TITLES[1]) + ` v${n}` }, { authorize: input.authorize, finalize: input.finalize });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  } } });
  await finish(r);
  await handEdit(r, 1);
  const fingerprint = integrityFpRaw(r.raw(1));
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id, { overwrite: { operation: 'op-4', fingerprint } });
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.ok((await r.note(1)).detail.includes('LATER'));
});

test('review-a B2: a reader\'s note added between the backup and the write survives (the write is refused like a hand edit)', async () => {
  const { wrapNote } = S.load('core/book-pipeline/book-notes.ts');
  const r = await rig({ script: { author: async (input, n) => {
    await input.admission.reserve();
    if (n === 2) await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(bodyOf(TITLES[1]), wrapNote(bodyOf(TITLES[1]), 1, 'keep this note')), {});
    const out = await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(TITLES[1]) + ` v${n}` }, { authorize: input.authorize, finalize: input.finalize });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  } } });
  await finish(r);
  await rerun(r, 1);
  assert.ok((await r.note(1)).detail.includes('%%備註#1：keep this note%%'), 'the note survived');
  assert.ok(!(await r.note(1)).detail.includes(' v2'), 'the author text did not land');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
});

test('T9 detection through the notes: a reader\'s note on the chapter is not a hand edit, a changed word is', async () => {
  const r = await rig();
  await finish(r);
  const { wrapNote } = S.load('core/book-pipeline/book-notes.ts');
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(bodyOf(TITLES[1]), wrapNote(bodyOf(TITLES[1]), 1, 'please check this')), {});
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'a note alone does not count');
  await handEdit(r, 1, ' WORD');
  assert.equal(bodyStateRaw(r.raw(1)), 'edited');
});

// ---- T10a: chapter prose under the first sources heading (new author result only); one verdict reducer for every proof ----
test('T10a write (decision #24): the two evidence shapes are NOT lifted; the card keeps its text, says no_body and ends needs-review without a fingerprint stamp', async () => {
  for (const name of ['book-sources-lead-r5.md', 'book-sources-lead-r3.md']) {
    const fixtureDetail = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', name), 'utf8').split('> [!vam-book]')[0].trimEnd() + '\n';
    const r = await rig({ script: { author: async input => {
      await input.admission.reserve();
      await r.repo.updateNoteGuarded(input.path, { detail: fixtureDetail }, { authorize: input.authorize, finalize: input.finalize });
      return { outcome: 'written' };
    } } });
    await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
    const note = await r.note(1);
    assert.equal(note.pipelineIssue, 'write failed: no_body', name);
    assert.equal(stageOf(r.raw(1)), 'needs-review', name);
    assert.ok(!note.detail.includes('wayfair.com'), `${name}: the refused text was not written`);
  }
});

test('T10a write (decision #24): a double heading with long sources commentary is not lifted and gets no fingerprint stamp', async () => {
  const commentary = '這些來源的可靠度評析：第一個來源由專業機構發布，方法透明，數據可以重現，因此可信度高。'.repeat(3) + '\n\n' + '第二個來源是個人整理，缺乏原始出處，只能當作參考，引用時需要另外查證，可信度中等。'.repeat(3);
  assert.ok(commentary.length > 200);
  const detail = `### 來源\n\n${commentary}\n\n### 參考資料\n\n- [A](https://a.example/x)\n- [B](https://b.example/y)\n`;
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve();
    await r.repo.updateNoteGuarded(input.path, { detail }, { authorize: input.authorize, finalize: input.finalize });
    return { outcome: 'written' };
  } } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const note = await r.note(1);
  assert.equal(note.pipelineIssue, 'write failed: no_body');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.ok(!note.detail.includes('可靠度評析'), 'the commentary was not committed as the chapter');
  assert.ok(!r.raw(1).includes('book-body:v1'), 'no fingerprint stamp');
});

test('T10a write: an ambiguous result (list only, or commentary with a list under one heading) stays no_body; the text is not rewritten', async () => {
  for (const detail of ['### 來源：\n\n- [S](https://s.example/a)', '### 來源\n\n這些資料是本章的依據。\n\n- [S](https://s.example/a)']) {
    const r = await rig({ script: { author: async input => {
      await input.admission.reserve();
      await r.repo.updateNoteGuarded(input.path, { detail }, { authorize: input.authorize, finalize: input.finalize });
      return { outcome: 'written' };
    } } });
    await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
    assert.equal((await r.note(1)).pipelineIssue, 'write failed: no_body');
    assert.ok(!(await r.note(1)).detail.includes('s.example'));
  }
});

const unjudged = (request, statuses) => ({ aggregate: 'checked', items: request.checklist.map(c => ({ id: c.id, type: c.type, status: statuses[c.id] ?? 'met', note: `note ${c.id}`, sources: c.type === 'fact' ? ['https://example.org/p'] : [] })) });
test('T10a proof: a proof that says checked while every structure point is unmet is re-judged to needs-review and gets the one auto-fix, whose author request names the structure point', async () => {
  const seen = [];
  const r = await rig({ script: { ...factCard, proof: async request => unjudged(request, { C1: 'unmet' }), author: input => writeAs(r, seen)(input) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  const s = await r.state();
  assert.equal(s.autoFixes[r.nodes[1].id], 1);
  const redo = seen.filter(([, instruction]) => instruction !== undefined);
  assert.ok(redo.length >= 1);
  assert.match(redo[0][1], /structure points/);
  assert.match(redo[0][1], /has a beginning/);
  assert.equal((await r.note(1)).pipelineIssue, 'proof unmet: C1');
});

test('T10a proof: a mixed fact and structure failure puts both in the one auto-fix request; a partly unmet structure with met facts stays checked', async () => {
  const seen = [];
  let first = true;
  const r = await rig({ script: { ...factCard, proof: async request => { const out = first && request.body.includes(TITLES[1]) ? unjudged(request, { C1: 'unmet', C2: 'unmet' }) : unjudged(request, {}); if (request.body.includes(TITLES[1])) first = false; return out; }, author: input => writeAs(r, seen)(input) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const redo = seen.filter(([, instruction]) => instruction !== undefined);
  assert.equal(redo.length, 1);
  assert.match(redo[0][1], /fact check/); assert.match(redo[0][1], /a date/);
  assert.match(redo[0][1], /structure points/); assert.match(redo[0][1], /has a beginning/);
  const three = [{ id: 'C1', type: 'structure', text: 'a' }, { id: 'C2', type: 'structure', text: 'b' }, { id: 'C3', type: 'fact', text: 'd' }];
  const p = await rig({ script: { card: () => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: three }), proof: async request => unjudged(request, { C1: 'unmet' }) } });
  await p.runs.start(p.mapPath); await confirmDone(p.runs, p.mapPath);
  assert.equal(stageOf(p.raw(1)), 'checked');
});

// ---- T10c: the length rule (Bug3) and the card-plan request (Bug4) ----
const LEN_SETTING = '每章 100–200 字';
const lenRig = async (over = {}, setting = LEN_SETTING) => {
  const r = await rig(over);
  if (setting !== null) await r.repo.writeBookSettings(r.nodes[0].path, { length: setting });
  return r;
};
const longBody = (title, n) => `${bodyOf(title)} ${'好'.repeat(n)}`;
/** An author that writes `first` characters, then `later` once it was given an instruction (the one automatic redo). */
const lengthAuthor = (r, seen, first, later) => async input => {
  seen.push([input.nodeId, input.instruction]);
  await input.admission.reserve();
  const note = await r.repo.readNote(input.path);
  const n = input.instruction !== undefined ? later : first;
  const out = await r.repo.updateNoteGuarded(input.path, { detail: longBody(note.title, n) }, { authorize: input.authorize, finalize: input.finalize });
  return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
};

test('T10c length: a chapter over the range gets the one auto-fix whose author instruction says to shorten; when the redo fits it ends checked with no length issue', async () => {
  const seen = [];
  const r = await lenRig();
  // chapter 1 first too long, then right; the others are right
  r.script.author = async input => lengthAuthor(r, seen, input.nodeId === r.nodes[1].id ? 400 : 150, 150)(input);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const redo = seen.filter(([id, instruction]) => id === r.nodes[1].id && instruction !== undefined);
  assert.equal(redo.length, 1);
  assert.match(redo[0][1], /shorten/); assert.match(redo[0][1], /100 to 200/);
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1);
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal((await r.note(1)).pipelineIssue ?? '', '');
});

test('T10c length: with the one auto-fix spent and the chapter still outside the range the card stays needs-review with the `length unmet:` token (not checked)', async () => {
  const seen = [];
  const r = await lenRig();
  r.script.author = lengthAuthor(r, seen, 500, 500);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.match((await r.note(1)).pipelineIssue, /^length unmet: length:over:\d+:100-200:字:v\d+$/);
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1, 'only one automatic redo');
  assert.equal(seen.filter(([id, instruction]) => id === r.nodes[1].id && instruction !== undefined).length, 1);
});

test('T10c length: a lengthened chapter that is too short says "lengthen"; a failed fact and the length together keep both in the issue and in the one instruction', async () => {
  const under = [];
  const a = await lenRig();
  a.script.author = lengthAuthor(a, under, 10, 10);
  await a.runs.start(a.mapPath); await confirmDone(a.runs, a.mapPath);
  assert.match(under.find(([id, instruction]) => id === a.nodes[1].id && instruction !== undefined)[1], /lengthen/);
  assert.match((await a.note(1)).pipelineIssue, /length:under:\d+:100-200/);
  const seen = [];
  const r = await lenRig({ script: { ...factCard, proof: async request => verdictOf(request, 'unmet', 'WRONGDATE') } });
  r.script.author = lengthAuthor(r, seen, 500, 500);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const redo = seen.filter(([id, instruction]) => id === r.nodes[1].id && instruction !== undefined);
  assert.equal(redo.length, 1);
  assert.match(redo[0][1], /fact check/); assert.match(redo[0][1], /shorten/);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.match((await r.note(1)).pipelineIssue, /^proof unmet: C2 length:over:\d+:100-200:字:v\d+$/, 'length does not lower the fact failure, and sits beside it');
});

test('T10c length: a single-card rerun (job) has no automatic redo; an over-length chapter stays needs-review with the length issue', async () => {
  const r = await lenRig();
  await finish(r);
  assert.equal(stageOf(r.raw(1)), 'needs-review', 'the first run wrote a 25 character chapter, below the range');
  const seen = [];
  r.script.author = lengthAuthor(r, seen, 500, 500);
  const fixes = (await r.state()).autoFixes[r.nodes[1].id];
  await rerun(r, 1);
  assert.equal(seen.filter(([id]) => id === r.nodes[1].id).length, 1, 'one write, no redo');
  assert.ok(seen.every(([, instruction]) => instruction === undefined || typeof instruction === 'string'));
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], fixes, 'the job did not spend an automatic redo');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.match((await r.note(1)).pipelineIssue, /length:over:/);
});

test('T10c length: an ambiguous (two ranges), inverted or zero-valued setting is not checked and the log says length_rule_ignored; no unit-less rule becomes a hard rule', async () => {
  for (const setting of ['每章 100–200 字，或 300–400 words', '每章 300–100 字', '0–50 字']) {
    const seen = [];
    const r = await lenRig({}, setting);
    r.script.author = lengthAuthor(r, seen, 900, 900);
    await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
    assert.equal(stageOf(r.raw(1)), 'checked', setting);
    assert.ok(!/length:/.test((await r.note(1)).pipelineIssue ?? ''), setting);
    assert.ok(r.stat.logs.some(line => line.includes('length_rule_ignored')), `${setting}: logged`);
    assert.ok(seen.every(([, instruction]) => instruction === undefined), 'no redo');
  }
});

test('T10c plan request: the chapter list is the whole book on the map and the root carries its direct child cards; a card with no children has none', async () => {
  const requests = [];
  const r = await rig({ script: { card: request => { requests.push(request); return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }] }; } } });
  await r.runs.start(r.mapPath);
  const root = requests.find(x => x.card.id === r.nodes[0].id);
  assert.deepEqual([...root.chapters.map(c => c.title)], TITLES);
  assert.deepEqual([...root.chapters.map(c => c.position)], [1, 2, 3]);
  assert.deepEqual([...root.children.map(c => c.title)], [TITLES[1], TITLES[2]]);
  assert.match(root.children[0].summary, /summary of/);
  const leaf = requests.find(x => x.card.id === r.nodes[1].id);
  assert.equal(leaf.children, undefined);
  assert.equal(leaf.chapters.length, 3);
});

test('T10c plan request: a chapter list too long for the step is refused before any call, logged plan_refused chapters_too_long, and the card needs a person', async () => {
  const titles = ['R'.repeat(60000), 'A'.repeat(60000), 'B'.repeat(60000)];
  const r = await rig({ titles });
  await r.runs.start(r.mapPath);
  assert.ok(r.stat.logs.some(line => line.includes('plan_refused') && line.includes('chapters_too_long')), 'logged');
  assert.ok(!r.stat.plan.some(id => id !== 'global'), 'no card plan call was made');
  assert.ok(r.stat.logs.every(line => !line.includes('R'.repeat(50))), 'no title in the log');
  assert.equal(stageOf(r.raw(0)), 'needs-review');
});

test('T10c length: a pure length failure keeps the notice tokens of the card (a partly unmet structure point) and adds the length token; no token is dropped', async () => {
  const three = [{ id: 'C1', type: 'structure', text: 'a' }, { id: 'C2', type: 'structure', text: 'b' }, { id: 'C3', type: 'fact', text: 'd' }];
  const r = await lenRig({ script: { card: () => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: three }), proof: async request => unjudged(request, { C1: 'unmet' }) } });
  r.script.author = lengthAuthor(r, [], 500, 500);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  const issue = (await r.note(1)).pipelineIssue;
  assert.match(issue, /^length unmet: length:over:\d+:100-200:字:v\d+ C1$/, 'the length token and the structure token both stay');
});

// ---- T11: cards added or removed while a run is in progress ----
const sameJson = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const FOUR = ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB', 'SecretTitleC'];
const addCard = async (r, title) => {
  const doc = await r.repo.readMap(r.mapPath);
  const n = await r.repo.createNote(title, 'model-a', doc, r.mapPath, 'workspace', { summary: `summary of ${title}` });
  n.x = 900; n.y = 0; n.parentId = r.nodes[0].id;
  await r.repo.updateMap(r.mapPath, d => { d.nodes.push(n); });
  return n;
};
const dropCard = (r, i) => r.repo.updateMap(r.mapPath, d => { d.nodes = d.nodes.filter(n => n.id !== r.nodes[i].id); });
const finished = async (r, runs = r.runs) => { while (runs.isRunning(r.mapPath)) await tick(); await settle(); };

test('map change before admission: the run pauses with a count and nothing is written; "carry on" runs on without pausing again', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  const before = (await r.state()).budget.used;
  await dropCard(r, 2);
  const fresh = await addCard(r, 'SecretTitleNew');
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'map');
  sameJson([s.changed.added.length, s.changed.missing.length], [1, 1]);
  assert.equal(r.stat.author.length, 0, 'nothing was admitted');
  assert.equal(s.budget.used, before, 'no call was spent');
  assert.equal(r.runs.getProgress(r.mapPath).mapChange.added, 1);
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  s = await r.state();
  assert.equal(s.phase, 'gate2'); assert.equal(s.status, 'running');
  sameJson(s.removed, [r.nodes[2].id]); sameJson(s.ignored, [fresh.id]);
  assert.ok(s.accepted.includes(fresh.id) && !s.accepted.includes(r.nodes[2].id));
  sameJson([...new Set(r.stat.author)].sort(), [r.nodes[0].id, r.nodes[1].id, r.nodes[3].id].sort(), 'only the kept cards were written, the new one and the removed one were not');
  assert.equal(r.stat.author.length, 3);
  assert.equal(s.budget.used, before + 3 + 3, 'three authors and three proofs, nothing for the removed card');
  assert.equal(stageOf(r.raw(2)), 'planned', 'the removed card keeps what it had');
  assert.equal(r.runs.getProgress(r.mapPath).total, 3);
  assert.equal(r.runs.getProgress(r.mapPath).counts.checked, 3);
});

test('map change: it survives a reopen (a new runner reads the saved pause) and the old data without the new fields reads as before', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  await dropCard(r, 3);
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  assert.equal((await r.state()).pauseReason, 'map');
  const again = new BookPipelineRuns(r.ports);
  assert.equal(again.getProgress(r.mapPath), undefined);
  await again.keepBookMap(r.mapPath); await finished(r, again);
  const s = await r.state();
  assert.equal(s.phase, 'gate2'); sameJson(s.removed, [r.nodes[3].id]);
  // A paused-for-map run is only resumed by keepBookMap; the plain resume pauses again at its first step.
  const old = await rig({ titles: FOUR });
  await old.runs.start(old.mapPath);
  await old.repo.updateMap(old.mapPath, d => { delete d.bookPipeline.accepted; delete d.bookPipeline.ignored; delete d.bookPipeline.removed; });
  await old.runs.confirmGate1(old.mapPath); await finished(old);
  assert.equal((await old.state()).phase, 'gate2', 'an old map without the fields and with no change runs through');
  const old2 = await rig({ titles: FOUR });
  await old2.runs.start(old2.mapPath);
  await old2.repo.updateMap(old2.mapPath, d => { delete d.bookPipeline.accepted; });
  await dropCard(old2, 1);
  await old2.runs.confirmGate1(old2.mapPath); await finished(old2);
  assert.equal((await old2.state()).pauseReason, 'map', 'an old map without `accepted` compares with its order');
  await old2.runs.resume(old2.mapPath); await finished(old2);
  assert.equal((await old2.state()).pauseReason, 'map', 'a plain resume pauses again while the map still differs');
});

test('a second add or remove after "carry on" pauses again and only counts what is new', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  await dropCard(r, 1);
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  const base = r.script.author; let armed = true; let second;
  r.script.author = async (input, n) => { if (armed) { armed = false; second = await addCard(r, 'SecretTitleLate'); await dropCard(r, 3); } return base(input, n); };
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'map');
  sameJson(s.changed.added, [second.id]); sameJson(s.changed.missing, [r.nodes[3].id], 'the first removal is already settled');
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  const done = await r.state();
  assert.equal(done.phase, 'gate2'); sameJson(done.removed.sort(), [r.nodes[1].id, r.nodes[3].id].sort()); sameJson(done.ignored, [second.id]);
  for (const id of done.removed) assert.ok(!r.stat.author.filter(x => x === id).length || id === r.nodes[3].id, 'a removed card is never retried');
});

test('a card deleted before its author commits: the result is dropped, the attempt is given back, the sent call is counted, the card is never retried', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  const before = (await r.state()).budget.used;
  const victim = r.nodes[2].id; let hit = 0;
  const base = r.script.author;
  r.script.author = async (input, n) => { if (input.nodeId === victim) { hit++; await dropCard(r, 2); } return base(input, n); };
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  let s = await r.state();
  assert.equal(s.pauseReason, 'map'); sameJson(s.changed.missing, [victim]);
  assert.equal(s.attempts[victim].write, 0, 'the attempt is given back');
  assert.ok(s.budget.used > before, 'the call that was sent counts');
  for (let i = 0; i < 4; i++) assert.notEqual(stageOf(r.raw(i)), 'needs-review');
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  s = await r.state();
  assert.equal(s.phase, 'gate2'); assert.equal(hit, 1, 'the removed card is never written again');
  assert.equal(r.stat.author.filter(id => id === victim).length, 1);
  assert.equal(s.attempts[victim].write, 0);
});

test('review-b S2: an author write already in flight to a card removed from the map does not land (the removed note keeps its text)', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  const victim = r.nodes[2].id;
  const base = r.script.author;
  let before;
  r.script.author = async (input, n) => {
    if (input.nodeId === victim) { before = r.raw(2); await dropCard(r, 2); await r.runs.mapModified(r.mapPath); }
    return base(input, n);
  };
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  assert.ok(before !== undefined, 'the victim was in flight');
  assert.equal(r.raw(2), before, 'the removed note is exactly as it was');
  const s = await r.state();
  assert.equal(s.pauseReason, 'map'); sameJson(s.changed.missing, [victim]);
});

test('neighbours: the previous and next chapter skip a removed one; its seam is never marked; its callouts and queued rewrite are cleaned', async () => {
  const cleared = [];
  const r = await rig({ titles: FOUR, ports: { callouts: { reconcile: async () => undefined, clear: async () => true, clearNotes: async (path, runId, cards) => { cleared.push(...cards.map(c => c.id)); return true; } } } });
  await r.runs.start(r.mapPath);
  const base = r.script.author; let hit = false;
  r.script.author = async (input, n) => { if (!hit) { hit = true; await dropCard(r, 2); } return base(input, n); };
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  sameJson(cleared, [r.nodes[2].id], 'the removed chapter gets its program callouts taken off');
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  const seen = [];
  const card = r.script.card;
  r.script.card = (request, n) => { seen.push(request); return card(request, n); };
  await r.runs.rerunCard(r.mapPath, r.nodes[3].id); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  const request = seen.find(item => item.card.id === r.nodes[3].id);
  assert.equal(request.previous.title, 'SecretTitleA', 'the previous chapter is the one before the removed card');
  assert.ok((await r.note(1)).pipelineSeam, 'the previous chapter is marked');
  assert.ok(!(await r.note(2)).pipelineSeam, 'the removed card is not');
});

test('no id reaches the owner: the log, progress and failure text of a map change carry counts only', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  await dropCard(r, 2);
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  const text = JSON.stringify(r.runs.getProgress(r.mapPath));
  for (const node of r.nodes) assert.ok(!text.includes(node.id));
  assert.ok(r.stat.logs.some(line => /map_changed/.test(line)));
});

test('keepBookMap refuses a run that did not pause for the map', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  await assert.rejects(r.runs.keepBookMap(r.mapPath), refusal('not_stopped'));
});

test('a card already missing when a drive opens: the start snapshot gives its note, so its program callouts are cleaned; old data without it changes nothing', async () => {
  for (const snapshot of [true, false]) {
    const cleared = [];
    const r = await rig({ titles: FOUR, ports: { callouts: { reconcile: async () => undefined, clear: async () => true, clearNotes: async (path, runId, cards) => { cleared.push(...cards.map(c => `${c.id}|${c.path}`)); return true; } } } });
    await r.runs.start(r.mapPath);
    let s = await r.state();
    sameJson(Object.keys(s.chapters).sort(), r.nodes.map(n => n.id).sort());
    sameJson(s.chapters[r.nodes[3].id], { title: 'SecretTitleC', path: r.nodes[3].path });
    if (!snapshot) await r.repo.updateMap(r.mapPath, d => { delete d.bookPipeline.chapters; });
    await dropCard(r, 3);
    await r.runs.confirmGate1(r.mapPath); await finished(r);
    s = await r.state();
    assert.equal(s.pauseReason, 'map'); sameJson(s.changed.missing, [r.nodes[3].id]);
    sameJson(cleared, snapshot ? [`${r.nodes[3].id}|${r.nodes[3].path}`] : [], snapshot ? 'cleaned from the snapshot' : 'no snapshot: nothing known, nothing cleaned');
    await r.runs.keepBookMap(r.mapPath); await finished(r);
    assert.equal((await r.state()).phase, 'gate2');
  }
});

// ---- T12: after a single-chapter rerun, the neighbours' previous/next plan line follows the new covers (no AI call) ----
const promptLine = async (r, i, label) => new RegExp(`^${label}[:：] ?(.*)$`, 'm').exec((await r.note(i)).prompt)?.[1];
async function neighbourRig(titles = FOUR) {
  const r = await rig({ titles });
  await r.runs.start(r.mapPath); await r.runs.confirmGate1(r.mapPath); await finished(r);
  assert.equal((await r.state()).phase, 'gate2');
  const base = r.script.card; r.script.card = (request, n) => ({ ...base(request, n), covers: `NEWCOVERS ${request.card.position}` });
  return r;
}
const NEXT = /後一張|Next card/;

test('T12 neighbours: both neighbours get the rerun chapter\'s new covers on their line; no AI call; the seam is still marked; the chapter text and its fingerprint are untouched', async () => {
  const r = await neighbourRig();
  const fps = [1, 2, 3].map(i => integrityFpRaw(r.raw(i)));
  const before = { proof: r.stat.proof.length };
  const planBefore = r.stat.plan.length;
  await rerun(r, 2);
  assert.equal(r.stat.plan.length, planBefore + 1, 'only the rerun chapter was planned again');
  assert.equal(r.stat.proof.length, before.proof + 1, 'only the rerun chapter was proofread again');
  assert.equal((await promptLine(r, 1, '後一張')), `(3) SecretTitleB — NEWCOVERS 3`, 'left neighbour: next line');
  assert.equal((await promptLine(r, 3, '前一張')), `(3) SecretTitleB — NEWCOVERS 3`, 'right neighbour: previous line');
  assert.ok((await promptLine(r, 1, '前一張')).includes('(1)'), 'its other line is not touched');
  assert.ok((await r.note(1)).pipelineSeam && (await r.note(3)).pipelineSeam, 'seams marked as before');
  assert.equal(integrityFpRaw(r.raw(1)), fps[0]); assert.equal(integrityFpRaw(r.raw(3)), fps[2]);
  for (const i of [1, 3]) assert.equal(bodyStateRaw(r.raw(i)), 'clean');
});

test('T12 neighbours: the first and the last chapter have one neighbour; a removed neighbour is skipped for the next one over', async () => {
  const r = await neighbourRig();
  await rerun(r, 0);
  assert.equal((await promptLine(r, 1, '前一張')), '(1) SecretRootTitle — NEWCOVERS 1');
  assert.ok(!/NEWCOVERS/.test((await promptLine(r, 2, '前一張'))));
  const last = await neighbourRig();
  await rerun(last, 3);
  assert.equal((await promptLine(last, 2, '後一張')), '(4) SecretTitleC — NEWCOVERS 4');
  // A removed neighbour: chapter 2 is removed; rerunning chapter 3 changes chapter 1's next line (now the one before) and not the removed card.
  const gone = await neighbourRig();
  const removedBefore = gone.raw(2);
  await dropCard(gone, 2);
  await gone.repo.updateMap(gone.mapPath, d => { d.bookPipeline.removed = [gone.nodes[2].id]; d.bookPipeline.accepted = d.bookPipeline.order.filter(id => id !== gone.nodes[2].id); d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  await rerun(gone, 3);
  assert.equal(gone.raw(2), removedBefore, 'the removed card is never written');
  assert.equal((await promptLine(gone, 1, '後一張')), '(3) SecretTitleC — NEWCOVERS 3', 'the surviving neighbour on the left follows');
});

test('T12 neighbours: a neighbour whose text the reader edited by hand is not touched; its seam is still marked; running the rewrite again changes nothing', async () => {
  const r = await neighbourRig();
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${(await r.note(1)).detail}\nreader added this line` }, {});
  assert.equal(bodyStateRaw(r.raw(1)), 'edited');
  const editedLine = await promptLine(r, 1, '後一張');
  await rerun(r, 2);
  assert.equal(await promptLine(r, 1, '後一張'), editedLine, 'the edited neighbour keeps its line');
  assert.equal((await promptLine(r, 3, '前一張')), '(3) SecretTitleB — NEWCOVERS 3', 'the clean neighbour still follows');
  assert.ok((await r.note(1)).pipelineSeam, 'seam is marked');
  // Idempotent: the second rerun with the same covers writes no neighbour again.
  const writes = []; const base = r.ports.updateNoteGuarded;
  r.ports.updateNoteGuarded = async (path, patch, options) => { if (patch.prompt !== undefined && path !== r.nodes[2].path) writes.push(path); return base(path, patch, options); };
  const snap = (await r.note(3)).prompt;
  await rerun(r, 2);
  assert.equal(writes.length, 0, 'identical line: no write');
  assert.equal((await r.note(3)).prompt, snap);
});

test('T12 neighbours: a rerun that fails its plan, or one that is stopped, leaves the neighbours\' lines as they were', async () => {
  const r = await neighbourRig();
  const keep = [1, 3].map(i => r.raw(i));
  const base = r.script.card; r.script.card = () => { throw new Error('plan boom'); };
  await rerun(r, 2);
  assert.deepEqual([1, 3].map(i => r.raw(i).replace(/^pipeline-seam:.*\n/m, '')), keep.map(x => x.replace(/^pipeline-seam:.*\n/m, '')));
  r.script.card = base;
});

test('T12 rewriteNeighbourLine: keeps the label and colon (English, CRLF), writes one safe line, returns undefined for a missing or identical line', () => {
  const { rewriteNeighbourLine } = S.load('core/book-pipeline/plan-text.ts');
  const n = { position: 2, title: 'T\n# x', summary: 'new [[link]]' };
  const out = rewriteNeighbourLine('Role: Body\r\nNext card: (3) old — old\r\nChecklist:', 'next', n);
  assert.ok(/^Role: Body\r\nNext card: \(2\) T[^\n]* — [^\n]*\r\nChecklist:$/.test(out), out);
  assert.equal(out.split('\n').length, 3, 'one line, no injected heading');
  assert.equal(rewriteNeighbourLine('Role: Body', 'next', n), undefined, 'no such line');
  assert.equal(rewriteNeighbourLine(out, 'next', n), undefined, 'already says it');
});
