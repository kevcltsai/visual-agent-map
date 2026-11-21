// Picture-book toolbar (no panel): the runner finish path, the seam label, the bar ETA and the card right-click rerun. Part A drives a real
// BookPipelineRuns (fake AI ports, real repository fixture) to gate 2; part B runs the view's own methods on the stand-in DOM.
// Real Obsidian look, focus ring and the 400px pane are UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');
const notices = [];
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export { BookReviewMemory, runTrackedRerun } from "./experiences/visual-map/book-pipeline-review";
export { BookPipelineRuns, BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage } from "./i18n";
export { shortHash } from "./core/book-pipeline/image-slots";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice(notices), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
const { setUiLanguage } = bundle;
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const all = (el, cls) => dom.findAll(el, i => (i.cls ?? '').split(/\s+/).includes(cls));
const one = (el, cls) => all(el, cls)[0];
const texts = el => dom.findAll(el, i => i.text).map(i => i.text);
const EVIL = 'fine <img src=x onerror=alert(1)> ![pic](http://example.test/a.png)';


// ---- part A: real runner at gate 2 ----
const confirmDone = async (runs, mapPath) => { await runs.confirmGate1(mapPath); while (runs.isRunning(mapPath)) await new Promise(resolve => setImmediate(resolve)); };
async function rig() {
  setUiLanguage('zh-TW');
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of ['Root', 'Da Vinci', 'Michelangelo']) nodes.push(await repo.createNote(title, 'model-a', doc, mapPath, 'workspace', { summary: `summary of ${title}` }));
  nodes.forEach((node, i) => { node.x = i * 300; node.y = 0; if (i) node.parentId = nodes[0].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { author: [], proof: [] };
  const script = {
    proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: EVIL, sources: [] })), aggregate: 'checked' }),
    author: async input => { await input.admission.reserve(); const note = await repo.readNote(input.path); const out = await repo.updateNoteGuarded(input.path, { detail: `Body of ${note.title}` }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; }
  };
  let queue = Promise.resolve();
  let ids = 0;
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: p => repo.readMap(p), updateMap: (p, change) => repo.updateMap(p, change),
    readCard: async p => { const note = await repo.readNote(p); return { path: p, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(p), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineRole ? { pipelineRole: note.pipelineRole } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}), ...(note.pipelineSeam ? { pipelineSeam: note.pipelineSeam } : {}) } }; },
    writePipelineFields: (p, patch) => repo.writePipelineFields(p, patch),
    updateNoteGuarded: (p, patch, options) => repo.updateNoteGuarded(p, patch, options),
    updateNoteRawGuarded: (p, transform, options) => repo.updateNoteRawGuarded(p, transform, options),
    runPlan: async (step, request, run) => {
      await run.admission.reserve();
      if (step.id === 'book-pipeline.global-plan') return { thread: 'one thread', cards: nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: {} };
      return { covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }] };
    },
    runProofread: async (request, run) => { stat.proof.push(request); await run.admission.reserve(); return script.proof(request); },
    author: input => { stat.author.push(input.nodeId); return script.author(input); },
    probeImage: async () => ({ ok: true }),
    backupNote: async p => ({ ok: true, path: `${p}.bak` }),
    blocked: () => false,
    config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z', newId: () => `run-${++ids}`, log() {}
  };
  const runs = new bundle.BookPipelineRuns(ports);
  await runs.start(mapPath);
  await confirmDone(runs, mapPath);
  // The run finishes by itself now; these tests are about a book saved at gate 2 (an older save), so it is put back there.
  await repo.updateMap(mapPath, d => { d.bookPipeline.phase = 'gate2'; d.bookPipeline.status = 'running'; delete d.bookPipeline.pauseReason; });
  const noteOf = new Map();
  const reload = async () => { for (const n of nodes) noteOf.set(n.id, await repo.readNote(n.path)); };
  return { repo, runs, nodes, mapPath, stat, script, reload, noteOf, stateOf: async () => (await repo.readMap(mapPath)).bookPipeline };
}
const rowOf = (panel, id) => all(panel, 'vam-book-panel-row').find(r => r.dataset.row === id && r.dataset.kind !== 'seam');
const unmetProof = async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'unmet', note: 'missing', sources: [] })), aggregate: 'needs-review' });


