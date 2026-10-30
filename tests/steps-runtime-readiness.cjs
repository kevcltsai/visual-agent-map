// Characterization of how the plugin reads the AI runtime for readiness, the first-use notice, the Claude pre-start, the
// reasoning-effort menu and "Fix connection" (C3 ticket 05). Written against the code before the move: every exit of
// aiReadyForModel and every observable of its neighbours is pinned, so moving them behind AiRuntime changes nothing.
// Synthetic: no process, no AI, no vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { makeNotice } = require('./support-dom.cjs');

const notices = [];
const modals = [];
class Modal { constructor(app) { this.app = app; } open() { modals.push(this); } close() {} }
const { default: Plugin } = S.load('main.ts', { obsidian: { ...S.obsidian, Modal, Notice: makeNotice(notices) } });

// Errors the plugin makes itself belong to the loaded module's realm (the harness runs it in a vm context), so
// `instanceof Error` is true for those only. This one is taken from a real throw inside the plugin.
const PluginError = (() => { try { new Plugin().pluginDirectory.call({ app: { vault: { adapter: {} } } }); } catch (error) { return error.constructor; } throw new Error('no plugin error to borrow'); })();
const list = values => [...values];

const CLAUDE = 'claude:sonnet';
const CODEX = 'gpt-test';

// A plugin whose outside world is counted: discovery refreshes per provider, diagnostics, guides, log lines, saved data.
function fixture({ cliModel = CODEX, refresh = async provider => ({ provider, status: 'ready', models: [CLAUDE, CODEX] }), codexInstalled = true } = {}) {
  notices.length = 0; modals.length = 0;
  const plugin = new Plugin();
  const seen = { refresh: [], codexDiag: 0, codexGuide: 0, claudeGuide: 0, logs: [], saved: [] };
  plugin.app = { vault: {}, fileManager: {} };
  plugin.settings = { ...plugin.settings, cliModel };
  plugin.logs = { appendLog: (level, message) => seen.logs.push([level, message]) };
  plugin.codexDiagnostic = () => { seen.codexDiag++; return { installed: codexInstalled }; };
  plugin.refreshModelDiscovery = async provider => { seen.refresh.push(provider); return refresh(provider); };
  plugin.openCodexSetupGuide = () => { seen.codexGuide++; };
  plugin.openClaudeSetupGuide = () => { seen.claudeGuide++; };
  plugin.saveData = async data => { seen.saved.push(JSON.parse(JSON.stringify(data))); };
  return { plugin, seen };
}
const state = (status, models = []) => async provider => ({ provider, status, models });
const quiet = (seen, extra = {}) => assert.deepEqual({ notices: notices.length, logs: seen.logs.length, ...extra }, { notices: 0, logs: 0, ...extra });

// ---- A1: every exit of aiReadyForModel ----

