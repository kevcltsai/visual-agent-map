const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
function load(file) {
  const module = { exports: {} };
  vm.runInNewContext(buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text, { module, exports: module.exports, require, console, AbortController, setTimeout, clearTimeout });
  return module.exports;
}
const { validateMindSearchResearchPlan, researchContentHash } = load('experiences/mind-search/research-plan.ts');
const { scheduleMindSearchResearch } = load('experiences/mind-search/research-scheduler.ts');
const { MindSearchManualFlow, parseMindSearchResearchPlan } = load('experiences/mind-search/manual-flow.ts');
const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
const { parseMap, serializeMap } = load('map-model.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const answer = (summary, detail = summary) => ({ summary, detail, suggestions: [], visualReferences: [] });
const target = (id, dependsOn = []) => ({ id, title: `Target ${id}`, task: `Find evidence for ${id}`, expectedValue: `Resolve ${id}`, action: 'research', dependsOn });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const phase = context => context.task.match(/mindsearch-phase: ([a-z-]+)/)?.[1];

test('MindSearch planner accepts zero through five tasks and validates dependency graphs', () => {
  assert.equal(validateMindSearchResearchPlan([]).length, 0);
  assert.equal(validateMindSearchResearchPlan([target('only')]).length, 1);
  assert.equal(parseMindSearchResearchPlan(answer('No new tasks', '<!-- mindsearch-plan {"subtopics":[]} -->')).length, 0);
  assert.throws(() => validateMindSearchResearchPlan(Array.from({ length: 6 }, (_, n) => target(String(n)))), /0–5/);
  assert.throws(() => validateMindSearchResearchPlan([target('a', ['b'])]), /existing targets/);
  assert.throws(() => validateMindSearchResearchPlan([target('a', ['a'])]), /other than themselves/);
  assert.throws(() => validateMindSearchResearchPlan([target('a', ['b']), target('b', ['a'])]), /cycle/);
});

test('MindSearch scheduler caps independent work at two and passes actual completed dependency reports', async () => {
  const gates = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, deferred()]));
  const started = [], prerequisites = {}; let active = 0, max = 0;
  const work = scheduleMindSearchResearch([target('a'), target('b'), target('c', ['a']), target('d', ['b'])], async (item, reports) => {
    started.push(item.id); prerequisites[item.id] = Object.fromEntries(reports); max = Math.max(max, ++active);
    const result = await gates[item.id].promise; active--; return result;
  });
  await tick(); assert.deepEqual(started, ['a', 'b']);
  gates.b.resolve({ detail: 'Actual report B' }); await tick();
  assert.deepEqual(started, ['a', 'b', 'd']); assert.deepEqual(prerequisites.d, { b: { detail: 'Actual report B' } });
  gates.a.resolve({ detail: 'Actual report A' }); await tick();
  assert.deepEqual(started, ['a', 'b', 'd', 'c']); assert.deepEqual(prerequisites.c, { a: { detail: 'Actual report A' } });
  gates.c.resolve('C'); gates.d.resolve('D'); const reports = await work;
  assert.equal(reports.size, 4); assert.equal(max, 2);
});

test('MindSearch failed predecessor prevents dependent dispatch and failure waits for successful sibling', async () => {
  const first = deferred(), sibling = deferred(); const started = [], saved = []; let settled = false;
  const work = scheduleMindSearchResearch([target('a'), target('b'), target('c', ['a'])], async item => {
    started.push(item.id);
    const result = await (item.id === 'a' ? first.promise : sibling.promise); saved.push(item.id); return result;
  });
  const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
  await tick(); first.reject(new Error('failed A')); await tick();
  assert.equal(settled, false); assert.deepEqual(started, ['a', 'b']);
  sibling.resolve('Saved B'); assert.match((await observed).message, /failed A/); assert.deepEqual(saved, ['b']);
});

