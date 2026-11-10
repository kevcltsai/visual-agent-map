const assert = require('node:assert/strict');
const { test, integrationTest, load, core, plain, obsidian, DEFAULT_SETTINGS, normalizeReasoningLevel, fixture, TFile } = require('../support.cjs');
const dom = require('../support-dom.cjs');
test('model inheritance distinguishes CLI default from absent parent and copies once', () => {
  assert.equal(core.inheritModel(undefined, 'root-model'), 'root-model');
  assert.equal(core.inheritModel('', 'root-model'), '');
  let parent = 'parent-model'; const child = core.inheritModel(parent, 'root-model'); parent = 'changed';
  assert.equal(child, 'parent-model');
});
test('workspace defaults to the configured low-cost model and low reasoning', () => {
  assert.equal(DEFAULT_SETTINGS.cliModel, 'gpt-5.6-luna');
  assert.equal(DEFAULT_SETTINGS.cliReasoning, 'low');
  assert.equal(DEFAULT_SETTINGS.codexPath, 'codex');
  assert.equal(DEFAULT_SETTINGS.claudePath, 'claude');
  assert.equal(DEFAULT_SETTINGS.firstUseNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.codexUsageNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.claudeUsageNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.workspaceInitialized, false);
  assert.ok(!('sampleTourVersionSeen' in DEFAULT_SETTINGS));
  assert.equal(DEFAULT_SETTINGS.canvasHintSeen, false);
  assert.doesNotMatch(DEFAULT_SETTINGS.models, /claude:/);
  assert.equal(normalizeReasoningLevel('medium'), 'medium');
  assert.equal(normalizeReasoningLevel('high'), 'high');
  assert.equal(normalizeReasoningLevel('auto'), 'auto');
  assert.equal(normalizeReasoningLevel('unsupported'), 'low');
});
test('model identifiers select one provider and preserve stable Claude aliases', () => {
  const providers = load('ai/providers/provider.ts');
  assert.equal(providers.providerForModel('gpt-5.6-luna'), 'codex');
  assert.equal(providers.providerForModel('claude:sonnet'), 'claude');
  assert.equal(providers.providerModelId('claude:opus'), 'opus');
  assert.equal(providers.claudeModelChoice('claude:sonnet').model, 'sonnet');
  assert.equal(providers.claudeModelChoice('claude:unknown'), undefined);
  assert.equal(providers.providerModelId('claude:haiku'), 'haiku');
  assert.equal(providers.claudeModelChoice('claude:haiku').label, 'Claude · Haiku');
  assert.deepEqual([...providers.CLAUDE_MODEL_CHOICES.map(choice => choice.id)], ['claude:sonnet', 'claude:opus', 'claude:haiku']);
});
test('stale Codex discovery cannot replace the current models or reasoning catalog', async () => {
  const { ModelDiscovery } = load('core/model-discovery.ts');
  let first, second;
  const discovery = new ModelDiscovery(() => true, () => new Promise(resolve => { if (!first) first = resolve; else second = resolve; }), () => false);
  const stale = discovery.refresh('codex');
  discovery.invalidate('codex');
  const current = discovery.refresh('codex');
  second({ models: ['current'], reasoningEfforts: { current: ['high'] } });
  await current;
  first({ models: ['stale'], reasoningEfforts: { stale: ['low'] } });
  await stale;
  assert.deepEqual(plain(discovery.state('codex')), { provider: 'codex', status: 'ready', models: ['current'], reasoningEfforts: { current: ['high'] } });
});
test('Codex reasoning metadata survives loading and error refresh states', async () => {
  const { ModelDiscovery } = load('core/model-discovery.ts'); let fail;
  let loadCount = 0;
  const discovery = new ModelDiscovery(() => true, () => {
    if (loadCount++ === 0) return Promise.resolve({ models: ['model'], reasoningEfforts: { model: ['high'] } });
    return new Promise((_resolve, reject) => { fail = reject; });
  }, () => false);
  await discovery.refresh('codex');
  const loading = discovery.refresh('codex');
  assert.deepEqual(plain(discovery.state('codex').reasoningEfforts), { model: ['high'] });
  fail(new Error('temporary failure'));
  await loading;
  assert.deepEqual(plain(discovery.state('codex').reasoningEfforts), { model: ['high'] });
});
test('Coffee Tables preserves a requested reasoning choice while model discovery is pending', () => {
  const { reasoningChoiceState } = load('experiences/coffee-tables/view.ts', { obsidian });
  assert.deepEqual(plain(reasoningChoiceState('high', [], 'loading')), { values: ['auto', 'high'], selected: 'high' });
  assert.deepEqual(plain(reasoningChoiceState('high', [], 'error')), { values: ['auto', 'high'], selected: 'high' });
  assert.deepEqual(plain(reasoningChoiceState('high', ['low'], 'ready')), { values: ['auto', 'low'], selected: 'auto' });
  assert.deepEqual(plain(reasoningChoiceState('high', ['high'], 'ready')), { values: ['auto', 'high'], selected: 'high' });
});
test('automatic reasoning respects manual choices and local tasks avoid research', () => {
  const { effectiveReasoningLevel, researchGuidance } = load('ai/task-policy.ts');
  const task = { title: 'Topic', summary: '', rules: '', detail: '', task: 'Organize', ancestors: '', mode: 'task', researchMode: 'local' };
  assert.equal(effectiveReasoningLevel(task, 'auto'), 'low');
  assert.equal(effectiveReasoningLevel({ ...task, mode: 'synthesize' }, 'auto'), 'medium');
  assert.equal(effectiveReasoningLevel({ ...task, sourceContext: 'x'.repeat(6_001) }, 'auto'), 'medium');
  assert.equal(effectiveReasoningLevel({ ...task, mode: 'synthesize' }, 'high'), 'high');
  assert.match(researchGuidance(task), /不要搜尋網路/);
  assert.match(researchGuidance(task), /現有資料不足/);
  assert.match(researchGuidance({ ...task, researchMode: 'research' }), /沒有固定/);
  assert.match(researchGuidance({ ...task, researchMode: 'research' }), /預期價值偏低時停止/);
});
test('research depth remains qualitative and imposes no fixed query or source count', () => {
  const { researchGuidance } = load('ai/task-policy.ts');
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'fast' }), /快速概覽/);
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'deep' }), /深入研究/);
  assert.match(researchGuidance({ researchMode: 'research', researchDepth: 'fast' }), /沒有固定/);
  assert.doesNotMatch(researchGuidance({ researchMode: 'research', researchDepth: 'fast' }), /最多 \\d+ 次/);
});
test('explicit source context survives long existing Markdown', () => {
  const { buildPreparedTaskContext } = load('ai/context-builder.ts');
  const context = { title: 'Topic', summary: '', rules: '', detail: 'old '.repeat(1_100), task: 'Review selected note', ancestors: '', workingFindings: '', sourceContext: '來源：selected.md\nverified evidence', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  const prepared = buildPreparedTaskContext(context, 'test-model', 1_000);
  assert.match(prepared.context.sourceContext, /verified evidence/);
  assert.ok(prepared.context.detail.length < context.detail.length);
});
test('general tasks retain existing Detail while decompose uses lightweight context', () => {
  const { buildPreparedTaskContext, extractJsonObject } = load('main.ts', { obsidian });
  const input = { title: 'Topic', summary: 'Existing summary', detail: 'Existing Detail', rules: '', task: 'Research the topic', ancestors: '', mode: 'task' };
  assert.equal(buildPreparedTaskContext(input, 'gpt-5.6-luna').context.detail, 'Existing Detail');
  assert.equal(buildPreparedTaskContext({ ...input, mode: 'decompose' }, 'gpt-5.6-luna').context.detail, '');
  assert.deepEqual(JSON.parse(extractJsonObject('我會先查核。\n{"summary":"ok","detail":"brace } in string"}\n完成。')), { summary: 'ok', detail: 'brace } in string' });
  assert.throws(() => extractJsonObject('沒有結構化回應'), /JSON object/);
});

test('saved content templates are normalized with the same call onload uses', () => {
  // Plugin.onload needs a full Obsidian workspace (editor extensions, views), so this exercises the exact
  // normalizeTemplates call that main.ts makes on `saved?.detailTemplates`, plus the DEFAULT_SETTINGS default.
  const templates = load('ai/detail-templates.ts');
  const valid = (id, name) => templates.copyTemplate(templates.standardTemplate('en'), name, id);
  const saved = { detailTemplates: [valid('t1', 'Teach'), { id: 'x', name: 'X', sections: [] }, valid('t1', 'Other')], defaultDetailTemplateId: 't1' };
  assert.deepEqual(plain(templates.normalizeTemplates(saved.detailTemplates).map(item => item.id)), ['t1']);
  assert.deepEqual(plain(templates.normalizeTemplates(undefined)), []);
  assert.deepEqual(plain(DEFAULT_SETTINGS.detailTemplates), []);
});
// model resolution (MS-01): run-once, then topic override (inherited upward), then the current model
const modelResolution = load('ai/model-resolution.ts');
const resolveInput = (extra = {}) => ({ current: { model: 'cur', reasoning: 'low' }, ...extra });
test('model resolution: run-once beats override and current, and keeps current reasoning when none is given', () => {
  const out = modelResolution.resolveTaskModel(resolveInput({ runOnce: { model: 'once' }, override: { model: 'ov', reasoning: 'high' } }));
  assert.deepEqual(plain(out), { model: 'once', reasoning: 'low', origin: 'run-once' });
  const withReasoning = modelResolution.resolveTaskModel(resolveInput({ runOnce: { model: 'once', reasoning: 'medium' } }));
  assert.equal(withReasoning.reasoning, 'medium');
});
test('model resolution: override beats current', () => {
  const out = modelResolution.resolveTaskModel(resolveInput({ override: { model: 'ov', reasoning: 'high' } }));
  assert.deepEqual(plain(out), { model: 'ov', reasoning: 'high', origin: 'override' });
});
test('model resolution: current is used when nothing else is set', () => {
  assert.deepEqual(plain(modelResolution.resolveTaskModel(resolveInput())), { model: 'cur', reasoning: 'low', origin: 'current' });
});
test('model resolution: an empty run-once model does not count and falls to override then current', () => {
  const withOverride = modelResolution.resolveTaskModel(resolveInput({ runOnce: { model: '' }, override: { model: 'ov', reasoning: 'low' } }));
  assert.equal(withOverride.origin, 'override');
  const whitespace = modelResolution.resolveTaskModel(resolveInput({ runOnce: { model: '  ' } }));
  assert.equal(whitespace.origin, 'current');
});
test('model resolution: the single fallback constant is the default current model', () => {
  assert.equal(modelResolution.FALLBACK_MODEL, DEFAULT_SETTINGS.cliModel);
});
test('model resolution: a manual topic without a stored model resolves to current', async () => {
  const { fixture, topicNote } = require('../support.cjs');
  const { repo } = fixture('en'); repo.settings.cliModel = 'cur-model';
  const note = await topicNote(repo, 'T', 'stored');
  await repo.updateNote(note.path, { modelSource: 'manual', model: '' });
  const out = await repo.resolveTopicModel(note.path);
  assert.equal(out.model, 'cur-model'); assert.equal(out.origin, 'current');
});
test('model resolution: inherited with no manual ancestor resolves to current; manual ancestor is an override', async () => {
  const support = require('../support.cjs');
  const { repo, app } = support.fixture('en'); repo.settings.cliModel = 'cur-model';
  const root = await support.topicNote(repo, 'Root', 'gpt-5.5');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', map = support.map([root]); map.id = 'map-a';
  await app.vault.create(mapPath, support.core.serializeMap(map));
  const child = await repo.createNote('Child', 'gpt-5.5', map, mapPath, 'inherited');
  child.parentId = root.id; map.nodes.push(child);
  const none = await repo.resolveTopicModel(child.path, map);
  assert.equal(none.model, 'cur-model'); assert.equal(none.origin, 'current');
  await repo.updateNote(root.path, { model: 'anc-model', modelSource: 'manual' });
  const inherited = await repo.resolveTopicModel(child.path, map);
  assert.equal(inherited.model, 'anc-model'); assert.equal(inherited.origin, 'override');
  const once = await repo.resolveTopicModel(child.path, map, { model: 'once-model' });
  assert.equal(once.origin, 'run-once');
});

test('model resolution (MS-01 review): an override brings its own reasoning-level; a missing one falls back to cliReasoning', async () => {
  const support = require('../support.cjs');
  const { repo, app } = support.fixture('en'); repo.settings.cliModel = 'cur-model'; repo.settings.cliReasoning = 'low';
  const root = await support.topicNote(repo, 'Root', 'gpt-5.5');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', map = support.map([root]); map.id = 'map-a';
  await app.vault.create(mapPath, support.core.serializeMap(map));
  const child = await repo.createNote('Child', 'gpt-5.5', map, mapPath, 'inherited');
  child.parentId = root.id; map.nodes.push(child);
  await repo.updateNote(root.path, { model: 'anc-model', modelSource: 'manual', reasoning: 'high' });
  const own = await repo.resolveTopicModel(root.path, map);
  assert.equal(own.origin, 'override'); assert.equal(own.model, 'anc-model'); assert.equal(own.reasoning, 'high');
  const inherited = await repo.resolveTopicModel(child.path, map);
  assert.equal(inherited.origin, 'override'); assert.equal(inherited.reasoning, 'high', 'an inheriting topic uses its manual ancestor\'s reasoning');
  const once = await repo.resolveTopicModel(child.path, map, { model: 'once-model' });
  assert.equal(once.reasoning, 'low', 'run-once without reasoning keeps the current reasoning');
  await repo.updateNote(root.path, { model: 'anc-model', modelSource: 'manual' });
  await app.vault.process(repo.file(root.path), content => content.replace(/^reasoning-level:.*\n/m, ''));
  assert.equal((await repo.resolveTopicModel(root.path, map)).reasoning, 'low', 'no reasoning-level in the note: fall back to cliReasoning');
});

// MS-04: reasoning follows the model resolution; only an override keeps its own stored reasoning-level.
const rawLevel = (contents, path) => contents.get(path).match(/^reasoning-level: (.*)$/m)?.[1];
async function reasoningFixture() {
  const support = require('../support.cjs');
  const { repo, app, contents } = support.fixture('en'); repo.settings.cliModel = 'cur-model'; repo.settings.cliReasoning = 'low';
  const root = await support.topicNote(repo, 'Root', 'gpt-5.5');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', map = support.map([root]); map.id = 'map-a';
  await app.vault.create(mapPath, support.core.serializeMap(map));
  const child = await repo.createNote('Child', 'gpt-5.5', map, mapPath, 'inherited');
  child.parentId = root.id; map.nodes.push(child);
  return { repo, app, contents, root, child, map, mapPath, support };
}
const setFm = (app, repo, path, edit) => app.vault.process(repo.file(path), content => edit(content));
integrationTest('MS-04: a workspace topic with a stored reasoning-level high follows the current reasoning (low)', async () => {
  const { repo, app, root } = await reasoningFixture();
  await setFm(app, repo, root.path, c => c.replace(/^reasoning-level:.*$/m, 'reasoning-level: high'));
  assert.equal((await repo.readNote(root.path)).reasoning, 'low');
  assert.equal((await repo.resolveTopicModel(root.path)).reasoning, 'low');
});
integrationTest('MS-04: a manual topic keeps its own reasoning (high) while the current one is low', async () => {
  const { repo, root } = await reasoningFixture();
  await repo.updateNote(root.path, { model: 'own-model', modelSource: 'manual', reasoning: 'high' });
  const note = await repo.readNote(root.path);
  assert.equal(note.reasoning, 'high'); assert.equal(note.model, 'own-model');
  assert.equal((await repo.resolveTopicModel(root.path)).reasoning, 'high');
});
integrationTest('MS-04: an inherited topic takes its manual ancestor\'s reasoning (medium)', async () => {
  const { repo, root, child, map } = await reasoningFixture();
  await repo.updateNote(root.path, { model: 'anc', modelSource: 'manual', reasoning: 'medium' });
  const note = await repo.readNote(child.path, map);
  assert.equal(note.reasoning, 'medium'); assert.equal(note.model, 'anc');
});
integrationTest('MS-04: an inherited topic with no manual ancestor ignores a stored high and uses the current reasoning', async () => {
  const { repo, app, child, map } = await reasoningFixture();
  await setFm(app, repo, child.path, c => c.replace(/^reasoning-level:.*$/m, 'reasoning-level: high'));
  assert.equal((await repo.readNote(child.path, map)).reasoning, 'low');
});
integrationTest('MS-04: a manual topic without a stored model uses the current reasoning even if a level is stored', async () => {
  const { repo, root } = await reasoningFixture();
  await repo.updateNote(root.path, { modelSource: 'manual', model: '', reasoning: 'high' });
  const note = await repo.readNote(root.path);
  assert.equal(note.reasoning, 'low'); assert.equal(note.model, 'cur-model');
});
integrationTest('MS-04: changing the current reasoning changes the next read of an existing non-override topic (the askModel input), not an override', async () => {
  const { repo, root, child, map } = await reasoningFixture();
  const other = await repo.createNote('Own', 'x', map, 'Agent Workspace/Topics/map-a/Map.md', 'manual', { reasoning: 'high' });
  repo.settings.cliReasoning = 'medium';
  assert.equal((await repo.readNote(root.path)).reasoning, 'medium');
  assert.equal((await repo.readNote(child.path, map)).reasoning, 'medium');
  assert.equal((await repo.resolveTopicModel(root.path)).reasoning, 'medium');
  assert.equal((await repo.readNote(other.path, map)).reasoning, 'high');
  repo.settings.cliReasoning = 'auto';
  assert.equal((await repo.readNote(root.path)).reasoning, 'auto');
});
integrationTest('MS-04: createNote writes reasoning-level only for a manual topic', async () => {
  const { repo, contents, map, mapPath } = await reasoningFixture();
  for (const source of ['workspace', 'inherited']) {
    const n = await repo.createNote(`N ${source}`, 'm', map, mapPath, source, { reasoning: 'high' });
    assert.equal(rawLevel(contents, n.path), undefined, `createNote ${source}`);
  }
  const m = await repo.createNote('N manual', 'm', map, mapPath, 'manual', { reasoning: 'high' });
  assert.equal(rawLevel(contents, m.path), 'high');
  const mDefault = await repo.createNote('N manual2', 'm', map, mapPath, 'manual');
  assert.equal(rawLevel(contents, mDefault.path), 'low');
});
integrationTest('MS-04: upgrade-0.18 notes keep their stored reasoning-level byte for byte; reading ignores it for non-override topics', async () => {
  const fs = require('node:fs'), path = require('node:path'), support = require('../support.cjs');
  const root = path.join(__dirname, '..', 'fixtures', 'upgrade-0.18', 'vault');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const notes = walk(root).filter(f => /reasoning-level:/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(notes.length >= 5, `fixture notes with reasoning-level: ${notes.length}`);
  const { repo, app, contents } = support.fixture('en'); repo.settings.cliReasoning = 'high';
  for (const file of notes) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    await repo.folder(path.posix.dirname(rel)); await app.vault.create(rel, fs.readFileSync(file, 'utf8'));
  }
  for (const file of notes) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const note = await repo.readNote(rel);
    assert.equal(note.reasoning, 'high', `${rel}: stored low is ignored`);
    assert.equal(contents.get(rel), fs.readFileSync(file, 'utf8'), `${rel} is byte-identical after reading`);
  }
});
integrationTest('MS-04: a dialog that only changes the model of an old workspace note (stored high, current low) leaves the note reading low', async () => {
  const { repo, app, root } = await reasoningFixture();
  await setFm(app, repo, root.path, c => c.replace(/^reasoning-level:.*$/m, 'reasoning-level: high'));
  // The patch the dialog now saves for workspace -> manual: the model, manual and the level shown (low).
  await repo.updateNote(root.path, { model: 'picked', modelSource: 'manual', reasoning: 'low' });
  const note = await repo.readNote(root.path);
  assert.equal(note.model, 'picked'); assert.equal(note.reasoning, 'low');
  assert.equal((await repo.resolveTopicModel(root.path)).reasoning, 'low');
});