test('C1 Claude missing opens the Claude guide and says no', async () => {
  const { plugin, seen } = fixture({ refresh: state('missing') });
  assert.equal(await plugin.aiReadyForModel(CLAUDE), false);
  assert.deepEqual([seen.claudeGuide, seen.codexGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [1, 0, 0, 0, ['claude'], 0]);
});

test('C2 Claude ready with the model says yes with no UI', async () => {
  const { plugin, seen } = fixture();
  assert.equal(await plugin.aiReadyForModel(CLAUDE), true);
  assert.deepEqual([seen.claudeGuide, seen.codexGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [0, 0, 0, 0, ['claude'], 0]);
});

test('C3 Claude ready without the model says no and shows nothing', async () => {
  const { plugin, seen } = fixture({ refresh: state('ready', ['claude:haiku']) });
  assert.equal(await plugin.aiReadyForModel(CLAUDE), false);
  assert.deepEqual([seen.claudeGuide, seen.codexGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [0, 0, 0, 0, ['claude'], 0]);
});

for (const status of ['error', 'loading', 'idle']) {
  test(`C4 Claude ${status} says no and shows nothing`, async () => {
    const { plugin, seen } = fixture({ refresh: state(status, [CLAUDE]) });
    assert.equal(await plugin.aiReadyForModel(CLAUDE), false);
    assert.deepEqual([seen.claudeGuide, seen.codexGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [0, 0, 0, 0, ['claude'], 0]);
  });
}

test('C5 Claude discovery that rejects rejects with the same error; nothing is logged or opened', async () => {
  const boom = new Error('x');
  const { plugin, seen } = fixture({ refresh: async () => { throw boom; } });
  await assert.rejects(plugin.aiReadyForModel(CLAUDE), error => error === boom);
  assert.deepEqual([seen.claudeGuide, seen.codexGuide, notices.length, seen.logs.length, seen.refresh], [0, 0, 0, 0, ['claude']]);
});

test('X1 Codex not installed opens the Codex guide without refreshing', async () => {
  const { plugin, seen } = fixture({ codexInstalled: false });
  assert.equal(await plugin.aiReadyForModel(CODEX), false);
  assert.deepEqual([seen.codexGuide, seen.claudeGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [1, 0, 0, 0, [], 1]);
});

test('X2 Codex ready with the model says yes with no UI', async () => {
  const { plugin, seen } = fixture();
  assert.equal(await plugin.aiReadyForModel(CODEX), true);
  assert.deepEqual([seen.codexGuide, seen.claudeGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [0, 0, 0, 0, ['codex'], 1]);
});

test('X3 Codex missing after the refresh opens the Codex guide and no notice', async () => {
  const { plugin, seen } = fixture({ refresh: state('missing') });
  assert.equal(await plugin.aiReadyForModel(CODEX), false);
  assert.deepEqual([seen.codexGuide, notices.length, seen.logs.length, seen.refresh, seen.codexDiag], [1, 0, 0, ['codex'], 1]);
});

test('X4 Codex ready without the model shows the unavailable notice only', async () => {
  const { plugin, seen } = fixture({ refresh: state('ready', ['other']) });
  assert.equal(await plugin.aiReadyForModel(CODEX), false);
  assert.deepEqual(notices, ['Current model is unavailable']);
  assert.deepEqual([seen.codexGuide, seen.claudeGuide, seen.logs.length, seen.refresh, seen.codexDiag], [0, 0, 0, ['codex'], 1]);
});

for (const status of ['error', 'loading', 'idle']) {
  test(`X5 Codex ${status} shows the unavailable notice only`, async () => {
    const { plugin, seen } = fixture({ refresh: state(status, [CODEX]) });
    assert.equal(await plugin.aiReadyForModel(CODEX), false);
    assert.deepEqual(notices, ['Current model is unavailable']);
    assert.deepEqual([seen.codexGuide, seen.claudeGuide, seen.logs.length, seen.refresh, seen.codexDiag], [0, 0, 0, ['codex'], 1]);
  });
}

test('X6 Codex discovery that throws logs one warning with the text and says no', async () => {
  // An Error of the plugin's own realm logs its message; anything else is logged as String(thrown) (this realm's Error
  // is "Error: boom2", a bare string is itself).
  for (const [thrown, text] of [[new PluginError('boom'), 'boom'], ['boom2', 'boom2'], [new Error('boom3'), 'Error: boom3']]) {
    const { plugin, seen } = fixture({ refresh: async () => { throw thrown; } });
    assert.equal(await plugin.aiReadyForModel(CODEX), false);
    assert.deepEqual(seen.logs, [['warn', `Codex App Server is not ready yet: ${text}`]]);
    assert.deepEqual([notices.length, seen.codexGuide, seen.claudeGuide, seen.refresh, seen.codexDiag], [0, 0, 0, ['codex'], 1]);
  }
});

test('X7 Codex diagnostic that throws rejects with the same error, outside the try', async () => {
  const boom = new Error('diag');
  const { plugin, seen } = fixture();
  plugin.codexDiagnostic = () => { throw boom; };
  await assert.rejects(plugin.aiReadyForModel(CODEX), error => error === boom);
  assert.deepEqual([seen.logs.length, notices.length, seen.codexGuide, seen.refresh], [0, 0, 0, []]);
});

test('codexReadyForAi is aiReadyForModel of the workspace model, for a Claude and a Codex model', async () => {
  for (const [cliModel, refreshed] of [[CLAUDE, 'claude'], [CODEX, 'codex']]) {
    const { plugin, seen } = fixture({ cliModel });
    assert.equal(await plugin.codexReadyForAi(), true);
    assert.deepEqual(seen.refresh, [refreshed]);
    const missing = fixture({ cliModel, refresh: state('missing') });
    assert.equal(await missing.plugin.codexReadyForAi(), false);
    assert.deepEqual([missing.seen.claudeGuide, missing.seen.codexGuide], cliModel === CLAUDE ? [1, 0] : [0, 1]);
  }
});

// ---- A2: the first-use notice ----

for (const [name, model, flag, other, provider] of [['Claude', CLAUDE, 'claudeUsageNoticeSeen', 'codexUsageNoticeSeen', 'claude'], ['Codex', CODEX, 'codexUsageNoticeSeen', 'claudeUsageNoticeSeen', 'codex']]) {
  test(`A2 ${name}: cancel keeps the flag and does not run; confirm saves once, flips only its flag and runs; the second time asks nothing`, async () => {
    const { plugin, seen } = fixture();
    let runs = 0;
    const run = async () => { runs++; };
    const before = JSON.parse(JSON.stringify(plugin.settings));
    assert.equal(before[flag], false);
    assert.equal(plugin.usageNoticePending(model), true);
    const cancelled = plugin.confirmAiUsage(model, run);
    await S.until(() => modals.length === 1);
    assert.equal(modals[0].provider, provider);
    modals[0].resolve(false);
    assert.equal(await cancelled, false);
    assert.deepEqual([runs, seen.saved.length, plugin.settings[flag], plugin.usageNoticePending(model)], [0, 0, false, true]);
    const confirmed = plugin.confirmAiUsage(model, run);
    await S.until(() => modals.length === 2);
    assert.equal(modals[1].provider, provider);
    modals[1].resolve(true);
    assert.equal(await confirmed, true);
    assert.equal(runs, 1);
    assert.equal(seen.saved.length, 1);
    assert.deepEqual(seen.saved[0], { ...before, [flag]: true });
    assert.deepEqual(Object.keys(seen.saved[0]), Object.keys(before));
    assert.equal(seen.saved[0][other], before[other]);
    assert.equal(plugin.usageNoticePending(model), false);
    assert.equal(await plugin.confirmAiUsage(model, run), true);
    assert.deepEqual([modals.length, runs, seen.saved.length], [2, 2, 1]);
  });

  test(`A2 ${name}: a model that is not ready opens no modal and runs nothing`, async () => {
    const { plugin, seen } = fixture({ refresh: state('missing') });
    let runs = 0;
    assert.equal(await plugin.confirmAiUsage(model, async () => { runs++; }), false);
    assert.deepEqual([modals.length, runs, seen.saved.length, plugin.usageNoticePending(model)], [0, 0, 0, true]);
  });
}

test('A2 usageNoticePending reads the flag of the model\'s own service', () => {
  const { plugin } = fixture();
  plugin.settings.claudeUsageNoticeSeen = true;
  assert.deepEqual([plugin.usageNoticePending(CLAUDE), plugin.usageNoticePending(CODEX)], [false, true]);
  plugin.settings.claudeUsageNoticeSeen = false; plugin.settings.codexUsageNoticeSeen = true;
  assert.deepEqual([plugin.usageNoticePending(CLAUDE), plugin.usageNoticePending(CODEX)], [true, false]);
});

// ---- A3: the Claude pre-start ----

function prewarmFixture() {
  const { plugin, seen } = fixture();
  const out = { prewarm: [], claude: 0, released: 0, directory: 0, reset: 0, dispose: 0 };
  plugin.pluginDirectory = () => { out.directory++; return '/plugin'; };
  plugin.aiRuntime.claude = directory => { out.claude++; return { prewarm: (...args) => { out.prewarm.push([directory, ...args]); return true; } }; };
  Object.assign(plugin.aiRuntime, { releaseWarm: () => { out.released++; }, reset: () => { out.reset++; }, dispose: () => { out.dispose++; } });
  return { plugin, out, seen };
}

test('A3 Claude: prewarmClaude and prewarmClaudeStep start the very command with the plugin folder, model id, effort, schema and web flag', () => {
  const { plugin, out } = prewarmFixture();
  plugin.settings.cliReasoning = 'auto';
  plugin.prewarmClaude('claude:sonnet', undefined);
  plugin.prewarmClaude('claude:opus', 'high', false, 'synthesize');
  plugin.prewarmClaude('claude:sonnet', 'auto', true, 'synthesize');
  const schemas = out.prewarm.map(call => call[3]);
  assert.ok(schemas.every(schema => schema && schema.type === 'object'));
  assert.deepEqual(out.prewarm.map(call => [call[0], call[1], call[2], call[4]]), [['/plugin', 'sonnet', 'low', true], ['/plugin', 'opus', 'high', false], ['/plugin', 'sonnet', 'medium', true]]);
  const stepSchema = { type: 'object', properties: { step: {} } };
  out.prewarm.length = 0;
  plugin.prewarmClaudeStep('claude:sonnet', 'auto', stepSchema);
  plugin.prewarmClaudeStep('claude:opus', 'high', stepSchema);
  assert.deepEqual(out.prewarm.map(call => [call[0], call[1], call[2], call[3] === stepSchema, call[4]]), [['/plugin', 'sonnet', 'low', true, false], ['/plugin', 'opus', 'high', true, false]]);
  assert.deepEqual([out.released, out.reset, out.dispose], [0, 0, 0]);
});

test('A3 Codex: prewarmClaude and prewarmClaudeStep only release the waiting process; no Claude runtime, no plugin folder', () => {
  const { plugin, out } = prewarmFixture();
  plugin.prewarmClaude(CODEX);
  assert.deepEqual([out.released, out.claude, out.directory, out.prewarm.length], [1, 0, 0, 0]);
  plugin.prewarmClaudeStep(CODEX, 'low', { type: 'object' });
  assert.deepEqual([out.released, out.claude, out.directory, out.prewarm.length], [2, 0, 0, 0]);
  plugin.releaseWarmClaude();
  assert.deepEqual([out.released, out.claude, out.directory, out.prewarm.length], [3, 0, 0, 0], 'releaseWarmClaude called directly drops the waiting process');
});

test('A3 a plugin folder that throws never fails the caller, starts nothing and releases nothing', () => {
  const { plugin, out } = prewarmFixture();
  plugin.pluginDirectory = () => { throw new Error('no folder'); };
  assert.doesNotThrow(() => plugin.prewarmClaude(CLAUDE));
  assert.doesNotThrow(() => plugin.prewarmClaudeStep(CLAUDE, 'low', { type: 'object' }));
  assert.deepEqual([out.released, out.prewarm.length], [0, 0]);
});

test('A3 after unload neither a Claude nor a Codex model starts or releases anything', () => {
  const { plugin, out } = prewarmFixture();
  plugin.repo = { dispose() {} }; plugin.expansionCoordinator = { stopAll() {} }; plugin.modelDiscovery = { invalidate() {} };
  plugin.onunload();
  assert.deepEqual([out.reset, out.dispose], [1, 1]);
  out.released = 0; out.claude = 0;
  plugin.prewarmClaude(CLAUDE); plugin.prewarmClaude(CODEX);
  plugin.prewarmClaudeStep(CLAUDE, 'low', { type: 'object' }); plugin.prewarmClaudeStep(CODEX, 'low', { type: 'object' });
  assert.deepEqual([out.released, out.claude, out.prewarm.length], [0, 0, 0]);
});

// ---- A4: the effort menu ----

test('A4 Claude efforts are a fresh array every time; changing one changes nothing else', () => {
  const { plugin } = fixture();
  const first = plugin.coffeeReasoningEfforts(CLAUDE);
  assert.deepEqual(list(first), ['low', 'medium', 'high']);
  first.push('x');
  const second = plugin.coffeeReasoningEfforts(CLAUDE);
  assert.deepEqual(list(second), ['low', 'medium', 'high']);
  assert.notEqual(second, first);
  assert.deepEqual(list(plugin.coffeeReasoningEfforts('claude:haiku')), ['low', 'medium', 'high']);
});

test('A4 Codex efforts come from model discovery, and an unknown model has none', () => {
  const { plugin } = fixture();
  plugin.modelDiscovery = { state: provider => { assert.equal(provider, 'codex'); return { reasoningEfforts: { 'gpt-test': ['low', 'xhigh'] } }; } };
  assert.deepEqual(list(plugin.coffeeReasoningEfforts('gpt-test')), ['low', 'xhigh']);
  assert.deepEqual(list(plugin.coffeeReasoningEfforts('gpt-unknown')), []);
  plugin.modelDiscovery = { state: () => ({}) };
  assert.deepEqual(list(plugin.coffeeReasoningEfforts('gpt-test')), []);
});

// ---- A5: Fix connection (real plugin) ----

test('A5 repairConnection checks the chosen service and quietly refreshes the other one', () => {
  const run = (model, { claudeInstalled = true, cliModel = CODEX } = {}) => {
    const { plugin } = fixture({ cliModel });
    const calls = [];
    Object.assign(plugin, {
      recheckCodex: async guide => { calls.push(['recheckCodex', guide]); }, recheckClaude: async () => { calls.push(['recheckClaude']); },
      openClaudeSetupGuide: () => calls.push(['claudeGuide']), claudeDiagnostic: () => ({ installed: claudeInstalled }),
      refreshModelDiscovery: async provider => { calls.push(['refresh', provider]); }
    });
    plugin.repairConnection(model);
    return calls;
  };
  assert.deepEqual(run(CODEX), [['recheckCodex', true], ['refresh', 'claude']]);
  assert.deepEqual(run(undefined), [['recheckCodex', true], ['refresh', 'claude']]);
  assert.deepEqual(run(''), [['recheckCodex', true], ['refresh', 'claude']]);
  assert.deepEqual(run('', { cliModel: CLAUDE }), [['recheckClaude'], ['refresh', 'codex']]);
  assert.deepEqual(run(CLAUDE), [['recheckClaude'], ['refresh', 'codex']]);
  assert.deepEqual(run(CLAUDE, { claudeInstalled: false }), [['claudeGuide'], ['refresh', 'codex']]);
});
