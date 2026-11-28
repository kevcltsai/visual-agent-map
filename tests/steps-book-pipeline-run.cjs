// Picture-book pipeline runner (03a): the gates, retries, budget pause, stop/resume, stale fence, dispose, guarded writes and the picture
// allow-list of BookPipelineRuns, with fake ports over the real repository fixture. The provider, probe and step runner are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load: loadReplay } = require('./support-replay.cjs');
const { BookPipelineRuns, BookPipelineRunError, bodyImageUrls, replaceBodyImages, unsafeBody, convertSourceAnchors, expansionUnsafe, expansionUnsafeRule } = S.load('experiences/visual-map/book-pipeline-run.ts');
const { BudgetExhaustedError } = S.load('core/admission.ts');
const { readBookPipeline, closingPageSkipped } = S.load('core/book-pipeline/model.ts');
const { setCoverRecord } = S.load('core/book-pipeline/cover-block.ts');
const { OPEN_ISSUES_MARKER } = S.load('core/book-pipeline/open-issues.ts');
const { cardRevision, fixAgainPlan } = S.load('core/book-pipeline/machine.ts');
const review = S.load('experiences/visual-map/book-pipeline-review.ts');
/** The sentences the review box of chapter `i` lists after the run (gate 2's own rules): the box must say what really happened. */
const boxReasons = async (r, i) => {
  const s = await r.state();
  const note = await r.note(i);
  const card = review.gate2Cards({ order: [r.nodes[i].id], titleOf: () => note.title, noteOf: () => note, proofContext: { runId: s.runId, revisionOf: id => cardRevision(s, id) } })[0];
  return review.reviewProblems(card);
};
/** An unsafe_body chapter's box names the refused write and never says the text was changed (nothing was written). */
const assertUnsafeBox = async (r, i, label = '') => {
  const problems = await boxReasons(r, i);
  assert.ok(problems.some(p => p.kind === 'failed' && /safety check|安全檢查/.test(p.text)), `${label} the box names the failed safety check: ${JSON.stringify(problems)}`);
  assert.ok(!problems.some(p => p.kind === 'edited' || /已修改|changed, not proofread/i.test(p.text)), `${label} no "changed" line: ${JSON.stringify(problems)}`);
};
const { proofKey, evaluateProof, composeProofRecord } = S.load('core/book-pipeline/proof.ts');
const { findStoredProof, withoutResearchNotes, chapterBody, appendResearchNote, dropPlaceholderSections, markOldProofRecords } = S.load('core/book-pipeline/note-sections.ts');
const { parseChecklist } = S.load('core/book-pipeline/plan-text.ts');
const { stampDetail } = S.load('core/book-pipeline/body-integrity.ts');
const { frontmatter } = S.load('core/repository-frontmatter.ts', { obsidian: S.obsidian });
const { readAiLocked } = S.load('note-values.ts');

const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
const TITLES = ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB'];
const bodyOf = title => `SecretBody ${title}`;
/** The one automatic redo edits the chapter in place: a change block that puts `next` (default: the same text) where `line` was. */
const fixOf = (line, next = line) => `@@replace\n${line}\n@@with\n${next}`;
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
  // `over.nested`: the third card is a section of the second, so the trial (preface, chapter 1 and its sections) is the first three cards.
  if (over.nested && nodes.length > 2) nodes[2].parentId = nodes[1].id;
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { logs: [], plan: [], planEdit: [], author: [], proof: [], probes: [], backups: [], writes: 0, ai: [] };
  let queue = Promise.resolve();
  let ids = 0;
  const script = { global: () => ({ thread: 'one thread', cards: nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } }),
    card: request => ({ covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }] }),
    author: async input => { await input.admission.reserve(); const note = await repo.readNote(input.path); const r = await repo.updateNoteGuarded(input.path, { detail: input.requirements !== undefined ? fixOf(bodyOf(note.title)) : bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return r === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
    proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked' }),
    // The independent AI proofread (opt-in with `over.ai`): by default no check. 
    aiProof: async () => ({ checks: [], prior: [], dropped: {} }), aiFix: async () => [], aiBookProof: async () => ({ checks: [], prior: [], dropped: {} }),
    // The chief editor's pass over the plans: by default nothing needs a change.
    planEdit: () => [],
    probe: async () => ({ ok: true }), ...over.script };
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: path => repo.readMap(path),
    // Most tests here pin the older run without a trial (every card planned before gate 1): the run's `trial` is dropped unless `over.trial`.
    // Trial tests run the trial at once (as a run that is past its plan review) unless `over.planReview` keeps the plan review.
    updateMap: (path, change) => repo.updateMap(path, d => { change(d); if (d.bookPipeline) { if (!over.trial) delete d.bookPipeline.trial; if (over.trial && !over.planReview) delete d.bookPipeline.planReview; } }),
    readCard: async path => {
      const note = await repo.readNote(path);
      return { path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(path), aiLocked: readAiLocked(frontmatter(contents.get(path))), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineRole ? { pipelineRole: note.pipelineRole } : {}), ...(note.bookRoleBy ? { bookRoleBy: note.bookRoleBy } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}), ...(note.pipelineSeam ? { pipelineSeam: note.pipelineSeam } : {}) } };
    },
    writePipelineFields: (path, patch) => { stat.writes++; return repo.writePipelineFields(path, patch); },
    ...(over.noRolePort ? {} : { writePipelineRole: (path, role) => repo.writePipelineRole(path, role) }),
    updateNoteGuarded: (path, patch, options) => repo.updateNoteGuarded(path, patch, options),
    updateNoteRawGuarded: (path, transform, options) => repo.updateNoteRawGuarded(path, transform, options),
    runPlan: async (step, request, run) => {
      if (step.id === 'book-pipeline.global-plan') { stat.plan.push('global'); await run.admission.reserve(); return script.global(request, stat.plan.filter(x => x === 'global').length); }
      if (step.id === 'book-pipeline.plan-edit') { stat.planEdit.push(request); await run.admission.reserve(); const out = await script.planEdit(request, stat.planEdit.length); return Array.isArray(out) ? { changes: out } : out; }
      stat.plan.push(request.card.id); await run.admission.reserve(); return script.card(request, stat.plan.filter(x => x === request.card.id).length);
    },
    runProofread: async (request, run) => { stat.proof.push(request); await run.admission.reserve(); return script.proof(request, stat.proof.length); },
    author: input => { stat.author.push(input.nodeId); return script.author(input, stat.author.filter(x => x === input.nodeId).length); },
    probeImage: async (url, signal) => { stat.probes.push(url); return script.probe(url, signal, stat.probes.length); },
    ...(over.ai ? {
      aiProof: async (request, run) => { stat.ai.push(['proof', request]); await run.admission.reserve(); return script.aiProof(request, stat.ai.length); },
      aiFix: async (request, run) => { stat.ai.push(['fix', request]); await run.admission.reserve(); return script.aiFix(request, stat.ai.length, run); },
      aiBookProof: async (request, run) => { stat.ai.push(['book', request]); await run.admission.reserve(); return script.aiBookProof(request, stat.ai.length); }
    } : {}),
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
  await assert.rejects(() => r.runs.confirmGate1(r.mapPath), e => e instanceof BookPipelineRunError && e.code === 'finished');
  s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal(r.stat.author.length, 3);
  for (let i = 0; i < 3; i++) { assert.equal(stageOf(r.raw(i)), 'checked'); assert.ok((await r.note(i)).detail.includes(bodyOf(TITLES[i]))); }
  assert.equal(s.budget.used, 1 + 3 + 1 + 3 + 3, 'whole-book plan, 3 card plans, the chief editor\'s pass, 3 writes, 3 proofs');
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
  assert.equal(s.phase, 'done');
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
  await setLimit(r, 7); // 5 used by planning (plan, 3 cards, the plan edit): two more calls
  await confirmDone(r.runs, r.mapPath);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget'); assert.equal(s.phase, 'writing');
  assert.equal(r.runs.getProgress(r.mapPath).pauseReason, 'budget');
  for (let i = 0; i < 3; i++) assert.notEqual(stageOf(r.raw(i)), 'needs-review');
  assert.ok(Object.values(s.attempts).every(a => typeof a === 'number' || (a.write <= 1 && a.plan <= 1)));
  // the other map (its own budget gate) and a call without a gate are unaffected
  await other.runs.start(other.mapPath); await confirmDone(other.runs, other.mapPath);
  assert.equal((await other.state()).phase, 'done');
  assert.equal((await other.state()).budget.used, 11);
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e instanceof BookPipelineRunError && e.code === 'budget');
  await r.runs.resume(r.mapPath, { addBudget: 100 });
  s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.status, 'running');
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
  assert.equal(s.phase, 'done');
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
  assert.equal((await r.state()).phase, 'done');
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
  assert.equal((await r.state()).phase, 'done');
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
  await assertUnsafeBox(r, 1);
  const log = r.stat.logs.join('\n');
  assert.ok(log.includes('unsafe_body') && !/Secret|ok\.example|e\.example/.test(log));
  assert.match(log, /write_refused [^\n]*result=exit_check/, 'the log names the check that refused the write');
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
  await assertUnsafeBox(r, 1);
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
  assert.equal((await r.state()).phase, 'done');
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
  const r = await rig({ script: { card: request => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], ...((request.chapters.findIndex(c => c.title === request.card.title) + 1) === 2 ? { droppedSubjective: 2, droppedPicture: 1 } : {}) }) } });
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
    assert.match(section, /> - 作者模型：Label＜m2＞/); assert.match(section, /> - 校對模型：Label＜m2＞/); // the author's own self-check runs on the author model; the independent proofread is the proof model's
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
    card: request => ({ covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], ...((request.chapters.findIndex(c => c.title === request.card.title) + 1) === 2 ? { images } : (request.chapters.findIndex(c => c.title === request.card.title) + 1) === 3 ? { images: [] } : {}) }),
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
const writeAs = (r, seen) => async input => { seen.push([input.nodeId, input.instruction]); await input.admission.reserve(); const note = await r.repo.readNote(input.path); const out = await r.repo.updateNoteGuarded(input.path, { detail: input.requirements !== undefined ? fixOf(bodyOf(note.title)) : bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };

test('T4 autofix: an unmet fact is redone once by the author alone, after the card own first round; the reason goes to the author, never the plan or the proofread; the second verdict ends it', async () => {
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
  assert.equal(s.phase, 'done');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal(s.autoFixes[r.nodes[1].id], 1);
  assert.equal(s.autoFixes[r.nodes[0].id], undefined);
  assert.equal(r.stat.plan.filter(x => x === r.nodes[1].id).length, 1, 'no new plan: the plan and checklist stay');
  assert.ok(planSeen.every(x => x === undefined));
  assert.equal(seen.length, 4, 'three first rounds and one redo');
  assert.equal(seen.filter(([, instruction]) => instruction === undefined).length, 3, 'every card had exactly one first round');
  const redoAt = seen.findIndex(([, instruction]) => instruction !== undefined);
  assert.equal(seen.filter(([, instruction]) => instruction !== undefined).length, 1, 'exactly one redo');
  assert.equal(seen[redoAt][0], r.nodes[1].id);
  assert.ok(seen.findIndex(([id, instruction]) => id === r.nodes[1].id && instruction === undefined) < redoAt, 'the redo starts only after that card\'s own first round (not necessarily after the other cards\')');
  assert.match(seen[redoAt][1], /"a date \/ WRONGDATE"/);
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
  assert.equal(s.phase, 'done');
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
// The trial's gate 1 and the final gate pass by themselves now (the AI proofread is the check), so a test that needs the run parked at
// the trial's gate 1 puts the finished run back there: the trial chapters are the first `n`, the other cards keep what they were given.
const toTrialGate = (r, n = 3) => r.repo.updateMap(r.mapPath, d => { Object.assign(d.bookPipeline, { phase: 'gate1', status: 'running', trial: r.nodes.slice(0, n).map(x => x.id) }); delete d.bookPipeline.planReview; });
const T5_TITLES = ['T0', 'T1', 'T2', 'T3', 'T4'];
const trialRig = (over = {}) => {
  const models = { plan: 'm1', author: 'm2', proof: 'm3' };
  return rig({ trial: true, nested: true, titles: T5_TITLES, ...over, ports: { config: () => ({ planModel: models.plan, authorModel: models.author, imageModel: 'm4', proofModel: models.proof, reasoning: 'low', language: 'zh-TW' }), ...over.ports } }).then(r => ({ ...r, models }));
};

test('T5 trial: every card is planned, then only the first three are written and proofread before gate 1; after confirm the rest run and the trial cards get no more calls', async () => {
  const r = await trialRig();
  const trial = r.nodes.slice(0, 3).map(n => n.id);
  await r.runs.start(r.mapPath);
  let s = await r.state();
  same(s.trial, trial);
  assert.equal(s.phase, 'done'); assert.equal(s.status, 'running', 'the trial gate passes by itself: no owner step');
  same(r.stat.plan, ['global', ...r.nodes.map(n => n.id)], 'the whole book is planned before the trial is written');
  same(r.stat.author.slice(0, 3), trial, 'the trial chapters are written first');
  for (let i = 0; i < 5; i++) { assert.equal(stageOf(r.raw(i)), 'checked'); assert.ok((await r.note(i)).detail.includes(bodyOf(T5_TITLES[i]))); }
  s = await r.state();
  assert.equal(s.phase, 'done');
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
  await toTrialGate(r);
  same(r.stat.models, ['m2', 'm2', 'm2', 'm2', 'm2']);
  const planned = r.stat.plan.length, authored = r.stat.author.length, proofs = r.stat.proof.length, used = (await r.state()).budget.used;
  r.models.plan = 'n1'; r.models.author = 'n2'; r.models.proof = 'n3';
  await r.runs.retryTrial(r.mapPath); await idle(r);
  const s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.status, 'running');
  same(r.stat.plan.slice(planned), trial, 'the whole-book plan is not redone');
  same(r.stat.author.slice(authored), trial);
  assert.equal(r.stat.proof.length, proofs + 3);
  same(r.stat.models.slice(5), ['n2', 'n2', 'n2'], 'the new author model');
  same(planModels.slice(-3), ['n1', 'n1', 'n1'], 'the new plan model');
  assert.ok(r.stat.proof.slice(proofs).every(request => request.model === 'n2'), 'the self-check runs on the (new) author model');
  assert.equal(s.budget.used, used + 9);
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'checked');
  same([3, 4].map(i => r.raw(i)), outside);
  await assert.rejects(() => r.runs.retryTrial(r.mapPath), e => e.code === 'finished', 'the run is done: not at gate 1');
  await toTrialGate(r);
  await r.runs.retryTrial(r.mapPath); await idle(r);
  assert.equal(r.stat.author.length, authored + 6, 'a second retry runs the trial again');
});

// ---- Cover image review M-2: the trial retry and back-to-plan paths give a card's cover key back (one picture once per book) ----
test('cover key release: releasePictures frees a card\'s body picture keys and its cover key; retryTrial and backToPlan call it for every trial card that has a cover block', async () => {
  const blockLib = S.load('core/book-pipeline/cover-block.ts');
  const { imageKey: keyOf } = S.load('core/book-pipeline/image-dedupe.ts');
  const COVER_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/CoverX.jpg/1280px-CoverX.jpg';
  const BODY_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/BodyX.jpg/1280px-BodyX.jpg';
  const block = blockLib.composeCoverBlock('chapter', 'zh', { file: 'B/封面圖/x.png', url: COVER_URL, caption: 'c', sourceUrl: 'https://commons.wikimedia.org/wiki/File:CoverX.jpg' });
  const withCover = raw => blockLib.putCoverBlock(raw, block);
  // 1. the method itself
  const drive = { usedImages: new Set([keyOf(COVER_URL), keyOf(BODY_URL), 'other']) };
  BookPipelineRuns.prototype.releasePictures.call({}, drive, { raw: withCover('# T\n\nx\n'), detail: `text\n\n![b](${BODY_URL})\n` });
  assert.deepEqual([...drive.usedImages], ['other'], 'cover and body keys are gone, others stay');
  // 2. the two paths
  for (const path of ['retryTrial', 'backToPlan']) {
    const r = await trialRig({ planReview: path === 'backToPlan' });
    const released = [];
    const original = BookPipelineRuns.prototype.releasePictures;
    r.runs.releasePictures = function (drive, card) { released.push(blockLib.coverSourceKey(card.raw)); return original.call(this, drive, card); };
    await r.runs.start(r.mapPath);
    if (path === 'backToPlan') { await r.runs.startTrial(r.mapPath); await idle(r); } else await toTrialGate(r);
    await toTrialGate(r);
    for (let i = 0; i < 3; i++) r.contents.set(r.nodes[i].path, withCover(r.contents.get(r.nodes[i].path)));
    await r.runs[path](r.mapPath); await idle(r);
    assert.ok(released.filter(key => key === keyOf(COVER_URL)).length >= 3, `${path}: released the cover key of each of the 3 trial cards (${released.join('|')})`);
  }
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
  assert.equal(s.phase, 'done');
  assert.equal(r.stat.author.length, 2);
  assert.equal(r.stat.author.length, 2, 'nothing is written twice');
});

test('plan review: every chapter is planned, then the run waits for the owner before any chapter is written; "try" runs the trial to its gate 1', async () => {
  const r = await trialRig({ planReview: true });
  const trial = r.nodes.slice(0, 3).map(n => n.id);
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.planReview, true);
  same(r.stat.plan, ['global', ...r.nodes.map(n => n.id)], 'the whole book is planned');
  assert.equal(r.stat.author.length, 0, 'nothing is written at the plan review');
  await assert.rejects(() => r.runs.backToPlan(r.mapPath), e => e.code === 'not_gate1', 'already at the plan');
  await r.runs.startTrial(r.mapPath); await idle(r);
  s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.planReview, undefined);
  same(r.stat.author.slice(0, 3), trial, 'the trial is written first');
  same(r.stat.author, r.nodes.map(n => n.id), 'then the rest, each chapter once');
  await assert.rejects(() => r.runs.startTrial(r.mapPath), e => e.code === 'finished', 'the trial already ran');
});

test('plan review: "skip the trial" writes the whole book, each chapter once', async () => {
  const r = await trialRig({ planReview: true });
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.trial, undefined); assert.equal(s.planReview, undefined);
  same(r.stat.author, r.nodes.map(n => n.id));
  same(r.stat.plan, ['global', ...r.nodes.map(n => n.id)], 'nothing is planned again');
});