integrationTest('MS-04: merge model and reasoning follow the upper topic resolution (manual parent, workspace parent, no parent)', async () => {
  const { repo, root, child, map, support } = await reasoningFixture();
  const plugin = { repo, settings: { ...support.DEFAULT_SETTINGS, cliModel: 'cur-model', cliReasoning: 'low' }, currentModelChoice() { return { model: this.settings.cliModel, reasoning: support.normalizeReasoningLevel(this.settings.cliReasoning) }; } };
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: support.obsidian });
  const view = new VisualAgentMapView({ app: {} }, plugin); view.map = map;
  assert.deepEqual(plain(await view.mergeModel(root.id)), { model: 'cur-model', reasoning: 'low' });
  await repo.updateNote(root.path, { model: 'anc', modelSource: 'manual', reasoning: 'high' });
  assert.deepEqual(plain(await view.mergeModel(root.id)), { model: 'anc', reasoning: 'high' });
  assert.deepEqual(plain(await view.mergeModel(child.id)), { model: 'anc', reasoning: 'high' });
  assert.deepEqual(plain(await view.mergeModel(null)), { model: 'cur-model', reasoning: 'low' });
});

/** The rows of a definitions tree, groups and pages opened (the order a person reads them). */
function flattenDefinitions(items) { return items.flatMap(item => (item.type === 'group' || item.type === 'page') ? flattenDefinitions(item.items || []) : [item]); }
const MODEL_ROW = /^(Model|模型)$|Current model|目前模型|当前模型/;

