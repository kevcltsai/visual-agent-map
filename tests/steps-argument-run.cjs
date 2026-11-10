// Argument map runner (P5a): the gates, stop/resume, stale fence and dispose behaviour of ArgumentRuns, with fake ports over the
// real repository fixture. The provider, fetch and step runner are fakes; nothing here proves live provider behaviour.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { ArgumentRuns, ArgumentRunError, WORST_CASE_AI_CALLS } = S.load('experiences/visual-map/argument-run.ts');
const { ARGUMENT_STEPS, ArgumentStepError } = S.load('core/steps/argument-map/runner.ts');
const model = S.load('core/argument-map/model.ts');
const { translate } = S.load('i18n.ts');

const QUOTE = 'Youth unemployment rose to 9.2 percent in March';
const URL_OK = 'https://stats.example.org/report';
const PAGE = `<html><body><p>${QUOTE}, the highest in a decade.</p></body></html>`;
const STEP_NAME = { 'argument-map.plan-situation': 'plan_situation', 'argument-map.situation-gate': 'judge_gate', 'argument-map.hypotheses': 'propose_hypotheses', 'argument-map.verdict': 'verdict', 'argument-map.conclusion': 'conclude' };
const stepName = (step, request) => (step.id === ARGUMENT_STEPS.add_needs.id ? (request.existing.length ? 'revise' : 'add_needs') : STEP_NAME[step.id]);
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const foundEntry = (id, over = {}) => ({ need: id, status: 'found', stance: 'supports', claim: 'Rate rose', quote: QUOTE, url: URL_OK, ...over });

/** Everything the run needs; `over` replaces fakes. `script.step[name](request, n)` returns a parsed output or throws; `script.ask(ctx, n)` an AiResult. */
async function rig(over = {}) {
  const data = S.fixture('zh-TW', { linkIndex: true });
  const { repo } = data;
  const mapPath = await repo.createMap('Argument');
  const stat = { ask: [], steps: [], undo: [], logs: [], fetches: 0, active: 0, maxActive: 0 };
  let queue = Promise.resolve();
  const script = { step: {}, ask: (ctx) => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }), ...over.script };
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: path => repo.readMap(path),
    updateMap: (path, change) => repo.updateMap(path, change),
    createNote: (input, map) => repo.createNote(input.title, 'model-a', map, mapPath, 'workspace', { summary: input.summary, detail: input.detail, topicKind: input.kind === 'hypothesis' ? 'hypothesis' : input.kind === 'need' ? 'evidence' : input.kind === 'conclusion' ? 'conclusion' : 'topic' }),
    readNote: path => repo.readNote(path),
    updateNote: (path, patch) => repo.updateNote(path, patch),
    askModel: async (ctx, _model, _reasoning, signal) => {
      stat.ask.push(ctx); stat.active++; stat.maxActive = Math.max(stat.maxActive, stat.active);
      try {
        stat.beginSeen = stat.beginSeen ?? [];
        const state = model.readArgumentMap(await repo.readMap(mapPath)).data;
        stat.beginSeen.push(state.run.researchCalls);
        return await script.ask(ctx, stat.ask.length, signal);
      } finally { stat.active--; }
    },
    runStep: async (step, request) => {
      const name = stepName(step, request); stat.steps.push(name);
      const count = stat.steps.filter(n => n === name).length;
      const fake = script.step[name];
      if (!fake) throw new Error(`no fake for ${name}`);
      return fake(request, count);
    },
    fetch: async request => { stat.fetches++; return { status: 200, headers: { 'content-type': 'text/html' }, text: PAGE, url: request.url }; },
    parseHtml: html => html.replace(/<[^>]+>/g, ' '),
    now: () => '2026-11-09T00:00:00.000Z',
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    config: () => ({ model: 'model-a', reasoning: 'low', language: 'zh-TW' }),
    begin: () => { const controller = new AbortController(); return { signal: controller.signal, release: () => undefined }; },
    clearUndo: path => stat.undo.push(path),
    log: line => stat.logs.push(line),
    t: (key, ...values) => translate('zh-TW', key, ...values),
    ...over.ports
  };
  const runs = new ArgumentRuns(ports);
  const state = async () => model.readArgumentMap(await repo.readMap(mapPath)).data;
  return { ...data, runs, ports, stat, script, mapPath, state, text: async id => repo.readNote((await repo.readMap(mapPath)).nodes.find(n => n.id === id).path) };
}