test('back to the plan: the trial chapters return to planned with their plans kept; the next trial writes them again without a new plan', async () => {
  const r = await trialRig({ planReview: true });
  const trial = r.nodes.slice(0, 3).map(n => n.id);
  await r.runs.start(r.mapPath);
  await r.runs.startTrial(r.mapPath); await idle(r);
  await toTrialGate(r);
  const prompts = [0, 1, 2].map(i => r.raw(i).match(/## Prompt[\s\S]*?(?=\n## |$)/)?.[0]);
  await r.runs.backToPlan(r.mapPath);
  let s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.planReview, true);
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'planned');
  same([0, 1, 2].map(i => r.raw(i).match(/## Prompt[\s\S]*?(?=\n## |$)/)?.[0]), prompts, 'the plans stay for the owner to edit');
  const planned = r.stat.plan.length;
  await r.runs.startTrial(r.mapPath); await idle(r);
  s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.planReview, undefined);
  assert.equal(r.stat.plan.length, planned, 'no chapter is planned again');
  same(r.stat.author, [...r.nodes.map(n => n.id), ...trial], 'the first trial wrote the book; the trial chapters are written again');
  for (let i = 0; i < 3; i++) assert.equal(stageOf(r.raw(i)), 'checked');
});

test('T5 trial: retry while a trial card is needs-review: its counters start over and it is tried again', async () => {
  let fail = true;
  const r = await trialRig({ script: { author: async (input) => { if (fail && input.nodeId === r0.id) throw new Error('boom'); await input.admission.reserve(); const note = await rr.repo.readNote(input.path); await rr.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } } });
  const rr = r; const r0 = { id: r.nodes[1].id };
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(s.phase, 'done', 'a trial card that needs a person does not hold the run');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal(s.attempts[r0.id].write, 3);
  fail = false;
  await toTrialGate(r);
  await r.runs.retryTrial(r.mapPath); await idle(r);
  s = await r.state();
  assert.equal(s.phase, 'done');
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
  assert.equal(s.phase, 'done'); assert.equal(s.status, 'running');
  for (let i = 0; i < 5; i++) assert.equal(stageOf(r.raw(i)), 'checked');
  assert.equal(r.stat.author.filter(id => id === r.nodes[0].id).length, 1, 'a card finished before the stop is not written again');
  assert.equal(r.stat.author.indexOf(r.nodes[3].id) > r.stat.author.indexOf(r.nodes[2].id), true, 'a card outside the trial is written after the trial');
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
  assert.equal((await r.state()).phase, 'done');
  // A run an older build left at gate 2 still holds there when stopped; continuing lets it finish by itself (no owner step).
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  s = await r.state();
  assert.deepEqual([s.phase, s.status], ['gate2', 'stopped']);
  await r.runs.resume(r.mapPath); await settle();
  s = await r.state();
  assert.deepEqual([s.phase, s.status], ['done', 'running'], 'continue finishes the old gate 2 by itself');
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
  assert.equal((await r.state()).phase, 'done');
  const atGate2 = spy.log.length;
  assert.ok(atGate2 > atGate1, 'writing then gate 2 asked again');
  assert.ok(spy.log.every(([, path]) => path === r.mapPath));
  // The review box is still the gate 2 box: a run an older build left at gate 2 redraws it after a rerun (a finished run has none yet).
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'gate2'; });
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id); await settle();
  assert.ok(spy.log.length > atGate2, 'a rerun at gate 2 redrew the box');
  // A finished run too: the AI box of the chapter that was run again follows its new result at once.
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'done'; });
  const atDone = spy.log.length;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id); await settle();
  assert.ok(spy.log.length > atDone, 'a rerun after the run finished redrew the box');
});
test('callouts: a throwing or rejecting port never stops the run', async () => {
  const r = await rig({ ports: { callouts: { reconcile: () => { throw new Error('x'); }, clear: async () => true } } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal((await r.state()).phase, 'done');
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
const { SKIP_MARK, REFUSED_MARK } = S.load('core/book-pipeline/notes-apply.ts');
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

// B33-y: the reader locks the chapter while the AI works; the answer must not reach the locked text (ai-flows §AI 鎖定).
test('apply notes (B33-y): a chapter ai-locked while the AI works is not written; refused as ai_locked with the locked notice, the notes stay', async () => {
  // The ui bundle carries its own copy of the error class: the refusal is rebuilt there from the code the runner threw.
  const ui = require('./support-replay.cjs').loadSource(`
export { bookRefusalText } from "./experiences/visual-map/book-pipeline-ui";
export { BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
`, { obsidian: S.obsidian });
  let locked;
  const r = await notesRig({ notes: async request => {
    await r.repo.writeAiLocked(r.nodes[1].path, true);
    locked = r.cardRaw();
    return reply(request);
  } });
  const used = (await r.state()).budget.used;
  let caught;
  await r.runs.applyNotes(r.mapPath, r.nodes[1].id).catch(error => { caught = error; });
  assert.ok(refusal('ai_locked')(caught), `refused as ai_locked: ${caught?.code ?? caught}`);
  assert.match(locked, /^ai-locked: true$/m);
  assert.equal(r.cardRaw(), locked, 'the locked chapter: not one byte changed after the lock');
  assert.ok(r.cardRaw().includes('%%備註#1') && !r.cardRaw().includes('Alpha BETA2 gamma.'), 'the note is still unapplied');
  assert.equal(r.calls.length, 1);
  assert.equal((await r.state()).budget.used, used + 1, 'the call was spent (it was made)');
  assert.ok(!(await r.note(0)).pipelineSeam && !(await r.note(2)).pipelineSeam, 'no seam is marked');
  assert.match(ui.bookRefusalText(new ui.BookPipelineRunError(caught.code)), /^(?:Topic is locked; AI will not change it|議題已鎖定，AI 不會修改)$/, 'the reader gets the locked notice');
  assert.equal(r.runs.isApplyingNotes(r.mapPath), false, 'the slot is released (can be tried again)');
});
test('apply notes (B33-y, control): with no lock the same answer is applied', async () => {
  const r = await notesRig({ notes: async request => reply(request) });
  const result = await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  assert.equal(result.applied, 1);
  assert.ok(r.cardRaw().includes('Alpha BETA2 gamma.') && !r.cardRaw().includes('%%備註#1'));
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

test('apply notes: a pre-aborted caller is refused before any map read, backup or model call', async () => {
  const r = await notesRig();
  const controller = new AbortController();
  controller.abort();
  const before = await r.state();
  const backupCount = r.stat.backups.length;
  const readMap = r.ports.readMap;
  let reads = 0;
  r.ports.readMap = (...args) => { reads++; return readMap(...args); };
  await assert.rejects(r.runs.applyNotes(r.mapPath, r.nodes[1].id, { signal: controller.signal }), refusal('cancelled'));
  assert.equal(reads, 0);
  assert.equal(r.stat.backups.length, backupCount);
  assert.equal(r.calls.length, 0);
  assert.equal((await r.state()).budget.used, before.budget.used);
  assert.equal(r.runs.isApplyingNotes(r.mapPath), false);
});

test('apply notes: cancellation while reading text prevents backup and model dispatch', async () => {
  const r = await notesRig();
  const entered = defer(), release = defer();
  const read = r.ports.notes.readText;
  r.ports.notes = { ...r.ports.notes, readText: async path => {
    entered.resolve();
    await release.promise;
    return read(path);
  } };
  const before = await r.state(), raw = r.cardRaw(), backupCount = r.stat.backups.length;
  const job = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const rejected = assert.rejects(job, refusal('cancelled'));
  await entered.promise;
  r.runs.cancelNotes(r.mapPath);
  release.resolve();
  await rejected;
  assert.equal(r.stat.backups.length, backupCount);
  assert.equal(r.calls.length, 0);
  assert.equal((await r.state()).budget.used, before.budget.used);
  assert.equal(r.cardRaw(), raw);
  assert.equal(r.runs.isApplyingNotes(r.mapPath), false);
});

test('apply notes: disposal during context read prevents model dispatch and budget use', async () => {
  const r = await notesRig();
  const entered = defer(), release = defer();
  const read = r.ports.readCard;
  r.ports.readCard = async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  };
  const before = await r.state(), raw = r.cardRaw();
  const job = r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  const rejected = assert.rejects(job, refusal('disposed'));
  await entered.promise;
  r.runs.dispose();
  release.resolve();
  await rejected;
  assert.equal(r.calls.length, 0);
  assert.equal((await r.state()).budget.used, before.budget.used);
  assert.equal(r.cardRaw(), raw);
  assert.equal(r.runs.isApplyingNotes(r.mapPath), false);
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

test('apply notes: a refused id is marked with the refusal mark, counted skipped, and left out of the undo record', async () => {
  const P2 = `Delta ${NW('eps', 2, 'longer')} zeta.`;
  const r = await notesRig({
    notes: async request => ({
      paragraphs: [{ id: request.items[0].id, text: 'Alpha BETA2 gamma.' }],
      refused: [{ id: request.items[1].id, reason: 'new list mark' }]
    })
  });
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${P1}\n\n${P2}` }, { authorize: () => true, finalize: c => c });
  const result = await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  assert.equal(result.applied, 1); assert.equal(result.skipped, 1);
  assert.ok(r.cardRaw().includes(`longer${REFUSED_MARK}%%`), 'the refused note carries the refusal mark');
  assert.ok(!r.cardRaw().includes(SKIP_MARK), 'not the changed-text mark');
  assert.ok(r.cardRaw().includes(P2.replace('longer%%', `longer${REFUSED_MARK}%%`)), 'the refused paragraph is otherwise untouched');
  assert.deepEqual(JSON.parse(JSON.stringify(result.edits.map(e => e.before))), [P1], 'the undo record leaves the refused paragraph out');
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
  assert.equal((await r.state()).phase, 'done');
  assert.ok(r.stat.logs.some(l => l.includes('hand_edit_skipped')));
});

// Owner decision 2026-11-20 (requirement change): a chapter with text and no record of any kind (no book-body record, no stored proof, no
// slots record) is no longer held as possibly edited; nothing says the reader touched it, so it is rewritten after the usual backup.
const noRecords = c => c.replace(/\n> <!-- book-body:v1 .*-->/, '').replace(/\n> <!-- book-proof:v1 .*-->/, '').replace(/\n> \[!vam-book\]- 校對結果（最新一次）(\n>.*)*/, '\n');
test('T9 unknown: an older chapter with text and no fingerprint (and no stored proof to vouch for it) is rewritable: a whole-book redo writes it (owner decision 2026-11-20)', async () => {
  const r = await rig();
  await finish(r);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, noRecords, {});
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors + 1, 'written');
  assert.equal((await r.note(1)).pipelineIssue, undefined);
  assert.ok(!r.stat.logs.some(l => l.includes('hand_edit_skipped')));
});

test('T9 no records: a chapter with no record and no older evidence is backed up first, then rewritten, and the rewrite stores its fingerprint', async () => {
  const r = await rig();
  await finish(r);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, noRecords, {});
  const before = r.raw(1);
  assert.equal(readBodyRecord(detailBlockOf(before)), undefined);
  const backups = r.stat.backups.length;
  const authorsBefore = r.stat.author.length;
  let backedUpFirst;
  const backupNote = r.ports.backupNote;
  r.ports.backupNote = async (path, raw) => { if (path === r.nodes[1].path) backedUpFirst ??= { authors: r.stat.author.length, raw }; return backupNote(path, raw); };
  await redo(r, [1]);
  assert.ok(r.stat.backups.slice(backups).includes(r.nodes[1].path), 'a backup of the chapter was made');
  assert.equal(backedUpFirst?.authors, authorsBefore, 'the backup came before the rewrite');
  assert.equal(detailBlockOf(backedUpFirst?.raw ?? ''), detailBlockOf(before), 'the backup holds the chapter text as it was');
  assert.equal(r.stat.author.at(-1), r.nodes[1].id, 'rewritten');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.ok(readBodyRecord(detailBlockOf(r.raw(1))).fp, 'the fingerprint is stored');
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
});

test('C7 never in a book: a card the pipeline never wrote that already has text (the reader\'s research) is not rewritten by the run: skipped with the hand-edit box, text kept; the empty cards are written', async () => {
  const r = await rig();
  const RESEARCH = '### 核心結論\n\n磨豆機每次用後乾刷，定期拆洗刀盤。這是讀者自己的研究正文，不是程式寫的。';
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: RESEARCH }, {});
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown', 'no pipeline evidence on the card');
  await finish(r);
  assert.ok(!r.stat.author.includes(r.nodes[1].id), 'not rewritten');
  assert.ok((await r.note(1)).detail.includes('這是讀者自己的研究正文'), 'the research text is kept');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited', 'held with the hand-edit review box');
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown', 'the plan fields the run wrote (book-role, pipeline-role, the stage) are no evidence');
  assert.ok(r.stat.author.includes(r.nodes[0].id) && r.stat.author.includes(r.nodes[2].id), 'the empty cards are written');
  // A second whole-book run holds it again: the skip left no pipeline evidence on it.
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'still not written');
  assert.ok((await r.note(1)).detail.includes('這是讀者自己的研究正文'));
});

test('T9 keep (review-b B1): keeping a note that has no record stays kept: a whole-book redo does not write it and the record holds no program fingerprint', async () => {
  const r = await rig();
  await finish(r);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, noRecords, {});
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'no record of any kind: rewritable (owner decision 2026-11-20)');
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

// An older build wrote the chapters: text, the stored proof and the slots record, but no book-body record (real vault case, 2026-11-20).
const olderBuild = c => c.replace(/\n> <!-- book-body:v1 .*-->/, '');
test('T9 older build: a chapter the program wrote before the fingerprint existed (stored proof still fits) is rewritten by a whole-book redo, after a backup', async () => {
  const r = await rig();
  await finish(r);
  for (let i = 0; i < 3; i++) await r.repo.updateNoteRawGuarded(r.nodes[i].path, olderBuild, {});
  assert.ok(detailBlockOf(r.raw(1)).startsWith('\n'), 'the stored Detail starts with a line break (the card reader trims it)');
  assert.equal(readBodyRecord(detailBlockOf(r.raw(1))), undefined);
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'the stored proof vouches for the text');
  const authors = r.stat.author.length;
  const backups = r.stat.backups.length;
  await redo(r, [0, 1, 2]);
  assert.equal(r.stat.author.length, authors + 3, 'every chapter was written again');
  assert.ok(r.stat.backups.length > backups, 'backed up before the rewrite');
  for (let i = 0; i < 3; i++) {
    assert.equal(stageOf(r.raw(i)), 'checked');
    assert.equal((await r.note(i)).pipelineIssue, undefined);
    assert.equal(bodyStateRaw(r.raw(i)), 'clean');
    assert.ok(readBodyRecord(detailBlockOf(r.raw(i))).fp, 'the rewrite stores the fingerprint');
  }
  assert.ok(!r.stat.logs.some(l => l.includes('hand_edit_skipped')));
});

test('T9 older build: a real hand edit on such a chapter is still seen (the stored proof no longer fits) and skipped', async () => {
  const r = await rig();
  await finish(r);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, olderBuild, {});
  await handEdit(r, 1);
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown');
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'not written');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: hand_edited');
  assert.ok((await r.note(1)).detail.includes(HAND));
});

test('T9 older build, open items: a chapter with an AIM open-items marker saved after its Detail (the card reader appends it, so the proof hashed it) still reads as untouched', async () => {
  const r = await rig();
  await finish(r);
  const marker = '<!-- aim-open-items ["check the second source"] -->';
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace('<!-- visual-agent-map:detail:end -->\n', `<!-- visual-agent-map:detail:end -->\n${marker}\n`), {});
  assert.ok(!detailBlockOf(r.raw(1)).includes(marker), 'the marker is outside the Detail block');
  assert.ok((await r.note(1)).detail.endsWith(marker), 'the card reader appends it to the Detail');
  // The proof step runs again on the Detail the card reader gives (marker included), so its stored hash covers the marker.
  await redo(r, [1], 'written');
  assert.equal(stageOf(r.raw(1)), 'checked');
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, olderBuild, {});
  assert.equal(readBodyRecord(detailBlockOf(r.raw(1))), undefined);
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'the stored proof vouches for the text');
  await handEdit(r, 1);
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown', 'a real hand edit is still seen');
});

test('T9 older build, stuck run: every chapter wrongly left needs-review hand_edited at gate 2 (with the review box) is rewritten after stop and restart', async () => {
  const r = await rig();
  await finish(r);
  const box = '> [!vam-review] 這章要你看\n> ・這章有你手改的內容，這次重跑沒有重寫它\n> - [ ] 保留我的版本\n> - [ ] 用 AI 重寫這章（會蓋掉你的修改，改前先備份）\n> %%vam-review:old-run:n:0ad38d4019197e76:op:54c47c406daba134%%\n> %%vam-callout-version:1%%\n';
  for (let i = 0; i < 3; i++) {
    await r.repo.updateNoteRawGuarded(r.nodes[i].path, c => olderBuild(c).replace('<!-- visual-agent-map:detail:start -->\n', `<!-- visual-agent-map:detail:start -->\n${box}`), {});
    await r.repo.writePipelineFields(r.nodes[i].path, { pipelineStage: 'needs-review', pipelineIssue: 'write failed: hand_edited' });
    assert.equal(bodyStateRaw(r.raw(i)), 'clean', `chapter ${i}: the program's box is not the reader's hand`);
  }
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.accepted = [...d.bookPipeline.order]; });
  assert.equal((await r.state()).phase, 'done');
  await r.runs.stop(r.mapPath, { saved: true });
  const authors = r.stat.author.length;
  await r.runs.start(r.mapPath, { restart: true });
  await confirmDone(r.runs, r.mapPath);
  await settle();
  assert.equal(r.stat.author.length, authors + 3, 'all three chapters rewritten');
  for (let i = 0; i < 3; i++) {
    assert.equal(stageOf(r.raw(i)), 'checked');
    assert.equal((await r.note(i)).pipelineIssue, undefined);
    assert.equal(bodyStateRaw(r.raw(i)), 'clean');
  }
  assert.ok(!r.stat.logs.some(l => l.includes('hand_edit_skipped') || l.includes('plan_skipped')));
});

// Live acceptance (2026-11-20): a chapter whose notes were applied read as hand-edited on the next whole-book rerun. Applying notes and
// undoing that apply are program writes; a review box (ticked, collapsed) is the program's own callout. None of them is the reader's hand.
const { stampRaw } = S.load('core/book-pipeline/body-integrity.ts');
async function stampedNotesRig(extra = '') {
  const r = await notesRig();
  const path = r.nodes[1].path;
  await r.repo.updateNoteRawGuarded(path, c => stampRaw(c.replace(P1, 'Alpha beta gamma.')), {});
  await r.repo.updateNoteRawGuarded(path, c => c.replace('Alpha beta gamma.', P1 + extra), {});
  return r;
}
test('T9 apply notes: the AI rewrite of an untouched chapter stores the new fingerprint, so it is not a hand edit', async () => {
  const r = await stampedNotesRig();
  assert.equal(bodyStateRaw(r.cardRaw()), 'clean', 'a note on the text is not an edit');
  const before = readBodyRecord(detailBlockOf(r.cardRaw())).fp;
  const result = await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  assert.equal(result.applied, 1);
  assert.ok(r.cardRaw().includes('Alpha BETA2 gamma.'));
  assert.notEqual(readBodyRecord(detailBlockOf(r.cardRaw())).fp, before, 'the fingerprint follows the AI rewrite');
  assert.equal(bodyStateRaw(r.cardRaw()), 'clean');
});
test('T9 apply notes: a chapter the reader had already edited stays hand-edited after an apply', async () => {
  const r = await stampedNotesRig(' HAND');
  assert.equal(bodyStateRaw(r.cardRaw()), 'edited');
  const fp = readBodyRecord(detailBlockOf(r.cardRaw())).fp;
  await r.runs.applyNotes(r.mapPath, r.nodes[1].id);
  assert.ok(r.cardRaw().includes('Alpha BETA2 gamma.'));
  assert.equal(readBodyRecord(detailBlockOf(r.cardRaw())).fp, fp, 'the record is left as it was');
  assert.equal(bodyStateRaw(r.cardRaw()), 'edited');
});
test('T9 review box: ticking "accept" and collapsing the review box is not a hand edit', async () => {
  const r = await rig();
  await finish(r);
  const box = '> [!vam-review]- 這章要你看\n> ・已修改，未重新校對\n> - [x] 接受現在這樣，不用改\n> - [ ] 我改好了\n> %%vam-review:run:n:f653b1e7e2b15838%%\n';
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace('<!-- visual-agent-map:detail:start -->\n', `<!-- visual-agent-map:detail:start -->\n${box}\n`), {});
  assert.ok(r.raw(1).includes('- [x] 接受現在這樣'));
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
});

const TODO_AFTER = c => c.replace('<!-- visual-agent-map:detail:end -->\n', '<!-- visual-agent-map:detail:end -->\n<!-- aim-open-items ["check the second source"] -->\n');
test('T9 keep, open items: a kept chapter with an AIM open-items marker saved after its Detail stays kept (same fingerprint from the card reader and the raw block)', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, TODO_AFTER, {});
  assert.ok((await r.note(1)).detail.includes('aim-open-items'), 'the card reader appends the marker');
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'not written');
  assert.ok(r.stat.logs.some(l => l.includes('hand_edit_kept')));
  assert.ok(!r.stat.logs.some(l => l.includes('hand_edit_skipped')));
  assert.ok((await r.note(1)).detail.includes(HAND));
});
test('T9 keep: "keep my version" makes a whole-book redo leave the chapter alone; it is checked with no proofread call (the reader\'s answer is final)', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  const before = detailBlockOf(r.raw(1));
  const authors = r.stat.author.length;
  const proofs = r.stat.proof.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'not written');
  assert.equal(r.stat.proof.length, proofs, 'no proofread call: the kept text is not judged again');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal((await r.note(1)).pipelineIssue, undefined, 'no issue left');
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

test('accept as it is (Primary decision C3): a program chapter recorded as kept is left alone by a whole-book redo and checked; the card\'s own rerun still rewrites it', async () => {
  const r = await rig();
  await finish(r);
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  const before = detailBlockOf(r.raw(1));
  const authors = r.stat.author.length;
  await redo(r, [1]);
  assert.equal(r.stat.author.length, authors, 'the whole-book redo does not write the accepted chapter');
  assert.equal(detailBlockOf(r.raw(1)), before, 'its text is unchanged');
  assert.equal(stageOf(r.raw(1)), 'checked');
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'running'; });
  await rerun(r, 1);
  assert.equal(r.stat.author.length, authors + 1, 'the card\'s own rerun (the reader asked) rewrites it');
  assert.notEqual(detailBlockOf(r.raw(1)), before);
});

test('seams: a whole-book redo writes every chapter beside its neighbours again, so the join marks an earlier single-card rerun left are cleared', async () => {
  const r = await rig();
  await finish(r);
  await rerun(r, 1);
  const seam = i => /^pipeline-seam: (.*)$/m.exec(r.raw(i))?.[1];
  assert.ok(seam(0) !== undefined && seam(2) !== undefined, 'the single rerun marked both neighbours');
  await redo(r, [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map(seam), [undefined, undefined, undefined], 'all stale join marks are gone');
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

test('T9 own Summary: a rewrite the reader allowed of a kept chapter, or of text that was there before the book, keeps the reader\'s Summary (no plan summary, author keepSummary); a program chapter still gets a new one', async () => {
  const r = await rig();
  await r.repo.updateNote(r.nodes[2].path, { detail: 'MY OWN TEXT from before the book.', summary: 'BEFORE SUMMARY' });
  const seen = [];
  const base = r.script.author;
  r.script.author = async (input, n) => { seen.push({ id: input.nodeId, keepSummary: input.keepSummary }); return base(input, n); };
  await finish(r);
  assert.equal((await r.note(2)).pipelineIssue, 'write failed: hand_edited', 'the before-book text was skipped');
  assert.equal((await r.note(2)).summary, 'BEFORE SUMMARY');
  assert.equal(seen.find(c => c.id === r.nodes[0].id).keepSummary, undefined, 'a program chapter: the summary is replaced');
  assert.match((await r.note(0)).summary, /^covers /, 'the plan writes a program chapter\'s summary');
  // chapter 1: the reader edits text and Summary, keeps it, then asks for a rewrite
  await handEdit(r, 1);
  await r.repo.updateNote(r.nodes[1].path, { summary: 'KEPT SUMMARY' });
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  for (const [i, own] of [[1, 'KEPT SUMMARY'], [2, 'BEFORE SUMMARY']]) {
    seen.length = 0;
    await r.runs.rerunCard(r.mapPath, r.nodes[i].id, { overwrite: { operation: `op-${i}`, fingerprint: integrityFpRaw(r.raw(i)) } });
    while (r.runs.isRunning(r.mapPath)) await tick();
    await settle();
    assert.deepEqual(seen.map(c => [c.id, c.keepSummary]), [[r.nodes[i].id, true]], `chapter ${i}: written once with keepSummary`);
    assert.equal((await r.note(i)).summary, own, `chapter ${i}: the reader's Summary stays`);
    assert.match((await r.note(i)).prompt, /covers/, `chapter ${i}: the plan was written`);
  }
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

test('proof: the proofread gets the whole-book points and the chapter list (titles, covers lines) in reading order; a whole-book point unmet needs review and its note reaches the one auto-fix', async () => {
  const seen = [];
  const requests = [];
  const r = await rig({ script: { ...factCard, proof: async request => { requests.push(request); return unjudged(request, request.body.includes(TITLES[1]) && requests.filter(q => q.body.includes(TITLES[1])).length === 1 ? { V1: 'unmet' } : {}); }, author: input => writeAs(r, seen)(input) } });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const first = requests[0];
  assert.equal(first.checklist.slice(-3).map(c => c.id).join(), 'N1,V1,R1');
  assert.equal(first.chapters.map(c => c.title).join(), TITLES.join());
  assert.ok(first.chapters.every(c => c.covers === 'c'), 'each chapter\'s covers line from its Prompt');
  const redo = seen.filter(([, instruction]) => instruction !== undefined);
  assert.equal(redo.length, 1);
  assert.match(redo[0][1], /note V1/);
  assert.equal(stageOf(r.raw(1)), 'checked', 'the re-proof passed');
});

test('T10a proof: a mixed fact and structure failure puts both in the one auto-fix request; a partly unmet structure with met facts needs review after its one auto-fix, with the point in the issue', async () => {
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
  // Live re-verify: "structure unmet: C4" ended checked. Any unmet point now needs review once the one auto-fix is spent.
  assert.equal(stageOf(p.raw(1)), 'needs-review');
  assert.equal((await p.state()).autoFixes[p.nodes[1].id], 1);
  assert.equal((await p.note(1)).pipelineIssue, 'proof unmet: C1');
});

// ---- T10c: the length rule (Bug3) and the card-plan request (Bug4) ----
const LEN_SETTING = '每章 100–200 字';
const lenRig = async (over = {}, setting = LEN_SETTING) => {
  const r = await rig(over);
  if (setting !== null) await r.repo.writeBookSettings(r.nodes[0].path, { length: setting });
  return r;
};
const longBody = (title, n) => `${bodyOf(title)} ${'好'.repeat(n)}`;
/** An author that writes `first` characters, then (the one automatic redo, in place) replaces that text with `later` characters. */
const lengthAuthor = (r, seen, first, later) => async input => {
  seen.push([input.nodeId, input.instruction]);
  await input.admission.reserve();
  const note = await r.repo.readNote(input.path);
  const detail = input.requirements !== undefined ? fixOf(longBody(note.title, first), longBody(note.title, later)) : longBody(note.title, first);
  const out = await r.repo.updateNoteGuarded(input.path, { detail }, { authorize: input.authorize, finalize: input.finalize });
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

test('T10c length: a chapter that is too short is asked for new text in change blocks; a failed fact and the length together keep both in the issue and in the one instruction', async () => {
  const under = [];
  const a = await lenRig();
  a.script.author = lengthAuthor(a, under, 10, 10);
  await a.runs.start(a.mapPath); await confirmDone(a.runs, a.mapPath);
  assert.match(under.find(([id, instruction]) => id === a.nodes[1].id && instruction !== undefined)[1], /add about \d+ 字 of new text in @@insert blocks/);
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

test('R trial fix: a trial chapter still too short after its one redo gets no second fix round (gate 1 passes by itself; nobody read the trial); the log names why the author is called', async () => {
  const seen = [];
  const r = await lenRig({ trial: true });
  r.script.author = lengthAuthor(r, seen, 10, 10);
  await r.runs.start(r.mapPath);
  while (r.runs.isRunning(r.mapPath)) await new Promise(resolve => setImmediate(resolve));
  const id = r.nodes[1].id;
  assert.ok((await r.state()).trial.includes(id), 'the chapter is in the trial');
  const fixes = () => seen.filter(([at, instruction]) => at === id && instruction !== undefined).length;
  assert.equal((await r.state()).phase, 'done');
  assert.equal(fixes(), 1, 'the one redo only: no second round after the trial');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  const log = r.stat.logs.join('\n');
  assert.match(log, new RegExp(`author_call [^\\n]*card=${id} [^\\n]*result=first_draft`));
  assert.equal(log.split('\n').filter(line => line.includes('author_call') && line.includes(`card=${id} `) && line.includes('result=fix_round')).length, 1);
});

test('W trial (live v6 〈土壤〉): the reasons a trial chapter had survive to gate 2 beside a failed fix (author_failed); the box names both', async () => {
  const seen = [];
  const r = await lenRig({ trial: true, planReview: true, script: { ...factCard, proof: async request => verdictOf(request, 'unmet', 'WRONGDATE') } });
  const id = r.nodes[1].id;
  const write = lengthAuthor(r, seen, 10, 10);
  r.script.author = async input => {
    if (input.nodeId === id && input.requirements !== undefined) {
      seen.push([input.nodeId, input.instruction]);
      return { outcome: 'failed', reason: 'author_failed' };
    }
    return write(input);
  };
  await r.runs.start(r.mapPath); await idle(r);
  await r.runs.startTrial(r.mapPath); await idle(r);
  assert.equal((await r.state()).phase, 'done');
  assert.equal(seen.filter(([at, instruction]) => at === id && instruction !== undefined).length >= 1, true, 'the fix round ran and failed');
  const issue = (await r.note(1)).pipelineIssue;
  assert.match(issue, /^write failed: author_failed \+ /); assert.match(issue, /C2/); assert.match(issue, /length:under/);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  const problems = (await boxReasons(r, 1)).map(p => p.text).join(' / ');
  assert.match(problems, /writing call failed/, problems); assert.match(problems, /WRONGDATE/, problems); assert.match(problems, /shorter than the 100–200/, problems);
});

// The expansion of a too-short chapter: the one redo sees the chapter and returns change blocks; the program puts them in.
const DRAFT = ['## 開場', '', '開場段落。', '', '### 土壤', '', '土壤段落。', '', '### 小結', '', '結尾一句，帶到下一章。'].join('\n');
const expandAuthor = (r, seen, answer) => async input => {
  seen.push(input);
  await input.admission.reserve();
  const fix = input.requirements !== undefined;
  const out = await r.repo.updateNoteGuarded(input.path, { detail: fix ? answer : DRAFT }, { authorize: input.authorize, finalize: input.finalize });
  return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
};

test('expand cap: an answer with more than 3 new sections keeps the first 3, drops the rest and logs how many', async () => {
  const seen = [];
  const r = await lenRig();
  const section = name => [`### ${name}`, '', `${name}段落${'好'.repeat(40)}`, ''];
  const answer = ['@@insert after: ### 土壤', ...section('甲節'), ...section('乙節'), ...section('丙節'), ...section('丁節')].join('\n');
  r.script.author = async input => expandAuthor(r, seen, input.nodeId === r.nodes[1].id ? answer : DRAFT + '\n\n' + '好'.repeat(150))(input);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes('### 丙節') && !detail.includes('### 丁節'));
  assert.match(r.stat.logs.join('\n'), new RegExp(`expand_capped [^\\n]*card=${r.nodes[1].id} [^\\n]*dropped=1`));
});

test('T10c length expand: the one redo of a too-short chapter gets the chapter text and the missing amount; the blocks land after their heading and before the ending; the chapter reaches the range with no extra call', async () => {
  const seen = [];
  const r = await lenRig();
  const added = '好'.repeat(140);
  const answer = ['@@insert after: ### 土壤', '### 排水', '', `排水段落${added}`, '@@replace', '土壤段落。', '@@with', '土壤段落（已更正）。'].join('\n');
  r.script.author = async input => expandAuthor(r, seen, input.nodeId === r.nodes[1].id ? answer : DRAFT + '\n\n' + '好'.repeat(150))(input);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const calls = seen.filter(input => input.nodeId === r.nodes[1].id);
  assert.equal(calls.length, 2, 'first draft plus the one redo: no extra call');
  const fix = calls[1];
  assert.equal(fix.requirements.includes('<<<CHAPTER\n## 開場'), true, 'the redo sees the chapter it adds to');
  assert.match(fix.requirements, /the chapter text is \d+ characters \(字\), short of the asked 100 to 200/);
  assert.match(fix.requirements, /Write about \d+ characters \(字\) of new text/);
  assert.match(fix.requirements, /add about \d+ 字 of new text in @@insert blocks/, 'the point list rides along, last');
  assert.deepEqual([...fix.slots], [], 'no picture markers asked for');
  const detail = (await r.note(1)).detail;
  const at = name => detail.indexOf(name);
  assert.ok(at('土壤段落（已更正）。') > at('### 土壤'), detail);
  assert.ok(at('### 排水') > at('土壤段落（已更正）。') && at('### 排水') < at('### 小結'), 'inserted at the end of its section');
  assert.ok(at('結尾一句') > at(added), 'the ending stays last');
  assert.ok(!detail.includes('@@'), 'no block line is left');
  assert.ok(!detail.includes('土壤段落。'), 'the replaced passage is gone');
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal((await r.note(1)).pipelineIssue ?? '', '');
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'the merged text carries the program\'s fingerprint');
});

test('T10c length expand: a fact failure beside the length keeps the fact points (first) in the redo; an answer with no block lines is never put in (no rewrite): the chapter stays, needs-review with fix_no_edits', async () => {
  const seen = [];
  const r = await lenRig({ script: { ...factCard, proof: async request => verdictOf(request, 'unmet', 'WRONGDATE') } });
  r.script.author = expandAuthor(r, seen, '新增的一段，沒有區塊行。');
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const fix = seen.filter(input => input.nodeId === r.nodes[1].id)[1];
  assert.ok(fix, 'the one redo ran');
  assert.ok(fix.requirements.indexOf('WRONGDATE') > fix.requirements.indexOf('CHAPTER>>>'), 'the points follow the chapter data');
  assert.ok(fix.requirements.indexOf('WRONGDATE') < fix.requirements.indexOf('add about'), 'facts before the length');
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes('開場段落。') && detail.includes('結尾一句') && !detail.includes('新增的一段'), detail);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  // Contract change W (live v6): the failed fix keeps the reasons the chapter had (here the fact point and the length).
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: fix_no_edits + proof unmet: C2 length:under:23:100-200:字:v2');
});

test('expansionUnsafe: only what the merged chapter adds is checked; a second copy of an old record line, a new tag, a picture outside old ∪ answer or a slot marker the answer did not have is refused', () => {
  const proof = '> <!-- book-proof:v1 {"a":1} -->';
  const old = ['## 開場', '', '開場段落。', '', '![a](https://example.org/a.png)', '', '> [!vam-book]- 研究備註', proof].join('\n');
  const answer = new Set(['〔圖位 1：x〕']);
  const allowed = new Set(['https://example.org/a.png', 'https://example.org/new.png']);
  const add = text => old.replace('開場段落。', `開場段落。\n\n${text}`);
  assert.equal(expansionUnsafe(old, old, answer, allowed), false, 'the old chapter as it was');
  assert.equal(expansionUnsafe(add('新段落。\n\n![n](https://example.org/new.png)'), old, answer, allowed), false, 'new text and an answer picture');
  assert.equal(expansionUnsafe(add('![a](https://example.org/a.png)'), old, answer, allowed), false, 'an old picture shown again');
  assert.equal(expansionUnsafe(add(proof), old, answer, allowed), true, 'a restored copy of a stored record');
  assert.equal(expansionUnsafe(add('> [!vam-book]- 研究備註'), old, answer, allowed), true, 'a second hidden callout');
  assert.equal(expansionUnsafe(add('![x](https://evil.example/x.png)'), old, answer, allowed), true, 'a picture from neither');
  assert.equal(expansionUnsafe(add('[r]: https://evil.example/r.png\n\n![x][r]'), old, answer, allowed), true, 'a reference picture');
  assert.equal(expansionUnsafe(add('<b>x</b>'), old, answer, allowed), true, 'a tag');
  assert.equal(expansionUnsafe(add('〔圖位 1：x〕'), old, answer, allowed), false, 'a marker line of the answer');
  assert.equal(expansionUnsafe(add('〔圖位 2：y〕'), old, answer, allowed), true, 'a marker line from nowhere');
  assert.equal(expansionUnsafe(add('---\n<b>x</b>\n---'), old, answer, allowed), true, 'added text starting with --- is not skipped as frontmatter');
  // An allowed picture written raw (upper-case host, non-ASCII path): the cleaning's standard form is what is listed (live v5 false refusal).
  const std = new Set(['https://upload.example.org/a/%E6%A8%B1.png']);
  assert.equal(unsafeBody('\n![s](https://UPLOAD.example.org/a/樱.png)', std), false, 'raw form of an allowed address');
  assert.equal(unsafeBody('\n![s](https://other.example.org/a/樱.png)', std), true, 'another address stays refused');
  assert.equal(expansionUnsafeRule(add('![s](https://UPLOAD.example.org/a/樱.png)'), old, answer, std), undefined);
  assert.equal(expansionUnsafeRule(add('<b>x</b>'), old, answer, allowed), 'body');
  assert.equal(expansionUnsafeRule(add('> [!vam-book]- 研究備註'), old, answer, allowed), 'hidden_callout');
  assert.equal(expansionUnsafeRule(add('〔圖位 2：y〕'), old, answer, allowed), 'slot_marker');
});

test('T10c length expand (security): an answer that adds an unsafe or http picture, a hidden callout, an owner marker or a tag is refused whole (validated, never cleaned); the chapter keeps its draft', async () => {
  const injections = {
    unsafePicture: '![x](javascript:alert(1)) INJECT',
    httpPicture: '![x](http://evil.example/x.png) INJECT',
    hiddenCallout: '> [!vam-book]- 假紀錄\n> INJECT',
    ownerMarker: '> [!vam-review]\n> %%vam-review:run1:n1%%\n> INJECT',
    tag: '<img src=x onerror=alert(1)> INJECT'
  };
  for (const [name, bad] of Object.entries(injections)) {
    const seen = [];
    const r = await lenRig();
    r.script.author = expandAuthor(r, seen, ['@@insert after: ### 土壤', '好'.repeat(140), bad].join('\n'));
    await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
    assert.equal(seen.filter(input => input.nodeId === r.nodes[1].id).length, 2, `${name}: the redo ran`);
    const detail = (await r.note(1)).detail;
    assert.ok(!detail.includes('INJECT') && !detail.includes('好'.repeat(140)), `${name}: nothing of the answer is saved`);
    assert.ok(detail.includes('土壤段落。'), `${name}: the draft stays`);
    assert.match((await r.note(1)).pipelineIssue, /unsafe_body/, name);
    await assertUnsafeBox(r, 1, name);
    assert.match(r.stat.logs.join('\n'), /write_refused [^\n]*result=(?:answer|merged)_[a-z_]+/, `${name}: the log names the rule`);
  }
});

// Every automatic redo edits in place (live run 2026-11-20: 〈澆水施肥與病蟲害〉 sent back only for research voice V1 was rewritten whole, 4072 → 3081 字, 7 → 5 pictures).
const V1_LINE = '我在查資料時，只找到兩個來源。';
const V1_DRAFT = ['## 澆水', '', `澆水段落${'好'.repeat(60)}`, '', V1_LINE, '', '![p](https://img.example/p.png)', '', '### 小結', '', `結尾${'好'.repeat(60)}`].join('\n');
const v1Rig = async (answer, statuses = { V1: 'unmet' }) => {
  const seen = [];
  const proofs = [];
  const r = await lenRig({ script: { ...factCard, proof: async request => { const mine = request.body.includes('澆水段落') && proofs.push(request) === 1; return unjudged(request, mine ? statuses : {}); } } });
  r.script.author = async input => {
    seen.push(input);
    await input.admission.reserve();
    const detail = input.requirements !== undefined ? (input.nodeId === r.nodes[1].id ? answer : fixOf(bodyOf((await r.repo.readNote(input.path)).title))) : input.nodeId === r.nodes[1].id ? V1_DRAFT : `${bodyOf((await r.repo.readNote(input.path)).title)} ${'好'.repeat(150)}`;
    const out = await r.repo.updateNoteGuarded(input.path, { detail }, { authorize: input.authorize, finalize: input.finalize });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  };
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  return { r, fix: seen.filter(input => input.nodeId === r.nodes[1].id)[1], detail: (await r.note(1)).detail };
};

test('fix in place: a chapter sent back only for research voice (V1) gets a correction request with the chapter as data; the @@replace changes that line only, length and picture stay', async () => {
  const { r, fix, detail } = await v1Rig(['@@replace', V1_LINE, '@@with', '常見的做法有兩種。'].join('\n'));
  assert.ok(fix, 'the one redo ran');
  assert.match(fix.requirements, /^Correction \(hard requirement; this run edits the chapter below in place, it does not rewrite it\)/);
  assert.match(fix.requirements, /at least 100 characters/, 'the minimum is named');
  assert.ok(fix.requirements.includes(`<<<CHAPTER\n## 澆水`) && fix.requirements.includes(V1_LINE), 'the redo sees the chapter it edits');
  assert.match(fix.instruction ?? fix.requirements, /note V1/);
  assert.equal(fix.keepSummary, true);
  assert.deepEqual([...fix.slots], []);
  assert.ok(!detail.includes(V1_LINE) && detail.includes('常見的做法有兩種。'), detail);
  assert.ok(detail.includes('![p](https://img.example/p.png)') && detail.includes(`澆水段落${'好'.repeat(60)}`) && detail.includes(`結尾${'好'.repeat(60)}`), 'the rest of the chapter and its picture stay');
  assert.equal(stageOf(r.raw(1)), 'checked');
});

test('fix in place: a V1-only redo answered with a whole shorter chapter and no blocks is never put in: the chapter, its length and its picture stay; needs-review with fix_no_edits', async () => {
  const { r, detail } = await v1Rig(['## 澆水', '', '重寫的短章。'].join('\n'));
  assert.ok(detail.includes(V1_LINE) && detail.includes('![p](https://img.example/p.png)') && !detail.includes('重寫的短章'), detail);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  // Contract change W: the V1 reason stays beside the failure.
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: fix_no_edits + proof unmet: V1');
});

test('fix in place: a redo whose blocks would drop a placed picture or cut the chapter below the minimum is refused whole (fix_lost_text); the chapter stays', async () => {
  for (const answer of [
    ['@@replace', '![p](https://img.example/p.png)', '@@with', ''].join('\n'),
    ['@@replace', `澆水段落${'好'.repeat(60)}`, '@@with', '短。', '@@replace', `結尾${'好'.repeat(60)}`, '@@with', '尾。'].join('\n')
  ]) {
    const { r, detail } = await v1Rig(answer);
    assert.equal(detail.includes('![p](https://img.example/p.png)') && detail.includes(`澆水段落${'好'.repeat(60)}`) && detail.includes(V1_LINE), true, answer);
    assert.equal((await r.note(1)).pipelineIssue, 'write failed: fix_lost_text + proof unmet: V1', answer);
  }
});

test('fix in place: mixed reasons (a fact, research voice and too long) ask for change blocks in one request; @@replace blocks fix the lines and shorten', async () => {
  const long = `澆水段落${'好'.repeat(60)}`;
  // The shorter passage keeps the chapter at the minimum (after the fix round the minimum itself holds; see the strict length test).
  const shorter = `澆水段落，早晚各一次${'好'.repeat(20)}。`;
  const { r, fix, detail } = await v1Rig(['@@replace', V1_LINE, '@@with', '常見的做法有兩種。', '@@replace', long, '@@with', shorter].join('\n'), { V1: 'unmet', C2: 'unmet' });
  assert.ok(fix);
  assert.match(fix.instruction, /failed the fact check on these points \(JSON strings; correct each with a @@replace block/);
  assert.match(fix.instruction, /note V1/);
  assert.doesNotMatch(fix.instruction, /rewrite the chapter/);
  assert.match(fix.requirements, /^Correction/);
  assert.ok(!detail.includes(V1_LINE) && !detail.includes(long) && detail.includes(shorter) && detail.includes('![p](https://img.example/p.png)'), detail);
  assert.equal(stageOf(r.raw(1)), 'checked');
});

test('fix in place: an expansion line that echoes the request is dropped (the live run\'s exact line, and a copied instruction sentence); the new paragraph goes in', async () => {
  const seen = [];
  const r = await lenRig();
  const echoed = '（本章結構以既有標題為準，以下新增段落接在章節正文各處；若找不到對應標題，請放在結語之前。）';
  const added = `排水段落${'好'.repeat(140)}`;
  r.script.author = expandAuthor(r, seen, ['@@insert after: ### 土壤', echoed, '', added, '', 'Keep the chapter\'s voice and terms.'].join('\n'));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const fix = seen.filter(input => input.nodeId === r.nodes[1].id)[1];
  assert.ok(fix.requirements.includes('Keep the chapter\'s voice and terms.'), 'the sentence was in the request');
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes(added), detail);
  assert.ok(!detail.includes('本章結構以既有標題為準') && !detail.includes('voice and terms'), detail);
});

test('fix in place (live v4): a process note the expansion leaves in is deleted by the program; the redo is told the role and the other chapters as "do not cover"', async () => {
  const seen = [];
  const r = await lenRig();
  const note = '至於一天中什麼時候採，現有資料不足，我沒有查到可靠的官方建議，所以這裡只分享常見的家庭做法，請當作參考。';
  const kept = `很多人習慣在早上或傍晚採葉菜${'好'.repeat(140)}。`;
  r.script.author = expandAuthor(r, seen, ['@@insert after: ### 土壤', '### 採收時間', '', note + kept].join('\n'));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const fix = seen.filter(input => input.nodeId === r.nodes[1].id)[1];
  assert.match(fix.requirements, /This chapter's role: /);
  assert.match(fix.requirements, /Do not cover \(each has its own chapter; JSON strings\): "/);
  assert.ok(!fix.requirements.includes(`Do not cover (each has its own chapter; JSON strings): ${JSON.stringify((await r.note(1)).title)}`), 'its own title is not listed');
  const detail = (await r.note(1)).detail;
  assert.ok(!detail.includes('現有資料不足') && !detail.includes('沒有查到') && detail.includes(kept) && detail.includes('### 採收時間'), detail);
});

test('T10c length v2 (200-300): captions never count; 319 prose with a caption (366 in all) is checked with no fix, and a fix that lands at 320 prose stays needs-review (strict maximum)', async () => {
  const seen = [];
  const r = await lenRig({}, '每章 200–300 字');
  const figure = `![P1](https://upload.wikimedia.org/wikipedia/commons/a/ab/P1.jpg)\n${'圖'.repeat(47)}`;
  const first = { [r.nodes[0].id]: 250, [r.nodes[1].id]: 400, [r.nodes[2].id]: 319 };
  r.script.author = async input => {
    seen.push([input.nodeId, input.requirements]);
    await input.admission.reserve();
    const line = '好'.repeat(first[input.nodeId]);
    const detail = input.requirements !== undefined ? fixOf(line, '好'.repeat(320)) : `${line}\n\n${figure}`;
    const out = await r.repo.updateNoteGuarded(input.path, { detail }, { authorize: input.authorize, finalize: input.finalize });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  };
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal(seen.filter(([id, req]) => id === r.nodes[2].id && req !== undefined).length, 0, '319 prose: no fix round');
  assert.equal(stageOf(r.raw(2)), 'checked');
  assert.equal((await r.note(2)).pipelineIssue ?? '', '');
  assert.equal(seen.filter(([id, req]) => id === r.nodes[1].id && req !== undefined).length, 1, 'one fix round for the long chapter');
  assert.ok((await r.note(1)).detail.includes('圖'.repeat(47)), 'the picture stayed through the fix');
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.equal((await r.note(1)).pipelineIssue, 'length unmet: length:over:320:200-300:字:v2');
});

test('T10c length (strict after the fix round): an expansion that lands between 0.8x and the minimum is not silently accepted: needs-review with the length reason; the redo asked for the minimum at least', async () => {
  const seen = [];
  const r = await lenRig();
  r.script.author = expandAuthor(r, seen, ['@@insert after: ### 土壤', '### 排水', '', `排水段落${'好'.repeat(58)}`].join('\n'));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const fix = seen.filter(input => input.nodeId === r.nodes[1].id)[1];
  assert.match(fix.requirements, /never less than \d+ characters \(字\) \(the whole chapter must reach at least 100 characters \(字\)/);
  assert.ok((await r.note(1)).detail.includes('### 排水'), 'the expansion was put in');
  const issue = (await r.note(1)).pipelineIssue;
  const m = /length:under:(\d+):100-200/.exec(issue);
  assert.ok(m && Number(m[1]) >= 80 && Number(m[1]) < 100, issue);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
});

// Extra expand passes (live v5: one expand adds about 1.4–2.2k characters whatever is asked): an author whose every fix call adds one new section.
const passAuthor = (r, seen, adds) => async input => {
  seen.push(input);
  await input.admission.reserve();
  const mine = seen.filter(call => call.nodeId === input.nodeId).length;
  const n = adds(mine - 1, input.nodeId);
  const fix = input.requirements !== undefined;
  const answer = n ? ['@@insert after: ### 土壤', `### 新節${n}`, '', `新節段落${'好'.repeat(n)}`].join('\n') : '@@insert after: ### 土壤\n本次無新增內容。';
  const out = await r.repo.updateNoteGuarded(input.path, { detail: fix ? answer : DRAFT }, { authorize: input.authorize, finalize: input.finalize });
  return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
};

test('expand passes: two short chapters still under the minimum after the fix round get extra expand passes until they reach it; every call is within the estimate and logged', async () => {
  const seen = [];
  const r = await lenRig();
  r.script.author = passAuthor(r, seen, (call, id) => (id === r.nodes[0].id ? 150 + call : 20 + call));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const { MAX_AUTO_FIXES, BOOK_EXPAND_PASSES } = S.load('core/book-pipeline/model.ts');
  const log = r.stat.logs.join('\n');
  for (const at of [1, 2]) {
    const id = r.nodes[at].id;
    const calls = seen.filter(input => input.nodeId === id);
    assert.equal(calls.length, 4, 'first draft, the fix round and two expand passes');
    assert.ok(calls.length <= 1 + MAX_AUTO_FIXES + BOOK_EXPAND_PASSES, 'within the estimate');
    assert.match(calls[3].requirements, /Expansion \(hard requirement/);
    assert.ok(calls[3].requirements.includes('### 新節22'), 'the pass sees the chapter as the passes before left it');
    assert.equal(calls[3].instruction, undefined, 'the fix points are not asked again');
    const detail = (await r.note(at)).detail;
    for (const n of [21, 22, 23]) assert.ok(detail.includes(`### 新節${n}`), detail);
    assert.equal(stageOf(r.raw(at)), 'checked', `chapter ${at} reached the minimum`);
    assert.equal(log.split('\n').filter(line => line.includes('author_call') && line.includes(`card=${id} `) && line.includes('result=expand_pass')).length, 2);
    assert.match(log, new RegExp(`expand_merge [^\\n]*card=${id} [^\\n]*result=written [^\\n]*pass=2 requested=\\d+ parsed=1 applied=1 [^\\n]*net=\\d+`));
  }
});

// Contract change X (live v6): a pass with no usable block no longer ends the passes; the next one (while any is left) asks again with BOOK_EXPAND_RETRY_INSTRUCTION.
test('expand passes: a pass that adds nothing is asked once more with the retry request (X), then the cap ends the passes; the chapter keeps what it has and needs review with the length reason', async () => {
  const seen = [];
  const r = await lenRig();
  r.script.author = passAuthor(r, seen, (call, id) => (id === r.nodes[1].id ? (call === 1 ? 30 : 0) : 150 + call));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const id = r.nodes[1].id;
  const calls = seen.filter(input => input.nodeId === id);
  assert.equal(calls.length, 4, 'first draft, the fix round, two passes that added nothing (the second with the retry request): no third');
  const { BOOK_EXPAND_RETRY_INSTRUCTION } = S.load('core/book-pipeline/settings.ts');
  assert.ok(!calls[2].requirements.includes(BOOK_EXPAND_RETRY_INSTRUCTION));
  assert.ok(calls[3].requirements.includes(BOOK_EXPAND_RETRY_INSTRUCTION));
  assert.ok((await r.note(1)).detail.includes('### 新節30'));
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  assert.match((await r.note(1)).pipelineIssue, /length:under:\d+:100-200/);
  assert.match(r.stat.logs.join('\n'), new RegExp(`expand_merge [^\\n]*card=${id} [^\\n]*result=no_edits [^\\n]*pass=1 [^\\n]*noop=1`));
});

test('expand passes (live v6 〈澆水〉, X): a fix round with no usable block is followed by a pass that asks with the retry request; when that pass writes, the chapter keeps it', async () => {
  const seen = [];
  const r = await lenRig();
  r.script.author = passAuthor(r, seen, (call, id) => (id === r.nodes[1].id ? (call === 1 ? 0 : 150) : 150 + call));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const id = r.nodes[1].id;
  const calls = seen.filter(input => input.nodeId === id);
  assert.equal(calls.length, 3, 'first draft, the fix round with no block, one pass that wrote');
  const { BOOK_EXPAND_RETRY_INSTRUCTION } = S.load('core/book-pipeline/settings.ts');
  assert.ok(!calls[1].requirements.includes(BOOK_EXPAND_RETRY_INSTRUCTION));
  assert.ok(calls[2].requirements.includes(BOOK_EXPAND_RETRY_INSTRUCTION), 'the pass after no_edits asks for concrete new sections');
  assert.ok((await r.note(1)).detail.includes('### 新節150'));
  assert.equal(stageOf(r.raw(1)), 'checked');
  assert.ok(!/fix_no_edits/.test((await r.note(1)).pipelineIssue ?? ''));
});

test('expand passes: a trial chapter has one fix round and at most BOOK_EXPAND_PASSES extra passes; its writing calls stay at draft + one fix round + the capped passes', async () => {
  const seen = [];
  // The plan-review flow: the run stops at the plan review, "try" writes the trial to its gate 1, then the rest; the bound is the same.
  const r = await trialRig({ titles: ['A', 'B', 'C', 'D', 'E'], planReview: true });
  await r.repo.writeBookSettings(r.nodes[0].path, { length: LEN_SETTING });
  r.script.author = passAuthor(r, seen, call => 5 + call);
  await r.runs.start(r.mapPath); await idle(r);
  assert.equal((await r.state()).planReview, true); assert.equal(seen.length, 0, 'nothing is written at the plan review');
  await r.runs.startTrial(r.mapPath); await idle(r);
  assert.equal((await r.state()).phase, 'done', 'the trial gate passes by itself');
  const { MAX_AUTO_FIXES, BOOK_EXPAND_PASSES } = S.load('core/book-pipeline/model.ts');
  const trial = r.nodes.slice(0, 3);
  const log = r.stat.logs.join('\n');
  const s = await r.state();
  for (const node of trial) {
    const calls = seen.filter(input => input.nodeId === node.id).length;
    assert.equal(calls, 1 + MAX_AUTO_FIXES + BOOK_EXPAND_PASSES, 'draft, the fix round, the capped passes');
    assert.ok(calls <= 1 + MAX_AUTO_FIXES + BOOK_EXPAND_PASSES, `${node.id}: ${calls} writing calls`);
    assert.ok(log.split('\n').filter(line => line.includes('author_call') && line.includes(`card=${node.id} `) && line.includes('result=expand_pass')).length <= BOOK_EXPAND_PASSES);
    assert.ok((s.expandPasses?.[node.id] ?? 0) <= BOOK_EXPAND_PASSES);
  }
  assert.ok(trial.some(node => s.expandPasses?.[node.id] === BOOK_EXPAND_PASSES), 'the cap was reached');
});

test('expand passes: the budget running out during an extra pass ends the passes; the chapter carries on to its proofread and the run continues', async () => {
  const seen = [];
  const r = await lenRig();
  const base = passAuthor(r, seen, call => 5 + call);
  r.script.author = async input => {
    const mine = seen.filter(call => call.nodeId === input.nodeId).length;
    if (input.nodeId === r.nodes[1].id && mine === 2) { seen.push(input); return { outcome: 'budget-exhausted' }; }
    return base(input);
  };
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const id = r.nodes[1].id;
  assert.equal(seen.filter(input => input.nodeId === id).length, 3, 'first draft, fix round, one pass that hit the budget: no second pass');
  assert.equal(r.stat.proof.length >= 3, true, 'the chapter was still proofread');
  assert.equal((await r.state()).phase, 'done');
  assert.equal((await r.state()).expandPasses[id], 1);
});

test('T10c length expand: the redo keeps the card\'s Summary (keepSummary reaches the author only for the expansion)', async () => {
  const seen = [];
  const r = await lenRig();
  r.script.author = expandAuthor(r, seen, ['@@insert', '好'.repeat(140)].join('\n'));
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const calls = seen.filter(input => input.nodeId === r.nodes[1].id);
  assert.equal(calls[0].keepSummary, undefined, 'a first write replaces the summary');
  assert.equal(calls[1].keepSummary, true, 'the expansion keeps it');
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
  assert.deepEqual([...root.chapters.map(c => c.place)], ['preface', 'chapter 1', 'chapter 2']);
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

test('T10c length: a length failure with a partly unmet structure point keeps both in the issue; no token is dropped', async () => {
  const three = [{ id: 'C1', type: 'structure', text: 'a' }, { id: 'C2', type: 'structure', text: 'b' }, { id: 'C3', type: 'fact', text: 'd' }];
  const r = await lenRig({ script: { card: () => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: three }), proof: async request => unjudged(request, { C1: 'unmet' }) } });
  r.script.author = lengthAuthor(r, [], 500, 500);
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  const issue = (await r.note(1)).pipelineIssue;
  assert.match(issue, /^proof unmet: C1 length:over:\d+:100-200:字:v\d+$/, 'the structure point and the length token both stay');
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
  assert.equal(s.phase, 'done'); assert.equal(s.status, 'running');
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
  assert.equal(s.phase, 'done'); sameJson(s.removed, [r.nodes[3].id]);
  // A paused-for-map run is only resumed by keepBookMap; the plain resume pauses again at its first step.
  const old = await rig({ titles: FOUR });
  await old.runs.start(old.mapPath);
  await old.repo.updateMap(old.mapPath, d => { delete d.bookPipeline.accepted; delete d.bookPipeline.ignored; delete d.bookPipeline.removed; });
  await old.runs.confirmGate1(old.mapPath); await finished(old);
  assert.equal((await old.state()).phase, 'done', 'an old map without the fields and with no change runs through');
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
  assert.equal(done.phase, 'done'); sameJson(done.removed.sort(), [r.nodes[1].id, r.nodes[3].id].sort()); sameJson(done.ignored, [second.id]);
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
  sameJson(r.runs.getProgress(r.mapPath).mapChange, { added: 0, missing: 1 }, 'a card deleted while running reads as one chapter less');
  assert.equal(s.attempts[victim].write, 0, 'the attempt is given back');
  assert.ok(s.budget.used > before, 'the call that was sent counts');
  for (let i = 0; i < 4; i++) assert.notEqual(stageOf(r.raw(i)), 'needs-review');
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(hit, 1, 'the removed card is never written again');
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
    assert.equal((await r.state()).phase, 'done');
  }
});

// ---- T12: after a single-chapter rerun, the neighbours' previous/next plan line follows the new covers (no AI call) ----
const promptLine = async (r, i, label) => new RegExp(`^${label}[:：] ?(.*)$`, 'm').exec((await r.note(i)).prompt)?.[1];
async function neighbourRig(titles = FOUR) {
  const r = await rig({ titles });
  await r.runs.start(r.mapPath); await r.runs.confirmGate1(r.mapPath); await finished(r);
  assert.equal((await r.state()).phase, 'done');
  const base = r.script.card; r.script.card = (request, n) => ({ ...base(request, n), covers: `NEWCOVERS ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}` });
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
  assert.equal((await promptLine(r, 1, '下一章')), `(2) SecretTitleB — NEWCOVERS 3`, 'left neighbour: next line');
  assert.equal((await promptLine(r, 3, '上一章')), `(2) SecretTitleB — p`, 'right neighbour: its previous line keeps its own sentence (the earlier ideas it stands on)');
  assert.ok((await promptLine(r, 1, '上一章')).includes('(前言)'), 'its other line is not touched');
  assert.ok((await r.note(1)).pipelineSeam && (await r.note(3)).pipelineSeam, 'seams marked as before');
  assert.equal(integrityFpRaw(r.raw(1)), fps[0]); assert.equal(integrityFpRaw(r.raw(3)), fps[2]);
  for (const i of [1, 3]) assert.equal(bodyStateRaw(r.raw(i)), 'clean');
});

test('T12 neighbours: the first and the last chapter have one neighbour; a removed neighbour is skipped for the next one over', async () => {
  const r = await neighbourRig();
  await rerun(r, 0);
  assert.equal((await promptLine(r, 1, '上一章')), '(前言) SecretRootTitle — p', 'a previous line keeps its own sentence');
  assert.ok(!/NEWCOVERS/.test((await promptLine(r, 2, '上一章'))));
  const last = await neighbourRig();
  await rerun(last, 3);
  assert.equal((await promptLine(last, 2, '下一章')), '(3) SecretTitleC — NEWCOVERS 4');
  // A removed neighbour: chapter 2 is removed; rerunning chapter 3 changes chapter 1's next line (now the one before) and not the removed card.
  const gone = await neighbourRig();
  const removedBefore = gone.raw(2);
  await dropCard(gone, 2);
  await gone.repo.updateMap(gone.mapPath, d => { d.bookPipeline.removed = [gone.nodes[2].id]; d.bookPipeline.accepted = d.bookPipeline.order.filter(id => id !== gone.nodes[2].id); d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  await rerun(gone, 3);
  assert.equal(gone.raw(2), removedBefore, 'the removed card is never written');
  assert.equal((await promptLine(gone, 1, '下一章')), '(2) SecretTitleC — NEWCOVERS 3', 'the surviving neighbour on the left follows');
});

test('T12 neighbours, open items: an untouched neighbour with an AIM open-items marker saved after its Detail still gets its line refreshed', async () => {
  const r = await neighbourRig();
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, TODO_AFTER, {});
  assert.ok((await r.note(1)).detail.includes('aim-open-items'));
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
  await rerun(r, 2);
  assert.equal((await promptLine(r, 1, '下一章')), `(2) SecretTitleB — NEWCOVERS 3`, 'left neighbour follows');
});

// 章節文字歸屬: the neighbour line follows the same rule as any rewrite of the card (text-ownership-fixes 02).
test('T12 neighbours: a neighbour the reader kept is not touched; an older-build chapter (no fingerprint, written stage) follows', async () => {
  const r = await neighbourRig();
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, keepRaw, {});
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
  const keptLine = await promptLine(r, 1, '下一章');
  await rerun(r, 2);
  assert.equal(await promptLine(r, 1, '下一章'), keptLine, 'the kept neighbour keeps its line');
  const old = await neighbourRig();
  const plain = raw => raw.replace(/(<!-- visual-agent-map:detail:start -->\n)[\s\S]*?(\n<!-- visual-agent-map:detail:end -->)/, '$1舊版寫好的正文。$2');
  await old.repo.updateNoteRawGuarded(old.nodes[1].path, plain, {});
  assert.equal(readBodyRecord((await old.note(1)).detail), undefined, 'no fingerprint record');
  assert.equal(bodyStateRaw(old.raw(1)), 'clean', 'the written/checked stage vouches for it');
  await rerun(old, 2);
  assert.equal(await promptLine(old, 1, '下一章'), '(2) SecretTitleB — NEWCOVERS 3', 'the older-build neighbour follows');
});

test('T12 neighbours: a neighbour whose text the reader edited by hand is not touched; its seam is still marked; running the rewrite again changes nothing', async () => {
  const r = await neighbourRig();
  await r.repo.updateNoteGuarded(r.nodes[1].path, { detail: `${(await r.note(1)).detail}\nreader added this line` }, {});
  assert.equal(bodyStateRaw(r.raw(1)), 'edited');
  const editedLine = await promptLine(r, 1, '下一章');
  await rerun(r, 2);
  assert.equal(await promptLine(r, 1, '下一章'), editedLine, 'the edited neighbour keeps its line');
  assert.equal((await promptLine(r, 3, '上一章')), '(2) SecretTitleB — p', 'the clean neighbour keeps its own previous sentence');
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
  assert.ok(/^Role: Body\r\nNext chapter: \(2\) T[^\n]* — [^\n]*\r\nChecklist:$/.test(out), out);
  assert.equal(out.split('\n').length, 3, 'one line, no injected heading');
  assert.equal(rewriteNeighbourLine('Role: Body', 'next', n), undefined, 'no such line');
  assert.equal(rewriteNeighbourLine(out, 'next', n), undefined, 'already says it');
});

// ---- fix packet 5: skipped chapters' neighbour lines follow the order; placeholder summaries are not descriptions ----
test('fix5 skipped chapter: a hand-edited chapter the plan step leaves alone gets its previous/next lines rewritten from the current covers (text and fingerprint untouched)', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 1);
  const stale = await promptLine(r, 1, '下一章');
  const fp = integrityFpRaw(r.raw(1));
  const base = r.script.card; r.script.card = (request, n) => ({ ...base(request, n), covers: `NEWCOVERS ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}` });
  await redo(r, [1, 2], null);
  assert.equal(stageOf(r.raw(1)), 'needs-review', 'chapter 1 was skipped');
  assert.notEqual(stale, '(2) SecretTitleB — NEWCOVERS 3');
  assert.equal(await promptLine(r, 1, '下一章'), '(2) SecretTitleB — NEWCOVERS 3', 'next line follows the neighbour\'s current covers');
  assert.ok((await promptLine(r, 1, '上一章')).startsWith('(前言) SecretRootTitle'), 'previous line names the current previous chapter');
  assert.equal(integrityFpRaw(r.raw(1)), fp, 'the integrity fingerprint is not touched');
  assert.equal(bodyStateRaw(r.raw(1)), 'edited');
  assert.ok((await r.note(1)).detail.includes(HAND));
});

test('fix5 placeholder: a neighbour whose summary is the "no conclusion yet" placeholder is sent (and written) with an empty description', async () => {
  const r = await rig();
  const PLACEHOLDER = '尚未形成結論';
  await r.repo.updateNoteRawGuarded(r.nodes[2].path, c => c.split('summary of SecretTitleB').join(PLACEHOLDER), {});
  const seen = [];
  const base = r.script.card; r.script.card = (request, n) => { seen.push(request); return base(request, n); };
  const baseGlobal = r.script.global; let globalRequest; r.script.global = (request, n) => { globalRequest = request; return baseGlobal(request, n); };
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  const forA = seen.find(request => request.card.id === r.nodes[1].id);
  assert.equal(forA.next.title, 'SecretTitleB');
  assert.equal(forA.next.summary, '', 'the placeholder is not a description');
  assert.equal(forA.previous.summary, 'summary of SecretRootTitle', 'a real summary is kept');
  assert.equal(globalRequest.cards.find(c => c.id === r.nodes[2].id).summary, '');
  assert.ok(!/尚未形成結論/.test(await promptLine(r, 1, '下一章')), 'the written line has no placeholder');
});

test('fix5 rewriteNeighbourLine: an empty summary leaves no dangling dash', () => {
  const { rewriteNeighbourLine } = S.load('core/book-pipeline/plan-text.ts');
  const out = rewriteNeighbourLine('後一張：(3) old — old', 'next', { position: 5, title: 'T', summary: '' });
  assert.equal(out, '下一章：(5) T', 'an old label is written as the new one');
});

// ---- fix packet 6: the no-neighbour form, and a redo that never plans still refreshes skipped chapters ----
test('fix6 rewriteNeighbourLine: null writes the no-neighbour form for either end, in the line\'s own language, CRLF kept, idempotent', () => {
  const { rewriteNeighbourLine } = S.load('core/book-pipeline/plan-text.ts');
  const next = rewriteNeighbourLine('後一張：(3) old — old', 'next', null);
  assert.equal(next, '下一章：無', 'last chapter, Chinese');
  const prev = rewriteNeighbourLine('Role: Body\r\nPrevious card: (1) old — old\r\nNext card: (3) x', 'previous', null);
  assert.equal(prev, 'Role: Body\r\nPrevious chapter: none\r\nNext card: (3) x', 'first chapter, English, CRLF');
  assert.equal(rewriteNeighbourLine(next, 'next', null), undefined, 'already says it');
});

test('fix6 redo at planned: no plan step runs, yet a skipped (hand-edited) last chapter\'s stale next line becomes "none"; no AI call, fingerprint untouched, idempotent', async () => {
  const r = await rig();
  await finish(r);
  await handEdit(r, 2);
  const last = await promptLine(r, 2, '下一章');
  assert.equal(last, '無', 'the last chapter starts with none');
  await r.repo.updateNoteRawGuarded(r.nodes[2].path, c => c.replace(/^後一張[:：] ?.*$/m, '後一張：(9) stale — old'), {});
  const fp = integrityFpRaw(r.raw(2));
  let calls = 0;
  { const f = r.script.card; r.script.card = (...a) => { calls++; return f(...a); }; }
  await redo(r, [1]);
  assert.equal(await promptLine(r, 2, '下一章'), '無');
  assert.equal(integrityFpRaw(r.raw(2)), fp, 'fingerprint untouched');
  assert.ok((await r.note(2)).detail.includes(HAND));
  const before = r.raw(2);
  await redo(r, [1]);
  assert.equal(r.raw(2), before, 'a second drive changes nothing');
  assert.equal(calls, 0, 'no plan call');
});

// ---- rerun fix 3: neighbours around a chapter removed mid-writing, and no literal "null" description ----
test('fix3 retargetNeighbourLine: a line naming the neighbour is left; a moved position keeps its sentence; another chapter is rewritten; null gives none', () => {
  const { retargetNeighbourLine } = S.load('core/book-pipeline/plan-text.ts');
  const prompt = '角色：本文\n前一張：(2) A — about a\n後一張：(4) Gone — about gone';
  assert.equal(retargetNeighbourLine(prompt, 'previous', { position: 2, title: 'A', summary: 'new' }), undefined, 'already names it');
  assert.equal(retargetNeighbourLine(prompt, 'previous', { position: 1, title: 'A', summary: 'new' }), '角色：本文\n上一章：(1) A — about a\n後一張：(4) Gone — about gone', 'only the position moved');
  assert.equal(retargetNeighbourLine(prompt, 'next', { position: 4, title: 'C', summary: 'covers c' }), '角色：本文\n前一張：(2) A — about a\n下一章：(4) C — covers c', 'a removed chapter is replaced');
  assert.equal(retargetNeighbourLine(prompt, 'next', null), '角色：本文\n前一張：(2) A — about a\n下一章：無');
  assert.equal(retargetNeighbourLine('角色：本文', 'next', null), undefined, 'no such line');
});

test('dropEntryNaming: the entry line goes only when it names a removed chapter; other lines, a missing line, a one-character title and English labels', () => {
  const { dropEntryNaming } = S.load('core/book-pipeline/plan-text.ts');
  const prompt = '角色：本文\n接入點：接著「烘焙」講的火候\n交接：留給下一張';
  assert.equal(dropEntryNaming(prompt, ['烘焙']), '角色：本文\n交接：留給下一張');
  assert.equal(dropEntryNaming(prompt, ['沖煮']), undefined, 'names no removed chapter');
  assert.equal(dropEntryNaming('角色：本文\n交接：烘焙', ['烘焙']), undefined, 'no entry line (another line naming it is not touched)');
  assert.equal(dropEntryNaming('接入點：豆子', ['豆']), undefined, 'a one-character title is not looked for');
  assert.equal(dropEntryNaming('接入點: 接著 烘焙 ', [' 烘焙 ']), '', 'half-width colon, padded title');
  assert.equal(dropEntryNaming('Role: body\nEntry point: after Roasting\n', ['Roasting']), 'Role: body\n');
});

test('fix3 composeCardPrompt / rewriteNeighbourLine: a literal null or undefined description is never written (the title alone stays)', () => {
  const { composeCardPrompt, rewriteNeighbourLine } = S.load('core/book-pipeline/plan-text.ts');
  const prompt = composeCardPrompt({ role: 'body', covers: 'c', entry: 'e', handoff: 'h', previous: { position: 3, title: 'Seeds', summary: 'null' }, next: { position: 5, title: 'Veg', summary: ' undefined ' }, checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }, 'zh-TW');
  assert.ok(prompt.includes('上一章：(3) Seeds\n'), prompt);
  assert.ok(prompt.includes('下一章：(5) Veg\n'), prompt);
  assert.ok(!/null|undefined/.test(prompt));
  assert.equal(rewriteNeighbourLine('後一張：(3) old — old', 'next', { position: 5, title: 'T', summary: 'NULL' }), '下一章：(5) T');
});

test('fix3 a planned chapter whose plan step answers "null" for its neighbours writes their titles only', async () => {
  const r = await rig({ titles: FOUR });
  const base = r.script.card; r.script.card = (request, n) => ({ ...base(request, n), previous: 'null', next: 'null' });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  assert.equal(await promptLine(r, 2, '上一章'), '(1) SecretTitleA');
  assert.equal(await promptLine(r, 2, '下一章'), '(3) SecretTitleC');
});

test('fix3 a chapter removed while writing, then "carry on": the neighbours\' previous/next lines skip it and roles do not change', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  const roles = []; for (let i = 0; i < 4; i++) roles.push((await r.note(i)).bookRole);
  assert.ok((await promptLine(r, 0, '下一章')).startsWith('(1) SecretTitleA'), 'planned against the old order');
  // The entry line of chapter 2 names the chapter that goes; chapter 3's names one that stays.
  const withEntry = async (i, text) => { const n = await r.note(i); assert.match(n.prompt, /^接入點：/m); await r.repo.updateNoteGuarded(r.nodes[i].path, { prompt: n.prompt.replace(/^接入點：.*$/m, `接入點：${text}`) }, {}); };
  await withEntry(2, '接著 SecretTitleA 講到的步驟');
  await withEntry(3, '接著 SecretTitleB 的結尾');
  const base = r.script.author; let hit = false;
  r.script.author = async (input, n) => { if (!hit) { hit = true; await dropCard(r, 1); } return base(input, n); };
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  assert.equal((await r.state()).pauseReason, 'map');
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  assert.equal((await r.state()).phase, 'done');
  assert.equal(await promptLine(r, 2, '接入點'), undefined, 'the entry line naming the removed chapter is gone (a join no longer there)');
  assert.equal(await promptLine(r, 3, '接入點'), '接著 SecretTitleB 的結尾', 'an entry line naming a chapter that stays is kept');
  assert.equal(await promptLine(r, 0, '下一章'), '(1) SecretTitleB — covers 3', 'the previous chapter now points past the removed one');
  assert.equal(await promptLine(r, 2, '上一章'), '(前言) SecretRootTitle — covers 1', 'the next chapter names its new neighbour');
  assert.equal(await promptLine(r, 3, '上一章'), '(1) SecretTitleB — p', 'only the position moved: the sentence is kept');
  assert.equal(await promptLine(r, 2, '下一章'), '(2) SecretTitleC — n');
  assert.equal(await promptLine(r, 3, '下一章'), '無', 'an unaffected line is left as it was');
  for (const i of [0, 2, 3]) assert.equal((await r.note(i)).bookRole, roles[i], `role of card ${i} unchanged`);
});

test('fix5 an entry line that only paraphrases the removed chapter (no exact title) goes with the previous-line retarget', async () => {
  const r = await rig({ titles: FOUR });
  await r.runs.start(r.mapPath);
  const n = await r.note(2);
  await r.repo.updateNoteGuarded(r.nodes[2].path, { prompt: n.prompt.replace(/^接入點：.*$/m, '接入點：承接上一章的那些步驟，從這裡開始') }, {});
  const base = r.script.author; let hit = false;
  r.script.author = async (input, k) => { if (!hit) { hit = true; await dropCard(r, 1); } return base(input, k); };
  await r.runs.confirmGate1(r.mapPath); await finished(r);
  await r.runs.keepBookMap(r.mapPath); await finished(r);
  assert.equal(await promptLine(r, 2, '接入點'), undefined, 'previous chapter removed: the paraphrased join is gone too');
  assert.equal(await promptLine(r, 3, '接入點') !== undefined, true, 'a chapter whose previous stays keeps its entry');
});

test('plan wiring: a material\'s home id is shown by the owning card\'s title in the root plan and in the card plans; a card plan carries the previous card\'s planned opening and ending once that card is planned', async () => {
  const seen = [];
  const r = await rig({ titles: ['SecretRootTitle', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6'] });
  const g = r.script.global, c = r.script.card;
  const homeId = r.nodes[1].id;
  const indexOf = id => r.nodes.findIndex(n => n.id === id);
  r.script.global = (request, n) => ({ ...g(request, n), materials: [{ name: 'Barter scene', use: 'opens', home: homeId }, { name: 'Shell', use: 'u', home: '' }] });
  // The first five cards are planned at once; the later ones finish first, so card 6 starts after card 5 (its previous card) is planned.
  r.script.card = async (request, n) => {
    seen.push(request);
    const at = indexOf(request.card.id);
    if (at < 5) await new Promise(resolve => setTimeout(resolve, (5 - at) * 30));
    return { ...c(request, n), entry: `場景：${at} 的開場`, handoff: `問句：${at} 之後呢` };
  };
  await finish(r);
  assert.ok(/歸屬[：:]T1/.test(r.raw(0)), 'the root plan shows the owning card\'s title');
  const forSix = seen.find(request => request.card.id === r.nodes[6].id);
  assert.deepEqual(JSON.parse(JSON.stringify(forSix.materials)).map(m => [m.name, m.home]), [['Barter scene', 'T1'], ['Shell', undefined]]);
  assert.deepEqual(JSON.parse(JSON.stringify(forSix.previousStyle)), { entry: '場景：5 的開場', handoff: '問句：5 之後呢' }, 'the previous card\'s opening and ending ride with the request');
  assert.equal(seen.find(request => request.card.id === r.nodes[0].id).previousStyle, undefined, 'the preface has no previous card');
});

test('fix5 whole-book rerun after the book title (root topic) is renamed: plans and intro see the new title, the root is not hand-edited, no old title in entry or previous/next lines', async () => {
  const seen = [];
  const r = await rig({ titles: FOUR });
  const g = r.script.global, c = r.script.card;
  r.script.global = (request, n) => { seen.push(JSON.stringify(request)); return g(request, n); };
  r.script.card = (request, n) => { seen.push(JSON.stringify(request)); return { ...c(request, n), entry: `接著 ${request.previous?.title ?? ''} 的收尾` }; };
  await finish(r);
  assert.equal((await r.state()).phase, 'done');
  // The rename: the root topic's title (the map's name follows it).
  const oldPath = r.nodes[0].path;
  const newPath = await r.repo.renameNote(oldPath, 'BrandNewBookTitle');
  r.nodes[0].path = newPath; r.nodes[0].title = 'BrandNewBookTitle';
  await r.repo.updateMap(r.mapPath, d => { d.title = 'BrandNewBookTitle'; const n = d.nodes.find(x => x.id === r.nodes[0].id); n.title = 'BrandNewBookTitle'; n.path = newPath; });
  await r.runs.stop(r.mapPath, { saved: true });
  seen.length = 0; const authors = r.stat.author.length;
  await r.runs.start(r.mapPath, { restart: true });
  await confirmDone(r.runs, r.mapPath);
  await settle();
  assert.ok(seen.length >= 4, 'plans ran again');
  assert.ok(seen.every(x => !x.includes('SecretRootTitle')), 'no plan request carries the old title');
  assert.ok(seen.some(x => x.includes('BrandNewBookTitle')), 'the new title is in the plans');
  assert.equal(r.stat.author.length, authors + 4, 'every chapter, the root included, is written again');
  assert.ok(!r.stat.logs.some(l => l.includes('hand_edit_skipped') || l.includes('plan_skipped')), 'the root is not read as hand-edited');
  for (let i = 0; i < 4; i++) {
    const n = await r.note(i);
    assert.equal(n.pipelineIssue, undefined, `chapter ${i} has no issue`);
    assert.ok(!n.prompt.includes('SecretRootTitle'), `chapter ${i}: no old title in its prompt (entry, previous, next)`);
  }
  assert.ok((await promptLine(r, 1, '上一章')).includes('BrandNewBookTitle'));
  assert.ok((await promptLine(r, 1, '接入點')).includes('BrandNewBookTitle'));
});

// ---- P6b: the closing "still open" page is written before the book counts as done (the old consistency call is gone) ----
const { writeOpenIssuesFile } = S.load('experiences/visual-map/book-open-issues-file.ts');
const folderOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** An in-memory vault for the page: `files` maps path to text; `fail` makes every write fail. */
const pageVault = (files = new Map(), state = { fail: false, calls: 0 }) => {
  const vault = { read: async path => files.get(path), create: async (path, text) => { files.set(path, text); }, modify: async (path, text) => { files.set(path, text); } };
  const port = async (folder, language, content, existingOnly) => { state.calls++; return state.fail ? { ok: false } : writeOpenIssuesFile(vault, folder, language, content, existingOnly); };
  return { files, state, port };
};
const pageFiles = v => [...v.files.entries()].filter(([path]) => /仍有問題/.test(path));
const finishAi = async r => { await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle(); };
const okCheck = (request, id = 'P9') => ({ id, kind: 'fact', quote: request.body.slice(0, 11), verdict: 'ok', problem: '', fixable: false, suggestion: '', sources: [] });

test('open issues page: everything solved writes "AI 校對查了 N 項，全部解決" into the book\'s folder, beside no map card, then the book is done', async () => {
  const v = pageVault();
  const r = await aiRig({ aiProof: async request => ({ checks: [okCheck(request)], prior: [], dropped: {} }) }, { ports: { writeOpenIssues: v.port } });
  const nodesBefore = (await r.repo.readMap(r.mapPath)).nodes.length;
  await finishAi(r);
  const s = await r.state();
  assert.equal(s.phase, 'done');
  const pages = pageFiles(v);
  assert.equal(pages.length, 1);
  assert.equal(folderOf(pages[0][0]), folderOf(r.nodes[0].path));
  const n = Object.values(s.aiProof).reduce((sum, p) => sum + p.checked, 0) + s.bookProof.checked;
  assert.ok(n >= 3);
  assert.match(pages[0][1], new RegExp(`AI 校對查了 ${n} 項，全部解決`));
  assert.ok(pages[0][1].startsWith('<!-- vam-book-open-issues:v1 -->'));
  assert.equal((await r.repo.readMap(r.mapPath)).nodes.length, nodesBefore, 'the page is not a map card');
});

test('open issues page: a failed write is retried once, then the run stops with open_issues_write and is not done; a later resume writes it and finishes', async () => {
  const v = pageVault(new Map(), { fail: true, calls: 0 });
  const r = await aiRig({}, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  let s = await r.state();
  assert.equal(s.phase, 'gate2');
  assert.deepEqual([s.status, s.pauseReason, s.failureCode], ['stopped', 'failed', 'open_issues_write']);
  assert.equal(v.state.calls, 2, 'one try and one retry');
  assert.equal(pageFiles(v).length, 0);
  v.state.fail = false;
  await r.runs.resume(r.mapPath); await settle();
  s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal(pageFiles(v).length, 1);
});

test('open issues page: a same-named note without the marker is never overwritten (the next name is used); an earlier page of ours is rewritten', async () => {
  const files = new Map();
  const v = pageVault(files);
  const r = await aiRig({}, { ports: { writeOpenIssues: v.port } });
  const dir = folderOf(r.nodes[0].path);
  const mine = `${dir ? `${dir}/` : ''}仍有問題.md`;
  files.set(mine, 'my own note, no marker');
  await finishAi(r);
  assert.equal((await r.state()).phase, 'done');
  assert.equal(files.get(mine), 'my own note, no marker');
  const pages = pageFiles(v).filter(([path]) => path !== mine);
  assert.equal(pages.length, 1);
  assert.match(pages[0][0], /仍有問題 \(2\)\.md$/);
  // A rerun rewrites the same page (it has the marker), no third file.
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  files.set(pages[0][0], '<!-- vam-book-open-issues:v1 -->\nold');
  await r.runs.resume(r.mapPath); await settle();
  assert.equal((await r.state()).phase, 'done');
  assert.equal(pageFiles(v).length, 2);
  assert.ok(files.get(pages[0][0]).length > 40 && !files.get(pages[0][0]).includes('\nold'));
});

test('open issues page: an unfinished AI proofread never reads as all solved; a chapter needing review and an unsolved finding are listed with their reasons', async () => {
  const v = pageVault();
  const r = await aiRig({
    aiBookProof: async () => { throw new Error('boom'); },
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' ? [{ ...problem(request), fixable: false }] : [], prior: [], dropped: {} })
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  const s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal(s.bookProof.incomplete, true);
  const text = pageFiles(v)[0][1];
  assert.doesNotMatch(text, /全部解決/);
  assert.match(text, /AI 校對沒有跑完/);
  assert.match(text, /AI 判斷這處不能靠改字解決/);
  assert.match(text, /SecretTitleA/);
});

test('open issues page: a chapter that needs review is listed as a chapter-status item with a plain reason', async () => {
  const v = pageVault();
  const bad = { id: '' };
  const r = await aiRig({ author: async (input) => { if (input.nodeId === bad.id) throw new Error('boom'); await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return { outcome: 'written' }; } }, { ports: { writeOpenIssues: v.port } });
  bad.id = r.nodes[1].id;
  await finishAi(r);
  assert.equal((await r.state()).phase, 'done');
  const text = pageFiles(v)[0][1];
  assert.doesNotMatch(text, /全部解決/);
  assert.match(text, /SecretTitleA：有一個步驟失敗了/);
});

test('open issues page: a run an older build left at gate 2 (no whole-book proofread yet, an old consistency field) does the whole-book proofread, writes the page, and is done', async () => {
  const v = pageVault();
  const r = await aiRig({}, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  const books = () => r.stat.ai.filter(([k]) => k === 'book').length;
  assert.equal(books(), 1);
  await r.repo.updateMap(r.mapPath, d => {
    const b = d.bookPipeline;
    b.phase = 'gate2'; b.status = 'stopped'; delete b.pauseReason; delete b.bookProof;
    b.consistency = { key: 'old', attempts: 1, done: true, revisions: {}, findings: [] };
  });
  v.files.clear();
  await r.runs.resume(r.mapPath); await settle();
  const s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal(books(), 2, 'the whole-book proofread ran again');
  assert.equal(pageFiles(v).length, 1);
  assert.ok(s.consistency, 'the old field is still read');
});

// ---- P3: sections' neighbour lines (structure.neighboursOf) and the plan's 全書結構 ----
const { parseBookPlanBody, parseBookPlanDecisions, composeBookPlan } = S.load('core/book-pipeline/plan-text.ts');
const POINTED = { card: request => ({ covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, points: [`${request.card.title} a`, `${request.card.title} b`, `${request.card.title} c`], entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }] }) };
const SECT = ['BookRoot', 'ChapA', 'SecA1', 'SecA2', 'ChapB'];
/** Root, chapter A with two sections, chapter B; the run waits at the plan review. */
async function sectionRig(over = {}) {
  const r = await trialRig({ planReview: true, titles: SECT, ...over, script: { ...POINTED, ...over.script } });
  if (!over.titles) await r.repo.updateMap(r.mapPath, d => { d.nodes.find(n => n.id === r.nodes[3].id).parentId = r.nodes[1].id; });
  return r;
}
const rootRaw = r => r.raw(0);

test('P3 structure: the plan gate no longer writes a ### 全書結構 part; the thread, decisions and materials are there and parse as before', async () => {
  const r = await sectionRig();
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).planReview, true);
  const raw = rootRaw(r);
  assert.ok(!raw.includes('全書結構'), 'no structure part');
  assert.ok(raw.indexOf('> ### 全書主線') < raw.indexOf('> ### 編輯決定'));
  const body = parseBookPlanBody(raw);
  assert.equal(body.thread, 'one thread'); same(body.materials, [{ name: 'm', use: 'u' }]);
  assert.equal(parseBookPlanDecisions(raw).reader, 'kids');
});

test('P3 structure: the last section of a chapter is planned with the next chapter carrying its number; the section\'s own neighbours stay unnumbered', async () => {
  const seen = [];
  const r = await sectionRig({ script: { card: (request, n) => { seen.push(request); return POINTED.card(request, n); } } });
  await r.runs.start(r.mapPath);
  const last = seen.find(request => request.card.id === r.nodes[3].id);
  assert.ok(last, 'SecA2 was planned');
  assert.deepEqual([last.nextChapter.title, last.nextChapter.position], ['ChapB', 2], 'the next chapter keeps its chapter number');
  assert.equal(last.previous.position, undefined, 'the previous section is named by title only');
});

test('P3 neighbours: a section gets 所屬章 / 前一節 / 後一節 and a chapter gets 上一章 / 下一章 after a rerun; sections never name the next chapter', async () => {
  const r = await sectionRig();
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  assert.equal((await r.state()).phase, 'done');
  const base = r.script.card; r.script.card = (request, n) => ({ ...base(request, n), covers: `NEWCOVERS ${request.chapters.findIndex(c => c.title === request.card.title) + 1}` });
  await rerun(r, 2);
  assert.equal(await promptLine(r, 2, '所屬章'), '(1) ChapA', 'the section names its chapter, by number and title only');
  assert.equal(await promptLine(r, 2, '前一節'), '無');
  assert.ok((await promptLine(r, 2, '後一節')).startsWith('SecA2 — '), 'the next section has no number');
  assert.equal(await promptLine(r, 3, '前一節'), 'SecA1 — p', 'the next section keeps its own previous sentence');
  assert.equal(await promptLine(r, 3, '後一節'), '無', 'the last section names no next chapter');
  assert.ok(!/下一章/.test((await r.note(3)).prompt), 'no next-chapter line on a section');
  assert.ok((await promptLine(r, 1, '上一章')).startsWith('(前言) BookRoot'));
  assert.ok((await promptLine(r, 1, '下一章')).startsWith('(2) ChapB'), 'chapters skip the sections');
  assert.ok((await promptLine(r, 4, '上一章')).startsWith('(1) ChapA'));
  assert.equal(await promptLine(r, 4, '下一章'), '無');
});

test('P3 neighbours: a removed chapter is skipped (chapters are renumbered); a section keeps its chapter line', async () => {
  const r = await sectionRig({ titles: ['BookRoot', 'ChapA', 'SecA1', 'ChapB', 'ChapC'] });
  await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath);
  const base = r.script.card; r.script.card = (request, n) => ({ ...base(request, n), covers: `NEWCOVERS ${request.chapters.findIndex(c => c.title === request.card.title) + 1}` });
  const goneBefore = r.raw(3);
  await dropCard(r, 3);
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.removed = [r.nodes[3].id]; d.bookPipeline.accepted = d.bookPipeline.order.filter(id => id !== r.nodes[3].id); d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  await rerun(r, 4);
  assert.equal(r.raw(3), goneBefore, 'the removed card is never written');
  assert.ok((await promptLine(r, 1, '下一章')).startsWith('(2) ChapC'), 'chapter A now leads to chapter C, numbered 2');
  assert.equal(await promptLine(r, 2, '所屬章'), '(1) ChapA');
});

test('P3 neighbours: a section whose chapter was removed becomes a chapter and loses its 所屬章 line', async () => {
  const r = await sectionRig({ titles: ['BookRoot', 'ChapA', 'SecA1', 'ChapB', 'ChapC'] });
  await r.runs.start(r.mapPath);
  assert.equal(await promptLine(r, 2, '所屬章'), '(1) ChapA');
  const base = r.script.author; let hit = false;
  r.script.author = async (input, n) => { if (!hit) { hit = true; await r.repo.updateMap(r.mapPath, d => { d.nodes.find(n2 => n2.id === r.nodes[2].id).parentId = r.nodes[0].id; d.nodes = d.nodes.filter(n2 => n2.id !== r.nodes[1].id); }); } return base(input, n); };
  await r.runs.confirmGate1(r.mapPath); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  assert.equal((await r.state()).pauseReason, 'map');
  await r.runs.keepBookMap(r.mapPath); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  assert.equal(await promptLine(r, 2, '所屬章'), undefined, 'no chapter line on what is a chapter now');
  assert.ok((await promptLine(r, 2, '上一章')).startsWith('(前言) BookRoot'), 'it has chapter neighbours now');
});


// ---- P5b: the chapter's independent AI proofread (check with the proof model, fix with the author model) ----
const problem = (request, id = 'P1') => ({ id, kind: 'fact', quote: request.body.slice(0, 11), verdict: 'problem', problem: 'wrong', fixable: true, suggestion: 'fix it', sources: [] });
const aiRig = (script = {}, over = {}) => rig({ ai: true, script, ...over });
const aiRuns = (r, kind, title) => r.stat.ai.filter(([k, request]) => k === kind && (title === undefined || request.title === title));
const runToEnd = async r => { await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath); };

test('ai chapter: check with the proof model, fix with the author model, re-check; the write keeps the body record clean (not a hand edit)', async () => {
  let fixed = false;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' && !fixed ? [problem(request)] : [], prior: [], dropped: {} }),
    aiFix: async request => { fixed = true; return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }]; }
  });
  await runToEnd(r);
  assert.deepEqual(aiRuns(r, 'proof', 'SecretTitleA').map(([, q]) => q.model), ['m3', 'm3'], 'checked, then re-checked, by the proof model');
  assert.deepEqual(aiRuns(r, 'fix').map(([, q]) => q.model), ['m2'], 'fixed by the author model');
  assert.equal(aiRuns(r, 'fix')[0][1].chapters[0].title, 'SecretTitleA');
  assert.match((await r.note(1)).detail, /Corrected b/);
  assert.equal(bodyStateRaw(r.raw(1)), 'clean', 'the program write is not read as a hand edit');
  const slot = (await r.state()).aiProof[r.nodes[1].id];
  assert.deepEqual([slot.done, slot.fixed, slot.incomplete, slot.open.length], [true, 1, undefined, 0]);
  assert.ok(r.stat.logs.some(line => /book-pipeline ai_fix /.test(line)) && r.stat.logs.some(line => /book-pipeline ai_proof /.test(line)));
  assert.ok(r.stat.logs.every(line => !/SecretBody|Corrected/.test(line)), 'no chapter text in the log');
  assert.equal(aiRuns(r, 'proof', 'SecretTitleA')[1][1].prior.length, 1, 'the re-check is told what was open');
});

test('ai chapter: a chapter the reader edited by hand is never sent to the author model; its problem stays open as hand_edited', async () => {
  let edited = false;
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleB' && !edited) { edited = true; await handEdit(r, 2); }
      return { checks: request.title === 'SecretTitleB' ? [problem(request)] : [], prior: [], dropped: {} };
    }
  });
  await runToEnd(r);
  assert.equal(aiRuns(r, 'fix').length, 0, 'no fix call for the hand-edited chapter');
  assert.ok((await r.note(2)).detail.includes(HAND), 'the reader\'s text is kept');
  const slot = (await r.state()).aiProof[r.nodes[2].id];
  assert.equal(slot.done, true);
  same(slot.open.map(item => item.reason), ['hand_edited']);
});

test('ai chapter: three failed checks end it as incomplete (never as solved) and the other chapters go on', async () => {
  const r = await aiRig({ aiProof: async request => { if (request.title === 'SecretTitleA') throw new Error('boom'); return { checks: [], prior: [], dropped: {} }; } });
  await runToEnd(r);
  assert.equal(aiRuns(r, 'proof', 'SecretTitleA').length, 3);
  const s = await r.state();
  assert.deepEqual([s.aiProof[r.nodes[1].id].done, s.aiProof[r.nodes[1].id].incomplete], [true, true]);
  assert.equal(s.aiProof[r.nodes[2].id].done, true); assert.equal(s.aiProof[r.nodes[2].id].incomplete, undefined);
});

test('ai chapter: a stop drops a late fix (nothing written, the attempt is given back); the resume fixes it once', async () => {
  const hold = defer();
  let calls = 0;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' && calls === 0 ? [problem(request)] : [], prior: [], dropped: {} }),
    aiFix: async request => { calls++; if (calls === 1) await hold.promise; return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }]; }
  });
  const running = r.runs.start(r.mapPath); await running; r.runs.confirmGate1(r.mapPath).catch(() => undefined);
  while (calls === 0) await tick();
  await r.runs.stop(r.mapPath); hold.resolve(); await settle(); while (r.runs.isRunning(r.mapPath)) await tick();
  let s = await r.state();
  const id = r.nodes[1].id;
  assert.equal(s.status, 'stopped');
  assert.ok(!(await r.note(1)).detail.includes('Corrected b'), 'the late result was not written');
  assert.deepEqual([s.aiProof[id].step, s.aiProof[id].attempts, s.aiProof[id].fixed], ['fix', 0, 0], 'the attempt came back');
  await r.runs.resume(r.mapPath); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  assert.equal(calls, 2);
  assert.equal((await r.note(1)).detail.split('Corrected b').length - 1, 1, 'fixed once');
  assert.equal((await r.state()).aiProof[id].fixed, 1);
});

