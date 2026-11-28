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
export { bookStructure } from "./core/book-pipeline/structure";
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
  assert.equal(bundle.bookProgressText(bundle.bookBarState(data, progress({}), () => undefined)), '寫作中 · 已完成 0/6 章，正在寫第 1 章', 'the writing line is the done count plus the chapter in work');
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
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }, { nodeId: 'd', step: 'write', startedAt: 2 }]), '寫作中 · 已完成 3/4 章，正在寫第 4 章', 'a first-time chapter in work is the one named');
  assert.equal(text([{ nodeId: 'b', step: 'write', startedAt: 1 }]), '寫作中 · 已完成 3/4 章，正在寫第 2 章', 'no fix round: the done count and the chapter in work');
});

test('bar: a run saved in the old trial planning step reads as writing: the fix round keeps the whole-book done count; an initial write is still named', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd', 'e'], trial: ['a', 'b', 'c'], globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { a: 1 } };
  const progress = current => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: 5, counts: { pending: 2, planned: 0, written: 0, checked: 3, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
  const text = current => bundle.bookProgressText(bundle.bookBarState(data, progress(current), () => undefined));
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }]), '正在修正第 1 章・已完成 3／5 章', 'fix only: named fix line with the whole-book done count');
  assert.equal(text([{ nodeId: 'a', step: 'write', startedAt: 1 }, { nodeId: 'c', step: 'write', startedAt: 2 }]), '寫作中 · 已完成 3/5 章，正在寫第 3 章', 'initial write alongside a fix is named');
  assert.equal(text([{ nodeId: 'b', step: 'write', startedAt: 1 }]), '寫作中 · 已完成 3/5 章，正在寫第 2 章', 'a chapter in its first write is named');
});

test('bar (live v6): in the fix round the fix line names the chapter still being fixed as the fixes finish out of order, also for fixes that are not the first chapters', () => {
  setUiLanguage('zh-TW');
  const stages = {};
  const counts = () => {
    const done = Object.values(stages).filter(stage => stage === 'checked' || stage === 'needs-review').length;
    return { pending: 6 - 3, planned: 0, written: 3 - done, checked: done, 'needs-review': 0 };
  };
  const run = (order, trial) => {
    const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order, globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: Object.fromEntries(trial.map(id => [id, 1])) };
    const progress = current => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: order.length, counts: counts(), budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
    return busy => bundle.bookProgressText(bundle.bookBarState(data, progress(busy.map((nodeId, i) => ({ nodeId, step: 'proof', startedAt: i + 1 }))), id => stages[id]));
  };
  // v6: the three trial fixes run together; chapter 3 finishes first, then chapter 1, then chapter 2.
  for (const key of Object.keys(stages)) delete stages[key];
  let text = run(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c']);
  assert.equal(text(['a', 'b', 'c']), '正在修正第 1 章・已完成 0／6 章');
  stages.c = 'checked';
  assert.equal(text(['a', 'b', 'c']), '正在修正第 1 章・已完成 1／6 章', 'chapter 1 is still being fixed');
  stages.a = 'checked';
  assert.equal(text(['a', 'b']), '正在修正第 2 章・已完成 2／6 章', 'chapter 1 is done: chapter 2 is named');
  assert.equal(text(['b']), '正在修正第 2 章・已完成 2／6 章');
  // A trial picked from the middle of the book (reading order d, b, f): the chapter numbers are the book's.
  for (const key of Object.keys(stages)) delete stages[key];
  text = run(['a', 'b', 'c', 'd', 'e', 'f'], ['d', 'b', 'f']);
  assert.equal(text(['d', 'b', 'f']), '正在修正第 2 章・已完成 0／6 章');
  stages.b = 'needs-review';
  assert.equal(text(['d', 'f']), '正在修正第 4 章・已完成 1／6 章');
  stages.d = 'checked';
  assert.equal(text(['f']), '正在修正第 6 章・已完成 2／6 章');
  assert.equal(text([]), '正在修正第 6 章・已完成 2／6 章', 'between two steps of chapter 6\'s fix');
});

