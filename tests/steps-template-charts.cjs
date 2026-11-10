// Q3: the style decides whether the background chart step runs. A template or format rules without a ```mermaid block get
// no chart call; the built-in templates still get one; the old `圖表: 關` line, now written into a format rules text (P2),
// still stops it, and a mermaid block the user wrote in a section still gets its chart step. The format rules are a part
// of their own (Q1): the tests give them as the selection's format, not inside the template body.
// Runs the real AiTaskService and the plugin's addChartsAfterWrite over a scripted runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const M = loadSource(`
export { AiTaskService } from "./core/ai-task-service";
export { builtinTemplateText } from "./core/blocks/builtin";
export { selectionFromContext, assembleTaskPrompt, promptStepOf } from "./core/steps/task/assemble";
export { generalTaskPrompt } from "./core/steps/task/render";
export { splitTemplateZones } from "./core/blocks/template-block";
export { inLanguage, OBSIDIAN_FORMAT } from "./core/steps/_shared/fragments";
`);
const FROZEN_FORMATS = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'note-style-frozen', 'legacy-formats.json'), 'utf8'));
// legacyObsidianFormat(language, { diagrams: false, ... }) as the deleted upgrade module produced it, frozen in
// tests/fixtures/note-style-frozen/legacy-formats.json. A missing key throws.
function frozenLegacyFormat(language, preferences) {
  const key = `${language}:${JSON.stringify(Object.fromEntries(Object.entries(preferences).sort()))}`;
  const text = FROZEN_FORMATS.legacyFormats[key];
  if (typeof text !== 'string') throw new Error(`no frozen legacy format for ${key}`);
  return text;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const P1 = 'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.';
const NOTE = `${P1}\n\nThe pupa stage lasts 5 days.`;
const TIMELINE = 'timeline\n  title Life cycle\n  3 days : Larva\n  5 days : Pupa';

function rig() {
  const calls = [];
  const runtime = {
    runTask: async (prompt, _model, _effort, schema) => {
      calls.push(prompt);
      return JSON.stringify(schema?.properties?.charts
        ? { charts: [{ anchor: P1, shape: 'stages', mermaid: TIMELINE }] }
        : { summary: 'S', detail: NOTE, suggestions: [], visualReferences: [] });
    }
  };
  const service = new M.AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false,
    diagramsEnabled: () => true, mermaidParses: async () => true, codexRuntime: () => runtime, claudeRuntime: () => runtime
  });
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {}, workspace: { getLeavesOfType: () => [] } };
  plugin.logs = { appendLog() {} };
  plugin.mutate = async work => { await work(); };
  plugin.aiTasks = service;
  return { service, plugin, calls };
}

const base = mode => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do it', ancestors: '', sourceContext: '', mode, researchMode: 'local', researchDepth: 'fast', visualMode: 'auto', outputLanguage: 'en', addCharts: true });

async function run(mode, extra = {}) {
  const h = rig();
  const context = { ...base(mode), ...extra };
  const result = await h.service.askModel(context, 'gpt-6-luna', 'low');
  const applied = [];
  h.plugin.addChartsAfterWrite({ path: 'A.md', context, detail: result.detail, model: 'gpt-6-luna', apply: async detail => { applied.push(detail); return true; } });
  await delay(30);
  return { calls: h.calls, detail: applied[0] ?? result.detail, prompt: h.calls[0] };
}

const noMermaid = body => body.split('\n').filter(line => !line.includes('```mermaid')).join('\n');
/** The built-in format rules with the old diagrams switch applied, the way the upgrade writes it into a block. */
const diagramsOff = body => body.replace(M.inLanguage(M.OBSIDIAN_FORMAT, 'en'), () => frozenLegacyFormat('en', { callouts: 'auto', diagrams: false, tables: true, tasks: true, highlight: true }));
const withTemplate = (body, id = 'standard', format) => ({ styleSelection: { ...M.selectionFromContext(base('task'), 'en'), template: { id, body }, ...(format === undefined ? {} : { format: { id: 'file:F', body: format } }) } });
const STANDARD_FORMAT = M.inLanguage(M.OBSIDIAN_FORMAT, 'en');