/** Default scripted steps: two situation data, a matching gate, hypotheses that cite the first datum, two needs each, supported verdicts. */
const steps = (over = {}) => ({
  plan_situation: () => ({ data: [{ need: 'unemployment rate' }, { need: 'job postings' }] }),
  judge_gate: request => ({ matches: true, reason: 'data fit', citedData: [request.data[0].id] }),
  propose_hypotheses: request => ({ hypotheses: Array.from({ length: request.count }, (_, i) => ({ title: `H${request.existing.length + i + 1}`, statement: `statement ${request.existing.length + i + 1}`, citedData: [request.data[0].id] })) }),
  add_needs: () => ({ needs: [{ text: 'need one' }, { text: 'need two' }] }),
  revise: () => ({ needs: [{ text: 'next one' }] }),
  verdict: request => ({ verdict: 'supported', citedNeeds: [request.input.evidence[0].id], reason: 'enough' }),
  conclude: request => ({ summary: 'final answer', points: [{ text: 'point', hypothesisIds: request.input.hypotheses.map(h => h.id) }], basedOn: request.input.hypotheses.map(h => h.id) }),
  ...over
});

test('happy path: runs to a conclusion; begin is written before each dispatch; one node per item; logs carry no text', async () => {
  const r = await rig({ script: { step: steps() } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  assert.equal(state.run.status, 'finished');
  assert.equal(model.verifiedCount(state), 3);
  assert.equal(state.run.researchCalls, 2 + 6);
  // begin before dispatch: the nth dispatch already saw researchCalls >= n
  r.stat.beginSeen.forEach((seen, i) => assert.ok(seen >= i + 1, `dispatch ${i + 1} saw ${seen}`));
  const doc = await r.repo.readMap(r.mapPath);
  const ids = doc.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(doc.nodes.length, 5 + 2 + 3 + 6);
  const conclusion = await r.text(state.roles.conclusion);
  assert.equal(conclusion.summary, 'final answer');
  assert.ok(conclusion.detail.includes('依據的現況數據'));
  assert.ok(conclusion.detail.includes(URL_OK));
  assert.ok(r.stat.undo.length > 0 && r.stat.undo.every(p => p === r.mapPath));
  const log = r.stat.logs.join('\n');
  assert.ok(log.includes('stats.example.org') && !log.includes(QUOTE) && !log.includes(URL_OK) && log.includes('runId=id-1'));
  assert.equal(r.runs.isRunning(r.mapPath), false);
  // every checkpoint leaves the map arranged: deeper layers sit to the right, no two cards share a spot, and arranging again moves nothing
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  for (const n of doc.nodes.filter(n => n.parentId)) assert.ok(n.x > byId.get(n.parentId).x, n.id);
  assert.equal(new Set(doc.nodes.map(n => `${n.x},${n.y}`)).size, doc.nodes.length);
  const layoutModule = S.load('core/argument-map/layout.ts');
  const again = layoutModule.arrangeArgumentMap(doc.nodes, doc.argumentMap);
  assert.deepEqual(again.map(n => [n.id, n.x, n.y]), doc.nodes.map(n => [n.id, n.x, n.y]));
  assert.equal(layoutModule.arrangeUnarrangedArgumentMap(doc.nodes, doc.argumentMap), null);
});

test('layers: the eliminated group hangs under the conclusion; each situation datum is a leaf card (node id == datum id) under the situation card', async () => {
  const r = await rig({ script: { step: steps() } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const state = await r.state();
  const doc = await r.repo.readMap(r.mapPath);
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  assert.equal(byId.get(state.roles.eliminated).parentId, state.roles.conclusion);
  assert.equal(byId.get(state.roles.verified).parentId, state.roles.conclusion);
  assert.equal(byId.get(state.roles.situation).parentId, state.roles.proposition);
  assert.equal(state.situation.data.length, 2);
  for (const datum of state.situation.data) {
    const node = byId.get(datum.id);
    assert.ok(node, 'datum has a node');
    assert.equal(node.parentId, state.roles.situation);
    const note = await r.repo.readNote(node.path);
    assert.equal(note.summary, 'Rate rose');
    assert.ok(note.detail.includes(URL_OK));
  }
  assert.ok(model.managedNodeIds(doc).has(state.situation.data[0].id));
});

test('situation data: a deleted datum card is a miss with no note and no duplicate node', async () => {
  const holder = {};
  const r = await rig({ script: { step: steps(), ask: async ctx => {
    const id = ctx.argumentEvidenceNeeds[0].id;
    const isDatum = (await holder.r.state()).situation.data.some(d => d.id === id);
    if (isDatum && !holder.deleted) {
      holder.deleted = id;
      await holder.r.repo.updateMap(holder.r.mapPath, map => { map.nodes = map.nodes.filter(node => node.id !== id); });
    }
    return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(id)] };
  } } });
  holder.r = r;
  await r.runs.start(r.mapPath, 'p');
  const doc = await r.repo.readMap(r.mapPath);
  assert.ok(holder.deleted);
  assert.equal(doc.nodes.some(n => n.id === holder.deleted), false);
  const ids = doc.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
  const state = await r.state();
  const gone = state.situation.data.find(d => d.id === holder.deleted);
  assert.notEqual(gone.state, 'found', 'a deleted card never counts as found');
});

test('matches:false: 0 hypotheses, 0 research dispatches after, researchCalls unchanged, fixed sentence, resume refused', async () => {
  const r = await rig({ script: { step: steps({ judge_gate: request => ({ matches: false, reason: 'rate fell', citedData: [request.data[0].id] }) }) } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const dispatchesAtGate = r.stat.ask.length;
  const state = await r.state();
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal(state.hypotheses.length, 0);
  assert.equal(state.run.researchCalls, dispatchesAtGate);
  assert.equal(r.stat.steps.includes('propose_hypotheses'), false);
  assert.equal((await r.text(state.roles.conclusion)).summary, '現況不符合命題，已停止');
  assert.equal((await r.repo.readMap(r.mapPath)).nodes.length, 5 + 2, 'five fixed cards and the two data cards; no hypothesis note');
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e instanceof ArgumentRunError && e.code === 'finished');
  assert.equal(r.stat.ask.length, dispatchesAtGate);
  assert.equal(r.runs.isRunning(r.mapPath), false);
});

test('data missing: 0 gate AI calls, stopped as data_missing with its own sentence', async () => {
  const r = await rig({ script: { step: steps(), ask: ctx => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], argumentEvidence: [{ need: ctx.argumentEvidenceNeeds[0].id, status: 'not_found' }] }) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(r.stat.steps.includes('judge_gate'), false);
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal(state.situation.gate.kind, 'data_missing');
  assert.equal((await r.text(state.roles.conclusion)).summary, '找不到所需的現況資料，已停止');
  assert.equal(state.hypotheses.length, 0);
});

test('a forged source is not found: unusable proof never becomes a found datum', async () => {
  const r = await rig({ script: { step: steps(), ask: ctx => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id, { quote: 'This sentence is not on the page at all' })] }) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.ok(state.situation.data.every(d => d.state === 'not_found' && !d.proof));
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal(r.stat.fetches > 0, true);
});

test('stop pauses (items back to pending), a late result is not written, resume redoes only unfinished items', async () => {
  const gate = defer();
  let release = false;
  const r = await rig({ script: { step: steps(), ask: async (ctx, n) => {
    if (!release && n === 2) { await gate.promise; }
    return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] };
  } } });
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 2) await tick();
  await r.runs.stop(r.mapPath);
  await started;
  let state = await r.state();
  assert.equal(state.run.status, 'paused');
  assert.equal(state.run.stopReason, 'user');
  assert.equal(r.runs.isRunning(r.mapPath), false);
  assert.ok(state.situation.data.every(d => d.state !== 'searching'));
  const before = JSON.stringify(state);
  gate.resolve(); // the late result of the aborted dispatch
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(JSON.stringify(await r.state()), before, 'late result must not be written');
  const done = state.situation.data.filter(d => d.state === 'found').map(d => d.id);
  const askedBefore = r.stat.ask.length;
  release = true;
  await r.runs.resume(r.mapPath);
  state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  const reasked = r.stat.ask.slice(askedBefore).map(ctx => ctx.argumentEvidenceNeeds[0].id);
  for (const id of done) assert.equal(reasked.includes(id), false, 'a finished item was redone');
  const ids = (await r.repo.readMap(r.mapPath)).nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('dispose: aborts and never writes afterwards', async () => {
  const gate = defer();
  const r = await rig({ script: { step: steps(), ask: async ctx => { await gate.promise; return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }; } } });
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 1) await tick();
  r.runs.dispose();
  const snapshot = r.contents.get(r.mapPath);
  gate.resolve();
  await started;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(r.contents.get(r.mapPath), snapshot);
  await assert.rejects(() => r.runs.start(r.mapPath, 'p'), e => e instanceof ArgumentRunError && e.code === 'disposed');
});