test('bar: the fix line follows the chapter still being fixed and keeps the fix label between its steps', () => {
  setUiLanguage('zh-TW');
  const trial = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd'], globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { a: 1, b: 1, c: 1 } };
  const tp = current => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: 4, counts: { pending: 1, planned: 0, written: 2, checked: 1, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current });
  const done = { a: 'checked' };
  const ttext = current => bundle.bookProgressText(bundle.bookBarState(trial, tp(current), id => done[id]));
  // chapter 1 is proofread (counted done) but its step has not left the runner yet: chapter 2, still in its fix, is named
  assert.equal(ttext([{ nodeId: 'a', step: 'proof', startedAt: 1 }, { nodeId: 'b', step: 'write', startedAt: 2 }, { nodeId: 'c', step: 'write', startedAt: 3 }]), '正在修正第 2 章・已完成 1／4 章');
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
  assert.equal(wtext(undefined), '寫作中 · 已完成 5/6 章，正在寫第 6 章');
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
  for (const phase of ['gate1', 'done']) {
    const data = { v: 1, runId: 'r', phase, status: 'running', order: ['a', 'b', 'c'], accepted: ['a', 'b', 'c'], ...(phase === 'gate1' ? { planReview: true, trial: ['a'] } : {}), budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
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
  const plugin = S.withExpansionCoordinator({ repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, mutate: work => Promise.resolve().then(work), getBookPipelineProgress: () => undefined, argumentRuns: { isRunning: () => false }, rerunBookCard: async (p, id) => { calls.push(['rerun', p, id]); } });
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
  assert.ok(h.menu(node).every(i => i.title !== '重寫這一章'), 'no rerun item at gate 1');
  for (const phase of ['gate2', 'done']) {
    h.progress(h.prog(phase));
    const items = h.menu(node);
    const at = items.findIndex(i => i.title === '重寫這一章');
    assert.ok(at >= 0, phase);
    assert.equal(items[at].disabled, false);
    // The second line is a note (never the permanent grey "disabled" line it was): it describes the rerun while it can be used.
    assert.equal(items[at + 1].title, '約 2 分鐘，前後章只改銜接句');
    assert.notEqual(items[at + 1].disabled, true);
  }
  // When it cannot be used the second line says why.
  const why = progressOver => { h.progress(h.prog('gate2', progressOver)); const items = h.menu(node); const at = items.findIndex(i => i.title === '重寫這一章'); return { disabled: items[at].disabled, line: items[at + 1].title }; };
  assert.deepEqual(why({ active: true }), { disabled: true, line: '圖文書正在執行，等它結束後再重跑' });
  assert.deepEqual(why({ busyCards: [node.id] }), { disabled: true, line: '這一張正在重跑' });
  assert.deepEqual(why({ rerun: { nodeId: node.id, startedAt: 1 } }), { disabled: true, line: '這一張正在重跑' });
  assert.deepEqual(why({ rerun: { nodeId: 'other', startedAt: 1 } }), { disabled: true, line: '另一張正在重跑' });
  h.view.chatChainRunner = { current: {} };
  assert.deepEqual(why({}), { disabled: true, line: '對話進行中，等它結束後再重跑' });
  h.view.chatChainRunner = null;
  h.progress(h.prog('writing'));
  assert.equal(h.menu(node).some(i => i.title === '重寫這一章'), false, 'not while planning or writing');
  h.progress(h.prog('gate2'));
  let reread = 0;
  h.view.rereadBookCard = async () => { reread++; };
  h.menu(node).find(i => i.title === '重寫這一章').click();
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
  const click = async () => { h.menu(node).find(i => i.title === '重寫這一章').click(); await settle(); };
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
  // A submenu-capable menu: every item can open a child menu (mode 'sub'); in mode 'flat' no item has setSubmenu, so all items land in one list.
  const make = () => {
    const items = [];
    const m = { items, addItem(build) {
      const it = {};
      const chain = { setTitle(v) { it.title = v; return chain; }, setIcon(v) { it.icon = v; return chain; }, setDisabled(v) { it.disabled = !!v; return chain; }, setChecked(v) { it.checked = v; return chain; }, onClick(fn) { it.click = fn; return chain; } };
      if (mode === 'sub') chain.setSubmenu = () => (it.sub = make());
      build(chain); items.push(it); return m;
    }, addSeparator() { return m; } };
    return m;
  };
  const m = make();
  h.view.addCardMenuActions(m, node);
  if (mode === 'flat') {
    const at = m.items.findIndex(i => i.title === '章節角色');
    return { items: m.items, at, choices: m.items.slice(at + 1, at + 6) };
  }
  // The role item lives in the "Picture book" submenu, with its own submenu of choices.
  const book = m.items.find(i => i.title === '圖文書');
  const role = book?.sub?.items.find(i => i.title === '章節角色');
  return { items: m.items, at: role ? m.items.indexOf(book) : -1, choices: role?.sub?.items ?? [] };
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
  for (const [lang, expect] of [['en', ['Chapter role', 'Let AI decide']], ['zh-CN', ['章节角色', '交给 AI 决定']], ['zh-TW', ['章節角色', '交給 AI 決定']]]) {
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

// P8c: the AI proofread numbers on the bar, the plan review and the finished state.
const aiData = over => ({ v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd'], accepted: ['a', 'b', 'c', 'd'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', ...over });
const slot = over => ({ key: 'k', attempts: 0, round: 0, step: 'proof', checked: 0, fixed: 0, open: [], ...over });
const writingProgress = { runId: 'r', phase: 'writing', status: 'running', active: true, total: 4, counts: { pending: 0, planned: 0, written: 1, checked: 2, 'needs-review': 1 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current: [{ nodeId: 'c', step: 'proof', startedAt: 1 }] };

test('P8c bar: the AI numbers count chapters in a fix round and the same open items as the closing page; a done slot is not fixing', () => {
  const data = aiData({
    aiProof: {
      a: slot({ step: 'fix', round: 1, fixed: 1, checked: 5 }),
      b: slot({ step: 'fix', done: true, fixed: 2, open: [{ problem: 'p', reason: 'r' }, { problem: 'q', reason: 'r' }] }),
      c: slot({ done: true, incomplete: true, open: [] })
    },
    bookProof: slot({ done: true, fixed: 4, open: [{ problem: 'z', reason: 'r' }] })
  });
  const state = bundle.bookBarState(data, writingProgress, () => undefined);
  // fixing: only a; open: 2 (b) + 1 (c incomplete) + 1 (book) + 1 (needs-review chapter); fixed: 1 + 2 + 4
  assert.equal(JSON.stringify(state.ai), JSON.stringify({ fixing: 1, open: 5, fixed: 7 }));
  assert.equal(JSON.stringify(bundle.bookBarState(aiData({}), writingProgress, () => undefined).ai), JSON.stringify({ fixing: 0, open: 1, fixed: 0 }), 'no slots: only the chapter needing a look');
});

test('P8c bar: while running the bar says how many chapters the AI is fixing and how many issues are open; nothing asks the owner to review', () => {
  setUiLanguage('zh-TW');
  const data = aiData({ aiProof: { a: slot({ step: 'fix', round: 1 }), b: slot({ done: true, open: [{ problem: 'p', reason: 'r' }] }) } });
  const bar = dom.element('div');
  bundle.renderBookBar(bar, bundle.bookBarState(data, writingProgress, () => undefined), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {} });
  assert.equal(one(bar, 'vam-book-ai-counts').text, 'AI 修正中 1・仍有問題 2');
  assert.equal(one(bar, 'vam-book-now').children.some(child => child.cls?.includes('vam-book-ai-counts')), true);
  const words = texts(bar).join('|');
  assert.ok(!/要你看|需人看|驗收|仍要完成/.test(words), words);
  // gate 2 and a gate 1 without a plan review are the writing state; nothing drives them after a reload, so they read as stopped
  const gate2 = bundle.bookBarState(aiData({ phase: 'gate2' }), { ...writingProgress, phase: 'gate2' }, () => undefined);
  assert.equal(gate2.mode, 'writing');
  assert.equal(bundle.bookBarState(aiData({ phase: 'gate2' }), undefined, () => undefined).mode, 'stopped');
  assert.equal(bundle.bookBarState(aiData({ phase: 'gate1', trial: ['a'] }), { ...writingProgress, phase: 'gate1' }, () => undefined).mode, 'writing');
});

test('P8c bar: the plan review has two buttons (go and stop) and one hint line; no summary or back-to-plan button, no counts sentence, no progress track', () => {
  setUiLanguage('zh-TW');
  const state = bundle.bookBarState(aiData({ phase: 'gate1', planReview: true, trial: ['a', 'b'] }), undefined, () => undefined);
  assert.equal(state.mode, 'gate1');
  assert.equal(state.planReview, true);
  const calls = [];
  const bar = dom.element('div');
  bundle.renderBookBar(bar, state, { stop() {}, resume() {}, addBudget() {}, confirmGate1: () => calls.push('go') });
  assert.equal(bundle.bookTitleText(state), '圖文書：全書企劃好了，看方向對不對');
  const buttons = dom.findAll(bar, i => i.tag === 'button').map(i => i.text);
  assert.deepEqual(buttons, ['方向對，開始寫', '停止']);
  one(bar, 'vam-book-confirm').click();
  assert.deepEqual(calls, ['go']);
  for (const cls of ['vam-book-open-plan', 'vam-book-back-to-plan']) assert.equal(one(bar, cls), undefined, cls + ' is gone');
  assert.equal(all(bar, 'mod-warning').length, 0, 'stop is no longer a warning button');
  const hint = one(bar, 'vam-book-plan-hint');
  assert.equal(hint.children.length, 1);
  assert.equal(hint.children[0].tag, 'b');
  assert.equal(hint.children[0].text, '想改就直接跟左邊的總編輯說。');
  assert.equal(texts(bar).filter(x => x.includes('都企劃好了')).length, 0, 'no counts sentence');
  assert.equal(one(bar, 'vam-book-track'), undefined, 'nothing is finished yet: no track');
  assert.ok(!/試跑|跳過/.test(texts(bar).join('|')), 'no trial buttons');
});

test('P8c bar: a finished book shows the chapters, what the AI fixed and the open issues, with a button to the closing page', () => {
  setUiLanguage('zh-TW');
  const data = aiData({ phase: 'done', aiProof: { a: slot({ done: true, fixed: 3, open: [{ problem: 'p', reason: 'r' }] }), b: slot({ done: true, fixed: 2 }) }, bookProof: slot({ done: true, fixed: 1, open: [{ problem: 'q', reason: 'r' }] }) });
  const state = bundle.bookBarState(data, undefined, () => undefined);
  assert.equal(state.mode, 'done');
  const calls = [];
  const bar = dom.element('div');
  bundle.renderBookBar(bar, state, { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, openIssues: () => calls.push('issues') });
  assert.equal(bundle.bookTitleText(state), '圖文書：已完成');
  assert.equal(one(bar, 'vam-book-done-counts').text, '4 章・AI 修了 6 處・仍有問題 2 項');
  const button = one(bar, 'vam-book-open-issues');
  assert.equal(button.text, '看仍有問題');
  button.click();
  assert.deepEqual(calls, ['issues']);
  assert.ok(!/驗收|仍要完成|下一章要看/.test(texts(bar).join('|')));
  // nothing open still says so in numbers, never an empty line
  const clean = dom.element('div');
  bundle.renderBookBar(clean, bundle.bookBarState(aiData({ phase: 'done' }), undefined, () => undefined), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, openIssues() {} });
  assert.equal(one(clean, 'vam-book-done-counts').text, '4 章・AI 修了 0 處・仍有問題 0 項');
});

test('P8c bar: a finished book whose every chapter was locked and nothing checked has no closing page, so no button to it; one chapter open keeps it', () => {
  setUiLanguage('zh-TW');
  const done = { done: true };
  const proof = { a: slot(done), b: slot(done), c: slot(done), d: slot(done) };
  const draw = data => { const bar = dom.element('div'); bundle.renderBookBar(bar, bundle.bookBarState(data, undefined, () => undefined), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, openIssues() {} }); return bar; };
  const allLocked = draw(aiData({ phase: 'done', aiProof: proof, bookProof: slot({ done: true, incomplete: true, locked: ['a', 'b', 'c', 'd'] }) }));
  assert.equal(one(allLocked, 'vam-book-open-issues'), undefined, 'no button to a page that was not written');
  assert.ok(one(allLocked, 'vam-book-done-counts'), 'the counts line stays');
  const someOpen = draw(aiData({ phase: 'done', aiProof: proof, bookProof: slot({ done: true, incomplete: true, locked: ['a', 'b', 'c'] }) }));
  assert.ok(one(someOpen, 'vam-book-open-issues'), 'one chapter not locked: the page is written, the button stays');
});

test('B33-z bar: the button follows the runner\'s saved decision (closingSkipped), whatever the bar could count itself; older saves keep the B33-x rule', () => {
  setUiLanguage('zh-TW');
  const done = { done: true, checked: 2 };
  const proof = { a: slot(done), b: slot(done), c: slot(done), d: slot(done) };
  const book = slot({ done: true, checked: 3, incomplete: true, locked: ['b'] });
  const draw = data => { const bar = dom.element('div'); bundle.renderBookBar(bar, bundle.bookBarState(data, undefined, () => 'checked'), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, openIssues() {} }); return bar; };
  assert.equal(one(draw(aiData({ phase: 'done', aiProof: proof, bookProof: book, closingSkipped: true })), 'vam-book-open-issues'), undefined, 'saved as skipped: no button');
  assert.ok(one(draw(aiData({ phase: 'done', aiProof: proof, bookProof: book, closingSkipped: false })), 'vam-book-open-issues'), 'saved as written (say, a cover item): the button');
  const allLocked = slot({ done: true, incomplete: true, locked: ['a', 'b', 'c', 'd'] });
  assert.ok(one(draw(aiData({ phase: 'done', aiProof: { a: slot({ done: true }), b: slot({ done: true }), c: slot({ done: true }), d: slot({ done: true }) }, bookProof: allLocked, closingSkipped: false })), 'vam-book-open-issues'), 'the saved decision wins over the older rule');
  assert.ok(one(draw(aiData({ phase: 'done', aiProof: proof, bookProof: book })), 'vam-book-open-issues'), 'an older save, partly locked: the button as before');
});
test('B33-z: the notice for chapters skipped as locked names them, in each UI language', () => {
  setUiLanguage('zh-TW');
  assert.equal(bundle.lockedSkippedNotice(['甲', '乙']), 'AI 校對略過了已鎖定的章：甲、乙。其他章都沒有問題。');
  setUiLanguage('zh-CN');
  assert.equal(bundle.lockedSkippedNotice(['甲']), 'AI 校对略过了已锁定的章：甲。其他章都没有问题。');
  setUiLanguage('en');
  assert.equal(bundle.lockedSkippedNotice(['A', 'B']), 'The AI proofread skipped these locked chapters: A, B. Nothing else is open.');
  setUiLanguage('zh-TW');
});
test('bar: with a book structure the fix line names the card by its place (preface / chapter / section) and counts cards', () => {
  const order = ['p', 'c1', 's1', 'c2'];
  const places = { p: { kind: 'preface' }, c1: { kind: 'chapter', chapter: 1 }, s1: { kind: 'section', chapterId: 'c1', sectionIndex: 1, sectionCount: 1 }, c2: { kind: 'chapter', chapter: 2 } };
  const structure = { placeOf: id => places[id], chapters: ['c1', 'c2'], sectionsOf: id => (id === 'c1' ? ['s1'] : []), trialOf: () => ['p', 'c1', 's1'], neighboursOf: () => ({}) };
  const titles = { p: '前言', c1: '沒有錢的世界', s1: '以物易物', c2: 'x' };
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order, trial: ['p', 'c1', 's1'], globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', autoFixes: { p: 1, c1: 1, s1: 1 } };
  const progress = { runId: 'r', phase: 'writing', status: 'running', active: true, total: 4, counts: { pending: 1, planned: 0, written: 0, checked: 3, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [] };
  const text = (language, nodeId) => { setUiLanguage(language); return bundle.bookProgressText(bundle.bookBarState(data, { ...progress, current: [{ nodeId, step: 'write', startedAt: 1 }] }, () => undefined, undefined, structure, id => titles[id])); };
  assert.equal(text('zh-TW', 'p'), '正在修正前言・已完成 3／4 張卡');
  assert.equal(text('zh-TW', 'c1'), '正在修正第 1 章・已完成 3／4 張卡', 'the first chapter is chapter 1, not 2');
  assert.equal(text('zh-TW', 's1'), '正在修正「以物易物」・已完成 3／4 張卡');
  assert.equal(text('zh-CN', 'c1'), '正在修正第 1 章・已完成 3／4 张卡');
  assert.equal(text('en', 'c1'), 'Fixing chapter 1 · 3/4 cards done');
  // A run whose trial is not the structure's keeps the old wording.
  setUiLanguage('zh-TW');
  const old = bundle.bookProgressText(bundle.bookBarState({ ...data, trial: ['c1', 's1'] }, { ...progress, current: [{ nodeId: 'c1', step: 'write', startedAt: 1 }] }, () => undefined, undefined, structure, id => titles[id]));
  assert.equal(old, '正在修正第 2 章・已完成 3／4 章', 'old wording kept');
  assert.ok(!old.includes('張卡'));
});

test('bar: a finished book with a preface, 8 chapters and 14 sections says 8 chapters, not the card count; an old state without structure falls back to cards', () => {
  setUiLanguage('zh-TW');
  const order = ['p'];
  const places = { p: { kind: 'preface' } };
  const chapters = [];
  const sectionsOf = {};
  for (let c = 1; c <= 8; c++) {
    const id = `c${c}`;
    order.push(id); chapters.push(id); places[id] = { kind: 'chapter', chapter: c }; sectionsOf[id] = [];
    const n = c <= 6 ? 2 : 1;
    for (let k = 1; k <= n; k++) { const sid = `${id}s${k}`; order.push(sid); sectionsOf[id].push(sid); places[sid] = { kind: 'section', chapterId: id, sectionIndex: k, sectionCount: n }; }
  }
  assert.equal(order.length, 23);
  const structure = { placeOf: id => places[id], chapters, sectionsOf: id => sectionsOf[id] ?? [], trialOf: () => [], neighboursOf: () => ({}) };
  const data = aiData({ phase: 'done', order, accepted: order, aiProof: {} });
  const draw = st => { const bar = dom.element('div'); bundle.renderBookBar(bar, st, { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, openIssues() {} }); return one(bar, 'vam-book-done-counts').text; };
  assert.equal(draw(bundle.bookBarState(data, undefined, () => undefined, undefined, structure)), '8 章・AI 修了 0 處・仍有問題 0 項');
  assert.equal(draw(bundle.bookBarState(data, undefined, () => undefined)), '23 章・AI 修了 0 處・仍有問題 0 項', 'no structure: the card count, no throw');
});

test('bar: with a book structure the writing and done counts say cards, not chapters; without one the old chapter wording stays', () => {
  const places = { p: { kind: 'preface' }, c1: { kind: 'chapter', chapter: 1 }, s1: { kind: 'section', chapterId: 'c1', sectionIndex: 1, sectionCount: 1 }, c2: { kind: 'chapter', chapter: 2 } };
  const structure = { placeOf: id => places[id], chapters: ['c1', 'c2'], sectionsOf: id => (id === 'c1' ? ['s1'] : []), trialOf: () => ['p', 'c1', 's1'], neighboursOf: () => ({}) };
  const order = ['p', 'c1', 's1', 'c2'];
  const base = { v: 1, runId: 'r', status: 'running', order, trial: ['p', 'c1', 's1'], globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const progress = phase => ({ runId: 'r', phase, status: 'running', active: true, total: 4, counts: { pending: 1, planned: 0, written: 0, checked: 3, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], current: [{ nodeId: 'c2', step: 'write', startedAt: 1 }] });
  const text = (language, phase, struct) => { setUiLanguage(language); return bundle.bookProgressText(bundle.bookBarState({ ...base, phase }, progress(phase), () => undefined, undefined, struct, id => id)); };
  assert.equal(text('zh-TW', 'writing', structure), '寫作中 · 已完成 3/4 張卡，正在寫第 4 張卡');
  assert.equal(text('en', 'writing', structure), 'Writing · 3/4 cards done, Now writing card 4');
  assert.equal(text('zh-TW', 'planning', structure), '正在企劃第 4／4 張卡，已完成 3／4 張卡');
  assert.equal(text('zh-CN', 'planning', structure), '正在企划第 4／4 张卡，已完成 3／4 张卡');
  assert.equal(text('zh-TW', 'writing', undefined), '寫作中 · 已完成 3/4 章，正在寫第 4 章', 'no structure: unchanged');
  assert.equal(text('zh-TW', 'planning', undefined), '正在企劃第 4／4 章，已完成 3／4 章', 'no structure: unchanged');
});

// ---- structure edit list (gate 1) ----
const structureCase = () => {
  const node = (id, parentId, title) => ({ id, parentId, title });
  const before = { rootId: 'r', nodes: [node('r', null, 'Book'), node('a', 'r', 'Alpha'), node('b', 'r', 'Beta'), node('d', 'b', 'Digital'), node('t', 'r', 'Trust'), node('f', 'r', 'Future')] };
  const evil = 'fine <img src=x onerror=alert(1)> ![pic](http://example.test/a.png)';
  const applied = [
    { id: 'o1', op: { id: 'o1', kind: 'move', card: 't', parent: 'r', after: 'a', reason: 'trust first' }, before: { parent: 'r', after: 'b', title: 'Trust' } },
    { id: 'o2', op: { id: 'o2', kind: 'merge', card: 'd', into: 'f', reason: evil }, before: { parent: 'b', title: 'Digital' } },
    { id: 'o3', op: { id: 'o3', kind: 'add', title: 'Bitcoin', summary: 's', parent: 'f', ref: 'n', reason: 'an example' }, before: { parent: null, title: '' } },
    { id: 'o4', op: { id: 'o4', kind: 'rename', card: 'n', title: 'Bitcoin and CBDC', reason: 'clearer' }, before: { parent: 'f', title: 'Bitcoin' } },
    { id: 'o5', op: { id: 'o5', kind: 'rename', card: 'a', title: 'Before money', reason: 'consistent' }, before: { parent: 'r', title: 'Alpha' } }
  ];
  const titles = { r: 'Book', a: 'Before money', t: 'Trust', b: 'Beta', f: 'Future', n: 'Bitcoin and CBDC' };
  const parents = { a: 'r', t: 'r', b: 'r', f: 'r', n: 'f' };
  const order = ['r', 'a', 't', 'b', 'f', 'n'];
  const structure = bundle.bookStructure(order, id => parents[id], 'r');
  const edit = { runId: 'r1', applied, rejected: [{ id: 'x', code: 'locked' }, { id: 'y', code: 'cycle' }], before, archived: { d: 'Archive/Digital.md' } };
  const data = (over = {}, extra = {}) => ({ v: 1, runId: 'r1', phase: 'gate1', status: 'running', order, planReview: true, globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', structureEdit: { ...edit, ...over }, ...extra });
  const state = d => bundle.bookBarState(d, undefined, () => undefined, undefined, structure, id => titles[id]);
  const draw = (st, actions = {}) => { const bar = dom.element('div'); const out = bundle.renderBookBar(bar, st, { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, ...actions }); return { bar, out }; };
  return { data, state, draw, evil };
};

test('structure list: gate 1 lists each change with its kind, where it went and why; the summary line and the not-applied line are plain words', () => {
  setUiLanguage('zh-TW');
  const { data, state, draw, evil } = structureCase();
  const { bar } = draw(state(data()), { undoStructure() {} });
  const box = one(bar, 'vam-book-structure');
  assert.equal(box.attrs.role, 'group');
  assert.equal(box.attrs['aria-label'], '總編輯的結構調整');
  assert.deepEqual(all(box, 'vam-book-structure-kind').map(k => k.text), ['移動', '合併', '新增', '改名', '改名']);
  assert.deepEqual(all(box, 'vam-book-structure-text').map(k => k.text), [
    '「Trust」第 3 章 → 第 2 章',
    '「Digital」（Beta的節）併入「Future」',
    '「Future」下新增一節「Bitcoin」',
    '「Bitcoin」→「Bitcoin and CBDC」',
    '「Alpha」→「Before money」'
  ]);
  const whys = all(box, 'vam-book-structure-why');
  assert.equal(whys[0].children?.[0]?.text ?? texts(whys[0])[0], 'trust first');
  assert.ok(texts(whys[1]).includes(evil), 'reason stays literal text, never markup');
  assert.equal(dom.findAll(whys[1], i => i.tag === 'img' || i.tagName === 'IMG').length, 0);
  assert.deepEqual(all(box, 'vam-book-structure-sum').map(k => k.text), ['5 處結構調整 ·']);
  assert.ok(texts(box).includes('另有 2 項沒套用：碰到你改過的卡、不符合結構規則。'));
  // The chapter-count line and "undo all" (with its cost note) are gone; only per-item undo is left.
  assert.ok(!texts(box).some(x => x.includes('現在 ') || x.includes('全部還原')), 'no now/before count line, no undo-all note');
  assert.equal(one(box, 'vam-book-structure-undo-all'), undefined);
  assert.equal(all(box, 'vam-book-structure-undo').length, 5, 'every change keeps its own undo');
  // With no fold state the rows are shown, in the list container; no toggle or accept can exist without handlers.
  assert.ok(one(box, 'vam-book-structure-list'));
  assert.equal(one(box, 'vam-book-structure-toggle'), undefined);
});

test('structure list: a change made after an undone one is shown against the tree without the undone one (undo, then a chat move of the same card)', () => {
  setUiLanguage('zh-TW');
  const node = (id, parentId, title) => ({ id, parentId, title });
  const before = { rootId: 'r', nodes: [node('r', null, 'Book'), node('a', 'r', 'Alpha'), node('b', 'r', 'Beta')] };
  const applied = [
    { id: 'o1', op: { id: 'o1', kind: 'remove', card: 'a', reason: 'x' }, before: { parent: 'r', title: 'Alpha' } },
    { id: 'o2', op: { id: 'o2', kind: 'move', card: 'a', parent: 'r', after: 'b', reason: 'y' }, before: { parent: 'r', after: null, title: 'Alpha' } }
  ];
  const titles = { r: 'Book', a: 'Alpha', b: 'Beta' };
  const data = { v: 1, runId: 'r1', phase: 'gate1', status: 'running', order: ['r', 'b', 'a'], planReview: true, globalPlanned: true, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', structureEdit: { runId: 'r1', applied, rejected: [], before, undone: ['o1'] } };
  const st = bundle.bookBarState(data, undefined, () => undefined, undefined, bundle.bookStructure(['r', 'b', 'a'], id => 'r', 'r'), id => titles[id]);
  const rows = st.structureEdit.items;
  assert.equal(rows.find(i => i.id === 'o2').text, '「Alpha」第 1 章 → 第 2 章');
  assert.equal(rows.find(i => i.id === 'o1').undone, true);
  assert.match(rows.find(i => i.id === 'o1').text, /Alpha/);
});

test('structure list: nothing shows without changes, outside the plan review, or when nothing was applied or refused; the bar is then the same as before', () => {
  setUiLanguage('zh-TW');
  const { data, state, draw } = structureCase();
  const plain = data({ applied: [], rejected: [] });
  assert.equal(state(plain).structureEdit, undefined);
  assert.equal(one(draw(state(plain)).bar, 'vam-book-structure'), undefined);
  const noEdit = { ...data() }; delete noEdit.structureEdit;
  assert.equal(state(noEdit).structureEdit, undefined);
  assert.equal(state(data({}, { phase: 'writing', planReview: undefined })).structureEdit, undefined, 'only at the plan review');
  assert.equal(state(data({}, { planReview: undefined })).structureEdit, undefined);
  assert.equal(JSON.stringify({ ...state(plain), structureEdit: undefined }), JSON.stringify(state(noEdit)));
  const capOnly = state(data({ applied: [], rejected: [], overCap: true }));
  const text = texts(one(draw(capOnly).bar, 'vam-book-structure'));
  assert.ok(text.includes('總編輯提的修改超過上限（每本最多 6 項），這次都沒套用。'));
  assert.ok(!text.some(x => x.includes('全部還原')), 'no undo-all when nothing stands');
  assert.equal(one(draw(capOnly, { structureAccept: { accepted: false, expanded: false, accept() {}, toggle() {} } }).bar, 'vam-book-structure-head'), undefined, 'cap-only: no head line, the sentence stays visible even when folded');
  assert.ok(texts(one(draw(capOnly, { structureAccept: { accepted: false, expanded: false, accept() {}, toggle() {} } }).bar, 'vam-book-structure')).includes('總編輯提的修改超過上限（每本最多 6 項），這次都沒套用。'));
});

test('structure list: a change that leans on another names it for the undo button; an undone change shows "已還原" and no button', () => {
  setUiLanguage('zh-TW');
  const { data, state, draw } = structureCase();
  const calls = [];
  const { bar } = draw(state(data({ undone: ['o5'] })), { undoStructure: ids => calls.push(ids) });
  const rows = all(bar, 'vam-book-structure-row');
  const row3 = rows.find(r => r.dataset.op === 'o3');
  const button = one(row3, 'vam-book-structure-undo');
  const dep = dom.findAll(bar, i => i.id === button.attrs['aria-describedby']);
  assert.equal(dep.length, 1);
  assert.equal(dep[0].text, '還原這項也會還原：改名「Bitcoin and CBDC」');
  assert.equal(button.attrs['aria-label'], '還原：「Future」下新增一節「Bitcoin」');
  assert.equal(one(rows.find(r => r.dataset.op === 'o1'), 'vam-book-structure-undo').attrs['aria-describedby'], undefined);
  const done = rows.find(r => r.dataset.op === 'o5');
  assert.equal(one(done, 'vam-book-structure-undo'), undefined);
  assert.ok(texts(done).some(x => x.includes('已還原')));
  assert.deepEqual(all(one(bar, 'vam-book-structure'), 'vam-book-structure-sum').map(k => k.text), ['4 處結構調整 ·'], 'an undone change no longer counts');
  assert.equal(one(bar, 'vam-book-structure-undo-all'), undefined, 'there is no undo-all');
  button.listeners?.click?.[0]?.({ stopPropagation() {} });
  assert.equal(JSON.stringify(calls), JSON.stringify([['o3']]));
  // Every change undone: the head says so and no undo stays.
  const allUndone = draw(state(data({ undone: ['o1', 'o2', 'o3', 'o4', 'o5'] })), { undoStructure() {} }).bar;
  assert.deepEqual(all(allUndone, 'vam-book-structure-sum').map(k => k.text), ['結構調整都已還原 ·']);
  assert.equal(all(allUndone, 'vam-book-structure-undo').length, 0);
});

test('structure list: the archived-note link opens the parked note; busy disables every undo; a failed undo leaves one line; no undo handler, no undo buttons', () => {
  setUiLanguage('zh-TW');
  const { data, state, draw } = structureCase();
  const opened = [];
  const click = el => el.listeners?.click?.[0]?.({ stopPropagation() {} });
  const link = draw(state(data()), { undoStructure() {}, openArchived: p => opened.push(p) }).bar;
  const archived = all(link, 'vam-book-structure-archived');
  assert.equal(archived.length, 1, 'only the merged card has a parked note');
  assert.equal(archived[0].text, '看封存的筆記');
  click(archived[0]);
  assert.deepEqual(opened, ['Archive/Digital.md']);
  const busy = draw(state(data()), { undoStructure() {}, structureUndo: 'busy' }).bar;
  assert.ok(all(busy, 'vam-book-structure-undo').length > 0 && all(busy, 'vam-book-structure-undo').every(b => b.attrs.disabled === 'true'));
  assert.equal(all(busy, 'vam-book-structure-undo-all').length, 0, 'no undo-all button to disable');
  assert.ok(texts(busy).includes('還原中，請稍候…'));
  const failed = draw(state(data()), { undoStructure() {}, structureUndo: 'failed' }).bar;
  assert.ok(texts(failed).includes('還原沒有成功，心智圖已回到還原前的樣子。'));
  assert.equal(all(failed, 'vam-book-structure-undo').some(b => b.attrs.disabled), false, 'the owner can try again');
  const none = draw(state(data())).bar;
  assert.equal(all(none, 'vam-book-structure-undo').length, 0);
  assert.equal(all(none, 'vam-book-structure-undo-all').length, 0);
  setUiLanguage('en');
  const en = draw(state(data()), { undoStructure() {} }).bar;
  assert.ok(texts(en).includes('5 structure changes ·'));
  setUiLanguage('zh-TW');
});

test('structure list: folded it is one head line with a toggle and "accept"; the toggle opens the rows; accepted renders nothing; the key changes when the editor changes something new', () => {
  setUiLanguage('zh-TW');
  const { data, state, draw } = structureCase();
  const calls = [];
  const click = el => el.listeners?.click?.[0]?.({ stopPropagation() {} });
  const accept = (accepted, expanded) => ({ accepted, expanded, accept: () => calls.push('accept'), toggle: () => calls.push('toggle') });
  // Folded: head (sum + toggle + accept), no rows, no list.
  const folded = draw(state(data()), { undoStructure() {}, structureAccept: accept(false, false) }).bar;
  const box = one(folded, 'vam-book-structure');
  const head = one(box, 'vam-book-structure-head');
  assert.equal(one(head, 'vam-book-structure-sum').text, '5 處結構調整 ·');
  const toggle = one(head, 'vam-book-structure-toggle');
  assert.equal(toggle.text, '檢視 ▸');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(toggle.attrs['aria-controls'], 'vam-book-structure-list');
  const button = one(head, 'vam-book-structure-accept');
  assert.equal(button.text, '接受調整');
  assert.equal(all(box, 'vam-book-structure-row').length, 0, 'no rows while folded');
  assert.equal(one(box, 'vam-book-structure-list'), undefined);
  assert.equal(one(box, 'vam-book-structure-skipped'), undefined, 'the not-applied lines are inside the list too');
  click(toggle);
  click(button);
  assert.deepEqual(calls, ['toggle', 'accept']);
  // Expanded: the rows, the not-applied line and the list container the toggle points at; the toggle reads "hide".
  const open = one(draw(state(data()), { undoStructure() {}, structureAccept: accept(false, true) }).bar, 'vam-book-structure');
  assert.equal(all(open, 'vam-book-structure-row').length, 5);
  assert.equal(one(open, 'vam-book-structure-list').id, 'vam-book-structure-list');
  assert.equal(one(open, 'vam-book-structure-toggle').text, '收起 ▾');
  assert.equal(one(open, 'vam-book-structure-toggle').attrs['aria-expanded'], 'true');
  assert.ok(texts(open).includes('另有 2 項沒套用：碰到你改過的卡、不符合結構規則。'));
  // Accepted: the structure block is gone altogether (no reopen).
  const done = draw(state(data()), { undoStructure() {}, structureAccept: accept(true, false) }).bar;
  assert.equal(one(done, 'vam-book-structure'), undefined);
  assert.equal(one(done, 'vam-book-structure-reopen'), undefined);
  assert.equal(one(done, 'vam-book-structure-head'), undefined);
  assert.ok(one(done, 'vam-book-confirm'), 'the plan review itself stays');
  const key = state(data()).structureEdit.key;
  assert.notEqual(state(data({ applied: data().structureEdit.applied.slice(0, 2) })).structureEdit.key, key);
  assert.equal(state(data({ undone: ['o5'] })).structureEdit.key, key, 'an undo is not a new set of changes');
});

test('structure undo: the keyboard goes to the next remaining undo button, else to "start writing"; refusals read in plain words; undo all uses the runner\'s affected rule', async () => {
  setUiLanguage('zh-TW');
  const proto = bundle.VisualAgentMapView.prototype;
  const focused = [];
  const el = name => ({ focus: () => focused.push(name) });
  const world = { undos: [el('u1'), el('u2')], confirm: el('go') };
  const fake = (at, focus) => ({ closed: false, bookBarFocus: focus, bookStructureFocusAt: at, contentEl: { querySelectorAll: () => world.undos, querySelector: sel => (sel === '.vam-book-confirm' ? world.confirm : null) } });
  proto.applyBookBarFocus.call(fake(0, 'structure-undo'));
  proto.applyBookBarFocus.call(fake(5, 'structure-undo'));
  proto.applyBookBarFocus.call(fake(-1, 'structure-undo'));
  world.undos = [];
  proto.applyBookBarFocus.call(fake(0, 'structure-undo'));
  assert.equal(JSON.stringify(focused), JSON.stringify(['u1', 'u2', 'go', 'go']));
  // The fold toggle and the accepted plan review have their own targets.
  const asked = [];
  const sel = focus => ({ closed: false, bookBarFocus: focus, contentEl: { querySelector: s => ({ focus: () => asked.push(s) }) } });
  proto.applyBookBarFocus.call(sel('structure-toggle'));
  proto.applyBookBarFocus.call(sel('plan-go'));
  assert.deepEqual(asked, ['.vam-book-structure-toggle', '.vam-book-confirm']);
  const text = code => proto.structureUndoRefusalText.call({}, new bundle.BookPipelineRunError(code));
  assert.equal(text('missing'), '找不到封存的筆記，沒有還原任何東西。');
  assert.equal(text('stale'), '心智圖剛被改過，沒有還原；請再按一次。');
  assert.equal(text('busy'), bundle.bookRefusalText(new bundle.BookPipelineRunError('busy')));
  assert.equal(text('not_gate1'), bundle.bookRefusalText(new bundle.BookPipelineRunError('not_gate1')));
  setUiLanguage('en');
  assert.equal(text('stale'), 'The map was just changed, so nothing was undone. Press undo again.');
  setUiLanguage('zh-TW');
});

test('fix again focus: opening the card puts the keyboard on Cancel, closing it gives it back to the 再修一輪 button; nothing happens without a target', () => {
  const proto = bundle.VisualAgentMapView.prototype;
  const asked = [];
  const fake = focus => ({ closed: false, bookBarFocus: focus, contentEl: { querySelector: sel => ({ focus: () => asked.push(sel) }) } });
  proto.applyBookBarFocus.call(fake('again-cancel'));
  proto.applyBookBarFocus.call(fake('again-opener'));
  assert.deepEqual(asked, ['.vam-book-fix-again-cancel', '.vam-book-fix-again']);
  const gone = { closed: false, bookBarFocus: 'again-opener', contentEl: { querySelector: () => null } };
  proto.applyBookBarFocus.call(gone);
  assert.equal(gone.bookBarFocus, null, 'the request is used up');
  const proto2 = bundle.VisualAgentMapView.prototype;
  const asking = { bookAbandonAsking: 'p', bookFixAgainAsking: null, closed: true };
  proto2.askBookFixAgain.call(asking, 'p', true);
  assert.deepEqual([asking.bookAbandonAsking, asking.bookFixAgainAsking], [null, 'p'], 'asking one clears the other');
  proto2.askBookAbandon.call(asking, 'p', true);
  assert.deepEqual([asking.bookAbandonAsking, asking.bookFixAgainAsking], ['p', null]);
});

// ---- "Book settings" beside Stop (2026-11-25) ----
const settingsBundle = loadSource(`
export { BookSettingsViewModal } from "./experiences/visual-map/book-pipeline-start-modal";
export { effectiveSettings } from "./core/book-pipeline/settings";
export { parseBookPlanDecisions } from "./core/book-pipeline/plan-text";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
const settingsData = (over = {}) => ({ v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b', 'c'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x', ...over });
const drawSettings = (state, actions) => { const bar = dom.element('div'); bundle.renderBookBar(bar, state, { stop() {}, resume() {}, addBudget() {}, confirmGate1() {}, ...actions }); return bar; };
const buttonTexts = bar => dom.findAll(bar, i => i.tag === 'button').map(b => b.text);

test('book settings button: planning, writing, plan review, budget and map-changed bars each show it once, right before Stop', () => {
  setUiLanguage('zh-TW');
  const cases = {
    planning: settingsData({ phase: 'planning' }),
    writing: settingsData(),
    gate1: settingsData({ phase: 'gate1', planReview: true, trial: ['a'], globalPlanned: true }),
    budget: settingsData({ status: 'stopped', pauseReason: 'budget' }),
    changed: settingsData({ status: 'stopped', pauseReason: 'map', changed: { added: ['x'], missing: ['y'] } })
  };
  for (const [mode, data] of Object.entries(cases)) {
    const live = { runId: 'r', phase: data.phase, status: 'running', active: true, total: 3, counts: { pending: 3, planned: 0, written: 0, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x' };
    const state = bundle.bookBarState(data, data.status === 'running' ? live : undefined, () => undefined);
    assert.equal(state.mode, mode);
    const bar = drawSettings(state, { showSettings() {} });
    const names = buttonTexts(bar);
    assert.equal(names.filter(n => n === '書本設定').length, 1, `${mode}: one book settings button`);
    assert.equal(names.indexOf('書本設定') + 1, names.indexOf('停止'), `${mode}: right before Stop`);
  }
});

test('book settings button: two Stop buttons (map changed + rerun) still draw only one; no action, no button; a click calls the action; stopped/done bars (no Stop) show none', () => {
  setUiLanguage('zh-TW');
  const changed = bundle.bookBarState(settingsData({ status: 'stopped', pauseReason: 'map', changed: { added: ['x'], missing: ['y'] } }), undefined, () => undefined);
  const two = drawSettings({ ...changed, rerun: true }, { showSettings() {} });
  assert.equal(all(two, 'vam-book-stop').length, 2);
  assert.equal(all(two, 'vam-book-settings-view').length, 1);
  assert.equal(all(drawSettings(changed, {}), 'vam-book-settings-view').length, 0, 'a bar drawn without the action shows none');
  const calls = [];
  const live = { runId: 'r', phase: 'writing', status: 'running', active: true, total: 3, counts: { pending: 3, planned: 0, written: 0, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x' };
  const bar = drawSettings(bundle.bookBarState(settingsData(), live, () => undefined), { showSettings: () => calls.push('settings') });
  one(bar, 'vam-book-settings-view').click();
  assert.deepEqual(calls, ['settings']);
  const stopped = bundle.bookBarState(settingsData({ status: 'stopped', pauseReason: 'user' }), undefined, () => undefined);
  assert.equal(all(drawSettings(stopped, { showSettings() {} }), 'vam-book-settings-view').length, 0);
});

test('book settings modal: six labels with their values, the empty-field line for a missing one, the hint and Close; values are plain text', () => {
  settingsBundle.setUiLanguage('zh-TW');
  const modal = new settingsBundle.BookSettingsViewModal({}, { reader: EVIL, goal: '  ', tone: 'calm' });
  modal.open();
  const dts = dom.findAll(modal.contentEl, i => i.tag === 'dt').map(i => i.text);
  const dds = dom.findAll(modal.contentEl, i => i.tag === 'dd');
  assert.deepEqual(dts, ['讀者', '學習目標', '想看的角度', '語氣', '每章字數', '寫作風格']);
  assert.equal(dds[0].text, EVIL, 'set as text, never parsed');
  assert.equal(dds[0].children.length, 0);
  assert.deepEqual(dds.map(d => d.text).slice(1), ['留空 → 由總編輯決定', '留空 → 由總編輯決定', 'calm', '留空 → 由總編輯決定', '留空 → 由總編輯決定']);
  assert.ok(texts(modal.contentEl).some(x => x.includes('要改，先按「停止」，再跟總編輯說')));
  const close = dom.findAll(modal.modalEl, i => i.tag === 'button' && i.text === '關閉')[0];
  assert.ok(close);
  close.click();
  assert.equal(modal.closeCount, 1);
});

test('book settings: the shown values are the root frontmatter first, then the plan decisions', () => {
  const raw = '## 全書企劃\n\n### 編輯決定\n- 語氣：plan tone\n- 讀者：plan reader\n';
  const decided = settingsBundle.parseBookPlanDecisions(raw);
  const shown = settingsBundle.effectiveSettings({ reader: 'own reader' }, decided);
  assert.equal(shown.reader, 'own reader');
  assert.equal(shown.tone ?? '', decided.tone ?? '');
});

test('book settings: the view reads the root card and opens the modal with the effective values; an unreadable root or no root gives a Notice and no modal', async () => {
  setUiLanguage('zh-TW');
  const proto = bundle.VisualAgentMapView.prototype;
  const opened = [];
  const view = (readBookCardForChat, nodes) => ({ map: { nodes }, app: {}, plugin: { readBookCardForChat }, openMapModal: m => { opened.push(m); return m; } });
  const before = notices.length;
  await proto.showBookSettings.call(view(async () => ({ settings: { reader: 'own' }, raw: '' }), [{ id: 'k', path: 'k.md', parentId: 'r' }, { id: 'r', path: 'r.md' }]));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].values.reader, 'own');
  await proto.showBookSettings.call(view(async () => { throw new Error('gone'); }, [{ id: 'r', path: 'r.md' }]));
  await proto.showBookSettings.call(view(async () => ({ settings: {}, raw: '' }), []));
  assert.equal(opened.length, 1, 'no modal for a failed read or a map without a root');
  assert.equal(notices.length - before, 2);
});