test('finish: the runner moves gate2 to done, a second call is idempotent, and a non-gate2 run refuses', async () => {
  const r = await rig();
  await r.runs.finishRun(r.mapPath);
  assert.equal((await r.stateOf()).phase, 'done');
  await r.runs.finishRun(r.mapPath);
  assert.equal((await r.stateOf()).phase, 'done');
  assert.equal(r.runs.getProgress(r.mapPath).phase, 'done', 'the runner reports done right after the acceptance');
  assert.equal(bundle.bookTitleText(bundle.bookBarState(await r.stateOf(), r.runs.getProgress(r.mapPath), () => undefined)).includes('驗收'), false, 'the bar title no longer says it waits for acceptance');
  const early = await rig();
  await early.runs.rerunCard(early.mapPath, early.nodes[1].id);
  const g1 = await rig();
  await g1.repo.updateMap(g1.mapPath, doc => { doc.bookPipeline.phase = 'gate1'; });
  await assert.rejects(() => g1.runs.finishRun(g1.mapPath), e => e instanceof bundle.BookPipelineRunError);
});


test('finish after a rerun that stays needs-review: the run still reaches done', async () => {
  const r = await rig();
  r.script.proof = unmetProof;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  await r.runs.rerunCard(r.mapPath, r.nodes[2].id);
  assert.equal(r.runs.isRunning(r.mapPath), false, 'no drive left behind');
  assert.equal((await r.stateOf()).phase, 'gate2');
  await r.runs.finishRun(r.mapPath);
  assert.equal((await r.stateOf()).phase, 'done');
});


test('card label: a card with a seam shows the "seam to check" label with its reason as title', async () => {
  setUiLanguage('zh-TW');
  const header = dom.element('div');
  bundle.renderBookCardLabels(header, bundle.bookCardView({ pipelineStage: 'checked', pipelineSeam: 'x（第 2 張，版本 1）' }));
  const seam = one(header, 'is-seam');
  assert.equal(seam.text, '接縫需看');
  assert.ok(seam.attrs.title);
  const plain = dom.element('div');
  bundle.renderBookCardLabels(plain, bundle.bookCardView({ pipelineStage: 'checked' }));
  assert.equal(all(plain, 'is-seam').length, 0);
});

test('bar ETA: shown only while planning or writing and only with an estimate (the runner gives none below five finished cards)', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const progress = over => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: 6, counts: { pending: 0, planned: 0, written: 6, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], ...over });
  const draw = p => { const bar = dom.element('div'); bundle.renderBookBar(bar, bundle.bookBarState(data, p, () => undefined), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {} }); return bar; };
  assert.equal(all(draw(progress({})), 'vam-book-bar-eta').length, 0, 'under five finished cards: no ETA');
  assert.equal(bundle.bookProgressText(bundle.bookBarState(data, progress({}), () => undefined)), '正在寫第 1／6 章', 'the writing line is the one chapter sentence, with no done count');
  const shown = all(draw(progress({ etaSeconds: 600 })), 'vam-book-bar-eta');
  assert.equal(shown.length, 1);
  assert.ok(shown[0].text.includes('10'));
  assert.equal(all(draw(progress({ phase: 'gate2', active: false, etaSeconds: 600 })), 'vam-book-bar-eta').length, 0);
});

test('bar: the automatic fix round keeps the whole-book count; a first-time chapter in work is still named', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { a: 1 } };
  const progress = current => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: 4, counts: { pending: 0, planned: 1, written: 0, checked: 2, 'needs-review': 1 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
  const text = current => bundle.bookProgressText(bundle.bookBarState(data, progress(current), () => undefined));
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }]), '正在修正第 1 章・已完成 3／4 章', 'only the fix of chapter 1: named fix line with the whole-book count');
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }, { nodeId: 'd', step: 'write', startedAt: 2 }]), '正在寫第 4／4 章', 'a first-time chapter in work is the one named');
  assert.equal(text([{ nodeId: 'b', step: 'write', startedAt: 1 }]), '正在寫第 2／4 章', 'no fix round: unchanged');
});

test('bar: in the trial the fix round shows the trial done count, not chapter 1/3; an initial trial write is still named', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'planning', status: 'running', order: ['a', 'b', 'c', 'd', 'e'], trial: ['a', 'b', 'c'], globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { a: 1 } };
  const progress = current => ({ runId: 'r', phase: 'planning', status: 'running', active: true, total: 5, counts: { pending: 2, planned: 0, written: 0, checked: 3, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
  const text = current => bundle.bookProgressText(bundle.bookBarState(data, progress(current), () => undefined));
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }]), '正在修正第 1 章・已完成 3／3 章', 'fix only: named fix line with the trial done count');
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }, { nodeId: 'c', step: 'write', startedAt: 2 }]), '正在試跑第 3／3 章', 'initial write alongside a fix is named');
  assert.equal(text([{ nodeId: 'b', step: 'write', startedAt: 1 }]), '正在試跑第 2／3 章', 'a trial chapter in its first write is named');
});