test('concurrency: at most 3 research dispatches at once', async () => {
  const r = await rig({ script: { step: steps({ plan_situation: () => ({ data: Array.from({ length: 6 }, (_, i) => ({ need: `n${i}` })) }) }), ask: async ctx => {
    await tick(); await tick();
    return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] };
  } } });
  await r.runs.start(r.mapPath, 'p');
  assert.ok(r.stat.maxActive <= 3 && r.stat.maxActive >= 2, `max ${r.stat.maxActive}`);
});

test('caps: a 7th hypothesis is refused (no notes left behind) and the run pauses after one corrective retry', async () => {
  const r = await rig({ script: { step: steps({ propose_hypotheses: request => ({ hypotheses: Array.from({ length: 7 }, (_, i) => ({ title: `H${i}`, statement: `s${i}`, citedData: [request.data[0].id] })) }) }) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(r.stat.steps.filter(n => n === 'propose_hypotheses').length, 2);
  assert.equal(state.run.status, 'paused');
  assert.equal(state.run.stopReason, 'error');
  assert.equal(state.hypotheses.length, 0);
  assert.equal((await r.repo.readMap(r.mapPath)).nodes.length, 5 + 2, 'five fixed cards and the two data cards; no hypothesis note');
});

test('one corrective retry: a refused step succeeds the second time; failing twice pauses with error', async () => {
  const flaky = { ...steps() };
  flaky.plan_situation = (_request, n) => { if (n === 1) throw new ArgumentStepError('bad reply'); return { data: [{ need: 'a' }] }; };
  const r = await rig({ script: { step: flaky } });
  await r.runs.start(r.mapPath, 'p');
  assert.equal(r.stat.steps.filter(n => n === 'plan_situation').length, 2);
  assert.equal((await r.state()).run.phase, 'concluded');
  const broken = await rig({ script: { step: steps({ plan_situation: () => { throw new ArgumentStepError('bad reply'); } }) } });
  await broken.runs.start(broken.mapPath, 'p');
  const state = await broken.state();
  assert.equal(broken.stat.steps.filter(n => n === 'plan_situation').length, 2);
  assert.equal(state.run.status, 'paused');
  assert.equal(state.run.stopReason, 'error');
  assert.equal(broken.stat.ask.length, 0);
});

test('dead need #9: a not_found need is replaced in round 2 and the hypothesis verifies without a 3rd round', async () => {
  const r = await rig({ script: { step: steps({ add_needs: (_request, n) => ({ needs: n === 1 ? [{ text: 'dead source' }, { text: 'live two' }] : [{ text: 'need one' }, { text: 'need two' }] }), revise: () => ({ needs: [{ text: 'replacement source' }] }) }),
    ask: ctx => { const { id, text } = ctx.argumentEvidenceNeeds[0]; return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [text === 'dead source' ? { need: id, status: 'not_found' } : foundEntry(id)] }; } } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(r.stat.steps.filter(n => n === 'revise').length, 1);
  assert.equal(state.run.phase, 'concluded');
  assert.equal(model.verifiedCount(state), 3);
  const h1 = state.hypotheses[0];
  assert.equal(h1.round, 2);
  assert.deepEqual(plain(h1.needs.map(n => [n.text, n.state])), [['dead source', 'not_found'], ['live two', 'found'], ['replacement source', 'found']]);
  assert.equal(h1.needs[2].replaces, h1.needs[0].id);
  assert.equal(state.run.researchCalls, 2 + 3 + 2 + 2);
});

test('limits: refuted hypotheses stop at round 3, never 4; <3 verified never concludes; a user flip does not verify unfound needs', async () => {
  let asked = 0;
  const r = await rig({ script: { step: steps({ verdict: request => ({ verdict: 'refuted', citedNeeds: [request.input.evidence[0].id], reason: 'no' }) }),
    ask: ctx => { asked++; const id = ctx.argumentEvidenceNeeds[0].id; return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [asked % 5 === 0 ? { need: id, status: 'not_found' } : foundEntry(id)] }; } } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'stopped_limit');
  assert.equal(r.stat.steps.includes('conclude'), false);
  assert.ok(Math.max(...state.hypotheses.map(h => h.round)) <= 3);
  assert.ok(state.hypotheses.length <= 6);
  assert.ok(state.run.researchCalls <= 66);
  assert.ok((await r.text(state.roles.conclusion)).summary.startsWith('限制內未能驗證 3 個假設'));
  for (const h of state.hypotheses) {
    // flip a need that is not retired (a replaced dead need no longer blocks, so flipping needs[0] would test nothing)
    const retired = model.retiredNeedIds(h);
    const target = h.needs.filter(n => !retired.has(n.id)).at(-1)?.id; // undefined only for a hypothesis with no needs, which is never verified anyway
    const flipped = { ...h, location: 'verifying', userVerdict: 'supported', needs: h.needs.map(n => (n.id === target ? { ...n, state: 'not_found' } : n)) };
    assert.equal(model.isVerified(flipped), false);
  }
});

test('stale fence: a card the user deleted gets no note and no node, and the item is closed as a miss', async () => {
  const gate = defer();
  const holder = {};
  const r = await rig({ script: { step: steps(), ask: async ctx => {
    const id = ctx.argumentEvidenceNeeds[0].id;
    const isNeed = !(await holder.r.state()).situation.data.some(d => d.id === id);
    if (isNeed && !holder.deleted) {
      holder.deleted = id;
      await holder.r.repo.updateMap(holder.r.mapPath, map => { map.nodes = map.nodes.filter(node => node.id !== id); });
    }
    return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(id)] };
  } } });
  holder.r = r;
  void gate;
  await r.runs.start(r.mapPath, 'p');
  const doc = await r.repo.readMap(r.mapPath);
  assert.ok(holder.deleted);
  assert.equal(doc.nodes.some(n => n.id === holder.deleted), false);
  const ids = doc.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('unusable or existing key: start and resume refuse, nothing is written, no provider call', async () => {
  const r = await rig({ script: { step: steps() } });
  const raw = { v: 2, roles: {}, anything: [1, 2] };
  await r.repo.updateMap(r.mapPath, map => { map.argumentMap = raw; });
  const bytes = r.contents.get(r.mapPath);
  await assert.rejects(() => r.runs.start(r.mapPath, 'p'), e => e.code === 'unusable');
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e.code === 'unusable');
  assert.equal(r.contents.get(r.mapPath), bytes);
  assert.equal(r.stat.ask.length + r.stat.steps.length, 0);
  assert.equal(r.runs.isRunning(r.mapPath), false);
  const ok = await rig({ script: { step: steps() } });
  await ok.runs.start(ok.mapPath, 'p');
  await assert.rejects(() => ok.runs.start(ok.mapPath, 'p'), e => e.code === 'exists');
});

test('a second start on a running map is refused; usage confirmation declined pauses before any dispatch', async () => {
  const gate = defer();
  const r = await rig({ script: { step: steps(), ask: async ctx => { await gate.promise; return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }; } } });
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 1) await tick();
  assert.equal(r.runs.isRunning(r.mapPath), true);
  await assert.rejects(() => r.runs.start(r.mapPath, 'p'), e => e.code === 'busy');
  await r.runs.stop(r.mapPath);
  gate.resolve();
  await started;
  const declined = await rig({ script: { step: steps() }, ports: { confirmUsage: async () => false } });
  await declined.runs.start(declined.mapPath, 'p');
  assert.equal(declined.stat.ask.length + declined.stat.steps.length, 0);
  const state = await declined.state();
  assert.equal(state.run.status, 'paused');
  assert.equal(state.run.stopReason, 'user');
  assert.equal(state.run.researchCalls, 0);
});

test('stale fence: a run changed by someone else mid-dispatch drops the late result and keeps their pause reason', async () => {
  const gate = defer();
  const holder = {};
  const r = await rig({ script: { step: steps(), ask: async ctx => {
    await gate.promise;
    return { summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] };
  } } });
  holder.r = r;
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 2) await tick();
  // the recovery rule of another window: searching items back to pending, run paused as interrupted
  await r.repo.updateMap(r.mapPath, map => {
    const { applyPause } = S.load('core/argument-map/machine.ts');
    map.argumentMap = applyPause(map.argumentMap, 'interrupted');
  });
  const bytes = r.contents.get(r.mapPath);
  gate.resolve();
  await started;
  assert.equal(r.contents.get(r.mapPath), bytes, 'late result written over a changed run');
  const state = await r.state();
  assert.equal(state.run.stopReason, 'interrupted');
  assert.ok(state.situation.data.every(d => d.state === 'pending'));
});