test('ai chapter: without the three ports the AI proofread is off (an older host): the run ends as before', async () => {
  const r = await rig();
  await runToEnd(r);
  const s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.aiProof, undefined);
});

test('ai chapter: the budget running out during the fix pauses the run; addBudget resumes and the chapter is fixed once', async () => {
  let fixCalls = 0, applied = false;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' && !applied ? [problem(request)] : [], prior: [], dropped: {} }),
    aiFix: async (request, n, run) => {
      fixCalls++;
      if (fixCalls === 1) { for (;;) await run.admission.reserve(); } // the budget is gone: the reservation throws out of the call
      applied = true;
      return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }];
    }
  });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  let s = await r.state();
  const id = r.nodes[1].id;
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget');
  assert.ok(!(await r.note(1)).detail.includes('Corrected b'));
  await r.runs.resume(r.mapPath, { addBudget: 100 }); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal(fixCalls, 2, 'the fix is asked again once, not repeated after it was applied');
  assert.equal((await r.note(1)).detail.split('Corrected b').length - 1, 1);
  assert.equal(s.aiProof[id].fixed, 1);
});

// A fix only touches the text the model was shown: a quote that sits in a hidden callout is never replaced.
const hiddenFix = async (callout, quoteOf) => {
  let planted = false, callouts = '';
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleA' && !planted) {
        planted = true;
        await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => stampRaw(c.replace('<!-- visual-agent-map:detail:end -->', `\n> [!vam-book]- hidden\n> ${callout}\n<!-- visual-agent-map:detail:end -->`)), {});
        callouts = r.raw(1).match(/> \[!vam-book\]- hidden[\s\S]*?(?=<!-- visual-agent-map:detail:end)/)[0];
      }
      return { checks: request.title === 'SecretTitleA' ? [problem(request)] : [], prior: [], dropped: {} };
    },
    aiFix: async request => [{ id: 'P1', quote: quoteOf(request), replacement: 'Corrected b' }]
  });
  await runToEnd(r);
  return { r, callouts };
};