function settingsTabHarness(initial = 'gpt-a') {
  const { VisualAgentMapSettingTab } = load('ui/settings-tab.ts', { obsidian: { ...obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: class {} } });
  const listeners = new Set(), saved = [];
  const plugin = {
    settings: { cliModel: initial },
    currentModelListeners: listeners,
    subscribeModelDiscovery: () => () => {},
    subscribeCurrentModel: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    codexDiagnostic: () => ({ installed: true, executable: 'codex' }), claudeDiagnostic: () => ({ installed: true, executable: 'claude' }),
    availableModels: () => ['gpt-a', 'claude:sonnet'], modelLabel: id => `label:${id}`,
    modelDiscoveryState: () => ({ status: 'ready', models: [] }), refreshModelDiscovery: async () => {},
    async setCurrentModel(model) { if (typeof model !== 'string' || !model.trim()) return; this.settings.cliModel = model.trim(); saved.push(model.trim()); for (const fn of [...listeners]) fn(this.settings.cliModel); }
  };
  const tab = new VisualAgentMapSettingTab({}, plugin);
  const select = { options: [], value: '', isConnected: true, add(option) { this.options.push(option); }, replaceChildren() { this.options = []; } };
  let onChange; const status = { text: '', isConnected: true, setText(v) { this.text = v; } }; const descEl = { createDiv: () => status };
  const setting = { descEl, desc: undefined, setName() { return this; }, setDesc(v) { this.desc = v; return this; }, addDropdown(cb) { cb({ selectEl: select, setValue: v => { select.value = v; }, onChange: fn => { onChange = fn; } }); return this; }, addButton() { return this; } };
  const item = flattenDefinitions(tab.getSettingDefinitions()).find(d => d.render && MODEL_ROW.test(d.name));
  item.render(setting);
  return { tab, plugin, select, listeners, saved, status, setting, choose: v => onChange(v) };
}