test('MindSearch cancellation aborts both active tasks and never starts a dependent', async () => {
  const controller = new AbortController(), started = [], stopped = [];
  const work = scheduleMindSearchResearch([target('a'), target('b'), target('c', ['a'])], (item, reports, signal) => new Promise((resolve, reject) => {
    started.push(item.id); signal.addEventListener('abort', () => { stopped.push(item.id); const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); });
  }), controller.signal);
  const rejection = assert.rejects(work, { name: 'AbortError' });
  await tick(); controller.abort(); await rejection;
  assert.deepEqual(started, ['a', 'b']); assert.deepEqual(stopped, ['a', 'b']);
});

test('MindSearch legacy saved plans run serially without dependency metadata', async () => {
  const gates = [deferred(), deferred()], started = [];
  const plan = ['a', 'b'].map(id => { const item = target(id); delete item.dependsOn; delete item.action; return item; });
  const work = scheduleMindSearchResearch(plan, async item => { started.push(item.id); return gates[item.id === 'a' ? 0 : 1].promise; });
  await tick(); assert.deepEqual(started, ['a']); gates[0].resolve('A'); await tick();
  assert.deepEqual(started, ['a', 'b']); gates[1].resolve('B'); await work;
});

function fixture({ plan = [target('a')], ancestor = true, conditions = { weight: '1kg' }, sourceDetail = 'Research status: search completed\nFull method, limits and dated source https://example.org/method' } = {}) {
  let sequence = 0;
  const node = (id, kind, parentId = null) => ({ id, path: `${id}.md`, parentId, mindSearchKind: kind, x: 0, y: 0, collapsed: false });
  const branch = (id, questionNodeId, parentBranchId, supplied) => ({ id, questionNodeId, parentBranchId, answerSnapshot: { selections: [], freeText: 'Known' }, inputSnapshot: { topic: 'Prepare a meal', conditions: supplied, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [] });
  let map = { version: 1, id: 'research-fixture', title: 'Prepare a meal', nodes: [node('topic', 'topic'), node('question', 'question', 'topic')], viewport: { x: 0, y: 0, zoom: 1 }, mindSearch: { version: 1, branches: [], runs: [], pendingCommits: [] } };
  const notes = new Map([['topic.md', answer('Prepare a meal', 'Find a feasible method with a dated source')], ['question.md', answer('Preferred method?', 'Use the supplied condition')]]);
  for (const [path, value] of notes) notes.set(path, { ...value, title: path, status: 'completed' });
  const current = branch('current', 'question', ancestor ? 'ancestor' : null, conditions);
  if (plan !== undefined) current.researchPlan = plain(plan);
  map.mindSearch.branches.push(current);
  let source;
  if (ancestor) {
    const prior = branch('ancestor', 'prior-question', null, { weight: '1kg' });
    map.nodes.push(node('prior-question', 'question', 'topic'), node('source', 'research', 'prior-question'));
    notes.set('prior-question.md', { title: 'Prior question', ...answer('Weight?', 'Prior user condition'), status: 'completed' });
    notes.set('source.md', { title: 'Original method', ...answer('A fully supported method', sourceDetail), status: 'completed' });
    const ref = { resultId: 'original-result', runId: 'original-run', attemptId: 'attempt-1', nodeId: 'source', notePath: 'source.md', version: 1, kind: 'research' };
    prior.results.push(ref); map.mindSearch.branches.push(prior);
    map.mindSearch.runs.push({ id: 'original-run', branchId: prior.id, currentAttemptId: 'attempt-1', attempts: [{ id: 'attempt-1', inputSnapshotHash: 'prior', status: 'completed' }] });
    source = { branchId: prior.id, resultId: ref.resultId, notePath: ref.notePath, version: ref.version, contentHash: researchContentHash(notes.get(ref.notePath)) };
  }
  const repository = {
    settings: { language: 'en' }, readMap: async () => plain(map), saveMap: async (path, value) => { map = parseMap(serializeMap(value)); },
    readNote: async path => { if (!notes.has(path)) throw new Error(`Missing ${path}`); return plain(notes.get(path)); },
    updateNote: async (path, patch) => { if (!notes.has(path)) throw new Error(`Missing ${path}`); notes.set(path, { ...notes.get(path), ...plain(patch) }); },
    createNoteAt: async (title, model, doc, path, origin, notePath, id, patch) => { notes.set(notePath, { title, summary: '', detail: '', status: 'idea', ...plain(patch) }); },
    topicFolder: () => 'Notes', topicRoot: () => '.', ensureTopicFolders: async () => {}, unique: (folder, title) => `${folder}/${++sequence}-${title}.md`, hasNote: path => notes.has(path)
  };
  const store = new MindSearchRunStore(repository, () => `fixture-${++sequence}`);
  return { repository, store, notes, source, current, getMap: () => plain(map), setPlan: async value => { const next = plain(map); if (value === undefined) delete next.mindSearch.branches[0].researchPlan; else next.mindSearch.branches[0].researchPlan = value; await repository.saveMap('Map.md', next); } };
}
const reuseTarget = source => ({ ...target('reuse'), title: 'Applicable method', action: 'reuse', source, rationale: 'The method is already established', validity: { conditionKeys: ['weight'], reason: 'Weight remains the same and source is current' } });
const usable = answer('Applicable', '<!-- mindsearch-reuse {"usable":true,"rationale":"The full evidence supports this method","conditionKeys":["weight"],"validity":"Dated method remains applicable to this weight"} -->');
const stopAtReview = context => { if (phase(context) === 'report-review') throw new Error('STOP_AT_REVIEW'); throw new Error(`Unexpected phase ${phase(context)}`); };

test('MindSearch valid ancestor evidence is copied with provenance and no new web search before review', async () => {
  const subject = fixture(); await subject.setPlan([reuseTarget(subject.source)]); const phases = [];
  const flow = new MindSearchManualFlow(subject.repository, subject.store, async context => {
    phases.push(phase(context));
    if (phase(context) === 'evidence-reuse-audit') { assert.ok(context.task.includes(subject.notes.get('source.md').detail)); assert.equal(context.researchMode, 'local'); return usable; }
    return stopAtReview(context);
  });
  await assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
  const map = subject.getMap(), saved = map.mindSearch.branches[0].results;
  assert.equal(saved.length, 1); assert.equal(saved[0].kind, 'research'); assert.equal(saved[0].reuse.sourceResultId, 'original-result');
  assert.equal(saved[0].reuse.sourceContentHash, subject.source.contentHash); assert.deepEqual(saved[0].reuse.applicableConditions, { weight: '1kg' }); assert.ok(Date.parse(saved[0].reuse.checkedAt));
  assert.notEqual(saved[0].notePath, 'source.md'); assert.equal(subject.notes.get(saved[0].notePath).detail, subject.notes.get('source.md').detail);
  assert.deepEqual(phases, ['evidence-reuse-audit', 'report-review']);
});

test('MindSearch zero-task plan materializes audited reuse before persistence and can reopen its report', async () => {
  const subject = fixture(); await subject.setPlan(undefined); const phases = [];
  const ask = async context => { phases.push(phase(context)); if (phase(context) === 'research-plan') return answer('No new research', '<!-- mindsearch-plan {"subtopics":[]} -->'); if (phase(context) === 'evidence-reuse-audit') return usable; return stopAtReview(context); };
  const flow = new MindSearchManualFlow(subject.repository, subject.store, ask);
  await assert.rejects(flow.retryAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
  const saved = subject.getMap().mindSearch.branches[0];
  assert.equal(saved.researchPlan.length, 1); assert.equal(saved.researchPlan[0].action, 'reuse'); assert.equal(saved.results[0].subtopicId, saved.researchPlan[0].id);
  const previous = phases.length;
  const reopened = new MindSearchManualFlow(subject.repository, subject.store, ask);
  await assert.rejects(reopened.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
  assert.deepEqual(phases.slice(previous), ['report-review']);
});

test('MindSearch zero-task plan without evidence fails before saving the plan or terminal review', async () => {
  const subject = fixture({ ancestor: false }); await subject.setPlan(undefined); const phases = [];
  const flow = new MindSearchManualFlow(subject.repository, subject.store, async context => { phases.push(phase(context)); return answer('Empty', '<!-- mindsearch-plan {"subtopics":[]} -->'); });
  await assert.rejects(flow.retryAnswerResearch('Map.md', 'current', 'test', 'low'), /requires usable ancestor evidence/);
  assert.equal(subject.getMap().mindSearch.branches[0].researchPlan, undefined); assert.deepEqual(phases, ['research-plan']);
});

test('MindSearch update targets use the exact prior report and restrict new research to changed claims', async () => {
  const subject = fixture({ conditions: { weight: '2kg' } }); const item = { ...reuseTarget(subject.source), action: 'update', task: 'Update cooking time for the changed 2kg weight only' };
  await subject.setPlan([item]); const phases = [];
  const flow = new MindSearchManualFlow(subject.repository, subject.store, async context => {
    phases.push(phase(context));
    if (phase(context) === 'subtopic-research') {
      assert.match(context.task, /Update only changed or unresolved claims/); assert.match(context.task, /Update cooking time for the changed 2kg weight only/);
      assert.ok(context.task.includes(subject.notes.get('source.md').detail)); assert.match(context.task, /Earlier conditions: \{"weight":"1kg"\}/); assert.match(context.task, /Current conditions: \{"weight":"2kg"\}/);
      return answer('Updated time', 'Research status: search completed\nAdjusted cooking time https://example.org/update');
    }
    return stopAtReview(context);
  });
  await assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
  assert.deepEqual(phases, ['subtopic-research', 'report-review']); assert.equal(subject.getMap().mindSearch.branches[0].results[0].reuse, undefined);
});

for (const rejection of ['changed-source', 'missing-source', 'changed-condition', 'failed-freshness']) {
  test(`MindSearch rejects ${rejection} reuse and researches the same target afresh`, async () => {
    const subject = fixture({ conditions: rejection === 'changed-condition' ? { weight: '2kg' } : { weight: '1kg' } }); await subject.setPlan([reuseTarget(subject.source)]);
    if (rejection === 'changed-source') subject.notes.set('source.md', { ...subject.notes.get('source.md'), detail: 'CHANGED_REPORT_UNSAFE_TO_COPY' });
    if (rejection === 'missing-source') subject.notes.delete('source.md');
    const phases = [];
    const flow = new MindSearchManualFlow(subject.repository, subject.store, async context => {
      phases.push(phase(context));
      if (phase(context) === 'evidence-reuse-audit') return answer('Not reusable', '<!-- mindsearch-reuse {"usable":false,"rationale":"Source is stale","conditionKeys":[],"validity":"New verification required"} -->');
      if (phase(context) === 'subtopic-research') { assert.equal(context.mindSearchIsolatedResearch, true); assert.match(context.task, /Copying earlier evidence was rejected/); assert.ok(!context.task.includes('CHANGED_REPORT_UNSAFE_TO_COPY')); return answer('Fresh method', 'Research status: search completed\nFRESH_TARGET_EVIDENCE https://example.org/fresh'); }
      return stopAtReview(context);
    });
    await assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
    const saved = subject.getMap().mindSearch.branches[0].results[0]; assert.equal(saved.reuse, undefined); assert.match(subject.notes.get(saved.notePath).detail, /FRESH_TARGET_EVIDENCE/);
    assert.equal(phases.filter(item => item === 'subtopic-research').length, 1);
  });
}

test('MindSearch pipeline saves independent successes, then dependency receives the actual stored predecessor report', async () => {
  const subject = fixture({ ancestor: false, plan: [target('a'), target('b'), target('c', ['a'])] }); const gate = deferred(); const started = [];
  const flow = new MindSearchManualFlow(subject.repository, subject.store, async context => {
    if (phase(context) === 'subtopic-research') {
      const id = context.task.match(/Research task: Find evidence for ([abc])/)[1]; started.push(id);
      if (id === 'b') await gate.promise;
      if (id === 'c') { assert.match(context.task, /Actual stored A/); assert.equal(subject.getMap().mindSearch.branches[0].results.some(result => result.subtopicId === 'a'), true); }
      return answer(`Result ${id}`, `Research status: search completed\nActual stored ${id.toUpperCase()} https://example.org/${id}`);
    }
    return stopAtReview(context);
  });
  const work = flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'); const rejected = assert.rejects(work, /STOP_AT_REVIEW/);
  for (let count = 0; !started.includes('c') && count < 30; count++) await tick();
  assert.deepEqual(started, ['a', 'b', 'c']); gate.resolve(); await rejected;
  assert.equal(subject.getMap().mindSearch.branches[0].results.length, 3);
});

test('MindSearch real flow drains a successful sibling on predecessor failure and resumes only missing targets', async () => {
  const subject = fixture({ ancestor: false, plan: [target('a'), target('b'), target('c', ['a'])] });
  const failed = deferred(), saved = deferred(); let settled = false; const started = [];
  const first = new MindSearchManualFlow(subject.repository, subject.store, async context => {
    assert.equal(phase(context), 'subtopic-research');
    const id = context.task.match(/Research task: Find evidence for ([abc])/)[1]; started.push(id);
    await (id === 'a' ? failed.promise : saved.promise);
    return answer('Saved B', 'Research status: search completed\nPersisted B https://example.org/b');
  });
  const result = first.resumeAnswerResearch('Map.md', 'current', 'test', 'low').then(() => { settled = true; }, error => { settled = true; return error; });
  await tick(); failed.reject(new Error('Provider failed A')); await tick(); assert.equal(settled, false); assert.deepEqual(started, ['a', 'b']);
  saved.resolve(); assert.match((await result).message, /Provider failed A/);
  const after = subject.getMap(); assert.deepEqual(after.mindSearch.branches[0].results.map(item => item.subtopicId), ['b']); assert.equal(after.mindSearch.runs.some(run => run.attempts.some(item => item.status === 'failed')), true);
  const retryCalls = [];
  const retry = new MindSearchManualFlow(subject.repository, subject.store, async context => {
    if (phase(context) === 'subtopic-research') { const id = context.task.match(/Research task: Find evidence for ([abc])/)[1]; retryCalls.push(id); return answer(`Retry ${id}`, `Research status: search completed\nRetry evidence ${id} https://example.org/${id}`); }
    return stopAtReview(context);
  });
  await assert.rejects(retry.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
  assert.deepEqual(retryCalls, ['a', 'c']); assert.equal(subject.getMap().mindSearch.branches[0].results.length, 3);
});

test('MindSearch real flow cancellation stops both active searches and records cancelled attempts', async () => {
  const subject = fixture({ ancestor: false, plan: [target('a'), target('b'), target('c', ['a'])] }), controller = new AbortController();
  const started = [], stopped = [];
  const flow = new MindSearchManualFlow(subject.repository, subject.store, context => new Promise((resolve, reject) => {
    const id = context.task.match(/Research task: Find evidence for ([abc])/)[1]; started.push(id);
    context.signal.addEventListener('abort', () => { stopped.push(id); const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error); });
  }));
  const rejection = assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low', controller.signal), { name: 'AbortError' });
  for (let count = 0; started.length < 2 && count < 20; count++) await tick();
  controller.abort(); await rejection; assert.deepEqual(started, ['a', 'b']); assert.deepEqual(stopped, ['a', 'b']);
  const map = subject.getMap(); assert.equal(map.mindSearch.branches[0].results.length, 0); assert.deepEqual(map.mindSearch.runs.map(run => run.attempts.at(-1).status), ['cancelled', 'cancelled']);
});