test('ai chapter fix: a sentence in the body and in a hidden callout is refused, the callout stays byte for byte', async () => {
  const { r, callouts } = await hiddenFix('SecretBody SecretTitleA', () => 'SecretBody SecretTitleA');
  assert.ok(callouts.includes('SecretBody SecretTitleA'));
  assert.ok(r.raw(1).includes(callouts), 'the callout is unchanged');
  assert.ok(!r.raw(1).includes('Corrected b'));
  same((await r.state()).aiProof[r.nodes[1].id].open.map(item => item.reason), ['fix_quote_missing']);
});

test('ai chapter fix: a quote only in a hidden callout is refused and nothing is written', async () => {
  const { r, callouts } = await hiddenFix('CalloutOnly words', () => 'CalloutOnly words');
  assert.ok(r.raw(1).includes(callouts));
  assert.ok(!r.raw(1).includes('Corrected b'));
  same((await r.state()).aiProof[r.nodes[1].id].open.map(item => item.reason), ['fix_quote_missing']);
});

// ---- P6a: the whole-book AI proofread (text only, over every chapter; fixes written chapter by chapter) ----
const bookProblem = (request, chapter, other) => ({ id: 'B1', kind: 'consistency', chapter, otherChapter: other, quote: request.chapters[chapter - 1].text, verdict: 'problem', problem: 'chapters disagree', fixable: true, suggestion: 'use one value', why: '', sources: [] });

test('ai book: a contradiction between chapters is found by the whole-book step, fixed in the chapter, re-checked, and the chapter proofread is not reopened', async () => {
  let fixed = false;
  const r = await aiRig({
    aiBookProof: async request => ({ checks: fixed ? [] : [bookProblem(request, 2, 3)], prior: fixed ? [{ id: 'B1', status: 'resolved' }] : [], dropped: {} }),
    aiFix: async request => { fixed = true; return [{ id: 'B1', chapter: 2, quote: request.chapters[1].text, replacement: 'Book corrected' }]; }
  });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  const s = await r.state();
  assert.equal(s.phase, 'done');
  const books = r.stat.ai.filter(([k]) => k === 'book');
  assert.equal(books.length, 2, 'checked, then re-checked');
  assert.equal(books[0][1].model, 'm3', 'by the proof model');
  same(books[0][1].chapters.map(c => c.title), ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB']);
  same(books[0][1].chapters.map(c => c.place), [{ kind: 'preface' }, { kind: 'chapter', chapter: 1 }, { kind: 'chapter', chapter: 2 }], 'the whole-book proofread gets each card\'s place (preface, then chapters 1 and 2), not only its list position');
  assert.equal(books[1][1].prior.length, 1, 'the re-check is told what was open');
  const fixes = aiRuns(r, 'fix');
  assert.equal(fixes.length, 1); assert.equal(fixes[0][1].model, 'm2', 'by the author model');
  assert.equal((await r.note(1)).detail.split('Book corrected').length - 1, 1);
  assert.equal(bodyStateRaw(r.raw(1)), 'clean');
  assert.equal(aiRuns(r, 'proof', 'SecretTitleA').length, 1, 'the chapter proofread did not start again');
  assert.equal(aiRuns(r, 'proof', 'SecretTitleB').length, 1);
  const slot = s.bookProof;
  assert.deepEqual([slot.done, slot.fixed, slot.incomplete, slot.open.length], [true, 1, undefined, 0]);
  assert.ok(r.stat.logs.every(line => !/SecretBody|Book corrected/.test(line)));
});

test('ai book: a fix that touches two chapters writes each chapter once; a hand-edited chapter is refused and its problem stays open', async () => {
  let edited = false;
  const r = await aiRig({
    aiBookProof: async request => {
      if (!edited) { edited = true; await handEdit(r, 2); }
      return { checks: [bookProblem(request, 2, 3), { ...bookProblem(request, 3, 2), id: 'B2' }], prior: [], dropped: {} };
    },
    aiFix: async request => [{ id: 'B1', chapter: 2, quote: request.chapters[1].text, replacement: 'Book corrected' }, { id: 'B2', chapter: 3, quote: request.chapters[2].text, replacement: 'Never' }]
  });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  const s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal((await r.note(1)).detail.split('Book corrected').length - 1, 1);
  assert.ok(!r.raw(2).includes('Never') && r.raw(2).includes(HAND), 'the reader\'s chapter is untouched');
  assert.ok(s.bookProof.open.some(item => item.id === 'B2' && item.reason === 'hand_edited'));
});

test('ai book: three failed whole-book checks end it as incomplete and the run still finishes', async () => {
  const r = await aiRig({ aiBookProof: async () => { throw new Error('boom'); } });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  const s = await r.state();
  assert.equal(s.phase, 'done');
  assert.deepEqual([s.bookProof.done, s.bookProof.incomplete], [true, true]);
  assert.equal(r.stat.ai.filter(([k]) => k === 'book').length, 3);
});

test('worst-case calls: every chapter redoes once, uses every AI round and nothing is ever solved; the runner\'s actual call count is the sum its steps made (P7 sets the budget formula from it)', async () => {
  const seen = new Set();
  for (const titles of [['SecretRootTitle', 'SecretTitleA'], ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB']]) {
    seen.clear();
    const r = await aiRig({
      // The first proof of every card is unmet (the one automatic redo), the later ones are met.
      proof: async request => { const first = !seen.has(request.title); seen.add(request.title); return { items: request.checklist.map(c => ({ id: c.id, type: c.type, status: first ? 'unmet' : 'met', note: 'x', sources: [] })), aggregate: first ? 'needs-review' : 'checked' }; },
      aiProof: async request => ({ checks: [problem(request)], prior: [], dropped: {} }),
      aiFix: async request => [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: request.chapters[0].text.slice(0, 11) }],
      aiBookProof: async request => ({ checks: [bookProblem(request, 1, 1)], prior: [], dropped: {} })
    }, { titles });
    await finishAi(r);
    const s = await r.state();
    const calls = r.stat.plan.length + r.stat.planEdit.length + r.stat.author.length + r.stat.proof.length + r.stat.ai.length;
    assert.equal(s.phase, 'done');
    assert.equal(s.budget.used, calls, 'the budget counts exactly the calls made');
    assert.equal(calls, (titles.length >= 3 ? 7 : 6) + 10 * titles.length, 'this mock: 1 global plan + 5 book calls (+ the plan edit with three cards or more) + 10 per card (no picture search here)');
  }
});

test('worst-case calls with picture search: every step uses its whole allowance (first-write picture searches each with a language retry, the diagram call, the redo, the expand passes, the AI rounds); the actual count equals the start card\'s estimate (the covers add nothing), and with a bare root (no picture slots) the cover search stays inside it; within the 300 limit', async () => {
  const { bookStartEstimate } = S.load('experiences/visual-map/book-pipeline-start-modal.ts', { obsidian: S.obsidian });
  const counted = new Map();
  for (const variant of ['plain', 'cover', 'cover-bare-root']) {
  const MARKED = `${DRAFT}\n\n〔圖位 1：the route〕\n\n〔圖位 2：a port〕\n\n〔圖位 3：the trade cycle〕\n`;
  const slots = [{ index: 1, kind: 'map', explains: 'the route', anchor: 'after paragraph 1' }, { index: 2, kind: 'photo', explains: 'a port', anchor: 'end' }, { index: 3, kind: 'flow chart', explains: 'the trade cycle', anchor: 'end' }];
  for (const titles of [['R', 'A'], ['R', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']]) {
    const seen = new Set();
    const author = [];
    let imageCalls = 0;
    let coverAsked = 0;
    let picked = 0;
    const holder = {};
    const r = await aiRig({
      card: request => ({ covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], images: variant === 'cover-bare-root' && request.card.kind === 'preface' ? [] : slots, ...(variant === 'plain' ? {} : { cover: { explains: 'a cover', search: ['route map', 'port'] } }) }),
      author: async input => {
        author.push(input.nodeId);
        await input.admission.reserve();
        const mine = author.filter(id => id === input.nodeId).length;
        const fix = input.requirements !== undefined;
        const answer = ['@@insert after: ### 土壤', `### 新節${mine}`, '', `新節段落${'好'.repeat(mine < 4 ? 8 : 90)}`].join('\n');
        const out = await holder.r.repo.updateNoteGuarded(input.path, { detail: fix ? answer : MARKED }, { authorize: input.authorize, finalize: input.finalize });
        return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
      },
      proof: async request => { const first = !seen.has(request.title); seen.add(request.title); return { items: request.checklist.map(c => ({ id: c.id, type: c.type, status: first ? 'unmet' : 'met', note: 'x', sources: [] })), aggregate: first ? 'needs-review' : 'checked' }; },
      aiProof: async request => ({ checks: [problem(request)], prior: [], dropped: {} }),
      aiFix: async request => [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: request.chapters[0].text.slice(0, 11) }],
      aiBookProof: async request => ({ checks: [bookProblem(request, 1, 1)], prior: [], dropped: {} })
    }, {
      titles,
      // One search call finds nothing; each call stands for up to BOOK_IMAGE_CALLS_PER_SEARCH model calls (the caption-language retry sits inside the real step).
      // The first search of a chapter offers 3 non-Commons pictures for position 1, which the AI looks at and finds not fitting (the whole look allowance is spent).
      ports: {
        findImages: async (request, run) => {
          if (request.slots.some(slot => slot.index === 0)) coverAsked++;
          for (let i = 0; i < 2; i++) { imageCalls++; await run.admission.reserve(); }
          if (request.again || !request.slots.some(slot => slot.index === 1)) return { bySlot: new Map(), found: 0, offTopic: 0 };
          const list = [1, 2, 3].map(n => { const id = ++picked; return { title: `Web ${id}`, caption: `c${id}`, url: `https://img${id}.example.org/p${id}.jpg`, source: `https://blog${id}.example.org/post` }; });
          return { bySlot: new Map([[1, list]]), found: 3, offTopic: 0 };
        },
        fetchPicture: async url => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`,
        lookAtImage: async (request, run) => { imageCalls++; await run.admission.reserve(); return { fits: false, caption: '' }; },
        // The diagram-kind slot 3 finds nothing, so each chapter asks for diagrams once (and gets none: the worst case spends the call).
        drawDiagrams: async (request, run) => { imageCalls++; await run.admission.reserve(); return []; }
      }
    });
    holder.r = r;
    await r.repo.writeBookSettings(r.nodes[0].path, { length: LEN_SETTING });
    await finishAi(r);
    const s = await r.state();
    const calls = r.stat.plan.length + r.stat.planEdit.length + r.stat.author.length + r.stat.proof.length + r.stat.ai.length + imageCalls;
    assert.equal(s.phase, 'done');
    assert.equal(s.budget.used, calls, 'the budget counts exactly the calls made');
    const estimate = bookStartEstimate(titles.length, titles.length).calls;
    assert.equal(estimate, (titles.length >= 3 ? 7 : 6) + 20 * titles.length, 'the estimate is the whole-book calls (the plan edit with three cards or more) and 20 per card (3 of them picture looks, 1 the diagram call); the covers add nothing');
    counted.set(`${variant}:${titles.length}`, calls);
    if (variant === 'cover-bare-root') {
      assert.ok(coverAsked >= 1, 'the bare root searched for its cover alone');
      assert.ok(calls <= estimate, `${titles.length} cards, bare root: ${calls} calls within the estimate ${estimate}`);
      assert.equal(calls, counted.get(`plain:${titles.length}`) - 4 - 3 - 1 + 2, 'the bare root swaps its own picture searches, looks and diagram call (none: no slots) for the one cover search with its language retry');
    } else {
      assert.equal(calls, estimate, `${titles.length} cards: every card with picture slots spends its whole allowance, and the cover adds none: the real maximum is the estimate`);
      assert.equal(calls, counted.get(`plain:${titles.length}`), 'with and without a cover the same number of calls');
    }
    assert.ok(calls <= estimate && calls <= 300);
    if (titles.length === 10 && variant === 'plain') assert.equal(estimate, 207);
  }
  }
});


// ---- R1 follow-ups: B3 rerun after done, M1 partial book fix, M2 chapter reasons, B1 skipped target ----
const pageText = v => pageFiles(v)[0]?.[1] ?? '';
const checkedTotal = s => Object.values(s.aiProof).reduce((sum, p) => sum + p.checked, 0) + s.bookProof.checked;

test('R1 B3: a chapter written again after done gets its AI proofread in the same job; the closing page, the bar numbers and the chapter box agree', async () => {
  const v = pageVault();
  let fixedA = false;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' && !fixedA ? [problem(request)] : [okCheck(request)], prior: [], dropped: {} }),
    aiFix: async request => { fixedA = true; return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }]; }
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  assert.equal((await r.state()).phase, 'done');
  const proofsBefore = aiRuns(r, 'proof', 'SecretTitleA').length;
  await rerun(r, 1);
  const s = await r.state();
  assert.equal(s.phase, 'done');
  const slot = s.aiProof[r.nodes[1].id];
  assert.ok(slot && slot.done, 'the rewritten chapter was proofread again');
  assert.ok(aiRuns(r, 'proof', 'SecretTitleA').length > proofsBefore);
  assert.match(pageText(v), new RegExp(`AI 校對查了 ${checkedTotal(s)} 項`), 'the page counts what the bar counts');
});

test('R1 M1: a whole-book fix that wrote chapter 1 and was refused on chapter 2 still records chapter 1 (fixed, a new text key)', async () => {
  let once = true;
  const r = await aiRig({
    aiBookProof: async request => ({ checks: once ? [bookProblem(request, 2, 3), { ...bookProblem(request, 3, 2), id: 'B2' }] : [], prior: [], dropped: {} }),
    aiFix: async request => {
      if (once) { once = false; await r.repo.updateNoteRawGuarded(r.nodes[2].path, c => c + '\nHANDMADE', {}); }
      return [{ id: 'B1', chapter: 2, quote: request.chapters[1].text, replacement: 'One corrected' }, { id: 'B2', chapter: 3, quote: request.chapters[2].text, replacement: 'Two corrected' }];
    }
  });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  const s = await r.state();
  assert.ok(r.raw(1).includes('One corrected'), 'the first chapter was written');
  assert.ok(s.bookProof.fixed >= 1, 'and it is counted as fixed');
  assert.ok(s.bookProof.fixes.every(fix => fix.chapterId === r.nodes[1].id), 'and recorded on the chapter it changed');
  same(await invariantsOf(r, pageVault()), []);
});

test('R1 M2: chapter reasons on the page: no body reads as "no text", a hand edit as a hand edit (never "a step failed")', async () => {
  const v = pageVault();
  const r = await aiRig({}, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  await r.repo.writePipelineFields(r.nodes[1].path, { pipelineStage: 'needs-review', pipelineIssue: 'write failed: no_body' });
  await r.repo.writePipelineFields(r.nodes[2].path, { pipelineStage: 'needs-review', pipelineIssue: 'write failed: hand_edited' });
  await rerun(r, 0);
  const text = pageText(v);
  assert.match(text, /SecretTitleA：這章沒有正文/);
  assert.match(text, /SecretTitleB：這章是你手改過的/);
  assert.doesNotMatch(text, /步驟失敗/);
});

test('R1 B1: the model skips one of two targets: only the applied one is a fix, and the number equals the list', async () => {
  let fixed = false;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' && !fixed ? [problem(request, 'P1'), { ...problem(request, 'P2'), quote: request.body.slice(12, 20) }] : [], prior: [], dropped: {} }),
    aiFix: async request => { fixed = true; return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }]; }
  });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  const slot = (await r.state()).aiProof[r.nodes[1].id];
  same(slot.fixes.map(item => item.id), ['P1']);
  assert.equal(slot.fixed, slot.fixes.length);
});

test('R1 T1: a chapter that ends needs-review (author check unmet) still gets its AI proofread; a chapter with no text is not sent', async () => {
  const seen = [];
  const r = await aiRig({ ...factCard, proof: async request => verdictOf(request, 'unmet', 'bad'), author: input => input.nodeId === r.nodes[2].id ? { outcome: 'written' } : writeAs(r, seen)(input) });
  await runToEnd(r); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  assert.equal(stageOf(r.raw(1)), 'needs-review');
  const s = await r.state();
  assert.ok(s.aiProof[r.nodes[1].id]?.done, 'the needs-review chapter was proofread');
  assert.ok(aiRuns(r, 'proof', 'SecretTitleA').length >= 1);
  assert.equal(aiRuns(r, 'proof', 'SecretTitleB').length, 0, 'the chapter with no text is not sent to the model');
  const empty = s.aiProof[r.nodes[2].id];
  assert.ok(empty?.done && empty.checked === 0 && !empty.incomplete, `empty chapter slot ${JSON.stringify(empty)}`);
});

// ---- R2 diagnostic reset: the AI slot lifecycle as invariants (I1-I4), checked after every combination of proof result, fix outcome, stop and budget ----
const { checkAiProofInvariants } = require('./support-ai-proof-invariants.cjs');
const { aiProofKey, aiProofBody } = S.load('core/book-pipeline/ai-proof.ts');
const currentKeys = async r => { const s = await r.state(); const keys = {}; for (const [i, n] of r.nodes.entries()) if (i > 0) { const note = await r.repo.readNote(n.path); keys[n.id] = aiProofKey(s.revisions[n.id] ?? 0, aiProofBody(chapterBody(note.detail))); } return keys; };
// The boxes the callouts writer wants from the saved state (same input as `BookCallouts.reconcile`; this rig does not run that writer).
const boxesOf = data => Object.fromEntries(Object.entries(data.aiProof ?? {}).filter(([, slot]) => slot.done || slot.incomplete).map(([id, slot]) => [id, review.aiProofCallout({ checked: slot.checked, fixed: slot.fixed, fixes: slot.fixes ?? [], bookFixes: (data.bookProof?.fixes ?? []).filter(fix => fix.chapterId === id), open: slot.open, ...(slot.incomplete ? { incomplete: true } : {}) }, data.runId, id)]));
const invariantsOf = async (r, v, extra = {}) => { const data = await r.state(); return checkAiProofInvariants(data, { stageOf: id => stageOf(r.raw(r.nodes.findIndex(n => n.id === id))), page: pageText(v), keys: await currentKeys(r), ...(data.phase === 'done' ? { boxes: boxesOf(data) } : {}), ...extra }); };
const plain = value => JSON.parse(JSON.stringify(value));
const idA = r => r.nodes[1].id;
const quoteOf = (request, from = 0, to = 11) => request.body.slice(from, to);
const probOf = (request, id = 'P1', from = 0, to = 11) => ({ ...problem(request, id), quote: quoteOf(request, from, to) });

test('R2 combo N1: the fix was written but the re-check still finds the (new) sentence: still_present, never "not fixed in time"', async () => {
  const v = pageVault(); const applied = [];
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' ? [probOf(request)] : [okCheck(request)], prior: [], dropped: {} }),
    aiFix: async request => { const replacement = `Corrected${applied.length + 1}`; applied.push(replacement); return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement }]; }
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  same(await invariantsOf(r, v, { applied: { [idA(r)]: applied } }), []);
  const slot = (await r.state()).aiProof[idA(r)];
  assert.deepEqual(plain(slot.open.map(i => i.reason)), ['still_present']);
});

test('R2 combo M-a: a refusal from an earlier round is not carried to a problem that reuses its id', async () => {
  const v = pageVault(); let fixes = 0;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' ? [fixes === 0 ? probOf(request) : probOf(request, 'P1', 12, 20)] : [okCheck(request)], prior: [], dropped: {} }),
    aiFix: async request => { fixes++; return fixes === 1 ? [{ id: 'P1', quote: 'not in the text', replacement: 'x' }] : []; }
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  same(await invariantsOf(r, v, { refusedQuotes: [] }), []);
  const slot = (await r.state()).aiProof[idA(r)];
  assert.deepEqual(plain(slot.open.map(i => i.reason)), ['not_fixed']);
});

test('R3 M-R3-1: the same quote comes back under a new id and the model skips it: the reason stays the round-1 refusal (D6), invariants empty', async () => {
  const v = pageVault(); let fixes = 0;
  const r = await aiRig({
    aiProof: async request => ({ checks: request.title === 'SecretTitleA' ? [probOf(request, fixes === 0 ? 'P1' : 'P2')] : [okCheck(request)], prior: [], dropped: {} }),
    aiFix: async request => { fixes++; return fixes === 1 ? [{ id: 'P1', quote: 'not in the text', replacement: 'x' }] : []; }
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  same(await invariantsOf(r, v, { refusedQuotes: (await r.state()).aiProof[idA(r)].open.map(i => i.quote) }), []);
  const slot = (await r.state()).aiProof[idA(r)];
  assert.deepEqual(plain(slot.open.map(i => i.reason)), ['fix_quote_missing']);
});

// A finished book, one chapter written again, and the run cut short while that chapter is being proofread again.
const cutRerun = async (how, stepOfCut) => {
  const v = pageVault(); let armed = false; const hold = defer(); let reached = false;
  const r = await aiRig({
    aiProof: async (request, n, run) => {
      const here = armed && request.title === 'SecretTitleA';
      if (here && stepOfCut === 'proof') { reached = true; if (how === 'budget') for (;;) await run.admission.reserve(); await hold.promise; }
      return { checks: [here && stepOfCut === 'fix' ? probOf(request) : okCheck(request)], prior: [], dropped: {} };
    },
    aiFix: async (request, n, run) => { reached = true; if (how === 'budget') for (;;) await run.admission.reserve(); await hold.promise; return []; }
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  assert.equal((await r.state()).phase, 'done');
  same(await invariantsOf(r, v), [], 'the finished book holds the invariants');
  armed = true;
  const running = r.runs.rerunCard(r.mapPath, idA(r)).catch(() => undefined);
  while (!reached && r.runs.isRunning(r.mapPath)) await tick();
  if (how === 'stop') { await r.runs.stop(r.mapPath); hold.resolve(); }
  if (how === 'dispose') { r.runs.dispose(); hold.resolve(); }
  await running;
  while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  // the plugin is unloaded: the map is opened again by a new session, which reads the finished book
  if (how === 'dispose') { const again = new BookPipelineRuns(r.ports); await again.repairFinished(r.mapPath); await settle(); }
  return { r, v };
};
for (const how of ['stop', 'budget', 'dispose']) for (const at of ['proof', 'fix']) {
  test(`R2 combo N2: a finished book, one chapter written again, ${how} during its AI ${at}: the chapter is incomplete and the page says so`, async () => {
    const { r, v } = await cutRerun(how, at);
    same(await invariantsOf(r, v), []);
    const s = await r.state();
    const slot = s.aiProof[idA(r)];
    assert.ok(slot?.done && slot.incomplete, `slot ${JSON.stringify(slot)}`);
    assert.match(pageText(v), /沒有跑完/i);
    assert.doesNotMatch(pageText(v), /全部解決/);
    same(await invariantsOf(r, v), []);
  });
}

// A "budget" in the proof step is a failing call here (the proof step retries it), so the budget cut is pinned on the fix step only.
for (const [how, at] of [['stop', 'proof'], ['stop', 'fix'], ['budget', 'fix']]) {
  test(`R2 combo first run: ${how} during the chapter's ${at}, then resume: every state on the way holds the invariants`, async () => {
    const v = pageVault(); const hold = defer(); let calls = 0, fixed = false;
    const r = await aiRig({
      aiProof: async (request, n, run) => {
        if (at === 'proof' && request.title === 'SecretTitleA' && ++calls === 1) { if (how === 'budget') for (;;) await run.admission.reserve(); await hold.promise; }
        return { checks: [request.title === 'SecretTitleA' && !fixed ? probOf(request) : okCheck(request)], prior: [], dropped: {} };
      },
      aiFix: async (request, n, run) => { if (at === 'fix' && ++calls === 1) { if (how === 'budget') for (;;) await run.admission.reserve(); await hold.promise; } fixed = true; return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }]; }
    }, { ports: { writeOpenIssues: v.port } });
    await r.runs.start(r.mapPath); r.runs.confirmGate1(r.mapPath).catch(() => undefined);
    while (calls === 0) await tick();
    if (how === 'stop') { await r.runs.stop(r.mapPath); hold.resolve(); }
    while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
    same(await invariantsOf(r, v), [], 'stopped');
    await r.runs.resume(r.mapPath, how === 'budget' ? { addBudget: 100 } : undefined); while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
    const s = await r.state();
    assert.equal(s.phase, 'done');
    same(await invariantsOf(r, v, { applied: { [idA(r)]: ['Corrected b'] } }), [], 'finished');
  });
}

// ---- R4: the chapter AI proofread waits for the author side to settle (a queued automatic redo), and a stale slot is proofread again ----
test('R4 combo: a needs-review chapter is rewritten by its one automatic redo BEFORE its chapter AI proofread; the AI fix stays in the final text (I5)', async () => {
  const v = pageVault(); const events = []; let fixed = false;
  const r = await aiRig({
    ...factCard,
    proof: async request => verdictOf(request, 'unmet', 'bad'),
    author: async input => { events.push(`author:${input.nodeId}`); return writeAs(r, [])(input); },
    aiProof: async request => { events.push(`ai:${request.title}`); return { checks: [request.title === 'SecretTitleA' && !fixed ? probOf(request) : okCheck(request)], prior: [], dropped: {} }; },
    aiFix: async request => { fixed = true; return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: 'Corrected b' }]; }
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  const lastAuthor = events.lastIndexOf(`author:${idA(r)}`);
  const firstAi = events.indexOf('ai:SecretTitleA');
  assert.ok(events.filter(e => e === `author:${idA(r)}`).length >= 2, `the automatic redo ran: ${events.join(',')}`);
  assert.ok(lastAuthor >= 0 && firstAi > lastAuthor, `the chapter AI proofread came after the last author write: ${events.join(',')}`);
  assert.ok(r.raw(1).includes('Corrected b'), 'the AI fix is in the final text');
  assert.equal((await r.state()).phase, 'done');
  same(await invariantsOf(r, v, { applied: { [idA(r)]: ['Corrected b'] } }), []);
});

// ---- gate presses while the drive that reached the gate is still ending ----------------------------------------------------------
/** A plan-review run whose start drive stays alive after it saved gate 1 (its next map read waits), plus controls over that wait. */
async function lingerRig(over = {}) {
  const r = await trialRig({ planReview: true, ...over });
  const ctl = { on: false, block: false, blocked: 0, fail: false, hold: defer() };
  const update = r.ports.updateMap, readMap = r.ports.readMap;
  r.ports.updateMap = async (path, change) => { const x = await update(path, change); const s = await r.state(); if (!ctl.on && s.phase === 'gate1' && s.planReview) { ctl.on = true; ctl.block = true; } return x; };
  r.ports.readMap = async path => { if (ctl.block) { ctl.blocked++; await ctl.hold.promise; if (ctl.fail) throw new Error('boom'); } return readMap(path); };
  const start = r.runs.start(r.mapPath);
  while (!ctl.blocked) await tick();
  ctl.block = false; // later reads (the press, the tests) pass; the drive stays held where it is
  assert.equal(r.runs.isRunning(r.mapPath), true, 'the drive that reached the gate is still ending');
  assert.equal((await r.state()).phase, 'gate1');
  const trace = async () => (await r.state()).gateTrace ?? [];
  const pending = p => { const box = { done: false }; p.then(() => { box.done = true; }, () => { box.done = true; }); return box; };
  return { r, ctl, start, trace, pending };
}

test('gate press while the gate-reaching drive is ending: waits, then applies once (startTrial and confirmGate1)', async () => {
  for (const action of ['startTrial', 'confirmGate1']) {
    const { r, ctl, start, trace, pending } = await lingerRig();
    const press = r.runs[action](r.mapPath); const box = pending(press);
    await settle();
    assert.equal(box.done, false, `${action} waits instead of refusing busy`);
    assert.equal(r.stat.author.length, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    ctl.hold.resolve();
    await start; await press; await idle(r);
    const s = await r.state();
    assert.equal(s.phase, 'done'); assert.equal(s.planReview, undefined);
    assert.ok(r.stat.author.length >= 3, 'writing started');
    const lines = await trace();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], new RegExp(`^2026-11-17T00:00:00.000Z ${action} applied wait=\\d+$`));
  }
});

test('gate press while waiting: a second click is refused busy and applies nothing twice; wrong-gate presses wait and are refused not_gate1', async () => {
  const { r, ctl, start, trace } = await lingerRig();
  const first = r.runs.startTrial(r.mapPath);
  await settle();
  await assert.rejects(() => r.runs.startTrial(r.mapPath), e => e.code === 'busy', 'double click');
  await assert.rejects(() => r.runs.confirmGate1(r.mapPath), e => e.code === 'busy', 'another gate press while one waits');
  const wrong = r.runs.backToPlan(r.mapPath).then(() => 'ok', e => e.code); // already at the plan: refused after the wait, but only the first waiter exists
  await settle();
  ctl.hold.resolve();
  await start; await first; await idle(r);
  assert.equal(await wrong, 'busy');
  assert.equal((await r.state()).phase, 'done');
  assert.equal(r.stat.plan.filter(x => x === 'global').length, 1, 'planned once');
  const lines = await trace();
  assert.equal(lines.filter(l => /startTrial applied/.test(l)).length, 1);
  assert.ok(lines.some(l => /startTrial refused:busy/.test(l)) && lines.some(l => /confirmGate1 refused:busy/.test(l)), JSON.stringify(lines));
});

test('gate press while the drive that reached the gate is ending: a stale-phase press (backToPlan at the plan) waits, then is refused not_gate1', async () => {
  const { r, ctl, start, trace } = await lingerRig();
  const press = r.runs.backToPlan(r.mapPath).then(() => 'ok', e => e.code);
  await settle();
  ctl.hold.resolve();
  await start;
  assert.equal(await press, 'not_gate1');
  const s = await r.state(); assert.equal(s.phase, 'gate1'); assert.equal(s.planReview, true);
  assert.match((await trace())[0], /backToPlan refused:not_gate1 wait=|backToPlan refused:not_gate1$/);
});

test('gate press while a gate phase is still working (a trial being written, no owner gate): refused busy at once, never waits', async () => {
  const r = await trialRig();
  const gate = defer(); const base = r.script.author; let held = 0;
  r.script.author = async input => { held++; await gate.promise; return base(input); };
  const start = r.runs.start(r.mapPath);
  while (!held) await tick();
  const s = await r.state();
  assert.ok(s.phase === 'gate1' || s.phase === 'writing' || s.phase === 'planning', s.phase);
  assert.equal(r.runs.isRunning(r.mapPath), true);
  for (const action of ['startTrial', 'retryTrial', 'backToPlan', 'finishRun', 'confirmGate1'])
    await assert.rejects(() => r.runs[action](r.mapPath), e => e.code === 'busy', action);
  gate.resolve(); await start; await idle(r);
});
test('gate press while a different operation runs (the plan phase) is refused busy at once and is traced', async () => {
  const gate = defer();
  const holder = { r: null };
  const r = await rig({ script: { global: async () => { await gate.promise; return { thread: 't', cards: holder.r.nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } }; } } });
  holder.r = r;
  const start = r.runs.start(r.mapPath);
  await settle();
  assert.equal(r.runs.isRunning(r.mapPath), true);
  for (const action of ['confirmGate1', 'startTrial', 'backToPlan', 'retryTrial', 'finishRun'])
    await assert.rejects(() => r.runs[action](r.mapPath), e => e.code === 'busy', action);
  gate.resolve(); await start;
  const lines = (await r.state()).gateTrace ?? [];
  assert.equal(lines.length, 5, JSON.stringify(lines));
  assert.ok(lines.every(l => /refused:busy$/.test(l)));
  assert.equal(r.stat.author.length, 0);
});

test('waiting gate press: the progress says gateWaiting while it waits, and progressed fires when the wait starts and ends', async () => {
  const seen = [];
  let runs;
  const { r, ctl, start } = await lingerRig({ ports: { progressed: () => seen.push(runs?.getProgress(r0.mapPath)?.gateWaiting === true) } });
  const r0 = r; runs = r.runs;
  assert.equal(r.runs.getProgress(r.mapPath)?.gateWaiting, undefined);
  seen.length = 0;
  const press = r.runs.startTrial(r.mapPath);
  await settle();
  assert.equal(r.runs.getProgress(r.mapPath)?.gateWaiting, true);
  assert.ok(seen.includes(true), 'progressed fired when the wait began');
  ctl.hold.resolve();
  await start; await press; await idle(r);
  assert.equal(r.runs.getProgress(r.mapPath)?.gateWaiting, undefined);
  assert.ok(seen.slice(seen.indexOf(true)).includes(false), 'progressed fired when the wait ended');
});

test('waiting gate press when the ending drive is stopped: the press does nothing (gate_cancelled), the run stays stopped at the gate', async () => {
  const { r, ctl, start, trace } = await lingerRig();
  const press = r.runs.startTrial(r.mapPath).then(() => 'ok', e => e.code);
  await settle();
  const stopping = r.runs.stop(r.mapPath);
  await settle();
  ctl.hold.resolve();
  await start; await stopping;
  assert.equal(await press, 'gate_cancelled');
  await settle();
  const s = await r.state();
  assert.deepEqual([s.phase, s.status, s.planReview], ['gate1', 'stopped', true]);
  assert.equal(r.stat.author.length, 0); assert.equal(r.runs.isRunning(r.mapPath), false, 'no drive was started');
  assert.match((await trace()).at(-1), /startTrial refused:gate_cancelled/);
});

test('waiting gate press when the ending drive fails: the press does nothing (gate_cancelled), does not hang, starts no drive', async () => {
  const { r, ctl, start, trace } = await lingerRig();
  const press = r.runs.confirmGate1(r.mapPath).then(() => 'ok', e => e.code);
  await settle();
  ctl.fail = true; ctl.hold.resolve();
  await start;
  assert.equal(await press, 'gate_cancelled');
  await settle();
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.notEqual(s.phase, 'done');
  assert.equal(r.stat.author.length, 0); assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.match((await trace()).at(-1), /confirmGate1 refused:gate_cancelled/);
});

test('waiting gate press when the plugin is disposed: refused disposed, nothing is written afterwards', async () => {
  const { r, ctl, start, trace } = await lingerRig();
  const press = r.runs.startTrial(r.mapPath).then(() => 'ok', e => e.code);
  await settle();
  r.runs.dispose();
  const before = r.mapRaw();
  ctl.hold.resolve();
  await start;
  assert.equal(await press, 'disposed');
  await settle();
  assert.equal(r.mapRaw(), before, 'no late write-back, not even a trace line');
  assert.equal(r.stat.author.length, 0);
});

test('the gate trace is capped, kept by the drive\'s own state writes, and the run file still reads', async () => {
  const r = await trialRig({ planReview: true });
  await r.runs.start(r.mapPath);
  for (let i = 0; i < 25; i++) await assert.rejects(() => r.runs.backToPlan(r.mapPath), e => e.code === 'not_gate1');
  let s = await r.state();
  assert.equal(s.gateTrace.length, 20);
  await r.runs.startTrial(r.mapPath); await idle(r);
  s = await r.state();
  assert.equal(s.phase, 'done'); assert.equal(s.gateTrace.length, 20, 'later state writes keep the trace');
  assert.match(s.gateTrace.at(-1), /startTrial applied/);
  assert.ok(s.gateTrace.every(l => !/Secret/.test(l)), 'no owner text');
});

// ---- Picture work does not hold a write place: its own cap (BOOK_POST_POOL) ----
const { BOOK_POOL, BOOK_POST_POOL } = S.load('experiences/visual-map/book-pipeline-run.ts');
const { MAX_STEP_ATTEMPTS } = S.load('core/book-pipeline/model.ts');
async function postRig(count, over = {}) {
  const titles = Array.from({ length: count }, (_, i) => `T${i}`);
  const gates = new Map();
  const live = { writes: 0, peakWrites: 0, searches: 0, peakSearches: 0, proofs: 0, peakPost: 0, started: [] };
  const MARKED = `${DRAFT}\n\n〔圖位 1：the route〕\n`;
  const slots = [{ index: 1, kind: 'map', explains: 'the route', anchor: 'after paragraph 1' }];
  const holder = {};
  const post = () => live.searches + live.proofs;
  const r = await rig({
    titles,
    script: {
      card: request => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], images: slots }),
      author: async input => {
        live.writes++; live.peakWrites = Math.max(live.peakWrites, live.writes); live.started.push(input.nodeId);
        try {
          await input.admission.reserve();
          await tick();
          const out = await holder.r.repo.updateNoteGuarded(input.path, { detail: `${MARKED}\n唯一${input.nodeId}\n` }, { authorize: input.authorize, finalize: input.finalize });
          return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
        } finally { live.writes--; }
      },
      proof: async request => { live.proofs++; live.peakPost = Math.max(live.peakPost, post()); await tick(); live.proofs--; return { items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'x', sources: [] })), aggregate: 'checked' }; }
    },
    ports: {
      findImages: async (request, run) => {
        live.searches++; live.peakSearches = Math.max(live.peakSearches, live.searches); live.peakPost = Math.max(live.peakPost, post());
        const key = request.chapter;
        if (!gates.has(key)) gates.set(key, defer());
        try {
          await new Promise((resolve, reject) => { gates.get(key).promise.then(resolve); run.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
          return { bySlot: new Map(), found: 0, offTopic: 0 };
        } finally { live.searches--; }
      },
      ...over.ports
    }
  });
  holder.r = r;
  return { r, live, gates };
}
const open = gates => { for (const g of gates.values()) g.resolve(); };