test('MS-02: settings page picks the current model, the chat listener hears it, and an outside change updates the dropdown', async () => {
  const h = settingsTabHarness('gpt-a');
  const chat = []; h.plugin.subscribeCurrentModel(m => chat.push(m));
  assert.equal(h.select.value, 'gpt-a');
  assert.equal(h.listeners.size, 2, 'settings page and the chat listener');
  h.choose('claude:sonnet'); await new Promise(r => setImmediate(r));
  assert.equal(h.plugin.settings.cliModel, 'claude:sonnet'); assert.deepEqual(chat, ['claude:sonnet']);
  await h.plugin.setCurrentModel('gpt-a');
  assert.equal(h.select.value, 'gpt-a', 'the chat menu changed it, the page follows');
  await h.plugin.setCurrentModel('gone-model');
  assert.equal(h.select.value, 'gone-model');
  const gone = h.select.options.find(o => o.value === 'gone-model');
  assert.ok(gone && gone.disabled && /label:gone-model/.test(gone.text), 'unavailable model stays visible and disabled');
  await h.tab.setControlValue('cliModel', '  '); await h.tab.setControlValue('cliModel', 7);
  assert.equal(h.plugin.settings.cliModel, 'gone-model', 'blank and non-string values do nothing');
});

test('MS-02: the settings page stops listening when it is hidden, and re-rendering never stacks listeners', () => {
  const h = settingsTabHarness();
  assert.equal(h.listeners.size, 1);
  const again = flattenDefinitions(h.tab.getSettingDefinitions()).find(d => d.render && MODEL_ROW.test(d.name));
  again.render(h.setting);
  assert.equal(h.listeners.size, 1, 'a second render replaces the first subscription');
  h.tab.hide(); assert.equal(h.listeners.size, 0);
  h.tab.hide(); assert.equal(h.listeners.size, 0, 'hide is safe twice');
});

