// MS-06: a model picked for one run (multi-topic research, the topic dialog) is used for that run only and is never
// written to a topic as an override; "pin" is the one explicit way to write it. P6a covers the pass-through of the
// run-once choice (research, expansion, synthesis, the progress model, the multi-research batch). The dialog menus
// (P6b) and the outline import window (P6c) are covered further down in this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const frontmatterOf = text => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
/** The three lines that decide which model a topic runs on; they must not move when a model is only used once. */
const modelLines = text => frontmatterOf(text).split('\n').filter(line => /^(model|model-source|reasoning-level):/.test(line)).join('\n');

/** A real view over a fake vault; askModel records the model and reasoning each call received. */
async function harness(topics, plugin = {}) {
  const { repo, app, contents } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const nodes = [];
  for (const [title, model, source, reasoning] of topics) {
    const created = await repo.createNote(title, model, mapDoc, MAP, source, reasoning ? { reasoning } : {});
    mapDoc.nodes.push(created);
    nodes.push(created);
  }
  await repo.saveMap(MAP, mapDoc);
  const calls = [], confirms = [], progress = [];
  const reply = { summary: 'S', detail: 'D', visualReferences: [], suggestions: [{ title: 'Child', task: 'Explore', contribution: '', parentTitle: '' }] };
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(),
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {},
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [],
    mutate: async work => work(),
    confirmAiUsage: async (model, run) => { confirms.push(model); await run(); return true; },
    researchProgress: { get: () => undefined, begin: (_key, _id, _at, model) => progress.push(model), newAttempt() {}, stage() {}, preview() {}, markSlow() {}, end() {} },
    askModel: async (context, model, reasoning, _signal, _exchange, accepted) => { calls.push({ mode: context.mode, model, reasoning }); accepted?.(); return reply; },
    ...plugin
  });
  repo.settings = host.settings;
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app }, host);
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate: async () => {}, ancestorContext: async () => '', queueCharts() {} });
  const raw = node => contents.get(node.path);
  return { repo, view, host, nodes, calls, confirms, progress, raw };
}
const research = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };

test('counterexample 1: multi-topic research with a picked model leaves every topic model-source untouched and asks that model', async () => {
  const h = await harness([['A', 'gpt-6-luna', 'workspace'], ['B', 'model-b', 'manual', 'high'], ['C', 'gpt-6-luna', 'inherited']]);
  const before = h.nodes.map(node => modelLines(h.raw(node)));
  const whole = h.nodes.map(node => h.raw(node).match(/^model-source:.*$/m)?.[0]);
  h.view.multiSelected = new Set(h.nodes.map(node => node.id));
  await h.view.startMultiResearch({ requirements: '', model: 'claude:sonnet', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
  await until(() => h.calls.length === 3);
  assert.deepEqual(h.calls.map(call => call.model), ['claude:sonnet', 'claude:sonnet', 'claude:sonnet'], 'overridden topics use it too (D4)');
  assert.deepEqual(h.confirms, ['claude:sonnet'], 'the usage notice asks only about the picked model');
  await until(() => h.view.plugin.expansionBatches.get(`multi-research:${MAP}`)?.status === 'completed');
  assert.deepEqual(h.nodes.map(node => modelLines(h.raw(node))), before, 'model, model-source and reasoning-level are byte for byte what they were');
  assert.deepEqual(h.nodes.map(node => h.raw(node).match(/^model-source:.*$/m)?.[0]), whole);
});

test('multi-topic research without a picked model keeps each topic on its own model', async () => {
  const h = await harness([['A', 'gpt-6-luna', 'workspace'], ['B', 'model-b', 'manual', 'high']]);
  h.view.multiSelected = new Set(h.nodes.map(node => node.id));
  await h.view.startMultiResearch({ requirements: '', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
  await until(() => h.calls.length === 2);
  assert.deepEqual(h.calls.map(call => [call.model, call.reasoning]).sort(), [['gpt-6-luna', 'low'], ['model-b', 'high']]);
});

test('a run-once choice reaches the research call, its reasoning and the progress model; the topic keeps its own override', async () => {
  const h = await harness([['A', 'model-b', 'manual', 'high']]);
  const before = modelLines(h.raw(h.nodes[0]));
  await h.view.runAgent(h.nodes[0], undefined, undefined, { task: 'go', ...research }, undefined, { model: 'claude:sonnet', reasoning: 'medium' });
  await until(() => h.calls.length === 1);
  assert.deepEqual(h.calls[0], { mode: 'task', model: 'claude:sonnet', reasoning: 'medium' });
  assert.equal(h.progress[0], 'claude:sonnet', 'the progress line names the model that really runs');
  await until(() => !h.host.running.has(h.nodes[0].path));
  assert.equal(modelLines(h.raw(h.nodes[0])), before);
});

test('a run-once model without reasoning uses the current model reasoning; no run-once uses the topic own model', async () => {
  const h = await harness([['A', 'model-b', 'manual', 'high']]);
  await h.view.runAgent(h.nodes[0], undefined, undefined, { task: 'go', ...research }, undefined, { model: 'claude:sonnet' });
  await until(() => !h.host.running.has(h.nodes[0].path));
  await h.view.runAgent(h.nodes[0], undefined, undefined, { task: 'go', ...research });
  await until(() => h.calls.length === 2 && !h.host.running.has(h.nodes[0].path));
  assert.deepEqual(h.calls.map(call => [call.model, call.reasoning]), [['claude:sonnet', 'low'], ['model-b', 'high']]);
});

test('expansion proposals ask the run-once model and write nothing to the topic', async () => {
  const h = await harness([['A', 'model-b', 'manual', 'high']]);
  const before = modelLines(h.raw(h.nodes[0]));
  await h.view.proposeChildren(h.nodes[0], { ...research, runOnce: { model: 'claude:sonnet', reasoning: 'medium' } }, '', () => {}, message => assert.fail(message));
  assert.deepEqual(h.calls.map(call => [call.mode, call.model, call.reasoning]), [['decompose', 'claude:sonnet', 'medium']]);
  assert.equal(modelLines(h.raw(h.nodes[0])), before);
});

test('the synthesis directions step asks the run-once model', async () => {
  const h = await harness([['P', 'model-b', 'manual', 'high']]);
  const child = await h.repo.createNote('Kid', 'gpt-6-luna', h.view.map, MAP, 'workspace');
  child.parentId = h.nodes[0].id; h.view.map.nodes.push(child); await h.repo.saveMap(MAP, h.view.map);
  const failures = [];
  await h.view.startSynthesis(h.nodes[0], { ...research, runOnce: { model: 'claude:sonnet', reasoning: 'medium' } }, null, message => failures.push(message), () => {});
  assert.deepEqual(failures, []);
  assert.deepEqual(h.calls.map(call => [call.mode, call.model, call.reasoning]), [['synthesize', 'claude:sonnet', 'medium']]);
});

test('the stale check still compares the note itself: a run-once model does not make the result stale', async () => {
  const done = [];
  const h = await harness([['A', 'model-b', 'manual', 'high']]);
  await h.view.runAgent(h.nodes[0], result => done.push(result), message => assert.fail(message), { task: 'go', ...research }, undefined, { model: 'claude:sonnet', reasoning: 'medium' });
  await until(() => done.length === 1);
  assert.equal(done.length, 1);
});


// ---- P6c: the outline import window --------------------------------------------------------------------------------
const modalFor = (over = {}) => {
  const Modal = dom.makeModal();
  const mod = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal, Notice: class {} } });
  const requests = [], created = [], labels = [];
  const generator = { presets: { settings: { language: 'en', promptPresets: [] }, async saveSettings() {} }, initialTopic: 'Sleep', generate: async (request, _signal, started) => { requests.push(request); started(); return '# Sleep\n## A\n'; } };
  const modal = new mod.OutlineImportModal({}, async request => { created.push(request); },
    { list: () => [{ id: 'm1', label: 'Model One' }], watch: () => () => {} }, [], { map: 'editable', selected: { id: 'n1', title: 'Sleep' } }, 'tree', generator, {}, [], '',
    over.defaultModelLabel ?? (async parentId => { labels.push(parentId); return parentId ? 'Follow upper topic (gpt-x)' : 'Follow current model (cur)'; }));
  modal.open();
  const model = () => dom.find(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Model');
  const radio = value => dom.find(modal.contentEl, i => i.tag === 'input' && i.type === 'radio' && i.value === value);
  const choose = value => { radio(value).checked = true; radio(value).fire('change'); };
  return { modal, model, choose, labels, requests, created };
};
test('counterexample 6: the default model label follows the import position and target, live', async () => {
  const m = modalFor();
  await dom.tick();
  assert.equal(m.model().children[0].text, 'Follow current model (cur)');
  m.choose('under'); await dom.tick();
  assert.equal(m.model().children[0].text, 'Follow upper topic (gpt-x)', 'a topic with a manual upper topic shows its model');
  m.choose('tree'); await dom.tick();
  assert.equal(m.model().children[0].text, 'Follow current model (cur)');
  assert.deepEqual(m.labels, [null, 'n1', null], 'the host is asked with the parent topic, or null for a new tree');
  assert.equal(m.model().children[0].value, '', 'the default entry still means "no pick"');
});
test('a slow label answer for an earlier position never overwrites the latest one', async () => {
  const waits = new Map();
  const m = modalFor({ defaultModelLabel: parentId => new Promise(resolve => waits.set(parentId, () => resolve(parentId ? 'under' : 'tree'))) });
  m.choose('under'); await dom.tick();
  waits.get('n1')(); waits.get(null)(); await dom.tick();
  assert.equal(m.model().children[0].text, 'under', 'the answer for the last position wins, whatever order they arrive in');
});
test('AI outline generation gets the picked model only when the research option shows it; no pick leaves the request model-free', async () => {
  const m = modalFor();
  const generate = () => dom.button(dom.find(m.modal.contentEl, i => i.tag === 'details' && dom.hasCls(i, 'vam-outline-ai')), 'Generate outline');
  generate().click(); await dom.tick();
  assert.equal('model' in m.requests[0], false);
  const picked = modalFor();
  picked.model().value = 'm1'; picked.model().fire('change');
  const gen = () => dom.button(dom.find(picked.modal.contentEl, i => i.tag === 'details' && dom.hasCls(i, 'vam-outline-ai')), 'Generate outline');
  gen().click(); await dom.tick();
  assert.equal('model' in picked.requests[0], false, 'research option unchecked: the hidden menu is not used');
  const shown = modalFor();
  dom.find(shown.modal.contentEl, i => i.type === 'checkbox' && dom.hasCls(i.parent ?? {}, 'vam-outline-check')).checked = true;
  shown.model().value = 'm1'; shown.model().fire('change');
  dom.button(dom.find(shown.modal.contentEl, i => i.tag === 'details' && dom.hasCls(i, 'vam-outline-ai')), 'Generate outline').click(); await dom.tick();
  assert.equal(shown.requests[0].model, 'm1');
});
test('the view generator runs the picked model once with the current reasoning and asks usage for it; without a pick the current model', async () => {
  const h = await harness([['Old root', 'parent-model', 'manual', 'high']]);
  const calls = [];
  h.host.outlineGeneration = { generate: async request => { calls.push(request); return { markdown: '# T\n', nodes: [] }; } };
  h.host.currentModelChoice = () => ({ model: 'cur-x', reasoning: 'medium' });
  const inputs = () => ({ topic: 'T', presetId: 'p', presetText: 'p', placement: 'tree', target: { map: 'editable' }, shallow: false, mode: 'quick' });
  const generator = h.view.outlineGenerator('T');
  await generator.generate({ topic: 'T', presetText: 'p', model: 'm1' }, new AbortController().signal, inputs);
  await generator.generate({ topic: 'T', presetText: 'p' }, new AbortController().signal, inputs);
  assert.deepEqual(calls.map(c => [c.model, c.reasoning]), [['m1', 'medium'], ['cur-x', 'medium']]);
  assert.deepEqual(h.confirms, ['m1', 'cur-x']);
  assert.equal(h.repo.settings.cliModel, 'gpt-6-luna', 'nothing is saved');
});
test('the host default label: the current model unless the target topic resolves to an override', async () => {
  const h = await harness([['Manual root', 'gpt-x', 'manual', 'high'], ['Plain root', 'gpt-6-luna', 'workspace']]);
  h.host.modelLabel = id => `L:${id}`;
  h.host.settings.cliModel = 'cur-x';
  h.host.currentModelChoice = () => ({ model: 'cur-x', reasoning: 'low' });
  assert.equal(await h.view.outlineModelLabel(null), 'Follow current model (L:cur-x)');
  assert.equal(await h.view.outlineModelLabel(h.nodes[0].id), 'Follow upper topic (L:gpt-x)');
  assert.equal(await h.view.outlineModelLabel(h.nodes[1].id), 'Follow current model (L:cur-x)');
});
test('merging with no upper topic uses the current model choice, not a direct read of the settings', async () => {
  const h = await harness([['Root', 'gpt-6-luna', 'workspace']]);
  h.host.currentModelChoice = () => ({ model: 'cur-x', reasoning: 'high' });
  assert.deepEqual({ ...await h.view.mergeModel(null) }, { model: 'cur-x', reasoning: 'high' });
});