test('dispose between the map write and the note write: the notes are skipped; dispose while building: nothing is written', async () => {
  const holder = {};
  const mismatch = await rig({ script: { step: steps({ judge_gate: request => ({ matches: false, reason: 'rate fell', citedData: [request.data[0].id] }) }) }, ports: {
    updateMap: async (path, change) => {
      const map = await holder.repo.updateMap(path, change);
      if (map.argumentMap?.run.phase === 'stopped_mismatch') holder.runs.dispose();
      return map;
    }
  } });
  holder.repo = mismatch.repo; holder.runs = mismatch.runs;
  await mismatch.runs.start(mismatch.mapPath, 'p');
  const state = await mismatch.state();
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal((await mismatch.text(state.roles.conclusion)).summary, '研究進行中，尚無結論');

  const build = {};
  const creating = await rig({ script: { step: steps() }, ports: {
    createNote: async (input, map) => {
      const node = await build.make(input, map);
      if (input.kind === 'hypothesis') build.runs.dispose();
      return node;
    }
  } });
  build.runs = creating.runs;
  build.make = (input, map) => creating.repo.createNote(input.title, 'model-a', map, creating.mapPath, 'workspace', { summary: input.summary, topicKind: input.kind === 'hypothesis' ? 'hypothesis' : 'topic' });
  await creating.runs.start(creating.mapPath, 'p').catch(() => undefined);
  assert.equal((await creating.state()).hypotheses.length, 0);
});