test('MS-02: settings description and the discovery summary are two separate elements; old i18n keys are gone', () => {
  const h = settingsTabHarness();
  assert.match(h.setting.desc, /聊天|Chat|聊天/);
  assert.notEqual(h.status.text, ''); assert.notEqual(h.status.text, h.setting.desc);
  const fs = require('node:fs'), path = require('node:path');
  for (const lang of ['zh-TW', 'zh-CN', 'en']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'i18n', `${lang}.ts`), 'utf8');
    for (const key of ['ui.map_chat_model_follow_0', 'ui.map_chat_model_follow_short_0', 'ui.workspace_default_model', 'ui.models_are_loaded_from_each_installed_ai_service_changes_apply_only_to_new_root_topics']) assert.equal(source.includes(`"${key}"`), false, `${lang} no longer has ${key}`);
    assert.ok(source.includes('"ui.current_model"') && source.includes('"ui.current_model_description"'));
  }
});
test('N1: a data.json that still carries sampleTourVersionSeen loads without error and the key is dropped', () => {
  const { settingsFromSaved } = load('main.ts', { obsidian });
  const result = settingsFromSaved({ sampleTourVersionSeen: 3, workspaceInitialized: true, language: 'en' });
  assert.ok(!('sampleTourVersionSeen' in result));
  assert.ok(!JSON.stringify(result).includes('sampleTourVersionSeen'));
  assert.equal(result.workspaceInitialized, true);
  assert.equal(result.language, 'en');
});

// ---- Settings page groups and pages (Obsidian 1.13 type: group / page) ----
function groupedTab(overrides = {}) {
  const { VisualAgentMapSettingTab } = load('ui/settings-tab.ts', { obsidian: { ...obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: class {} } });
  const recipes = [
    { ref: 'builtin:general', name: 'General research', kind: 'builtin', issues: [] },
    { ref: 'builtin:hypothesis', name: 'Hypothesis test', kind: 'builtin', issues: [] },
    { ref: 'builtin:aim', name: 'AIM report', kind: 'builtin', aimOnly: true, issues: [] },
    { ref: 'file:mine', name: 'Mine', kind: 'file', issues: [] }
  ];
  const plugin = {
    settings: { cliModel: 'm', language: 'en', ...(overrides.settings || {}) },
    subscribeModelDiscovery: () => () => {}, subscribeCurrentModel: () => () => {},
    codexDiagnostic: () => ({ installed: overrides.codex ?? true, executable: 'codex' }),
    claudeDiagnostic: () => ({ installed: overrides.claude ?? true, executable: 'claude' }),
    noteStyles: { listRecipes: () => overrides.recipes || recipes }
  };
  return { tab: new VisualAgentMapSettingTab({}, plugin), plugin };
}
const pagesOf = items => items.flatMap(item => item.type === 'group' ? item.items.filter(x => x.type === 'page') : item.type === 'page' ? [item] : []);
const allPages = items => items.flatMap(item => item.type === 'page' ? [item, ...allPages(item.items || [])] : item.type === 'group' ? allPages(item.items || []) : []);
const valueOf = page => typeof page.displayValue === 'function' ? page.displayValue() : page.displayValue;
const statusOf = page => typeof page.status === 'function' ? page.status() : page.status;
const pageNamed = (tab, name) => allPages(tab.getSettingDefinitions()).find(p => p.name === name);

test('settings page: five top-level groups in order, eleven rows (no AIM folder row since AIM was removed), three top-level pages and no nested page', () => {
  const { tab } = groupedTab();
  const defs = tab.getSettingDefinitions();
  assert.ok(defs.every(d => d.type === 'group'), 'the top level holds only groups');
  assert.deepEqual(plain(defs.map(d => d.heading)), ['General', 'AI', 'Notes', 'Map', 'Advanced']);
  assert.equal(defs.reduce((n, d) => n + d.items.length, 0), 11);
  assert.deepEqual(plain(pagesOf(defs).map(p => p.name)), ['AI connection', 'Note style', 'Advanced and troubleshooting']);
  const note = pageNamed(tab, 'Note style');
  assert.deepEqual(plain(pagesOf(note.items).map(p => p.name)), [], 'the "By topic type" sub-page is gone (grilling Q11)');
  assert.equal(allPages(defs).length, 3);
});

test('settings page: every control and saved key is still reachable after the regroup', () => {
  const rows = flattenDefinitions(groupedTab().tab.getSettingDefinitions());
  assert.ok(rows.some(r => r.control && r.control.key === 'cliReasoning'));
  assert.ok(rows.some(r => r.control && r.control.key === 'codexPath'));
  assert.ok(rows.some(r => r.control && r.control.key === 'claudePath'));
  assert.equal(rows.filter(r => r.render && MODEL_ROW.test(r.name)).length, 1);
  const names = rows.map(r => r.name);
  for (const name of ['Interface language', 'Hover preview size', 'Mind Maps folder', 'Record AI exchanges', 'Save map AI conversations', 'Add diagrams after research', 'Reconnect existing Workspace', 'File location', 'Topic']) assert.ok(names.includes(name), `${name} is on the page`);
  for (const name of ['AIM folder', 'AIM conclusion note']) assert.equal(names.includes(name), false, `${name} is gone with AIM (the saved aimFolder value is kept)`);
});

test('settings page: the two sub-page intro rows render with an empty name and the sentence as the description, and stay out of search', () => {
  const { tab, plugin } = groupedTab();
  const intros = [["AI connection"]];
  for (const [pageName] of intros) {
    const item = pageNamed(tab, pageName).items[0];
    assert.equal(item.searchable, false, `${pageName} intro is not a search entry`);
    assert.equal(typeof item.render, 'function', `${pageName} intro has a render`);
    assert.ok(item.name, 'the definition keeps a name, as Obsidian requires');
    const view = { name: item.name, desc: '', buttons: [] };
    const setting = { setName(n) { view.name = n; return this; }, setDesc(d) { view.desc = d; return this; }, addButton(cb) { const b = { text: '', onClick(h) { view.click = h; return this; }, setButtonText(x) { b.text = x; return this; }, buttonEl: { addClass() {} } }; cb(b); view.buttons.push(b); return this; } };
    item.render(setting);
    assert.equal(view.name, '', `${pageName} intro: no name left after render`);
    assert.equal(view.desc, item.name, `${pageName} intro: desc is the intro text`);
  }
  // P3: the Note style page opens with the "How notes are written" card instead of an intro row (its Preview button is tested in steps-note-style-settings.cjs)
  const noteItem = pageNamed(tab, 'Note style').items[0];
  assert.equal(noteItem.name, 'How notes are written');
  assert.equal(typeof noteItem.render, 'function');
  assert.notEqual(noteItem.searchable, false, 'the card is a search entry');
});

