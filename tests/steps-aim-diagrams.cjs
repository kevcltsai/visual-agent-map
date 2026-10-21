// Diagram step for AIM conclusions: the final conclusion detail goes through the chart step once, the
// "Add diagrams after research" setting turns the step off everywhere, and a stop leaves the conclusion unwritten.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');

const { AimManualFlow } = S.load('experiences/aim/manual-flow.ts');
const { AimRunStore } = S.load('experiences/aim/research-run-store.ts');
const { createAimMap } = S.load('experiences/aim/create-map.ts');
const { AiTaskService } = S.load('core/ai-task-service.ts');
const root = path.join(__dirname, '..');
const MODEL = 'gpt-6-luna';
const CHART = '```mermaid\nflowchart TD\n  A-->B\n```';

async function conclude(configure) {
  const data = S.fixture();
  const model = S.coverageModel();
  const created = await createAimMap(data.repo, MODEL, { requestId: 'diagram-flow', topic: 'diagram', context: 'Initial clarification: known background.', minimumAnswersBeforeConclusion: 3, outcomeExpectation: { goal: 'execute', description: '', formats: ['steps', 'table'] } });
  const repo = new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' });
  const flow = new AimManualFlow(repo, new AimRunStore(repo), (context, ...rest) => model.ask(context, ...rest));
  configure(flow);
  let question = (await flow.planNextQuestion(created.mapPath, created.root.id, MODEL, 'low', 'q')).node;
  let outcome;
  for (let round = 1; round <= 3; round++) {
    outcome = await flow.answerAndResearch(created.mapPath, question.id, { requestId: `a-${round}`, selections: [question.aimQuestion.options[0].id], freeText: `Specific condition ${round}` }, MODEL, 'low');
    if (round < 3) question = (await repo.readMap(created.mapPath)).nodes.find(node => node.id === outcome.questionNodeId);
  }
  const map = await repo.readMap(created.mapPath);
  const refs = map.aim.branches.flatMap(branch => branch.results).filter(result => result.kind === 'conclusion');
  const details = [];
  for (const ref of refs) details.push((await repo.readNote(ref.notePath)).detail);
  return { outcome, details };
}

test('AIM conclusion: the chart step runs on the final detail only, once', async () => {
  const seen = [];
  const baseline = await conclude(() => {});
  const charted = await conclude(flow => {
    flow.addDiagrams = async request => {
      seen.push(request);
      return `${request.detail}\n\n${CHART}`;
    };
  });
  assert.equal(baseline.outcome.status, 'completed');
  assert.equal(baseline.details.length, 1);
  assert.doesNotMatch(baseline.details[0], /```mermaid/);
  assert.equal(seen.length, 1, 'one chart step per conclusion, none for interim notes or the gap audit');
  assert.ok(seen[0].detail.trim() && seen[0].model === MODEL && seen[0].language && seen[0].title);
  assert.equal(charted.details.length, 1);
  assert.ok(charted.details[0].includes(CHART));
});

test('AIM conclusion: an unchanged detail from the chart step is byte-identical to no chart step', async () => {
  const baseline = await conclude(() => {});
  const same = await conclude(flow => {
    flow.addDiagrams = async request => request.detail;
  });
  assert.deepEqual(same.details, baseline.details);
});

test('AIM conclusion: a stop during the chart step leaves the conclusion unwritten', async () => {
  const data = await conclude(flow => {
    flow.addDiagrams = async () => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    };
  }).then(
    () => ({ ok: true }),
    error => ({ ok: false, error })
  );
  assert.equal(data.ok, false);
  assert.equal(data.error.name, 'AbortError');
});

test('addDiagramsToDetail: off returns the detail with no model call; on calls the chart step; a stop rethrows', async () => {
  const calls = [];
  const runtime = {
    runTask: async (prompt, model, effort, schema, controls) => {
      calls.push({ effort, controls });
      return JSON.stringify({ charts: [{ anchor: 'The larva stage lasts 3 days.', shape: 'stages', mermaid: 'timeline\n  title T\n  3 days : Larva' }] });
    }
  };
  const make = enabled =>
    new AiTaskService({
      pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
      exchangeLoggingEnabled: () => false, exchanges: () => null,
      codexRuntime: () => runtime, claudeRuntime: () => runtime,
      mermaidParses: async () => true,
      ...(enabled === undefined ? {} : { diagramsEnabled: () => enabled })
    });
  const detail = 'The larva stage lasts 3 days.\n\nSecond paragraph.';
  const request = { title: 'T', detail, language: 'en', model: 'claude:sonnet' };
  assert.equal(await make(false).addDiagramsToDetail(request), detail);
  assert.equal(calls.length, 0, 'off: no model call');
  for (const service of [make(true), make(undefined)]) {
    calls.length = 0;
    const out = await service.addDiagramsToDetail(request);
    assert.match(out, /```mermaid\ntimeline/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].effort, 'low');
    assert.equal(calls[0].controls.webSearch, false);
  }
  const controller = new AbortController();
  const stopping = { runTask: async () => { controller.abort(); throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); } };
  const stoppable = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => stopping, claudeRuntime: () => stopping, mermaidParses: async () => true
  });
  await assert.rejects(stoppable.addDiagramsToDetail({ ...request, signal: controller.signal }), error => error.name === 'AbortError');
});

