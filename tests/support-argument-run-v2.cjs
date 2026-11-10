// Shared rig for the runner v2 tests (packet V5a): fake ports over the real repository fixture. The provider, fetch and step runner are fakes;
// nothing here proves live provider behaviour.
const S = require('./support.cjs');
const { translate } = S.load('i18n.ts');
const run = S.load('experiences/visual-map/argument-run-v2.ts');
const model = S.load('core/argument-map/model.ts');

const QUOTE = 'Youth unemployment rose to 9.2 percent in March';
const URL_OK = 'https://stats.example.org/report';
const PAGE = `<html><body><p>${QUOTE}, the highest in a decade.</p></body></html>`;
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const foundEntry = (id, over = {}) => ({ need: id, status: 'found', stance: 'supports', claim: 'Rate rose', quote: QUOTE, url: URL_OK, ...over });
const GOOD = { relevant: true, stance: 'supports', scopeFit: true, scopeNote: '', sourceType: 'official', underlyingSource: 'agency', alsoRelevantTo: [] };

/** A locked breakdown: premises `premises` (label -> data needs), testable claims `testable` (label -> premise labels it rests on). */
function locked({ premises = { c1: ['rate'] }, testable = { c2: ['c1'] }, lockedAt = '2026-11-10T00:00:00.000Z' } = {}) {
  const claim = (id, role, dependsOn, dataNeeds) => ({ id, text: `claim ${id}`, type: 'fact', role, dependsOn, definitions: [], dataNeeds });
  return {
    framing: { original: 'Q', restatement: 'Is youth unemployment rising?', presuppositions: [], loadedTerms: [], vagueTerms: [], outOfScope: [], candidates: [{ id: 'q1', question: 'Q?', answerShape: 'yes or no', diff: '', kind: 'interpretation', unanswered: false }], chosen: 'q1', settings: [], attempts: 1, lockedAt },
    claims: [...Object.entries(premises).map(([id, needs]) => claim(id, 'premise', [], needs)), ...Object.entries(testable).map(([id, deps]) => claim(id, 'testable', deps, []))]
  };
}

/** Default scripted steps (by short step name). A fake returns the parsed output or throws. */
const steps = (over = {}) => ({
  assessment: request => ({ assessments: request.items.map(i => ({ id: i.id, assessment: { ...GOOD }, sameCondition: i.replaces ? true : null })) }),
  premise: request => { const usable = request.data.every(d => d.usable); return { result: usable ? 'holds' : 'insufficient', reason: 'data fit', citedData: usable ? request.data.map(d => d.id) : [] }; },
  hypotheses: request => ({ hypotheses: request.ids.slice(0, 2).map((id, i) => ({ id, role: 'facet', predictions: [{ id: `${id}-p1`, kind: 'support', text: `facet ${i + 1} holds`, required: true, alsoPredictedBy: [], auxiliary: [] }, { id: `${id}-p2`, kind: 'refute', text: `facet ${i + 1} fails`, required: false, alsoPredictedBy: [], auxiliary: [request.premises[0].id], reason: 'it would show the facet is absent' }] })) }),
  needs: request => ({ needs: request.hypothesis.predictions.filter(p => p.required).slice(0, request.max).map((p, i) => ({ id: request.ids[i], predictionId: p.id, text: `need for ${p.id}`, criteria: { supports: 's', refutes: 'r', irrelevant: 'i' } })) }),
  // stage 3 (V5b): the default verdict is `undecided` (a complete test nothing decides), the comparison completes with `insufficient`.
  verdict: request => ({ value: 'undecided', reason: 'no decisive result', citedNeeds: [], counterNotes: request.input.counterEvidence.map(() => 'note'), refutations: request.input.counterEvidence.map(needId => ({ needId, class: 'nondecisive', auxiliary: [] })), causal: 'not_applicable', assumptionStatus: [], confidence: 'low' }),
  comparison: () => ({ decision: 'complete', vetoes: [], allocations: [], rejudge: [], answer: 'insufficient' }),
  conclusion: request => ({ answers: request.input.claims.filter(c => c.evaluated).map(c => ({ claimId: c.id, answer: c.comparison.answer, sentence: `${c.text} cannot be settled`, assumptions: c.comparison.requiredAssumptions })) }),
  'inference-check': request => request.input.sentences.map(x => ({ id: x.id, status: 'ok' })),
  ...over
});

async function rig(over = {}) {
  const data = S.fixture('zh-TW', { linkIndex: true });
  const { repo } = data;
  const mapPath = await repo.createMap('Argument');
  const stat = { ask: [], steps: [], requests: [], notes: 0, undo: [], logs: [], fetches: 0 };
  let queue = Promise.resolve();
  const script = { step: steps(), ask: ctx => ({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }), ...over.script };
  if (over.script?.step) script.step = steps(over.script.step);
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: path => repo.readMap(path),
    updateMap: (path, change) => repo.updateMap(path, change),
    createNote: (input, map) => { stat.notes++; return repo.createNote(input.title, 'model-a', map, mapPath, 'workspace', { summary: input.summary, detail: input.detail, topicKind: input.kind === 'hypothesis' ? 'hypothesis' : input.kind === 'need' ? 'evidence' : input.kind === 'conclusion' ? 'conclusion' : 'topic' }); },
    readNote: path => repo.readNote(path),
    updateNote: (path, patch) => repo.updateNote(path, patch),
    askModel: async (ctx, _model, _reasoning, signal) => { stat.ask.push(ctx); return script.ask(ctx, stat.ask.length, signal); },
    runStep: async (step, request) => {
      const name = step.id.replace('argument-map.v2-', ''); stat.steps.push(name); stat.requests.push({ name, request: plain(request) });
      const fake = script.step[name];
      if (!fake) throw new Error(`no fake for ${name}`);
      return fake(request, stat.steps.filter(n => n === name).length);
    },
    fetch: async request => { stat.fetches++; return over.fetch ? over.fetch(request) : { status: 200, headers: { 'content-type': 'text/html' }, text: PAGE, url: request.url }; },
    parseHtml: html => html.replace(/<[^>]+>/g, ' '),
    now: () => '2026-11-10T00:00:00.000Z',
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    config: () => ({ model: 'model-a', reasoning: 'low', language: 'zh-TW' }),
    begin: () => { const controller = new AbortController(); return { signal: controller.signal, release: () => undefined }; },
    clearUndo: path => stat.undo.push(path),
    log: line => stat.logs.push(line),
    t: (key, ...values) => translate('zh-TW', key, ...values),
    ...over.ports
  };
  const runs = new run.ArgumentRunsV2(ports);
  const state = async () => model.readArgumentMap(await repo.readMap(mapPath)).data;
  const snapshot = async () => JSON.stringify(await repo.readMap(mapPath));
  return { ...data, runs, ports, stat, script, mapPath, state, snapshot, log: () => stat.logs.join('\n'), text: async id => repo.readNote((await repo.readMap(mapPath)).nodes.find(n => n.id === id).path) };
}

module.exports = { rig, locked, steps, run, model, QUOTE, URL_OK, GOOD, plain, tick, defer, foundEntry };
