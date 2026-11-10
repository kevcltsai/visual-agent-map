// Argument map runner (P5a): the gates, stop/resume, stale fence and dispose behaviour of ArgumentRuns, with fake ports over the
// real repository fixture. The provider, fetch and step runner are fakes; nothing here proves live provider behaviour.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { ArgumentRuns, ArgumentRunError, WORST_CASE_AI_CALLS, assumptionScope } = S.load('experiences/visual-map/argument-run.ts');
const { ARGUMENT_STEPS, ArgumentStepError } = S.load('core/steps/argument-map/runner.ts');
const model = S.load('core/argument-map/model.ts');
const machine = S.load('core/argument-map/machine.ts');
const { translate } = S.load('i18n.ts');

const QUOTE = 'Youth unemployment rose to 9.2 percent in March';
const URL_OK = 'https://stats.example.org/report';
const PAGE = `<html><body><p>${QUOTE}, the highest in a decade.</p></body></html>`;
const STEP_NAME = { 'argument-map.facet-plan': 'plan_facets', 'argument-map.facet-judge': 'judge_facets', 'argument-map.facet-hypotheses': 'propose_facet_hypotheses', 'argument-map.facet-verdict': 'verdict_facets', 'argument-map.situation-gate': 'judge_gate', 'argument-map.hypotheses': 'propose_hypotheses', 'argument-map.verdict': 'verdict', 'argument-map.conclusion': 'conclude' };
const stepName = (step, request) => (step.id === ARGUMENT_STEPS.add_needs.id ? (request.existing.length ? 'revise' : 'add_needs') : STEP_NAME[step.id]);
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const foundEntry = (id, over = {}) => ({ need: id, status: 'found', stance: 'supports', claim: 'Rate rose', quote: QUOTE, url: URL_OK, ...over });