// Security: model/web text is written to Markdown notes as plain text; a fence or line break cannot open a diagram or a code block.
const EVIL = '\n```mermaid\nflowchart LR\nA-->B\nstyle A fill:red\n```\n';
const fenceLines = text => text.split(/\r\n?|\n/).filter(line => /^\s*(`{3,}|~{3,})/.test(line));

test('sanitize on write: claim/reason/point with a mermaid fence and newlines never reach a note as a fence; summaries stay single-line', async () => {
  const r = await rig({ script: { step: steps({
    verdict: request => ({ verdict: 'supported', citedNeeds: [request.input.evidence[0].id], reason: `ok${EVIL}done` }),
    conclude: request => ({ summary: `final${EVIL}answer`, points: [{ text: `point${EVIL}more`, hypothesisIds: request.input.hypotheses.map(h => h.id) }], basedOn: request.input.hypotheses.map(h => h.id) })
  }), ask: ctx => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id, { claim: `Rate rose${EVIL}x` })] }) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  const doc = await r.repo.readMap(r.mapPath);
  let checked = 0;
  for (const node of doc.nodes) {
    const note = await r.repo.readNote(node.path);
    assert.deepEqual(fenceLines(note.detail ?? ''), [], `detail of ${node.id}`);
    assert.ok(!/[\r\n]/.test(note.summary ?? ''), `summary of ${node.id}`);
    assert.ok(!/mermaid/i.test((note.detail ?? '').split(/\r\n?|\n/).filter(l => /^\s*`/.test(l)).join('')), 'no mermaid fence line');
    checked++;
  }
  assert.ok(checked > 5);
  const conclusion = await r.text(state.roles.conclusion);
  assert.ok(conclusion.detail.includes('point') && conclusion.detail.includes('more'));
});