test('picture work: with every search held open, more than BOOK_POOL writes complete and later cards start writing; writes never exceed BOOK_POOL, picture work never exceeds BOOK_POST_POOL', async () => {
  const cards = BOOK_POOL + BOOK_POST_POOL + 2; // more cards than both caps together, so both fill
  const { r, live, gates } = await postRig(cards);
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(live.searches, BOOK_POST_POOL, 'the picture searches fill their own cap');
  assert.ok(live.started.length > BOOK_POOL + BOOK_POST_POOL - 1, `later cards started writing while searches are open: ${live.started.length}`);
  assert.ok(live.peakWrites <= BOOK_POOL, `writes at most BOOK_POOL: ${live.peakWrites}`);
  assert.ok(live.peakSearches <= BOOK_POST_POOL, `searches at most the cap: ${live.peakSearches}`);
  // Let everything finish, searches included.
  for (let i = 0; i < 400 && r.runs.isRunning(r.mapPath); i++) { open(gates); await tick(); }
  await running;
  assert.equal((await r.state()).phase, 'done');
  assert.ok(live.peakWrites <= BOOK_POOL && live.peakSearches <= BOOK_POST_POOL && live.peakPost <= BOOK_POST_POOL, `peaks ${live.peakWrites}/${live.peakSearches}/${live.peakPost}`);
  assert.equal(new Set(live.started).size, cards);
});

test('picture work: a card is proofread only after its own pictures settled, while others still search', async () => {
  const { r, live, gates } = await postRig(4);
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(r.stat.proof.length, 0, 'no proofread while every card is still searching');
  assert.ok(gates.size >= 2, `one gate per card: ${gates.size}`);
  const first = [...gates.values()][0];
  first.resolve();
  await settle();
  assert.ok(r.stat.proof.length >= 1, 'the card whose pictures settled is proofread');
  assert.ok(r.stat.proof.length < 4, 'others are not');
  for (const request of r.stat.proof) assert.ok(/^T\d+$/.test(request.title));
  for (let i = 0; i < 400 && r.runs.isRunning(r.mapPath); i++) { open(gates); await tick(); }
  await running;
  assert.equal((await r.state()).phase, 'done');
});

test('picture work: stop while writes and searches are both in flight cancels both and leaves no late write-back', async () => {
  const { r, live, gates } = await postRig(12);
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.ok(live.searches > 0 && live.started.length > BOOK_POST_POOL);
  await r.runs.stop(r.mapPath);
  await running.catch(() => undefined);
  const before = r.mapRaw();
  const notes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => r.raw(i));
  const authored = r.stat.author.length;
  open(gates);
  await settle();
  assert.equal(live.searches, 0, 'no search left running');
  assert.equal(r.stat.author.length, authored, 'no new write after the stop');
  assert.equal(r.mapRaw(), before, 'the saved run is unchanged by late results');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => r.raw(i)), notes, 'no card text changed after the stop');
  const s = await r.state();
  assert.equal(s.status, 'stopped');
  for (let i = 0; i < 12; i++) assert.notEqual(stageOf(r.raw(i)), 'checked');
});

// ---- The automatic redo of a card starts once that card's own first round is over, not when the whole book is idle ----
// Card T1's first proofread names an unmet fact; T2's picture search (and optionally its AI proofread) is held open.
async function earlyRig(over = {}) {
  const titles = Array.from({ length: over.count ?? 3 }, (_, i) => `T${i}`);
  const gates = new Map();
  const live = { calls: new Map(), peak: new Map(), seen: [], book: 0, proofOrder: [], stages: [], proofsAtBook: undefined };
  const MARKED = `${DRAFT}\n\n〔圖位 1：the route〕\n`;
  const slots = [{ index: 1, kind: 'map', explains: 'the route', anchor: 'after paragraph 1' }];
  const holder = {};
  const heldAi = defer();
  let clock = 0;
  const r = await rig({
    titles, ai: !!over.ai,
    script: {
      card: () => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: FACTS, images: slots }),
      author: async input => {
        const id = input.nodeId;
        live.calls.set(id, (live.calls.get(id) ?? 0) + 1); live.peak.set(id, Math.max(live.peak.get(id) ?? 0, live.calls.get(id)));
        live.seen.push([id, input.instruction]);
        try {
          if (over.holdAuthorOfRedo && input.instruction !== undefined) await over.holdAuthorOfRedo.promise;
          await input.admission.reserve();
          await tick();
          const detail = input.requirements !== undefined ? fixOf(`唯一${id}`, `唯一${id} 補`) : `${MARKED}\n唯一${id}\n`;
          const out = await holder.r.repo.updateNoteGuarded(input.path, { detail }, { authorize: input.authorize, finalize: input.finalize });
          return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
        } finally { live.calls.set(id, live.calls.get(id) - 1); }
      },
      proof: async request => { live.proofOrder.push(request.title); return verdictOf(request, request.title === 'T1' && !live.proofOrder.slice(0, -1).includes('T1') ? 'unmet' : 'met', 'WRONGDATE'); },
      aiProof: async request => { if (over.holdAi && request.title === 'T2') await heldAi.promise; return { checks: [], prior: [], dropped: {} }; },
      aiBookProof: async () => { live.book++; live.proofsAtBook = live.proofOrder.length; return { checks: [], prior: [], dropped: {} }; }
    },
    ports: {
      now: () => new Date(Date.UTC(2026, 10, 17) + (clock += 1000)).toISOString(),
      writePipelineFields: async (path, patch) => {
        if (over.stageGate && path === holder.r.nodes[1].path && patch.pipelineStage) {
          live.stages.push(patch.pipelineStage);
          if (patch.pipelineStage === 'needs-review') await over.stageGate.promise;
        }
        return holder.r.repo.writePipelineFields(path, patch);
      },
      findImages: async (request, run) => {
        const key = request.chapter;
        if (!gates.has(key)) gates.set(key, defer());
        if (!key.includes('T2') || over.freeImages) gates.get(key).resolve();
        await new Promise((resolve, reject) => { gates.get(key).promise.then(resolve); run.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
        return { bySlot: new Map(), found: 0, offTopic: 0 };
      }
    }
  });
  holder.r = r;
  return { r, live, gates, heldAi };
}
const redoSeen = (live, title) => live.seen.filter(([id, instruction]) => id === title && instruction !== undefined);

test('early redo: a card whose first round ended starts its automatic redo while another card\'s picture search is still open', async () => {
  const { r, live, gates } = await earlyRig();
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.ok([...gates.keys()].some(k => k.includes('T2')), 'T2 search is held');
  const redo = live.seen.filter(([id, instruction]) => id === r.nodes[1].id && instruction !== undefined);
  assert.equal(redo.length, 1, 'T1 redo author call started before T2\'s pictures were released');
  assert.match(redo[0][1], /"a date \/ WRONGDATE"/);
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1);
  for (let i = 0; i < 400 && r.runs.isRunning(r.mapPath); i++) { open(gates); await tick(); }
  await running;
  assert.equal((await r.state()).phase, 'done');
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1, 'still one redo');
});

const drain = async (r, gates) => { for (let i = 0; i < 400 && r.runs.isRunning(r.mapPath); i++) { open(gates); await tick(); } };

test('early redo: another card\'s AI proofread still running does not hold the redo back', async () => {
  const { r, live, gates, heldAi } = await earlyRig({ ai: true, holdAi: true, freeImages: true });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.ok(r.stat.ai.some(([kind, request]) => kind === 'proof' && request.title === 'T2'), 'T2 AI proofread is held open');
  assert.equal(redoSeen(live, r.nodes[1].id).length, 1, 'T1 redo started while T2 AI proofread is held');
  assert.equal(live.book, 0);
  heldAi.resolve(); await drain(r, gates); await running;
  assert.equal((await r.state()).phase, 'done');
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1);
});

test('early redo: stop and resume during the redo never dispatch twice: one redo, one call per card at a time, step attempts within the limit', async () => {
  const hold = defer();
  const { r, live, gates } = await earlyRig({ holdAuthorOfRedo: hold });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(redoSeen(live, r.nodes[1].id).length, 1);
  await r.runs.stop(r.mapPath);
  hold.resolve(); await running.catch(() => undefined); await settle();
  const resumed = r.runs.resume(r.mapPath);
  await drain(r, gates); await resumed; await settle();
  assert.equal(live.seen.filter(([id]) => id === r.nodes[1].id).length, 2, 'T1: one first round and one redo, no more');
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1);
  assert.equal((await r.note(1)).pipelineIssue, 'proof unmet: fix interrupted');
  assert.ok(live.seen.filter(([id]) => id === r.nodes[2].id).length <= MAX_STEP_ATTEMPTS, 'T2 write attempts within the limit');
  for (const [id, peak] of live.peak) assert.ok(peak <= 1, `no card had two author calls at once: ${id}`);
});

test('early redo: the whole-book proofread waits for every card, the redone one included', async () => {
  const { r, live, gates } = await earlyRig({ ai: true });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(redoSeen(live, r.nodes[1].id).length, 1);
  assert.equal(live.book, 0, 'no whole-book proofread while T2 searches and T1 is redone');
  await drain(r, gates); await running;
  assert.equal(live.book, 1);
  assert.equal(live.proofsAtBook, 4, 'after the last proofread of every card (T0, T1, T2 and the redone T1)');
});

test('early redo: a card whose own proofread result is still being saved is not taken by the redo; its result is committed first', async () => {
  const stageGate = defer();
  const { r, live, gates } = await earlyRig({ stageGate });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.deepEqual(live.stages.filter(x => x === 'needs-review'), ['needs-review'], 'T1 reached the held needs-review write');
  open(gates); await settle(); // another card finishes and wakes the loop
  assert.equal(redoSeen(live, r.nodes[1].id).length, 0, 'no redo while the card is still in its step');
  assert.equal((await r.state()).autoFixes?.[r.nodes[1].id], undefined, 'revision untouched, no use counted');
  stageGate.resolve(); await drain(r, gates); await running;
  const s = await r.state();
  assert.equal(s.phase, 'done');
  assert.equal(s.autoFixes[r.nodes[1].id], 1, 'one redo');
  assert.equal(redoSeen(live, r.nodes[1].id).length, 1);
  assert.equal(r.stat.proof.filter(p => p.title === 'T1').length, 2, 'the first proofread result was kept, then the redo was proofread');
  assert.ok(live.stages.indexOf('needs-review') < live.stages.lastIndexOf('planned'), 'needs-review is written before the card goes back to planned');
});

test('early redo: the estimate counts a card whose redo is queued', async () => {
  const stageGate = defer();
  const { r, live, gates } = await earlyRig({ count: 6, freeImages: true, stageGate });
  await r.runs.start(r.mapPath);
  const running = r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.deepEqual(live.stages.filter(x => x === 'needs-review'), ['needs-review'], 'T1 is held at its needs-review write, its redo queued');
  assert.equal(r.runs.getProgress(r.mapPath).etaSeconds > 0, true, 'five finished cards, one still owed a redo: an estimate above zero');
  stageGate.resolve(); await drain(r, gates); await running;
  assert.equal((await r.state()).autoFixes[r.nodes[1].id], 1);
});

test('ai chapter: one failed card read does not end the chapter check; the read is tried once more', async () => {
  let throws = 0;
  const r = await aiRig({}, {
    ports: { readCard: async path => { if (throws === 0 && path === r.nodes[1].path && /aiChapter/.test(new Error().stack)) { throws++; throw new Error('read boom'); } return r.__readCard(path); } } });
  r.__readCard = path => r.repo.readNote(path).then(note => ({ path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: r.contents.get(path), settings: note.bookSettings ?? {}, fields: {} }));
  await runToEnd(r);
  assert.equal(throws, 1, 'the read failed once');
  assert.equal(aiRuns(r, 'proof', 'SecretTitleA').length, 1, 'the chapter was still checked');
  const slot = (await r.state()).aiProof[r.nodes[1].id];
  assert.deepEqual([slot.done, slot.incomplete], [true, undefined]);
});

// ---- the chief editor's pass over the plans (every card planned, one call, before gate 1) ----
const promptOf = async (r, i) => (await r.note(i)).prompt;
const CL = [{ type: 'structure', text: 'names the earlier ideas "X" and "Y" and states that they lead to "Z"' }];
const coversLine = prompt => /^本章會講[:：].*$/m.exec(prompt)?.[0];

test('plan edit: one call sees every card; a change rewrites only the named card\'s Prompt and keeps its other lines and the others untouched', async () => {
  const plainRig = await rig();
  await plainRig.runs.start(plainRig.mapPath);
  const before = [];
  for (let i = 0; i < 3; i++) before.push(await promptOf(plainRig, i));
  assert.equal(plainRig.stat.planEdit.length, 1, 'the pass is one call');
  assert.deepEqual([...plainRig.stat.planEdit[0].cards.map(c => c.title)], TITLES, 'it reads every card, in reading order');
  const r = await rig({ script: { planEdit: request => [{ id: request.cards[1].id, covers: 'edited covers', previous: 'edited previous', checklist: CL }] } });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.planEdited, true);
  assert.equal(await promptOf(r, 0), before[0].replace('SecretTitleA — n', 'SecretTitleA — edited covers'), 'the card before: only its next line follows the new covers');
  assert.equal(await promptOf(r, 2), before[2], 'the card after: its previous sentence (the plan\'s own) is untouched');
  const after = await promptOf(r, 1);
  assert.match(after, /本章會講[:：]\s*edited covers/);
  assert.match(after, /edited previous/);
  assert.deepEqual([...parseChecklist(after).map(c => c.text)], CL.map(c => c.text), 'the checklist is the replacement');
  assert.equal(after.replace('edited covers', 'covers 2').replace('edited previous', 'p').replace(CL[0].text, 'has a beginning'), before[1].replace(/\n- C2 .*/, ''), 'every other line is carried over');
  assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.ok(r.stat.logs.some(line => /plan_edit/.test(line) && /ok/.test(line)));
});

test('plan edit: a Prompt the owner edited while the call ran is not overwritten', async () => {
  const holder = {};
  const r = await rig({ script: { planEdit: async request => { await holder.r.repo.updateNoteGuarded(holder.r.nodes[1].path, { prompt: 'the owner wrote this' }, {}); return [{ id: request.cards[1].id, covers: 'edited covers', checklist: CL }, { id: request.cards[2].id, covers: 'edited covers', checklist: CL }]; } } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  assert.equal(await promptOf(r, 1), 'the owner wrote this');
  assert.match(await promptOf(r, 2), /edited covers/, 'the other card is still edited');
  assert.equal((await r.state()).planEdited, true);
});

test('plan edit: a stop during the call writes nothing and sets no flag; the pass runs again after a resume', async () => {
  const hold = defer();
  const holder = {};
  let first = true;
  const r = await rig({ script: { planEdit: async request => { if (first) { first = false; await hold.promise; } return [{ id: request.cards[1].id, covers: 'edited covers', checklist: CL }]; } } });
  holder.r = r;
  const started = r.runs.start(r.mapPath);
  await settle();
  const old = await promptOf(r, 1);
  await r.runs.stop(r.mapPath, { saved: true });
  hold.resolve();
  await started.catch(() => undefined); await settle();
  let s = await r.state();
  assert.equal(s.planEdited, undefined, 'no flag'); assert.equal(s.planEditAttempts, undefined, 'the attempt is given back');
  assert.equal(await promptOf(r, 1), old, 'nothing written');
  await r.runs.resume(r.mapPath); await settle();
  s = await r.state();
  assert.equal(r.stat.planEdit.length, 2, 'the pass reran');
  assert.equal(s.planEdited, true); assert.equal(s.phase, 'gate1');
  assert.match(await promptOf(r, 1), /edited covers/);
});

test('plan edit: a failing call is tried three times, writes nothing, and the book goes on to gate 1 (no card is marked)', async () => {
  const r = await rig({ script: { planEdit: () => { throw new Error('Bad reply'); } } });
  const old = [];
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(r.stat.planEdit.length, 3);
  assert.equal(s.planEditAttempts, 3); assert.equal(s.planEdited, true); assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  for (let i = 0; i < 3; i++) { assert.equal(stageOf(r.raw(i)), 'planned'); old.push(await promptOf(r, i)); assert.match(old[i], /本章會講[:：]\s*covers/); }
  assert.ok(r.stat.logs.some(line => /plan_edit/.test(line) && /failed/.test(line)));
  assert.equal(s.budget.used, 1 + 3 + 3, 'every attempt is a call');
});

test('plan edit: a reload of the same planning run does not call the pass again; a replan (retryTrial) calls it again; the budget counts the call', async () => {
  const r = await rig({ trial: true, planReview: true, titles: ['R', 'A', 'B', 'C'] });
  await r.runs.start(r.mapPath);
  let s = await r.state();
  assert.equal(r.stat.planEdit.length, 1); assert.equal(s.planEdited, true);
  assert.equal(s.budget.used, 1 + 4 + 1);
  // the same run, back in planning, in a new runner: the flag keeps the pass from running again
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'planning'; });
  const again = new r.runs.constructor(r.ports);
  await again.resume(r.mapPath).catch(() => undefined); await settle();
  assert.equal(r.stat.planEdit.length, 1, 'not again after a reload');
  s = await r.state();
  assert.equal(s.phase, 'gate1');
  // a replan clears the flag
  await again.retryTrial(r.mapPath); await settle();
  assert.equal(r.stat.planEdit.length, 2, 'the replan runs the pass again');
});