test('bar (live v6): in the trial fix round the fix line names the chapter still being fixed as the fixes finish out of order, also for a trial that is not the first chapters', () => {
  setUiLanguage('zh-TW');
  const stages = {};
  const counts = () => {
    const done = Object.values(stages).filter(stage => stage === 'checked' || stage === 'needs-review').length;
    return { pending: 6 - 3, planned: 0, written: 3 - done, checked: done, 'needs-review': 0 };
  };
  const run = (order, trial) => {
    const data = { v: 1, runId: 'r', phase: 'planning', status: 'running', order, trial, globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: Object.fromEntries(trial.map(id => [id, 1])) };
    const progress = current => ({ runId: 'r', phase: 'planning', status: 'running', active: true, total: order.length, counts: counts(), budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
    return busy => bundle.bookProgressText(bundle.bookBarState(data, progress(busy.map((nodeId, i) => ({ nodeId, step: 'proof', startedAt: i + 1 }))), id => stages[id]));
  };
  // v6: the three trial fixes run together; chapter 3 finishes first, then chapter 1, then chapter 2.
  for (const key of Object.keys(stages)) delete stages[key];
  let text = run(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c']);
  assert.equal(text(['a', 'b', 'c']), '正在修正第 1 章・已完成 0／3 章');
  stages.c = 'checked';
  assert.equal(text(['a', 'b', 'c']), '正在修正第 1 章・已完成 1／3 章', 'chapter 1 is still being fixed');
  stages.a = 'checked';
  assert.equal(text(['a', 'b']), '正在修正第 2 章・已完成 2／3 章', 'chapter 1 is done: chapter 2 is named');
  assert.equal(text(['b']), '正在修正第 2 章・已完成 2／3 章');
  // A trial picked from the middle of the book (reading order d, b, f): the chapter numbers are the book's.
  for (const key of Object.keys(stages)) delete stages[key];
  text = run(['a', 'b', 'c', 'd', 'e', 'f'], ['d', 'b', 'f']);
  assert.equal(text(['d', 'b', 'f']), '正在修正第 2 章・已完成 0／3 章');
  stages.b = 'needs-review';
  assert.equal(text(['d', 'f']), '正在修正第 4 章・已完成 1／3 章');
  stages.d = 'checked';
  assert.equal(text(['f']), '正在修正第 6 章・已完成 2／3 章');
  assert.equal(text([]), '正在修正第 6 章・已完成 2／3 章', 'between two steps of chapter 6\'s fix');
});

test('bar: the fix line follows the chapter still being fixed and keeps the fix label between its steps', () => {
  setUiLanguage('zh-TW');
  const trial = { v: 1, runId: 'r', phase: 'planning', status: 'running', order: ['a', 'b', 'c', 'd'], trial: ['a', 'b', 'c'], globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { a: 1, b: 1, c: 1 } };
  const tp = current => ({ runId: 'r', phase: 'planning', status: 'running', active: true, total: 4, counts: { pending: 1, planned: 0, written: 2, checked: 1, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
  const done = { a: 'checked' };
  const ttext = current => bundle.bookProgressText(bundle.bookBarState(trial, tp(current), id => done[id]));
  // chapter 1 is proofread (counted done) but its step has not left the runner yet: chapter 2, still in its fix, is named
  assert.equal(ttext([{ nodeId: 'a', step: 'proof', startedAt: 1 }, { nodeId: 'b', step: 'write', startedAt: 2 }, { nodeId: 'c', step: 'write', startedAt: 3 }]), '正在修正第 2 章・已完成 1／3 章');
  const whole = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd', 'e', 'f'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { f: 1 } };
  const wp = current => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: 6, counts: { pending: 0, planned: 0, written: 1, checked: 5, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
  const stages = { a: 'checked', b: 'checked', c: 'checked', d: 'checked', e: 'checked', f: 'written' };
  const wtext = current => bundle.bookProgressText(bundle.bookBarState(whole, wp(current), id => stages[id]));
  assert.equal(wtext([{ nodeId: 'f', step: 'write', startedAt: 1 }]), '正在修正第 6 章・已完成 5／6 章');
  // between two steps of chapter 6's fix (nothing in work), never "writing chapter 6/6"
  assert.equal(wtext(undefined), '正在修正第 6 章・已完成 5／6 章');
  assert.equal(wtext([]), '正在修正第 6 章・已完成 5／6 章');
  // once chapter 6 is done, no fix line is left
  stages.f = 'needs-review';
  assert.equal(wtext(undefined), '正在寫第 6／6 章');
});

test('bar: a map change shows the changed mode with the counts, three real buttons and no card id', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'stopped', pauseReason: 'map', changed: { added: ['node-secret-1'], missing: ['node-secret-2'] }, order: ['node-secret-2', 'b'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const state = bundle.bookBarState(data, undefined, () => undefined);
  assert.equal(state.mode, 'changed');
  const calls = [];
  const bar = dom.element('div');
  bundle.renderBookBar(bar, state, { stop: () => calls.push('stop'), resume() {}, addBudget() {}, confirmGate1() {}, mapChanged: { replan: () => calls.push('replan'), keep: () => calls.push('keep') } });
  assert.equal(one(bar, 'vam-book-map-changed').text, '心智圖變了：多 1 章、少 1 章');
  const buttons = dom.findAll(bar, i => i.tag === 'button');
  assert.equal(buttons.length, 3);
  assert.ok(one(bar, 'vam-book-map-replan') && one(bar, 'vam-book-map-keep') && one(bar, 'vam-book-stop'));
  assert.equal(JSON.stringify(dom.findAll(bar, () => true).map(i => [i.text, i.attrs ?? {}])).includes('node-secret'), false, 'no id in text or attributes');
  assert.equal(bundle.bookTitleText(state).includes('node-secret'), false);
  assert.equal(bundle.bookProgressText(state).includes('node-secret'), false);
  // The live progress count wins over the saved one.
  const live = bundle.bookBarState(data, { runId: 'r', phase: 'writing', status: 'stopped', active: false, pauseReason: 'map', mapChange: { added: 2, missing: 0 }, total: 2, counts: { pending: 2, planned: 0, written: 0, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [] }, () => undefined);
  assert.deepEqual(live.mapChange, { added: 2, missing: 0 });
});

test('bar: a run paused for a map change counts the map as it is now (a card removed or added after the pause counts at once)', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'stopped', pauseReason: 'map', changed: { added: ['new'], missing: [] }, accepted: ['a', 'b', 'c'], order: ['a', 'b', 'c'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const progress = { runId: 'r', phase: 'writing', status: 'stopped', active: false, pauseReason: 'map', mapChange: { added: 1, missing: 0 }, total: 3, counts: { pending: 3, planned: 0, written: 0, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [] };
  const text = mapIds => {
    const bar = dom.element('div');
    bundle.renderBookBar(bar, bundle.bookBarState(data, progress, () => undefined, mapIds), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, mapChanged: { replan() {}, keep() {} } });
    return one(bar, 'vam-book-map-changed').text;
  };
  assert.equal(text(['a', 'b', 'c', 'new']), '心智圖變了：多 1 章、少 0 章', 'as it paused');
  assert.equal(text(['a', 'b', 'c']), '心智圖變了：多 0 章、少 0 章', 'the added card removed again: the stale "1 more" is gone');
  assert.equal(text(['a', 'c', 'new']), '心智圖變了：多 1 章、少 1 章', 'a chapter card deleted while paused');
  assert.equal(text(['a', 'c']), '心智圖變了：多 0 章、少 1 章');
  assert.equal(text(undefined), '心智圖變了：多 1 章、少 0 章', 'no map at hand: the runner\'s numbers');
});

test('bar: waiting at gate 1 or gate 2, or a finished book, shows the map-change line with live counts, and nothing when the map matches', () => {
  setUiLanguage('zh-TW');
  for (const phase of ['gate1', 'gate2', 'done']) {
    const data = { v: 1, runId: 'r', phase, status: 'running', order: ['a', 'b', 'c'], accepted: ['a', 'b', 'c'], trial: ['a'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
    const line = mapIds => {
      const state = bundle.bookBarState(data, undefined, () => undefined, mapIds);
      assert.equal(state.mode, phase);
      const bar = dom.element('div');
      bundle.renderBookBar(bar, state, { stop() {}, resume() {}, addBudget() {}, confirmGate1() {} });
      return one(bar, 'vam-book-map-changed')?.text;
    };
    assert.equal(line(['a', 'b', 'c']), undefined, phase + ': same map, no line');
    assert.equal(line(undefined), undefined, phase + ': no map at hand');
    assert.equal(line(['a', 'b']), '心智圖變了：多 0 章、少 1 章', phase + ': a card removed');
    assert.equal(line(['a', 'b', 'c', 'n']), '心智圖變了：多 1 章、少 0 章', phase + ': a card added');
    assert.equal(line(['a', 'c', 'n', 'm']), '心智圖變了：多 2 章、少 1 章', phase + ': both');
  }
  // A finished book: the line only, never the replan/keep buttons (nothing is planned again on its own).
  const done = bundle.bookBarState({ v: 1, runId: 'r', phase: 'done', status: 'running', order: ['a', 'b'], accepted: ['a', 'b'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' }, undefined, () => undefined, ['a', 'b', 'n']);
  const bar = dom.element('div');
  bundle.renderBookBar(bar, done, { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, mapChanged: { replan() {}, keep() {} } });
  assert.equal(one(bar, 'vam-book-map-changed')?.text, '心智圖變了：多 1 章、少 0 章');
  assert.equal(one(bar, 'vam-book-map-replan'), undefined, 'done: no replan button');
});

test('bar: a finished book reminds of every map change on one line, also while the runner is busy (a card rerun); a reorder reads without counts', () => {
  setUiLanguage('zh-TW');
  const base = { v: 1, runId: 'r', phase: 'done', order: ['a', 'b', 'c'], accepted: ['a', 'b', 'c'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const live = { runId: 'r', phase: 'done', status: 'stopped', active: true, total: 3, counts: { pending: 0, planned: 0, written: 0, checked: 3, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [] };
  for (const [status, progress] of [['running', undefined], ['running', live]]) {
    const line = mapIds => {
      const bar = dom.element('div');
      bundle.renderBookBar(bar, bundle.bookBarState({ ...base, status }, progress, () => undefined, mapIds), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {} });
      return one(bar, 'vam-book-map-changed')?.text;
    };
    const tag = status + (progress ? ' + active runner' : '');
    assert.equal(line(['a', 'b', 'c']), undefined, tag + ': same map, no line');
    assert.equal(line(['a', 'c']), '心智圖變了：多 0 章、少 1 章', tag + ': removed to unassigned');
    assert.equal(line(['a', 'm']), '心智圖變了：多 1 章、少 2 章', tag + ': two cards merged into a new one');
    assert.equal(line(['a', 'c', 'b']), '心智圖變了：章節順序不同', tag + ': a topic moved, nothing added or removed');
    assert.equal(line(['root', 'a', 'b', 'c']), '心智圖變了：多 1 章、少 0 章', tag + ': a card added');
  }
  // Not at a gate: a reorder alone is not reported there (the gates keep their counts line).
  const gate2 = bundle.bookBarState({ ...base, phase: 'gate2', status: 'running' }, undefined, () => undefined, ['a', 'c', 'b']);
  assert.equal(gate2.mapChange, undefined);
  setUiLanguage('en');
  const bar = dom.element('div');
  bundle.renderBookBar(bar, bundle.bookBarState({ ...base, status: 'running' }, undefined, () => undefined, ['c', 'b', 'a']), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {} });
  assert.equal(one(bar, 'vam-book-map-changed').text, 'The map changed: the chapters are in a different order');
  setUiLanguage('zh-TW');
});

test('finish at gate 2: a card added or removed pauses as map changed (no silent finish); keep removes it and the next finish completes', async () => {
  for (const kind of ['removed', 'added']) {
    const r = await rig();
    assert.equal((await r.stateOf()).phase, 'gate2');
    const gone = r.nodes[2].id;
    await r.repo.updateMap(r.mapPath, d => { if (kind === 'removed') d.nodes = d.nodes.filter(n => n.id !== gone); else d.nodes.push({ ...d.nodes[2], id: 'extra-card' }); });
    await r.runs.finishRun(r.mapPath);
    let st = await r.stateOf();
    assert.equal(st.phase, 'gate2', kind + ': not finished');
    assert.equal(st.status, 'stopped');
    assert.equal(st.pauseReason, 'map');
    const ids = (await r.repo.readMap(r.mapPath)).nodes.map(n => n.id);
    const bar = bundle.bookBarState(st, r.runs.getProgress(r.mapPath), () => undefined, ids);
    assert.equal(bar.mode, 'changed');
    assert.equal(JSON.stringify(bar.mapChange), JSON.stringify(kind === 'removed' ? { added: 0, missing: 1 } : { added: 1, missing: 0 }));
    await r.runs.keepBookMap(r.mapPath);
    st = await r.stateOf();
    assert.equal(st.status, 'running');
    assert.equal(st.phase, 'done', 'keeping the map lets the run finish by itself');
    if (kind === 'removed') assert.ok(st.removed.includes(gone));
    await r.runs.finishRun(r.mapPath);
    assert.equal((await r.stateOf()).phase, 'done', kind + ': finishes after keep');
  }
});

// ---- part B: the view ----
const MAP = 'Agent Workspace/Topics/map-bk2/Map.md';
async function viewRig({ book = true, phase = 'gate2' } = {}) {
  setUiLanguage('zh-TW');
  const { repo, app } = S.fixture('zh-TW', { linkIndex: true });
  const settings = { ...S.DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-bk2', title: 'BK', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-bk2');
  const ids = [];
  for (const key of ['root', 'a']) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace', { summary: `summary of ${key}` });
    Object.assign(created, { parentId: ids.length ? ids[0] : null, x: 0, y: mapDoc.nodes.length * 100 });
    mapDoc.nodes.push(created); ids.push(created.id);
  }
  if (book) mapDoc.bookPipeline = { v: 1, runId: 'r1', phase, status: 'running', order: ids, globalPlanned: true, attempts: { global: 1 }, revisions: {}, budget: { used: 1, limit: 300 }, revision: 1, startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z' };
  await app.vault.create(MAP, S.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const calls = [];
  const plugin = S.withExpansionCoordinator({ repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, mutate: work => Promise.resolve().then(work), getBookPipelineProgress: () => undefined, argumentRuns: { isRunning: () => false }, rerunBookCard: async (p, id) => { calls.push(['rerun', p, id]); } });
  S.attachTopicRuns(plugin);
  const view = new bundle.VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = dom.element('div'); view.contentEl = dom.element('div');
  view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
  view.render = () => {};
  const log = [];
  view.chat = { isHero: false, isOpen: true, setOpen: (open, focus) => { log.push(['chat', open, !!focus]); } };
  const progress = over => { plugin.getBookPipelineProgress = () => over; };
  const menu = node => { const items = []; const m = { addItem(build) { const it = {}; const chain = { setTitle(v) { it.title = v; return chain; }, setIcon(v) { it.icon = v; return chain; }, setDisabled(v) { it.disabled = !!v; return chain; }, onClick(fn) { it.click = fn; return chain; } }; build(chain); items.push(it); return m; }, addSeparator() { items.push({ separator: true }); return m; } }; view.addCardMenuActions(m, node); return items; };
  const prog = (phase2, extra = {}) => ({ runId: 'r1', phase: phase2, status: 'running', active: false, total: 2, counts: { pending: 0, planned: 0, written: 0, checked: 2, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], ...extra });
  return { view, plugin, log, calls, progress, menu, prog };
}


test('right-click: the rerun item and its disabled sub line show at gate 2 and done (not at gate 1, where a trial retry replaces it); busy or active disables; clicking calls rerunBookCard and rereads the card', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  h.progress(h.prog('gate1'));
  assert.ok(h.menu(node).every(i => i.title !== '重跑圖文書這一張'), 'no rerun item at gate 1');
  for (const phase of ['gate2', 'done']) {
    h.progress(h.prog(phase));
    const items = h.menu(node);
    const at = items.findIndex(i => i.title === '重跑圖文書這一張');
    assert.ok(at >= 0, phase);
    assert.equal(items[at].disabled, false);
    // The second line is a note (never the permanent grey "disabled" line it was): it describes the rerun while it can be used.
    assert.equal(items[at + 1].title, '企劃 → 寫 → 校，約 2 分鐘；前後章正文不動，只更新前後章節的連接行並標「接縫需看」');
    assert.notEqual(items[at + 1].disabled, true);
  }
  // When it cannot be used the second line says why.
  const why = progressOver => { h.progress(h.prog('gate2', progressOver)); const items = h.menu(node); const at = items.findIndex(i => i.title === '重跑圖文書這一張'); return { disabled: items[at].disabled, line: items[at + 1].title }; };
  assert.deepEqual(why({ active: true }), { disabled: true, line: '圖文書正在執行，等它結束後再重跑' });
  assert.deepEqual(why({ busyCards: [node.id] }), { disabled: true, line: '這一張正在重跑' });
  assert.deepEqual(why({ rerun: { nodeId: node.id, startedAt: 1 } }), { disabled: true, line: '這一張正在重跑' });
  assert.deepEqual(why({ rerun: { nodeId: 'other', startedAt: 1 } }), { disabled: true, line: '另一張正在重跑' });
  h.view.chatChainRunner = { current: {} };
  assert.deepEqual(why({}), { disabled: true, line: '對話進行中，等它結束後再重跑' });
  h.view.chatChainRunner = null;
  h.progress(h.prog('writing'));
  assert.equal(h.menu(node).some(i => i.title === '重跑圖文書這一張'), false, 'not while planning or writing');
  h.progress(h.prog('gate2'));
  let reread = 0;
  h.view.rereadBookCard = async () => { reread++; };
  h.menu(node).find(i => i.title === '重跑圖文書這一張').click();
  await settle();
  assert.deepEqual(h.calls, [['rerun', MAP, node.id]]);
  assert.equal(reread, 1);
});

test('right-click rerun through the view: "same result" lands on the review memory of the view, a changed result clears the old mark', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  h.progress(h.prog('gate2'));
  h.view.rereadBookCard = async () => {};
    let next = { unchanged: true };
  h.plugin.rerunBookCard = async () => next;
  const click = async () => { h.menu(node).find(i => i.title === '重跑圖文書這一張').click(); await settle(); };
  await click();
  assert.ok(h.view.bookReview.unchanged.has(node.id), 'the same result is remembered');
  next = { unchanged: false };
  await click();
  assert.ok(!h.view.bookReview.unchanged.has(node.id), 'a changed result clears it');
  const view_ts = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view_ts, /runTrackedRerun\(this\.bookReview, nodeId,/);
  assert.match(view_ts, /dom\?\.setAttr\("aria-disabled", "true"\)/);
});

test('right-click: a map without bookPipeline gets the same items as before (no rerun item, no extra separator)', async () => {
  const h = await viewRig({ book: false });
  const node = h.view.map.nodes[1];
  const items = h.menu(node);
  assert.equal(items.some(i => /圖文書/.test(i.title ?? '')), false);
  const rebuilt = h.menu(node).map(i => i.title ?? '|');
  assert.equal(rebuilt.filter(x => x === '|').length, 3, 'the three separators it always had');
});

test('runTrackedRerun: the same result is remembered, a changed result or a new run clears it, a throw leaves it clear', async () => {
  const memory = new bundle.BookReviewMemory();
  await bundle.runTrackedRerun(memory, 'fail', async () => ({ unchanged: true }));
  assert.ok(memory.unchanged.has('fail'));
  await bundle.runTrackedRerun(memory, 'fail', async () => ({ unchanged: false }));
  assert.ok(!memory.unchanged.has('fail'), 'a changed result clears the old mark');
  await bundle.runTrackedRerun(memory, 'fail', async () => ({ unchanged: true }));
  let seen;
  await bundle.runTrackedRerun(memory, 'fail', async () => { seen = memory.unchanged.has('fail'); return undefined; });
  assert.equal(seen, false, 'cleared before the run starts');
  assert.ok(!memory.unchanged.has('fail'), 'a run with no result leaves it clear');
  await bundle.runTrackedRerun(memory, 'fail', async () => ({ unchanged: true }));
  await assert.rejects(() => bundle.runTrackedRerun(memory, 'fail', async () => { throw new Error('x'); }));
  assert.ok(!memory.unchanged.has('fail'));
});

// ---- T14: the chapter-role item of the card right-click menu ----
const roleMenu = (h, node, mode = 'sub') => {
  const items = [];
  const entry = () => { const it = {}; const chain = { setTitle(v) { it.title = v; return chain; }, setIcon(v) { it.icon = v; return chain; }, setDisabled(v) { it.disabled = !!v; return chain; }, setChecked(v) { it.checked = v; return chain; }, onClick(fn) { it.click = fn; return chain; } }; return { it, chain }; };
  const sub = { items: [], addItem(build) { const e = entry(); build(e.chain); this.items.push(e.it); return this; } };
  const m = { addItem(build) { const e = entry(); if (mode === 'sub') e.chain.setSubmenu = () => sub; build(e.chain); items.push(e.it); return m; }, addSeparator() { return m; } };
  h.view.addCardMenuActions(m, node);
  const at = items.findIndex(i => i.title === '圖文書：章節角色');
  return { items, at, choices: mode === 'sub' ? sub.items : items.slice(at + 1, at + 6) };
};
const noteOf = (h, node) => h.view.plugin.repo.readNote(node.path);

test('T14 menu: a chapter card of a usable book has the role item with five choices, a submenu where there is one and flat items otherwise (keyboard reachable through the same menu); the current value is marked; i18n in three languages', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  await h.view.plugin.repo.writePipelineFields(node.path, { bookRole: 'body', pipelineRole: 'body' });
  await h.view.rereadBookCard(node.id);
  for (const mode of ['sub', 'flat']) {
    const m = roleMenu(h, node, mode);
    assert.ok(m.at >= 0, mode);
    assert.deepEqual(m.choices.map(c => c.title), ['本文', '導讀', '素材導覽', '收尾', '交給 AI 決定'], mode);
    assert.deepEqual(m.choices.map(c => !!c.checked), [false, false, false, false, true], 'a pipeline role: the AI option is marked');
  }
  for (const [lang, expect] of [['en', ['Picture book: chapter role', 'Let AI decide']], ['zh-CN', ['图文书：章节角色', '交给 AI 决定']], ['zh-TW', ['圖文書：章節角色', '交給 AI 決定']]]) {
    setUiLanguage(lang);
    const items = []; h.view.addCardMenuActions({ addItem(b) { const it = {}; const c = { setTitle(v) { it.title = v; return c; }, setIcon() { return c; }, setDisabled() { return c; }, onClick() { return c; } }; b(c); items.push(it); return this; }, addSeparator() { return this; } }, node);
    assert.ok(items.some(i => i.title === expect[0]), lang);
    assert.ok(items.some(i => i.title === expect[1]), lang);
  }
  setUiLanguage('zh-TW');
});

test('T14 menu: absent on a non-chapter card (not in the book order) and on a map without a usable book', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  h.view.map.bookPipeline.order = [h.view.map.nodes[0].id];
  h.view.bookPipelineSeen = null;
  assert.equal(roleMenu(h, node).at, -1);
  const plain = await viewRig({ book: false });
  assert.equal(roleMenu(plain, plain.view.map.nodes[1]).at, -1);
});

test('T14 menu: a choice with no run writes book-role and book-role-by owner at once, the mark follows, and it survives a reopen; the same value is written too', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  h.progress(undefined);
  notices.length = 0;
  let m = roleMenu(h, node);
  m.choices[1].click();
  await settle();
  let note = await noteOf(h, node);
  assert.equal(note.bookRole, 'intro');
  assert.equal(note.bookRoleBy, 'owner');
  assert.ok(notices.some(n => n.includes('導讀') && !n.includes('正在執行')), 'no run: no deferral sentence');
  assert.deepEqual(roleMenu(h, node).choices.map(c => !!c.checked), [false, true, false, false, false]);
  // a reopen: a fresh view reads the same file
  h.view.notes.delete(node.id); await h.view.rereadBookCard(node.id);
  assert.deepEqual(roleMenu(h, node).choices.map(c => !!c.checked), [false, true, false, false, false]);
  // the same value again still records the owner (a pipeline-written role chosen as is)
  await h.view.plugin.repo.writePipelineFields(node.path, { bookRole: 'body', pipelineRole: 'body', bookRoleBy: null });
  await h.view.rereadBookCard(node.id);
  roleMenu(h, node).choices[0].click();
  await settle();
  note = await noteOf(h, node);
  assert.equal(note.bookRole, 'body');
  assert.equal(note.bookRoleBy, 'owner', 'same value is still the owner\'s');
});

test('T14 menu: handing the card to AI writes book-role-by ai and pipeline-role = book-role; a running book is told the change waits for the next load', async () => {
  const h = await viewRig({ phase: 'writing' });
  const node = h.view.map.nodes[1];
  await h.view.plugin.repo.writeBookRoleChoice(node.path, 'gallery');
  await h.view.rereadBookCard(node.id);
  h.progress({ runId: 'r1', phase: 'writing', status: 'running', active: true, total: 2, counts: { pending: 0, planned: 0, written: 0, checked: 2, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x' });
  h.view.bookPipelineSeen = null;
  notices.length = 0;
  roleMenu(h, node).choices[4].click();
  await settle();
  const note = await noteOf(h, node);
  assert.equal(note.bookRoleBy, 'ai');
  assert.equal(note.bookRole, 'gallery');
  assert.equal(note.pipelineRole, 'gallery');
  assert.ok(notices.some(n => n.includes('交給 AI') && n.includes('下次載入才生效')), 'says it takes effect from the next load');
});

test('bar: while the whole-book consistency check runs the line says so, never writing', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', consistency: { key: 'k', attempts: 1, done: false } };
  const progress = { runId: 'r', phase: 'writing', status: 'running', active: true, total: 4, counts: { pending: 0, planned: 0, written: 0, checked: 3, 'needs-review': 1 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current: [] };
  assert.equal(bundle.bookProgressText(bundle.bookBarState(data, progress, () => undefined)), '正在檢查全書一致性・已完成 4／4 章');
  const idle = { ...data, consistency: { key: 'k', attempts: 1, done: true } };
  assert.match(bundle.bookProgressText(bundle.bookBarState(idle, progress, () => undefined)), /^正在寫第/, 'a finished check is not shown');
});