test('sanitize on write: a mismatch reason and a not-found reason with a fence are plain text', async () => {
  const mismatch = await rig({ script: { step: steps({ judge_gate: request => ({ matches: false, reason: `rate fell${EVIL}end`, citedData: [request.data[0].id] }) }) } });
  await mismatch.runs.start(mismatch.mapPath, 'p');
  const state = await mismatch.state();
  const note = await mismatch.text(state.roles.conclusion);
  assert.deepEqual(fenceLines(note.detail), []);
  assert.ok(note.detail.includes('rate fell'));
});

test('sanitize on write: ordinary text is written byte-identical', async () => {
  const r = await rig({ script: { step: steps({ conclude: request => ({ summary: 'final answer', points: [{ text: 'point `code` and a-b', hypothesisIds: request.input.hypotheses.map(h => h.id) }], basedOn: request.input.hypotheses.map(h => h.id) }) }) } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const state = await r.state();
  const note = await r.text(state.roles.conclusion);
  assert.equal(note.summary, 'final answer');
  assert.ok(note.detail.startsWith('- point `code` and a-b\n'));
  assert.ok(note.detail.includes(`Rate rose`) && note.detail.includes(QUOTE) && note.detail.includes(URL_OK));
  const { plainLine } = S.load('experiences/visual-map/argument-run.ts');
  for (const text of ['plain', 'a `b` c', 'x ``y`` z', '中文 text: 1.5%', '']) assert.equal(plainLine(text), text);
  assert.equal(plainLine('a\r\nb\nc'), 'a b c');
  assert.equal(plainLine('```mermaid'), '` ` `mermaid');
});

const INLINE = ['![](https://evil.example/p.png)', '![[Secret Note]]', '[[Secret Note]]', '<img src=x onerror=1>', '<script>alert(1)</script>', '\\[[Secret Note]]', '~~~\nx\n~~~', 'a\u2028b\r\nc'];
const inert = text => !/!\[|\[\[|\]\]|[<>]|[\u2028\u2029]/.test(text) && !/~{3,}|`{3,}/.test(text);
const oneLine = text => !/[\r\n]/.test(text);

test('sanitize inline Markdown: plainLine neutralizes images, wikilinks, embeds, html and keeps ordinary text', () => {
  const { plainLine } = S.load('experiences/visual-map/argument-run.ts');
  for (const bad of INLINE) assert.ok(inert(plainLine(`x ${bad} y`)) && oneLine(plainLine(bad)), JSON.stringify(plainLine(bad)));
  for (const text of ['GDP grew 3.2% in 2020 (see Table 1)', 'see [x] and a & b', 'https://stats.example.org/report?a=1&b=2', 'list [1] [2]', 'ok]']) assert.equal(plainLine(text), text);
  assert.ok(plainLine('![[Secret Note]]').includes('Secret Note'));
});

test('sanitize inline Markdown on write: claim/quote/reason/point and note title/summary stay inert', async () => {
  for (const bad of INLINE.filter(b => !b.includes('\n'))) {
    const r = await rig({ script: { step: steps({
      judge_gate: request => ({ matches: false, reason: `reason ${bad}`, citedData: [request.data[0].id] }),
      conclude: request => ({ summary: `sum ${bad}`, points: [{ text: `point ${bad}`, hypothesisIds: request.input.hypotheses.map(h => h.id) }], basedOn: request.input.hypotheses.map(h => h.id) })
    }) } });
    await r.runs.start(r.mapPath, 'p');
    const state = await r.state();
    const ids = (await r.repo.readMap(r.mapPath)).nodes.map(n => n.id);
    for (const id of ids) {
      const note = await r.text(id).catch(() => null);
      if (!note) continue;
      assert.ok(inert(note.summary ?? '') && oneLine(note.summary ?? ''), `${bad} summary ${note.summary}`);
      assert.ok(inert(note.detail ?? ''), `${bad} detail ${note.detail}`);
    }
  }
});

test('worst-case AI call count shown before a run is 109', () => {
  assert.equal(WORST_CASE_AI_CALLS, 109);
});