test('plan edit: a book whose plans do not fit one request is refused before any call (plans_too_long), the attempts are used up and the book goes on to gate 1', async () => {
  const titles = Array.from({ length: 40 }, (_, i) => `Card ${i}`);
  const long = n => `${'x'.repeat(380)}${n}`;
  const r = await rig({ titles, script: { card: () => ({ covers: long(1), entry: long(2), handoff: long(3), previous: long(4), next: long(5), checklist: Array.from({ length: 8 }, (_, i) => ({ id: `C${i + 1}`, type: 'structure', text: long(i) })) }) } });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(r.stat.planEdit.length, 0, 'no call was made');
  assert.ok(r.stat.logs.some(line => line.includes('plan_refused') && line.includes('plans_too_long')), 'logged');
  assert.equal(s.planEditAttempts, 3); assert.equal(s.planEdited, true); assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  assert.ok(r.stat.logs.some(line => /plan_edit/.test(line) && /failed:/.test(line)));
  assert.equal(s.budget.used, 1 + 40, 'the refused attempts cost no call');
});

test('plan edit: one change to covers, points or previous without its replacement checklist makes the whole reply fail: nothing is written (a subject moved from one card to another cannot vanish), the attempt counts, and after the cap the run goes on', async () => {
  const r = await rig({ script: { planEdit: request => [{ id: request.cards[1].id, covers: 'edited covers' }, { id: request.cards[2].id, covers: 'moved here', points: ['a', 'b', 'c'], checklist: CL }] } });
  await r.runs.start(r.mapPath);
  const before = await rig();
  await before.runs.start(before.mapPath);
  for (const i of [0, 1, 2]) assert.equal(await promptOf(r, i), await promptOf(before, i), `card ${i} is as planned`);
  assert.equal((await r.note(1)).summary, 'covers 2', 'the summary stays too');
  assert.equal(r.stat.planEdit.length, 3, 'each rejected reply counts as an attempt, up to the cap');
  assert.equal((await r.state()).planEdited, true, 'after the cap the run passes on');
});

test('plan edit: a checklist sent without a covers, points or previous change is ignored; the rest of the change applies', async () => {
  const r = await rig({ script: { planEdit: request => [{ id: request.cards[2].id, entry: 'edited entry', checklist: CL }] } });
  await r.runs.start(r.mapPath);
  const two = await promptOf(r, 2);
  assert.match(two, /edited entry/); assert.deepEqual([...parseChecklist(two).map(c => c.text)], ['has a beginning', 'has an end']);
  assert.equal((await r.state()).planEdited, true);
});

test('plan edit: new covers also set the map summary; a locked card (kept, hand-edited) is marked in the request and its change is dropped', async () => {
  const r = await rig({ script: { planEdit: request => request.cards.slice(1).map(card => ({ id: card.id, covers: `edited ${card.title}`, checklist: CL })) } });
  const RESEARCH = '### 核心結論\n\n這是讀者自己的研究正文。';
  await r.repo.updateNoteGuarded(r.nodes[2].path, { detail: RESEARCH }, {});
  const before2 = await promptOf(r, 2);
  await r.runs.start(r.mapPath);
  const request = r.stat.planEdit[0];
  assert.deepEqual([...request.cards.map(c => !!c.locked)], [false, false, true], 'only the hand-written card is locked');
  assert.equal((await r.note(1)).summary, 'edited SecretTitleA', 'the summary follows the covers like the plan step writes it');
  assert.match(await promptOf(r, 1), /本章會講[:：]\s*edited SecretTitleA/);
  assert.equal(await promptOf(r, 2), before2, 'the locked card keeps its plan');
  assert.equal((await r.note(2)).summary, 'summary of SecretTitleB', 'and its summary');
});

// ---- the editor's structure changes (P2a): apply, fences, failures ------------------------------------------------------------------
const { createBookStructurePort } = S.load('experiences/visual-map/book-structure-port.ts', { obsidian: S.obsidian });
const { bookReadingOrder } = S.load('experiences/visual-map/presentation-order.ts');
const { mapDifference } = S.load('core/book-pipeline/model.ts');
/** A rig whose global plan carries `structure(r)`; the real structure port runs over the fixture repository (`wrap(repo)` may make it fail). */
async function structureRig(structure, over = {}) {
  const holder = {};
  const requests = { global: [], card: [] };
  const r = await rig({
    ...over,
    script: {
      global: request => { requests.global.push(request); return { ...planRoles(holder.r, ['intro', 'body', 'body']), structure: structure(holder.r) }; },
      card: request => { requests.card.push(request); return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }; },
      ...over.script
    }
  });
  holder.r = r;
  const repo = over.wrap ? over.wrap(r.repo) : r.repo;
  r.ports.editBookStructure = (mapPath, work) => createBookStructurePort({ repo, rebuildDerivedData: over.rebuild ?? (async () => undefined) })(mapPath, work);
  r.runs.ports = r.ports;
  return { r, requests };
}
const mapNow = async r => r.repo.readMap(r.mapPath);
const idsNow = async r => bookReadingOrder(await mapNow(r));
const SOP = (r) => [
  { id: 'o1', kind: 'merge', card: r.nodes[2].id, into: r.nodes[1].id, reason: 'same ground' },
  { id: 'o2', kind: 'add', ref: 'n1', title: 'NewChapter', summary: 'fresh summary', parent: r.nodes[0].id, after: r.nodes[1].id, reason: 'gap' },
  { id: 'o3', kind: 'rename', card: r.nodes[1].id, title: 'RenamedA', reason: 'clearer' }
];
const newRunner = r => new BookPipelineRuns(r.ports);

test('P2a apply: add, merge (archive) and rename in one transaction; the map and the run agree and the run never pauses for the map change', async () => {
  const { r, requests } = await structureRig(SOP);
  const bRaw = r.raw(2);
  const bPath = r.nodes[2].path;
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  assert.notEqual(s.pauseReason, 'map');
  assert.ok(!r.stat.logs.some(l => /map_changed/.test(l)), 'pauseOnMapChange never fired');
  const map = await mapNow(r);
  same(mapDifference(s, bookReadingOrder(map)), { added: [], missing: [] });
  assert.equal(s.order.length, 3);
  same(s.order, bookReadingOrder(map));
  assert.equal(s.order[0], r.nodes[0].id); assert.equal(s.order[1], r.nodes[1].id);
  const created = s.order[2];
  assert.ok(![r.nodes[1].id, r.nodes[0].id, r.nodes[2].id].includes(created));
  assert.equal((await r.repo.readNote(map.nodes.find(n => n.id === created).path)).title, 'NewChapter');
  assert.equal((await r.repo.readNote(map.nodes.find(n => n.id === r.nodes[1].id).path)).title, 'RenamedA');
  assert.equal(s.chapters[r.nodes[1].id].title, 'RenamedA');
  assert.equal(s.structureEdit.runId, s.runId);
  assert.equal(s.structureEdit.applied.length, 3);
  assert.equal(s.structureEdit.applied.find(a => a.id === 'o2').op.ref, created, 'the ref became the real id');
  assert.equal(s.structureEdit.applied.find(a => a.id === 'o1').before.summary, 'summary of SecretTitleB');
  const archivePath = s.structureEdit.archived[r.nodes[2].id];
  assert.match(archivePath, /\/Archive\//);
  const bodyOf2 = raw => raw.slice(raw.indexOf('\n---\n') + 5);
  assert.equal(bodyOf2(r.contents.get(archivePath)), bodyOf2(bRaw), 'the archived note keeps its text (only the lifecycle fields change)');
  assert.match(r.contents.get(archivePath), /title: SecretTitleB/);
  assert.ok(!r.contents.has(bPath), 'and no longer in Notes');
  assert.ok(r.stat.logs.some(l => /structure_edit/.test(l) && /add:1_remove:0_merge:1_move:0_rename:1_rejected:0/.test(l)), 'the log has counts only');
  assert.ok(!r.stat.logs.some(l => /NewChapter|RenamedA|fresh summary/.test(l)));
  // The merge target's plan carries the folded card; the new card is planned.
  const target = requests.card.find(q => q.card.id === r.nodes[1].id);
  same(target.mergedFrom, [{ title: 'SecretTitleB', summary: 'summary of SecretTitleB' }]);
  assert.ok(requests.card.some(q => q.card.id === created), 'the new card is planned');
  assert.ok(!requests.card.some(q => q.card.id === r.nodes[2].id), 'the archived card is not');
  assert.ok(!requests.card.find(q => q.card.id === created).mergedFrom);
});

test('P2a a second global reply of the same run applies nothing again', async () => {
  const { r } = await structureRig(SOP);
  await r.runs.start(r.mapPath);
  const s1 = await r.state();
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.globalPlanned = false; d.bookPipeline.phase = 'planning'; d.bookPipeline.attempts.global = 0; });
  const before = JSON.stringify((await mapNow(r)).nodes.map(n => n.id));
  const again = newRunner(r);
  await again.resume(r.mapPath); await settle();
  const s2 = await r.state();
  assert.equal(r.stat.plan.filter(x => x === 'global').length, 2, 'the global plan did run again');
  assert.equal(JSON.stringify((await mapNow(r)).nodes.map(n => n.id)), before);
  assert.equal(s2.structureEdit.applied.length, 3);
  same(s2.structureEdit.archived, s1.structureEdit.archived);
});

test('P2a a stop before the global result is used writes nothing of the structure', async () => {
  const gate = defer();
  const { r } = await structureRig(SOP, { script: { global: async () => { await gate.promise; return { thread: 't', cards: [], materials: [], decisions: {}, structure: SOP(r0.r) }; } } });
  const r0 = { r };
  const mapBefore = r.mapRaw();
  const started = r.runs.start(r.mapPath);
  await settle();
  await r.runs.stop(r.mapPath, { saved: true });
  gate.resolve(); await started.catch(() => undefined); await settle();
  assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.ok(!r.contents.get(r.mapPath).includes('structureEdit'), 'no structure record');
  assert.ok(r.contents.has(r.nodes[2].path), 'nothing archived');
  assert.equal((await idsNow(r)).length, 3);
  void mapBefore;
});

test('P2a a failed transaction (rollback ok): map and notes as before, the run goes on with the old structure, the failure is logged', async () => {
  let throws = 1;
  const wrap = repo => new Proxy(repo, { get: (t, k) => k === 'saveMap' ? (...a) => { if (throws-- > 0) throw new Error('disk'); return t.saveMap(...a); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k] });
  const { r, requests } = await structureRig(SOP, { wrap });
  const order = await idsNow(r);
  const raws = r.nodes.map((n, i) => r.raw(i));
  const notesBefore = [...r.contents.keys()].filter(k => !k.endsWith('Map.md')).sort();
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running');
  same(s.order, order);
  assert.equal(s.structureEdit, undefined);
  assert.ok(r.stat.logs.some(l => /structure_failed/.test(l)));
  same(await idsNow(r), order);
  const map = await mapNow(r);
  for (let i = 0; i < 3; i++) assert.equal((await r.repo.readNote(map.nodes.find(n => n.id === r.nodes[i].id).path)).title, TITLES[i]);
  assert.ok(r.contents.has(r.nodes[2].path), 'B is still in Notes');
  const notesNow = [...r.contents.keys()].filter(k => !k.endsWith('Map.md') && !/\/Unassigned\//.test(k)).sort();
  same(notesNow, notesBefore.filter(k => !/\/Unassigned\//.test(k)), 'no new note is left in Notes or Archive');
  void raws; void requests;
});

test('P2a a failed rollback stops the run as failed (structure_rollback)', async () => {
  let saves = 0;
  const wrap = repo => new Proxy(repo, { get: (t, k) => k === 'saveMap' ? (...a) => { if (saves++ > 0) throw new Error('disk'); return t.saveMap(...a); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k] });
  const { r } = await structureRig(SOP, { wrap, rebuild: async () => { throw new Error('rebuild'); } });
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.status, 'stopped');
  assert.equal(s.failureCode, 'structure_rollback');
  assert.equal(r.runs.isRunning(r.mapPath), false);
});

test('P2a a card with the owner\'s hand in it (and the root) is marked locked in the request, and changes to it are refused', async () => {
  const { r, requests } = await structureRig(r => [
    { id: 'o1', kind: 'rename', card: r.nodes[1].id, title: 'Nope', reason: 'x' },
    { id: 'o2', kind: 'rename', card: r.nodes[2].id, title: 'Fine', reason: 'x' }
  ]);
  await r.repo.updateNote(r.nodes[1].path, { detail: 'my own words' });
  assert.equal(bodyStateRaw(r.raw(1)), 'unknown');
  await r.runs.start(r.mapPath);
  const cards = requests.global[0].cards;
  assert.equal(cards.find(c => c.id === r.nodes[0].id).locked, true);
  assert.equal(cards.find(c => c.id === r.nodes[1].id).locked, true);
  assert.equal(cards.find(c => c.id === r.nodes[2].id).locked, undefined);
  const s = await r.state();
  same(s.structureEdit.rejected, [{ id: 'o1', code: 'locked' }]);
  assert.equal(s.structureEdit.applied.length, 1);
  assert.equal((await r.note(1)).title, 'SecretTitleA');
});

test('P2a nothing applicable: only the record is written, and no port is called', async () => {
  const { r } = await structureRig(r => [{ id: 'o1', kind: 'remove', card: r.nodes[0].id, reason: 'x' }]);
  let called = 0;
  const port = r.ports.editBookStructure;
  r.ports.editBookStructure = (...a) => { called++; return port(...a); };
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(called, 0);
  same(s.structureEdit.applied, []);
  same(s.structureEdit.rejected, [{ id: 'o1', code: 'root' }]);
  assert.equal(s.structureEdit.before.nodes.length, 3);
  assert.equal(s.order.length, 3);
});

test('P2a without the port the proposal is recorded and the map stays as it is', async () => {
  const { r } = await structureRig(SOP);
  delete r.ports.editBookStructure;
  await r.runs.start(r.mapPath);
  const s = await r.state();
  assert.equal(s.structureEdit.applied.length, 0);
  assert.equal((await idsNow(r)).length, 3);
  assert.ok(r.contents.has(r.nodes[2].path));
});

// ---- undoing the editor's structure changes (P2b) ----------------------------------------------------------------------------------
const HOME_GLOBAL = holder => request => ({ ...planRoles(holder.r, ['intro', 'body', 'body']), materials: [{ name: 'Scene', use: 'u', home: holder.r.nodes[2].id }, { name: 'Other', use: 'u', home: holder.r.nodes[1].id }], structure: SOP(holder.r) });
const undoRig = async (over = {}) => {
  const out = await structureRig(SOP, over);
  await out.r.runs.start(out.r.mapPath);
  await settle();
  return out;
};
const bodyOfRaw = raw => raw.slice(raw.indexOf('\n---\n') + 5);
const noTrace = raw => raw.replace(/,?\s*"gateTrace": \[[^\]]*\]/, '');
const codeOf = async p => p.then(() => undefined, e => e.code);

test('P2b undo one op (the added card): it is parked, the others stay, the run goes back to planning and re-plans nothing it need not', async () => {
  const { r, requests } = await undoRig();
  const s1 = await r.state();
  const created = s1.order[2];
  const createdPath = (await mapNow(r)).nodes.find(n => n.id === created).path;
  const plansBefore = requests.card.length;
  await r.runs.undoStructureEdit(r.mapPath, ['o2']);
  await settle();
  const s = await r.state();
  same(s.structureEdit.undone, ['o2']);
  same(s.order, [r.nodes[0].id, r.nodes[1].id]);
  same(await idsNow(r), s.order);
  assert.match(s.structureEdit.archived[created], /\/Archive\//);
  assert.ok(!r.contents.has(createdPath), 'the new card left Notes');
  assert.match(r.contents.get(s.structureEdit.archived[created]), /title: NewChapter/);
  assert.equal((await r.repo.readNote((await mapNow(r)).nodes.find(n => n.id === r.nodes[1].id).path)).title, 'RenamedA', 'the other ops stay');
  assert.equal(s.phase, 'gate1', 'the run is at the gate again after the re-plan');
  assert.ok(s.structureEdit.applied.length === 3);
  assert.equal(requests.card.length, plansBefore, 'the dropped card is not planned; nothing else was affected');
});

test('P2b undo all: the merged card is back in Notes with its text, titles and places as before, the new card parked, nothing lost', async () => {
  const { r, requests } = await undoRig();
  const s1 = await r.state();
  const created = s1.order[2];
  const archivePath = s1.structureEdit.archived[r.nodes[2].id];
  const archivedDetail = (await r.repo.readNote(archivePath)).detail;
  requests.card.length = 0;
  let hold = defer();
  await r.runs.undoStructureEdit(r.mapPath, 'all');
  await settle();
  const s = await r.state();
  same(s.structureEdit.undone.slice().sort(), ['o1', 'o2', 'o3']);
  same(s.order, [r.nodes[0].id, r.nodes[1].id, r.nodes[2].id]);
  same(await idsNow(r), s.order);
  const map = await mapNow(r);
  const bNode = map.nodes.find(n => n.id === r.nodes[2].id);
  assert.match(bNode.path, /\/Notes\//);
  assert.ok(!r.contents.has(archivePath), 'the archived note moved out of Archive');
  assert.equal((await r.repo.readNote(bNode.path)).detail, archivedDetail, 'the text did not change');
  assert.equal((await r.repo.readNote(bNode.path)).title, 'SecretTitleB');
  assert.equal((await r.repo.readNote(map.nodes.find(n => n.id === r.nodes[1].id).path)).title, 'SecretTitleA', 'the rename was undone');
  assert.equal(s.chapters[r.nodes[1].id].title, 'SecretTitleA');
  assert.equal(map.nodes.find(n => n.id === created), undefined);
  assert.match(s.structureEdit.archived[created], /\/Archive\//);
  assert.equal(s.structureEdit.archived[r.nodes[2].id], undefined, 'restored ones are no longer archived');
  same(mapDifference(s, bookReadingOrder(map)), { added: [], missing: [] });
  assert.ok(requests.card.some(q => q.card.id === r.nodes[2].id), 'the put-back card is planned again');
  assert.ok(requests.card.some(q => q.card.id === r.nodes[1].id), 'the merge target is planned again');
  assert.ok(r.stat.logs.some(l => /undo_structure:3/.test(l)));
  assert.ok(!r.stat.logs.some(l => /NewChapter|RenamedA/.test(l)));
  void hold;
});

test('P2b undo one op that others lean on takes them too (the new card and its rename)', async () => {
  const mk = r => [
    { id: 'o1', kind: 'add', ref: 'n1', title: 'NewChapter', summary: 's', parent: r.nodes[0].id, after: r.nodes[1].id, reason: 'x' },
    { id: 'o2', kind: 'rename', card: 'n1', title: 'NewName', reason: 'x' },
    { id: 'o3', kind: 'rename', card: r.nodes[1].id, title: 'RenamedA', reason: 'x' }
  ];
  const { r } = await structureRig(mk);
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).structureEdit.applied.length, 3);
  await r.runs.undoStructureEdit(r.mapPath, ['o1']);
  await settle();
  const s = await r.state();
  same(s.structureEdit.undone.slice().sort(), ['o1', 'o2']);
  assert.equal(s.order.length, 3);
  assert.equal((await r.repo.readNote((await mapNow(r)).nodes.find(n => n.id === r.nodes[1].id).path)).title, 'RenamedA');
});

test('P2b the run goes to planning with the affected cards in pendingReset (before the loop reads them)', async () => {
  const gate = defer();
  const holder = {};
  let hold = false;
  const { r } = await structureRig(SOP, { script: { card: async request => { if (hold) await gate.promise; return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }; } } });
  await r.runs.start(r.mapPath);
  const before = await r.state();
  hold = true;
  const undoing = r.runs.undoStructureEdit(r.mapPath, ['o1']);
  await settle();
  const s = await r.state();
  assert.equal(s.phase, 'planning');
  assert.ok(s.revisions[r.nodes[2].id] > (before.revisions[r.nodes[2].id] ?? 0), 'the restored card has a new revision');
  assert.ok(s.revisions[r.nodes[1].id] > (before.revisions[r.nodes[1].id] ?? 0), 'the merge target has a new revision');
  gate.resolve(); await undoing; await settle();
  assert.equal((await r.state()).phase, 'gate1');
  void holder;
});

test('P2b undo is refused outside a running gate 1', async () => {
  const { r } = await undoRig();
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.status = 'stopped'; });
  assert.equal(await codeOf(r.runs.undoStructureEdit(r.mapPath, 'all')), 'not_gate1');
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.status = 'running'; d.bookPipeline.phase = 'writing'; });
  assert.equal(await codeOf(r.runs.undoStructureEdit(r.mapPath, 'all')), 'not_gate1');
  assert.equal((await r.state()).structureEdit.undone, undefined);
});

test('P2b undo is refused while a drive of the map runs', async () => {
  const gate = defer();
  const { r } = await structureRig(SOP, { script: { card: async () => { await gate.promise; return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }; } } });
  const started = r.runs.start(r.mapPath);
  await settle();
  assert.ok(r.runs.isRunning(r.mapPath));
  assert.equal(await codeOf(r.runs.undoStructureEdit(r.mapPath, 'all')), 'busy');
  gate.resolve(); await started.catch(() => undefined); await settle();
});

test('P2b a parked note that is gone: the whole undo is refused and nothing moves', async () => {
  const { r } = await undoRig();
  const s1 = await r.state();
  r.contents.delete(s1.structureEdit.archived[r.nodes[2].id]);
  const mapBefore = r.mapRaw();
  const notesBefore = [...r.contents.keys()].sort();
  assert.equal(await codeOf(r.runs.undoStructureEdit(r.mapPath, 'all')), 'missing');
  assert.equal(noTrace(r.mapRaw()), noTrace(mapBefore));
  same([...r.contents.keys()].sort(), notesBefore);
  assert.equal((await r.state()).structureEdit.undone, undefined);
});

test('P2b undoing the same op twice: the second is a no-op, and unknown ids do nothing', async () => {
  const { r } = await undoRig();
  await r.runs.undoStructureEdit(r.mapPath, ['o2']); await settle();
  const mapAfter = r.mapRaw();
  const s1 = await r.state();
  await r.runs.undoStructureEdit(r.mapPath, ['o2']); await settle();
  await r.runs.undoStructureEdit(r.mapPath, ['zzz']); await settle();
  assert.equal(noTrace(r.mapRaw()), noTrace(mapAfter));
  same((await r.state()).structureEdit.undone, s1.structureEdit.undone);
});

test('P2b after the undo the run re-plans the affected cards and the editor reads the plan again (plan_edit)', async () => {
  const { r, requests } = await undoRig();
  const editsBefore = r.stat.planEdit.length;
  requests.card.length = 0;
  await r.runs.undoStructureEdit(r.mapPath, 'all'); await settle();
  assert.ok(requests.card.length >= 2, 'the restored card and the merge target are planned again');
  assert.equal(r.stat.planEdit.length, editsBefore + 1, 'plan_edit runs once more');
  assert.equal((await r.state()).phase, 'gate1');
});

test('plan edit opening: the editor\'s opening is stored as planOpening; a reply without one stores none', async () => {
  const withOpening = await rig({ script: { planEdit: () => ({ changes: [], opening: 'Hello author' }) } });
  await withOpening.runs.start(withOpening.mapPath);
  assert.equal((await withOpening.state()).planOpening, 'Hello author');
  const without = await rig({ script: { planEdit: () => ({ changes: [] }) } });
  await without.runs.start(without.mapPath);
  assert.equal((await without.state()).planOpening, undefined);
  const small = await rig({ titles: TITLES.slice(0, 2) });
  await small.runs.start(small.mapPath);
  assert.equal((await small.state()).planOpening, undefined, 'a book too small for the pass has no opening');
});

test('plan edit: structureChanges holds this run\'s applied ops that were not undone, and a replan after an undo drops the undone one', async () => {
  const { r } = await structureRig(SOP);
  await r.runs.start(r.mapPath);
  const first = r.stat.planEdit[0];
  assert.deepEqual([...first.structureChanges.map(c => c.kind)], ['merge', 'add', 'rename']);
  assert.deepEqual([...first.structureChanges.map(c => c.title)], ['SecretTitleB', 'NewChapter', 'RenamedA']);
  assert.equal(first.structureChanges[0].reason, 'same ground');
  await r.runs.undoStructureEdit(r.mapPath, ['o1']); await settle();
  const last = r.stat.planEdit[r.stat.planEdit.length - 1];
  assert.ok(r.stat.planEdit.length > 1, 'the pass ran again');
  assert.ok(!(last.structureChanges ?? []).some(c => c.kind === 'merge'), 'the undone op is not offered');
  const plain = await rig();
  await plain.runs.start(plain.mapPath);
  assert.equal(plain.stat.planEdit[0].structureChanges, undefined, 'no structure changes: the field is absent');
});

test('P2b materials homed on a merged card are pointed back at it by the undo', async () => {
  const holder = {};
  const { r } = await structureRig(SOP, { script: { global: request => HOME_GLOBAL(holder)(request) } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  const s1 = await r.state();
  same(s1.structureEdit.applied.find(a => a.id === 'o1').before.homes, ['Scene']);
  assert.match(r.raw(0), /Scene.*歸屬：RenamedA/);
  await r.runs.undoStructureEdit(r.mapPath, 'all'); await settle();
  assert.match(r.raw(0), /Scene.*歸屬：SecretTitleB/);
  assert.match(r.raw(0), /Other.*歸屬：SecretTitleA/);
});

test('P2b a failed apply (rollback ok) writes the materials homes back to the cards as they were', async () => {
  let throws = 1;
  const wrap = repo => new Proxy(repo, { get: (t, k) => k === 'saveMap' ? (...a) => { if (throws-- > 0) throw new Error('disk'); return t.saveMap(...a); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k] });
  const holder = {};
  const { r } = await structureRig(SOP, { wrap, script: { global: request => HOME_GLOBAL(holder)(request) } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  assert.ok(r.stat.logs.some(l => /structure_failed/.test(l)));
  assert.match(r.raw(0), /Scene.*歸屬：SecretTitleB/, 'not the merge target\'s title');
});

// ---- review round 1: undo closure follows the parent, the runner refuses an unsafe inverse, unreadable record, locked on read failure, busy ----
const nestedRig = async (structure, over = {}) => {
  const holder = {};
  const out = await structureRig(structure, {
    titles: ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB', 'SecretTitleC'], nested: true,
    ...over,
    script: { global: () => ({ ...planRoles(holder.r, ['intro', 'body', 'body', 'body']), structure: structure(holder.r) }), ...over.script }
  });
  holder.r = out.r;
  return out;
};

test('P2b undo closure: moving the only section out of a chapter, then removing the empty chapter: undoing the move takes the removal too, nothing is parked', async () => {
  const { r } = await nestedRig(r => [
    { id: 'o1', kind: 'move', card: r.nodes[2].id, parent: r.nodes[3].id, reason: 'x' },
    { id: 'o2', kind: 'remove', card: r.nodes[1].id, reason: 'x' }
  ]);
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).structureEdit.applied.length, 2);
  assert.ok(!(await idsNow(r)).includes(r.nodes[1].id));
  await r.runs.undoStructureEdit(r.mapPath, ['o1']); await settle();
  const s = await r.state();
  same(s.structureEdit.undone.slice().sort(), ['o1', 'o2']);
  same(Object.keys(s.structureEdit.archived).filter(id => id === r.nodes[2].id), [], 'the section was not parked');
  const map = await mapNow(r);
  assert.equal(map.nodes.find(n => n.id === r.nodes[2].id).parentId, r.nodes[1].id);
  assert.ok(map.nodes.some(n => n.id === r.nodes[1].id));
  assert.equal((await idsNow(r)).length, 4);
  assert.ok(r.contents.has(r.nodes[2].path), 'the section is still in Notes');
});

test('P2b undo closure: removing a section, then merging its empty chapter away: undoing the removal takes the merge too, the section comes back', async () => {
  const { r } = await nestedRig(r => [
    { id: 'o1', kind: 'remove', card: r.nodes[2].id, reason: 'x' },
    { id: 'o2', kind: 'merge', card: r.nodes[1].id, into: r.nodes[3].id, reason: 'x' }
  ]);
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).structureEdit.applied.length, 2);
  await r.runs.undoStructureEdit(r.mapPath, ['o1']); await settle();
  const s = await r.state();
  same(s.structureEdit.undone.slice().sort(), ['o1', 'o2']);
  const ids = await idsNow(r);
  for (const n of r.nodes) assert.ok(ids.includes(n.id), 'every card is back');
  assert.equal((await mapNow(r)).nodes.find(n => n.id === r.nodes[2].id).parentId, r.nodes[1].id);
});

test('P2b the runner refuses an inverse that would make a card it did not add disappear (unsafe): nothing changes', async () => {
  const { r } = await nestedRig(r => [{ id: 'o1', kind: 'move', card: r.nodes[2].id, parent: r.nodes[3].id, reason: 'x' }]);
  await r.runs.start(r.mapPath);
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.structureEdit.applied[0].before.parent = 'ghost'; });
  const mapBefore = r.mapRaw();
  const notesBefore = [...r.contents.keys()].sort();
  assert.equal(await codeOf(r.runs.undoStructureEdit(r.mapPath, ['o1'])), 'unsafe');
  assert.equal(noTrace(r.mapRaw()), noTrace(mapBefore));
  same([...r.contents.keys()].sort(), notesBefore);
  assert.equal((await r.state()).structureEdit.undone, undefined);
});

test('structure record that cannot be read: the run opens without it and logs structure_unreadable once', async () => {
  const { r } = await undoRig();
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.structureEdit = { junk: true }; });
  const before = r.stat.logs.filter(l => /structure_unreadable/.test(l)).length;
  assert.equal(await codeOf(r.runs.undoStructureEdit(r.mapPath, 'all')), 'not_gate1');
  assert.equal(r.stat.logs.filter(l => /structure_unreadable/.test(l)).length, before + 1);
});

test('P2a a card that cannot be read when the editor is asked is treated as locked; the run does not fail', async () => {
  const { r, requests } = await structureRig(r => [{ id: 'o1', kind: 'rename', card: r.nodes[2].id, title: 'Nope', reason: 'x' }]);
  const read = r.ports.readCard;
  r.ports.readCard = async path => {
    if (path === r.nodes[2].path && /execGlobal/.test(new Error().stack)) throw new Error('unreadable');
    return read(path);
  };
  await r.runs.start(r.mapPath);
  assert.equal(requests.global[0].cards.find(c => c.id === r.nodes[2].id).locked, true);
  const s = await r.state();
  assert.equal(s.phase, 'gate1');
  same(s.structureEdit.rejected, [{ id: 'o1', code: 'locked' }]);
  assert.equal((await r.note(2)).title, 'SecretTitleB');
});

test('P2a while the structure port runs, the map-change check does not pause the run (structureBusy)', async () => {
  const { r } = await structureRig(SOP);
  const real = r.ports.editBookStructure;
  const seen = [];
  r.ports.editBookStructure = (mapPath, work) => real(mapPath, {
    ...work,
    edit: (map, tools) => {
      const out = work.edit(map, tools);
      // the transaction's own view of the map: its new cards differ from the accepted set
      const readMap = r.ports.readMap;
      r.ports.readMap = async () => map;
      seen.push(r.runs.pauseOnMapChange(r.runs.drives.get(mapPath)));
      r.ports.readMap = readMap;
      return out;
    }
  });
  await r.runs.start(r.mapPath);
  assert.equal(seen.length, 1);
  assert.equal(await seen[0], false, 'no pause in the middle of the transaction');
  const s = await r.state();
  assert.equal(s.status, 'running'); assert.notEqual(s.pauseReason, 'map');
});

// ---- the owner's structure changes at the plan review, through chat (editStructureAtReview) ----------------------------------------
const treeOf = async r => { const s = await r.state(); const map = await mapNow(r); const at = new Map(map.nodes.map(n => [n.id, n])); const nodes = []; for (const id of s.order) nodes.push({ id, parentId: at.get(id).parentId ?? null, title: (await r.repo.readNote(at.get(id).path)).title }); return { s, nodes }; };
const chatRig = async () => {
  const out = await structureRig(() => []);
  await out.r.runs.start(out.r.mapPath);
  await settle();
  return out;
};
const expectOf = async r => { const { s, nodes } = await treeOf(r); return { runId: s.runId, phaseStartedAt: s.phaseStartedAt, nodes }; };
const CHAT_OPS = r => [
  { id: 'c1', kind: 'add', ref: 'cn', title: 'ChatChapter', summary: 'chat summary', parent: r.nodes[0].id, after: r.nodes[1].id, reason: 'gap' },
  { id: 'c2', kind: 'remove', card: r.nodes[2].id, reason: 'not needed' }
];