test('setting: default on, old data.json loads as on, and the gates and call sites are wired', () => {
  const { DEFAULT_SETTINGS } = S.load('repository.ts', { obsidian: { App: class {}, TFile: class {}, TFolder: class {}, normalizePath: value => value, parseYaml: () => ({}), stringifyYaml: () => '' } });
  assert.equal(DEFAULT_SETTINGS.addDiagramsAfterResearch, true);
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('main.ts'), /addDiagramsAfterResearch: saved\?\.addDiagramsAfterResearch !== false/);
  assert.match(read('main.ts'), /diagramsEnabled: \(\) => this\.settings\.addDiagramsAfterResearch/);
  assert.match(read('ui/settings-tab.ts'), /this\.plugin\.settings\.addDiagramsAfterResearch = value/);
  assert.match(read('core/ai-task-service.ts'), /input\.addCharts &&\s+this\.diagramsOn\(\)/);
  assert.match(read('experiences/visual-map/view.ts'), /aimManual\.addDiagrams = /);
  assert.match(read('experiences/visual-map/view.ts'), /aimRecovery\.addDiagrams = /);
  const flow = read('experiences/aim/manual-flow.ts');
  assert.equal(flow.match(/await this\.concludedDetail\(finalReview, /g)?.length, 3, 'every conclusion write path');
  assert.doesNotMatch(flow, /[^c] this\.concludedDetail\(finalReview\)/);
});

test('setting off: a normal task with addCharts is not eligible and makes no chart call; on makes one, after askModel', async () => {
  const run = async enabled => {
    let count = 0;
    const runtime = { runTask: async () => (++count === 1 ? JSON.stringify({ summary: 'S', detail: 'The larva stage lasts 3 days.', suggestions: [], visualReferences: [] }) : JSON.stringify({ charts: [] })) };
    const service = new AiTaskService({
      pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
      exchangeLoggingEnabled: () => false, exchanges: () => null,
      codexRuntime: () => runtime, claudeRuntime: () => runtime, diagramsEnabled: () => enabled
    });
    const input = { title: 'T', summary: '', rules: '', detail: '', task: 'do', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'auto', outputLanguage: 'en', addCharts: true };
    const result = await service.askModel(input, 'claude:sonnet', 'low');
    assert.equal(count, 1, 'askModel itself never runs the chart step');
    assert.equal(service.chartEligible(input), enabled);
    if (service.chartEligible(input)) await service.chartDetail({ input, detail: result.detail, model: 'claude:sonnet' });
    return count;
  };
  assert.equal(await run(false), 1);
  assert.equal(await run(true), 2);
});

test('progress: the add-diagrams stage is emitted when the step runs and not when diagrams are off', async () => {
  const stages = [];
  const on = await conclude(flow => {
    flow.onProgress = event => event.kind === 'stage' && stages.push(event.stage);
    flow.addDiagrams = async request => {
      request.onStart?.();
      return request.detail;
    };
  });
  assert.equal(on.outcome.status, 'completed');
  assert.equal(stages.filter(stage => stage === 'add-diagrams').length, 1);
  assert.ok(stages.indexOf('add-diagrams') > -1);
  stages.length = 0;
  await conclude(flow => {
    flow.onProgress = event => event.kind === 'stage' && stages.push(event.stage);
    flow.addDiagrams = async request => request.detail; // what the plugin does when the setting is off: onStart is never called
  });
  assert.ok(!stages.includes('add-diagrams'));
  // The real service: onStart fires once when on, never when off.
  const runtime = { runTask: async () => JSON.stringify({ charts: [] }) };
  for (const [enabled, expected] of [[true, 1], [false, 0]]) {
    let started = 0;
    const service = new AiTaskService({
      pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
      exchangeLoggingEnabled: () => false, exchanges: () => null,
      codexRuntime: () => runtime, claudeRuntime: () => runtime, diagramsEnabled: () => enabled
    });
    await service.addDiagramsToDetail({ title: 'T', detail: 'Para.', language: 'en', model: 'claude:sonnet', onStart: () => started++ });
    assert.equal(started, expected);
  }
  assert.match(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'), /"add-diagrams": "ui\.aim_stage_add-diagrams"/);
});
