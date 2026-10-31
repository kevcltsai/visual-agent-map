// MS-08 P8a: every shared progress stage text carries the model that really runs the task (D4: "{0} ({1})" in English,
// "{0}・{1}" in Chinese); the chart step shows the model of the task it belongs to; AIM resolves the branch root's model once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { ResearchProgressStore } = S.load('experiences/visual-map/research-progress.ts');
const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } }
);
const { t } = S.load('i18n.ts');
const view = () =>
  Object.assign(Object.create(VisualAgentMapView.prototype), { plugin: { modelLabel: id => `L:${id}` } });
const clock = { now: () => 0, setTimeout: () => 0, clearTimeout() {} };

test('the progress store keeps the model across stage, attempt and slow changes', () => {
  const store = new ResearchProgressStore(clock);
  store.begin('A.md', 'a1', 0, 'gpt-x');
  assert.equal(store.get('A.md').model, 'gpt-x');
  store.stage('A.md', 'a1', 'reading', 1);
  store.markSlow('A.md', 'a1', true, () => {});
  store.newAttempt('A.md', 'a2', 2);
  assert.equal(store.get('A.md').model, 'gpt-x');
  store.begin('B.md', 'b1', 0);
  assert.equal(store.get('B.md').model, undefined);
});

test('every stage text gains the model; an entry without one keeps the bare stage name', () => {
  const v = view();
  const base = { attemptId: 'a', startedAt: 0, stageAt: 0, slow: false };
  for (const stage of ['waiting', 'searching', 'reading', 'writing', 'charts']) {
    const bare = v.researchStageText({ ...base, stage });
    const withModel = v.researchStageText({ ...base, stage, model: 'm1' });
    assert.equal(withModel, t('ui.progress_stage_with_model_0_1', bare, 'L:m1'), stage);
    assert.ok(withModel.includes('L:m1'));
    assert.ok(!bare.includes('L:'));
  }
  assert.equal(v.researchStageText({ ...base, stage: 'searching', query: 'q', model: 'm1' }).includes('q'), true);
});

test('the progress formats follow decision #14 D4 in every language', () => {
  const text = file => read(file).match(/"ui\.progress_stage_with_model_0_1": "([^"]*)"/)?.[1];
  assert.equal(text('i18n/en.ts'), '{0} ({1})');
  assert.equal(text('i18n/zh-TW.ts'), '{0}・{1}');
  assert.equal(text('i18n/zh-CN.ts'), '{0}・{1}');
});

test('counterexample: the chart step shows "Adding diagrams" with the model of the task it belongs to', async () => {
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {}, workspace: { getLeavesOfType: () => [] } };
  plugin.logs = { appendLog() {} };
  plugin.mutate = async work => { await work(); };
  plugin.aiTasks = { chartEligible: () => true, chartDetail: () => new Promise(() => {}), failExchange() {} };
  plugin.addChartsAfterWrite({ path: 'A.md', context: { title: 'A' }, detail: 'body', model: 'claude:sonnet', apply: async () => true });
  const entry = plugin.researchProgress.get('A.md');
  assert.equal(entry.stage, 'charts');
  assert.equal(entry.model, 'claude:sonnet');
  assert.equal(view().researchStageText(entry), t('ui.progress_stage_with_model_0_1', t('ui.research_stage_charts'), 'L:claude:sonnet'));
  plugin.abortChartJobs('A.md');
});

test('startTaskProgress takes the task model and every call site passes the model that runs the task', () => {
  const source = read('experiences/visual-map/view.ts');
  const sites = [...source.matchAll(/this\.startTaskProgress\(([^;]*)\);/g)].map(m => m[1]);
  assert.equal(sites.length, 5);
  for (const site of sites) assert.match(site, /, (task\.model|note\.model|chosen\.model)$/, site);
  const progress = view();
  const store = new ResearchProgressStore(clock);
  progress.plugin.researchProgress = store;
  const started = progress.startTaskProgress('task:merge:M.md', 'm2');
  assert.equal(store.get('task:merge:M.md').model, 'm2');
  started.end();
  assert.equal(store.get('task:merge:M.md'), undefined);
});

test('AIM resolves the branch root model once per run and the stage text uses the cache', async () => {
  const calls = [];
  const v = Object.assign(view(), {
    closed: false,
    path: 'Map.md',
    map: {
      aim: { branches: [
        { id: 'b1', questionNodeId: 'q1', parentBranchId: null },
        { id: 'b2', questionNodeId: 'q2', parentBranchId: 'b1' }
      ] },
      nodes: [{ id: 'q1', path: 'Root.md' }, { id: 'q2', path: 'Child.md' }]
    },
    aimBranchModels: new Map(),
    aimBranchModelPending: new Set(),
    aimProgressEls: new Map(),
    aimBusy: true,
    render() {}
  });
  v.plugin.repo = { resolveTopicModel: async p => { calls.push(p); return { model: 'root-model' }; } };
  v.aimProgress = { branchId: 'b2', stage: 'research-plan', startedAt: Date.now(), targets: new Map() };
  v.ensureAimBranchModel('b2');
  v.ensureAimBranchModel('b2');
  await new Promise(resolve => setImmediate(resolve));
  v.ensureAimBranchModel('b2');
  assert.deepEqual(calls, ['Root.md']);
  const text = v.aimStageText();
  assert.ok(text.includes('L:root-model'), text);
  assert.ok(text.includes('0:0'), text);
});