test('AI connection entry: shows how many CLIs are connected and warns only when none is', () => {
  for (const [codex, claude, text, status] of [[true, true, '2 connected', null], [true, false, '1 connected', null], [false, true, '1 connected', null], [false, false, 'Not connected', 'warning']]) {
    const page = pageNamed(groupedTab({ codex, claude }).tab, 'AI connection');
    assert.equal(valueOf(page), text);
    assert.equal(statusOf(page), status);
  }
  const { tab, plugin } = groupedTab({ codex: false, claude: false });
  const page = pageNamed(tab, 'AI connection');
  assert.equal(statusOf(page), 'warning');
  plugin.codexDiagnostic = () => ({ installed: true, executable: 'codex' });
  assert.equal(valueOf(page), '1 connected', 'the value is recomputed on every render, not frozen');
  assert.equal(statusOf(page), null);
});

test('Note style page: a "Topic types" group of six rows in kind order (no AIM row since AIM was removed), then "My styles" with one row, then "More" with only File location; no Structure, Voice or By topic type row', () => {
  const note = pageNamed(groupedTab().tab, 'Note style');
  const groups = note.items.filter(item => item.type === 'group');
  assert.deepEqual(plain(groups.map(group => group.heading)), ['Topic types', 'My styles', 'More']);
  assert.deepEqual(plain(groups[0].items.map(row => row.name)), ['Topic', 'Atomic knowledge', 'Hypothesis', 'Evidence', 'Conclusion', 'Action']);
  assert.deepEqual(plain(groups[1].items.map(row => row.name)), ['My styles']);
  assert.deepEqual(plain(groups[2].items.map(row => row.name)), ['File location']);
  const names = flattenDefinitions(note.items).map(row => row.name);
  for (const gone of ['Structure', 'Voice', 'By topic type']) assert.ok(!names.includes(gone), `${gone} row is gone`);
});

test('Note style entry: shows the general topic row style by name, falls back to the ref, warns when a saved style is gone', () => {
  const ok = pageNamed(groupedTab().tab, 'Note style');
  assert.equal(valueOf(ok), 'General research');
  assert.equal(statusOf(ok), null);
  const chosen = pageNamed(groupedTab({ settings: { noteStyleByKind: { topic: 'file:mine' } } }).tab, 'Note style');
  assert.equal(valueOf(chosen), 'Mine');
  const unnamed = pageNamed(groupedTab({ recipes: [] }).tab, 'Note style');
  assert.doesNotThrow(() => valueOf(unnamed));
  assert.equal(valueOf(unnamed), 'builtin:general', 'no name found: the ref is shown');
  const gone = pageNamed(groupedTab({ settings: { noteStyleByKind: { action: 'file:deleted' } } }).tab, 'Note style');
  assert.equal(statusOf(gone), 'warning', 'any row whose saved style is gone');
  assert.doesNotThrow(() => valueOf(gone));
  const aimOnTopic = pageNamed(groupedTab({ settings: { noteStyleByKind: { topic: 'builtin:aim' } } }).tab, 'Note style');
  assert.equal(statusOf(aimOnTopic), 'warning', 'the AIM report is not a style a topic type can use');
  const aimOnAim = pageNamed(groupedTab({ settings: { noteStyleByKind: { aim: 'file:mine' } } }).tab, 'Note style');
  assert.equal(statusOf(aimOnAim), null);
});

// ---- Bug bash E: #18 language refocus in a popout window, #19 CLI path commit refreshes the status ----
function tabWithDoc(extra = {}) {
  const { VisualAgentMapSettingTab } = load('ui/settings-tab.ts', { obsidian: { ...obsidian, PluginSettingTab: class { hide() {} update() { this.updates = (this.updates || 0) + 1; this.onUpdate?.(); } }, Setting: class {}, Modal: class {} } });
  const saved = [];
  const plugin = {
    settings: { cliModel: 'm', language: 'en', codexPath: 'codex', claudePath: 'claude' },
    subscribeModelDiscovery: () => () => {}, subscribeCurrentModel: () => () => {}, rereadAllViews() {},
    codexDiagnostic() { return { installed: this.settings.codexPath === '/ok/codex', executable: this.settings.codexPath }; },
    claudeDiagnostic() { return { installed: false, executable: 'claude' }; },
    resetCodexRuntime() {}, modelDiscovery: { invalidate() {} }, refreshModelDiscovery: async () => {},
    saveSettings: async () => { saved.push({ ...plugin.settings }); },
    ...extra
  };
  return { tab: new VisualAgentMapSettingTab({}, plugin), plugin, saved };
}
const languageSelect = (id, log) => {
  const select = { tag: 'select', id, options: ['en', 'zh-TW', 'zh-CN'].map(value => ({ value })), instanceOf: () => true, focus() { log.push(id); } };
  return select;
};
test('Bug bash E #18: after a language change the language select of a popout Settings window is focused again (the window own document, not the global one)', () => {
  const log = [];
  const { tab } = tabWithDoc();
  const oldSelect = languageSelect('old', log), newSelect = languageSelect('new', log);
  const popoutDoc = { activeElement: oldSelect };
  let selects = [oldSelect];
  tab.containerEl = { doc: popoutDoc, contains: el => el === oldSelect || el === newSelect, querySelectorAll: () => selects };
  tab.onUpdate = () => { selects = [newSelect]; popoutDoc.activeElement = null; };
  tab.refreshAfterLanguageChange();
  assert.deepEqual(log, ['new'], 'the new language select got the focus back');
  // not focused in the language select: nothing is moved
  log.length = 0;
  popoutDoc.activeElement = { tag: 'button', instanceOf: () => false };
  tab.containerEl.contains = () => true;
  tab.refreshAfterLanguageChange();
  assert.deepEqual(log, []);
});
test('Bug bash E #19: committing a Codex or Claude CLI path redraws the page after saving, and picking a reasoning level or typing does not', async () => {
  const { tab, plugin, saved } = tabWithDoc();
  const seen = [];
  tab.onUpdate = () => seen.push({ saved: saved.length, value: tab.aiConnectionValue() });
  assert.equal(tab.aiConnectionValue(), 'Not connected');
  await tab.setControlValue('codexPath', ' /ok/codex ');
  assert.equal(plugin.settings.codexPath, '/ok/codex');
  assert.equal(seen.length, 1, 'redrawn once, after the save');
  assert.equal(seen[0].saved, 1);
  assert.notEqual(seen[0].value, 'Not connected', 'the status follows the diagnostic of the new path');
  await tab.setControlValue('claudePath', '/x/claude');
  assert.equal(seen.length, 2);
  await tab.setControlValue('cliReasoning', 'high');
  assert.equal(seen.length, 2, 'other values do not redraw the page');
});