for (const mode of ['task', 'synthesize']) {
  test(`${mode}: a template without a mermaid block makes no chart call and leaves no mermaid`, async () => {
    const format = noMermaid(STANDARD_FORMAT);
    assert.ok(STANDARD_FORMAT.includes('```mermaid'), 'the built-in standard format has one');
    assert.ok(!M.builtinTemplateText('standard', 'en').includes('```mermaid'), 'the built-in standard sections have none');
    assert.ok(!format.includes('```mermaid'));
    const r = await run(mode, withTemplate(M.builtinTemplateText('standard', 'en'), 'standard', format));
    assert.equal(r.calls.length, 1, 'only the main call');
    assert.ok(!r.detail.includes('```mermaid'));
    assert.ok(!r.prompt.includes('```mermaid'), 'the prompt the model got has no mermaid block either');
  });
  for (const id of ['standard', 'textbook']) {
    test(`${mode}: the built-in ${id} template still gets one chart call`, async () => {
      const r = await run(mode, withTemplate(M.builtinTemplateText(id, 'en'), id));
      assert.equal(r.calls.length, 2, 'main call plus one chart call');
      assert.ok(r.detail.includes('```mermaid'));
    });
  }
  test(`${mode}: no styleSelection (today's path) still gets one chart call`, async () => {
    const r = await run(mode);
    assert.equal(r.calls.length, 2);
  });
  test(`${mode}: the old 圖表 off switch, as the upgrade writes it into the format rules, still stops the chart step`, async () => {
    const r = await run(mode, withTemplate(M.builtinTemplateText('standard', 'en'), 'standard', diagramsOff(STANDARD_FORMAT)));
    assert.equal(r.calls.length, 1);
    assert.ok(!r.detail.includes('```mermaid'));
    assert.ok(!r.prompt.includes('```mermaid'));
  });
  test(`${mode}: the old styleDiagrams flag is gone and changes nothing`, async () => {
    const r = await run(mode, { styleDiagrams: false });
    assert.equal(r.calls.length, 2);
  });
  test(`${mode}: charts off in the format rules but a mermaid block in the user's own section: the chart step still runs (locked behaviour, counter 3)`, async () => {
    const own = '## 流程\n畫一張流程圖：\n```mermaid\nflowchart TD\n  A --> B\n```\n';
    const format = diagramsOff(STANDARD_FORMAT);
    assert.ok(format.length > 0 && !format.includes('```mermaid'));
    assert.equal(new M.AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, diagramsEnabled: () => true }).chartEligible({ ...base(mode), ...withTemplate(own, 'standard', format) }), true);
    const r = await run(mode, withTemplate(own, 'standard', format));
    assert.equal(r.calls.length, 2, 'main call plus the chart call');
  });
}

test('chartEligible keeps its existing conditions first and does not throw on other contexts', () => {
  const { service } = rig();
  const format = noMermaid(STANDARD_FORMAT);
  assert.equal(service.chartEligible({ ...base('task'), ...withTemplate(M.builtinTemplateText('standard', 'en'), 'standard', format) }), false);
  assert.equal(service.chartEligible({ ...base('task') }), true);
  assert.equal(service.chartEligible({ ...base('decompose') }), false);
  assert.equal(service.chartEligible({ ...base(undefined), mode: undefined }), false);
  assert.equal(service.chartEligible({ ...base('task'), countRepair: true }), false);
  assert.equal(service.chartEligible({ ...base('task'), addCharts: false }), false);
  const custom = { id: 'x', name: 'X', sections: [{ id: 's1', name: 'A', description: 'text', role: 'none', aliases: [] }] };
  assert.doesNotThrow(() => service.chartEligible({ ...base('task'), detailTemplate: custom }));
});

test('generalTaskPrompt reads styleSelection when present and is unchanged without it', () => {
  const context = base('task');
  const plain = M.generalTaskPrompt(context, 'en');
  assert.equal(M.generalTaskPrompt({ ...context, styleSelection: M.selectionFromContext(context, 'en') }, 'en'), plain);
  const stripped = M.generalTaskPrompt({ ...context, ...withTemplate(M.builtinTemplateText('standard', 'en'), 'standard', noMermaid(STANDARD_FORMAT)) }, 'en');
  assert.notEqual(stripped, plain);
  assert.ok(!stripped.includes('```mermaid'));
});

test('the assembler reports charts === false for a template without a mermaid block', () => {
  const context = base('task');
  const sel = { ...M.selectionFromContext(context, 'en'), template: { id: 'standard', body: M.builtinTemplateText('standard', 'en') }, format: { id: 'file:F', body: noMermaid(STANDARD_FORMAT) } };
  assert.equal(M.assembleTaskPrompt(sel, 'research', context, 'en').charts, false);
  assert.equal(M.assembleTaskPrompt(M.selectionFromContext(context, 'en'), 'research', context, 'en').charts, true);
});
