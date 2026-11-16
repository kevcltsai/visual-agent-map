// Picture-book pipeline runner (03a): the gates, retries, budget pause, stop/resume, stale fence, dispose, guarded writes and the picture
// allow-list of BookPipelineRuns, with fake ports over the real repository fixture. The provider, probe and step runner are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { BookPipelineRuns, BookPipelineRunError, bodyImageUrls, replaceBodyImages } = S.load('experiences/visual-map/book-pipeline-run.ts');
const { BudgetExhaustedError } = S.load('core/admission.ts');
const { readBookPipeline } = S.load('core/book-pipeline/model.ts');
const { cardRevision } = S.load('core/book-pipeline/machine.ts');
const { proofKey } = S.load('core/book-pipeline/proof.ts');
const { findStoredProof, withoutResearchNotes } = S.load('core/book-pipeline/note-sections.ts');
const { parseChecklist } = S.load('core/book-pipeline/plan-text.ts');

const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
const TITLES = ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB'];
const bodyOf = title => `SecretBody ${title}`;
const stageOf = raw => /^pipeline-stage: "?([a-z-]+)"?$/m.exec(raw)?.[1];

/** A map of one root and two child cards (reading order: root, A, B), the fake ports and call counters. `over` replaces ports/script. */
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
    author: async input => { await input.admission.reserve(); const note = await repo.readNote(input.path); const r = await repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize }); return r === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
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
  await assert.rejects(() => r.runs.confirmGate1(r.mapPath).then(() => r.runs.confirmGate1(r.mapPath)), e => e instanceof BookPipelineRunError && e.code === 'not_gate1');
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
  const r = await rig({ script: { author: async (input, n) => { if (input.nodeId === bad.id) throw new Error('boom'); await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize }); return { outcome: 'written' }; } } });
  bad.id = r.nodes[1].id;
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
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

test('the budget running out pauses without marking a card; addBudget resumes and finishes; another map is not touched', async () => {
  const r = await rig();
  const other = await rig();
  await r.runs.start(r.mapPath);
  await setLimit(r, 6); // 4 used by planning: two more calls
  await r.runs.confirmGate1(r.mapPath);
  let s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget'); assert.equal(s.phase, 'writing');
  assert.equal(r.runs.getProgress(r.mapPath).pauseReason, 'budget');
  for (let i = 0; i < 3; i++) assert.notEqual(stageOf(r.raw(i)), 'needs-review');
  assert.ok(Object.values(s.attempts).every(a => typeof a === 'number' || (a.write <= 1 && a.plan <= 1)));
  // the other map (its own budget gate) and a call without a gate are unaffected
  await other.runs.start(other.mapPath); await other.runs.confirmGate1(other.mapPath);
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
    if (input.nodeId === r.nodes[1].id && first) { first = false; await hold.promise; const out = await r.repo.updateNoteGuarded(input.path, { detail: 'LATE' }, { authorize: input.authorize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; }
    await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize }); return { outcome: 'written' };
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
    if (input.nodeId === r.nodes[2].id && n === 1) { await hold.promise; await r.repo.updateNoteGuarded(input.path, { detail: 'AFTER DISPOSE' }, { authorize: input.authorize }); return { outcome: 'written' }; }
    await input.admission.reserve(); const note = await r.repo.readNote(input.path); await r.repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize }); return { outcome: 'written' };
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
    await r.repo.updateNoteGuarded(input.path, { detail: `${bodyOf(note.title)}\n\n![](https://img.example/a.png)` }, { authorize: input.authorize });
    return { outcome: 'written' };
  }, probe: async (url, signal, n) => {
    if (n === 1) await r.repo.updateNote(r.nodes[0].path, { summary: 'owner summary' }); // the owner edits after the runner's last read
    return n === 1 ? { ok: false, reason: 'gone' } : { ok: true };
  } } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  assert.ok(seen.length >= 3 && seen.every(([a, b]) => a === b && a === 'planned'));
  assert.equal((await r.note(0)).summary, 'owner summary', 'the owner text survived');
  assert.ok(r.stat.author.filter(id => id === r.nodes[0].id).length >= 2, 'the discarded step was tried again');
  assert.equal((await r.state()).phase, 'gate2');
});