test('chat structure edit: ops appended, deleted note archived, new card planned, neighbours rewritten, back at gate1 without the editor pass; undo all restores', async () => {
  const { r, requests } = await chatRig();
  const original = (await treeOf(r)).nodes;
  const bPath = r.nodes[2].path;
  const bRaw = r.raw(2);
  const editsBefore = r.stat.planEdit.length;
  requests.card.length = 0;
  const ops = CHAT_OPS(r);
  const out = await r.runs.editStructureAtReview(r.mapPath, ops, await expectOf(r), 'returned line');
  await settle();
  same(out.applied, ['c1', 'c2']); same(out.refused, []); assert.equal(out.affected, 1);
  const { s, nodes } = await treeOf(r);
  assert.equal(s.phase, 'gate1'); assert.equal(s.status, 'running'); assert.equal(s.planOpening, 'returned line');
  assert.equal(r.stat.planEdit.length, editsBefore, 'the editor pass did not run');
  assert.equal(s.planEdited, true);
  same(s.structureEdit.applied.map(a => a.id), ['c1', 'c2']);
  const created = s.order[2];
  assert.equal(nodes[2].title, 'ChatChapter');
  same(requests.card.map(q => q.card.id), [created], 'only the new card is planned');
  const archived = s.structureEdit.archived[r.nodes[2].id];
  assert.match(archived, /\/Archive\//);
  assert.ok(!r.contents.has(bPath)); assert.match(r.contents.get(archived), /title: SecretTitleB/);
  assert.ok(r.contents.get(archived).includes(bRaw.slice(bRaw.indexOf('\n---\n') + 5)), 'its text is kept');
  await r.runs.undoStructureEdit(r.mapPath, 'all');
  await settle();
  const back = await treeOf(r);
  same(back.nodes.map(n => [n.parentId, n.title]), original.map(n => [n.parentId, n.title]));
  same(back.s.order.filter(id => id !== created), original.map(n => n.id));
});

test('chat structure edit: resolves once the change is written (not after the re-plan), the opening line follows the runner\'s own count, and a failing card plan does not reject the call', async () => {
  const gate = { current: null, fail: false };
  const card = async () => {
    if (gate.current) await gate.current.promise;
    if (gate.fail) throw new Error('card plan down');
    return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] };
  };
  const { r } = await structureRig(() => [], { script: { card } });
  await r.runs.start(r.mapPath); await settle();
  gate.current = defer(); gate.fail = true;
  const asked = [];
  const pending = r.runs.editStructureAtReview(r.mapPath, [CHAT_OPS(r)[0]], await expectOf(r), n => { asked.push(n); return `re-planning ${n}`; });
  const early = await Promise.race([pending.then(() => 'resolved'), new Promise(res => setTimeout(() => res('waited'), 200))]);
  assert.equal(early, 'resolved', 'the call does not wait for the card plans');
  assert.ok(asked.length && asked.every(n => n === 1), 'the opening is built from the runner\'s affected count');
  assert.equal((await r.state()).phase, 'planning', 'the re-plan is still running');
  assert.equal((await pending).affected, 1);
  gate.current.resolve(); await settle();
  const s = await r.state();
  assert.ok(s.phase === 'gate1' || s.status === 'stopped', 'a failed card plan is the run\'s own business: no rejection reaches the caller, the run settles');
  await settle();
});

test('chat structure edit: a remove-only change costs no AI call and rewrites the neighbours', async () => {
  const { r, requests } = await chatRig();
  const calls = () => r.stat.plan.length + r.stat.planEdit.length + requests.card.length;
  const before = calls();
  const out = await r.runs.editStructureAtReview(r.mapPath, [CHAT_OPS(r)[1]], await expectOf(r), 'x');
  await settle();
  assert.equal(out.affected, 0); assert.equal(calls(), before);
  const s = await r.state();
  assert.equal(s.phase, 'gate1'); same(s.order, [r.nodes[0].id, r.nodes[1].id]);
});

test('chat structure edit: a stale tree, wrong gate, runId, phase start or a running drive is refused and nothing is written', async () => {
  const { r } = await chatRig();
  const ex = await expectOf(r);
  const files = () => JSON.stringify([...r.contents.entries()].map(([k, v]) => [k, noTrace(v)]));
  const snap = files();
  const ops = CHAT_OPS(r);
  assert.equal(await codeOf(r.runs.editStructureAtReview(r.mapPath, ops, { ...ex, nodes: ex.nodes.slice(1) }, 'x')), 'stale');
  assert.equal(await codeOf(r.runs.editStructureAtReview(r.mapPath, ops, { ...ex, runId: 'other' }, 'x')), 'not_gate1');
  assert.equal(await codeOf(r.runs.editStructureAtReview(r.mapPath, ops, { ...ex, phaseStartedAt: 'other' }, 'x')), 'not_gate1');
  assert.equal(files(), snap);
  const stateRaw = JSON.stringify((await mapNow(r)).bookPipeline).replace(/,?"gateTrace":\[[^\]]*\]/, '');
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; });
  assert.equal(await codeOf(r.runs.editStructureAtReview(r.mapPath, ops, ex, 'x')), 'not_gate1');
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'gate1'; });
  assert.ok((await r.state()).structureEdit === undefined);
  assert.ok(stateRaw.length > 0);
  const gate = defer();
  const busy = await structureRig(() => [], { script: { card: async () => { await gate.promise; return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }; } } });
  const started = busy.r.runs.start(busy.r.mapPath);
  await settle();
  assert.equal(await codeOf(busy.r.runs.editStructureAtReview(busy.r.mapPath, CHAT_OPS(busy.r), ex, 'x')), 'busy');
  gate.resolve(); await started.catch(() => undefined); await settle();
});

// ---- P1 "fix again": one more fix-and-check round over a finished book (reopenAiRound / closeAiRound / fixAgain) ----
const againOpen = slot => plain(slot.open.map(item => [item.reason, item.quote]));
/** A finished book whose chapter A has one fixable problem (it is never solved: still_present) and one the AI called unfixable. `mode` decides what the re-check says during the again round. */
const againRig = async (over = {}) => {
  const v = pageVault(); const applied = []; const st = { again: false, mode: 'solve', hold: undefined, p2: undefined };
  const r = await aiRig({
    aiProof: async (request, n, run) => {
      if (request.title !== 'SecretTitleA') return { checks: [okCheck(request)], prior: [], dropped: {} };
      if (!st.again) st.p2 = quoteOf(request, 12, 20);
      if (st.again && st.mode === 'solve') return { checks: [], prior: [], dropped: {} };
      if (st.again && st.mode === 'redetect') return { checks: [{ ...probOf(request, 'P1'), quote: 'zzz none' }, { ...probOf(request, 'P2'), quote: st.p2, fixable: false, why: 'unfixable' }], prior: [], dropped: {} };
      if (st.again && st.mode === 'hold-proof') { st.hold?.reached(); await st.hold?.promise; }
      return { checks: [probOf(request, 'P1'), { ...probOf(request, 'P2', 12, 20), fixable: false, why: 'unfixable' }], prior: [], dropped: {} };
    },
    aiFix: async (request, n, run) => {
      if (st.again && st.mode === 'fail-once') st.failOnce();
      if (st.again && st.mode === 'hold-fix') { st.hold?.reached(); if (st.hold?.budget) for (;;) await run.admission.reserve(); await st.hold?.promise; }
      const replacement = `Corrected${applied.length + 1}`; applied.push(replacement);
      return [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement }];
    },
    ...over
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  return { r, v, applied, st };
};
const finishedCalls = r => ({ fix: aiRuns(r, 'fix').length, proofA: aiRuns(r, 'proof', 'SecretTitleA').length, book: r.stat.ai.filter(([k]) => /book/i.test(k)).length, all: r.stat.ai.length });
const settleRuns = async r => { while (r.runs.isRunning(r.mapPath)) await tick(); await settle(); };

test('P1 fix again: the book was still_present + unfixable; one round = exactly one fix and one check for the chapter, nothing else is called; the unfixable one stays in front', async () => {
  const { r, v, applied, st } = await againRig();
  const before = (await r.state()).aiProof[idA(r)];
  assert.deepEqual(plain(before.open.map(i => i.reason).sort()), ['still_present', 'unfixable']);
  same(await invariantsOf(r, v, { applied: { [idA(r)]: applied } }), [], 'before');
  const calls = finishedCalls(r); st.again = true;
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const after = await r.state(); const slot = after.aiProof[idA(r)];
  const now = finishedCalls(r);
  assert.deepEqual([now.fix - calls.fix, now.proofA - calls.proofA, now.all - calls.all], [1, 1, 2], 'one fix, one re-check, no other call (other chapters, the book)');
  assert.deepEqual([after.phase, slot.done, slot.again, slot.pending, slot.round], ['done', true, undefined, undefined, 2]);
  assert.deepEqual(againOpen(slot).map(x => x[0]), ['unfixable'], 'the fixed one is gone, the excluded one stays');
  assert.equal(slot.fixed, before.fixed + 1);
  same(await invariantsOf(r, v, { applied: { [idA(r)]: applied } }), [], 'after');
  assert.ok(r.raw(1).includes(applied.at(-1)), 'the fix was written');
  assert.ok(after.aiProof[r.nodes[2].id].again === undefined && !after.bookProof.again);
});

test('P1 fix again: a still-present problem after the round stays still_present (counts do not drop); the new check re-listing the unfixable one does not duplicate it', async () => {
  const { r, v, applied, st } = await againRig();
  st.again = true; st.mode = 'redetect';
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const slot = (await r.state()).aiProof[idA(r)];
  assert.equal(slot.open.filter(i => i.reason === 'unfixable').length, 1, 'no duplicate of the excluded one');
  assert.equal(slot.open[0].reason, 'unfixable', 'the original is in front');
  same(await invariantsOf(r, v, { applied: { [idA(r)]: applied }, refusedQuotes: slot.open.map(i => i.quote) }), []);
});

test('P1 fix again: nothing fixable (all solved, or only unfixable left) is refused with "nothing"; no call, the saved state is not touched', async () => {
  const v = pageVault();
  const r = await aiRig({ aiProof: async request => ({ checks: [okCheck(request)], prior: [], dropped: {} }) }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  const saved = JSON.stringify(await r.state()); const calls = r.stat.ai.length;
  await assert.rejects(r.runs.fixAgain(r.mapPath), err => err instanceof BookPipelineRunError && err.code === 'nothing');
  assert.equal(JSON.stringify(await r.state()), saved);
  assert.equal(r.stat.ai.length, calls);
});

test('P1 fix again: unfixable-only chapter (excluded reasons) is not sent: refused "nothing" and the open items stay', async () => {
  const v = pageVault();
  const r = await aiRig({ aiProof: async request => ({ checks: request.title === 'SecretTitleA' ? [{ ...probOf(request, 'P2', 12, 20), fixable: false, why: 'sources_conflict' }] : [okCheck(request)], prior: [], dropped: {} }) }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  const saved = JSON.stringify(await r.state());
  await assert.rejects(r.runs.fixAgain(r.mapPath), err => err.code === 'nothing');
  assert.equal(JSON.stringify(await r.state()), saved);
});

test('P1 fix again: a book that is not done is refused (not_gate) before anything changes', async () => {
  const r = await aiRig({}, {});
  await r.runs.start(r.mapPath);
  await assert.rejects(r.runs.fixAgain(r.mapPath), err => err instanceof BookPipelineRunError && ['not_gate', 'busy'].includes(err.code));
  r.runs.dispose();
});

test('P1 fix again: the call limit is raised to used + calls when short; no pause', async () => {
  const { r, st } = await againRig();
  const used = (await r.state()).budget.used;
  await setLimit(r, used);
  st.again = true;
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const s = await r.state();
  assert.equal(s.budget.limit, used + 6, 'raised by what was short: 1 chapter = 2 calls, each step with room for 3 attempts');
  assert.notEqual(s.pauseReason, 'budget');
});

test('A1 fix again: one failed fix call is retried inside the round without pausing on the budget (acceptance r1 finding)', async () => {
  let failed = false;
  const { r, v, applied, st } = await againRig();
  const used = (await r.state()).budget.used;
  await setLimit(r, used);
  st.again = true;
  st.mode = 'fail-once';
  st.failOnce = () => { if (failed) return; failed = true; throw new Error('provider timeout'); };
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const s = await r.state();
  assert.ok(failed, 'the first fix call failed');
  assert.notEqual(s.pauseReason, 'budget', 'the retry fits in the raised limit');
  assert.equal(s.aiProof[idA(r)].again, undefined);
  assert.ok(r.raw(1).includes(applied.at(-1)), 'the retried fix was written');
  same(await invariantsOf(r, v, { applied: { [idA(r)]: applied } }), [], 'after');
});

test('P1 fix again: a limit that already has room is left alone', async () => {
  const { r, st } = await againRig();
  const limit = (await r.state()).budget.limit; st.again = true;
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  assert.equal((await r.state()).budget.limit, limit);
});

for (const [how, at] of [['stop', 'hold-fix'], ['stop', 'hold-proof'], ['budget', 'hold-fix']]) {
  test(`P1 fix again: ${how} during the round's ${at}: the slot is closed with the problems it had before (same open items), no again/pending, the invariants hold`, async () => {
    const { r, v, applied, st } = await againRig();
    const before = (await r.state()).aiProof[idA(r)];
    st.again = true; st.mode = at; let reached = false; const hold = defer();
    st.hold = { reached: () => { reached = true; }, promise: hold.promise, budget: how === 'budget' };
    const running = r.runs.fixAgain(r.mapPath).catch(() => undefined);
    while (!reached && r.runs.isRunning(r.mapPath)) await tick();
    if (how === 'stop') { await r.runs.stop(r.mapPath); hold.resolve(); }
    await running; await settleRuns(r);
    const s = await r.state(); const slot = s.aiProof[idA(r)];
    assert.ok(slot.done && !slot.again && !slot.pending && !slot.incomplete, JSON.stringify(slot));
    assert.deepEqual(againOpen(slot), againOpen(before), 'open is what it was before the round');
    assert.equal(s.phase, 'done');
    if (how === 'budget') assert.equal(s.pauseReason, 'budget');
    same(await invariantsOf(r, v, { applied: { [idA(r)]: applied }, refusedQuotes: slot.open.map(i => i.quote) }), []);
    assert.equal(slot.open.length, before.open.length);
  });
}

test('P1 fix again: the app closes (dispose) in the middle of the round; a new session repairFinished closes the slot (not incomplete) and the page lists the same items', async () => {
  const { r, v, applied, st } = await againRig();
  const before = (await r.state()).aiProof[idA(r)]; const pageBefore = pageText(v);
  st.again = true; st.mode = 'hold-fix'; let reached = false; const hold = defer();
  st.hold = { reached: () => { reached = true; }, promise: hold.promise };
  const running = r.runs.fixAgain(r.mapPath).catch(() => undefined);
  while (!reached && r.runs.isRunning(r.mapPath)) await tick();
  r.runs.dispose(); hold.resolve(); await running; await settle();
  const mid = (await r.state()).aiProof[idA(r)];
  assert.ok(mid.again && !mid.done, 'the unload left the round open');
  const again = new BookPipelineRuns(r.ports); await again.repairFinished(r.mapPath); await settle();
  const slot = (await r.state()).aiProof[idA(r)];
  assert.ok(slot.done && !slot.again && !slot.incomplete && !slot.pending, JSON.stringify(slot));
  assert.deepEqual(againOpen(slot), againOpen(before));
  assert.equal(pageText(v).split('\n').filter(l => l.startsWith('- ')).length, pageBefore.split('\n').filter(l => l.startsWith('- ')).length);
  same(await invariantsOf(r, v, { applied: { [idA(r)]: applied }, refusedQuotes: slot.open.map(i => i.quote) }), []);
  again.dispose();
});

test('P2 fix again: the runner tells the bar how far the round is (done / total) while it runs, and says nothing before it starts or after it ends', async () => {
  const { r, st } = await againRig();
  assert.equal(r.runs.getProgress(r.mapPath)?.again, undefined, 'before the round');
  st.again = true; st.mode = 'hold-fix'; let reached = false; const hold = defer();
  st.hold = { reached: () => { reached = true; }, promise: hold.promise };
  const running = r.runs.fixAgain(r.mapPath).catch(() => undefined);
  while (!reached && r.runs.isRunning(r.mapPath)) await tick();
  assert.deepEqual(plain(r.runs.getProgress(r.mapPath).again), { done: 0, total: 1 }, 'one chapter to work on, none finished');
  hold.resolve(); await running; await settleRuns(r);
  assert.equal(r.runs.getProgress(r.mapPath)?.again, undefined, 'after the round');
});

test('P1 fix again: the only fixable chapter was changed by the reader (key differs): refused "nothing" with no call, no write, no limit change, the saved state untouched (R1 finding 3)', async () => {
  const { r, st } = await againRig();
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/Corrected\d+/, m => `${m} by the reader`), {});
  const rawBefore = r.raw(1); const calls = finishedCalls(r); const saved = JSON.stringify(await r.state()); st.again = true;
  await assert.rejects(r.runs.fixAgain(r.mapPath), err => err instanceof BookPipelineRunError && err.code === 'nothing');
  await settleRuns(r);
  assert.equal(r.raw(1), rawBefore, 'nothing written');
  assert.deepEqual(finishedCalls(r), calls, 'no call at all');
  assert.equal(JSON.stringify(await r.state()), saved, 'no budget raise, no slot change');
});

/** A finished book where chapter A has a fixable problem the check keeps finding, and the whole-book check keeps finding one in chapter A (its fix writes there during the writing). */
const bothRig = async () => {
  const v = pageVault(); const st = { again: false, hold: undefined }; let n = 0;
  const r = await aiRig({
    aiProof: async request => request.title === 'SecretTitleA' ? { checks: [probOf(request, 'P1')], prior: [], dropped: {} } : { checks: [okCheck(request)], prior: [], dropped: {} },
    aiBookProof: async request => ({ checks: [bookProblem(request, 2, 3)], prior: [], dropped: {} }),
    aiFix: async request => request.targets[0].id === 'B1'
      ? [{ id: 'B1', chapter: 2, quote: request.chapters[1].text, replacement: `BookCorrected${++n}` }]
      : (st.hold?.reached(), await st.hold?.promise, [{ id: 'P1', quote: request.chapters[0].text.slice(0, 11), replacement: `ChapterCorrected${++n}` }])
  }, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  return { r, v, st };
};

test('R1 fix again: the book slot and a chapter are both fixed in one round: each gets exactly one fix and one re-check, nothing is skipped as hand-edited, the limit covers both (findings 1A and 1B)', async () => {
  const { r, v } = await bothRig();
  const s0 = await r.state();
  assert.ok(s0.bookProof.open.length && s0.aiProof[idA(r)].open.length, 'both have fixable problems left');
  same(await invariantsOf(r, v), [], 'before: the program\'s own book write left the chapter slot current');
  const calls = finishedCalls(r); const used = s0.budget.used; await setLimit(r, used);
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const s = await r.state(); const now = finishedCalls(r);
  assert.deepEqual([now.fix - calls.fix, now.proofA - calls.proofA, now.book - calls.book, now.all - calls.all], [2, 1, 1, 4], 'one fix + one re-check for the chapter, one fix + one re-check for the book');
  assert.equal(s.budget.limit, used + 12, 'raised for the four calls that run, each with room for 3 attempts');
  assert.deepEqual([s.phase, s.aiProof[idA(r)].again, s.aiProof[idA(r)].done, s.bookProof.again, s.bookProof.done], ['done', undefined, true, undefined, true]);
  assert.deepEqual([s.aiProof[idA(r)].round, s.bookProof.round], [s0.aiProof[idA(r)].round, s0.bookProof.round], 'both rounds finished (the last round again)');
  assert.equal(s.aiProof[idA(r)].fixed, s0.aiProof[idA(r)].fixed + 1);
  assert.equal(s.bookProof.fixed, s0.bookProof.fixed + 1);
  same(await invariantsOf(r, v), [], 'after: the keys are current, page = bar = open items');
  // A second round works too: the book slot followed the chapter's own fix.
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const again = finishedCalls(r);
  assert.deepEqual([again.fix - now.fix, again.proofA - now.proofA, again.book - now.book], [2, 1, 1], 'a second press runs both again: neither slot looks hand-edited');
});

test('R1 fix again: the reader edited the only chapter that could run and the book slot too: nothing runs, the limit is not raised', async () => {
  const { r } = await bothRig();
  const s0 = await r.state(); const used = s0.budget.used; await setLimit(r, used);
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/(Chapter|Book)Corrected\d+/, m => `${m} by the reader`), {});
  const calls = finishedCalls(r); const rawBefore = r.raw(1);
  // the book slot's key no longer matches either (a chapter changed by the reader): nothing at all runs for it
  await assert.rejects(r.runs.fixAgain(r.mapPath), err => err.code === 'nothing');
  assert.deepEqual(finishedCalls(r), calls); assert.equal(r.raw(1), rawBefore);
  assert.equal((await r.state()).budget.limit, used, 'no budget raise when nothing will run');
});

test('R1 fix again: the reader edits the chapter in the middle of the round (after the fix, before the re-check): the round is closed with the problems it had, no extra call, no new slot, counts do not drop', async () => {
  const { r, v, applied, st } = await againRig({});
  const before = (await r.state()).aiProof[idA(r)]; const pageBefore = pageText(v).split('\n').filter(l => l.startsWith('- ')).length;
  const calls = finishedCalls(r); st.again = true;
  const orig = r.ports.updateNoteRawGuarded; const read = r.ports.readCard; let once = false; let wrote = false; let reads = 0;
  r.ports.updateNoteRawGuarded = async (path, transform, options) => { const out = await orig(path, transform, options); if (st.again) wrote = true; return out; };
  // The fix's own read-back is the first read after the write; the next read (the re-check's) sees the reader's edit made just before it.
  r.ports.readCard = async path => {
    if (wrote && ++reads === 2 && !once) { once = true; await orig(path, c => c.replace(/Corrected\d+/, m => `${m} BY-READER`), {}); }
    return read(path);
  };
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const s = await r.state(); const slot = s.aiProof[idA(r)]; const now = finishedCalls(r);
  assert.ok(once, 'the hand edit happened after the fix was written');
  assert.deepEqual([now.fix - calls.fix, now.proofA - calls.proofA, now.all - calls.all], [1, 0, 1], 'the fix ran; no re-check and no fresh proofread call');
  assert.ok(slot.done && !slot.again && !slot.pending && !slot.incomplete, JSON.stringify(slot));
  assert.equal(slot.round, before.round, 'no fresh slot (round 0) was made');
  assert.deepEqual(againOpen(slot), againOpen(before), 'open is what it was');
  assert.equal(pageText(v).split('\n').filter(l => l.startsWith('- ')).length, pageBefore, 'the page keeps its items');
  assert.equal(r.runs.getProgress(r.mapPath)?.again, undefined);
  assert.ok(r.raw(1).includes('BY-READER'), 'the reader\'s text is kept');
});

test('R2 fix again: the app closes after a chapter fix wrote (at its re-check, before the round ends): the book key follows the write, so a new session repairs the slot and the next press reopens the book slot (1 fix + 1 re-check), counts stay equal', async () => {
  const { r, v } = await bothRig();
  const orig = r.ports.aiProof; let closed = false; let wrote = false;
  const write = r.ports.updateNoteRawGuarded;
  r.ports.updateNoteRawGuarded = async (path, transform, options) => { const out = await write(path, transform, options); if (r.raw(1).includes('ChapterCorrected')) wrote = true; return out; };
  // The re-check that follows the chapter's fix is where the app closes: the fix is written and its result is saved.
  r.ports.aiProof = async (request, n, run) => { const out = await orig(request, n, run); if (wrote && !closed) { closed = true; r.runs.dispose(); } return out; };
  await r.runs.fixAgain(r.mapPath); await settle();
  assert.ok(closed, 'the app closed after the chapter fix was written');
  r.ports.aiProof = orig; r.ports.updateNoteRawGuarded = write;
  const again = new BookPipelineRuns(r.ports); await again.repairFinished(r.mapPath); await settle();
  assert.ok((await r.state()).bookProof.done, 'the book slot is closed as done');
  const calls = finishedCalls(r);
  await again.fixAgain(r.mapPath); while (again.isRunning(r.mapPath)) await tick(); await settle();
  const now = finishedCalls(r);
  assert.deepEqual([now.fix - calls.fix, now.proofA - calls.proofA, now.book - calls.book], [2, 1, 1], 'the book slot reopened: one fix + one re-check (and the chapter once)');
  const s = await r.state();
  assert.equal(pageText(v).split('\n').filter(l => l.startsWith('- ')).length, [s.aiProof[idA(r)], s.bookProof].reduce((n, x) => n + x.open.length, 0), 'page items = open items');
  again.dispose();
});

test('R1 fix again: the progress counts the units that run (chapter + book), and the book finished first is already counted while the chapter works', async () => {
  const { r, st } = await bothRig();
  let reached = false; const hold = defer(); st.hold = { reached: () => { reached = true; }, promise: hold.promise };
  const running = r.runs.fixAgain(r.mapPath).catch(() => undefined);
  while (!reached && r.runs.isRunning(r.mapPath)) await tick();
  assert.deepEqual(plain(r.runs.getProgress(r.mapPath).again), { done: 1, total: 2 }, 'the book (first) is done, the chapter is working');
  hold.resolve(); await running; await settleRuns(r);
  assert.equal(r.runs.getProgress(r.mapPath)?.again, undefined);
});

test('P1 fix again: an old save without `again` loads and runs a round; a saved `again` that is not true is rejected', async () => {
  const { r, st } = await againRig();
  const raw = (await r.repo.readMap(r.mapPath)).bookPipeline;
  assert.ok(raw.aiProof[idA(r)] && !('again' in raw.aiProof[idA(r)]), 'the stored slot has no again field');
  st.again = true; await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.aiProof[idA(r)].again = 'yes'; });
  assert.equal(readBookPipeline(await r.repo.readMap(r.mapPath)).kind, 'unusable');
});

test('P1 chapter reasons: fix interrupted, off pictures (numbers in the problem), unmet proof and unmet structure each get their own sentence, after the older causes', async () => {
  const v = pageVault();
  const r = await aiRig({}, { ports: { writeOpenIssues: v.port } });
  await finishAi(r);
  const mark = (i, issue) => r.repo.writePipelineFields(r.nodes[i].path, { pipelineStage: 'needs-review', pipelineIssue: issue });
  await mark(1, 'proof unmet: fix interrupted'); await mark(2, 'images unmet: images:off:2,3');
  await rerun(r, 0);
  assert.match(pageText(v), /SecretTitleA：修正做到一半被中斷/);
  assert.match(pageText(v), /SecretTitleB：第 2、3 張圖：圖片可能對不上這一節，請看一下/);
  await mark(1, 'proof unmet: a1 a2'); await mark(2, 'structure unmet: s1');
  await rerun(r, 0);
  assert.match(pageText(v), /SecretTitleA：寫完後的校對有幾處沒過/);
  assert.match(pageText(v), /SecretTitleB：章節結構還沒符合企劃/);
  await mark(1, 'proof unmet: no_body'); await mark(2, 'proof unmet: fix interrupted images:under:1:3');
  await rerun(r, 0);
  assert.match(pageText(v), /SecretTitleA：這章沒有正文/, 'an older cause still wins');
  assert.match(pageText(v), /SecretTitleB：圖片少於設定的張數/, 'few pictures wins over the new causes');
  assert.doesNotMatch(pageText(v), /張圖：/);
});

test('P1 chapter reasons: English map language says "Picture 2" / "Pictures 2, 3" and English sentences', async () => {
  const v = pageVault();
  const r = await aiRig({}, { ports: { writeOpenIssues: v.port, config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'en' }) } });
  await finishAi(r);
  await r.repo.writePipelineFields(r.nodes[1].path, { pipelineStage: 'needs-review', pipelineIssue: 'images unmet: images:off:2' });
  await r.repo.writePipelineFields(r.nodes[2].path, { pipelineStage: 'needs-review', pipelineIssue: 'images unmet: images:off:2,3' });
  await rerun(r, 0);
  const text = [...v.files.values()].filter(t => t.startsWith('<!-- vam-book-open-issues')).join('\n');
  assert.match(text, /Picture 2: A picture may not fit this section/);
  assert.match(text, /Pictures 2, 3: A picture may not fit this section/);
});

// ---- AI-drawn Mermaid for diagram-kind slots that found no picture (plan 2026-11-23-book-ai-diagrams, P2) ----
const { diagramHash: dHash, diagramHashesOf: dHashes } = S.load('core/book-pipeline/image-slots.ts');
const GOOD_CHART = 'flowchart LR\n  A[開場] --> B[土壤] --> C[小結]';
async function diagRig({ kinds = ['圖表'], draw, ports = {}, manual, limitExtra, holder = {}, base = DRAFT }) {
  const slots = kinds.map((kind, i) => ({ index: i + 1, kind, explains: `說明${i + 1}`, anchor: 'end' }));
  const MARKED = `${base}\n\n${slots.map(s => `〔圖位 ${s.index}：${s.explains}〕`).join('\n\n')}\n`;
  const calls = [];
  const r = await rig({
    titles: ['T0', 'T1'],
    script: {
      card: request => ({ covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], images: request.card.title === 'T0' ? slots : [] }),
      author: async input => {
        await input.admission.reserve();
        const out = await holder.r.repo.updateNoteGuarded(input.path, { detail: input.nodeId === holder.r.nodes[0].id ? MARKED : base }, { authorize: input.authorize, finalize: input.finalize });
        return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
      }
    },
    ports: {
      findImages: async () => ({ bySlot: new Map(), found: 0, offTopic: 0 }),
      drawDiagrams: async (request, run) => { calls.push(request); await run.admission.reserve(); return draw(request, run, holder.r); },
      ...ports
    }
  });
  holder.r = r;
  await r.runs.start(r.mapPath);
  if (limitExtra !== undefined) await setLimit(r, (await r.state()).budget.used + limitExtra);
  const running = r.runs.confirmGate1(r.mapPath);
  if (manual) return { r, calls, slots, running };
  await running.catch(() => undefined);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  return { r, calls, slots };
}
const draft = (slot, mermaid, title = '開場到小結') => ({ slot, title, mermaid });

test('diagram slots: a missing diagram-kind slot costs exactly one admitted call and the chart lands at the marker with its caption and a diagram record', async () => {
  const { r, calls } = await diagRig({ kinds: ['圖表', '流程'], draw: request => request.slots.map(s => draft(s.index, GOOD_CHART)) });
  assert.equal(calls.length, 1, 'one call for both slots');
  assert.equal(calls[0].slots.map(s => s.index).join(), '1,2');
  const detail = (await r.note(0)).detail;
  assert.equal(detail.split('```mermaid').length - 1, 2);
  assert.match(detail, /示意圖｜開場到小結（依本章內文整理，非史料原圖）/);
  assert.doesNotMatch(detail, /〔圖位/);
  const hash = dHash(GOOD_CHART);
  assert.match(detail, new RegExp(`"index":1,"state":"diagram","hash":"${hash}"`));
  assert.ok(dHashes(detail).includes(hash), 'a re-read finds the chart by its hash');
  const { describeSlots, latestSlotsRecord } = S.load('core/book-pipeline/image-slots.ts');
  const states = describeSlots([{ index: 1, kind: '圖表', explains: '說明1', anchor: 'end' }, { index: 2, kind: '流程', explains: '說明2', anchor: 'end' }], latestSlotsRecord(detail), [], dHashes(detail));
  assert.equal(states.map(s => s.state).join(), 'diagram,diagram');
  const slotsLog = r.stat.logs.find(l => l.includes('slots') && l.includes('diagram_asked'));
  assert.ok(slotsLog && /diagram_asked=2|diagram_asked":2|diagram_asked:2/.test(slotsLog), `counts only: ${slotsLog}`);
  assert.doesNotMatch(slotsLog, /flowchart|開場/);
  assert.equal((await r.state()).phase, 'done');
});

test('diagram slots: no diagram-kind slot, or a setting turned off, means no call', async () => {
  const none = await diagRig({ kinds: ['照片', '地圖'], draw: () => [] });
  assert.equal(none.calls.length, 0);
  const off = await diagRig({ draw: () => [], ports: { diagramsOn: () => false } });
  assert.equal(off.calls.length, 0);
  const absent = await diagRig({ draw: () => [], ports: { drawDiagrams: undefined } });
  assert.equal(absent.calls.length, 0);
});

test('diagram slots: an empty reply leaves the chapter as it is without the call', async () => {
  const base = await diagRig({ draw: () => [], ports: { drawDiagrams: undefined } });
  const empty = await diagRig({ draw: () => [] });
  assert.equal(empty.calls.length, 1);
  const plain = text => text.replace(/<!-- book-proof:v1 .*? -->/g, '').replace(/^> .*book-proof.*$/gm, '');
  assert.equal(plain((await empty.r.note(0)).detail), plain((await base.r.note(0)).detail));
  assert.doesNotMatch((await empty.r.note(0)).detail, /mermaid/);
});

test('diagram slots: an error or timeout of the call draws nothing and the chapter still finishes', async () => {
  const bad = await diagRig({ draw: () => { throw new Error('boom'); } });
  assert.equal(bad.calls.length, 1);
  assert.doesNotMatch((await bad.r.note(0)).detail, /mermaid/);
  assert.equal((await bad.r.state()).phase, 'done');
});

test('diagram slots: a chart with <, more than 6 vertical nodes, a number not in the text or a syntax error is dropped alone', async () => {
  const tall = 'flowchart TD\n  A[一] --> B[二] --> C[三] --> D[四] --> E[五] --> F[六] --> G[七]';
  const { r } = await diagRig({
    kinds: ['圖表', '流程', '時間軸', '比較'],
    draw: request => [draft(1, 'flowchart LR\n  A[a<b] --> B[乙]'), draft(2, tall), draft(3, GOOD_CHART), draft(4, 'flowchart LR\n  A[甲] --> B[乙]', '合法但語法錯')],
    ports: { mermaidSyntax: async code => (code.includes('甲') ? 'invalid' : 'ok') }
  });
  const detail = (await r.note(0)).detail;
  assert.equal(detail.split('```mermaid').length - 1, 1, 'only the good chart is written');
  assert.match(detail, new RegExp(`"index":3,"state":"diagram","hash":"${dHash(GOOD_CHART)}"`));
  assert.match(detail, /"index":1,"state":"missing"/);
  assert.match(detail, /"index":2,"state":"missing"/);
  assert.match(detail, /"index":4,"state":"missing"/);
  const log = r.stat.logs.find(l => l.includes('diagram_asked'));
  for (const code of ['angle', 'too_tall', 'syntax']) assert.match(log, new RegExp(`diagram_rej_${code}`));
  const number = await diagRig({ draw: () => [draft(1, 'pie\n  "甲" : 77')] });
  assert.doesNotMatch((await number.r.note(0)).detail, /mermaid/);
});

test('diagram slots: stop during the call writes nothing', async () => {
  const entered = defer();
  const { r, running } = await diagRig({
    manual: true,
    draw: (request, run) => new Promise((resolve, reject) => { run.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); entered.resolve(); })
  });
  await entered.promise;
  await r.runs.stop(r.mapPath);
  await running.catch(() => undefined);
  await settle();
  const detail = (await r.note(0)).detail;
  assert.doesNotMatch(detail, /mermaid/);
  assert.match(detail, /〔圖位 1：說明1〕/, 'the marker is still there: nothing was written');
});

test('diagram slots: budget exhausted in the call ends the step as budget with nothing drawn', async () => {
  const { r, calls } = await diagRig({ limitExtra: 2, draw: () => [draft(1, GOOD_CHART)] });
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget');
  assert.doesNotMatch((await r.note(0)).detail, /mermaid/);
});

