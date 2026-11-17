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
const { findStoredProof, withoutResearchNotes, appendResearchNote, dropPlaceholderSections, markOldProofRecords } = S.load('core/book-pipeline/note-sections.ts');
const { parseChecklist } = S.load('core/book-pipeline/plan-text.ts');

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
    updateMap: (path, change) => repo.updateMap(path, change),
    readCard: async path => {
      const note = await repo.readNote(path);
      return { path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(path), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}) } };
    },
    writePipelineFields: (path, patch) => { stat.writes++; return repo.writePipelineFields(path, patch); },
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
    config: () => ({ planModel: 'm1', authorModel: 'm2', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
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
  assert.match(r.raw(0), /## 全書企劃/);
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
  const detail = r.raw(i).replace(/^---\n[\s\S]*?\n---\n/, '');
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
  const FAIL_SECTION = '\n## 校對結果（最新一次）\n\n- 失敗：unsafe\\_body\n';
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
    const r = await rig({ titles: ['SecretRootTitle'], script: { author: async input => {
      await input.admission.reserve();
      await r.repo.updateNoteGuarded(input.path, { detail: reasons.map((_, i) => `![p${i}](https://x.example/${i}.png)`).join('\n\n') }, { authorize: input.authorize, finalize: input.finalize });
      return { outcome: 'written' };
    }, probe: async url => ({ ok: false, reason: reasons[Number(/(\d)\.png/.exec(url)[1])] }) }, ports: { config: () => ({ planModel: 'm1', authorModel: 'm2', proofModel: 'm3', reasoning: 'low', language }) } });
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
  assert.match(r.raw(1), /> \[!note\]-/);
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
  assert.equal(r.stat.proof.length, r.nodes.length, 'one proofread per card: pages were opened but no fact verified is not retried (Primary decision)');
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

test('a written chapter with no picture gets one "no picture" line in the research notes (body untouched, no duplicate on a rewrite); one with a picture gets none; the log has pictures=n', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  for (let i = 0; i < 3; i++) {
    const detail = (await r.note(i)).detail;
    assert.equal(detail.split('無圖：未找到可驗證的公開圖片').length - 1, 1, `card ${i}: one line`);
    assert.equal(withoutResearchNotes(detail).replace(/\s+$/, ''), bodyOf(TITLES[i]) + '', 'the body text is as the author wrote it');
  }
  assert.ok(r.stat.logs.some(line => / pictures=0$/.test(line) && /book-pipeline pictures /.test(line)));
  assert.ok(!r.stat.logs.some(line => /SecretBody|SecretTitle/.test(line)));
});

test('a chapter whose body already carries a picture is not given the no-picture line', async () => {
  const body = title => `SecretBody ${title}\n\n![x](https://upload.wikimedia.org/a.jpg)`;
  const r = await rig();
  r.script.author = async input => { await input.admission.reserve(); const note = await r.repo.readNote(input.path); const w = await r.repo.updateNoteGuarded(input.path, { detail: body(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return w === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };
  await r.runs.start(r.mapPath);
  await confirmDone(r.runs, r.mapPath);
  for (let i = 0; i < 3; i++) assert.ok(!(await r.note(i)).detail.includes('無圖：未找到'));
  assert.ok(r.stat.logs.some(line => / pictures=1$/.test(line)));
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
  const cfg = { planModel: 'plan-A', authorModel: 'author-A', proofModel: 'proof-A', reasoning: 'low', language: 'zh-TW' };
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
const SECTION = '## 校對結果（最新一次）';
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
    assert.match(section, /- C1 達成\n- C2 達成/);
    assert.ok(!section.includes('fine'), 'a met item shows no note');
    assert.match(section, /- 作者模型：Label＜m2＞/); assert.match(section, /- 校對模型：Label＜m3＞/);
    assert.match(raw, /^model: "?model-a"?$/m);
  }
  for (const line of r.stat.logs) { assert.ok(!/校對結果|Label|m2|m3|SecretBody/.test(line), line); }
});

test('T1 proof section: an unmet item shows its note; a rerun replaces the section and the record (not accumulated) and the proof never sees the section', async () => {
  const r = await rig({ script: { proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: c.id === 'C2' ? 'unmet' : 'met', note: 'needs an end', sources: [] })), aggregate: 'needs-review' }) } });
  await finish(r);
  assert.match(r.raw(0), /- C2 未達成：needs an end/);
  await rerun(r, 0);
  const raw = r.raw(0);
  assert.equal(count(raw, SECTION), 1);
  assert.equal(count(raw, 'book-proof:v1'), 1, 'the research notes keep the latest record only');
  assert.ok(!raw.includes('（舊版）'));
  for (const request of r.stat.proof) assert.ok(!request.body.includes('校對結果') && !request.body.includes('作者模型'));
});

test('T1 models: the author model is the id actually dispatched (not the frontmatter model); a Haiku author shows Haiku and frontmatter model stays', async () => {
  const r = await rig({ ports: { config: () => ({ planModel: 'm1', authorModel: 'claude-haiku-4-5', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }) } });
  const before = /^model: .*$/m.exec(r.raw(1))[0];
  await finish(r);
  assert.match(r.raw(1), /- 作者模型：claude-haiku-4-5/);
  assert.equal(/^model: .*$/m.exec(r.raw(1))[0], before);
  assert.ok(r.raw(1).includes(`"authorModel":"claude-haiku-4-5"`));
});

test('T1 failure: a failed proof writes "失敗：原因" in the section with no model line; the card needs review', async () => {
  const r = await rig({ script: { proof: async () => { throw new Error('nope'); } } });
  await finish(r);
  const raw = r.raw(1);
  assert.equal(count(raw, SECTION), 1);
  assert.match(raw, /校對結果（最新一次）\n\n- 失敗：failed\n/);
  assert.ok(!/作者模型|校對模型/.test(raw.slice(raw.indexOf(SECTION))));
  assert.equal(stageOf(raw), 'needs-review');
});

test('T1 failure: a failed author step (write) shows its code in the section; discarded / removed reasons write no section', async () => {
  const r = await rig({ script: { author: async () => { throw new Error('boom'); } } });
  await finish(r);
  assert.match(r.raw(1), /校對結果（最新一次）\n\n- 失敗：failed\n/);
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
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/\n## 校對結果（最新一次）[\s\S]*?(?=\n<!--|\n> \[!|$)/, ''), {});
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
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, c => c.replace(/\n## 校對結果（最新一次）[\s\S]*?(?=\n<!--|\n> \[!|$)/, ''), {});
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
  await r.repo.updateNoteRawGuarded(r.nodes[0].path, c => c.replace(/\n## 校對結果（最新一次）[\s\S]*$/, '\n'), {});
  await r.repo.updateNoteGuarded(r.nodes[0].path, { detail }, {});
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
