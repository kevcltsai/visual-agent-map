// P4 / ticket 06 P2: `圖表: 關` in an old style file, upgraded into a block (the switch is written into the block's format rules),
// stops the background chart step for research and synthesis, through the real plugin gate and the real AiTaskService over a
// scripted runtime. Without the line the chart step runs as on origin/main (integration). The old styleDiagrams gate is gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const M = loadSource(`
export { NoteStyleStore } from "./ai/note-style-store";
export { AiTaskService } from "./core/ai-task-service";
`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const P1 = 'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.';
const NOTE = `${P1}\n\nThe pupa stage lasts 5 days.`;
const TIMELINE = 'timeline\n  title Life cycle\n  3 days : Larva\n  5 days : Pupa';
const OLD_FILES = {
  'WS/S/Off.md': '---\n圖表: 關\n---\n## A\ntext\n',
  'WS/S/On.md': '---\ntone: plain\n---\n## A\ntext\n'
};

function rig() {
  const calls = [];
  const runtime = {
    runTask: async (prompt, _model, _effort, schema) => {
      calls.push(prompt);
      // The main task answers a plain note; the chart step answers one timeline anchored in the note.
      return JSON.stringify(schema?.properties?.charts
        ? { charts: [{ anchor: P1, shape: 'stages', mermaid: TIMELINE }] }
        : { summary: 'S', detail: NOTE, suggestions: [], visualReferences: [] });
    }
  };
  const service = new M.AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false,
    diagramsEnabled: () => true, mermaidParses: async () => true, codexRuntime: () => runtime, claudeRuntime: () => runtime
  });
  const settings = { detailTemplates: [], promptPresets: [], workspaceFolder: 'WS', language: 'en', noteStylesFolder: 'WS/S' };
  const files = { ...OLD_FILES };
  const under = folder => Object.keys(files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  const port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async path => files[path], folderExists: folder => Object.keys(files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async () => {}, create: async (path, content) => { files[path] = content; }, trash: async path => { delete files[path]; }
  };
  const store = new M.NoteStyleStore({ settings: () => settings, port, save: async () => {} });
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {}, workspace: { getLeavesOfType: () => [] } };
  plugin.logs = { appendLog() {} };
  plugin.mutate = async work => { await work(); };
  plugin.aiTasks = service;
  return { service, store, plugin, calls };
}

async function run(styleId, mode) {
  const h = rig();
  await h.store.refresh();
  assert.equal((await h.store.upgradeLegacy()).status, 'done');
  await h.store.refresh();
  const fields = h.store.runStyle({ ...(styleId ? { topic: { template: styleId } } : {}), outputLanguage: 'en' }).contextFields;
  const context = { title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do it', ancestors: '', sourceContext: '', mode, researchMode: 'local', researchDepth: 'fast', visualMode: 'auto', outputLanguage: 'en', addCharts: true, ...fields };
  const result = await h.service.askModel(context, 'gpt-6-luna', 'low');
  const applied = [];
  h.plugin.addChartsAfterWrite({ path: 'A.md', context, detail: result.detail, model: 'gpt-6-luna', apply: async detail => { applied.push(detail); return true; } });
  await delay(30);
  assert.equal(styleId ? Boolean(fields.styleSelection) : true, true, 'the upgraded style runs as a block');
  return { calls: h.calls, detail: applied[0] ?? result.detail, mainCalls: 1 };
}

for (const mode of ['task', 'synthesize']) {
  test(`${mode}: 圖表 關 with global charts on and addCharts true makes no chart call and leaves no mermaid`, async () => {
    const off = await run('style:Off', mode);
    assert.equal(off.calls.length, 1, 'only the main call, no chart step');
    assert.ok(!off.detail.includes('```mermaid'));
  });
  test(`${mode}: a style without 圖表 charts exactly like a run with no style file`, async () => {
    const on = await run('style:On', mode);
    const none = await run(undefined, mode);
    assert.equal(on.calls.length, 2, 'main call plus one chart call');
    assert.equal(on.calls.length, none.calls.length);
    assert.ok(on.detail.includes('```mermaid') && none.detail.includes('```mermaid'));
    assert.equal(on.detail, none.detail);
  });
}
