// Characterization of how AiTaskService picks the runtime id (Claude or Codex) for a model: the model check, the task
// prompt branch and the chart prompt branch. It pins what a refactor onto the runtime capabilities must keep, and that
// the check starts no runtime and reads no plugin directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');
const { AiTaskService } = load('core/ai-task-service.ts');

const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const NOTE = 'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.\n\nThe pupa stage lasts 5 days.';
const CHART_REPLY = JSON.stringify({ charts: [] });
const context = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });
const chartContext = (extra = {}) => context({ outputLanguage: 'en', addCharts: true, visualMode: 'auto', ...extra });

/** A service over a scripted runtime that records every runtime request, runtime construction and pluginDirectory read. */
function rig({ reply = () => GOOD } = {}) {
  const state = { directoryReads: 0, claudeRuntime: 0, codexRuntime: 0, calls: [], exchanges: 0 };
  const runtime = {
    runTask: async (prompt, model, effort, schema, controls) => {
      state.calls.push({ prompt, model, effort, schema, controls });
      controls.onRequest?.({ via: 'fake' });
      return reply(prompt);
    }
  };
  const log = new Proxy({}, { get: () => () => { state.exchanges++; } });
  const service = new AiTaskService({
    pluginDirectory: () => { state.directoryReads++; return '/plugin'; }, language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => true, exchanges: () => log, mermaidParses: async () => true,
    codexRuntime: () => { state.codexRuntime++; return runtime; },
    claudeRuntime: () => { state.claudeRuntime++; return runtime; }
  });
  return { service, state };
}
const usesStructuredOutput = call => call.prompt.includes('StructuredOutput');

test('an unsupported Claude model is refused before any runtime, plugin directory or exchange is touched', async () => {
  const h = rig();
  await assert.rejects(h.service.askModel(context(), 'claude:not-a-model', 'low'), error => error.message === translate('en', 'ui.claude_model_is_not_supported_0', 'claude:not-a-model'));
  assert.equal(h.state.directoryReads, 0); assert.equal(h.state.claudeRuntime, 0); assert.equal(h.state.codexRuntime, 0);
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.exchanges, 0);
});

test('the timeout check runs before the model check', async () => {
  const h = rig();
  await assert.rejects(h.service.askModel(context({ timeoutMs: 1 }), 'claude:not-a-model', 'low'), error => error.message === 'Invalid AI task timeout.');
  assert.equal(h.state.directoryReads, 0); assert.equal(h.state.calls.length, 0);
});

test('the task prompt asks for StructuredOutput only on Claude, and the runtime gets the provider model id', async () => {
  const claude = rig(), codex = rig();
  await claude.service.askModel(context(), 'claude:sonnet', 'low');
  await codex.service.askModel(context(), 'gpt-6-luna', 'low');
  assert.equal(claude.state.calls.length, 1); assert.equal(codex.state.calls.length, 1);
  assert.equal(usesStructuredOutput(claude.state.calls[0]), true); assert.equal(usesStructuredOutput(codex.state.calls[0]), false);
  assert.equal(claude.state.calls[0].model, 'sonnet'); assert.equal(codex.state.calls[0].model, 'gpt-6-luna');
  assert.equal(claude.state.claudeRuntime, 1); assert.equal(claude.state.codexRuntime, 0);
  assert.equal(codex.state.codexRuntime, 1); assert.equal(codex.state.claudeRuntime, 0);
  // Measured on 32971ab: one askModel call reads the plugin directory exactly once (the runtime choice reads none).
  assert.equal(claude.state.directoryReads, 1); assert.equal(codex.state.directoryReads, 1);
});

test('the chart prompt asks for StructuredOutput only on Claude, for chartDetail and addDiagramsToDetail', async () => {
  for (const model of ['claude:sonnet', 'gpt-6-luna']) {
    const expected = model.startsWith('claude:');
    const viaChart = rig({ reply: () => CHART_REPLY });
    await viaChart.service.chartDetail({ input: chartContext(), detail: NOTE, model });
    assert.equal(viaChart.state.calls.length, 1, model); assert.equal(usesStructuredOutput(viaChart.state.calls[0]), expected, `chartDetail ${model}`);
    const viaDiagrams = rig({ reply: () => CHART_REPLY });
    await viaDiagrams.service.addDiagramsToDetail({ title: 'Goal', detail: NOTE, language: 'en', model });
    assert.equal(viaDiagrams.state.calls.length, 1, model); assert.equal(usesStructuredOutput(viaDiagrams.state.calls[0]), expected, `addDiagramsToDetail ${model}`);
  }
});