test('pictures: a non-https address is not probed; an https failure becomes "無圖：原因"; a good https picture stays', async () => {
  const r = await rig({ script: { author: async input => {
    await input.admission.reserve(); const note = await r.repo.readNote(input.path);
    const text = `${bodyOf(note.title)}\n\n![a](http://plain.example/a.png)\n\n![b](javascript:alert(1))\n\n![c](https://dead.example/c.png)\n\n![d](https://ok.example/d.png)`;
    await r.repo.updateNoteGuarded(input.path, { detail: text }, { authorize: input.authorize });
    return { outcome: 'written' };
  }, probe: async url => (url.includes('dead') ? { ok: false, reason: '404' } : { ok: true }) } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  assert.ok(r.stat.probes.every(u => u.startsWith('https://')), 'only https is probed');
  assert.ok(!r.stat.probes.some(u => u.includes('plain') || u.startsWith('javascript')));
  const detail = (await r.note(1)).detail;
  assert.ok(detail.includes('無圖：404') && detail.includes('無圖：網址不安全'));
  assert.ok(!detail.includes('http://plain') && !detail.includes('javascript:') && !detail.includes('dead.example'));
  assert.ok(detail.includes('![d](https://ok.example/d.png)'));
});

test('picture allow-list: every form that could load a remote resource is rewritten, whatever its shape', () => {
  const none = new Map();
  const loads = out => /!\[[^\]\n]*\]\(|!\[[^\]\n]*\]\[|<\/?(?:img|picture|source|iframe|video|audio|object|embed)\b|!\[\[\s*(?:[a-z][a-z0-9+.-]*:|\/\/)|url\s*\(|^ {0,3}\[[^\]\n]+\]:\s*\S/im.test(out);
  const cases = {
    'inline http': '![x](http://e.example/a.png)',
    'inline angle brackets': '![x](<http://e.example/a b.png>)',
    'inline nested parens': '![x](http://e.example/a_(1).png)',
    'inline javascript': '![x](javascript:alert(1))',
    'inline data': '![x](data:image/svg+xml;base64,AAAA)',
    'inline with title': '![x](http://e.example/a.png "t")',
    'reference': '![x][r]\n\n[r]: http://e.example/a.png',
    'reference angle': '![x][r]\n\n[r]: <http://e.example/a.png> "t"',
    'reference collapsed': '![r][]\n\n[r]: http://e.example/a.png',
    'reference shortcut': '![r]\n\n[r]: javascript:alert(1)',
    'html img': '<img src="https://ok.example/a.png">',
    'html img split over lines': '<img\n  src="https://ok.example/a.png"\n>',
    'html IMG upper case': '<IMG SRC=https://ok.example/a.png>',
    'html picture': '<picture><source srcset="https://ok.example/a.webp"><img src="https://ok.example/a.png"></picture>',
    'html iframe': '<iframe src="https://ok.example/"></iframe>',
    'html video': '<video src="https://ok.example/a.mp4" poster="https://ok.example/p.png"></video>',
    'html audio': '<audio src="https://ok.example/a.mp3"></audio>',
    'html object': '<object data="https://ok.example/a.swf"></object>',
    'html embed': '<embed src="https://ok.example/a.swf">',
    'html style url': '<p style="background:url(https://ok.example/a.png)">text</p>',
    'obsidian embed https': '![[https://ok.example/a.png]]',
    'obsidian embed http': '![[http://e.example/a.png]]',
    'obsidian embed data': '![[data:image/png;base64,AAAA]]',
    'alt with a bracket (not understood)': '![a [b]](https://ok.example/a.png)',
    'alt holding html': '![<img src=x>](https://ok.example/a.png)'
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.ok(loads(input) || name.includes('not understood'), `${name}: the sample itself loads`);
    const out = replaceBodyImages(`---\ntitle: t\n---\n${input}\n`, none);
    assert.ok(!loads(out) || /^!\[a \[b\]\]/.test(out.split('---\n')[2] ?? ''), `${name}: ${JSON.stringify(out)}`);
    assert.ok(out.includes('無圖：'), `${name}: says why`);
    assert.ok(out.startsWith('---\ntitle: t\n---\n'), `${name}: frontmatter kept`);
  }
  // not understood: the leading "![" is replaced, so nothing can render as an image
  assert.ok(!replaceBodyImages('![a [b]](https://ok.example/a.png)', none).includes('!['));
  // what stays: a good https image (inline and reference form), a local embed, code-free text; frontmatter is never changed
  const good = '![x](https://ok.example/a.png)\n\n![y][r]\n\n[r]: https://ok.example/b.png\n\n![[local.png]]\n\nplain text';
  assert.equal(replaceBodyImages(good, none), good);
  assert.deepEqual([...bodyImageUrls(good)].sort(), ['https://ok.example/a.png', 'https://ok.example/b.png']);
  const failed = new Map([['https://ok.example/b.png', '無圖：404']]);
  const out = replaceBodyImages(good, failed);
  assert.ok(out.includes('無圖：404') && !out.includes('b.png') && out.includes('![x](https://ok.example/a.png)'));
  assert.equal(replaceBodyImages('---\nimg: "![](http://e.example/a.png)"\n---\nbody', none), '---\nimg: "![](http://e.example/a.png)"\n---\nbody');
  // idempotent
  const once = replaceBodyImages(Object.values(cases).join('\n\n'), none);
  assert.equal(replaceBodyImages(once, none), once);
});

test('log lines carry ids, counts and codes only: no title and no body text', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath); await r.runs.confirmGate1(r.mapPath);
  const log = r.stat.logs.join('\n');
  assert.ok(r.stat.logs.length > 5 && log.includes('run=run-1'));
  assert.ok(!/Secret/.test(log) && !log.includes('summary of') && !log.includes('one thread'));
});

test('a proof already stored under the same key is reused: no second AI call', async () => {
  const r = await rig();
  await r.runs.start(r.mapPath); await r.runs.confirmGate1(r.mapPath);
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
  await r.runs.start(r.mapPath); await r.runs.confirmGate1(r.mapPath);
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