test('Bug bash E #18 (round 2): the language select is focused again after the redraw even though it had already lost focus when the refresh ran', async () => {
  const log = [];
  const pendingBox = { pending: true };
  const { tab, plugin } = tabWithDoc({ languageSwitchPending: true, changeLanguage: async () => {} });
  const oldSelect = languageSelect('old', log), newSelect = languageSelect('new', log);
  const doc = { activeElement: oldSelect };
  let selects = [oldSelect];
  tab.containerEl = { doc, contains: el => el === oldSelect || el === newSelect, querySelectorAll: () => selects };
  tab.onUpdate = () => { selects = [newSelect]; };
  // render the language row and take its onChange
  let onChange;
  const row = flattenDefinitions(tab.getSettingDefinitions()).find(d => d.render && /Interface language|介面語言|界面语言/.test(d.name));
  const setting = { setName() { return this; }, setDesc() { return this; }, addDropdown(cb) { cb({ addOption() {}, setValue() { return this; }, setDisabled() { return this; }, onChange: fn => { onChange = fn; }, selectEl: oldSelect }); return this; } };
  row.render(setting);
  onChange('zh-TW'); // the change event: the select is still the focused one here
  doc.activeElement = { tag: 'body', instanceOf: () => false }; // ...but focus is gone when the refresh runs
  tab.refreshAfterLanguageChange(); // first refresh: switch pending, the new select is disabled
  assert.deepEqual(log, [], 'a disabled select cannot take the focus yet');
  plugin.languageSwitchPending = false;
  tab.refreshAfterLanguageChange(); // final refresh
  assert.deepEqual(log, ['new']);
  log.length = 0;
  tab.refreshAfterLanguageChange();
  assert.deepEqual(log, [], 'the request is used once');
});