/** Everything the run needs; `over` replaces fakes. Legacy mode (default): the old plan step no longer exists, so after the start write the rig seeds old-style data (`script.step.plan_situation()` needs, one card each, no facets) and the run continues as an old map; `over.facet` skips the seeding and the new facet plan runs. `script.step[name](request, n)` returns a parsed output or throws; `script.ask(ctx, n)` an AiResult. */
async function rig(over = {}) {
  const data = S.fixture('zh-TW', { linkIndex: true });
  const { repo } = data;
  const mapPath = await repo.createMap('Argument');
  const stat = { ask: [], steps: [], undo: [], logs: [], fetches: 0, active: 0, maxActive: 0 };
  let queue = Promise.resolve();
  let seeded = false;
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
  if (!over.facet) {
    const inner = ports.updateMap;
    ports.updateMap = async (path, change) => {
      const written = await inner(path, change);
      if (seeded) return written;
      const doc = await repo.readMap(path);
      const read = model.readArgumentMap(doc);
      if (read.kind !== 'usable' || read.data.situation.data.length || read.data.situation.facets) return written;
      seeded = true;
      const planned = script.step.plan_situation({ proposition: '' }, 1);
      const items = [];
      const nodes = [];
      for (const d of planned.data) { const node = await ports.createNote({ kind: 'datum', title: d.need, summary: d.need }, doc, path); items.push({ id: node.id, need: d.need }); nodes.push(node); }
      await repo.updateMap(path, d => { for (const node of nodes) { node.parentId = read.data.roles.situation; node.x = 0; node.y = 0; d.nodes.push(node); } d.argumentMap = machine.applySituationData(model.readArgumentMap(d).data, items); });
      return written;
    };
  }
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

/** Default scripted steps of a facet-judged map (`rig({ facet: true })`): three facets of one need each, all supporting. */
const facetSteps = (over = {}) => ({
  plan_facets: () => ({ assumptions: { items: [{ label: 'Age band', value: '16 to 24', reason: 'the claim is about youth' }] }, facets: [{ title: 'Rate', needs: [{ need: 'unemployment rate' }] }, { title: 'Postings', needs: [{ need: 'job postings' }] }, { title: 'Hiring', needs: [{ need: 'junior hiring' }] }], causalQuestions: ['Why would it rise?'], question: 'Is youth unemployment rising?' }),
  judge_facets: request => ({
    data: request.facets.flatMap(f => f.data.map(d => ({ id: d.id, propStance: d.fixedStance ?? 'supports', reason: 'it fits' }))),
    facets: request.facets.map(f => ({ id: f.id, verdict: f.data.length ? 'supports' : 'insufficient', reason: 'enough', summary: `summary of ${f.title}`, citedData: f.data.length ? [f.data[0].id] : [], retryNeeds: [] })),
    assumptionInsights: ['The age band narrows the data']
  }),
  propose_facet_hypotheses: request => ({ hypotheses: Array.from({ length: request.count }, (_, i) => ({ title: `H${request.existing.length + i + 1}`, statement: `statement ${request.existing.length + i + 1}`, basis: 'because of the data', alternative: false, citedData: [request.data[0].id] })) }),
  add_needs: () => ({ needs: [{ text: 'need one' }, { text: 'need two' }] }),
  revise: () => ({ needs: [{ text: 'next one' }] }),
  verdict_facets: request => ({ verdict: 'supported', citedNeeds: [request.input.evidence[0].id], reason: 'enough', insights: [{ kind: 'consistent', text: 'the sources agree' }] }),
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

test('B3: situation research carries the assumptions as its scope; an old map (no assumptions) sends a need without a context key', async () => {
  assert.equal(assumptionScope({ situation: { data: [] } }), undefined);
  assert.equal(assumptionScope({ situation: { data: [], assumptions: { id: 'as', items: [] } } }), undefined);
  assert.equal(assumptionScope({ situation: { data: [], assumptions: { id: 'as', items: [{ label: 'Age band', value: '16 to 24, 2023 to 2024', reason: 'r' }, { label: 'Unemployed', value: 'ILO definition', reason: 'r' }] } } }), 'Age band: 16 to 24, 2023 to 2024; Unemployed: ILO definition');
  const r = await rig({ script: { step: steps() } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  assert.ok(r.stat.ask.length > 0);
  for (const ctx of r.stat.ask) assert.equal('context' in ctx.argumentEvidenceNeeds[0], false);
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

test('one corrective retry: a refused step succeeds the second time; failing twice pauses with error (the facet plan; the old plan step is removed)', async () => {
  const flaky = facetSteps({ plan_facets: (_request, n) => { if (n === 1) throw new ArgumentStepError('bad reply'); return facetSteps().plan_facets(); } });
  const r = await rig({ facet: true, script: { step: flaky } });
  await r.runs.start(r.mapPath, 'p');
  assert.equal(r.stat.steps.filter(n => n === 'plan_facets').length, 2);
  assert.equal((await r.state()).run.phase, 'concluded');
  const broken = await rig({ facet: true, script: { step: facetSteps({ plan_facets: () => { throw new ArgumentStepError('bad reply'); } }) } });
  await broken.runs.start(broken.mapPath, 'p');
  const state = await broken.state();
  assert.equal(broken.stat.steps.filter(n => n === 'plan_facets').length, 2);
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
  assert.ok(state.run.researchCalls <= 78);
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

// ---- provider failure is not a try (ticket 04): a rejected askModel never becomes found or not_found ---------------------------
const reply = (ctx, entry) => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [entry] });
const notFound = ctx => reply(ctx, { need: ctx.argumentEvidenceNeeds[0].id, status: 'not_found' });
const okAnswer = ctx => reply(ctx, foundEntry(ctx.argumentEvidenceNeeds[0].id));
/** 'unemployment rate' answers not_found once, then rejects like a 3-minute timeout; the other datum is found. */
const replayAsk = (counts, after = () => { throw new Error('timeout'); }) => async ctx => {
  if (ctx.task !== 'unemployment rate') return okAnswer(ctx);
  counts.n = (counts.n ?? 0) + 1;
  return counts.n === 1 ? notFound(ctx) : after(ctx, counts.n);
};
const datum = (state, need) => state.situation.data.find(d => d.need === need);

test('timeout is not a try: a datum whose provider call rejects twice pauses with error, never stopped_mismatch/data_missing', async () => {
  const counts = {};
  const r = await rig({ script: { step: steps(), ask: replayAsk(counts) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.status, 'paused');
  assert.equal(state.run.stopReason, 'error');
  assert.equal(state.run.phase, 'situation');
  assert.equal(state.situation.gate.state, 'pending');
  const d = datum(state, 'unemployment rate');
  assert.equal(d.state, 'pending');
  assert.equal(d.attempts, 1);
  assert.notEqual(d.state, 'found');
  assert.equal(d.proof, undefined);
  assert.equal(r.stat.steps.includes('judge_gate'), false);
  assert.equal(state.situation.gate.kind, undefined);
  assert.equal(state.run.researchCalls, r.stat.ask.length, 'researchCalls stays honest');
  assert.equal(datum(state, 'job postings').state, 'found', 'a sibling result in the failing batch is committed');
  assert.ok(r.stat.logs.some(l => l.includes('result=provider_failure')));
  assert.equal(r.runs.isRunning(r.mapPath), false);
});

test('timeout never becomes found: while the failing datum is pending the gate is never asked', async () => {
  const counts = {};
  const r = await rig({ script: { step: steps({ judge_gate: () => { throw new Error('gate must not run'); } }), ask: replayAsk(counts) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.ok(state.situation.data.every(d => d.state !== 'searching'));
  assert.equal(datum(state, 'unemployment rate').proof, undefined);
  assert.equal(datum(state, 'unemployment rate').state, 'pending');
  assert.equal(r.stat.steps.filter(n => n === 'judge_gate').length, 0);
});

test('timeout of an evidence need: rejecting twice pauses with error, the need stays pending, no revise', async () => {
  const r = await rig({ script: { step: steps(), ask: ctx => { if (ctx.task.startsWith('need')) throw new Error('timeout'); return okAnswer(ctx); } } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.status, 'paused');
  assert.equal(state.run.stopReason, 'error');
  assert.equal(state.run.phase, 'analysis');
  const needs = state.hypotheses.flatMap(h => h.needs);
  assert.ok(needs.length > 0 && needs.every(n => n.state === 'pending' && !n.proof));
  assert.ok(state.hypotheses.every(h => h.round === 1));
  assert.equal(r.stat.steps.includes('revise'), false);
  assert.equal(state.run.researchCalls, r.stat.ask.length);
});

test('one retry absorbs a single provider failure: the run concludes with no pause and researchCalls counts both calls', async () => {
  let failed = false;
  const r = await rig({ script: { step: steps(), ask: ctx => { if (ctx.task === 'job postings' && !failed) { failed = true; throw new Error('timeout'); } return okAnswer(ctx); } } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  assert.equal(state.run.stopReason, undefined);
  assert.equal(state.run.researchCalls, 2 + 6 + 1);
  assert.equal(state.run.researchCalls, r.stat.ask.length);
  assert.equal(r.stat.logs.some(l => l.includes('paused stopReason')), false);
});

test('answered not_found twice still ends as data_missing (a genuine miss is not a provider failure)', async () => {
  const r = await rig({ script: { step: steps(), ask: notFound } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal(state.situation.gate.kind, 'data_missing');
});

test('after the error pause a reload makes no call; resume re-asks only the released datum and the run completes', async () => {
  const counts = {};
  let mode = 'fail';
  const r = await rig({ script: { step: steps(), ask: replayAsk(counts, ctx => { if (mode === 'fail') throw new Error('timeout'); return okAnswer(ctx); }) } });
  await r.runs.start(r.mapPath, 'p');
  const asked = r.stat.ask.length;
  const again = new ArgumentRuns(r.ports);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(again.isRunning(r.mapPath), false);
  assert.equal(r.stat.ask.length, asked, 'no auto rerun after reload');
  mode = 'ok';
  await again.resume(r.mapPath);
  const reasked = r.stat.ask.slice(asked).map(c => c.argumentEvidenceNeeds[0].id);
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  const d1 = datum(state, 'unemployment rate').id;
  const d2 = datum(state, 'job postings').id;
  assert.ok(reasked.includes(d1));
  assert.equal(reasked.includes(d2), false, 'a found item was redone');
  assert.ok(r.stat.steps.includes('judge_gate'));
});

test('after release a resume that answers not_found ends as data_missing and the next resume is refused as finished', async () => {
  const counts = {};
  let mode = 'fail';
  const r = await rig({ script: { step: steps(), ask: replayAsk(counts, ctx => { if (mode === 'fail') throw new Error('timeout'); return notFound(ctx); }) } });
  await r.runs.start(r.mapPath, 'p');
  mode = 'miss';
  await r.runs.resume(r.mapPath);
  const state = await r.state();
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal(state.situation.gate.kind, 'data_missing');
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e instanceof ArgumentRunError && e.code === 'finished');
});

test('stale: a rejection arriving after the user Stop writes nothing and the pause reason stays user', async () => {
  const gate = defer();
  const r = await rig({ script: { step: steps(), ask: async ctx => { if (ctx.task === 'unemployment rate') { await gate.promise; throw new Error('timeout'); } return okAnswer(ctx); } } });
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 2) await tick();
  await r.runs.stop(r.mapPath);
  await started;
  const before = JSON.stringify(await r.state());
  assert.equal(JSON.parse(before).run.stopReason, 'user');
  gate.resolve();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(JSON.stringify(await r.state()), before);
  assert.equal(r.stat.logs.some(l => l.includes('provider_failure')), false);
});

test('stale: a provider failure after the user Stop (rejecting late) writes nothing', async () => {
  let rejectLate;
  const late = new Promise((_, reject) => { rejectLate = reject; });
  late.catch(() => undefined);
  const r = await rig({ script: { step: steps(), ask: async ctx => { if (ctx.task === 'unemployment rate') await late; return okAnswer(ctx); } } });
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 2) await tick();
  await r.runs.stop(r.mapPath);
  await started;
  const before = JSON.stringify(await r.state());
  rejectLate(new Error('timeout'));
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(JSON.stringify(await r.state()), before);
  assert.equal(JSON.parse(before).run.stopReason, 'user');
});

test('dispose: a provider failure after dispose writes nothing', async () => {
  let rejectLate;
  const late = new Promise((_, reject) => { rejectLate = reject; });
  late.catch(() => undefined);
  const r = await rig({ script: { step: steps(), ask: async () => { await late; } } });
  const started = r.runs.start(r.mapPath, 'p');
  while (r.stat.ask.length < 1) await tick();
  r.runs.dispose();
  const snapshot = r.contents.get(r.mapPath);
  rejectLate(new Error('timeout'));
  await started;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(r.contents.get(r.mapPath), snapshot);
});

test('persistent timeout with repeated resumes ends at the research limit (stopped_limit), never idle in running; a further resume is refused as finished', async () => {
  const r = await rig({ script: { step: steps(), ask: ctx => { if (ctx.task === 'unemployment rate') throw new Error('timeout'); return okAnswer(ctx); } } });
  await r.runs.start(r.mapPath, 'p');
  for (let i = 0; i < 60; i++) {
    if ((await r.state()).run.status !== 'paused') break;
    await r.runs.resume(r.mapPath);
  }
  const state = await r.state();
  assert.equal(state.run.phase, 'stopped_limit');
  assert.equal(state.run.status, 'finished');
  assert.equal(state.run.stopReason, 'limit');
  assert.ok(state.run.researchCalls <= 78);
  assert.equal(state.run.researchCalls, r.stat.ask.length);
  assert.equal(r.stat.steps.includes('judge_gate'), false);
  assert.equal(r.runs.isRunning(r.mapPath), false);
  await assert.rejects(() => r.runs.resume(r.mapPath), e => e instanceof ArgumentRunError && e.code === 'finished');
});

test('failure counter resets after an answer: reject, not_found, reject, found concludes with no pause', async () => {
  const counts = {};
  const r = await rig({ script: { step: steps(), ask: async ctx => {
    if (ctx.task !== 'unemployment rate') return okAnswer(ctx);
    counts.n = (counts.n ?? 0) + 1;
    if (counts.n === 1 || counts.n === 3) throw new Error('timeout');
    return counts.n === 2 ? notFound(ctx) : okAnswer(ctx);
  } } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  assert.equal(state.run.stopReason, undefined);
  assert.equal(state.run.researchCalls, r.stat.ask.length);
  assert.equal(r.stat.logs.some(l => l.includes('paused stopReason')), false);
});

test('failures are counted per item, not summed: every situation datum rejects once then answers found, no pause', async () => {
  const seen = new Set();
  const r = await rig({ script: { step: steps(), ask: ctx => {
    if (ctx.task.startsWith('need')) return okAnswer(ctx);
    if (!seen.has(ctx.task)) { seen.add(ctx.task); throw new Error('timeout'); }
    return okAnswer(ctx);
  } } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  assert.equal(state.run.stopReason, undefined);
  assert.equal(state.run.researchCalls, r.stat.ask.length);
});

test('worst-case AI call count shown before a run is 122', () => {
  assert.equal(WORST_CASE_AI_CALLS, 122);
});

// ---- P5: the facet-judged map wired into the runner ----
const aiReply = (entries, evidence = {}) => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [], ...evidence }, argumentEvidence: entries });
const needOf = ctx => ctx.argumentEvidenceNeeds[0];
const notFoundEntry = (id, note) => ({ need: id, status: 'not_found', ...(note ? { note } : {}) });
/** A judge that supports every facet holding a relevant datum and marks the others insufficient (with `retry(facet, n)` as their retry needs). */
const judgeBy = (log, retry = () => []) => (request, n) => {
  log.push(plain(request));
  const stance = d => d.fixedStance ?? 'supports';
  return {
    data: request.facets.flatMap(f => f.data.map(d => ({ id: d.id, propStance: stance(d), reason: 'it fits' }))),
    facets: request.facets.map(f => {
      const good = f.data.filter(d => stance(d) === 'supports');
      return { id: f.id, verdict: good.length ? 'supports' : 'insufficient', reason: 'SECRET-REASON-TEXT', summary: `summary of ${f.title}`, citedData: good.length ? [good[0].id] : [], retryNeeds: good.length ? [] : retry(f, n) };
    }),
    assumptionInsights: ['The age band narrows the data']
  };
};
const askByNeed = byText => ctx => { const need = needOf(ctx); return (byText[need.text] ?? (() => aiReply([foundEntry(need.id)])))(need, ctx); };
const rowsOf = async r => (await r.state()).situation.data;

test('P5: a new map plans by facets and never calls the old plan step; every card id is its state id', async () => {
  const r = await rig({ facet: true, script: { step: facetSteps() } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const state = await r.state();
  assert.ok(r.stat.steps.includes('plan_facets'));
  assert.ok(!r.stat.steps.includes('plan_situation'));
  assert.equal(state.situation.question, 'Is youth unemployment rising?');
  const byId = new Map((await r.repo.readMap(r.mapPath)).nodes.map(n => [n.id, n]));
  assert.equal(state.situation.facets.length, 3);
  assert.equal(byId.get(state.situation.assumptions.id).parentId, state.roles.situation);
  for (const f of state.situation.facets) {
    assert.equal(byId.get(f.id)?.parentId, state.roles.situation, `facet ${f.id}`);
    assert.equal(f.summary, `summary of ${f.title}`);
  }
  for (const d of state.situation.data) assert.equal(byId.get(d.id)?.parentId, d.facetId, `datum ${d.id}`);
  assert.equal(state.run.phase, 'concluded');
});

test('P5: a pause between the facet judgement and its checkpoint leaves no verdicts and no retry needs; resume asks the judge again', async () => {
  const log = [];
  const holder = {};
  let first = true;
  const judge = judgeBy(log, () => ['one more search']);
  const r = await rig({ facet: true, script: { step: facetSteps({ judge_facets: async (request, n) => {
    const out = judge(request, n);
    if (first) { first = false; void holder.runs.stop(holder.mapPath); await tick(); }
    return out;
  } }), ask: askByNeed({ 'job postings': need => aiReply([notFoundEntry(need.id)]), 'junior hiring': need => aiReply([notFoundEntry(need.id)]) }) } });
  holder.runs = r.runs; holder.mapPath = r.mapPath;
  await r.runs.start(r.mapPath, 'p');
  let state = await r.state();
  assert.equal(state.run.status, 'paused');
  assert.equal(state.situation.data.length, 3, 'no half retry batch');
  assert.ok(state.situation.facets.every(f => f.verdict === 'pending'));
  assert.equal((await r.repo.readMap(r.mapPath)).nodes.length, 5 + 1 + 3 + 3);
  await r.runs.resume(r.mapPath);
  state = await r.state();
  assert.equal(log.length >= 2, true, 'the judge was asked again');
  assert.ok(state.situation.facets.every(f => f.verdict !== 'pending'));
  assert.ok(state.situation.data.length > 3, 'the retry batch is written with the verdicts');
});

test('P5: a round-1 retry with no retry needs ends data_insufficient (not not_matching); the stop log has the kind and no text', async () => {
  const log = [];
  const r = await rig({ facet: true, script: { step: facetSteps({ judge_facets: judgeBy(log) }), ask: askByNeed({ 'job postings': need => aiReply([notFoundEntry(need.id)]), 'junior hiring': need => aiReply([notFoundEntry(need.id)]) }) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(state.run.phase, 'stopped_mismatch');
  assert.equal(state.situation.gate.kind, 'data_insufficient');
  assert.equal(state.run.stopReason, 'data_missing');
  assert.equal((await r.text(state.roles.conclusion)).summary, translate('zh-TW', 'ui.argument_stopped_insufficient'));
  const lines = r.stat.logs.filter(l => l.startsWith('argument-run stopped'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /gateKind=data_insufficient$/);
  assert.ok(!r.stat.logs.join('\n').includes('SECRET-REASON-TEXT'));
});

test('P5: round 2 judges only the facets still insufficient, carries a fixed stance, and the retry needs become cards under their facet', async () => {
  const log = [];
  const r = await rig({ facet: true, script: {
    step: facetSteps({ judge_facets: judgeBy(log, (f, n) => (n === 1 ? [`${f.title} again`] : [])) }),
    ask: askByNeed({ 'unemployment rate': (need) => aiReply([foundEntry(need.id, { stance: 'uncertain' })]), 'job postings': need => aiReply([notFoundEntry(need.id)]) })
  } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].facets.map(f => f.title), ['Rate', 'Postings', 'Hiring']);
  assert.deepEqual(log[1].facets.map(f => f.title), ['Rate', 'Postings'], 'the supported facet is not asked again');
  assert.equal(log[1].round, 2);
  const rate = log[1].facets.find(f => f.title === 'Rate');
  assert.ok(rate.data.some(d => d.fixedStance === 'irrelevant'), 'the uncertain answer keeps its fixed stance');
  assert.deepEqual(log[1].facets.find(f => f.title === 'Postings').notFoundNeeds, ['job postings']);
  const byId = new Map((await r.repo.readMap(r.mapPath)).nodes.map(n => [n.id, n]));
  const retried = state.situation.data.filter(d => d.need.endsWith('again'));
  assert.equal(retried.length, 2);
  for (const d of retried) assert.equal(byId.get(d.id)?.parentId, d.facetId);
  assert.equal(state.run.phase, 'concluded');
});

test('P5: on a facet map an uncertain answer with a verified source is found/irrelevant; with a bad source it is not_found(source_*); an old map keeps stance_uncertain', async () => {
  const bad = await rig({ facet: true, script: { step: facetSteps(), ask: askByNeed({ 'unemployment rate': need => aiReply([foundEntry(need.id, { stance: 'uncertain', url: 'https://bad.example.org/x' })]), 'job postings': need => aiReply([foundEntry(need.id, { stance: 'uncertain' })]) }) },
    ports: { fetch: async request => ({ status: 200, headers: { 'content-type': 'text/html' }, text: request.url.includes('bad.example') ? '<html><body>nothing relevant</body></html>' : PAGE, url: request.url }) } });
  await bad.runs.start(bad.mapPath, 'p');
  const data = await rowsOf(bad);
  const rate = data.find(d => d.need === 'unemployment rate');
  assert.equal(rate.state, 'not_found');
  assert.match(rate.reason, /^source_/);
  assert.equal(rate.stance, undefined);
  const postings = data.find(d => d.need === 'job postings');
  assert.equal(postings.state, 'found');
  assert.equal(postings.propStance, 'irrelevant');
  assert.equal(postings.stance, undefined);
  assert.ok(postings.proof.url);

  const old = await rig({ script: { step: steps(), ask: askByNeed({ 'unemployment rate': need => aiReply([foundEntry(need.id, { stance: 'uncertain' })]) }) } });
  await old.runs.start(old.mapPath, 'p');
  const first = (await rowsOf(old)).find(d => d.need === 'unemployment rate');
  assert.equal(first.state, 'not_found');
  assert.equal(first.reason, 'stance_uncertain');
});

test('P5: a facet map asks the facet-hypotheses and facet-verdict steps and keeps basis and insights; a blank basis is refused', async () => {
  const r = await rig({ facet: true, script: { step: facetSteps({ verdict_facets: request => ({ verdict: 'supported', citedNeeds: [request.input.evidence[0].id], reason: 'enough', insights: [{ kind: 'tension', text: 'x'.repeat(400) }] }) }) } });
  await r.runs.start(r.mapPath, 'p');
  const state = await r.state();
  assert.ok(r.stat.steps.includes('propose_facet_hypotheses') && r.stat.steps.includes('verdict_facets'));
  assert.ok(!r.stat.steps.includes('propose_hypotheses') && !r.stat.steps.includes('verdict'));
  assert.deepEqual(plain(state.situation.assumptions.insights), ['The age band narrows the data']);
  for (const h of state.hypotheses) {
    assert.equal(h.basis, 'because of the data');
    assert.deepEqual(plain(h.insights), [{ kind: 'tension', text: 'x'.repeat(300) }]);
  }
  const blank = await rig({ facet: true, script: { step: facetSteps({ propose_facet_hypotheses: request => ({ hypotheses: Array.from({ length: request.count }, (_, i) => ({ title: `H${i}`, statement: `s${i}`, basis: ' ', alternative: false, citedData: [request.data[0].id] })) }) }) } });
  await blank.runs.start(blank.mapPath, 'p');
  const refused = await blank.state();
  assert.equal(refused.hypotheses.length, 0);
  assert.equal(refused.run.status, 'paused');
  assert.equal(refused.run.stopReason, 'error');
});

test('P5: a figure is kept on the proof and the search log of a miss (queries, pages, reason and note, capped) is stored on data and needs', async () => {
  const figure = { number: '9.2', period: 'March 2024', unit: 'percent' };
  const long = 'q'.repeat(250);
  const missing = need => aiReply([notFoundEntry(need.id, 'the page had no table')], { searchQueries: ['a', 'b', 'c', 'd', 'e', long, 'g'], openedUrls: ['https://one.example.org/', 'https://two.example.org/'] });
  const r = await rig({ facet: true, script: { step: facetSteps(), ask: askByNeed({ 'unemployment rate': need => aiReply([foundEntry(need.id, { figure })]), 'job postings': missing }) } });
  await r.runs.start(r.mapPath, 'p');
  const data = await rowsOf(r);
  assert.deepEqual(plain(data.find(d => d.need === 'unemployment rate').proof.figure), figure);
  const log = data.find(d => d.need === 'job postings').searchLog;
  assert.equal(log.queries.length, 5);
  assert.ok(log.queries.every(q => q.length <= 200));
  assert.deepEqual(plain(log.opened), ['https://one.example.org/', 'https://two.example.org/']);
  assert.ok(log.why.includes('not_found') && log.why.includes('the page had no table') && log.why.length <= 200);
  assert.equal(data.find(d => d.need === 'unemployment rate').searchLog, undefined);

  const old = await rig({ script: { step: steps({ add_needs: (_request, n) => ({ needs: n === 1 ? [{ text: 'dead source' }, { text: 'live two' }] : [{ text: 'need one' }, { text: 'need two' }] }) }),
    ask: askByNeed({ 'dead source': need => aiReply([notFoundEntry(need.id, 'nothing')], { searchQueries: ['dead query'], openedUrls: [] }) }) } });
  await old.runs.start(old.mapPath, 'p');
  const dead = (await old.state()).hypotheses.flatMap(h => h.needs).find(n => n.text === 'dead source');
  assert.equal(dead.state, 'not_found');
  assert.deepEqual(plain(dead.searchLog), { queries: ['dead query'], opened: [], why: 'not_found: nothing' });
});

test('P5: the research cap and the worst-case call count follow the constants (78 research calls, 122 AI calls)', () => {
  assert.equal(model.MAX_RESEARCH_CALLS, 78);
  assert.equal(WORST_CASE_AI_CALLS, model.MAX_RESEARCH_CALLS + 1 + 2 + 4 + 36 + 1);
  assert.equal(WORST_CASE_AI_CALLS, 122);
});

// ---- P6: notes of a facet map; an old map's notes stay as V1 wrote them ---------------------------------------------------------------
test('P6: a facet map writes facet, datum, situation, definitions, hypothesis and conclusion notes; research detail never reaches a note', async () => {
  const fig = (id, n) => foundEntry(id, { figure: { number: n, period: '2026-07', unit: '%' } });
  let n = 0;
  const r = await rig({ facet: true, script: { step: facetSteps(), ask: ctx => ({ summary: 's', detail: 'SECRET-DETAIL-TEXT', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [fig(ctx.argumentEvidenceNeeds[0].id, String(++n))] }) } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const state = await r.state();
  assert.equal(state.run.phase, 'concluded');
  const doc = await r.repo.readMap(r.mapPath);
  const core = '### 核心結論';
  const facetNote = await r.text(state.situation.facets[0].id);
  assert.ok(facetNote.detail.startsWith(core) && facetNote.detail.includes('判定：支持命題') && facetNote.detail.includes('| 數據 |'));
  const datumNote = await r.text(state.situation.data[0].id);
  assert.ok(datumNote.detail.startsWith(core) && datumNote.detail.includes(URL_OK));
  assert.ok((await r.text(state.roles.situation)).detail.includes('個面向中有'));
  assert.ok((await r.text(state.situation.assumptions.id)).detail.includes('The age band narrows the data'));
  assert.ok((await r.text(state.hypotheses[0].id)).detail.includes('成立的原因') && (await r.text(state.hypotheses[0].id)).detail.includes('the sources agree'));
  const conclusion = await r.text(state.roles.conclusion);
  assert.ok(conclusion.detail.includes('final answer') && conclusion.detail.includes('### 依據的假設') && conclusion.detail.includes('### 現況依據'));
  for (const node of doc.nodes) assert.ok(!(await r.repo.readNote(node.path)).detail?.includes('SECRET-DETAIL-TEXT'), node.id);
});

test('P6: an old (non-facet) map keeps the V1 note text byte for byte', async () => {
  const r = await rig({ script: { step: steps() } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const state = await r.state();
  const conclusion = await r.text(state.roles.conclusion);
  const claim = 'Rate rose';
  const src = `- ${claim}「${QUOTE}」（${URL_OK}）`;
  assert.equal(conclusion.detail, ['- point', '', '## 依據的現況數據', src, '', '## 來源', src, src, src, src, src, src].join('\n'));
  const datum = await r.text(state.situation.data[0].id);
  assert.equal(datum.detail, ['## 來源', src].join('\n'));
});

// ---- P7: re-run with the owner's definitions -------------------------------------------------------------------------------------------
test('P7: start with presetAssumptions sends them in the facet-plan request and the assumption card shows them; without it the request has none', async () => {
  const preset = [{ label: 'Age', value: '30 to 40', reason: 'owner edited' }];
  const seen = [];
  const r = await rig({ facet: true, script: { step: facetSteps({ plan_facets: request => { seen.push(plain(request)); return facetSteps().plan_facets(); } }) } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising', { presetAssumptions: preset });
  assert.deepEqual(seen[0].presetAssumptions, preset);
  const plain0 = await rig({ facet: true, script: { step: facetSteps({ plan_facets: request => { seen.push(plain(request)); return facetSteps().plan_facets(); } }) } });
  await plain0.runs.start(plain0.mapPath, 'Youth unemployment is rising');
  assert.equal('presetAssumptions' in seen[1], false);
});
test('P8: the preset assumptions are saved in the map, so a re-run paused before the facet plan still uses them on resume; a bad saved preset makes the map unusable', async () => {
  const preset = [{ label: 'Age', value: '30 to 40', reason: 'owner edited' }];
  const seen = [];
  const holder = {};
  let first = true;
  const r = await rig({ facet: true, script: { step: facetSteps({ plan_facets: async request => {
    seen.push(plain(request));
    if (first) { first = false; void holder.runs.stop(holder.mapPath); await tick(); }
    return facetSteps().plan_facets();
  } }) } });
  holder.runs = r.runs; holder.mapPath = r.mapPath;
  await r.runs.start(r.mapPath, 'Youth unemployment is rising', { presetAssumptions: preset });
  const paused = await r.state();
  assert.equal(paused.run.status, 'paused');
  assert.equal(paused.situation.facets, undefined, 'paused before the facet plan was written');
  assert.deepEqual(plain(paused.run.presetAssumptions), preset, 'saved in the map');
  await r.runs.resume(r.mapPath);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].presetAssumptions, preset, 'the resumed plan request still carries them');
  const map = await r.repo.readMap(r.mapPath);
  for (const bad of [[{ label: 'a', value: 'b' }], 'x', [{ label: '', value: 'v', reason: 'r' }], []]) {
    const copy = JSON.parse(JSON.stringify(map));
    copy.argumentMap.run.presetAssumptions = bad;
    assert.equal(model.readArgumentMap(copy).kind, 'unusable', JSON.stringify(bad));
  }
});
test('P7: re-running on a new map leaves the original Map.md byte-identical', async () => {
  const r = await rig({ facet: true, script: { step: facetSteps() } });
  await r.runs.start(r.mapPath, 'Youth unemployment is rising');
  const before = r.contents.get(r.mapPath);
  assert.ok(before && before.length > 0);
  const second = await r.repo.createMap('Argument again');
  assert.notEqual(second, r.mapPath);
  await r.runs.start(second, 'Youth unemployment is rising', { presetAssumptions: [{ label: 'Age', value: '30 to 40', reason: 'owner edited' }] });
  assert.equal(r.contents.get(r.mapPath), before);
  assert.equal(model.readArgumentMap(await r.repo.readMap(second)).kind, 'usable');
});
