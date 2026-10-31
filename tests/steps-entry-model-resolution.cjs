// MS-05 P5b: manual add-topic, AI outline generation, structure review and relevance grading take their model from the one
// resolution (plugin.currentModelChoice(), or repo.resolveTopicModel for a topic with a parent), never from settings directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
// The settings model and the resolved model differ on purpose: only the resolved one may reach a task.
const CURRENT = { model: 'claude-sonnet-5-5', reasoning: 'high' };

async function harness() {
  const { repo, app } = fixture('en');
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'settings-model-not-used', cliReasoning: 'low' };
  const doc = { id: 'map-a', title: 'A', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const calls = { prewarm: [], confirm: [], outline: [] };
  const plugin = withExpansionCoordinator({
    repo, settings: repo.settings, running: new Set(), mutate: async work => work(), releaseOutline() {},
    currentModelChoice: () => ({ ...CURRENT }),
    confirmAiUsage: async (model, run) => { calls.confirm.push(model); await run(); return true; },
    prewarmClaudeStep: (...args) => calls.prewarm.push(args),
    outlineGeneration: { generate: async request => { calls.outline.push(request); return { markdown: '# T\n', nodes: [] }; } }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = doc; view.render = () => {};
  return { repo, view, doc, plugin, calls };
}

async function addAndCaptureModel(h, parent) {
  let seen;
  h.repo.createNote = async (_title, model) => { seen = model; throw new Error('stop'); };
  await h.view.addNode(parent, 'Child', true, false).catch(error => assert.equal(error.message, 'stop'));
  return seen;
}

test('addNode with no parent uses the resolved current model, not settings.cliModel', async () => {
  const h = await harness();
  assert.equal(await addAndCaptureModel(h, null), CURRENT.model);
});

test('addNode under a manual parent inherits that parent model; under a non-manual parent it takes the current model', async () => {
  const h = await harness();
  const manual = await h.repo.createNote('Manual', 'gpt-x', h.doc, MAP, 'manual');
  h.doc.nodes.push(manual);
  const plain = await h.repo.createNote('Plain', 'settings-model-not-used', h.doc, MAP, 'workspace');
  h.doc.nodes.push(plain);
  assert.equal(await addAndCaptureModel(h, manual), 'gpt-x');
  const resolved = [];
  const resolve = h.repo.resolveTopicModel.bind(h.repo);
  h.repo.resolveTopicModel = async (...args) => { resolved.push(args[0]); return resolve(...args); };
  await addAndCaptureModel(h, plain);
  assert.deepEqual(resolved, [plain.path], 'a parented add goes through resolveTopicModel');
});

test('the AI outline generator sends the resolved model and reasoning', async () => {
  const h = await harness();
  await h.view.outlineGenerator('T').generate({ topic: 'T', presetText: 'p' }, new AbortController().signal, () => ({ topic: 'T', presetId: 'knowledge-tree', presetText: 'p', placement: 'tree', target: { map: 'editable' }, shallow: false, mode: 'quick' }));
  assert.equal(h.calls.outline[0].model, CURRENT.model);
  assert.equal(h.calls.outline[0].reasoning, CURRENT.reasoning);
  assert.deepEqual(h.calls.confirm, [CURRENT.model], 'the usage notice is asked for the same model');
});

test('relevance prewarm starts the resolved model and reasoning', async () => {
  const h = await harness();
  h.view.prewarmRelevance('grade');
  assert.equal(h.calls.prewarm[0][0], CURRENT.model);
  assert.equal(h.calls.prewarm[0][1], CURRENT.reasoning);
});

test('structure review and relevance grading read the one resolution (no direct settings model in those functions)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const body = (start, end) => { const from = source.indexOf(start); assert.ok(from >= 0, start); const to = source.indexOf(end, from); assert.ok(to > from, end); return source.slice(from, to); };
  const structure = body('  openStructureReview(scopeId', '  private reopenStructureReview(');
  assert.match(structure, /const \{ model, reasoning \} = this\.plugin\.currentModelChoice\(\)/);
  assert.doesNotMatch(structure, /settings\.cliModel|settings\.cliReasoning/);
  const grade = body('  private async submitRelevanceGoal(', '  private async applyRelevanceGrade(');
  assert.match(grade, /this\.plugin\.currentModelChoice\(\)/);
  assert.doesNotMatch(grade, /settings\.cliModel|settings\.cliReasoning/);
  assert.match(grade, /reasoning: gradeReasoning/);
});

test('share translation defaults to the one resolution (#27)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'main.ts'), 'utf8');
  const from = source.indexOf('translation: {'); assert.ok(from >= 0);
  const block = source.slice(from, source.indexOf('}', from));
  assert.match(block, /defaultModel: \(\) => this\.currentModelChoice\(\)\.model/);
  assert.match(block, /reasoning: \(\) => this\.currentModelChoice\(\)\.reasoning/);
  assert.doesNotMatch(block, /settings\.cliModel|settings\.cliReasoning/);
});