// A page of settings rows as the redraw builds it: [setting name, [control label, ...]]. Every control knows its row, as in the DOM.
function settingsPage(doc, rows) {
  const items = rows.map(([name]) => ({ name, querySelector: () => ({ textContent: name }) }));
  const controls = [];
  rows.forEach(([, labels], row) => labels.forEach(label => {
    controls.push({ id: `${rows[row][0]}/${label}`, tagName: 'BUTTON', textContent: label, getAttribute: () => null, closest: () => items[row], focus() { doc.activeElement = this; }, instanceOf: () => false });
  }));
  return { items, controls };
}
const pageRoot = (doc, page) => ({ doc, contains: el => page().controls.includes(el), querySelectorAll: sel => (sel === '.setting-item' ? page().items : page().controls) });
test('Bug bash E #19 (round 3): committing a CLI path with Tab keeps the keyboard on the control Tab moved to, and the redrawn page has it focused again', async () => {
  const { tab } = tabWithDoc();
  const doc = { activeElement: null };
  const rows = [['Path', ['path']], ['Next', ['next']], ['Other', ['other']]];
  let page = settingsPage(doc, rows);
  tab.containerEl = pageRoot(doc, () => page);
  tab.onUpdate = () => { page = settingsPage(doc, rows); doc.activeElement = { id: 'container' }; }; // a redraw drops the focus to the container
  page.controls[1].focus(); // Tab moved the focus to the next control before the change was committed
  const before = page.controls[1];
  await tab.setControlValue('codexPath', '/ok/codex');
  assert.equal(doc.activeElement.id, 'Next/next', 'activeElement is the redrawn equivalent of the control that had focus');
  assert.notEqual(doc.activeElement, before, 'it is the new element, not the destroyed one');
  // no focus inside the page: nothing is moved
  tab.onUpdate = () => { page = settingsPage(doc, [['Path', ['path']]]); doc.activeElement = null; };
  doc.activeElement = { id: 'elsewhere' };
  await tab.setControlValue('claudePath', '/c');
  assert.equal(doc.activeElement, null);
});
test('Bug bash E #19 (follow-up): when the redraw adds a control (an invalid path adds the Installation guide button), the focus still lands on the same control, not on the one now at its old position', async () => {
  const { tab } = tabWithDoc();
  const doc = { activeElement: null };
  const before = [['Status', ['Check again']], ['CLI path', ['path']], ['Model', ['model']]];
  const after = [['Status', ['Installation guide', 'Check again']], ['CLI path', ['path']], ['Model', ['model']]];
  let page = settingsPage(doc, before);
  tab.containerEl = pageRoot(doc, () => page);
  tab.onUpdate = () => { page = settingsPage(doc, after); doc.activeElement = { id: 'container' }; };
  page.controls[1].focus(); // the path entry: index 1 before the redraw, index 2 after
  await tab.setControlValue('codexPath', '/bad/codex');
  assert.equal(doc.activeElement.id, 'CLI path/path');
  // the same label in two same-named rows (Codex and Claude status): the same one of the two
  const twin = [['Status', ['Check again']], ['Status', ['Check again']]];
  const twinAfter = [['Status', ['Installation guide', 'Check again']], ['Status', ['Check again']]];
  page = settingsPage(doc, twin);
  tab.onUpdate = () => { page = settingsPage(doc, twinAfter); doc.activeElement = null; };
  page.controls[1].focus();
  await tab.setControlValue('claudePath', '/bad/claude');
  assert.equal(doc.activeElement, page.controls[2], 'the second Status row Check again, not the first');
  // the control count does not change: still the same control
  page = settingsPage(doc, before);
  tab.onUpdate = () => { page = settingsPage(doc, before); doc.activeElement = null; };
  page.controls[2].focus();
  await tab.setControlValue('codexPath', '/ok/codex');
  assert.equal(doc.activeElement.id, 'Model/model');
});
test('UX B2: the AI usage notice says in plain words what is sent where and whose allowance it uses, and its button is a verb', () => {
  const dom = require('../support-dom.cjs');
  const buttons = [];
  class Setting { constructor() {} addButton(build) { const b = { text: '', cta: false, setButtonText(text) { this.text = text; return this; }, setCta() { this.cta = true; return this; }, onClick(fn) { this.click = fn; return this; } }; build(b); buttons.push(b); return this; } }
  const { AiUsageModal } = load('ui/settings-tab.ts', { obsidian: { ...obsidian, PluginSettingTab: class { hide() {} }, Setting, Modal: dom.makeModal() } });
  for (const [provider, title, service, allowance] of [['codex', 'Before sending to Codex', /to Codex/, /Codex allowance/], ['claude', 'Before sending to Claude', /to Claude/, /Claude account's usage/]]) {
    buttons.length = 0; const answers = [];
    const modal = new AiUsageModal({}, provider, ok => answers.push(ok)); modal.open();
    assert.equal(modal.titleEl.text, title);
    const intro = dom.find(modal.contentEl, i => i.tag === 'p').text;
    assert.match(intro, /your message/); assert.match(intro, /current map/); assert.match(intro, service); assert.match(intro, allowance);
    assert.deepEqual(buttons.map(b => [b.text, b.cta]), [['Cancel', false], ['Agree and send', true]]);
    buttons[1].click(); assert.deepEqual(answers, [true], 'agreeing still answers yes, once');
  }
});

// Map chat records switch (A2, A10)
test('mapChatRecords defaults off and sanitizes', () => {
  const Main = load('main.ts', { obsidian });
  assert.equal(DEFAULT_SETTINGS.mapChatRecords, false);
  assert.equal(Main.settingsFromSaved(null).mapChatRecords, false);
  assert.equal(Main.settingsFromSaved({}).mapChatRecords, false);
  for (const bad of ['true', 1, 'yes', null, {}, [], 0]) assert.equal(Main.settingsFromSaved({ mapChatRecords: bad }).mapChatRecords, false, String(bad));
  assert.equal(Main.settingsFromSaved({ mapChatRecords: false }).mapChatRecords, false);
  assert.equal(Main.settingsFromSaved({ mapChatRecords: true }).mapChatRecords, true);
});
test('turning records off asks keep/delete with count N', async () => {
  const notices = [];
  const Modal = dom.makeModal();
  const modals = [];
  const { turnMapChatRecordsOff } = load('ui/modals/map-chat-records-off-modal.ts', { obsidian: { ...obsidian, Modal: class extends Modal { constructor(a) { super(a); modals.push(this); } }, Notice: dom.makeNotice(notices) } });
  const rec = (root, n) => `${root}/Chats/records/20261106-0000${String(n).padStart(2, '0')}-abc12${n}.jsonl`;
  const build = async () => {
    const { app, trashed, files } = fixture('en');
    app.vault.getFiles = () => Array.from(files.values()).filter(f => f instanceof TFile);
    const paths = [
      rec('Agent Workspace/Mind Maps/Alpha', 1), rec('Agent Workspace/Mind Maps/Alpha', 2),
      rec('Agent Workspace/Mind Maps/Gone', 3) // Map.md deleted, folder and records still there
    ];
    for (const path of paths) await app.vault.create(path, '{"v":1}\n');
    // Counter-examples: never deleted
    const keepers = ['Agent Workspace/Mind Maps/Alpha/Chats/records/notes.md', 'Agent Workspace/Mind Maps/Alpha/Chats/other.jsonl', 'Agent Workspace/Mind Maps/Alpha/Chats/records/bad-name.jsonl', 'Agent Workspace/Mind Maps/Alpha/Map.md', '.obsidian/Chats/records/20261106-000001-abc123.jsonl'];
    for (const path of keepers) await app.vault.create(path, 'x');
    return { app, trashed, paths };
  };
  const writer = () => { const w = { enabled: true, idles: 0, setEnabled(on) { w.enabled = on; }, async idle() { w.idles++; } }; return w; };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const clickBy = (modal, text) => dom.findAll(modal.modalEl, i => i.tag === 'button').find(b => b.text.startsWith(text)).click();

  // keep: default focus is on Keep, files untouched, writers stopped
  {
    const { app, trashed, paths } = await build();
    const w = writer();
    const pending = turnMapChatRecordsOff({ app, writers: [w] });
    await tick();
    assert.equal(modals.length, 1);
    const m = modals[0];
    assert.equal(w.enabled, false);
    assert.match(m.contentEl.children[0].text, /Saved conversations: 3/);
    const buttons = dom.findAll(m.modalEl, i => i.tag === 'button');
    assert.deepEqual(buttons.map(b => b.text), ['Keep', 'Delete conversations (3)']);
    assert.equal(dom.focusedNow(), buttons[0]);
    clickBy(m, 'Keep');
    assert.deepEqual(plain(await pending), { deleted: 0, failed: 0 });
    assert.deepEqual(trashed, []);
    assert.ok(paths.every(p => app.vault.getAbstractFileByPath(p)));
  }
  // Escape / closing the dialog keeps too
  {
    modals.length = 0;
    const { app, trashed } = await build();
    const pending = turnMapChatRecordsOff({ app, writers: [] });
    await tick();
    modals[0].close();
    assert.deepEqual(plain(await pending), { deleted: 0, failed: 0 });
    assert.deepEqual(trashed, []);
  }
  // delete: only the 3 record files go to trashFile, after the writers' queues drained; the others stay
  {
    modals.length = 0;
    const { app, trashed, paths } = await build();
    const w = writer();
    const vaultDelete = []; app.vault.delete = async f => { vaultDelete.push(f.path); };
    const pending = turnMapChatRecordsOff({ app, writers: [w] });
    await tick();
    clickBy(modals[0], 'Delete conversations (3)');
    assert.deepEqual(plain(await pending), { deleted: 3, failed: 0 });
    assert.deepEqual(plain([...trashed].sort()), plain([...paths].sort()));
    assert.deepEqual(vaultDelete, []);
    assert.ok(w.idles >= 2);
  }
  // switched back on while the dialog was open: nothing is deleted
  {
    modals.length = 0;
    const { app, trashed } = await build();
    let off = true;
    const pending = turnMapChatRecordsOff({ app, writers: [], stillOff: () => off });
    await tick();
    off = false;
    clickBy(modals[0], 'Delete conversations (3)');
    await pending;
    assert.deepEqual(trashed, []);
  }
  // N=0: no dialog; an unrelated .md / other .jsonl does not count
  {
    modals.length = 0;
    const { app, trashed, files } = fixture('en');
    app.vault.getFiles = () => Array.from(files.values()).filter(f => f instanceof TFile);
    for (const path of ['A/Chats/records/notes.md', 'A/Chats/other.jsonl', 'A/Chats/records/bad-name.jsonl', 'A/Chats/records/sub/20261106-000001-abc123.jsonl']) await app.vault.create(path, 'x');
    const w = writer();
    assert.deepEqual(plain(await turnMapChatRecordsOff({ app, writers: [w] })), { deleted: 0, failed: 0 });
    assert.equal(modals.length, 0);
    assert.equal(w.enabled, false);
    assert.deepEqual(trashed, []);
  }
});