test('diagram slots: a card edited between the re-read and the write is refused by the guarded write and the owner text is kept', async () => {
  let edited = false;
  const outcomes = [];
  const holder = {};
  const { r } = await diagRig({
    draw: request => request.slots.map(s => draft(s.index, GOOD_CHART)),
    ports: {
      updateNoteGuarded: async (path, patch, options) => {
        if (!edited && /```mermaid/.test(patch.detail ?? '')) {
          edited = true;
          const note = await holder.r.repo.readNote(path);
          await holder.r.repo.updateNoteGuarded(path, { detail: `${note.detail}\n\n擁有者新增一句。` });
        }
        const out = await holder.r.repo.updateNoteGuarded(path, patch, options);
        if (/```mermaid/.test(patch.detail ?? '')) outcomes.push(out);
        return out;
      }
    },
    holder
  });
  assert.equal(outcomes[0], 'discarded', 'the stale write is refused');
  assert.match((await r.note(0)).detail, /擁有者新增一句。/, 'the owner text is kept');
});

// ---- structured figures in the same call (plan svg-figures, P2) ----
const NUMBERED = `${DRAFT}\n\n轉盤停在 10 時估計約 25%；停在 65 時約 45%。`;
const GOOD_FIGURE = { type: 'bar', unit: '%', stacked: false, groups: [{ label: '轉盤 10', values: [{ value: '25' }] }, { label: '轉盤 65', values: [{ value: '45' }] }] };
const FIGURE_BODY = '{"type":"bar","unit":"%","stacked":false,"groups":[{"label":"轉盤 10","values":[{"value":"25"}]},{"label":"轉盤 65","values":[{"value":"45"}]}]}';
const figDraft = (slot, figure, title = '轉盤與估計') => ({ slot, title, figure });

test('figure slots: a figure lands as a vam-figure fence with the caption, a diagram record with its hash, in the one call; a hand edit reads as edited', async () => {
  const { r, calls } = await diagRig({ base: NUMBERED, draw: request => [figDraft(1, GOOD_FIGURE)] });
  assert.equal(calls.length, 1, 'still one call');
  const detail = (await r.note(0)).detail;
  assert.ok(detail.includes('```vam-figure\n' + FIGURE_BODY + '\n```\n示意圖｜轉盤與估計（依本章內文整理，非史料原圖）'), detail);
  assert.doesNotMatch(detail, /〔圖位|```mermaid/);
  const hash = dHash(FIGURE_BODY);
  assert.match(detail, new RegExp(`"index":1,"state":"diagram","hash":"${hash}"`));
  const { describeSlots, latestSlotsRecord } = S.load('core/book-pipeline/image-slots.ts');
  const plan = [{ index: 1, kind: '圖表', explains: '說明1', anchor: 'end' }];
  assert.equal(describeSlots(plan, latestSlotsRecord(detail), [], dHashes(detail))[0].state, 'diagram');
  const edited = detail.replace('"25"', '"26"');
  assert.equal(describeSlots(plan, latestSlotsRecord(edited), [], dHashes(edited))[0].state, 'edited');
  assert.equal((await r.state()).phase, 'done');
});

test('figure slots: a figure and a chart in one reply; a bad figure (unknown type, number not in the text, unsafe text, null chart) is dropped alone and counted by code', async () => {
  const text = (n, v) => ({ ...GOOD_FIGURE, groups: [{ label: n, values: [{ value: v }] }] });
  const { r } = await diagRig({
    base: NUMBERED,
    kinds: ['圖表', '流程', '時間軸', '比較', '示意'],
    draw: () => [figDraft(1, GOOD_FIGURE), draft(2, GOOD_CHART), figDraft(3, { type: 'pie' }), figDraft(4, text('轉盤 10', '26')), figDraft(5, text('a<b', '25'))]
  });
  const detail = (await r.note(0)).detail;
  assert.equal(detail.split('```vam-figure').length - 1, 1);
  assert.equal(detail.split('```mermaid').length - 1, 1);
  for (const i of [3, 4, 5]) assert.match(detail, new RegExp(`"index":${i},"state":"missing"`));
  const log = r.stat.logs.find(l => l.includes('diagram_asked'));
  for (const code of ['figure_type', 'number_not_in_text', 'unsafe_text']) assert.match(log, new RegExp(`diagram_rej_${code}`));
  // The generated card UUID can contain "25"; it is an opaque identifier, not rejected figure content.
  const cardId = / card=[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?= )/i;
  assert.match(log, cardId);
  assert.doesNotMatch(log.replace(cardId, ' card=<uuid>'), /轉盤|25|a<b/);
});

test('figure slots: a number that only an old vam-figure fence holds does not count as text; the draft is rejected and nothing is written', async () => {
  const old = '```vam-figure\n{"type":"bar","unit":"%","stacked":false,"groups":[{"label":"舊","values":[{"value":"99"}]}]}\n```';
  const { r } = await diagRig({ base: `${DRAFT}\n\n${old}`, draw: () => [figDraft(1, { ...GOOD_FIGURE, groups: [{ label: '新', values: [{ value: '99' }] }] })] });
  const detail = (await r.note(0)).detail;
  assert.equal(detail.split('```vam-figure').length - 1, 1, 'only the old fence');
  assert.doesNotMatch(detail, /"label":"新"/);
  assert.match(r.stat.logs.find(l => l.includes('diagram_asked')), /diagram_rej_number_not_in_text/);
});

test('figure slots: a chapter without numbers keeps the slot not_found and the text unchanged', async () => {
  const { r } = await diagRig({ draw: () => [figDraft(1, GOOD_FIGURE)] });
  const detail = (await r.note(0)).detail;
  assert.doesNotMatch(detail, /vam-figure/);
  assert.match(detail, /"index":1,"state":"missing","reasonCode":"not_found"/);
  assert.match(r.stat.logs.find(l => l.includes('diagram_asked')), /diagram_rej_number_not_in_text/);
});

test('figure slots: stop during the call, or a card edited before the write, writes no figure', async () => {
  const entered = defer();
  const { r, running } = await diagRig({
    base: NUMBERED,
    manual: true,
    draw: (request, run) => new Promise((resolve, reject) => { run.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); entered.resolve(); })
  });
  await entered.promise;
  await r.runs.stop(r.mapPath);
  await running.catch(() => undefined);
  await settle();
  assert.doesNotMatch((await r.note(0)).detail, /vam-figure/);
  let edited = false;
  const outcomes = [];
  const holder = {};
  const second = await diagRig({
    base: NUMBERED,
    draw: () => [figDraft(1, GOOD_FIGURE)],
    holder,
    ports: {
      updateNoteGuarded: async (path, patch, options) => {
        if (!edited && /```vam-figure/.test(patch.detail ?? '')) {
          edited = true;
          const note = await holder.r.repo.readNote(path);
          await holder.r.repo.updateNoteGuarded(path, { detail: `${note.detail}\n\n擁有者新增一句。` });
        }
        const out = await holder.r.repo.updateNoteGuarded(path, patch, options);
        if (/```vam-figure/.test(patch.detail ?? '')) outcomes.push(out);
        return out;
      }
    }
  });
  assert.equal(outcomes[0], 'discarded');
  assert.match((await second.r.note(0)).detail, /擁有者新增一句。/);
});

// ai-flows §AI 鎖定: a chapter with `ai-locked: true` is skipped before any call (no plan, write or proof for it), its text stays, and its
// reason is the locked one (not "dropped"); the other chapters run. Program bookkeeping (stage, issue, role keys) is not an AI write.
const LOCKED = /^(?:Topic is locked; AI will not change it|議題已鎖定，AI 不會修改)$/;
const withoutProgramKeys = raw => raw.replace(/^(?:book-role|book-role-by|pipeline-[a-z]+):.*\n/gm, '');
test('AI lock: a locked chapter costs no AI call, keeps its text and shows the locked reason; the other chapters still run', async () => {
  const r = await rig();
  await r.repo.writeAiLocked(r.nodes[2].path, true);
  const before = r.raw(2);
  const id = r.nodes[2].id;
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  assert.equal((await r.state()).phase, 'done');
  assert.ok(!r.stat.plan.includes(id), 'no card plan for the locked chapter');
  assert.ok(!r.stat.author.includes(id), 'no write for the locked chapter');
  assert.ok(!r.stat.proof.some(request => (request.title ?? request.card?.title) === TITLES[2]), 'no proofread for the locked chapter');
  assert.equal(r.stat.author.length, 2, 'the two unlocked chapters are written');
  assert.equal(stageOf(r.raw(0)), 'checked'); assert.equal(stageOf(r.raw(1)), 'checked');
  assert.equal(withoutProgramKeys(r.raw(2)), withoutProgramKeys(before), 'the locked note: nothing but the pipeline keys changed');
  assert.match(r.raw(2), /^ai-locked: true$/m);
  assert.equal(stageOf(r.raw(2)), 'needs-review');
  assert.equal((await r.note(2)).pipelineIssue, 'plan failed: ai_locked');
  const reasons = await boxReasons(r, 2);
  assert.ok(reasons.some(p => LOCKED.test(p.text)), `the locked reason is shown: ${JSON.stringify(reasons)}`);
  assert.ok(!reasons.some(p => /丟棄|已停止|dropped|discarded|stopped/i.test(p.text)), 'not reported as dropped or stopped');
  assert.ok(r.stat.logs.some(line => /ai_locked/.test(line)));
});
test('AI lock: a chapter locked after its plan is not written (no author call) and shows the locked reason', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  assert.equal((await r.state()).phase, 'gate1');
  await r.repo.writeAiLocked(r.nodes[1].path, true);
  const before = r.raw(1);
  await confirmDone(r.runs, r.mapPath);
  assert.ok(!r.stat.author.includes(r.nodes[1].id));
  assert.equal(withoutProgramKeys(r.raw(1)), withoutProgramKeys(before));
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: ai_locked');
  assert.ok((await boxReasons(r, 1)).some(p => LOCKED.test(p.text)));
  assert.equal(stageOf(r.raw(2)), 'checked');
});
test('AI lock: a locked book card (the root) stops the whole-book plan before its call, with the locked code', async () => {
  const r = await rig();
  await r.repo.writeAiLocked(r.nodes[0].path, true);
  const before = r.raw(0);
  await r.runs.start(r.mapPath).catch(() => undefined);
  await settle();
  assert.deepEqual(r.stat.plan, [], 'no whole-book plan call');
  assert.equal((await r.state()).failureCode, 'ai_locked');
  assert.equal(withoutProgramKeys(r.raw(0)), withoutProgramKeys(before));
});
test('AI lock: a lock landing while the author runs is still caught by the write fence (nothing written); the retry is skipped before its call', async () => {
  const holder = {};
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve();
    const note = await holder.r.repo.readNote(input.path);
    if (input.nodeId === holder.r.nodes[1].id) await holder.r.repo.writeAiLocked(input.path, true);
    const out = await holder.r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize, rejectAiCard: true });
    return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' };
  } } });
  holder.r = r;
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  assert.equal(r.stat.author.filter(id => id === r.nodes[1].id).length, 1, 'one call (the lock came during it); the retry made none');
  assert.ok(!(await r.note(1)).detail.includes(bodyOf(TITLES[1])), 'the late result was not written');
  assert.equal((await r.note(1)).pipelineIssue, 'write failed: ai_locked');
  assert.equal(stageOf(r.raw(2)), 'checked');
});
test('AI lock: applying the reader\'s notes to a locked chapter is refused with the locked code before the backup and the call; nothing changes', async () => {
  const r = await notesRig();
  await r.repo.writeAiLocked(r.nodes[1].path, true);
  const before = r.cardRaw();
  const backups = r.stat.backups.length;
  const used = (await r.state()).budget.used;
  await assert.rejects(() => r.runs.applyNotes(r.mapPath, r.nodes[1].id), refusal('ai_locked'));
  assert.equal(r.calls.length, 0); assert.equal(r.stat.backups.length, backups);
  assert.equal(r.cardRaw(), before); assert.equal((await r.state()).budget.used, used);
});

// ai-flows §AI 鎖定, whole-book proofread: a locked chapter is left out of the call itself (its title and text are not sent, no fix target
// of it is asked), never only refused at the write; with every chapter locked no call is made and "fix again" says the book is locked.
const bookCalls = r => r.stat.ai.filter(([k]) => k === 'book');
const sentText = request => JSON.stringify(request);
test('AI lock, whole book: a chapter locked before the book proofread is not in the one call; its file is untouched', async () => {
  const holder = {};
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleA') { await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true); holder.locked = holder.r.raw(1); }
      return { checks: [], prior: [], dropped: {} };
    }
  });
  holder.r = r;
  await finishAi(r);
  assert.ok(holder.locked, 'chapter A was locked after its write');
  const books = bookCalls(r);
  assert.equal(books.length, 1, 'one whole-book call');
  same(books[0][1].chapters.map(c => c.title), ['SecretRootTitle', 'SecretTitleB'], 'the locked chapter is not sent');
  assert.ok(!sentText(books[0][1]).includes('SecretTitleA'), 'no title of the locked chapter in the payload');
  const lockedBody = (await r.note(1)).detail.trim();
  assert.ok(lockedBody.length > 0 && !sentText(books[0][1]).includes(lockedBody), 'no body of the locked chapter in the payload');
  assert.equal(r.raw(1), holder.locked, 'the locked file is byte for byte as locked');
  assert.equal((await r.state()).phase, 'done');
});
test('AI lock, whole book: a chapter locked after the check is not sent to the fix (no target, no text); the other chapter is fixed', async () => {
  const holder = {};
  let fixed = false;
  const r = await aiRig({
    aiBookProof: async request => {
      if (!holder.locked) { await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true); holder.locked = holder.r.raw(1); }
      if (fixed) return { checks: [], prior: [], dropped: {} };
      return { checks: [bookProblem(request, 2, 3), { ...bookProblem(request, 3, 2), id: 'B2' }], prior: [], dropped: {} };
    },
    aiFix: async request => { fixed = true; return request.targets.map(t => ({ id: t.id, chapter: t.chapter, quote: request.chapters.find(c => c.number === t.chapter).text, replacement: `Book corrected ${t.chapter}` })); }
  });
  holder.r = r;
  await finishAi(r);
  const fixes = aiRuns(r, 'fix');
  assert.equal(fixes.length, 1, 'one fix call');
  same(fixes[0][1].chapters.map(c => [c.number, c.title]), [[1, 'SecretRootTitle'], [3, 'SecretTitleB']], 'the open chapters only, with their book numbers');
  same(fixes[0][1].targets.map(t => t.id), ['B2'], 'no target in the locked chapter');
  assert.ok(!sentText(fixes[0][1]).includes('SecretTitleA'));
  assert.equal(r.raw(1), holder.locked, 'the locked file is byte for byte as locked');
  assert.ok((await r.note(2)).detail.includes('Book corrected 3'), 'the open chapter is fixed');
  const books = bookCalls(r);
  assert.ok(books.length >= 2 && !sentText(books.at(-1)[1]).includes('SecretTitleA'), 'the re-check leaves the locked chapter out too');
  assert.equal((await r.state()).phase, 'done');
});
test('AI lock, whole book: every chapter locked: no whole-book call, no fix, every file as locked', async () => {
  const holder = { raws: {} };
  const r = await aiRig({
    aiProof: async request => {
      const at = TITLES.indexOf(request.title);
      await holder.r.repo.writeAiLocked(holder.r.nodes[at].path, true);
      holder.raws[at] = holder.r.raw(at);
      return { checks: [], prior: [], dropped: {} };
    }
  });
  holder.r = r;
  await finishAi(r);
  same(Object.keys(holder.raws).sort(), ['0', '1', '2'], 'every chapter was locked');
  assert.equal(bookCalls(r).length, 0, 'no whole-book call');
  assert.equal(aiRuns(r, 'fix').length, 0);
  for (let i = 0; i < 3; i++) assert.equal(r.raw(i), holder.raws[i], `chapter ${i} is byte for byte as locked`);
  assert.equal((await r.state()).phase, 'done');
  assert.ok(r.stat.logs.some(line => /ai_locked/.test(line)));
});
test('AI lock, whole book: "fix again" over a book whose chapters were all locked afterwards calls nothing and says the book is locked', async () => {
  const r = await aiRig({
    aiBookProof: async request => ({ checks: [bookProblem(request, 2, 3)], prior: [], dropped: {} }),
    aiFix: async () => []
  });
  await finishAi(r);
  for (let i = 0; i < 3; i++) await r.repo.writeAiLocked(r.nodes[i].path, true);
  const raws = [0, 1, 2].map(i => r.raw(i));
  const calls = r.stat.ai.length;
  const saved = JSON.stringify(await r.state());
  let refused;
  await r.runs.fixAgain(r.mapPath).catch(error => { refused = error; });
  while (r.runs.isRunning(r.mapPath)) await tick(); await settle();
  assert.equal(r.stat.ai.length, calls, 'no AI call');
  // `ai_locked` is the refusal the bar shows as the existing ui.ai_locked_notice (REFUSAL_KEY).
  assert.ok(refused instanceof BookPipelineRunError && refused.code === 'ai_locked', `refused as locked: ${refused && refused.code}`);
  assert.equal(JSON.stringify(await r.state()), saved, 'the saved state is not touched');
  for (let i = 0; i < 3; i++) assert.equal(r.raw(i), raws[i]);
});
test('AI lock, whole book: a chapter never checked because it was locked leaves the book proofread incomplete, not solved', async () => {
  const holder = {};
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleA') await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true);
      return { checks: [], prior: [], dropped: {} };
    }
  });
  holder.r = r;
  await finishAi(r);
  const slot = (await r.state()).bookProof;
  assert.equal(slot.done, true);
  assert.equal(slot.incomplete, true, 'the book is not marked as fully checked');
  same(slot.locked, [r.nodes[1].id], 'the chapter left out is named');
});
// B33-z: a chapter the whole-book check left out because it was locked is "skipped (locked)", never "did not finish"; with nothing else
// open the book gets no page, only a notice naming the skipped chapters (and the bar no button to a page).
const lockedSkipRig = async (aiProof = async () => ({ checks: [], prior: [], dropped: {} }), v = pageVault()) => {
  const holder = { v, skipped: [] };
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleA') await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true);
      return aiProof(request, holder.r);
    }
  }, { ports: { writeOpenIssues: holder.v.port, lockedSkipped: titles => holder.skipped.push(titles) } });
  holder.r = r;
  await finishAi(r);
  return { r, holder };
};
test('AI lock, whole book (B33-z): one chapter locked, the rest solved: no closing page, a notice names the skipped chapter, the bar has no button', async () => {
  const { r, holder } = await lockedSkipRig();
  const state = await r.state();
  same(state.bookProof.locked, [r.nodes[1].id], 'the book still records the skipped chapter (so "fix again" can take it back once unlocked)');
  assert.equal(state.bookProof.incomplete, true);
  assert.equal(state.phase, 'done');
  same(pageFiles(holder.v), [], 'no "still open" page for a book whose only gap is a locked chapter');
  same(holder.skipped, [['SecretTitleA']], 'one notice, naming the locked chapter');
  assert.equal(state.closingSkipped, true, 'the decision is saved');
  assert.equal(closingPageSkipped(state), true, 'the bar reads the same: no page, no button');
});
test('AI lock, whole book (B33-z): one chapter locked and another whose check failed: the page is written; the locked one is "skipped (locked)", only the failed one "did not finish"', async () => {
  const { r, holder } = await lockedSkipRig(async request => { if (request.title === 'SecretTitleB') throw new Error('boom'); return { checks: [], prior: [], dropped: {} }; });
  const state = await r.state();
  assert.equal(state.aiProof[r.nodes[2].id].incomplete, true, 'chapter B did not finish');
  const page = pageFiles(holder.v).map(([, text]) => text).join('\n');
  assert.match(page, /^- SecretTitleA：略過（已鎖定）/m, `the locked chapter is marked as skipped: ${page}`);
  assert.doesNotMatch(page, /SecretTitleA：AI 校對沒有跑完/, 'the locked chapter is not listed as unfinished');
  assert.match(page, /^- SecretTitleB：AI 校對沒有跑完/m, 'the failed chapter keeps the unfinished line');
  assert.match(page, /仍有 1 項沒解決。 另有 1 章略過（已鎖定）。/, `N counts the failed chapter only; the skipped one has its own sentence: ${page}`);
  same(holder.skipped, [], 'no notice: the page says it');
  assert.equal(state.closingSkipped, false);
  assert.equal(closingPageSkipped(state), false);
});
test('AI lock, whole book (B33-z): one chapter locked and another accepted with a cover that may not fit: the page is written, the bar keeps its button, no notice', async () => {
  const { r, holder } = await lockedSkipRig(async (request, rig) => {
    if (request.title === 'SecretTitleB') {
      const path = rig.nodes[2].path;
      rig.contents.set(path, setCoverRecord(rig.contents.get(path), { file: 'Covers/b.png', key: 'k-b', off: 1 }));
    }
    return { checks: [], prior: [], dropped: {} };
  });
  const state = await r.state();
  assert.notEqual(r.raw(2).match(/^stage: .*$/m)?.[0], 'stage: needs-review', 'the chapter is not in needs-review (accepted)');
  const page = pageFiles(holder.v).map(([, text]) => text).join('\n');
  assert.match(page, /^- SecretTitleB：封面圖可能對不上/m, `the cover item is on the page: ${page}`);
  assert.match(page, /^- SecretTitleA：略過（已鎖定）/m);
  same(holder.skipped, [], 'no notice saying nothing else is open');
  assert.equal(closingPageSkipped(state), false, 'the bar keeps its button');
});
test('AI lock, whole book (B33-z): an earlier page of ours is rewritten (not left stale, no new file) when only a locked chapter is left', async () => {
  const dir = 'Agent Workspace/Mind Maps/Book/Notes';
  const old = `${OPEN_ISSUES_MARKER}\n\n# old\n\n- SecretTitleB：AI 校對沒有跑完，這章沒有完整查過\n`;
  const v = pageVault(new Map([[`${dir}/仍有問題.md`, old]]));
  const { r, holder } = await lockedSkipRig(undefined, v);
  const pages = pageFiles(holder.v);
  same(pages.map(([path]) => path), [`${dir}/仍有問題.md`], 'the same file, no new one');
  assert.match(pages[0][1], /^- SecretTitleA：略過（已鎖定）/m, `rewritten with the skipped chapter: ${pages[0][1]}`);
  assert.doesNotMatch(pages[0][1], /沒有跑完/, 'nothing stale stays');
  assert.doesNotMatch(pages[0][1], /仍有 \d+ 項沒解決/, 'the skipped chapter is not counted as unsolved');
  assert.match(pages[0][1], /另有 1 章略過（已鎖定）。/);
  same(holder.skipped, [['SecretTitleA']]);
  assert.equal(closingPageSkipped(await r.state()), true);
});
test('AI lock, whole book (B33-z): every chapter locked: no page, one notice naming every chapter', async () => {
  const holder = { v: pageVault(), skipped: [] };
  const r = await aiRig({
    aiProof: async request => { await holder.r.repo.writeAiLocked(holder.r.nodes[TITLES.indexOf(request.title)].path, true); return { checks: [], prior: [], dropped: {} }; }
  }, { ports: { writeOpenIssues: holder.v.port, lockedSkipped: titles => holder.skipped.push(titles) } });
  holder.r = r;
  await finishAi(r);
  same(pageFiles(holder.v), []);
  same(holder.skipped, [TITLES], 'one notice, every chapter named');
  assert.equal(closingPageSkipped(await r.state()), true);
});
// The finding in chapter A (book chapter 2) is found by the first check; A is locked during that check, so it is never fixed or re-checked.
const lockedFindingRig = async (aiFix = async request => request.targets.map(t => ({ id: t.id, chapter: t.chapter, quote: request.chapters.find(c => c.number === t.chapter).text, replacement: `Book corrected ${t.chapter}` }))) => {
  const holder = { checks: 0, v: pageVault() };
  const r = await aiRig({
    aiBookProof: async request => {
      holder.checks++;
      if (holder.fail) throw new Error('book check down');
      if (holder.checks === 1) {
        await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true); holder.locked = holder.r.raw(1);
        return { checks: [bookProblem(request, 2, 3), { ...bookProblem(request, 3, 2), id: 'B2' }], prior: [], dropped: {} };
      }
      return { checks: [], prior: [], dropped: {} };
    },
    aiFix: (...args) => aiFix(...args)
  }, { ports: { writeOpenIssues: holder.v.port } });
  holder.r = r;
  await finishAi(r);
  return { r, holder };
};
test('AI lock, whole book: a known finding in a chapter locked after the check stays open as locked after the re-check; the book is incomplete', async () => {
  const { r, holder } = await lockedFindingRig();
  const slot = (await r.state()).bookProof;
  assert.equal(slot.done, true);
  const kept = slot.open.filter(item => item.chapter === 2);
  assert.equal(kept.length, 1, `the locked chapter's finding is still open: ${JSON.stringify(slot.open)}`);
  assert.equal(kept[0].reason, 'ai_locked');
  assert.equal(slot.incomplete, true, 'not shown as complete with nothing open');
  assert.equal(r.raw(1), holder.locked, 'the locked file is byte for byte as locked');
  const page = pageFiles(holder.v).map(([, text]) => text).join('\n');
  assert.match(page, /SecretTitleA：chapters disagree：這章已鎖定/, `the closing page lists the kept finding as locked: ${page}`);
  assert.match(page, /SecretTitleA：略過（已鎖定）/, 'and names the locked chapter as skipped (B33-z: not as unfinished)');
  assert.doesNotMatch(page, /SecretTitleA：AI 校對沒有跑完/);
});
test('AI lock, whole book: once the chapter is unlocked, "fix again" sends its kept finding and the re-check covers it; the book is complete again', async () => {
  const { r } = await lockedFindingRig();
  await r.repo.writeAiLocked(r.nodes[1].path, false);
  const fixes = aiRuns(r, 'fix').length;
  const books = bookCalls(r).length;
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const fix = aiRuns(r, 'fix').slice(fixes);
  assert.equal(fix.length, 1, 'one fix call');
  same(fix[0][1].targets.map(t => t.chapter), [2], 'the kept finding of the unlocked chapter is the target');
  assert.ok(sentText(bookCalls(r).at(-1)[1]).includes('SecretTitleA') && bookCalls(r).length > books, 'the re-check reads the unlocked chapter');
  assert.ok((await r.note(1)).detail.includes('Book corrected 2'), 'the unlocked chapter is fixed');
  const slot = (await r.state()).bookProof;
  assert.ok(!slot.incomplete && !slot.locked, 'complete again');
  assert.ok(!slot.open.some(item => item.reason === 'ai_locked'));
});
test('AI lock, whole book: unlocked, "fix again" whose re-check keeps failing gives up the whole book: the old locked list is gone, no more "fix again", the page says the book is not finished', async () => {
  const { r, holder } = await lockedFindingRig();
  await r.repo.writeAiLocked(r.nodes[1].path, false);
  holder.fail = true;
  await r.runs.fixAgain(r.mapPath); await settleRuns(r);
  const state = await r.state();
  const slot = state.bookProof;
  assert.equal(slot.done, true);
  assert.equal(slot.incomplete, true, 'the failed re-check leaves the book incomplete');
  assert.equal(slot.locked, undefined, `no stale locked chapters: ${JSON.stringify(slot.locked)}`);
  assert.equal(fixAgainPlan(state, 0).book, false, 'a failed proofread is not offered one more round');
  const page = pageFiles(holder.v).at(-1)[1];
  assert.doesNotMatch(page, /SecretTitleA：AI 校對沒有跑完/, `the unlocked chapter is not named as the reason: ${page}`);
  assert.match(page, /^- AI 校對沒有跑完，這章沒有完整查過$/m, 'the book as a whole is named as not fully checked');
});
test('AI lock, whole book: the check\'s chapter numbers map back past a chapter locked before it: chapter 2 of the call is the book\'s chapter 3', async () => {
  const holder = {};
  let fixed = false;
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleA') { await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true); holder.locked = holder.r.raw(1); }
      return { checks: [], prior: [], dropped: {} };
    },
    aiBookProof: async request => (fixed ? { checks: [], prior: [], dropped: {} } : { checks: [bookProblem(request, 2, 1)], prior: [], dropped: {} }),
    aiFix: async request => { fixed = true; return request.targets.map(t => ({ id: t.id, chapter: t.chapter, quote: request.chapters.find(c => c.number === t.chapter).text, replacement: `Book corrected ${t.chapter}` })); }
  });
  holder.r = r;
  await finishAi(r);
  const fix = aiRuns(r, 'fix');
  assert.equal(fix.length, 1);
  same(fix[0][1].targets.map(t => t.chapter), [3], 'the target is the book\'s chapter 3 (B)');
  assert.ok((await r.note(2)).detail.includes('Book corrected 3'), 'chapter B is fixed');
  assert.equal(r.raw(1), holder.locked, 'the locked chapter is byte for byte as locked');
});
test('AI lock, whole book: "fix again" whose problems are all in a locked chapter (the others are open) calls nothing and says it is locked', async () => {
  const r = await aiRig({
    aiBookProof: async request => ({ checks: [bookProblem(request, 2, 3)], prior: [], dropped: {} }),
    aiFix: async () => []
  });
  await finishAi(r);
  assert.ok((await r.state()).bookProof.open.some(item => item.chapter === 2), 'the book has a fixable problem in chapter 2');
  await r.repo.writeAiLocked(r.nodes[1].path, true);
  const raws = [0, 1, 2].map(i => r.raw(i));
  const calls = r.stat.ai.length;
  const saved = JSON.stringify(await r.state());
  let refused;
  await r.runs.fixAgain(r.mapPath).catch(error => { refused = error; });
  await settleRuns(r);
  assert.equal(r.stat.ai.length, calls, 'no AI call, no whole-book re-check');
  assert.ok(refused instanceof BookPipelineRunError && refused.code === 'ai_locked', `refused as locked: ${refused && refused.code}`);
  assert.equal(JSON.stringify(await r.state()), saved, 'the saved state is not touched');
  for (let i = 0; i < 3; i++) assert.equal(r.raw(i), raws[i]);
});

// ai-flows §AI 鎖定 ("AI 不會修改"): after the whole-book proofread the callouts writer (BookCallouts, as main.ts wires it over the note
// writer) leaves a locked chapter's bytes alone: no "AI 校對：查了 0 項" box is put in, an old box is neither rewritten nor taken off. Only
// the pipeline's own frontmatter keys may change on a locked chapter; the run writes none of them after the lock here, so the list is
// what the program could write (writePipelineFields / writePipelineRole), not what it did.
const { BookCallouts } = S.load('experiences/visual-map/book-pipeline-callouts.ts');
const PIPELINE_KEYS = ['pipeline-stage', 'pipeline-issue', 'pipeline-seam', 'pipeline-role', 'book-role'];
const withoutPipelineKeys = raw => raw.split('\n').filter(line => !PIPELINE_KEYS.some(key => line.startsWith(`${key}:`))).join('\n');
const calloutsOf = r => new BookCallouts({
  readMap: p => r.repo.readMap(p),
  readCard: p => r.ports.readCard(p),
  readText: async p => r.contents.get(p),
  write: createNoteWriter({ openViews: () => [], rawGuarded: (p, transform, options) => r.repo.updateNoteRawGuarded(p, transform, options) }),
  log: () => {}
});
const AI_BOX = /AI 校對|vam-review/;
test('AI lock, whole book: the callouts writer leaves a chapter locked during the run as locked: no AI box, every byte but the pipeline keys kept; the open chapter gets its box', async () => {
  const holder = {};
  const r = await aiRig({
    aiProof: async request => {
      if (request.title === 'SecretTitleA') { await holder.r.repo.writeAiLocked(holder.r.nodes[1].path, true); holder.locked = holder.r.raw(1); }
      return { checks: [], prior: [], dropped: {} };
    }
  });
  holder.r = r;
  await finishAi(r);
  assert.equal((await r.state()).phase, 'done');
  const callouts = calloutsOf(r);
  await callouts.reconcile(r.mapPath); await callouts.idle();
  assert.ok(AI_BOX.test(r.raw(2)), 'the open chapter has its AI box (the writer ran)');
  assert.ok(!AI_BOX.test(r.raw(1)), 'no AI box in the locked chapter');
  assert.equal(withoutPipelineKeys(r.raw(1)), withoutPipelineKeys(holder.locked), 'the locked chapter is byte for byte as locked, the pipeline keys aside');
});
test('AI lock, whole book: a box written before the lock stays as it was through the next align, a clear and an align with no run', async () => {
  const r = await aiRig({});
  await finishAi(r);
  const callouts = calloutsOf(r);
  await callouts.reconcile(r.mapPath); await callouts.idle();
  assert.ok(AI_BOX.test(r.raw(1)), 'chapter A got its box while open');
  await r.repo.writeAiLocked(r.nodes[1].path, true);
  const locked = r.raw(1);
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; });
  await callouts.reconcile(r.mapPath); await callouts.idle();
  assert.equal(r.raw(1), locked, 'an align that wants no box leaves the locked box');
  assert.ok(!AI_BOX.test(r.raw(2)), 'the open chapter\'s box goes (the writer ran)');
  await callouts.clear(r.mapPath);
  assert.equal(r.raw(1), locked, 'a clear leaves the locked box');
  await r.repo.updateMap(r.mapPath, d => { delete d.bookPipeline; });
  await callouts.reconcile(r.mapPath); await callouts.idle();
  assert.equal(r.raw(1), locked, 'an align with no run leaves the locked box');
});
test('AI lock, whole book: every chapter locked and nothing checked: no new file in the vault (no "still open" page), every chapter as locked', async () => {
  const holder = { raws: {} };
  const files = { get: p => holder.r.contents.get(p), set: (p, text) => holder.r.contents.set(p, text) };
  const v = pageVault(files);
  const r = await aiRig({
    aiProof: async request => {
      const at = TITLES.indexOf(request.title);
      await holder.r.repo.writeAiLocked(holder.r.nodes[at].path, true);
      holder.raws[at] = holder.r.raw(at);
      holder.files = [...holder.r.contents.keys()].sort();
      return { checks: [], prior: [], dropped: {} };
    }
  }, { ports: { writeOpenIssues: v.port } });
  holder.r = r;
  await finishAi(r);
  same(Object.keys(holder.raws).sort(), ['0', '1', '2'], 'every chapter was locked');
  assert.equal((await r.state()).phase, 'done', 'the book is done without the page');
  const callouts = calloutsOf(r);
  await callouts.reconcile(r.mapPath); await callouts.idle();
  same([...r.contents.keys()].sort(), holder.files, 'no file added after the last lock');
  for (let i = 0; i < 3; i++) {
    assert.ok(!AI_BOX.test(r.raw(i)), `no AI box in chapter ${i}`);
    assert.equal(withoutPipelineKeys(r.raw(i)), withoutPipelineKeys(holder.raws[i]), `chapter ${i} is byte for byte as locked, the pipeline keys aside`);
  }
});
