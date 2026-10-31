const assert = require('node:assert/strict');
const { test, integrationTest, load, core, plain, obsidian, DEFAULT_SETTINGS, normalizeReasoningLevel } = require('../support.cjs');
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
  assert.equal(DEFAULT_SETTINGS.sampleTourVersionSeen, 0);
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
test('AIM model refresh updates choices, preserves selection, and reports failures', async () => {
  class Element {
    constructor(tag, options = {}) { this.tag = tag; this.children = []; this.attributes = {}; this.text = options.text ?? ''; this.value = options.value ?? ''; this.disabled = false; this.checked = false; this.isConnected = true; this.handlers = {}; }
    createDiv(options) { const child = new Element('div', options); this.children.push(child); return child; }
    createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
    createSpan(options) { return this.createEl('span', options); }
    setAttr(name, value) { this.attributes[name] = value; }
    setText(value) { this.text = value; }
    addClass() {}
    toggleClass() {}
    addEventListener(name, handler) { this.handlers[name] = handler; }
    replaceChildren() { this.children = []; }
    focus() {}
    querySelector(selector) { return selector === 'button:last-child' ? this.children.filter(child => child.tag === 'button').at(-1) : null; }
    click() { return this.handlers.click?.(); }
  }
  class Modal { constructor() { this.contentEl = new Element('div'); this.titleEl = new Element('h2'); } close() { this.contentEl.isConnected = false; } }
  class Setting {
    constructor(parent) { this.controlEl = parent.createDiv(); }
    addButton(configure) { const button = this.controlEl.createEl('button'); configure({ setButtonText(text) { button.text = text; return this; }, setCta() { return this; }, onClick(handler) { button.handlers.click = handler; return this; } }); return this; }
  }
  const { AimStartModal } = load('ui/modals/aim-start-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  const open = refreshModels => {
    const modal = new AimStartModal({}, async () => {}, [{ id: 'old-model', label: 'Old model' }], 'old-model', 'low', refreshModels);
    modal.onOpen();
    const all = []; const visit = el => { all.push(el); for (const child of el.children) visit(child); }; visit(modal.contentEl);
    return { modal, all };
  };
  let calls = 0;
  const success = open(async () => { calls++; return [{ id: 'old-model', label: 'Old model' }, { id: 'new-model', label: 'New model' }]; });
  const refresh = success.all.find(el => el.tag === 'button' && el.text === 'Refresh model list');
  const model = success.all.find(el => el.tag === 'select' && el.attributes['aria-label'] === 'Model');
  refresh.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1); assert.equal(model.value, 'old-model');
  assert.deepEqual(model.children.map(option => option.value), ['old-model', 'new-model']);
  const changedSelection = open(async () => ({ models: [{ id: 'new-model', label: 'New model' }], message: 'partial provider error', preserveSelection: true }));
  const changedModel = changedSelection.all.find(el => el.tag === 'select' && el.attributes['aria-label'] === 'Model');
  const initialRequestId = changedSelection.modal.requestId;
  changedSelection.all.find(el => el.tag === 'button' && el.text === 'Refresh model list').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(changedModel.value, 'old-model'); assert.equal(changedSelection.modal.requestId, initialRequestId);
  assert.deepEqual(changedModel.children.map(option => option.value), ['new-model', 'old-model']);
  assert.ok(changedSelection.all.some(el => el.text === 'partial provider error'));
  const removedSelection = open(async () => [{ id: 'new-model', label: 'New model' }]);
  const removedModel = removedSelection.all.find(el => el.tag === 'select' && el.attributes['aria-label'] === 'Model');
  const removedRequestId = removedSelection.modal.requestId;
  removedSelection.all.find(el => el.tag === 'button' && el.text === 'Refresh model list').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(removedModel.value, 'new-model'); assert.notEqual(removedSelection.modal.requestId, removedRequestId);
  const failed = open(async () => { throw new Error('provider unavailable'); });
  failed.all.find(el => el.tag === 'button' && el.text === 'Refresh model list').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(failed.all.some(el => el.text.includes('provider unavailable')));
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
integrationTest('MS-04: createNote and createNoteAt write reasoning-level only for a manual topic', async () => {
  const { repo, contents, map, mapPath } = await reasoningFixture();
  for (const source of ['workspace', 'inherited']) {
    const n = await repo.createNote(`N ${source}`, 'm', map, mapPath, source, { reasoning: 'high' });
    assert.equal(rawLevel(contents, n.path), undefined, `createNote ${source}`);
    const at = await repo.createNoteAt(`A ${source}`, 'm', map, mapPath, source, `${repo.topicFolder(mapPath, 'Notes')}/A ${source}.md`, `id-${source}`, { reasoning: 'high' });
    assert.equal(rawLevel(contents, at.path), undefined, `createNoteAt ${source}`);
  }
  const m = await repo.createNote('N manual', 'm', map, mapPath, 'manual', { reasoning: 'high' });
  assert.equal(rawLevel(contents, m.path), 'high');
  const mDefault = await repo.createNote('N manual2', 'm', map, mapPath, 'manual');
  assert.equal(rawLevel(contents, mDefault.path), 'low');
  const mAt = await repo.createNoteAt('A manual', 'm', map, mapPath, 'manual', `${repo.topicFolder(mapPath, 'Notes')}/A manual.md`, 'id-manual', { reasoning: 'medium' });
  assert.equal(rawLevel(contents, mAt.path), 'medium');
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
  const item = tab.getSettingDefinitions().find(d => d.render && /Current model|目前模型|当前模型/.test(d.name));
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
  const again = h.tab.getSettingDefinitions().find(d => d.render && /Current model|目前模型|当前模型/.test(d.name));
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
