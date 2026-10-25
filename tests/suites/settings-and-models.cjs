const assert = require('node:assert/strict');
const { test, load, core, plain, obsidian, DEFAULT_SETTINGS, normalizeReasoningLevel } = require('../support.cjs');
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
test('Fix connection checks the chosen model service and quietly refreshes the other one', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const run = (model, claudeInstalled = true) => {
    const calls = [], plugin = Object.create(Plugin.prototype);
    Object.assign(plugin, { settings: { cliModel: 'gpt-test' },
      recheckCodex: async guide => { calls.push(['recheckCodex', guide]); }, recheckClaude: async () => { calls.push(['recheckClaude']); },
      openClaudeSetupGuide: () => calls.push(['claudeGuide']), claudeDiagnostic: () => ({ installed: claudeInstalled }),
      refreshModelDiscovery: async provider => { calls.push(['refresh', provider]); } });
    plugin.repairConnection(model);
    return calls;
  };
  assert.deepEqual(run('gpt-test'), [['recheckCodex', true], ['refresh', 'claude']]);
  assert.deepEqual(run(undefined), [['recheckCodex', true], ['refresh', 'claude']], 'no choice means the workspace model');
  assert.deepEqual(run('claude:sonnet'), [['recheckClaude'], ['refresh', 'codex']]);
  assert.deepEqual(run('claude:sonnet', false), [['claudeGuide'], ['refresh', 'codex']], 'a missing CLI opens its setup guide');
});
