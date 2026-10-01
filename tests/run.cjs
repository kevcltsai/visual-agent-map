const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { test: nodeTest } = require('node:test');
const layer = process.argv.find(value => value.startsWith('--layer='))?.split('=')[1];
if (layer && !['unit', 'integration'].includes(layer)) throw new Error('Unknown test layer');
const test = (name, fn) => { if (!layer || layer === 'unit') nodeTest(name, fn); };
const integrationTest = (name, fn) => { if (!layer || layer === 'integration') nodeTest(name, fn); };
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, windowValues = {}) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console, TextDecoder, crypto: require('node:crypto').webcrypto, process, AbortController, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, window: { setTimeout, clearTimeout, ...windowValues } });
  return module.exports;
}
const core = load('map-model.ts');
const layout = load('map-layout.ts');
const logging = load('log-manager.ts');
const node = (id, parentId = null, collapsed = false) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed });
const map = nodes => ({ id: 'map', title: '測試心智圖', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const plain = obj => JSON.parse(JSON.stringify(obj));
const tree = () => [node('a'), node('b', 'a'), node('c', 'b'), node('d')];
test('rejects self links, descendant links, missing parent; allows detaching and reparenting', () => {
  assert.equal(core.canParent(tree(), 'a', 'a'), false);
  assert.equal(core.canParent(tree(), 'a', 'c'), false);
  assert.equal(core.canParent(tree(), 'b', 'missing'), false);
  assert.equal(core.canParent(tree(), 'b', 'd'), true);
  assert.equal(core.canParent(tree(), 'b', null), true);
});
test('collapse hides every descendant, not unrelated roots; nested collapse persists', () => {
  const nodes = tree(); nodes[0].collapsed = true; nodes[1].collapsed = true;
  assert.deepEqual(Array.from(core.visibleNodes(nodes), n => n.id), ['a', 'd']);
  nodes[0].collapsed = false;
  assert.deepEqual(Array.from(core.visibleNodes(nodes), n => n.id), ['a', 'b', 'd']);
});
test('single removal promotes immediate children but preserves deeper links', () => {
  const result = core.removeNodes(tree(), 'a', false);
  assert.deepEqual(Array.from(result, n => [n.id, n.parentId]), [['b', null], ['c', 'b'], ['d', null]]);
});
test('branch removal removes descendants and leaves other trees intact', () => {
  assert.deepEqual(Array.from(core.removeNodes(tree(), 'a', true), n => n.id), ['d']);
});
test('map round trip retains structure, viewport and collapse', () => {
  const source = map(tree()); source.nodes[1].collapsed = true; source.viewport = { x: -720, y: 83, zoom: .65 };
  assert.deepEqual(plain(core.parseMap(core.serializeMap(source))), source);
});
test('new branch layout keeps older coordinates while full layout arranges all levels', () => {
  const nodes = [
    { ...node('root'), x: 80, y: 80 },
    { ...node('older', 'root'), x: 440, y: 80 },
    { ...node('new-a', 'root'), x: 440, y: 80 },
    { ...node('new-b', 'root'), x: 440, y: 80 },
    { ...node('grandchild', 'new-a'), x: 440, y: 80 }
  ];
  const branch = layout.arrangeNewBranch(nodes, 'root', new Set(['new-a', 'new-b', 'grandchild']));
  assert.deepEqual(plain(branch.slice(0, 2)), plain(nodes.slice(0, 2)));
  for (const fresh of branch.slice(2)) for (const fixed of branch.slice(0, 2)) assert.ok(Math.abs(fresh.x - fixed.x) >= 300 || Math.abs(fresh.y - fixed.y) >= 190);
  assert.equal(branch[4].x, branch[2].x + 360);
  const full = layout.arrangeMap(nodes);
  assert.equal(full[4].x, full[2].x + 360);
  assert.notDeepEqual(plain(full), plain(nodes));
  const crowded = [{ ...node('root'), x: 0, y: 0 }, ...Array.from({ length: 5 }, (_, index) => ({ ...node(`old-${index}`, 'root'), x: 360, y: index * 440 })), { ...node('fresh', 'root'), x: 0, y: 0 }];
  const clear = layout.arrangeNewBranch(crowded, 'root', new Set(['fresh']));
  for (const old of clear.slice(1, 6)) assert.ok(Math.abs(clear[6].x - old.x) >= 300 || Math.abs(clear[6].y - old.y) >= 190);
});
test('malformed maps fail before data can be overwritten', () => {
  for (const nodes of [[node('a'), node('a')], [node('a', 'b'), node('b', 'a')], [node('a', 'missing')]]) {
    assert.throws(() => core.parseMap(core.serializeMap(map(nodes))));
  }
  assert.throws(() => core.parseMap('No map data'));
});
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
  assert.doesNotMatch(DEFAULT_SETTINGS.models, /claude:/);
  assert.equal(normalizeReasoningLevel('medium'), 'medium');
  assert.equal(normalizeReasoningLevel('high'), 'high');
  assert.equal(normalizeReasoningLevel('auto'), 'auto');
  assert.equal(normalizeReasoningLevel('unsupported'), 'low');
});
test('thinking artifacts route through shared core without view coupling', async () => {
  const artifacts = load('core/thinking-artifact.ts');
  const { ExperienceRouter } = load('core/experience-router.ts');
  const artifact = artifacts.createThinkingArtifact({
    id: 'artifact-1',
    kind: 'insight',
    title: 'A useful insight',
    content: 'The discussion exposed a tradeoff.',
    origin: { experience: 'coffee-tables', sessionId: 'table-1' },
    sources: [{ label: 'Coffee Table', experience: 'coffee-tables', sessionId: 'table-1' }]
  });
  assert.equal(artifact.version, 1);
  const router = new ExperienceRouter();
  let received;
  const unregister = router.register('visual-map', async value => { received = value; });
  assert.equal(router.canHandoff('visual-map'), true);
  await router.handoff({ target: 'visual-map', artifact });
  assert.deepEqual(plain(received), plain(artifact));
  unregister();
  assert.equal(router.canHandoff('visual-map'), false);
  await assert.rejects(() => router.handoff({ target: 'visual-map', artifact }), /not available/);
});

test('model identifiers select one provider and preserve stable Claude aliases', () => {
  const providers = load('ai/providers/provider.ts');
  assert.equal(providers.providerForModel('gpt-5.6-luna'), 'codex');
  assert.equal(providers.providerForModel('claude:sonnet'), 'claude');
  assert.equal(providers.providerModelId('claude:opus'), 'opus');
  assert.equal(providers.claudeModelChoice('claude:sonnet').model, 'sonnet');
  assert.equal(providers.claudeModelChoice('claude:unknown'), undefined);
});
test('automatic reasoning respects manual choices and local tasks avoid research', () => {
  const { effectiveReasoningLevel, researchGuidance, RESEARCH_SEARCH_BUDGET } = load('ai/task-policy.ts');
  const task = { title: 'Topic', summary: '', rules: '', detail: '', task: 'Organize', ancestors: '', mode: 'task', researchMode: 'local' };
  assert.equal(effectiveReasoningLevel(task, 'auto'), 'low');
  assert.equal(effectiveReasoningLevel({ ...task, mode: 'synthesize' }, 'auto'), 'medium');
  assert.equal(effectiveReasoningLevel({ ...task, sourceContext: 'x'.repeat(6_001) }, 'auto'), 'medium');
  assert.equal(effectiveReasoningLevel({ ...task, mode: 'synthesize' }, 'high'), 'high');
  assert.match(researchGuidance(task), /不要搜尋網路/);
  assert.match(researchGuidance(task), /現有資料不足/);
  assert.match(researchGuidance({ ...task, researchMode: 'research' }), /最多 3 次網路搜尋/);
  assert.equal(RESEARCH_SEARCH_BUDGET, 3);
});
test('research depth sets separate web search targets', () => {
  const { researchLimits } = load('ai/task-policy.ts');
  assert.deepEqual(plain(researchLimits('fast')), { searches: 1, sources: 2 });
  assert.deepEqual(plain(researchLimits('normal')), { searches: 3, sources: 5 });
  assert.deepEqual(plain(researchLimits('deep')), { searches: 6, sources: 10 });
  const { researchGuidance } = load('ai/task-policy.ts');
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'fast' }), /快速概覽/);
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'deep' }), /深入研究/);
});
test('explicit source context survives long existing Markdown', () => {
  const { buildPreparedTaskContext } = load('ai/context-builder.ts');
  const context = { title: 'Topic', summary: '', rules: '', detail: 'old '.repeat(8_000), task: 'Review selected note', ancestors: '', workingFindings: '', sourceContext: '來源：selected.md\nverified evidence', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  const prepared = buildPreparedTaskContext(context, 'test-model', 1_000);
  assert.match(prepared.context.sourceContext, /verified evidence/);
  assert.ok(prepared.context.detail.length < context.detail.length);
});
test('Codex executable discovery covers Homebrew, local npm, Volta, fnm, nvm and inherited PATH', () => {
  const { executableCandidates } = load('main.ts', { obsidian });
  const candidates = executableCandidates('codex', '/Users/friend', '/custom/npm/bin:/usr/bin', ['v20.18.0']);
  for (const path of [
    '/Users/friend/.local/bin/codex', '/Users/friend/.npm-global/bin/codex',
    '/Users/friend/.volta/bin/codex', '/Users/friend/.fnm/current/bin/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    '/Users/friend/.nvm/versions/node/v20.18.0/bin/codex', '/custom/npm/bin/codex'
  ]) assert.ok(candidates.includes(path), path);
  assert.deepEqual(Array.from(executableCandidates('/exact/codex', '/Users/friend', '', [])), ['/exact/codex']);
});

integrationTest('Codex launch uses its sibling Node with automatic nvm discovery and explicit paths', async () => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vam-codex-path-'));
  const home = path.join(temporary, 'Friend Home');
  const bin = path.join(home, '.nvm/versions/node/v24.14.0/bin');
  const executable = path.join(bin, 'codex');
  fs.mkdirSync(bin, { recursive: true });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nVAM_TEST_NODE=sibling exec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const model = process.env.VAM_TEST_NODE === 'sibling' ? 'sibling-node' : 'wrong-node';
  const result = message.method === 'model/list'
    ? { data: [{ id: model, model, displayName: model, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
    : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`, { mode: 0o755 });
  try {
    for (const configured of ['codex', executable]) {
      const environment = { HOME: home, PATH: '/usr/bin:/bin', VAM_TEST_PRESERVED: 'yes' };
      const before = { ...environment };
      const { default: Plugin } = load('main.ts', { obsidian }, { process: { env: environment } });
      const plugin = new Plugin();
      plugin.settings.codexPath = configured; plugin.manifest = { version: '0.7.1' };
      const runtime = plugin.runtime(temporary);
      try {
        assert.equal(runtime.options.executable, executable);
        const models = await runtime.listModels();
        assert.equal(models[0].model, 'sibling-node');
        assert.equal(runtime.options.env.PATH.split(path.delimiter)[0], bin);
        assert.equal(runtime.options.env.VAM_TEST_PRESERVED, 'yes');
        assert.deepEqual(environment, before);
      } finally { runtime.stop(); }
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('Codex launch retains fallback PATH without adding the working directory', () => {
  for (const environment of [{}, { PATH: '/custom/bin:/usr/bin:/custom/bin', KEEP: 'yes' }]) {
    const { default: Plugin } = load('main.ts', { obsidian, 'node:fs': { existsSync: () => false, readdirSync: () => [] } }, { process: { env: environment } });
    const plugin = new Plugin(); plugin.manifest = { version: '0.7.1' };
    const runtime = plugin.runtime('/vault');
    const dirs = Array.from(runtime.options.env.PATH.split(path.delimiter));
    assert.equal(runtime.options.executable, 'codex');
    assert.ok(!dirs.includes('.') && !dirs.includes(''));
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) assert.ok(dirs.includes(dir));
    if (environment.PATH) assert.ok(dirs.includes('/custom/bin'));
    assert.equal(dirs.length, new Set(dirs).size);
    assert.equal(runtime.options.env.KEEP, environment.KEEP);
  }
});

test('built-in Taiwan sample is bilingual, read-only source data with exploration and synthesis roots', () => {
  const sample = load('builtin-sample.ts');
  for (const language of ['zh-TW', 'en']) {
    assert.deepEqual(Array.from(sample.validateBuiltInSample(language)), []);
    const data = sample.builtInSample(language);
    assert.equal(data.map.nodes.filter(node => node.parentId === null).length, 2);
    assert.ok(Array.from(data.notes.values()).some(note => note.sourcePaths.length === 6));
    assert.equal(data.map.nodes.length, 12); assert.equal(data.assets.size, 5);
  }
  assert.notEqual(sample.builtInSample('zh-TW').map.title, sample.builtInSample('en').map.title);
});
test('official samples teach per-run requirements without active Rules in both languages', () => {
  const sample = load('builtin-sample.ts');
  assert.equal(sample.SAMPLE_CONTENT_VERSION, 3); assert.equal(sample.SAMPLE_TOUR_VERSION, 2);
  for (const locale of ['en', 'zh-TW']) {
    const data = sample.builtInSample(locale, false);
    for (const note of data.notes.values()) {
      assert.equal(note.rules, '');
      assert.match(note.detail, locale === 'en' ? /Requirements for this run[\s\S]*Additional requirements/ : /本次任務要求[\s\S]*本次附加要求/);
    }
    const root = data.notes.get('explore');
    assert.match(root.detail, locale === 'en' ? /Nine days; favor public transport; no more than two priorities per day/ : /九天八夜；以大眾運輸為主；每天最多安排兩個重點/);
  }
});
integrationTest('workspace repair creates only the configured base folders and is idempotent', async () => {
  const { repo, app } = fixture();
  assert.equal(repo.workspaceExists(), false);
  await repo.ensureWorkspace(); await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics') instanceof TFolder);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Inbox') instanceof TFolder);
});
integrationTest('workspace rediscovery finds valid custom VAM workspaces without accepting unrelated Map files', async () => {
  const { repo, app } = fixture();
  await repo.folder('Research/My Maps/Topics/Trip');
  await app.vault.create('Research/My Maps/Topics/Trip/Map.md', core.serializeMap(map([])));
  await repo.folder('Unrelated/Topics/Folder');
  await app.vault.create('Unrelated/Topics/Folder/Map.md', '# Not a VAM map');
  assert.deepEqual(Array.from(await repo.workspaceCandidates()), ['Research/My Maps']);
  assert.equal(repo.workspaceExists(), false);
});
test('general tasks retain existing Detail while decompose uses lightweight context', () => {
  const { buildPreparedTaskContext, extractJsonObject } = load('main.ts', { obsidian });
  const input = { title: 'Topic', summary: 'Existing summary', detail: 'Existing Detail', rules: '', task: 'Research the topic', ancestors: '', mode: 'task' };
  assert.equal(buildPreparedTaskContext(input, 'gpt-5.6-luna').context.detail, 'Existing Detail');
  assert.equal(buildPreparedTaskContext({ ...input, mode: 'decompose' }, 'gpt-5.6-luna').context.detail, '');
  assert.deepEqual(JSON.parse(extractJsonObject('我會先查核。\n{"summary":"ok","detail":"brace } in string"}\n完成。')), { summary: 'ok', detail: 'brace } in string' });
  assert.throws(() => extractJsonObject('沒有結構化回應'), /JSON object/);
});
test('Codex output schema requires every declared property', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'response-schema.json'), 'utf8'));
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
});
test('undo and redo preserve ordering; new edit invalidates redo', () => {
  const h = new core.History(); h.push('move'); h.push('delete'); assert.equal(h.undo(), 'delete'); assert.equal(h.undo(), 'move'); assert.equal(h.redo(), 'move'); h.push('edit'); assert.equal(h.canRedo, false); assert.equal(h.undo(), 'edit');
});
test('debug log manager timestamps, bounds, formats and clears in-memory entries', () => {
  const logs = new logging.LogManager(2);
  let changes = 0; const unsubscribe = logs.subscribe(() => changes++);
  logs.appendLog('debug', 'discarded'); logs.appendLog('info', 'runtime started'); logs.appendLog('error', 'runtime failed');
  const entries = logs.getLogs();
  assert.equal(entries.length, 2); assert.equal(entries[0].message, 'runtime started'); assert.match(entries[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(logging.formatDebugLogs(entries), /\[INFO\] runtime started/); assert.match(logging.formatDebugLogs(entries), /\[ERROR\] runtime failed/);
  entries[0].message = 'changed outside'; assert.equal(logs.getLogs()[0].message, 'runtime started');
  logs.clear(); assert.equal(logs.getLogs().length, 0); assert.equal(changes, 4);
  unsubscribe(); logs.appendLog('info', 'ignored by listener'); assert.equal(changes, 4);
});
integrationTest('AI exchange log persists exact request and reply with a bounded history and clear', async () => {
  const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-log-'));
  const file = path.join(directory, 'ai-exchanges.json');
  const errors = [];
  const sentinel = path.join(directory, 'unrelated.md'); fs.writeFileSync(sentinel, 'preserve');
  try {
    const exchanges = new AiExchangeLog(file, error => errors.push(error), 2);
    for (let index = 0; index < 3; index++) {
      const id = String(index);
      exchanges.begin({ id, startedAt: new Date().toISOString(), topic: `Topic ${index}`, mode: 'task', model: 'test', effort: 'low' });
      exchanges.sent(id, JSON.stringify({ input: `private prompt ${index}` }));
      exchanges.received(id, `raw response ${index}`);
      exchanges.completed(id);
    }
    await exchanges.flush();
    const restored = new AiExchangeLog(file, error => errors.push(error), 2);
    await restored.load();
    assert.deepEqual(plain(restored.getEntries().map(entry => entry.id)), ['1', '2']);
    assert.match(formatAiExchange(restored.getEntries()[1]), /private prompt 2/);
    assert.match(formatAiExchange(restored.getEntries()[1]), /raw response 2/);
    restored.clear(); await restored.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['ai-exchanges.json', 'unrelated.md']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('pending child suggestions persist across reload and disappear after dismissal', async () => {
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-proposals-'));
  const file = path.join(directory, 'pending-suggestions.json');
  const errors = [];
  try {
    const first = new PendingSuggestions(file, error => errors.push(error));
    first.set('topic.md', [{ title: 'A', task: 'Research A', contribution: 'Scope A', parentTitle: '' }]);
    await first.flush();
    const second = new PendingSuggestions(file, error => errors.push(error));
    await second.load();
    assert.equal(second.get('topic.md')[0].title, 'A');
    second.delete('topic.md'); await second.flush();
    const third = new PendingSuggestions(file, error => errors.push(error)); await third.load();
    assert.equal(third.has('topic.md'), false);
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('proposal persistence reports disk write failure to the caller', async () => {
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const errors = [];
  const store = new PendingSuggestions(path.join(os.tmpdir(), `vam-missing-${Date.now()}`, 'pending.json'), error => errors.push(error));
  store.set('topic.md', [{ title: 'A', task: 'Research A', contribution: '' }]);
  await assert.rejects(store.flush());
  assert.equal(errors.length, 1);
});
test('debug log command opens the custom modal and exposes copy and clear actions', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const modal = fs.readFileSync(path.join(root, 'ui/modals/debug-log-modal.ts'), 'utf8');
  assert.match(source, /addLocalizedCommand\("open-debug-log"/); assert.match(source, /new DebugLogModal\(this\.app, this\.logs, this\.exchanges/);
  assert.match(modal, /navigator\.clipboard\.writeText/); assert.match(modal, /this\.logs\.clear\(\)/);
  assert.match(modal, /ui\.debug_log/);
  assert.match(modal, /this\.logs\.subscribe/);
  assert.match(source, /codexReadyForAi\(\)/);
  assert.match(source, /ui\.codex_app_server_is_ready_0/);
  assert.match(source, /AI 任務失敗/);
});
class TFolder { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = []; this.parent = null; } }
class TFile { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\.md$/, ''); this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''; this.parent = null; this.stat = { mtime: Date.now() }; } }
const obsidian = { setIcon: (parent, name) => { parent.iconName = name; }, Menu: class { addItem(callback) { callback({ setTitle() { return this; }, setWarning() { return this; }, onClick() { return this; } }); return this; } showAtMouseEvent() { return this; } },
  TFile, TFolder, App: class {}, Plugin: class {}, ItemView: class { constructor(leaf) { this.app = leaf.app; } async setState() {} }, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, FileSystemAdapter: class { getBasePath() { return '/vault'; } },
  normalizePath: value => value.replace(/\/+/g, '/').replace(/^\//, ''),
  parseYaml: text => Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const index = line.indexOf(':'); const raw = line.slice(index + 1).trim(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return [line.slice(0, index), value]; })),
  stringifyYaml: obj => Object.entries(obj).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n'
};
const { Repository, DEFAULT_SETTINGS, normalizeReasoningLevel } = load('repository.ts', { obsidian });
integrationTest('node plus adds a child without opening a duplicate right-click menu', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const events = new Map(), buttons = [];
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, setPointerCapture() {},
    addEventListener(name, handler) { events.set(`${tag}:${name}`, handler); if (tag === 'button') this.click = handler; }, removeEventListener() {}
  });
  const topic = node('parent');
  const view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map([['parent.md', [{ title: 'Idea', task: 'Investigate', contribution: '' }]]]) });
  view.stageEl = element('stage'); view.map = map([topic]);
  view.notes = new Map([[topic.id, { title: 'Parent', summary: '', status: 'completed' }]]);
  view.render = () => {};
  let added = 0, opened = [], details = [], next = [];
  view.addNode = () => { added++; }; view.enqueue = work => work(); view.openNodePanel = (topic, mode) => opened.push([topic.id, mode]);
  view.openDetails = topic => details.push(topic.id); view.openNextStep = topic => next.push(topic.id);
  view.renderNode(topic);
  const plus = buttons.find(button => button.text === '+');
  assert.equal(plus['aria-label'], 'Add subtopic manually');
  plus.click({ stopPropagation() {} });
  assert.equal(added, 1);
  const badge = buttons.find(button => button.text === 'View 1 expansion suggestions');
  badge.click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === 'How would you like to explore next?').click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === 'Structure and links').click({ stopPropagation() {} });
  assert.deepEqual(opened, [[topic.id, 'proposals'], [topic.id, 'structure']]); assert.deepEqual(next, [topic.id]);
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  events.get('div:pointerup')({ type: 'pointerup', clientX: 0, clientY: 0 });
  assert.deepEqual(details, [topic.id]);
  assert.equal(opened.filter(([, mode]) => mode === 'edit').length, 0);
  view.suppressClickUntil = 0; events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.deepEqual(details, [topic.id, topic.id]);
  events.get('div:keydown')({ key: 'Enter', target: view.stageEl.children[0] });
  assert.deepEqual(details, [topic.id, topic.id, topic.id]);
  assert.equal(events.has('div:contextmenu'), false);
});
integrationTest('Next Step reviews first expansion proposals in place and keeps existing proposal review', async () => {
  let closed = 0, expandCalls = 0, synthCalls = 0, created, saved, quickOptions, researchOptions, synthOptions; const notices = [];
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, get textContent() { return this.text; }, value: options.value ?? options.text ?? '', cls: options.cls ?? '', children: [], style: {}, dataset: {}, disabled: false,
    classList: { toggle(name, enabled) { this[name] = enabled; } },
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = name; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addEventListener(name, handler) { if (name === 'click') this.click = handler; if (name === 'change') this.change = handler; if (name === 'input') this.input = handler; },
    querySelector(selector) { const name = selector.slice(1); return find(this, item => item.cls.split(' ').includes(name)); },
    querySelectorAll(selector) { return all(this, item => selector === 'button[data-topic-run]' && item.tag === 'button' && item.dataset.topicRun !== undefined); },
    empty() { this.children = []; }, remove() { this.removed = true; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const button = (root, label) => find(root, item => item.tag === 'button' && item.text === label);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { closed++; this.onClose?.(); } }
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class { constructor(message) { notices.push(message); } } } });
  const checkedModels = [];
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), sources: { currentTopicId: 'current', currentLabel: 'Current topic included', synthesisLabel: 'Current topic and child topics included', synthesisTopics: ['Child A', 'Child B'], topics: async () => [], readTopic: async () => [] } };
  const modelSettings = { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, sources: plugin.sources };
  const modal = new NextStepModal({}, 'Parent', 'normal', 1, 1, plugin,
    async options => { researchOptions = options; },
    async (options, _direction, found, _failed, createdMap) => { expandCalls++; if (options.multiLayer) { quickOptions = options; createdMap(); } else found([{ title: 'Transport', task: 'Compare', contribution: '', parentTitle: '' }], async items => { created = items; }); },
    async (options, angles, drafted) => { synthCalls++; synthOptions = options; angles([{ title: 'Shared constraints', task: 'Find tradeoffs', contribution: 'Across children' }], async () => { drafted({ summary: 'Draft', detail: 'Detail' }, async (summary, detail) => { saved = [summary, detail]; }); }); }, modelSettings);
  modal.onOpen();
  assert.ok(find(modal.contentEl, item => /3 minutes.*avoid prolonged resource use/.test(item.text ?? '')));
  const cards = find(modal.contentEl, item => item.cls === 'vam-next-cards');
  const [research, expand, synthesize] = all(modal.contentEl, item => item.cls.includes('vam-next-research'));
  const requirements = find(modal.contentEl, item => item.tag === 'textarea');
  assert.equal(requirements.value, '');
  assert.equal(all(modal.contentEl, item => item.tag === 'textarea').length, 1);
  assert.equal(button(modal.contentEl, 'Save instructions'), undefined);
  requirements.value = 'Only this run';
  const researchChecks = all(research, item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(researchChecks.length, 2); assert.ok(researchChecks[0].checked); assert.ok(researchChecks[1].checked);
  assert.ok(find(research, item => item.text === 'Search for image references'));
  assert.ok(find(research, item => /Standard: aim for up to 3 web searches and 5 main sources/.test(item.text ?? '')), JSON.stringify(all(research, item => item.text).map(item => item.text)));
  const expandChecks = all(expand, item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(expandChecks.length, 3); assert.ok(expandChecks[0].checked); assert.ok(expandChecks[1].checked);
  assert.ok(find(expand, item => item.text === 'Search for image references'));
  assert.equal(all(research, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.equal(all(expand, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.equal(all(synthesize, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.ok(find(research, item => item.text === 'Allow web search'));
  assert.ok(find(expand, item => item.text === 'Allow web search'));
  assert.ok(find(synthesize, item => item.text === 'Allow web search'));
  assert.equal(find(synthesize, item => item.text === 'Does not copy full subtopic notes'), undefined);
  cards.children[1].click();
  assert.equal(research.style.display, 'none'); assert.equal(expand.style.display, '');
  expandChecks[0].checked = false; expandChecks[0].change();
  assert.equal(expandChecks[1].disabled, true); assert.equal(expandChecks[1].checked, false);
  button(expand, 'Review AI subtopic suggestions').click(); await tick();
  assert.equal(expandCalls, 1); assert.equal(closed, 0);
  const proposalCheck = find(expand.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  proposalCheck.checked = false; button(expand, 'Create subtopics').click(); await tick();
  assert.equal(created, undefined); assert.equal(expand.querySelector('.vam-next-status').text, 'Select at least one subtopic.');
  proposalCheck.checked = true;
  button(expand, 'Create subtopics').click(); await tick();
  assert.equal(created[0].title, 'Transport'); assert.equal(closed, 0);
  let firstCreated, firstAttempts = 0;
  const firstFlow = new NextStepModal({}, 'Parent', 'normal', 0, 0, plugin, async () => {}, async (_options, _direction, found, failed) => {
    firstAttempts++;
    if (firstAttempts === 1) { failed('No useful proposals'); return; }
    found([{ title: 'First idea', task: 'Explore it', contribution: '', parentTitle: '' }], async items => { firstCreated = items; });
  }, async () => {});
  firstFlow.onOpen(); find(firstFlow.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  const firstPanel = all(firstFlow.contentEl, item => item.cls.includes('vam-next-research'))[1];
  const firstRequirements = find(firstFlow.contentEl, item => item.tag === 'textarea'); firstRequirements.value = 'Keep this while retrying';
  button(firstPanel, 'Get expansion directions').click(); await tick();
  assert.equal(firstPanel.querySelector('.vam-next-status').text, 'No useful proposals');
  assert.equal(firstRequirements.value, 'Keep this while retrying'); assert.equal(closed, 0);
  button(firstPanel, 'Get expansion directions').click(); await tick();
  assert.ok(find(firstPanel.querySelector('.vam-next-result'), item => item.text === 'AI subtopic proposals'));
  const firstCheckbox = find(firstPanel.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  firstCheckbox.checked = false;
  button(firstPanel, 'Create subtopics').click(); await tick();
  assert.equal(firstCreated, undefined); assert.equal(firstPanel.querySelector('.vam-next-status').text, 'Select at least one subtopic.');
  firstCheckbox.checked = true;
  const firstName = find(firstPanel.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'text'); firstName.value = 'Edited idea';
  button(firstPanel, 'Create subtopics').click(); await tick();
  assert.equal(firstCreated[0].title, 'Edited idea'); assert.equal(closed, 0);
  const contentChoice = find(synthesize, item => item.tag === 'select' && item['aria-label'] === 'Topic synthesis content');
  assert.equal(contentChoice.value, 'full');
  assert.ok(find(synthesize, item => item.tag === 'li' && item.text === 'Child A'));
  assert.ok(find(synthesize, item => item.tag === 'li' && item.text === 'Child B'));
  contentChoice.value = 'summary'; contentChoice.change();
  assert.ok(find(synthesize, item => /Important conditions in the body may be omitted/.test(item.text ?? '')));
  cards.children[2].click(); button(synthesize, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(contentChoice.disabled, true);
  assert.equal(synthOptions.synthesisContent, 'summary');
  assert.equal(synthCalls, 1); assert.equal(closed, 0);
  assert.equal(synthOptions.researchMode, 'local');
  assert.ok(button(synthesize, 'Choose this direction'));
  button(synthesize, 'Get synthesis draft').click(); await tick();
  assert.equal(synthOptions.synthesisContent, 'summary');
  button(synthesize, 'Confirm update to parent topic').click(); await tick();
  assert.deepEqual(saved, ['Draft', 'Detail']); assert.equal(closed, 0);
  cards.children[0].click(); button(research, 'Confirm research task').click(); await tick();
  assert.equal(researchOptions.requirements, 'Only this run'); assert.equal(researchOptions.researchMode, 'research'); assert.equal(researchOptions.referenceGroups.length, 0);
  assert.equal(closed, 1); assert.equal(research.querySelector('.vam-next-result'), undefined);
  const quickModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, modal.expand, async () => {});
  quickModal.onOpen(); find(quickModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(quickModal.contentEl, 'Quickly explore a map').click();
  assert.equal(button(quickModal.contentEl, 'Review AI subtopic suggestions'), undefined);
  const quickNumbers = all(quickModal.contentEl, item => item.tag === 'input' && item.type === 'number');
  const [levelInput, , childrenInput] = quickNumbers;
  assert.equal(childrenInput.disabled, false);
  levelInput.value = '1'; levelInput.input();
  assert.equal(childrenInput.disabled, true);
  assert.equal(find(quickModal.contentEl, item => item.text === 'Not used when expanding only one level.').hidden, false);
  levelInput.value = '2'; levelInput.input();
  assert.equal(childrenInput.disabled, false);
  button(quickModal.contentEl, 'Create starter map now').click(); await tick();
  assert.equal(quickOptions.multiLayer, true); assert.equal(quickOptions.shallowResearch, false); assert.equal(quickOptions.layers, 2); assert.equal(quickOptions.firstLayerCount, 3); assert.equal(quickOptions.childrenPerParent, 2); assert.equal(closed, 2);
  assert.equal(quickOptions.researchMode, 'local'); assert.equal(quickOptions.referenceGroups.length, 0);
  const partial = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('部分子議題已建立，請重新開啟視窗。', false), async () => {});
  partial.onOpen(); find(partial.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(partial.contentEl, 'Quickly explore a map').click();
  button(partial.contentEl, 'Create starter map now').click(); await tick();
  assert.equal(closed, 3); assert.match(notices.at(-1), /重新開啟/);
  let emptyOptions;
  const empty = new NextStepModal({}, 'No children', 'normal', 0, 0, plugin, async () => {}, async () => {}, async options => { synthCalls++; emptyOptions = options; });
  empty.onOpen(); find(empty.contentEl, item => item.cls === 'vam-next-cards').children[2].click();
  const emptyPanel = all(empty.contentEl, item => item.cls.includes('vam-next-research'))[2];
  assert.match(emptyPanel.children[1].text, /no direct subtopics/i);
  button(emptyPanel, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(synthCalls, 1); assert.equal(emptyOptions, undefined);
  const failing = new NextStepModal({}, 'Parent', 'normal', 1, 1, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('Provider failed'), async () => {});
  failing.onOpen(); find(failing.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(failing.contentEl, 'Review AI subtopic suggestions').click(); await tick();
  assert.equal(all(failing.contentEl, item => item.cls.includes('vam-next-research'))[1].querySelector('.vam-next-status').text, 'Provider failed'); assert.equal(closed, 3);
  const failedResearch = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async (_options, _focus, _done, failed) => failed('Cannot start'), async () => {}, async () => {});
  failedResearch.onOpen(); button(failedResearch.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(closed, 3); assert.equal(all(failedResearch.contentEl, item => item.cls.includes('vam-next-research'))[0].querySelector('.vam-next-status').text, 'Cannot start');
  let acknowledged = 0, began = 0;
  let firstUseConfirmed = false;
  const firstUsePlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!firstUseConfirmed) { firstUseConfirmed = true; return false; } acknowledged++; await run(); return true; }, saveSettings: async () => { acknowledged++; } };
  const firstUse = new NextStepModal({}, 'Parent', 'normal', 1, 0, firstUsePlugin, async () => { began++; }, async () => {}, async () => {});
  firstUse.onOpen(); button(firstUse.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 0); assert.equal(button(firstUse.contentEl, 'Understand and run'), undefined); assert.equal(closed, 3);
  button(firstUse.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 1); assert.equal(acknowledged, 1); assert.equal(closed, 4);
  let pendingCalls = 0;
  let pendingConfirmed = false;
  const pendingPlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!pendingConfirmed) { pendingConfirmed = true; return false; } await run(); return true; }, saveSettings: async () => {} };
  const pendingModal = new NextStepModal({}, 'Parent', 'normal', 1, 1, pendingPlugin, async () => {}, async (_options, _direction, found) => { pendingCalls++; found([{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }], async () => {}); }, async () => {});
  pendingModal.onOpen(); find(pendingModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(pendingModal.contentEl, 'Review AI subtopic suggestions').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Understand and run'), undefined);
  button(pendingModal.contentEl, 'Create subtopics').click(); await tick();
  assert.ok(button(pendingModal.contentEl, 'Get expansion directions'));
  button(pendingModal.contentEl, 'Get expansion directions').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Understand and run'), undefined);
  let finishQuick, completedQuick = false, delayedOptions;
  const delayed = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async options => {
    delayedOptions = options;
    await new Promise(resolve => { finishQuick = resolve; });
    completedQuick = true;
  }, async () => {});
  delayed.onOpen(); find(delayed.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(delayed.contentEl, 'Quickly explore a map').click();
  const numbers = all(delayed.contentEl, item => item.tag === 'input' && item.type === 'number');
  numbers[0].value = '3'; numbers[1].value = '2'; numbers[2].value = '2'; numbers[0].input();
  const shallow = find(all(delayed.contentEl, item => item.cls.includes('vam-next-research'))[1], item => item.tag === 'input' && item.type === 'checkbox' && item.checked === false);
  shallow.checked = true;
  button(delayed.contentEl, 'Create starter map now').click(); await tick();
  assert.equal(closed, 4); assert.equal(completedQuick, false);
  assert.equal(delayedOptions.layers, 3); assert.equal(delayedOptions.firstLayerCount, 2); assert.equal(delayedOptions.childrenPerParent, 2); assert.equal(delayedOptions.shallowResearch, true);
  finishQuick(); await tick(); assert.equal(completedQuick, true); assert.equal(closed, 5);
  const invalid = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async () => assert.fail('over-limit task started'), async () => {});
  invalid.onOpen(); find(invalid.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(invalid.contentEl, 'Quickly explore a map').click();
  const invalidNumbers = all(invalid.contentEl, item => item.tag === 'input' && item.type === 'number'); invalidNumbers[0].value = '3'; invalidNumbers[1].value = '3'; invalidNumbers[2].value = '2'; invalidNumbers[0].input();
  assert.match(find(invalid.contentEl, item => item.tag === 'p' && item.text?.includes('exceeding the limit of 15')).text, /21 subtopics/);
  assert.equal(button(invalid.contentEl, 'Create starter map now').disabled, true);
  invalidNumbers[0].value = '2'; invalidNumbers[0].input();
  assert.equal(button(invalid.contentEl, 'Create starter map now').disabled, false);
  assert.ok(all(invalid.contentEl, item => item.tag === 'p').some(item => /3/.test(item.text ?? '') && /6/.test(item.text ?? '') && /9/.test(item.text ?? '')));
  assert.equal(closed, 5);
  let finishGuided, guidedFinished = false;
  const guidedModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (_options, _direction, found) => {
    await new Promise(resolve => { finishGuided = resolve; });
    found([{ title: 'Later', task: 'Explore', contribution: '' }], async () => {});
    guidedFinished = true;
  }, async () => {});
  guidedModal.onOpen(); find(guidedModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(guidedModal.contentEl, 'Get expansion directions').click(); await tick();
  assert.equal(closed, 5); assert.equal(guidedFinished, false);
  finishGuided(); await tick();
  assert.equal(guidedFinished, true); assert.ok(button(guidedModal.contentEl, 'Create subtopics'));
  button(guidedModal.contentEl, 'Create subtopics').click(); await tick();
  assert.equal(closed, 5);
  const settingsWrites = []; let researchAfterSave = false;
  const settingsModal = new NextStepModal({}, 'Parent', 'normal', 0, 0,
    { settings: { codexUsageNoticeSeen: true, models: 'model-a,model-b' }, aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {} },
    async () => { researchAfterSave = settingsWrites.length === 2; }, async () => {}, async () => {},
    { model: 'model-a', modelSource: 'workspace', reasoning: 'low', save: async patch => { settingsWrites.push(patch); } });
  settingsModal.onOpen();
  assert.equal(settingsModal.contentEl.children.find(item => item.cls.includes('vam-next-model')).children[0].text, 'Model and advanced settings');
  const modelSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Model');
  const reasoningSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Reasoning level');
  modelSelect.value = 'model-b'; modelSelect.change(); reasoningSelect.value = 'high'; reasoningSelect.change();
  assert.equal(researchAfterSave, false);
  button(settingsModal.contentEl, 'Confirm research task').click(); await tick();
  assert.deepEqual(plain(settingsWrites), [{ model: 'model-b', modelSource: 'manual' }, { reasoning: 'high' }]);
  assert.equal(checkedModels.at(-1), 'model-b');
  assert.equal(researchAfterSave, true);
  const closedBeforeCancel = closed;
  const cancelModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async options => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true })), async () => {});
  cancelModal.onOpen(); find(cancelModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(cancelModal.contentEl, 'Quickly explore a map').click(); button(cancelModal.contentEl, 'Create starter map now').click(); await tick();
  const taskCancel = find(cancelModal.contentEl, item => item.cls === 'vam-task-cancel');
  assert.equal(taskCancel.hidden, false); taskCancel.onclick(); await tick();
  assert.match(find(all(cancelModal.contentEl, item => item.cls.includes('vam-next-research'))[1], item => item.cls.includes('vam-next-status')).text, /cancelled/i);
  assert.equal(closed, closedBeforeCancel);
});
function fixture(language = 'zh-TW') {
  const files = new Map(), contents = new Map();
  const attach = item => { const folderPath = item.path.split('/').slice(0, -1).join('/'); item.parent = files.get(folderPath) || null; if (item.parent instanceof TFolder && !item.parent.children.includes(item)) item.parent.children.push(item); };
  const renameTree = (from, to) => { const entries = Array.from(files.entries()).filter(([p]) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a[0].length - b[0].length); for (const [old, item] of entries) { files.delete(old); const next = `${to}${old.slice(from.length)}`; item.path = next; item.name = next.split('/').at(-1); if (item instanceof TFile) { item.basename = item.name.replace(/\.md$/, ''); item.stat.mtime = Date.now(); const content = contents.get(old); contents.delete(old); contents.set(next, content); } files.set(next, item); } for (const [, item] of entries) attach(item); };
  const app = { vault: {
    getAbstractFileByPath: p => files.get(p),
    getMarkdownFiles: () => Array.from(files.values()).filter(file => file instanceof TFile && file.extension === 'md'),
    read: async file => contents.get(file.path), cachedRead: async file => contents.get(file.path),
    createFolder: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); return folder; },
    create: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    createBinary: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    process: async (file, change) => { contents.set(file.path, change(contents.get(file.path))); },
    adapter: {
      exists: async p => files.has(p),
      mkdir: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); },
      list: async p => ({ files: [...files.values()].filter(file => file instanceof TFile && file.parent?.path === p).map(file => file.path), folders: [...files.values()].filter(file => file instanceof TFolder && file.parent?.path === p).map(file => file.path) }),
      read: async p => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); return contents.get(p); },
      write: async (p, value) => { if (!files.has(p)) { const file = new TFile(p); files.set(p, file); attach(file); } contents.set(p, value); },
      process: async (p, change) => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); const next = change(contents.get(p)); contents.set(p, next); return next; }
    }
  }, metadataCache: { getFileCache: file => { const text = contents.get(file.path) || ''; return { frontmatter: text.includes('agent-map-node: true') ? { 'agent-map-node': true } : text.includes('visual-agent-map: true') ? { 'visual-agent-map': true } : {} }; }, getFirstLinkpathDest: link => Array.from(files.values()).find(file => file instanceof TFile && (file.basename === link || file.path.replace(/\.md$/, '') === link)) || null }, fileManager: { renameFile: async (item, target) => renameTree(item.path, target), trashFile: async () => {} } };
  return { app, contents, files, repo: new Repository(app, { ...DEFAULT_SETTINGS, language }) };
}
async function topicNote(repo, title = '題目', model = 'model-a', id = 'map-a') {
  const mapDoc = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = `Agent Workspace/Topics/${id}/Map.md`; await repo.ensureTopicFolders(`Agent Workspace/Topics/${id}`);
  return repo.createNote(title, model, mapDoc, mapPath, 'workspace');
}
integrationTest('editing note fields preserves latest AI detail and unrelated frontmatter', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo);
  contents.set(n.path, contents.get(n.path).replace('---\n', '---\ncustom: "retain me"\n'));
  await repo.updateNote(n.path, { detail: '## Nested heading\n\nAI result with $& and ```code```', newFindings: 'Fresh research', status: 'review' });
  await repo.updateNote(n.path, { title: '修改標題', model: 'model-b', reasoning: 'high', prompt: 'A task with $&' });
  const result = await repo.readNote(n.path);
  assert.equal(result.detail, '## Nested heading\n\nAI result with $& and ```code```'); assert.equal(result.prompt, 'A task with $&'); assert.equal(result.model, 'model-b'); assert.equal(result.status, 'completed');
  assert.equal(result.reasoning, 'high');
  assert.equal(result.newFindings, 'Fresh research');
  assert.match(contents.get(n.path), /## Working Findings\n\nFresh research/);
  assert.match(contents.get(n.path), /custom: "retain me"/);
});
integrationTest('local research mode persists without changing older notes', async () => {
  const { repo } = fixture(); const n = await topicNote(repo);
  const original = await repo.readNote(n.path);
  assert.equal(original.researchMode, 'research');
  assert.equal(original.researchDepth, 'normal');
  assert.equal(original.visualMode, 'auto');
  await repo.updateNote(n.path, { researchMode: 'local', researchDepth: 'deep', visualMode: 'off' });
  const updated = await repo.readNote(n.path);
  assert.equal(updated.researchMode, 'local');
  assert.equal(updated.researchDepth, 'deep');
  assert.equal(updated.visualMode, 'off');
});
integrationTest('current summary is editable in the Markdown body', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Editable summary');
  assert.match(contents.get(n.path), /## Current Summary\n\n尚未形成結論/);
  await repo.updateNote(n.path, { summary: 'AI conclusion that can be edited' });
  assert.match(contents.get(n.path), /summary: "AI conclusion that can be edited"/);
  assert.match(contents.get(n.path), /## Current Summary\n\nAI conclusion that can be edited/);
  contents.set(n.path, contents.get(n.path).replace('## Current Summary\n\nAI conclusion that can be edited', '## Current Summary\n\nUser-edited conclusion'));
  assert.equal((await repo.readNote(n.path)).summary, 'User-edited conclusion');
});
integrationTest('English notes use English preview, pending summary, and managed reference labels', async () => {
  const { repo, app, contents } = fixture('en');
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  assert.match(contents.get(mapPath), /This file stores the mind map structure/);
  assert.doesNotMatch(contents.get(mapPath), /此檔案保存心智圖結構/);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  let markdown = contents.get(note.path);
  assert.match(markdown, /## Current Summary\n\nNo conclusion yet/);
  assert.match(markdown, /## Preview\n\nNo conclusion yet/);
  assert.match(markdown, /- Topic: \[\[/);
  assert.match(markdown, /- Mind map: \[\[/);
  assert.doesNotMatch(markdown, /尚未形成結論|## 預覽|所屬主題|所屬心智圖/);
  await repo.updateNote(note.path, { sourcePaths: ['Source.md'], detail: 'English detail' });
  markdown = contents.get(note.path);
  assert.match(markdown, /- Source topic: \[\[Source\]\]/);
  assert.equal((await repo.readNote(note.path)).preview, 'No conclusion yet');
  await repo.updateNote(note.path, { summary: 'English conclusion' });
  assert.equal((await repo.readNote(note.path)).preview, 'English conclusion');
  assert.match(contents.get(note.path), /## Preview\n\nEnglish conclusion/);
  const copy = await repo.duplicateNote(note.path, map, mapPath);
  assert.match(copy.path, /Route copy\.md$/);
  assert.throws(() => repo.file('Missing.md'), /File not found/);
});
integrationTest('language switch localizes only generated note scaffolding and preserves authored text', async () => {
  const { repo, app, contents } = fixture();
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  await repo.updateNote(note.path, { detail: 'Keep detail', sourcePaths: ['Source.md'] });
  const beforeSwitch = contents.get(note.path);
  repo.settings.language = 'en';
  assert.equal(contents.get(note.path), beforeSwitch);
  await repo.updateNote(note.path, { model: 'model-b' });
  let markdown = contents.get(note.path);
  assert.match(markdown, /## Preview\n\nNo conclusion yet/);
  assert.match(markdown, /## Current Summary\n\nNo conclusion yet/);
  assert.match(markdown, /- Topic: \[\[/);
  assert.match(markdown, /- Source topic: \[\[Source\]\]/);
  assert.match(markdown, /Keep detail/);
  assert.doesNotMatch(markdown, /## 預覽|尚未形成結論|所屬主題|來源議題/);
  await repo.updateNote(note.path, { preview: 'My own preview' });
  repo.settings.language = 'zh-TW';
  await repo.rebuildDerivedData();
  markdown = contents.get(note.path);
  assert.match(markdown, /## 預覽\n\nMy own preview/);
  assert.match(markdown, /## Current Summary\n\n尚未形成結論/);
  assert.match(markdown, /- 所屬主題：\[\[/);
  assert.match(markdown, /Keep detail/);
  assert.doesNotMatch(markdown, /## Preview|No conclusion yet/);
  assert.equal((await repo.readNote(note.path)).preview, 'My own preview');
});
integrationTest('editing a note heading updates its card title and survives later note writes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, '新的子議題');
  contents.set(n.path, contents.get(n.path).replace('# 新的子議題', '# 要如何推廣VAM'));
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
  await repo.updateNote(n.path, { summary: '新的摘要' });
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
  assert.match(contents.get(n.path), /title: "要如何推廣VAM"/);
  assert.match(contents.get(n.path), /^# 要如何推廣VAM$/m);
  await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
});
integrationTest('visual references are stored inside the editable Detail section', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Outfit');
  await repo.updateNote(n.path, { visualReferences: '### Navy + Beige\n\n![Navy + Beige](https://example.com/outfit.jpg)\n\n來源：https://example.com/page\n配色：navy / beige' });
  let note = await repo.readNote(n.path);
  assert.equal(note.visualReferences, '');
  assert.match(note.detail, /\*\*Navy \+ Beige\*\*/);
  assert.doesNotMatch(note.detail, /### 視覺參考/);
  assert.doesNotMatch(contents.get(n.path), /## Visual References/);
  await repo.updateNote(n.path, { visualReferences: '' });
  note = await repo.readNote(n.path);
  assert.equal(note.visualReferences, '');
  assert.doesNotMatch(contents.get(n.path), /## Visual References/);
});
integrationTest('managed references stay outside Detail and preserve user-authored content', async () => {
  const { repo, contents, app } = fixture(); const n = await topicNote(repo);
  const mapPath = await repo.createMap('Map A', [n]);
  await repo.rebuildDerivedData();
  let text = contents.get(n.path);
  assert.match(text, /visual-agent-map:references:start/);
  assert.match(text, /## Reference Links/);
  assert.match(text, /agent-map-references:/);
  assert.doesNotMatch((await repo.readNote(n.path)).detail, /關聯議題/);
  text = text.replace('<!-- visual-agent-map:detail:end -->', '<!-- visual-agent-map:detail:end -->\n\n## User notes\n\nUser content'); contents.set(n.path, text);
  await repo.updateNote(n.path, { detail: 'New detail' }); await repo.rebuildDerivedData();
  assert.match(contents.get(n.path), /User content/); assert.equal((await repo.readNote(n.path)).detail, 'New detail');
  assert.ok(app.vault.getAbstractFileByPath(mapPath));
});
integrationTest('a note cannot belong to two maps', async () => {
  const { repo } = fixture(); const n = await topicNote(repo, 'shared');
  await repo.createMap('One', [n]); await repo.createMap('Two', [n]);
  await assert.rejects(() => repo.rebuildDerivedData(), /同時出現在兩張心智圖/);
});
integrationTest('removing a node clears ownership and generated references while keeping the note', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'kept'); const mapPath = await repo.createMap('One', [n]);
  await repo.rebuildDerivedData(); const mapDoc = await repo.readMap(mapPath); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).mapId, ''); assert.doesNotMatch(contents.get(n.path), /visual-agent-map:references:start/); assert.doesNotMatch(contents.get(n.path), /agent-map-references:/);
});
integrationTest('maps keep independent layout and preserve Markdown prose', async () => {
  const { repo, contents } = fixture(); const firstNode = await topicNote(repo, 'first', 'gpt-5.6-terra', 'map-a'); const secondNode = await topicNote(repo, 'second', 'gpt-5.6-terra', 'map-b');
  const first = await repo.createMap('One', [firstNode]), second = await repo.createMap('Two', [secondNode]);
  contents.set(first, contents.get(first) + '\nUser annotation\n');
  const changed = await repo.readMap(first); changed.nodes[0].x = 600; changed.title = 'Renamed'; await repo.saveMap(first, changed);
  assert.equal((await repo.readMap(second)).nodes[0].x, 80); assert.match(contents.get(first), /User annotation/); assert.match(contents.get(first), /# Renamed/);
});
integrationTest('preview migration moves owned notes into a topic and unknown orphans into Inbox', async () => {
  const { repo, app } = fixture();
  await repo.folder('Agent Workspace/Maps'); await repo.folder('Agent Workspace/Nodes');
  const content = id => `---\nagent-map-node: true\nnode-id: "${id}"\ntitle: "${id}"\n---\n\n# ${id}\n\n## Prompt\n\n## Rules\n\n## Detail\n\nOld detail\n`;
  await app.vault.create('Agent Workspace/Nodes/a.md', content('a')); await app.vault.create('Agent Workspace/Nodes/orphan.md', content('orphan'));
  const legacy = map([node('a')]); legacy.title = 'Legacy'; legacy.nodes[0].path = 'Agent Workspace/Nodes/a.md';
  await app.vault.create('Agent Workspace/Maps/Legacy.md', core.serializeMap(legacy));
  const plan = await repo.legacyMigrationPlan(); assert.equal(plan.maps.length, 1); assert.deepEqual(plain(plan.orphanPaths), ['Agent Workspace/Nodes/orphan.md']);
  const mapping = await repo.migrateLegacyWorkspace(plan), next = mapping.get('Agent Workspace/Maps/Legacy.md');
  assert.equal(next, 'Agent Workspace/Topics/Legacy/Map.md');
  const movedMap = await repo.readMap(next); assert.match(movedMap.nodes[0].path, /\/Notes\/a\.md$/);
  assert.equal((await repo.readNote(movedMap.nodes[0].path)).topicState, 'active');
  assert.equal((await repo.inboxFiles()).length, 1); assert.equal((await repo.readNote((await repo.inboxFiles())[0].path)).topicState, 'inbox');
});
integrationTest('preview migration rolls back all completed moves when a later move fails', async () => {
  const { repo, app } = fixture();
  await repo.folder('Agent Workspace/Maps'); await repo.folder('Agent Workspace/Nodes');
  const content = `---\nagent-map-node: true\nnode-id: "a"\ntitle: "a"\n---\n\n# a\n`;
  await app.vault.create('Agent Workspace/Nodes/a.md', content);
  const legacy = map([node('a')]); legacy.title = 'Rollback'; legacy.nodes[0].path = 'Agent Workspace/Nodes/a.md';
  await app.vault.create('Agent Workspace/Maps/Rollback.md', core.serializeMap(legacy));
  const rename = app.fileManager.renameFile; let failed = false;
  app.fileManager.renameFile = async (item, target) => {
    if (!failed && target.includes('/Notes/')) { failed = true; throw new Error('controlled migration failure'); }
    await rename(item, target);
  };
  const plan = await repo.legacyMigrationPlan();
  await assert.rejects(() => repo.migrateLegacyWorkspace(plan), /controlled migration failure/);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Maps/Rollback.md'));
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Nodes/a.md'));
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics/Rollback/Map.md'), undefined);
});
integrationTest('external rename reconciliation only follows a unique matching node-id', async () => {
  const { repo, app, contents } = fixture(); const n = await topicNote(repo, 'External rename');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', doc = { id: 'map-a', title: 'Map A', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(doc));
  const renamed = 'Agent Workspace/Topics/map-a/Notes/External rename moved.md';
  await app.fileManager.renameFile(app.vault.getAbstractFileByPath(n.path), renamed);
  assert.equal(await repo.reconcileMissingNodePaths(), 1);
  assert.equal((await repo.readMap(mapPath)).nodes[0].path, renamed);

  const second = fixture(); const other = await topicNote(second.repo, 'Ambiguous rename');
  const otherMap = 'Agent Workspace/Topics/map-a/Map.md', otherDoc = { id: 'map-a', title: 'Map A', version: 1, nodes: [other], viewport: { x: 0, y: 0, zoom: 1 } };
  await second.app.vault.create(otherMap, core.serializeMap(otherDoc));
  const firstCandidate = 'Agent Workspace/Topics/map-a/Notes/Ambiguous one.md', secondCandidate = 'Agent Workspace/Topics/map-a/Notes/Ambiguous two.md';
  await second.app.fileManager.renameFile(second.app.vault.getAbstractFileByPath(other.path), firstCandidate);
  await second.app.vault.create(secondCandidate, second.contents.get(firstCandidate));
  assert.equal(await second.repo.reconcileMissingNodePaths(), 0);
  assert.equal((await second.repo.readMap(otherMap)).nodes[0].path, other.path);
});
integrationTest('new topics contain Map, Notes, Unassigned and Archive', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Topic A');
  assert.equal(mapPath, 'Agent Workspace/Topics/Topic A/Map.md');
  for (const name of ['Notes', 'Unassigned', 'Archive']) assert.ok(app.vault.getAbstractFileByPath(`Agent Workspace/Topics/Topic A/${name}`) instanceof TFolder);
});
integrationTest('unassigned and archived notes keep topic ownership but leave the map', async () => {
  const { repo, contents } = fixture(), mapPath = await repo.createMap('Lifecycle'), mapDoc = await repo.readMap(mapPath);
  const n = await repo.createNote('Knowledge', 'a', mapDoc, mapPath, 'workspace'); mapDoc.nodes.push(n); await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  const unassigned = await repo.moveUnique(n.path, repo.topicFolder(mapPath, 'Unassigned')); await repo.setLifecycle(unassigned, mapDoc.id, '', 'unassigned'); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  let note = await repo.readNote(unassigned); assert.equal(note.topicId, mapDoc.id); assert.equal(note.mapId, ''); assert.equal(note.topicState, 'unassigned'); assert.match(contents.get(unassigned), /狀態：未歸類/);
  const archived = await repo.moveUnique(unassigned, repo.topicFolder(mapPath, 'Archive')); await repo.setLifecycle(archived, mapDoc.id, '', 'archived'); await repo.rebuildDerivedData();
  note = await repo.readNote(archived); assert.equal(note.topicState, 'archived'); assert.match(contents.get(archived), /狀態：已封存/);
});
integrationTest('a missing Map can be rebuilt from topic Notes as root nodes', async () => {
  const { repo } = fixture(), root = 'Agent Workspace/Topics/Broken', placeholder = { id: 'stable-topic', title: 'Broken', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(root); await repo.createNote('Recovered', 'a', placeholder, `${root}/Map.md`, 'workspace');
  const path = await repo.rebuildMissingMap(root), rebuilt = await repo.readMap(path); assert.equal(rebuilt.id, 'stable-topic'); assert.equal(rebuilt.nodes.length, 1); assert.equal(rebuilt.nodes[0].parentId, null);
});
integrationTest('replacing AI synthesis preserves 預覽', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Synthesis');
  await repo.updateNote(n.path, { detail: 'Old synthesis', preview: 'Keep this manually written note' });
  await repo.updateNote(n.path, { detail: 'New synthesis', prompt: '' });
  const result = await repo.readNote(n.path); assert.equal(result.detail, 'New synthesis'); assert.equal(result.preview, 'Keep this manually written note'); assert.equal(result.prompt, '');
});
integrationTest('text undo uses field patches and preserves AI details arriving in between', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Original', 'a');
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.refreshCard = () => {}; view.updateHistoryButtons = () => {}; view.render = () => {};
  await view.noteChange(n, { title: 'Edited' }); await repo.updateNote(n.path, { detail: 'New AI answer' }); await view.travel(false);
  const note = await repo.readNote(n.path); assert.equal(note.title, 'Original'); assert.equal(note.detail, 'New AI answer');
});
test('AI result formatting always produces the canonical knowledge structure', async () => {
  const { canonicalDetail } = load('main.ts', { obsidian });
  const result = canonicalDetail('New analysis');
  for (const heading of ['核心結論', '關鍵知識', '證據與來源', '取捨與限制', '待確認事項', '更新紀錄']) assert.match(result, new RegExp(`### ${heading}`));
  assert.equal((result.match(/New analysis/g) || []).length, 1);
  const english = canonicalDetail('New analysis', 'en');
  for (const heading of ['Core conclusions', 'Key knowledge', 'Evidence and sources', 'Tradeoffs and limitations', 'Open questions', 'Update log']) assert.match(english, new RegExp(`### ${heading}`));
  assert.doesNotMatch(english, /核心結論|尚待補充|整理為結構化知識/);
  const bilingual = canonicalDetail('### 核心結論\n\n中文結論\n\n### 證據與來源\n\n[[來源.md]]', 'en');
  assert.equal((bilingual.match(/中文結論/g) || []).length, 1);
  assert.match(bilingual, /### Core conclusions\n\n中文結論/);
  assert.doesNotMatch(bilingual, /### 核心結論/);
  assert.doesNotMatch(bilingual, /To be added/);
});
test('AI visual references render as image cards', () => {
  const { visualReferencesMarkdown } = load('main.ts', { obsidian });
  const markdown = visualReferencesMarkdown([{ title: 'Navy + Beige', imageUrl: 'https://example.com/outfit.jpg', sourceUrl: 'https://example.com/page', description: '乾淨休閒穿搭', palette: ['navy', 'white', 'beige'], formula: '深色外套 + 白色內搭 + 淺色褲' }]);
  assert.match(markdown, /!\[Navy \+ Beige\]\(https:\/\/example.com\/outfit.jpg\)/);
  assert.match(markdown, /來源：https:\/\/example.com\/page/);
  assert.match(markdown, /配色：navy \/ white \/ beige/);
  const english = visualReferencesMarkdown([{ title: 'Map', imageUrl: 'https://example.com/map.jpg', sourceUrl: 'https://example.com/page', description: 'Route', palette: [], formula: '' }], 'en');
  assert.match(english, /Source: https:\/\/example.com\/page/);
  assert.doesNotMatch(english, /來源：|用途：/);
});
integrationTest('AI prompt defaults to the selected language across task modes', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  const prompts = [];
  plugin.runtime = () => ({ runTask: async prompt => { prompts.push(prompt); return '{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}'; } });
  const context = { title: 'English topic', summary: 'English summary', rules: '', detail: '', task: 'Expand the map', ancestors: '', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  plugin.settings.language = 'en';
  for (const mode of ['task', 'decompose', 'synthesize']) await plugin.askModel({ ...context, mode }, 'test-model', 'low');
  for (const prompt of prompts) {
    assert.match(prompt, /Write newly generated content in English by default/);
    assert.doesNotMatch(prompt, /[一-龥]/);
  }
  assert.match(prompts[0], /### Core conclusions/);
  assert.match(prompts[0], /Insufficient information/);
  assert.doesNotMatch(prompts[0], /現有資料不足/);
  assert.doesNotMatch(prompts[0], /detail 必須是完整繁體中文/);
  plugin.settings.language = 'zh-TW';
  await plugin.askModel({ ...context, mode: 'task' }, 'test-model', 'low');
  assert.match(prompts[3], /新產生的內容預設使用繁體中文/);
  assert.match(prompts[3], /### 核心結論/);
});
integrationTest('Claude Code uses the shared task prompt and structured result parser without provider fallback', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  let call;
  plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: 'Claude result', detail: 'Claude detail', suggestions: [], visualReferences: [] }); } });
  plugin.runtime = () => { assert.fail('Claude selection must not fall back to Codex'); };
  const result = await plugin.askModel({ title: 'Topic', summary: 'Existing summary', rules: '', detail: 'Full detail', task: 'One-run requirement', ancestors: '', mode: 'synthesize', researchMode: 'research', researchDepth: 'fast', visualMode: 'off' }, 'claude:sonnet', 'high');
  assert.equal(call[1], 'sonnet'); assert.equal(call[2], 'high');
  assert.match(call[0], /One-run requirement/); assert.match(call[0], /Full detail/);
  assert.ok(call[3] && typeof call[3] === 'object');
  assert.equal(call[4].searchBudget, 1);
  assert.deepEqual(plain(result), { summary: 'Claude result', detail: 'Claude detail', suggestions: [], visualReferences: [] });
});
integrationTest('AI response fallback keeps the language captured when the task started', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  plugin.settings.language = 'en';
  plugin.runtime = () => ({ runTask: async () => {
    plugin.settings.language = 'zh-TW';
    return JSON.stringify({ summary: 'Done', detail: 'Details', suggestions: [], visualReferences: [{ imageUrl: 'https://example.com/image.jpg', sourceUrl: 'https://example.com' }] });
  } });
  const result = await plugin.askModel({ title: 'Topic', summary: '', rules: '', detail: '', task: 'Research', ancestors: '', mode: 'task', researchMode: 'local', visualMode: 'off' }, 'test-model', 'low');
  assert.equal(result.visualReferences[0].title, 'Visual reference');
});
test('hover helpers extract image and table from user notes markdown', () => {
  const { firstMarkdownImage, firstMarkdownTable, markdownImages } = load('main.ts', { obsidian });
  const markdown = '我的筆記\n\n![配色](https://example.com/style.jpg)\n![髮型](https://example.com/hair.jpg)\n![鞋子](https://example.com/shoes.jpg)\n![外套](https://example.com/jacket.jpg)\n![忽略](https://example.com/ignored.jpg)\n\n| 面向 | 判斷 |\n| --- | --- |\n| 顏色 | navy / beige |\n| 鞋子 | white sneakers |';
  const image = firstMarkdownImage(markdown);
  assert.equal(image.alt, '配色');
  assert.equal(image.url, 'https://example.com/style.jpg');
  assert.equal(markdownImages(markdown, 4).length, 4);
  assert.equal(markdownImages(markdown, 4)[3].alt, '外套');
  assert.equal(JSON.stringify(firstMarkdownTable(markdown)), JSON.stringify([['面向', '判斷'], ['顏色', 'navy / beige'], ['鞋子', 'white sneakers']]));
});
integrationTest('new notes omit inactive rules and working findings; clearing legacy findings removes the section', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  assert.match(contents.get(n.path), /## Prompt[\s\S]*## 預覽[\s\S]*## Detail/);
  assert.doesNotMatch(contents.get(n.path), /## Rules/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  await repo.updateNote(n.path, { newFindings: 'Legacy finding' });
  assert.match(contents.get(n.path), /## Working Findings\n\nLegacy finding/);
  await repo.updateNote(n.path, { newFindings: '' });
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal((await repo.readNote(n.path)).newFindings, '');
});
integrationTest('a successful AI task immediately updates summary and MD detail', async () => {
  const { repo, app, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  await repo.updateNote(n.path, { prompt: 'Research this', rules: 'Use a comparison table.', detail: 'Existing detail', newFindings: 'Legacy finding', sourcePaths: ['Other.md'] });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: async context => { assert.equal(context.mode, 'task'); assert.equal(context.task, 'One-time request'); assert.equal(context.rules, ''); assert.equal(context.detail, 'Existing detail'); assert.equal(context.workingFindings, 'Legacy finding'); assert.equal(context.sourceContext, ''); return { summary: 'Direct summary', detail: '### 核心結論\n\nDirect detail\n\n### 關鍵知識\n\nExisting detail; Legacy finding\n\n### 證據與來源\n\nSource\n\n### 取捨與限制\n\nNone\n\n### 待確認事項\n\nNone\n\n### 更新紀錄\n\n- Updated', suggestions: [] }; },
    rebuildDerivedData: async () => {}, mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n, undefined, undefined, { task: 'One-time request' }); await new Promise(resolve => setTimeout(resolve, 20));
  const updated = await repo.readNote(n.path);
  assert.equal(updated.prompt, 'Research this'); assert.equal(updated.summary, 'Direct summary'); assert.equal(updated.rules, 'Use a comparison table.');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.newFindings, '');
  assert.match(updated.detail, /Direct detail/);
  assert.match(updated.detail, /Legacy finding/);
  assert.match(updated.detail, /Existing detail/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal(updated.previewInitialized, true);
  await view.travel(false);
  const restored = await repo.readNote(n.path);
  assert.equal(restored.status, 'idea');
  assert.equal(restored.previewInitialized, false);
  assert.doesNotMatch(restored.previewSection, /Direct summary/);
  await view.travel(true);
  assert.equal((await repo.readNote(n.path)).previewInitialized, true);
});
integrationTest('cancelling a node task keeps its earlier Markdown and status', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Cancel');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Keep this' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (_context, _model, _reasoning, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true })),
    mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n);
  assert.equal((await repo.readNote(n.path)).status, 'running');
  plugin.activeTasks.get(n.path).abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await repo.readNote(n.path);
  assert.equal(after.status, 'idea'); assert.equal(after.detail, 'Keep this'); assert.equal(plugin.activeTasks.size, 0);
});
integrationTest('cancelling child synthesis restores the topic status and does not report a failure', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Synthesis parent');
  await repo.updateNote(parent.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  const child = await topicNote(repo, 'Synthesis child');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [{ ...parent, status: 'completed' }, { ...child, parentId: parent.id }], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const controller = new AbortController(); let view, reported = '';
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(),
    askModel: (_context, _model, _reasoning, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true })),
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => { reported = error.message; return error.message; }
  };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  const pending = view.integrateChildren(parent, true, { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [], signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await pending;
  const after = await repo.readNote(parent.path);
  assert.equal(after.status, 'completed'); assert.equal(after.summary, 'Existing conclusion'); assert.equal(after.detail, 'Existing knowledge');
  assert.equal(reported, ''); assert.equal(plugin.running.has(parent.path), false);
});
integrationTest('provider failure keeps its original AI log stage during node error writeback', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Provider failure');
  await repo.updateNote(n.path, { prompt: 'Research' });
  const entry = { id: 'exchange-1', status: 'failed', error: '等待 AI 回覆：provider timeout' };
  const exchanges = { getEntries: () => [entry], failed: (_id, error) => { entry.error = error; } };
  let view;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS, aiExchangeLoggingEnabled: true }, exchanges, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: async (_context, _model, _reasoning, _signal, onExchange) => { onExchange(entry.id); throw new Error('provider timeout'); },
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => error.message };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  const originalError = console.error; console.error = () => {};
  try { await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20)); }
  finally { console.error = originalError; }
  assert.equal((await repo.readNote(n.path)).status, 'error');
  assert.equal(entry.error, '等待 AI 回覆：provider timeout');
});
integrationTest('proposal persistence failure does not erase completed shallow research', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Research result');
  await repo.updateNote(n.path, { prompt: 'Research' });
  const pending = new Map(); pending.flush = async () => { throw new Error('disk unavailable'); };
  let exchangeStatus = 'parsed', view, reported = '';
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS, aiExchangeLoggingEnabled: true }, exchanges: { completed: () => { exchangeStatus = 'completed'; }, getEntries: () => [{ id: 'exchange-1', status: exchangeStatus }], failed: () => { exchangeStatus = 'failed'; } }, running: new Set(), activeTasks: new Map(), pendingSuggestions: pending,
    askModel: async (_context, _model, _reasoning, _signal, onExchange) => { onExchange('exchange-1'); return { summary: 'Researched', detail: 'Result body', suggestions: [{ title: 'Proposal', task: 'Investigate', contribution: '' }], visualReferences: [] }; },
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => { reported = error.message; return reported; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await repo.readNote(n.path)).status, 'completed');
  assert.equal((await repo.readNote(n.path)).summary, 'Researched');
  assert.equal(exchangeStatus, 'completed'); assert.equal(reported, 'disk unavailable');
});
integrationTest('a completed but stale answer cannot overwrite an edited note', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Stale');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Original' });
  let finish; const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: () => new Promise(resolve => { finish = resolve; }), mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n);
  await repo.updateNote(n.path, { detail: 'User edit' });
  finish({ summary: 'Stale summary', detail: 'Stale detail', suggestions: [], visualReferences: [] });
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await repo.readNote(n.path);
  assert.equal(after.detail, 'User edit'); assert.equal(after.status, 'idea'); assert.notEqual(after.summary, 'Stale summary');
});
integrationTest('new child topics inherit reasoning without activating legacy rules', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  await repo.updateNote(parent.path, { rules: 'Use official sources and tables.', reasoning: 'high' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.addNode(parent, 'Child');
  const child = (await repo.readMap(mapPath)).nodes.at(-1);
  assert.equal((await repo.readNote(child.path)).rules, '');
  assert.equal((await repo.readNote(child.path)).reasoning, 'high');
});
integrationTest('selected subtopics move together and copied notes keep their content with new identities', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const first = await repo.createNote('First', 'a', mapDoc, mapPath, 'inherited');
  const second = await repo.createNote('Second', 'a', mapDoc, mapPath, 'inherited');
  first.parentId = root.id; second.parentId = root.id; mapDoc.nodes.push(first, second); await repo.saveMap(mapPath, mapDoc);
  await repo.updateNote(first.path, { detail: 'Original knowledge', preview: 'My handwritten preview' });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([first.id]);
  await view.moveSelected(second);
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === first.id).parentId, second.id);
  view.multiSelected = new Set([first.id]);
  await view.copySelected(root);
  const saved = await repo.readMap(mapPath), copied = saved.nodes.find(node => node.id !== first.id && node.id !== second.id && node.id !== root.id);
  assert.equal(saved.nodes.length, 4);
  assert.equal(copied.parentId, root.id);
  assert.notEqual(copied.path, first.path);
  const note = await repo.readNote(copied.path);
  assert.equal(note.detail, 'Original knowledge'); assert.equal(note.preview, 'My handwritten preview');
  await view.history.undo().undo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/First 副本.md')).topicState, 'unassigned');
  await view.history.redo().redo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 4);
  assert.equal((await repo.readNote(copied.path)).topicState, 'active');
});
integrationTest('copying a legacy note without a title field keeps its filename as the copy title', async () => {
  const { repo, app } = fixture();
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create('Agent Workspace/Topics/map-a/Notes/budget.md', '---\nagent-map-node: true\nnode-id: original\ntopic-id: map-a\n---\n# budget\n\nOriginal content\n');
  const copy = await repo.duplicateNote('Agent Workspace/Topics/map-a/Notes/budget.md', mapDoc, mapPath);
  assert.equal((await repo.readNote(copy.path)).title, 'budget 副本');
  assert.match(await app.vault.read(app.vault.getAbstractFileByPath(copy.path)), /^---[\s\S]*# budget 副本/m);
});
integrationTest('failed batch copy parks created notes and leaves the map unchanged', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const first = await repo.createNote('First', 'a', mapDoc, mapPath, 'inherited');
  const second = await repo.createNote('Second', 'a', mapDoc, mapPath, 'inherited');
  first.parentId = root.id; second.parentId = root.id; mapDoc.nodes.push(first, second); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([first.id, second.id]);
  const duplicate = repo.duplicateNote.bind(repo); let count = 0;
  repo.duplicateNote = async (...args) => { if (++count === 2) throw new Error('injected duplicate failure'); return duplicate(...args); };
  await assert.rejects(view.copySelected(root), /injected duplicate failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/First 副本.md')).topicState, 'unassigned');
  assert.equal(view.history.canUndo, false);
});
integrationTest('failed map save during copy parks the duplicate without changing the map', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([root.id]);
  const save = repo.saveMap.bind(repo); let fail = true;
  repo.saveMap = async (...args) => { if (fail) { fail = false; throw new Error('injected map save failure'); } return save(...args); };
  await assert.rejects(view.copySelected(root), /injected map save failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/Root 副本.md')).topicState, 'unassigned');
  assert.equal(view.history.canUndo, false);
});
integrationTest('removing selected subtopic branches parks notes and can be undone', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'a', mapDoc, mapPath, 'inherited'); child.parentId = root.id;
  const grandchild = await repo.createNote('Grandchild', 'a', mapDoc, mapPath, 'inherited'); grandchild.parentId = child.id;
  mapDoc.nodes.push(child, grandchild); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([child.id]); await view.removeSelected();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal((await repo.readNote(`Agent Workspace/Topics/map-a/Unassigned/Child.md`)).topicState, 'unassigned');
  await view.history.undo().undo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.ok(app.vault.getAbstractFileByPath(child.path));
});
integrationTest('failed batch removal restores map and active note ownership', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'a', mapDoc, mapPath, 'inherited'); child.parentId = root.id;
  mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([child.id]);
  const save = repo.saveMap.bind(repo); let fail = true;
  repo.saveMap = async (...args) => { if (fail) { fail = false; throw new Error('injected map save failure'); } return save(...args); };
  await assert.rejects(view.removeSelected(), /injected map save failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal((await repo.readNote(child.path)).topicState, 'active');
  assert.equal((await repo.readNote(child.path)).mapId, mapDoc.id);
  assert.equal(view.history.canUndo, false);
});
integrationTest('failed rebuild after batch removal also restores map and notes', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'a', mapDoc, mapPath, 'inherited'); child.parentId = root.id;
  mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let fail = true;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { if (fail) { fail = false; throw new Error('injected rebuild failure'); } } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([child.id]);
  await assert.rejects(view.removeSelected(), /injected rebuild failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal((await repo.readNote(child.path)).topicState, 'active');
  assert.equal(view.history.canUndo, false);
});
integrationTest('confirmed child batches rebuild derived data only once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a'); let rebuilds = 0;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { rebuilds++; } });
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  await view.createChildBatch(parent, [
    { title: 'One', task: 'Task one', contribution: 'First' },
    { title: 'Two', task: 'Task two', contribution: 'Second' },
    { title: 'Three', task: 'Task three', contribution: 'Third' }
  ]);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 4);
  assert.equal(rebuilds, 1);
  assert.equal((await repo.readNote(saved.nodes[1].path)).prompt, 'Task one');
});
integrationTest('two-level child batches attach grandchildren and still rebuild once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a'); let rebuilds = 0;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { rebuilds++; } });
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  await view.createChildBatch(parent, [
    { title: 'A', task: 'Explore A', contribution: '' },
    { title: 'B', task: 'Explore B', contribution: '' },
    { title: 'A1', task: 'Explore A1', contribution: '', parentTitle: 'A' }
  ]);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 4);
  assert.equal(saved.nodes[3].parentId, saved.nodes[1].id);
  assert.equal(rebuilds, 1);
});
integrationTest('orphan grandchild proposals fail instead of silently disappearing', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await assert.rejects(view.createChildBatch(parent, [{ title: 'Orphan', task: '', contribution: '', parentTitle: 'Missing' }]), /Select the parent topic before its child/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
integrationTest('duplicate first-level proposal names cannot misplace grandchildren', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await assert.rejects(view.createChildBatch(parent, [
    { title: 'Same', task: '', contribution: '' },
    { title: 'Same', task: '', contribution: '' },
    { title: 'Child', task: '', contribution: '', parentTitle: 'Same' }
  ]), /First-level topic names must be unique/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
test('ambiguous original AI proposal names are rejected before editing', () => {
  const notices = []; let opened = 0;
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { open() { opened++; } } } });
  const suggestions = [
    { title: 'Same', task: '', contribution: '', parentTitle: '' },
    { title: 'Same', task: '', contribution: '', parentTitle: '' },
    { title: 'Child', task: '', contribution: '', parentTitle: 'Same' }
  ];
  const plugin = { pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map([['parent.md', { researchDepth: 'fast' }]]) };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.openChildSuggestions({ id: 'parent', path: 'parent.md' }, suggestions);
  assert.equal(opened, 0);
  assert.match(notices[0], /duplicate first-level names/);
  assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  assert.equal(plugin.pendingResearchOptions.has('parent.md'), false);
});
integrationTest('confirmed two-level decomposition starts shallow research for every created topic', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; view.runAgent = async node => { researched.push(node.id); await repo.updateNote(node.path, { status: 'running' }); };
  await view.createChildBatch(parent, [
    { title: 'A', task: 'Research A', contribution: '' },
    { title: 'A1', task: 'Research A1', contribution: '', parentTitle: 'A' }
  ], { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', referenceGroups: [], multiLayer: true });
  const saved = await repo.readMap(mapPath);
  assert.equal(JSON.stringify(researched), JSON.stringify(saved.nodes.slice(1).map(node => node.id)));
  for (const node of saved.nodes.slice(1)) {
    const note = await repo.readNote(node.path);
    assert.equal(note.researchDepth, 'fast'); assert.equal(note.researchMode, 'research'); assert.equal(note.visualMode, 'auto');
  }
});
integrationTest('guided expansion can research a confirmed first-level child', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; view.runAgent = async child => { researched.push(child.id); await repo.updateNote(child.path, { status: 'running' }); };
  await view.createChildBatch(parent, [{ title: 'Research me', task: 'Find evidence', contribution: '', parentTitle: '' }], { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: false, shallowResearch: true });
  assert.equal(researched.length, 1);
  assert.equal((await repo.readNote(view.map.nodes.at(-1).path)).researchMode, 'research');
});
integrationTest('one shallow-research startup failure marks that child and does not strand later children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, recordFailure: (context, error) => failures.push(`${context}: ${error.message}`) };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async child => { if ((await repo.readNote(child.path)).title === 'First') throw new Error('startup failed'); await repo.updateNote(child.path, { status: 'running' }); };
  await view.createChildBatch(parent, [{ title: 'First', task: 'Research first', contribution: '' }, { title: 'Second', task: 'Research second', contribution: '' }], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true });
  const saved = await repo.readMap(mapPath);
  assert.equal((await repo.readNote(saved.nodes[1].path)).status, 'error');
  assert.equal((await repo.readNote(saved.nodes[2].path)).status, 'running');
  assert.match(failures[0], /startup failed/);
});
integrationTest('cancelling shallow research stops the batch without marking unstarted children as errors', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const controller = new AbortController(), failures = [], started = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, recordFailure: (context, error) => failures.push(`${context}: ${error.message}`) };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (child, _unusedA, _unusedB, options) => {
    started.push((await repo.readNote(child.path)).title); assert.equal(options.signal, controller.signal);
    await repo.updateNote(child.path, { status: 'idea' });
    controller.abort();
  };
  await view.createChildBatch(parent, [
    { title: 'First', task: 'Research first', contribution: '' },
    { title: 'Second', task: 'Research second', contribution: '' }
  ], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true, signal: controller.signal });
  const saved = await repo.readMap(mapPath);
  assert.deepEqual(started, ['First']);
  assert.equal((await repo.readNote(saved.nodes[1].path)).status, 'idea');
  assert.equal((await repo.readNote(saved.nodes[2].path)).status, 'idea');
  assert.deepEqual(failures, []);
});
integrationTest('quick exploration creates two levels directly and leaves them unresearched', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [
    { title: 'A', task: 'Explore A', contribution: '', parentTitle: '' },
    { title: 'B', task: 'Explore B', contribution: '', parentTitle: '' },
    { title: 'A1', task: 'Explore A1', contribution: '', parentTitle: 'A' },
    { title: 'B1', task: 'Explore B1', contribution: '', parentTitle: 'B' }
  ] }) };
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let reviewed = 0, completed = 0, researched = 0;
  view.runAgent = async () => { researched++; };
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 2, firstLayerCount: 2, childrenPerParent: 1 }, '', () => { reviewed++; }, message => assert.fail(message), true, () => { completed++; });
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 5); assert.equal(saved.nodes[3].parentId, saved.nodes[1].id); assert.equal(saved.nodes[4].parentId, saved.nodes[2].id);
  assert.equal(reviewed, 0); assert.equal(completed, 1); assert.equal(researched, 0);
  for (const child of saved.nodes.slice(1)) assert.equal((await repo.readNote(child.path)).status, 'idea');
});
integrationTest('quick exploration rejects zero for multiple levels and ignores unused single-level child count', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let task = '';
  const plugin = { recordFailure: (_label, error) => String(error), repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), askModel: async context => {
    task = context.task;
    return { summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 10 }, (_, index) => ({ title: `Child ${index + 1}`, task: `Explore ${index + 1}`, contribution: '', parentTitle: '' })) };
  } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let completed = false;
  let failure = '';
  await view.proposeChildren(parent, true, { multiLayer: true, layers: 2, firstLayerCount: 10, childrenPerParent: 0 }, '', () => assert.fail('invalid shape'), message => { failure = message; }, true);
  assert.match(failure, /positive whole/); assert.equal(task, ''); assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, layers: 1, firstLayerCount: 10, childrenPerParent: NaN }, '', () => assert.fail('quick map should not show review'), message => assert.fail(message), true, () => { completed = true; });
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 11);
  assert.ok(saved.nodes.slice(1).every(child => child.parentId === parent.id));
  assert.match(task, /1 level/);
  assert.match(task, /total: 10/);
  assert.equal(completed, true);
});
integrationTest('quick exploration gives every parent two children across three levels and starts optional research', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const suggestions = []; let parents = [''];
  for (let depth = 0; depth < 3; depth++) {
    const current = [];
    for (const parentTitle of parents) for (let index = 0; index < 2; index++) {
      const title = `L${depth}-${current.length}`;
      suggestions.push({ title, task: `Research ${title}`, contribution: '', parentTitle }); current.push(title);
    }
    parents = current;
  }
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions }) };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let researched = 0; view.runAgent = async child => { researched++; await repo.updateNote(child.path, { status: 'running' }); };
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: true, layers: 3, firstLayerCount: 2, childrenPerParent: 2 }, '', () => assert.fail('quick map should not show review'), message => assert.fail(message), true);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 15); assert.equal(researched, 14);
  const byTitle = new Map(); for (const item of saved.nodes.slice(1)) byTitle.set((await repo.readNote(item.path)).title, item);
  for (const item of suggestions) assert.equal(byTitle.get(item.title).parentId, item.parentTitle ? byTitle.get(item.parentTitle).id : parent.id);
});
integrationTest('quick exploration rejects an uneven branch before creating any topic', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const suggestions = [
    { title: 'A', task: 'Explore A', contribution: '', parentTitle: '' },
    { title: 'B', task: 'Explore B', contribution: '', parentTitle: '' },
    { title: 'A1', task: 'Explore A1', contribution: '', parentTitle: 'A' },
    { title: 'A2', task: 'Explore A2', contribution: '', parentTitle: 'A' }
  ];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions }) };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  let failure = '';
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, layers: 2, firstLayerCount: 2, childrenPerParent: 1 }, '', () => assert.fail('uneven map accepted'), message => { failure = message; }, true);
  assert.match(failure, /level counts and parent-child structure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
integrationTest('quick AI wait leaves map mutations free and uses the latest parent position', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve();
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandPending: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 };
  const job = view.startQuickExpansion(parent, options, '', message => assert.fail(message), () => {});
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(plugin.quickExpandPending.has(parent.path), true);
  let moved = false;
  const change = plugin.mutate(async () => { await view.mapChange(map => { map.nodes[0].x = 500; }, false); moved = true; });
  const progressed = await Promise.race([change.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal(progressed, true); assert.equal(moved, true);
  const saved = await repo.readMap(mapPath); assert.equal(saved.nodes.length, 2); assert.equal(saved.nodes[1].x, 860);
  assert.equal(plugin.quickExpandPending.size, 0);
});
integrationTest('quick map discards a delayed answer when its parent has been removed', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve(), error = '';
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandPending: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, failure) => failure.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 };
  const job = view.startQuickExpansion(parent, options, '', message => { error = message; }, () => assert.fail('stale result created nodes'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await plugin.mutate(() => view.mapChange(map => { map.nodes = []; }));
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Stale child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  assert.match(error, /map or parent topic changed/); assert.equal((await repo.readMap(mapPath)).nodes.length, 0);
  assert.equal(plugin.quickExpandPending.size, 0); assert.ok(plugin.quickExpandFailures.has(parent.path));
});
integrationTest('pending proposals use this run\'s shallow research choice and serialize creation', async () => {
  const suggestions = [{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }];
  const plugin = { pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map(), mutate: async work => { queued++; return work(); } };
  let queued = 0, create, used;
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.render = () => {};
  view.createChildBatch = async (_parent, _items, options) => { used = options; };
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [{ name: 'Reference map', documents: [{ path: 'map/topic.md', content: 'private source' }] }], multiLayer: false, shallowResearch: true };
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, true, options, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
  assert.deepEqual({ ...plugin.pendingResearchOptions.get('parent.md'), referenceGroups: [] }, { ...options, referenceGroups: [] });
  await create(suggestions);
  assert.equal(queued, 1); assert.equal(used.researchMode, 'local'); assert.equal(used.researchDepth, 'fast'); assert.equal(used.visualMode, 'off'); assert.equal(used.referenceGroups.length, 0); assert.notEqual(used, options); assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  plugin.pendingSuggestions.set('parent.md', suggestions); plugin.pendingResearchOptions.set('parent.md', options);
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, true, { ...options, shallowResearch: false }, '', () => {}, message => assert.fail(message));
  assert.equal(plugin.pendingResearchOptions.has('parent.md'), false);
});
integrationTest('two views cannot create the same pending proposals twice', async () => {
  const suggestions = [{ title: 'Child', task: 'Research', contribution: '', parentTitle: '' }];
  let tail = Promise.resolve(), created = 0;
  const plugin = { pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map(), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const first = new VisualAgentMapView({ app: {} }, plugin), second = new VisualAgentMapView({ app: {} }, plugin);
  for (const view of [first, second]) { view.render = () => {}; view.createChildBatch = async () => { created++; }; }
  let acceptFirst, acceptSecond;
  await first.proposeChildren({ id: 'parent', path: 'parent.md' }, true, undefined, '', (_items, accept) => { acceptFirst = accept; });
  await second.proposeChildren({ id: 'parent', path: 'parent.md' }, true, undefined, '', (_items, accept) => { acceptSecond = accept; });
  const outcomes = await Promise.allSettled([acceptFirst(suggestions), acceptSecond(suggestions)]);
  assert.equal(created, 1);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected']);
  assert.match(outcomes[1].reason.message, /Expansion suggestions changed/);
});
integrationTest('partial child creation invalidates the proposal so retry cannot duplicate nodes', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const suggestions = [{ title: 'First', task: 'A', contribution: '', parentTitle: '' }, { title: 'Second', task: 'B', contribution: '', parentTitle: '' }];
  let queued = 0, changes = 0, create;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, pendingSuggestions: new Map([[parent.path, suggestions]]), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => { queued++; return work(); } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  view.noteChange = async () => { if (++changes === 2) throw new Error('injected note write failure'); };
  await view.proposeChildren(parent, true, undefined, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
  await assert.rejects(create(suggestions), /Some subtopics were created/);
  assert.equal(queued, 1); assert.equal(plugin.pendingSuggestions.has(parent.path), false);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
});
integrationTest('synthesis directions and draft are separate steps; only confirmed draft updates the parent', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'model-a', mapDoc, mapPath, 'workspace'); child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  await repo.updateNote(parent.path, { rules: 'Legacy sentinel' });
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] } : { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  let choose, save;
  const options = { requirements: 'Only compare cost', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [{ id: 'picked', name: 'Picked', location: '/refs', documents: [{ path: '/refs/selected.md', content: 'Selected note content', external: true }] }] };
  await view.proposeIntegrationDirections(parent, options, (items, draft) => { assert.equal(items[0].title, 'Common ground'); choose = draft; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
  assert.equal(contexts.length, 1); assert.equal(contexts[0].referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md'), true); assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft summary');
  await choose('Find shared constraints');
  assert.equal(contexts[1].task, 'Find shared constraints\n\nOnly compare cost');
  for (const context of contexts) { assert.equal(context.rules, ''); assert.match(context.task, /Only compare cost/); assert.ok(context.referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md')); assert.doesNotMatch(JSON.stringify(context), /Legacy sentinel/); } assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft summary');
  await save('Edited summary', 'Edited detail');
  const saved = await repo.readNote(parent.path);
  assert.equal(saved.rules, 'Legacy sentinel');
  assert.equal(saved.summary, 'Edited summary'); assert.match(saved.detail, /Edited detail/);
});
integrationTest('synthesis content is explicit for one, three and four children, with full default and no descendants', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { referenceBatches } = load('ai/reference-materials.ts', { obsidian });
  for (const count of [1, 3, 4]) for (const choice of [undefined, 'full', 'summary']) {
    const { repo, app, contents } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
    await repo.updateNote(parent.path, { rules: 'LEGACY_PARENT_RULES' });
    const children = [];
    for (let index = 0; index < count; index++) {
      const child = await topicNote(repo, `Child ${index}`, 'model-a'); child.parentId = parent.id;
      await repo.updateNote(child.path, { summary: `Summary ${index}`, detail: `DETAIL_START_${index}\n${'body '.repeat(3500)}\nBODY_ONLY_CONDITION_${index}\n${'rest '.repeat(3500)}\nDETAIL_END_${index}`, newFindings: `Finding ${index}`, rules: `LEGACY_CHILD_${index}` });
      children.push(child);
    }
    const grandchild = await topicNote(repo, 'Grandchild', 'model-a'); grandchild.parentId = children[0].id;
    await repo.updateNote(grandchild.path, { detail: 'EXCLUDED_GRANDCHILD' });
    const unrelated = await topicNote(repo, 'Unrelated', 'model-a');
    await repo.updateNote(unrelated.path, { detail: 'EXCLUDED_UNRELATED' });
    const selected = { id: 'extra', name: 'Extra', location: '/refs', documents: [{ path: '/refs/extra.md', content: 'EXTRA_FULL_BODY', external: true }] };
    const before = new Map(contents);
    const contexts = [];
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), recordFailure: (_label, error) => error.message,
      askModel: async context => { contexts.push(context); return contexts.length === 1 ? { suggestions: [{ title: 'Direction', task: 'Compare evidence', contribution: '' }] } : { summary: 'Draft', detail: 'Draft', visualReferences: [], suggestions: [] }; } };
    const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent, ...children, grandchild, unrelated]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
    let draft, save;
    const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', requirements: 'Respect the budget', referenceGroups: [selected], ...(choice ? { synthesisContent: choice } : {}) };
    await view.proposeIntegrationDirections(parent, options, (_items, next) => { draft = next; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
    await draft('Compare evidence');
    assert.equal(typeof save, 'function'); assert.equal(contexts.length, 2);
    for (const context of contexts) {
      assert.equal(context.rules, ''); assert.match(context.task, /Respect the budget/);
      const docs = context.referenceGroups.flatMap(group => group.documents);
      const automatic = docs.filter(doc => !doc.external);
      assert.deepEqual(Array.from(docs, doc => doc.path), ['/refs/extra.md', ...children.map(child => child.path)]);
      assert.equal(docs[0].content, 'EXTRA_FULL_BODY');
      const batches = referenceBatches(context.referenceGroups).join('\n');
      assert.doesNotMatch(batches, /EXCLUDED_GRANDCHILD|EXCLUDED_UNRELATED|LEGACY_CHILD/);
      for (let index = 0; index < count; index++) {
        assert.ok(automatic[index].content.includes(`Summary ${index}`)); assert.ok(automatic[index].content.includes(`Finding ${index}`));
        if (choice === 'summary') assert.ok(!automatic[index].content.includes(`BODY_ONLY_CONDITION_${index}`));
        else {
          const detail = (await repo.readNote(children[index].path)).detail;
          assert.ok(automatic[index].content.includes(detail), `full source lost Detail for ${count}/${choice}/${index}`);
          for (const marker of [`DETAIL_START_${index}`, `BODY_ONLY_CONDITION_${index}`, `DETAIL_END_${index}`]) assert.ok(batches.includes(marker));
          assert.ok(batches.includes(children[index].path));
        }
      }
    }
    assert.doesNotMatch(JSON.stringify(contexts), /LEGACY_PARENT_RULES/);
    assert.equal((await repo.readNote(parent.path)).rules, 'LEGACY_PARENT_RULES');
    for (const child of [...children, grandchild, unrelated]) assert.equal(contents.get(child.path), before.get(child.path));
    assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft');
  }
});
integrationTest('multi-select synthesis honors content choice and leaves unselected topics and extra Markdown unchanged', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  for (const choice of [undefined, 'full', 'summary']) {
    const { repo, app, contents } = fixture(), a = await topicNote(repo, 'Selected A', 'model-a'), b = await topicNote(repo, 'Selected B', 'model-a'), excluded = await topicNote(repo, 'Not selected', 'model-a');
    await repo.updateNote(a.path, { summary: 'A summary', detail: 'A_BODY_ONLY', rules: 'OLD_RULE_A' });
    await repo.updateNote(b.path, { summary: 'B summary', detail: 'B_BODY_ONLY' });
    const before = new Map(contents);
    const extra = { id: 'extra', name: 'Extra', location: '/refs', documents: [{ path: '/refs/source.md', content: 'EXTRA_BODY_UNCHANGED', external: true }] };
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, askModel: async context => {
      const docs = context.referenceGroups.flatMap(group => group.documents);
      const automatic = docs.filter(doc => !doc.external);
      assert.deepEqual(Array.from(docs, doc => doc.path), ['/refs/source.md', a.path, b.path]);
      assert.equal(automatic[0].content.includes('A_BODY_ONLY'), choice !== 'summary');
      assert.equal(automatic[1].content.includes('B_BODY_ONLY'), choice !== 'summary');
      assert.equal(docs[0].content, 'EXTRA_BODY_UNCHANGED');
      assert.match(context.task, /This run only/); assert.equal(context.rules, '');
      throw new Error('Stop before any write');
    } };
    const view = new VisualAgentMapView({ app }, plugin); view.map = map([a, b, excluded]); view.render = () => {};
    await assert.rejects(view.createIntegratedNode('Draft', [a, b], 'Compare', '', { synthesisContent: choice, requirements: 'This run only', referenceGroups: [extra] }, true), /Stop before any write/);
    assert.deepEqual(new Map(contents), before);
  }
});
integrationTest('explicit full Markdown wins over overlapping automatic summaries in both synthesis paths', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent'), a = await topicNote(repo, 'A'), b = await topicNote(repo, 'B');
  a.parentId = parent.id; b.parentId = parent.id;
  await repo.updateNote(a.path, { summary: 'A summary', detail: 'FULL_OVERLAP_CONDITION' });
  const { referenceBatches } = load('ai/reference-materials.ts', { obsidian });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const full = await app.vault.read(repo.file(a.path));
  const extra = { id: 'shared-map', name: 'Other map', location: 'Other/Map.md', documents: [{ path: a.path, content: full }] };
  let calls = 0;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), recordFailure: (_label, error) => error.message, askModel: async context => {
    const batches = referenceBatches(context.referenceGroups).join('\n');
    assert.match(batches, /FULL_OVERLAP_CONDITION/);
    assert.equal(batches.split('FULL_OVERLAP_CONDITION').length - 1, 1);
    calls++;
    return { summary: 'Draft', detail: 'Draft', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare', contribution: '' }] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent, a, b]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const options = { synthesisContent: 'summary', referenceGroups: [extra], researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  let draft;
  await view.proposeIntegrationDirections(parent, options, (_items, next) => { draft = next; }, () => {}, message => assert.fail(message));
  await draft('Compare');
  view.saveIntegratedNode = async () => {};
  await view.createIntegratedNode('Combined', [a, b], 'Compare', '', options);
  assert.equal(calls, 3);
  assert.equal(await app.vault.read(repo.file(a.path)), full);
});
integrationTest('synthesis can use selected notes when a topic has no children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', suggestions: [{ title: 'Shared view', task: 'Combine notes', contribution: '' }] } : { summary: 'Combined', detail: 'Combined detail', suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const empty = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  let failure = '';
  await view.proposeIntegrationDirections(parent, empty, () => assert.fail('missing sources'), () => {}, message => { failure = message; });
  assert.match(failure, /Choose another note source first/);
  assert.equal(contexts.length, 0);
  await view.proposeIntegrationDirections(parent, { ...empty, referenceGroups: [{ id: 'empty', name: 'Empty', location: '', documents: [] }] }, () => assert.fail('empty source'), () => {}, message => { failure = message; });
  assert.match(failure, /Choose another note source first/);
  assert.equal(contexts.length, 0);
  let draft, save;
  const selectedGroup = { id: 'selected', name: 'Selected', location: '/refs', documents: [{ path: '/refs/selected.md', content: 'Selected note content', external: true }] };
  await view.proposeIntegrationDirections(parent, { ...empty, referenceGroups: [selectedGroup] }, (_items, next) => { draft = next; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
  assert.ok(contexts[0].referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md'));
  await draft('Combine notes');
  assert.ok(contexts[1].referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md'));
  await save('Combined', 'Combined detail');
  assert.equal((await repo.readNote(parent.path)).summary, 'Combined');
});
integrationTest('decomposition accepts 1 to 7 proposals and does not write nodes before confirmation', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }, { title: 'Only two', task: '', contribution: '' }] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {};
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 2);
  plugin.pendingSuggestions.clear();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }] });
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 1);
  plugin.pendingSuggestions.clear();
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 8 }, (_, index) => ({ title: `Suggestion ${index + 1}`, task: '', contribution: '' })) });
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 7);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
integrationTest('English expansion uses English-generated task instructions', async () => {
  const { repo, app } = fixture('en'), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'Map', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc, 'en'));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  let task = '';
  const plugin = { recordFailure: (_label, error) => String(error), repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), pendingSuggestions: new Map(), askModel: async context => { task = context.task; return { summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 3 }, (_, index) => ({ title: `Idea ${index}`, task: 'Research', contribution: '' })) }; } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {}; view.ancestorContext = async () => '';
  await view.proposeChildren(parent, true);
  assert.match(task, /Existing direct subtopics/);
  assert.doesNotMatch(task, /[一-龥]/);
});
integrationTest('decomposition receives existing child topics to avoid duplicate proposals', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Travel', 'model-a');
  await repo.updateNote(parent.path, { researchMode: 'local' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('交通', 'model-a', mapDoc, mapPath, 'workspace');
  child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  let captured;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), askModel: async context => { captured = context; return { summary: 'No split', detail: '', visualReferences: [], suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.notes.set(child.id, await repo.readNote(child.path)); view.render = () => {}; view.hydrate = async () => {};
  await view.proposeChildren(parent, true);
  assert.match(captured.task, /Existing direct subtopics/);
  assert.match(captured.task, /交通/);
  assert.match(captured.task, /do not pad the count/);
  assert.equal(captured.researchMode, 'research');
  assert.equal(captured.referenceGroups, undefined);
  assert.equal(plugin.pendingSuggestions.size, 0);
});
integrationTest('duplicating the built-in sample creates an independent editable map with new identities', async () => {
  const { repo, app } = fixture();
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings = { ...DEFAULT_SETTINGS }; plugin.saveSettings = async () => {};
  const mapPath = await plugin.duplicateBuiltInSample();
  const sample = await repo.readMap(mapPath);
  assert.match(mapPath, /Agent Workspace\/Topics\/Sample Planning a Taiwan Journey\/Map\.md$/);
  assert.equal(sample.nodes.length, 12);
  assert.equal(sample.nodes.filter(node => node.parentId === null).length, 2);
  assert.notEqual(sample.id, 'builtin-taiwan-travel');
  assert.ok(sample.nodes.every(node => !['explore', 'constraints', 'transport', 'food', 'nature', 'journey'].includes(node.id)));
  const synthesis = await repo.readNote(sample.nodes.find(node => node.x === 1050).path);
  assert.equal(synthesis.status, 'completed'); assert.equal(synthesis.sourcePaths.length, 6);
  assert.ok(synthesis.sourcePaths.every(source => source.startsWith('Agent Workspace/Topics/')));
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics/Sample Planning a Taiwan Journey/Attachments/east-coast-landscape.webp'));
});
integrationTest('failed Sample duplication removes only its new map and reports cleanup failures', async () => {
  const { repo, app, files, contents } = fixture();
  const existingPath = await repo.createMap('Sample Planning a Taiwan Journey');
  const existingMap = contents.get(existingPath);
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings = { ...DEFAULT_SETTINGS }; plugin.saveSettings = async () => {};
  const trashFile = async folder => {
    for (const [path, item] of Array.from(files.entries())) if (path === folder.path || path.startsWith(`${folder.path}/`)) { files.delete(path); contents.delete(path); item.parent?.children && (item.parent.children = item.parent.children.filter(child => child !== item)); }
  };
  app.fileManager.trashFile = trashFile;
  const createBinary = app.vault.createBinary;
  app.vault.createBinary = async () => { throw new Error('injected attachment failure'); };
  await assert.rejects(plugin.duplicateBuiltInSample(), /injected attachment failure/);
  app.vault.createBinary = createBinary;
  assert.equal(contents.get(existingPath), existingMap);
  assert.ok(app.vault.getAbstractFileByPath(existingPath));
  assert.equal(!!app.vault.getAbstractFileByPath('Agent Workspace/Topics/Sample Planning a Taiwan Journey 2'), false);

  const cleanupFailure = new Error('injected cleanup failure');
  app.fileManager.trashFile = async () => { throw cleanupFailure; };
  app.vault.createBinary = async () => { throw new Error('injected second attachment failure'); };
  await assert.rejects(plugin.duplicateBuiltInSample(), /cleanup failed for Agent Workspace\/Topics\/Sample Planning a Taiwan Journey 2: Error: injected cleanup failure/);
});

integrationTest('Sample rollback covers creation failures and never adopts a colliding or replaced folder', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const stage of ['root-collision', 'child-folder', 'map-file', 'read-map', 'note-create', 'note-update', 'save-map', 'rebuild', 'settings', 'replacement']) {
    const { repo, app, files, contents } = fixture('en');
    const oldPath = await repo.createMap('Existing');
    const oldMap = await repo.readMap(oldPath);
    const oldNode = await repo.createNote('Existing note', 'model', oldMap, oldPath, 'workspace');
    const before = new Map(contents);
    const plugin = new Plugin(); Object.assign(plugin, { app, repo, settings: { ...DEFAULT_SETTINGS }, saveSettings: async () => {} });
    const root = 'Agent Workspace/Topics/Sample Planning a Taiwan Journey';
    const trashed = [];
    app.fileManager.trashFile = async folder => { trashed.push(folder.path); for (const key of [...files.keys()]) if (key === folder.path || key.startsWith(folder.path + '/')) { files.delete(key); contents.delete(key); } };
    const fail = () => { throw new Error('injected ' + stage); };
    const createFolder = app.vault.createFolder;
    if (stage === 'root-collision') app.vault.createFolder = async path => { if (path === root) { await createFolder(path); fail(); } return createFolder(path); };
    if (stage === 'child-folder') app.vault.createFolder = async path => { if (path === root + '/Unassigned') fail(); return createFolder(path); };
    const create = app.vault.create;
    if (stage === 'map-file') app.vault.create = async (path, data) => { if (path === root + '/Map.md') fail(); return create(path, data); };
    if (stage === 'read-map') repo.readMap = fail;
    if (stage === 'note-create') repo.createNote = fail;
    if (stage === 'note-update') repo.updateNote = fail;
    if (stage === 'save-map') repo.saveMap = fail;
    if (stage === 'rebuild') repo.rebuildDerivedData = fail;
    if (stage === 'settings') plugin.saveSettings = fail;
    if (stage === 'replacement') app.vault.createBinary = async () => { files.set(root, new TFolder(root)); fail(); };
    await assert.rejects(plugin.duplicateBuiltInSample(), /injected/);
    const preserved = stage === 'root-collision' || stage === 'replacement';
    assert.equal(!!files.get(root), preserved, stage);
    assert.deepEqual(trashed, preserved ? [] : [root], stage);
    for (const [path, content] of before) assert.equal(contents.get(path), content, stage + ': ' + path);
    assert.ok(files.get(oldNode.path));
  }
});

integrationTest('guided proposals support zero, one, two and seven, saving selected edits and rejecting a switched map', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  for (const count of [0, 1, 2, 7]) {
    const { repo, app } = fixture('en');
    const path = await repo.createMap('Guided'), doc = await repo.readMap(path);
    const parent = await repo.createNote('Parent', 'model-a', doc, path, 'workspace'); doc.nodes.push(parent); await repo.saveMap(path, doc);
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), mutate: async work => work(), rebuildDerivedData: async () => {}, askModel: async () => ({ summary: '', detail: 'No useful split', suggestions: Array.from({length: count}, (_, i) => ({title: 'Child ' + i, task: 'Explore', contribution: ''})) }) };
    const view = new VisualAgentMapView({app}, plugin); Object.assign(view, {path, map: doc, contentEl: {querySelector: () => null}, render() {}, async hydrate() {}, focusNode() {}});
    let offered, confirm, failure, renderedPending;
    view.render = () => { renderedPending = plugin.pendingSuggestions.size; };
    await view.proposeChildren(parent, true, {}, '', (items, create) => { offered = items; confirm = create; }, message => { failure = message; });
    assert.equal((await repo.readMap(path)).nodes.length, 1);
    if (!count) { assert.equal(failure, 'No useful split'); continue; }
    assert.equal(offered.length, count);
    view.map = { ...doc, id: 'other', nodes: [] }; view.path = 'Other/Map.md';
    await assert.rejects(confirm(offered), /changed/);
    assert.equal((await repo.readMap(path)).nodes.length, 1);
    view.map = doc; view.path = path;
    await confirm([{...offered[0], title: 'Edited choice'}]);
    const reopened = await repo.readMap(path); assert.equal(reopened.nodes.length, 2);
    assert.equal((await repo.readNote(reopened.nodes[1].path)).title, 'Edited choice');
    assert.equal(plugin.pendingSuggestions.size, 0); assert.equal(renderedPending, 0);
  }
});
test('first-use map view waits for async initialization and opens the official Sample once', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  let resolveReady, pending = true, opened = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const plugin = {
    ready,
    consumeFirstInstallSample() { const value = pending; pending = false; return value; },
    repo: { workspaceExists: () => false, mapFiles: async () => [] }
  };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.contentEl = { addClass() {} }; view.registerDomEvent = () => {};
  view.openBuiltInSample = async () => { opened++; view.builtIn = true; };
  const opening = view.onOpen();
  await Promise.resolve();
  assert.equal(opened, 0, 'the view must not read workspace data before initialization completes');
  resolveReady(); await opening;
  assert.equal(pending, false);
  assert.equal(opened, 1);
  assert.equal(view.builtIn, true);
});
test('the first AI task shows a provider-specific usage acknowledgement only once', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(source, /class AiUsageModal/);
  assert.match(source, /ui\.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u/);
  assert.match(source, /ui\.vam_runs_ai_tasks_through_your_claude_code_account_and_uses/);
  assert.match(source, /if \(!confirmed\) return false;/);
  assert.match(source, /this\.settings\.codexUsageNoticeSeen = true/);
  assert.match(source, /this\.settings\.claudeUsageNoticeSeen = true/);
  assert.match(source, /confirmAiUsage\(model/);
});
test('Obsidian 1.13 declarative settings expose workspace recovery and App Server diagnostics', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const definitions = source.slice(source.indexOf('getSettingDefinitions()'), source.indexOf('async setControlValue'));
  assert.match(definitions, /ui\.workspace_location/);
  assert.match(definitions, /ui\.repair_agent_workspace/);
  assert.match(definitions, /ui\.ai_reasoning_level/);
  assert.match(definitions, /cliReasoning/);
  assert.match(definitions, /low: t\("ui\.low"\)/);
  assert.match(definitions, /medium: t\("ui\.medium"\)/);
  assert.match(definitions, /high: t\("ui\.high"\)/);
  assert.match(definitions, /ui\.refresh_vam_data/);
  assert.match(definitions, /ui\.full_rebuild/);
  assert.match(definitions, /ui\.reconnect_existing_workspace/);
  assert.match(definitions, /ui\.codex_app_server_status/);
  assert.match(definitions, /ui\.check_again/);
  assert.match(definitions, /ui\.installation_guide/);
  assert.match(source, /this\.settingTab\?\.update\(\)/);
  assert.match(source, /setAttr\("aria-label", t\("ui\.reasoning_level"\)\)/);
  assert.match(source, /save\(\{ reasoning: normalizeReasoningLevel\(reasoning\.value\) \}\)/);
});
integrationTest('full rebuild refreshes derived data and open views', async () => {
  const { default: Plugin } = load('main.ts', { obsidian }); let rebuilds = 0, refreshes = 0;
  const plugin = new Plugin();
  plugin.repo = { rebuildDerivedData: async () => { rebuilds++; } };
  plugin.views = () => [{ refreshFromPlugin: async () => { refreshes++; } }];
  await plugin.fullRebuild();
  assert.equal(rebuilds, 1);
  assert.equal(refreshes, 1);
});
test('missing Codex opens an in-product setup guide with official installation and sign-in steps', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(source, /class CodexSetupModal/);
  assert.match(source, /https:\/\/developers\.openai\.com\/codex\/cli\//);
  assert.match(source, /ui\.codex_setup_for_ai_only/);
  assert.match(source, /ui\.no_api_key_is_required_the_standalone_codex_cli_does_not_req/);
  assert.match(source, /ui\.no_api_key_is_required_the_standalone_codex_cli_does_not_req/);
  assert.match(source, /ui\.run_codex_in_terminal_and_sign_in_with_your_chatgpt_account/);
  assert.match(source, /if \(showGuide\) this\.openCodexSetupGuide\(\)/);
  assert.match(source, /this\.recheckCodex\(false\)/);
});
integrationTest('generated child filenames are migrated to their topic titles and maps stay linked', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Filename migration'), mapDoc = await repo.readMap(mapPath);
  const child = await repo.createNote('新的子議題', 'a', mapDoc, mapPath, 'workspace');
  await repo.updateNote(child.path, { title: '清楚的子議題名稱' }); mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const count = await repo.normalizeGeneratedNoteFilenames(), updated = await repo.readMap(mapPath);
  assert.equal(count, 1); assert.match(updated.nodes[0].path, /清楚的子議題名稱\.md$/); assert.ok(app.vault.getAbstractFileByPath(updated.nodes[0].path));
});
integrationTest('map topic sources retain every selected summary and working finding', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'a'), second = await topicNote(repo, 'Recipe B', 'a');
  await repo.updateNote(first.path, { summary: 'Use more onion', newFindings: '### 暫存結論\n\nOnion adds sweetness.' });
  await repo.updateNote(second.path, { summary: 'Toast the buns' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const group = await view.topicReferenceGroup([first, second]);
  assert.deepEqual(group.documents.map(document => document.path), [first.path, second.path]);
  assert.match(group.documents[0].content, /Use more onion/);
  assert.match(group.documents[0].content, /Onion adds sweetness/);
  assert.match(group.documents[1].content, /Toast the buns/);
});
integrationTest('legacy integrated source links resolve from short Obsidian links', async () => {
  const { repo, app } = fixture(), source = await topicNote(repo, 'Recipe A', 'a'), root = await topicNote(repo, 'Integrated Burger', 'a');
  await repo.updateNote(root.path, { detail: '### 整合來源（保存內容）\n\n- [[Recipe A]]' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  assert.deepEqual(plain(view.referenceSourcePaths(await repo.readNote(root.path), root.path)), [source.path]);
});
integrationTest('creating an integrated topic runs AI with full sources and keeps clickable source paths', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  await repo.updateNote(first.path, { summary: 'Saved onion note', newFindings: 'Caramelize slowly.' });
  await repo.updateNote(second.path, { summary: 'Saved bun note' });
  first.x = 80; first.y = 80; second.x = 420; second.y = 220;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, askModel: async context => {
    assert.equal(context.mode, 'synthesize'); const allSources = context.referenceGroups.flatMap(group => group.documents).map(document => document.content).join('\n'); assert.match(allSources, /Saved onion note/); assert.match(allSources, /Caramelize slowly/); assert.match(allSources, /Saved bun note/);
    return { summary: 'Integrated answer', detail: 'Integrated detail', suggestions: [] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.createIntegratedNode('Personal Burger', [first, second], 'Find the best approach', 'Use tables');
  const savedMap = await repo.readMap(mapPath); assert.equal(savedMap.nodes.length, 3);
  const integrated = await repo.readNote(savedMap.nodes[2].path);
  assert.match(integrated.detail, /### Core conclusions/);
  assert.deepEqual(integrated.sourcePaths, [first.path, second.path]);
  assert.equal(integrated.rules, '');
  assert.equal(integrated.status, 'completed');
});
integrationTest('failed multi-select integration creates no empty root or note', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, askModel: async () => { throw new Error('provider unavailable'); } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await assert.rejects(() => view.createIntegratedNode('Should not exist', [first, second], 'Combine', ''), /provider unavailable/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics/map-a/Notes/Should not exist.md'), undefined);
});
integrationTest('saved integration is not offered for retry when derived-data refresh fails', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Source A'), second = await topicNote(repo, 'Source B');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { throw new Error('refresh unavailable'); }, askModel: async () => ({ summary: 'Combined', detail: 'Combined knowledge', suggestions: [] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.focusNode = () => {};
  await view.createIntegratedNode('Combined', [first, second], 'Compare', '');
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal(view.integrationTask, null);
});
integrationTest('topic notes hide properties without removing existing css classes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Styled', 'a');
  let content = contents.get(n.path); assert.match(content, /visual-agent-map-node/);
  content = content.replace('cssclasses: ["visual-agent-map-node"]', 'cssclasses: ["user-class"]'); contents.set(n.path, content);
  await repo.ensureNodePresentation(); content = contents.get(n.path); assert.match(content, /user-class/); assert.match(content, /visual-agent-map-node/);
});
integrationTest('deleted map restore refuses an occupied path without changing its contents', async () => {
  const { repo, app } = fixture(), path = await repo.createMap('Restoration conflict', []);
  const existing = await app.vault.read(repo.file(path));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo });
  view.deletedMap = { path, content: 'previous map contents', map: await repo.readMap(path), deleted: true };
  await assert.rejects(() => view.restoreDeletedMap());
  assert.equal(await app.vault.read(repo.file(path)), existing);
  assert.equal(view.deletedMap.deleted, true);
});
integrationTest('map structural undo restores deleted branch; redo removes it again', async () => {
  const { repo, app } = fixture(); const file = await repo.createMap('Undo', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(m => { m.nodes = core.removeNodes(m.nodes, 'a', true); }); assert.equal((await repo.readMap(file)).nodes.length, 1);
  await view.travel(false); assert.equal((await repo.readMap(file)).nodes.length, 4);
  await view.travel(true); assert.equal((await repo.readMap(file)).nodes.length, 1);
});
integrationTest('layout-only map changes and AI note results do not rebuild derived data', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Layout', tree()); let rebuilds = 0;
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => { rebuilds++; } });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(map => { map.nodes[0].x = 120; map.viewport.zoom = 1.2; }); assert.equal(rebuilds, 0);
  await view.mapChange(map => { map.nodes[0].parentId = 'd'; }); assert.equal(rebuilds, 1);
});
integrationTest('full auto layout can be undone without changing parent links', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Arrange', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => assert.fail('layout should not rebuild ownership') });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  const before = plain(view.map.nodes);
  await view.mapChange(map => { map.nodes = layout.arrangeMap(map.nodes); }, false);
  const after = (await repo.readMap(file)).nodes;
  assert.notDeepEqual(plain(after), before);
  assert.deepEqual(Array.from(after, item => item.parentId), Array.from(before, item => item.parentId));
  await view.travel(false);
  assert.deepEqual(plain((await repo.readMap(file)).nodes), before);
});
integrationTest('Codex App Server uses model/list, selected reasoning and fresh ephemeral threads', async () => {
  const { EventEmitter } = require('node:events'); let command, args, turnCount = 0, threadCount = 0, unsubscribeCount = 0; const efforts = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    const reply = result => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`)));
    if (message.method === 'initialize') reply({});
    else if (message.method === 'model/list') reply({ data: [
      { id: 'visible', model: 'visible-model', displayName: 'Visible', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
      { id: 'hidden', model: 'hidden-model', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: false },
      { id: 'internal', model: 'internal-model', displayName: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false }
    ], nextCursor: null });
    else if (message.method === 'thread/start') { assert.equal(message.params.ephemeral, true); assert.equal(message.params.sandbox, 'read-only'); reply({ thread: { id: `thread-${++threadCount}` } }); }
    else if (message.method === 'thread/unsubscribe') { unsubscribeCount++; reply({}); }
    else if (message.method === 'turn/start') {
      turnCount++; efforts.push(message.params.effort); assert.ok(message.params.outputSchema.properties.summary); assert.match(message.params.input[0].text, /Current topic/);
      assert.deepEqual(plain(message.params.sandboxPolicy), { type: 'readOnly', networkAccess: false });
      const threadId = message.params.threadId, summary = threadId === 'thread-1' ? 'first' : 'second';
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { turn: { id: `turn-${turnCount}` } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId: `turn-${turnCount}`, item: { type: 'agentMessage', text: 'Progress commentary' } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId: `turn-${turnCount}`, item: { type: 'agentMessage', text: JSON.stringify({ summary, detail: 'detail', suggestions: [], visualReferences: [] }) } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } })}\n`));
      });
    }
  } };
  const { default: Plugin } = load('main.ts', { obsidian, 'node:fs': { existsSync: () => false, readdirSync: () => [] }, 'node:child_process': { spawn: (path, invocation) => { command = path; args = invocation; return child; } } });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() }, workspace: { getLeavesOfType: () => [] } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  plugin.saveData = async data => { plugin.saved = data; };
  await plugin.refreshCodexModels();
  plugin.settings.cliReasoning = 'low';
  const [result, second] = await Promise.all([
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'task' }, 'visible-model', 'medium'),
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'synthesize' }, 'visible-model', 'medium')
  ]);
  assert.equal(command, DEFAULT_SETTINGS.codexPath); assert.deepEqual(Array.from(args), ['app-server']);
  assert.equal(turnCount, 2); assert.equal(threadCount, 2);
  assert.equal(unsubscribeCount, 2);
  assert.deepEqual(efforts, ['medium', 'medium']);
  assert.equal(plugin.settings.models, 'visible-model');
  assert.equal(result.summary, 'first');
  assert.equal(second.summary, 'second');
});
integrationTest('Codex App Server accepts a plain-text turn without changing structured VAM turns', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let steer;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') { assert.equal(message.params.config['features.shell_tool'], false); assert.equal(message.params.config['features.unified_exec'], false); assert.match(message.params.baseInstructions, /text-generation/); emit({ id: message.id, result: { thread: { id: 'plain-thread' } } }); }
    else if (message.method === 'turn/start') {
      assert.equal(Object.hasOwn(message.params, 'outputSchema'), false);
      emit({ id: message.id, result: { turn: { id: 'plain-turn' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'plain-thread', itemId: 'agent-1', delta: '# Full' } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'plain-thread', itemId: 'agent-1', delta: ' conversation' } });
    } else if (message.method === 'turn/steer') {
      assert.match(message.params.input[0].text, /include parent question/); emit({ id: message.id, result: {} });
      emit({ method: 'item/completed', params: { threadId: 'plain-thread', item: { id: 'agent-1', type: 'agentMessage', text: '# Full conversation' } } });
      emit({ method: 'turn/completed', params: { threadId: 'plain-thread', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try { const chunks = []; const running = runtime.runTask('coffee', 'model', 'high', undefined, { textOnly: true, onText: text => chunks.push(text), onSteer: handler => { steer = handler; } }); await until(() => !!steer); await steer('include parent question'); assert.equal(await running, '# Full conversation'); assert.deepEqual(chunks, ['# Full', '# Full conversation', '# Full conversation']); }
  finally { runtime.stop(); }
});
integrationTest('AI exchange logging captures the sent payload, raw reply and parse failure', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-capture-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    let reply = '{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}';
    plugin.runtime = () => ({ runTask: async (prompt, model, effort, _schema, controls) => { controls.onRequest({ input: prompt, model, effort }); return reply; } });
    const context = { title: 'Private topic', summary: 'private summary', rules: '', detail: '', task: 'Analyze this', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
    await plugin.askModel(context, 'test-model', 'low');
    reply = 'invalid raw answer';
    await assert.rejects(plugin.askModel(context, 'test-model', 'low'));
    await plugin.exchanges.flush();
    const entries = plugin.exchanges.getEntries();
    assert.equal(entries.length, 2);
    assert.match(entries[0].request, /private summary/); assert.match(entries[0].response, /"summary":"done"/); assert.equal(entries[0].status, 'parsed');
    assert.equal(entries[1].response, 'invalid raw answer'); assert.equal(entries[1].status, 'failed'); assert.match(entries[1].error, /解析 AI 回覆/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('turning exchange logging off during a task stops recording its reply', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-toggle-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    let release;
    plugin.runtime = () => ({ runTask: async (_prompt, _model, _effort, _schema, controls) => {
      controls.onRequest({ input: 'sent prompt' });
      return new Promise(resolve => { release = resolve; });
    } });
    const context = { title: 'Topic', summary: '', rules: '', detail: '', task: 'task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
    const running = plugin.askModel(context, 'test-model', 'low');
    await new Promise(resolve => setTimeout(resolve, 0));
    plugin.settings.aiExchangeLoggingEnabled = false;
    release('{"summary":"done","detail":"private answer","suggestions":[],"visualReferences":[]}');
    await running; await plugin.exchanges.flush();
    const entry = plugin.exchanges.getEntries()[0];
    assert.match(entry.request, /sent prompt/);
    assert.equal(entry.response, '');
    assert.equal(entry.status, 'sent');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('local Codex runtime disables web search for its process', async () => {
  const { EventEmitter } = require('node:events'); let args;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (_path, invocation) => { args = invocation; return child; } } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', webSearchDisabled: true });
  await runtime.start(); assert.deepEqual(plain(args), ['--config', 'web_search="disabled"', 'app-server']); runtime.stop();
});
integrationTest('research budget sends one stop-search steer after three searches', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      for (let i = 0; i < 3; i++) emit({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'webSearch', action: { type: 'search' } } } });
    } else if (message.method === 'turn/steer') {
      emit({ id: message.id, result: { turnId: 'turn-1' } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try {
    assert.equal(await runtime.runTask('research', 'model', 'low', {}, { searchBudget: 3 }), 'answer');
    assert.equal(sent.filter(message => message.method === 'turn/steer').length, 1);
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 0);
    assert.match(sent.find(message => message.method === 'turn/steer').params.input[0].text, /停止搜尋/);
  } finally { runtime.stop(); }
});
integrationTest('cancelling a Codex turn sends interrupt and rejects the result', async () => {
  const { EventEmitter } = require('node:events'); const sent = [], timerDelays = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    else if (message.method === 'turn/interrupt') { emit({ id: message.id, result: {} }); emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'interrupted' } } }); }
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } }, { setTimeout: (callback, delay) => { timerDelays.push(delay); return setTimeout(callback, delay); } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const controller = new AbortController();
  try {
    const pending = runtime.runTask('research', 'model', 'low', {}, { signal: controller.signal });
    while (!sent.some(message => message.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.equal(timerDelays.at(-1), 30_000);
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
  } finally { runtime.stop(); }
});
for (const delayedStart of [false, true]) test(`timed-out Codex turn attempts one interrupt${delayedStart ? ' after a late turn/start reply' : ''}`, async () => {
  const { EventEmitter } = require('node:events'); const sent = [], logs = []; let turnTimeout, startRequest;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') { startRequest = message.id; if (!delayedStart) emit({ id: message.id, result: { turn: { id: 'turn-1' } } }); }
    else if (message.method === 'turn/interrupt') emit({ id: message.id, error: { message: 'interrupt unavailable' } });
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const windowValues = {
    setTimeout: (callback, delay) => delay === 180_000 ? (turnTimeout = callback, 1) : setTimeout(callback, delay),
    clearTimeout: timer => { if (timer !== 1) clearTimeout(timer); }
  };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } }, windowValues);
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', onLog: (level, message) => logs.push([level, message]) });
  try {
    const pending = runtime.runTask('research', 'model', 'low', {});
    while (!startRequest || !turnTimeout) await new Promise(resolve => setImmediate(resolve));
    if (!delayedStart) await new Promise(resolve => setImmediate(resolve));
    turnTimeout();
    if (delayedStart) emit({ id: startRequest, result: { turn: { id: 'turn-1' } } });
    await assert.rejects(pending, /AI task exceeded 3 minutes.*interrupt it to avoid prolonged resource use.*Incomplete results are not applied/);
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.filter(([level, message]) => level === 'warn' && message.includes('逾時後無法停止 AI 任務')).length, 1);
  } finally { runtime.stop(); }
});
integrationTest('Codex App Server declines unsupported interaction requests instead of hanging', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  await runtime.start();
  const requests = [
    { id: 'command', method: 'item/commandExecution/requestApproval', expected: { decision: 'decline' } },
    { id: 'file', method: 'item/fileChange/requestApproval', expected: { decision: 'decline' } },
    { id: 'permission', method: 'item/permissions/requestApproval', expected: { permissions: {} } },
    { id: 'input', method: 'item/tool/requestUserInput', expected: { answers: {} } },
    { id: 'mcp', method: 'mcpServer/elicitation/request', expected: { action: 'decline', content: null } }
  ];
  for (const request of requests) child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, method: request.method, params: {} })}\n`));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'unknown', method: 'unknown/request', params: {} })}\n`));
  await new Promise(resolve => setImmediate(resolve));
  for (const request of requests) assert.deepEqual(plain(sent.find(message => message.id === request.id)?.result), request.expected);
  assert.equal(sent.find(message => message.id === 'unknown')?.error?.code, -32601);
  runtime.stop();
});
integrationTest('Codex App Server ignores stale child events after a clean restart', async () => {
  const { EventEmitter } = require('node:events'); const children = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin = { write: line => {
      const message = JSON.parse(line.trim());
      if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      else if (message.method === 'model/list') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`)));
    } };
    children.push(child); return child;
  };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  await runtime.start();
  const first = children[0]; first.stdout.emit('data', Buffer.from('{')); first.emit('error', new Error('first failed'));
  await runtime.start();
  first.emit('close', 1);
  await runtime.listModels();
  assert.equal(children.length, 2);
  runtime.stop();
});
test('Claude CLI uses the local structured-output interface with tools restricted by task mode', async () => {
  const { EventEmitter } = require('node:events'); let args, prompt, cwd;
  const result = { type: 'result', subtype: 'success', is_error: false, structured_output: { summary: 'Summary', detail: 'Evidence', suggestions: [], visualReferences: [] } };
  const spawn = (_executable, received, options) => {
    args = received; cwd = options.cwd;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { end: text => { prompt = text; process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(result))); child.emit('close', 0); }); } };
    return child;
  };
  const { ClaudeCodeCliRuntime, claudeTaskArgs, claudeStructuredOutput } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
  const localArgs = claudeTaskArgs('sonnet', 'medium', schema, false);
  const claudeSchema = JSON.parse(localArgs[localArgs.indexOf('--json-schema') + 1]);
  assert.equal(claudeSchema.$schema, undefined);
  assert.deepEqual(claudeSchema.required, ['summary']);
  assert.equal(claudeSchema.additionalProperties, false);
  assert.equal(localArgs[localArgs.indexOf('--tools') + 1], '');
  assert.ok(localArgs.includes('--safe-mode'));
  assert.ok(localArgs.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(localArgs[localArgs.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.ok(localArgs.includes('--no-session-persistence'));
  const webArgs = claudeTaskArgs('opus', 'high', schema, true);
  assert.equal(webArgs[webArgs.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.doesNotMatch(webArgs.join(' '), /\b(Bash|Read|Write|Edit|Agent)\b/);
  const runtime = new ClaudeCodeCliRuntime({ executable: '/usr/local/bin/claude', cwd: '/plugin', env: {}, spawn });
  const raw = await runtime.runTask('VAM prompt', 'sonnet', 'medium', schema, { searchBudget: 0 });
  assert.equal(cwd, '/plugin'); assert.equal(prompt, 'VAM prompt');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.deepEqual(JSON.parse(raw), result.structured_output);
  assert.deepEqual(JSON.parse(claudeStructuredOutput(JSON.stringify([{ type: 'system', subtype: 'init' }, result]))), result.structured_output);
  assert.deepEqual(JSON.parse(claudeStructuredOutput(JSON.stringify(result))), result.structured_output);
  assert.throws(() => claudeStructuredOutput('not-json'));
  assert.throws(() => claudeStructuredOutput(JSON.stringify({ ...result, structured_output: undefined })), /structured result/);
  assert.throws(() => claudeStructuredOutput(JSON.stringify({ ...result, subtype: 'error_max_turns', is_error: true, errors: ['turn limit'] })), /turn limit/);
  const textResult = { type: 'result', subtype: 'success', is_error: false, result: '# Complete Markdown table' };
  assert.equal(claudeStructuredOutput(JSON.stringify(textResult), true), '# Complete Markdown table');
  assert.ok(!claudeTaskArgs('sonnet', 'high', undefined, false).includes('--json-schema'));
});
integrationTest('Claude stream-json keeps one request open for live guest interventions', async () => {
  const { EventEmitter } = require('node:events'); let args, handler, child; const input = [], chunks = [];
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'Hello there' };
  const spawn = (_executable, received) => {
    args = received; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { write: line => { const message = JSON.parse(line); input.push(message); if (input.length === 1) process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello' } } })}\n`))); else process.nextTick(() => { child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: ' there' } } })}\n${JSON.stringify(result)}\n`)); }); return true; }, end: () => process.nextTick(() => child.emit('close', 0)) };
    return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const task = runtime.runTask('initial prompt', 'sonnet', 'low', undefined, { onText: text => chunks.push(text), onSteer: steer => { handler = steer; } });
  await until(() => !!handler); await handler('Ask Lin to explain the cost'); assert.equal(await task, 'Hello there');
  assert.ok(args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');
  assert.deepEqual(input.map(item => item.message.content[0].text), ['initial prompt', 'Ask Lin to explain the cost']);
  assert.deepEqual(chunks, ['Hello', 'Hello there']);
});

test('Claude cancellation rejects immediately and terminates only its own process', async () => {
  const { EventEmitter } = require('node:events'); const kills = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal)); return true; };
    child.stdin = { end: () => {} }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const controller = new AbortController();
  const task = runtime.runTask('prompt', 'sonnet', 'low', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(kills, ['SIGTERM']);
});

test('Claude timeout stops its process and never accepts a late structured result', async () => {
  const { EventEmitter } = require('node:events'); let child; const kills = [];
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal)); return true; };
    child.stdin = { end: () => {} }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn, timeoutMs: 15 });
  const task = runtime.runTask('prompt', 'sonnet', 'low', {});
  await assert.rejects(task, /exceeded 3 minutes/);
  child.stdout.emit('data', Buffer.from(JSON.stringify({ structured_output: { detail: 'late write' } })));
  child.emit('close', 0);
  assert.deepEqual(kills, ['SIGTERM']);
});

test('external map conflict UI retains file, screen, and manual merge choices', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  for (const modal of ['class MapConflictModal']) {
    const start = source.indexOf(modal), next = source.indexOf('\nclass ', start + modal.length);
    const body = source.slice(start, next < 0 ? source.length : next);
    assert.match(body, /ui\.use_file_contents/); assert.match(body, /ui\.keep_editor_contents/); assert.match(body, /ui\.save_merged_contents/);
  }
});

test('VAM notes hide properties in reading and live preview without removing frontmatter', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(styles, /\.markdown-preview-view\.visual-agent-map-node \.metadata-container/);
  assert.match(styles, /body \.workspace-leaf-content\.vam-topic-markdown \.markdown-source-view\.mod-cm6 \.metadata-container \{ display: none; \}/);
  assert.doesNotMatch(styles, /\.markdown-preview-view\.vam-topic-markdown \.metadata-container/);
  assert.doesNotMatch(styles, /!important/);
});

test('Coffee Tables room switches conversation and insights by pane width', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const responsive = styles.slice(styles.indexOf('@container (max-width: 899px)'));
  assert.match(responsive, /\.ct-room-columns\s*\{\s*flex-direction:\s*column/);
  assert.match(responsive, /\.ct-pane-tabs\s*\{[^}]*display:\s*flex/);
  assert.match(responsive, /\.ct-room-columns\[data-pane="chat"\].*\.ct-insight-panel/);
  assert.doesNotMatch(styles.match(/@media\s*\(max-width:\s*900px\)\s*\{([^}]*(?:\}[^}]*)?)\}/s)?.[1] ?? '', /\.ct-room-columns/);
});

integrationTest('legacy User Notes move to preview without losing either section or duplicating on save', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Legacy preview');
  await repo.updateNote(n.path, { preview: 'New preview' });
  contents.set(n.path, contents.get(n.path).replace('## Detail', '## User Notes\n\nLegacy text\n\n## Detail'));
  assert.equal((await repo.readNote(n.path)).preview, 'New preview\n\nLegacy text');
  await repo.updateNote(n.path, { summary: 'AI summary' });
  await repo.updateNote(n.path, { detail: 'AI detail' });
  assert.equal((await repo.readNote(n.path)).preview, 'New preview\n\nLegacy text');
  assert.doesNotMatch(contents.get(n.path), /## User Notes/);
  await repo.updateNote(n.path, { preview: '' });
  assert.equal((await repo.readNote(n.path)).preview, '');
});
test('preview cards display only editable preview content', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const card = source.slice(source.indexOf('preview.createEl("strong", { text: note.title })'), source.indexOf('const host = workspace.getBoundingClientRect()'));
  assert.match(card, /note.preview/);
  assert.doesNotMatch(card, /note.summary|User Notes|目前結論/);
});

integrationTest('first AI answer seeds summary and image in preview, later answers preserve it including an explicit clear', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Preview default');
  assert.equal((await repo.readNote(n.path)).preview, '尚未形成結論');
  await repo.updateNote(n.path, { summary: '簡短結論', detail: '文字\n\n![相關圖片](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '簡短結論\n\n![相關圖片](https://example.com/image.jpg)');
  await repo.updateNote(n.path, { summary: '第二次結論', detail: '新正文' });
  assert.match((await repo.readNote(n.path)).preview, /簡短結論/);
  await repo.updateNote(n.path, { preview: '' });
  await repo.updateNote(n.path, { summary: '第三次結論' });
  assert.equal((await repo.readNote(n.path)).preview, '');
});
integrationTest('AI answer cannot replace preview edited while task was running', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Manual preview');
  await repo.updateNote(n.path, { preview: '使用者的文字' });
  await repo.updateNote(n.path, { summary: 'AI 結論', detail: '![圖](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '使用者的文字');
});
integrationTest('AI history refuses to undo over a later edit and retains the undo entry', async () => {
  const { repo, app } = fixture(), node = await topicNote(repo, 'Conflict guard');
  const before = await repo.readNote(node.path);
  await repo.updateNote(node.path, { summary: 'AI answer', detail: 'AI detail', status: 'completed' });
  const after = await repo.readNote(node.path);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo }); view.map = map([node]); view.render = () => {}; view.hydrate = async () => {};
  view.recordNoteWrite(node.path, before, after, ['summary', 'detail', 'status'], 'Research');
  await repo.updateNote(node.path, { detail: 'Manual follow-up' });
  await assert.rejects(() => view.travel(false));
  assert.equal((await repo.readNote(node.path)).detail, 'Manual follow-up');
  assert.equal(view.history.canUndo, true);
  await repo.updateNote(node.path, { detail: 'AI detail' });
  await view.travel(false);
  assert.equal((await repo.readNote(node.path)).summary, before.summary);
  assert.equal(view.history.canRedo, true);
});
integrationTest('images follow related text and inline images are not duplicated', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Inline images');
  const reference = '**配色建議**\n![配色](https://example.com/color.jpg)\n來源：https://example.com/source';
  await repo.updateNote(n.path, { summary: '結論', detail: '### 核心結論\n\n摘要\n\n### 關鍵知識\n\n配色建議：採用低彩度。\n\n另一項建議。\n\n### 證據與來源\n\n來源', visualReferences: reference });
  let detail = (await repo.readNote(n.path)).detail;
  assert.ok(detail.indexOf('![配色]') > detail.indexOf('配色建議：'));
  assert.ok(detail.indexOf('![配色]') < detail.indexOf('另一項建議'));
  assert.doesNotMatch(detail, /### 視覺參考/);
  await repo.updateNote(n.path, { visualReferences: reference });
  detail = (await repo.readNote(n.path)).detail;
  assert.equal((detail.match(/color.jpg/g) || []).length, 1);
  assert.match((await repo.readNote(n.path)).preview, /color.jpg/);
});

integrationTest('references in synthesized notes remain clickable after rebuilding, updates and source renames', async () => {
  const { repo, contents } = fixture(); const path = await repo.createMap('References', []), mapDoc = await repo.readMap(path);
  const first = await repo.createNote('Source A', 'a', mapDoc, path, 'workspace'), second = await repo.createNote('Source B', 'a', mapDoc, path, 'workspace');
  const integrated = await repo.createNote('Integrated', 'a', mapDoc, path, 'workspace'); mapDoc.nodes.push(first, second, integrated); await repo.saveMap(path, mapDoc);
  await repo.updateNote(integrated.path, {sourcePaths: [first.path, second.path], detail: 'Knowledge'});
  await repo.rebuildDerivedData(); await repo.updateNote(integrated.path, {summary: 'Updated'}); await repo.rebuildDerivedData();
  const text = contents.get(integrated.path);
  assert.match(text, /## Reference Links/);
  assert.ok(text.includes('[[' + first.path.replace(/\.md$/, '') + ']]'));
  assert.ok(text.includes('[[' + second.path.replace(/\.md$/, '') + ']]'));
  assert.equal((text.match(/## Reference Links/g) || []).length, 1);
  assert.equal((await repo.readNote(integrated.path)).detail, 'Knowledge');
  const renamed = await repo.renameNote(first.path, 'Source renamed'); await repo.rebuildDerivedData();
  assert.ok(contents.get(integrated.path).includes('[[' + renamed.replace(/\.md$/, '') + ']]'));
  assert.deepEqual((await repo.readNote(integrated.path)).sourcePaths, [renamed, second.path]);
  const moved = await repo.moveUnique(renamed, repo.topicFolder(path, 'Unassigned'));
  await repo.rebuildDerivedData();
  assert.ok(contents.get(integrated.path).includes('[[' + moved.replace(/\.md$/, '') + ']]'));
});
test('preview renderer receives Markdown in original order with no extra Preview label', () => {
  const created = []; let rendered;
  const rect = {left:0,top:0,right:100,width:800,height:600};
  const element = () => ({style:{setProperty(){}},addEventListener(){},createEl(tag, options){created.push([tag,options.text]);return element()},createDiv(){return element()},getBoundingClientRect(){return rect},remove(){}});
  const workspace = element(); const contentEl = {querySelector(){return workspace}};
  const {VisualAgentMapView} = load('main.ts', {obsidian:{...obsidian,MarkdownRenderer:{render(app, markdown, el, path){rendered={markdown,path};return Promise.resolve()}}}});
  const view = new VisualAgentMapView({app:{}},{settings:{...DEFAULT_SETTINGS}}); view.contentEl=contentEl;view.map=map([node('a')]);
  const markdown='Text first\n\n![Image](https://example.com/a.png)\n\nText after\n\n|A|B|\n|---|---|\n|1|2|';
  view.showHoverCard({...element(),dataset:{nodeId:'a'}},{title:'Topic',preview:markdown});
  assert.equal(rendered.markdown,markdown);assert.equal(rendered.path,'a.md');assert.deepEqual(created,[['strong','Topic']]);
});
integrationTest('dragging synthesized roots persists coordinates and removal preserves notes with undo', async () => {
  const {repo,app} = fixture(), path = await repo.createMap('Root operations', []), mapDoc = await repo.readMap(path);
  const first = await repo.createNote('First','a',mapDoc,path,'workspace'), second=await repo.createNote('Second','a',mapDoc,path,'workspace'); mapDoc.nodes.push(first,second);await repo.saveMap(path,mapDoc);
  let pending=Promise.resolve();
  const plugin={repo,settings:{...DEFAULT_SETTINGS},rebuildDerivedData:()=>repo.rebuildDerivedData(),askModel:async()=>({summary:'Merged',detail:'Knowledge',visualReferences:[],suggestions:[]}),mutate(work){pending=pending.then(work);return pending}};
  const {VisualAgentMapView}=load('main.ts',{obsidian}); const view=new VisualAgentMapView({app},plugin);view.path=path;view.map=mapDoc;view.integrationMode=true;view.render=()=>{};view.focusNode=()=>{};view.drawEdges=()=>{};view.updateHistoryButtons=()=>{};
  await view.createIntegratedNode('Combined',[first,second],'Combine','');
  const root=view.map.nodes.find(n=>n.id!==first.id&&n.id!==second.id); assert.equal(root.parentId,null);assert.equal(view.integrationMode,false);
  const origin={x:root.x,y:root.y}; const events=new Map(),card={style:{},setPointerCapture(){},addEventListener(name,fn){events.set(name,fn)},removeEventListener(name){events.delete(name)}};
  view.enableDrag(card,root);events.get('pointerdown')({target:{closest(){return null}},button:0,clientX:10,clientY:10,pointerId:1});assert.equal(view.dragging,true);
  events.get('pointermove')({clientX:80,clientY:50});events.get('pointerup')({type:'pointerup'});await pending;
  const saved=(await repo.readMap(path)).nodes.find(n=>n.id===root.id); assert.equal(saved.x,origin.x+70);assert.equal(saved.y,origin.y+40);assert.equal(view.dragging,false);
  await view.removeToUnassigned(saved,false);assert.ok(!(await repo.readMap(path)).nodes.some(n=>n.id===root.id));assert.equal((await repo.collectionFiles(path,'Unassigned')).length,1);
  await view.travel(false);assert.ok((await repo.readMap(path)).nodes.some(n=>n.id===root.id));assert.ok(app.vault.getAbstractFileByPath(root.path));
});
test('UI language switch translates stable semantic keys and placeholders', () => {
  const {t,setUiLanguage,translate}=load('i18n.ts');setUiLanguage('en');assert.equal(t('ui.interface_language'),'Interface language');assert.equal(t('ui.expand_0',3),'Expand 3');assert.equal(translate('en','detail.core_conclusions'),'Core conclusions');assert.equal(translate('zh-TW','detail.core_conclusions'),'核心結論');assert.equal(translate('zh-TW','ui.expand_0'),'展開 {0}');assert.equal(translate('zh-TW','ui.interface_language'),'介面語言');
  assert.equal(translate('zh-TW','missing.runtime.key'), 'missing.runtime.key');
});
test('first install defaults to English regardless of Obsidian language while saved VAM choice wins', () => {
  const { initialUiLanguage } = load('i18n.ts');
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(initialUiLanguage(undefined), 'en');
  assert.equal(initialUiLanguage(null), 'en');
  assert.equal(initialUiLanguage('invalid'), 'en');
  assert.equal(initialUiLanguage('en'), 'en');
  assert.equal(initialUiLanguage('zh-TW'), 'zh-TW');
});
test('language change saves before applying and refreshes all views without mutating notes', async () => {
  const { default: Plugin, VisualAgentMapSettingTab } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  const calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const sharedSettings = plugin.settings;
  plugin.saveData = async settings => { calls.push(['save', settings.language, plugin.settings.language]); };
  plugin.repo = { settings: sharedSettings, syncManagedDetailHeadings: async () => { throw new Error('language switch must not rewrite Markdown'); } };
  plugin.views = () => [
    { refreshFromPlugin: async () => { calls.push(['view-a', plugin.settings.language]); throw new Error('test view error'); } },
    { refreshFromPlugin: async () => calls.push(['view-b', plugin.settings.language]) }
  ];
  plugin.coffeeViews = () => [{ refreshForLanguageChange: async () => calls.push(['coffee-a', plugin.settings.language]) }, { refreshForLanguageChange: async () => calls.push(['coffee-b', plugin.settings.language]) }];
  plugin.refreshLocalizedEntrypoints = () => calls.push(['commands', plugin.settings.language]);
  plugin.recordFailure = (...args) => calls.push(['diagnostic', ...args]);
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.settings.language, plugin.languageSwitchPending]) };
  const tab = new VisualAgentMapSettingTab({}, plugin);
  await tab.setControlValue('language', 'zh-TW');
  assert.equal(plugin.settings.language, 'zh-TW');
  assert.deepEqual(calls.filter(([kind]) => ['save', 'commands', 'view-a', 'view-b', 'coffee-a', 'coffee-b'].includes(kind)), [['save', 'zh-TW', 'en'], ['commands', 'zh-TW'], ['view-a', 'zh-TW'], ['view-b', 'zh-TW'], ['coffee-a', 'zh-TW'], ['coffee-b', 'zh-TW']]);
  assert.equal(plugin.settings, sharedSettings);
  assert.equal(plugin.repo.settings.language, 'zh-TW', 'repository keeps the shared settings object updated');
  assert.equal(calls.filter(([kind]) => kind === 'diagnostic').length, 1);
  assert.equal(plugin.languageSwitchPending, false);
  calls.length = 0;
  await tab.setControlValue('language', 'en');
  assert.equal(plugin.settings.language, 'en');
  assert.equal(calls.filter(([kind]) => kind === 'save').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'view-b').length, 1);
});
test('failed language save keeps the old selection and does not refresh views', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async () => { throw new Error('disk full'); };
  plugin.views = () => [{ refreshFromPlugin: async () => calls.push('view') }];
  plugin.refreshLocalizedEntrypoints = () => calls.push('commands');
  plugin.recordFailure = () => calls.push('logged');
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.languageSwitchPending]) };
  assert.equal(await plugin.changeLanguage('zh-TW'), false);
  assert.equal(plugin.settings.language, 'en');
  assert.deepEqual(calls, [['settings', true], 'logged', ['settings', false]]);
});
test('concurrent language changes are ignored until the first save and refresh completes', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  let finishSave, writes = 0;
  const plugin = new Plugin(); plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async () => { writes++; await new Promise(resolve => { finishSave = resolve; }); };
  plugin.views = () => [];
  plugin.refreshLocalizedEntrypoints = () => {};
  plugin.recordFailure = () => {};
  plugin.settingTab = { update() {}, refreshAfterLanguageChange() {} };
  const first = plugin.changeLanguage('zh-TW'); await Promise.resolve();
  assert.equal(plugin.languageSwitchPending, true);
  assert.equal(await plugin.changeLanguage('en'), false);
  assert.equal(writes, 1);
  finishSave();
  assert.equal(await first, true);
  assert.equal(plugin.settings.language, 'zh-TW');
  assert.equal(plugin.languageSwitchPending, false);
});
integrationTest('switching the interface language preserves exact existing Markdown bytes', async () => {
  const { app, contents, repo } = fixture('zh-TW');
  const note = await topicNote(repo, '保留原文');
  const before = contents.get(note.path);
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.settings = repo.settings;
  plugin.repo = repo; plugin.saveData = async () => {}; plugin.views = () => [];
  plugin.refreshLocalizedEntrypoints = () => {}; plugin.settingTab = { update() {}, refreshAfterLanguageChange() {} };
  await plugin.changeLanguage('en');
  await plugin.changeLanguage('zh-TW');
  assert.equal(contents.get(note.path), before);
  assert.equal(await app.vault.read(app.vault.getAbstractFileByPath(note.path)), before);
});
test('built-in Sample language refresh preserves selected topic and view state', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { builtInSample } = load('builtin-sample.ts');
  const plugin = { settings: { language: 'zh-TW' }, syncOutline() {} };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.builtIn = true; view.map = builtInSample('en').map; view.notes = builtInSample('en').notes;
  view.map.viewport = { x: -128, y: 74, zoom: 0.83 };
  view.selected = view.map.nodes[0].id; view.render = () => {};
  const selected = view.selected, viewport = plain(view.map.viewport);
  await view.refreshFromPlugin();
  assert.match(view.map.title, /範例/);
  assert.equal(view.selected, selected);
  assert.deepEqual(plain(view.map.viewport), viewport);
});
test('AI entry prompts for Codex only when unavailable and leaves manual work available', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); let guides = 0;
  plugin.settings = { ...DEFAULT_SETTINGS, models: '' };
  plugin.openCodexSetupGuide = () => { guides++; };
  plugin.codexDiagnostic = () => ({ installed: false });
  assert.equal(await plugin.codexReadyForAi(), false);
  assert.equal(guides, 1);
  plugin.codexDiagnostic = () => ({ installed: true });
  plugin.refreshCodexModels = async () => { plugin.settings.models = 'gpt-test'; };
  assert.equal(await plugin.codexReadyForAi(), true);
  plugin.settings.models = 'gpt-test';
  assert.equal(await plugin.codexReadyForAi(), true);
  assert.equal(guides, 1);
});
test('localized command and ribbon labels follow the selected VAM language', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), attributes = {}, command = { name: '' };
  plugin.ribbonIcon = { setAttribute: (key, value) => { attributes[key] = value; } };
  plugin.localizedCommands = [{ command, key: 'ui.open_map' }];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' }; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map (VAM): Open mind map');
  assert.equal(attributes['aria-label'], 'Open mind map');
  plugin.settings.language = 'zh-TW'; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map (VAM): 開啟心智圖');
});
test('map switch closes only the VAM note that remains in its right pane and clears Obsidian Outline', () => {
  class MarkdownView { constructor(path) { this.file = { path }; } }
  const { default: Plugin } = load('main.ts', { obsidian: { ...obsidian, MarkdownView } });
  const plugin = new Plugin(); let closed = 0, fileCleared = 0, synchronized = 0; plugin.app = { workspace: { getActiveViewOfType: () => ({ leaf: { id: 'map-view' } }), trigger: (event, leaf) => { if (event === 'file-open') { assert.equal(leaf, null); fileCleared++; } else { assert.equal(event, 'active-leaf-change'); assert.equal(leaf.id, 'map-view'); synchronized++; } } } };
  plugin.detailsPath = 'old-note.md';
  plugin.detailsLeaf = { view: new MarkdownView('other-user-note.md'), detach: () => { closed++; } };
  plugin.closeStaleDetails(); assert.equal(closed, 0); assert.equal(fileCleared, 0); assert.equal(synchronized, 0);
  plugin.detailsPath = 'old-note.md';
  plugin.detailsLeaf = { view: new MarkdownView('old-note.md'), detach: () => { closed++; } };
  plugin.closeStaleDetails(); assert.equal(closed, 1); assert.equal(fileCleared, 1); assert.equal(synchronized, 1);
});
test('topic status labels follow the selected UI language after startup', () => {
  const {topicStatusLabel}=load('i18n.ts');
  assert.equal(topicStatusLabel('idea', 'en'), 'To research');
  assert.equal(topicStatusLabel('idea', 'zh-TW'), '待研究');
  assert.equal(topicStatusLabel('error', 'en'), 'Task error');
});
test('all user-facing translations use stable semantic keys', () => {
  const dictionary = fs.readFileSync(path.join(root, 'i18n.ts'), 'utf8');
  const english = dictionary.slice(dictionary.indexOf('const english = {'), dictionary.indexOf('} as const;'));
  const chinese = dictionary.slice(dictionary.indexOf('const traditionalChinese:'), dictionary.lastIndexOf('};'));
  const extract = value => new Set([...value.matchAll(/^  "((?:[^"\\]|\\.)+)":/gm)].map(match => match[1]));
  const keys = extract(english);
  assert.deepEqual([...extract(chinese)].sort(), [...keys].sort(), 'every locale must define exactly the same semantic keys');
  const sourceFiles = ['main.ts', 'map-model.ts', 'ai/runtime/codex-app-server.ts', ...fs.readdirSync(path.join(root, 'ui')).filter(name => name.endsWith('.ts')).map(name => `ui/${name}`), ...fs.readdirSync(path.join(root, 'ui/modals')).filter(name => name.endsWith('.ts')).map(name => `ui/modals/${name}`)];
  const missing = [];
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) if (!/^[a-z][a-z0-9_.]*$/.test(match[1]) || !keys.has(match[1])) missing.push(`${file}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
  const dictionaryValues = source => new Map([...source.matchAll(/^  "((?:[^"\\]|\\.)+)": "((?:[^"\\]|\\.)*)",?$/gm)].map(match => [match[1], match[2]]));
  const englishValues = dictionaryValues(english), chineseValues = dictionaryValues(chinese);
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [key, value] of englishValues) assert.deepEqual(placeholders(chineseValues.get(key)), placeholders(value), `${key} placeholders must match between locales`);
});

test('reference batches include every selected Markdown source, deduplicate overlaps, split long files, and keep citations', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [
    { id: 'map-a', name: 'Map A', location: 'Maps/A/Map.md', documents: [{ key: 'same', path: 'Maps/A/one.md', content: 'A'.repeat(35_000) }, { key: 'external', path: '/Volumes/Refs/source.md', external: true, content: 'external evidence' }] },
    { id: 'folder', name: 'Folder', location: '/Volumes/Refs', documents: [{ key: 'same', path: 'Maps/A/one.md', content: 'duplicate' }, ...Array.from({ length: 100 }, (_, index) => ({ key: `note-${index}`, path: `Folder/note-${index}.md`, content: `unique-sentinel-${index}` }))] }
  ];
  const batches = api.referenceBatches(groups, 10_000, 12_000);
  const joined = batches.join('\n');
  assert.ok(batches.length > 1); assert.match(joined, /\[S1\] Vault Markdown; cite as an Obsidian wikilink: Maps\/A\/one\.md/);
  assert.match(joined, /\[S2\] external Markdown; cite the exact path as plain text: \/Volumes\/Refs\/source\.md/);
  assert.match(joined, /unique-sentinel-0/); assert.match(joined, /unique-sentinel-99/);
  assert.equal(joined.match(/duplicate/g), null);
  assert.match(joined, /part 1\/4/); assert.match(joined, /part 4\/4/);
  assert.match(api.referenceCatalog(groups), /\[S2\] External file \(plain path\): \/Volumes\/Refs\/source\.md/);
  assert.equal(api.resolveReferenceLinks('See [[source.md]]', groups), 'See 外部來源：/Volumes/Refs/source.md');
  assert.equal(api.resolveReferenceLinks('Vault [S1], external [S2]', groups), 'Vault [[Maps/A/one.md]], external 外部來源：/Volumes/Refs/source.md');
  const namesake = [{ id: 'mixed', documents: [{ path: 'Vault/source.md', content: 'vault' }, { path: '/Volumes/Refs/source.md', external: true, content: 'external' }] }];
  assert.equal(api.resolveReferenceLinks('Vault [S1], external [S2]', namesake), 'Vault [[Vault/source.md]], external 外部來源：/Volumes/Refs/source.md');
  assert.equal(api.resolveReferenceLinks('Ambiguous [[source.md]]', namesake), 'Ambiguous 來源待確認：source.md');
  assert.equal(api.resolveReferenceLinks('Exact [[Vault/source.md]]', namesake), 'Exact [[Vault/source.md]]');
  assert.equal(api.resolveReferenceLinks('Unknown [S3]', namesake), 'Unknown 來源待確認：[S3]');
  assert.equal(api.resolveReferenceLinks('See [[same.md]]', [{ id: 'a', documents: [{ path: '/a/same.md', external: true, content: '' }, { path: '/b/same.md', external: true, content: '' }] }]), 'See 來源待確認：same.md');
});

test('reference picker keeps source groups compact, collapsible and task-local', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.vam-reference-picker \.vam-reference-feedback \.is-hidden\s*\{\s*display:\s*none;\s*\}/);
  const element = (tag, options = {}) => ({ tag, cls: options.cls ?? '', text: options.text ?? '', children: [], dataset: {}, listeners: {},
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); Object.assign(child, value); Object.assign(child, value.attr ?? {}); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', value); this.children.push(child); return child; },
    addEventListener(name, handler) { this.listeners[name] = handler; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, empty() { this.children = []; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  class Modal { constructor() { this.titleEl = element('h2'); this.contentEl = element('div'); } open() {} close() {} }
  const { ReferencePicker } = load('ui/reference-picker.ts', { obsidian: { ...obsidian, Modal, setIcon: (parent, name) => { const icon = element('svg'); icon.iconName = name; parent.children.push(icon); } } });
  const root = element('root');
  const picker = new ReferencePicker({ vault: { adapter: {} } }, root, async () => [], async () => [], 'current', 'Current topic and parent are included');
  const offline = new ReferencePicker({ vault: { adapter: {} } }, element('root'), async () => [], async () => [], 'current', 'Current topic and parent are included', false, true);
  assert.deepEqual(plain(offline.selection()), { webSearch: false, imageSearch: false });
  const area = root.children[0];
  assert.ok(find(area, child => child.cls.includes('vam-reference-cancel')).cls.includes('is-hidden'));
  assert.ok(find(area, child => child.cls.includes('vam-reference-error-acknowledge')).cls.includes('is-hidden'));
  assert.deepEqual(area.children.filter(child => child.cls.includes('vam-reference-section')).map(child => child.cls), [
    'vam-reference-section vam-reference-network-section', 'vam-reference-section vam-reference-local-section'
  ]);
  const web = find(area, child => child.tag === 'input' && child.type === 'checkbox');
  const image = find(area, child => child.tag === 'input' && child !== web && child.type === 'checkbox');
  assert.ok(find(area, child => child.tag === 'strong' && !!child.text));
  const actionRow = find(area, child => child.cls === 'vam-reference-actions');
  assert.equal(actionRow.children.filter(child => child.tag === 'button').length, 3);
  assert.deepEqual(actionRow.children.filter(child => child.tag === 'button').map(button => button.children[0].children[0].iconName), ['brain-circuit', 'folder-open', 'file-text']);
  web.checked = false; web.listeners.change(); assert.equal(image.disabled, true); assert.equal(image.checked, false);
  picker.groups = [{ id: 'map', name: 'Travel map', location: 'Maps/Travel/Map.md', documents: [{ path: 'Maps/Travel/Notes/Train.md', content: 'rail' }] }];
  picker.refresh();
  const details = find(area, child => child.tag === 'details');
  assert.equal(details.open, undefined);
  assert.equal(find(details, child => child.tag === 'ul'), undefined);
  const groupRow = find(area, child => child.cls === 'vam-reference-group-row');
  const remove = find(area, child => child.cls === 'vam-reference-remove');
  assert.equal(groupRow.children.includes(remove), true);
  assert.equal(find(find(details, child => child.tag === 'summary'), child => child.tag === 'button'), undefined);
  details.open = true; details.listeners.toggle();
  assert.equal(find(details, child => child.tag === 'li').text, 'Maps/Travel/Notes/Train.md');
  remove.listeners.click({ preventDefault() {} });
  assert.equal((await picker.ready()).groups.length, 0);
  assert.ok(find(area, child => child.cls.includes('vam-reference-cancel')).cls.includes('is-hidden'));
  const input = (path, content) => ({name: path.split('/').at(-1), webkitRelativePath: path, text: async () => content});
  const archived = input('Vault/Topic/Archive/old.md', '---\nagent-map-node: true\ntopic-state: archived\n---\nOld');
  const ordinary = input('Vault/Archive/ordinary.md', 'Ordinary archive');
  const active = input('Archive/Topics/Archive/Notes/active.md', '---\nagent-map-node: true\ntopic-state: active\n---\nCurrent');
  picker.addFolder([archived, ordinary, active]);
  let chosen = await picker.ready();
  assert.deepEqual(plain(chosen.groups.flatMap(group => group.documents).map(doc => doc.path)), [ordinary.webkitRelativePath, active.webkitRelativePath]);
  assert.ok(find(area, child => child.text.includes('Excluded 1')));
  picker.addFiles([archived]); chosen = await picker.ready();
  assert.equal(chosen.groups.flatMap(group => group.documents).length, 3);
  assert.ok(chosen.groups.flatMap(group => group.documents).some(doc => doc.content.endsWith('Old')));
});

integrationTest('Markdown reader accepts only Markdown and reads the full file without changing it', async () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const body = 'Full source sentinel\n'.repeat(30_000);
  const file = { extension: 'md', path: 'Maps/Source.md' };
  const result = await api.readMarkdownFile({ vault: { read: async selected => { assert.equal(selected, file); return body; } } }, file);
  assert.equal(result.path, file.path); assert.equal(result.content, body); assert.equal(result.external, undefined);
  await assert.rejects(api.readMarkdownFile({ vault: { read: async () => { throw new Error('should not read'); } } }, { extension: 'pdf', path: 'Source.pdf' }), /Only Markdown/);
});

integrationTest('legacy reference metadata is preserved but no longer copied when duplicating a map', async () => {
  const { repo } = fixture(); const note = await topicNote(repo, 'Reference owner', 'model');
  await repo.updateNote(note.path, { referencePaths: ['Evidence.pdf', 'Other.md'], detail: 'Keep all detail' });
  const preserved = await repo.readNote(note.path);
  assert.deepEqual(preserved.referencePaths, ['Evidence.pdf', 'Other.md']); assert.equal(preserved.detail, 'Keep all detail');
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(source, /referencePaths:\s*note\.referencePaths/);
});

integrationTest('persisted JSON validates all exchange fields and optional suggestion parent without rewriting input', async () => {
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-json-boundary-'));
  try {
    const file = path.join(directory, 'exchanges.json');
    const valid = { id: '1', startedAt: 'now', topic: 'Topic', mode: 'task', model: 'test', effort: 'low', request: 'prompt', response: 'answer', status: 'completed', error: '' };
    const invalid = Object.keys(valid).map(key => ({ ...valid, [key]: 12 }));
    const text = JSON.stringify([valid, ...invalid, { ...valid, status: 'unknown' }]); fs.writeFileSync(file, text);
    const errors = []; const log = new AiExchangeLog(file, error => errors.push(error)); await log.load();
    assert.equal(log.getEntries().length, 0); assert.equal(errors.length, 1);
    log.begin({ ...valid, id: 'new' }); await log.flush(); assert.equal(fs.readFileSync(file, 'utf8'), text);
    const proposals = path.join(directory, 'suggestions.json');
    fs.writeFileSync(proposals, JSON.stringify([['topic.md', [{ title: 'A', task: 'B', contribution: 'C' }, { title: 'A', task: 'B', contribution: 'C', parentTitle: 12 }]]]));
    const pending = new PendingSuggestions(proposals, error => errors.push(error)); await pending.load();
    assert.equal(pending.size, 0); const original = fs.readFileSync(proposals, 'utf8');
    pending.set('new.md', [{ title: 'New', task: '', contribution: '' }]); await assert.rejects(pending.flush());
    assert.equal(fs.readFileSync(proposals, 'utf8'), original);
    for (const Store of [AiExchangeLog, PendingSuggestions]) {
      const failures = []; const broken = new Store(file, error => failures.push(error));
      fs.writeFileSync(file, '{broken'); await broken.load(); assert.equal(failures.length, 1);
      fs.rmSync(file); const missing = new Store(file, error => failures.push(error)); await missing.load(); assert.equal(failures.length, 1);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

integrationTest('Codex launch preserves executable as one argument and refuses privileged server requests', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let launch;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); sent.push(message); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (...args) => { launch = args; return child; } } });
  const executable = '/trusted path/codex;unexpected'; const env = { PATH: '/trusted/bin' };
  const runtime = new CodexAppServerRuntime({ executable, cwd: '/vault/custom-config/plugins/visual-agent-map', env, clientVersion: 'test' });
  try {
    await runtime.start(); assert.equal(launch[0], executable); assert.deepEqual(plain(launch[1]), ['app-server']);
    assert.equal(launch[2].cwd, '/vault/custom-config/plugins/visual-agent-map'); assert.equal(launch[2].env, env); assert.ok(!launch[2].shell);
    for (const [index, method] of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'unknown/privilege'].entries()) {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'server-' + index, method, params: {} })}\n`));
    }
    assert.deepEqual(sent.find(message => message.id === 'server-0').result, { decision: 'decline' });
    assert.deepEqual(sent.find(message => message.id === 'server-1').result, { decision: 'decline' });
    assert.deepEqual(sent.find(message => message.id === 'server-2').result, { permissions: {} });
    assert.equal(sent.find(message => message.id === 'server-3').error.code, -32601);
  } finally { runtime.stop(); }
});

// Coffee Tables uses one plain-text generation, then one request per follow-up.
const coffeeTypes = load('experiences/coffee-tables/types.ts');
const coffee = load('experiences/coffee-tables/engine.ts');
const coffeePrompts = load('experiences/coffee-tables/prompts.ts');
const coffeeInsights = load('experiences/coffee-tables/insights.ts');
const coffeeGuestInvitations = load('experiences/coffee-tables/guest-invitations.ts');
test('Coffee insight migration retains distinct older notes and creates stable IDs', () => {
  const oldest = '# 觀察者整理\n\n## 核心分歧\n- 規則一致能增加可預期性，但無法消除起點差異。<!-- source: 規則要一樣 -->\n';
  const latest = '# 觀察者整理\n\n## 核心分歧\n- 規則一致能增加可預期性，但無法消除起點差異。\n- 申請門檻可能先排除最需要協助的人。\n';
  const baseline = coffeeInsights.baselineFromVersions([latest, oldest], 'zh-TW');
  assert.equal(baseline.length, 2);
  assert.equal(new Set(baseline.map(item => item.id)).size, 2);
  assert.equal(baseline[0].sources[0], '規則要一樣');
});
test('Coffee insight merge updates IDs, explicitly folds aliases, and keeps omitted insights', () => {
  const current = coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 舊觀點 A。\n- 舊觀點 B。\n'], 'zh-TW');
  const [a,b] = current;
  const update = `# 觀察者整理\n\n## 疑問與可能解方\n- 疑問的可能解方仍受資源限制。<!-- coffee-insight:merge:${a.id},${b.id} -->\n  疑問：需要支援但流程很長。\n  可能解方：提供簡化申請。\n  條件與限制：簡化流程仍需足夠人力。\n`;
  const merged = coffeeInsights.mergeInsightUpdates(current, update, 'zh-TW');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, a.id);
  assert.deepEqual(plain(merged[0].mergedIds), [b.id]);
  assert.match(merged[0].proposedSolution, /簡化申請/);
  assert.match(merged[0].detail, /舊觀點 B/);
  const roundTrip = coffeeInsights.parseInsightNotes(coffeeInsights.serializeInsightNotes(merged, 'zh-TW'), 'zh-TW');
  assert.equal(roundTrip[0].id, a.id);
  assert.deepEqual(plain(roundTrip[0].mergedIds), [b.id]);
});
test('Coffee insight update preserves the explicit ID through summary changes and reopen', () => {
  const original = coffeeInsights.serializeInsightNotes(coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 規則一致可能掩蓋不同起點。\n'], 'zh-TW'), 'zh-TW');
  const before = coffeeInsights.parseInsightNotes(original, 'zh-TW')[0];
  const generated = `# 觀察者整理\n\n## 核心分歧\n- 統一規則提升可預期性，卻可能讓起點差異更難被看見。<!-- coffee-insight:update:${before.id} -->\n  - 脈絡：來賓補充資源配置條件會改變規則效果。\n`;
  const revised = coffeeInsights.mergeInsightUpdates([before], generated, 'zh-TW');
  assert.equal(revised[0].id, before.id);
  const reopened = coffeeInsights.baselineFromVersions([coffeeInsights.serializeInsightNotes(revised, 'zh-TW')], 'zh-TW');
  assert.equal(reopened[0].id, before.id);
  assert.match(reopened[0].summary, /統一規則提升可預期性/);
});
test('Coffee insight duplicate consolidation retains persisted merge aliases', () => {
  const versions = [
    '# 觀察者整理\n\n## 核心分歧\n- 同一核心觀點。<!-- coffee-insight:v1:id=primary;merged=older-alias -->\n',
    '# 觀察者整理\n\n## 核心分歧\n- 同一核心觀點。<!-- coffee-insight:v1:id=duplicate;merged=another-alias -->\n',
  ];
  const merged = coffeeInsights.baselineFromVersions(versions, 'zh-TW');
  assert.equal(merged.length, 1);
  assert.deepEqual(plain(merged[0].mergedIds), ['older-alias', 'duplicate', 'another-alias']);
  const reopened = coffeeInsights.parseInsightNotes(coffeeInsights.serializeInsightNotes(merged, 'zh-TW'), 'zh-TW');
  assert.deepEqual(plain(reopened[0].mergedIds), ['older-alias', 'duplicate', 'another-alias']);
});
test('Coffee insight update rejects unknown targets without modifying baseline', () => {
  const current = coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 保留舊內容。\n'], 'zh-TW');
  assert.throws(() => coffeeInsights.mergeInsightUpdates(current, '# 觀察者整理\n\n## 核心分歧\n- 新內容。<!-- coffee-insight:update:missing-id -->\n', 'zh-TW'), /unknown|不存在/i);
  assert.match(coffeeInsights.serializeInsightNotes(current, 'zh-TW'), /保留舊內容/);
});
test('Coffee invitation validation accepts a new guest and caps cumulative room size', () => {
  const types = load('experiences/coffee-tables/types.ts');
  const counts = { experts: 4, 'cross-domain': 1, generalist: 1, affected: 1 };
  const invites = (length, category = 'experts') => Array.from({ length }, (_, index) => ({ id: `new-${index}`, name: `新來賓${index}`, category, description: '帶來不同處境的觀點' }));
  assert.equal(coffeeGuestInvitations.validateGuestInvitations(invites(1), counts, []), null);
  assert.match(coffeeGuestInvitations.validateGuestInvitations(invites(6), counts, []), /12 位/);
  assert.match(coffeeGuestInvitations.validateGuestInvitations([{ ...invites(1)[0], name: '既有來賓' }], counts, [], undefined, ['既有來賓']), /已在這桌/);
  const completed = { id: 'asked-before', question: 'q', answer: 'a', status: 'complete', invitedGuests: invites(1, 'affected') };
  assert.equal(coffeeGuestInvitations.validateGuestInvitations(invites(4).map((guest, index) => ({ ...guest, id: `later-${index}`, name: `後續來賓${index}` })), counts, [completed]), null);
  assert.ok(types.parseSession(JSON.stringify({ ...types.createSession('題目', 'm', 'low', 'zh-TW'), status: 'completed', questions: [{ ...completed, createdAt: new Date().toISOString() }] })).questions[0].invitedGuests);
});
test('Coffee Tables every prompt mode carries cumulative update operations and the solutions category', () => {
  const session = coffeeTypes.createSession('整桌題目', 'm', 'low', 'zh-TW');
  session.status = 'completed';
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 最新整桌洞見。', '# 觀察者整理\n\n## 意外連結\n- 更早保存的跨域連結。'];
  const prompts = [coffeePrompts.tablePrompt(session.topic, session.language, session.guests), coffeePrompts.tablePrompt(session.topic, session.language, session.guests, '草稿'), coffeePrompts.questionPrompt(session, '新追問'), coffeePrompts.observerOnlyPrompt(session)];
  for (const prompt of prompts) {
    assert.match(prompt, /疑問與可能解方/);
    assert.match(prompt, /coffee-insight:(?:keep|update|merge):/);
    assert.match(prompt, /coffee-insight:new/);
    assert.match(prompt, /沒有重新輸出的舊項目會由程式保留|the program retains old items you do not rewrite/i);
  }
  const refresh = coffeePrompts.observerOnlyPrompt(session);
  assert.match(refresh, /更早保存的跨域連結/);
});
test('Coffee follow-up prompts name invited guests and retain them in later table continuations', () => {
  const session = coffeeTypes.createSession('整桌題目', 'm', 'low', 'zh-TW');
  const invite = { id: 'guest-invite-1', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' };
  const followUp = coffeePrompts.questionPrompt(session, '夜班怎麼找支援', '', [invite]);
  assert.match(followUp, /林照[｜|]受影響者：熟悉夜班與照護資源的社工/);
  session.questions.push({ id: 'q-1', createdAt: session.createdAt, question: '已完成的追問', answer: '林照談到夜班資源。', status: 'complete', invitedGuests: [invite] });
  assert.match(coffeePrompts.tablePrompt(session.topic, session.language, session.guests, '', coffeePrompts.assembleCoffeeContext(session)), /林照[｜|]受影響者：熟悉夜班與照護資源的社工/);
});
const coffeeSession = () => coffeeTypes.createSession('學生免費的營養午餐是否應該開放讓家長加價', 'test-model', 'high', 'zh-TW');
const coffeeTableList = load('experiences/coffee-tables/list.ts');
const coffeeTopics = load('experiences/coffee-tables/topics.ts');
integrationTest('Coffee Tables keeps an invited guest through failed retry and later continuation', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 周沐｜主持人\n\n先談如何求援。'; session.rounds = [{ id: 'prior-round', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  const invitation = { id: 'invite-care-worker', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' }; let fail = true, prompts = [];
  const notes = '# 觀察者整理\n\n' + ['意外連結','值得繼續想的問題','核心分歧','探索方向','值得查證的假設'].map((title,index)=>`## ${title}\n- 具體洞見 ${index + 1}，脈絡完整且仍待對談推進。`).join('\n\n');
  const engine = new coffee.CoffeeEngine(session, async request => { prompts.push(request.prompt); if (fail) throw new Error('retry this invite'); if (prompts.length === 2) return `### 林照｜受影響者\n\n夜班同仁要有可直接使用的求援窗口。\n\n${notes}`; return `### 周沐｜主持人\n\n${prompts.length === 3 ? '林照提出的窗口需要接上正式交接流程。' : '正式交接流程應列明跨班支援窗口。'}\n\n${notes}`; }, async () => {});
  await engine.ask('夜班如何找到即時支援？', 'followup-care', [invitation]); assert.equal(engine.session.questions[0].status, 'error'); assert.equal(JSON.stringify(engine.session.questions[0].invitedGuests), JSON.stringify([invitation]));
  fail = false; await engine.ask('夜班如何找到即時支援？', 'followup-care'); assert.equal(engine.session.questions.length, 1); assert.match(prompts[1], /林照[｜|].*熟悉夜班與照護資源的社工/); assert.equal(engine.session.questions[0].status, 'complete');
  await engine.continueTable(); assert.match(prompts[2], /林照[｜|].*熟悉夜班與照護資源的社工/); assert.match(prompts[2], /求援窗口/); await engine.continueTable(); assert.match(prompts[3], /正式交接流程/); assert.equal(engine.session.observerNotes.length, 1);
});
test('Coffee Tables inspiration topics are bilingual, deterministic in tests and avoid immediate repeats', () => {
  assert.equal(coffeeTopics.COFFEE_TOPICS.length, 20);
  assert.ok(coffeeTopics.COFFEE_TOPICS.every(item => item.zh.length > 8 && item.en.length > 8));
  assert.equal(new Set(coffeeTopics.COFFEE_TOPICS.map(item => item.id)).size, 20);
  assert.equal(coffeeTopics.coffeeTopicText('school-lunch', 'en'), coffeeTopics.COFFEE_TOPICS[6].en);
  assert.equal(coffeeTopics.coffeeTopicText('school-lunch', 'zh-TW'), coffeeTopics.COFFEE_TOPICS[6].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('zh-TW', '', () => 0), coffeeTopics.COFFEE_TOPICS[0].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('zh-TW', coffeeTopics.COFFEE_TOPICS[0].zh, () => 0), coffeeTopics.COFFEE_TOPICS[1].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('en', '', () => 0), coffeeTopics.COFFEE_TOPICS[0].en);
});
test('Coffee Tables roster shows configured role placeholders and replaces introduced guests as text arrives', () => {
  const { rosterFor, liveRosterFor } = load('experiences/coffee-tables/view.ts', { obsidian }); const session = coffeeSession();
  const roster = rosterFor(session, '- **林岑｜主持人**：擅長追問。\n- **許雯｜主題專家**：研究勞動。');
  assert.equal(roster.length, 10); assert.deepEqual(Array.from(roster.slice(0, 2), person => person.name), ['林岑', '許雯']);
  assert.equal(roster.filter(person => person.role === '即將登場').length, 8);
  session.rounds = [{ id: 'round-1', markdown: '- **林岑｜主持人**：擅長追問。\n- **許雯｜主題專家**：研究勞動。', notes: '', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }];
  const whileContinuing = liveRosterFor(session, '- **柏翰｜主題專家**：研究組織行為。\n\n### 柏翰｜主題專家\n接續發言。');
  assert.deepEqual(Array.from(whileContinuing.slice(0, 2), person => person.name), ['林岑', '許雯']);
  assert.equal(whileContinuing.find(person => person.name === '柏翰')?.role, '主題專家');
  assert.equal(whileContinuing.length, 10);
});
test('Coffee Tables recent-first list filters states, searches exact topics and sorts by meaningful activity', () => {
  const now = Date.parse('2026-09-30T00:00:00.000Z'), item = (id, topic, status, updatedAt, extra = {}) => ({ id, path: `${id}.md`, topic, status, createdAt: '2026-09-01T00:00:00.000Z', updatedAt, model: 'm', ...extra });
  const entries = [item('older','Shared','completed','2026-09-29T23:00:00.000Z',{lastCompletedAt:'2026-09-02T00:00:00.000Z'}), item('running','Shared','generating','2026-09-20T00:00:00.000Z',{lastGenerationStartedAt:'2026-09-29T23:30:00.000Z'}), item('draft','unfinished','error','2026-09-28T00:00:00.000Z'), item('recent','recent','completed','2026-09-10T00:00:00.000Z',{lastCompletedAt:'2026-09-29T23:45:00.000Z'}), item('past','past','completed','2026-09-29T00:00:00.000Z',{lastCompletedAt:'2026-09-22T00:00:00.000Z'})];
  assert.deepEqual(coffeeTableList.selectTables(entries).map(row => row.id), ['recent','running','draft','past','older']);
  assert.deepEqual(coffeeTableList.selectTables(entries, 'SHARED').map(row => row.id), ['running','older']);
  assert.deepEqual(coffeeTableList.selectTables(entries, '', 'unfinished').map(row => row.id), ['draft']);
  assert.deepEqual(coffeeTableList.selectTables(entries, '', 'completed', ' Shared ').map(row => row.id), ['older']);
  assert.equal(coffeeTableList.topicTableCount('Shared', entries), 2); assert.equal(coffeeTableList.topicTableCount('shared', entries), 0);
  assert.equal(coffeeTableList.tableTime(entries[2]).isFallback, true); assert.equal(coffeeTableList.tableTime(entries[1]).value, Date.parse('2026-09-29T23:30:00.000Z'));
  assert.equal(coffeeTableList.effectiveTableStatus({ status: 'completed', questions: [{ status: 'pending' }], rounds: [] }, true), 'generating'); assert.equal(coffeeTableList.effectiveTableStatus({ status: 'completed', questions: [{ status: 'error' }], rounds: [] }), 'error'); assert.equal(coffeeTableList.effectiveTableStatus({ status: 'generating', questions: [], rounds: [] }), 'error'); assert.deepEqual(coffeeTableList.selectTables([], '').map(row => row.id), []);
});
test('Coffee Tables list timestamps stay compact while retaining clear day and year context', () => {
  const now = new Date(2026, 8, 30, 16, 0).getTime();
  assert.match(coffeeTableList.formatTableTime(new Date(2026, 8, 30, 14, 30).getTime(), now, 'zh-TW'), /^今天/);
  assert.match(coffeeTableList.formatTableTime(new Date(2026, 8, 29, 14, 30).getTime(), now, 'en'), /^Yesterday/);
  assert.doesNotMatch(coffeeTableList.formatTableTime(new Date(2026, 8, 20, 14, 30).getTime(), now, 'zh-TW'), /2026/);
  assert.match(coffeeTableList.formatTableTime(new Date(2025, 8, 20, 14, 30).getTime(), now, 'en'), /2025/);
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition not reached'); };
test('Coffee Tables prompt keeps the owner’s role topology and conversational intent in one plain-text request', () => {
  const prompt = coffeePrompts.tablePrompt('Topic', 'zh-TW');
  assert.match(prompt, /使用者原始主題[\s\S]*\nTopic\n/); assert.match(prompt, /主持人 2 位/); assert.match(prompt, /兩位主持人分工為一位留意矛盾、一位好奇追問/); assert.match(prompt, /觀察者/); assert.match(prompt, /source: 對談中的原句/); assert.equal((prompt.match(/- 主題專家/g) ?? []).length, 4);
  assert.match(prompt, /每個可定位到具體發言的洞見，都要/); assert.match(prompt, /沒有單一來源/);
  assert.match(prompt, /跨領域專家/); assert.match(prompt, /generalist/); assert.match(prompt, /虛構模擬/); assert.match(prompt, /完整保留，不另取聊天室標題/);
  assert.match(prompt, /10–18 次簡短發言/); assert.match(prompt, /# 觀察者整理/); assert.match(prompt, /## 意外連結[\s\S]*## 值得繼續想的問題[\s\S]*## 核心分歧[\s\S]*## 探索方向[\s\S]*## 值得查證的假設/); assert.match(prompt, /每次續聊新增約 8–12 次簡短發言/); assert.match(prompt, /未解問題/); assert.match(prompt, /coffee-tables-complete/);
  const resumed = coffeePrompts.tablePrompt('Topic', 'zh-TW', undefined, '### 林岑｜主持人\n先前中斷的話');
  assert.match(resumed, /不加前言、流程說明或重複人物介紹/); assert.match(resumed, /從前一句自然接續/);
  const resumedEnglish = coffeePrompts.tablePrompt('Topic', 'en', undefined, '### Host\nAn interrupted thought');
  assert.match(resumedEnglish, /without a preamble, process notes/); assert.match(resumedEnglish, /resume naturally from the last sentence/);
  const tailored = coffeePrompts.tablePrompt('原始主題：保留標點？', 'en', { counts: { experts: 0, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [{ id: 'g1', category: 'affected', description: 'frontline support' }], background: '', customPrompt: 'Use small company examples.' });
  assert.match(tailored, /原始主題：保留標點？/); assert.match(tailored, /frontline support/); assert.match(tailored, /Use small company examples/); assert.doesNotMatch(tailored, /4 位與主題相關/); assert.doesNotMatch(tailored, /本桌沒有跨領域來賓/);
  assert.match(tailored, /For an opening, aim for 10–18 concise turns/); assert.match(tailored, /# Observer’s notes/); assert.match(tailored, /## Unexpected connections[\s\S]*## Questions worth pursuing[\s\S]*## Core disagreements[\s\S]*## Directions to explore[\s\S]*## Assumptions to verify/); assert.match(tailored, /questions worth pursuing/i); assert.match(tailored, /coffee-tables-complete/);
  assert.match(tailored, /For every insight that can be located in specific dialogue, append one or more/);
  assert.doesNotMatch(prompt, /JSON|nextSpeakerId|輪數|字數限制/);
  const session = coffeeSession(); session.transcriptMarkdown = '主持人：我們剛才談到免費午餐。';
  assert.match(coffeePrompts.questionPrompt(session, '那家長付費會不會讓孩子被分級？'), /我們剛才談到免費午餐/);
  assert.match(coffeePrompts.questionPrompt(session, '那家長付費會不會讓孩子被分級？'), /家長付費/);
  assert.match(coffeePrompts.questionPrompt(session, '追問'), /## 意外連結[\s\S]*## 值得繼續想的問題[\s\S]*## 核心分歧[\s\S]*## 探索方向[\s\S]*## 值得查證的假設/); assert.match(coffeePrompts.questionPrompt(session, '追問'), /coffee-tables-complete/);
  const snapshot = { ...session, guests: { ...session.guests, styleId: 'style-1', styleName: '輕鬆聊天', stylePrompt: '先多問問題，再整理分歧。', referenceFiles: [{ name: '背景.md', content: '# 標題\n```md\n<!-- coffee-tables-complete -->\n```' }] } };
  assert.match(coffeePrompts.tablePrompt('Topic', 'zh-TW', snapshot.guests), /先多問問題，再整理分歧/); assert.match(coffeePrompts.tablePrompt('Topic', 'zh-TW', snapshot.guests), /背景.md[\s\S]*<!-- coffee-tables-complete -->/);
  assert.match(coffeePrompts.questionPrompt(snapshot, '追問'), /先多問問題，再整理分歧/); assert.match(coffeePrompts.questionPrompt(snapshot, '追問'), /背景.md/);
  assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /先多問問題，再整理分歧/); assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /背景.md/); assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /source: 對談中的原句/);
  assert.throws(() => coffeePrompts.questionPrompt(snapshot, 'x'.repeat(180000)), /太長|too long/);
});
test('Coffee Tables custom style replaces editable built-in behavior guidance in every generation mode', () => {
  const session = coffeeSession();
  session.guests.stylePrompt = '自由深入討論，不限制發言輪數；遇到草稿從全新角度重新展開；觀察者只整理三個最重要的發現。';
  session.observerNotes = ['舊觀察整理'];
  const opening = coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests);
  const continuation = coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests, '### 主持人｜甲\n草稿');
  const followUp = coffeePrompts.questionPrompt(session, '請談談成本', '先前追問草稿');
  const observerRefresh = coffeePrompts.observerOnlyPrompt(session);
  for (const prompt of [opening, continuation, followUp, observerRefresh]) {
    assert.match(prompt, /自由深入討論，不限制發言輪數[\s\S]*遇到草稿從全新角度重新展開/);
    assert.doesNotMatch(prompt, /10–18 次簡短發言|約 8–12 次簡短發言|roughly 8–12 concise speaker turns|10–18 concise speaker turns|每個標題下 2–4 個條列|each followed by 2–4 bullets|一位留意矛盾，一位好奇追問/);
    assert.doesNotMatch(prompt, /只作脈絡，不要重寫|請從最後一句接續|只用來推進討論，不要重寫|請從最後一句繼續|不要重複/);
  }
  assert.match(opening, /### 姓名｜角色/);
  assert.match(opening, /## 意外連結/);
  assert.match(opening, /coffee-tables-complete/);
  assert.match(observerRefresh, /只更新觀察者整理/);
  session.guests.stylePrompt = '';
  assert.doesNotMatch(coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests), /聊天室風格：[\s\S]*?請用自然、口語的繁體中文（台灣用法）對話/);
});
test('Coffee Tables assembles the full timeline chronologically, including interventions, drafts and custom instructions', () => {
  const session = coffeeSession();
  session.guests.customPrompt = '多談第一線的實際情況';
  session.rounds = [{ id: 'r1', markdown: '第一段來賓發言', notes: '', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'r2', markdown: '', draftMarkdown: '第二段未完成草稿', notes: '', status: 'error', createdAt: '2026-01-01T00:00:04.000Z' }];
  session.transcriptMarkdown = '第一段來賓發言';
  session.questions = [{ id: 'q1', question: '追問已完成？', answer: '已完成回答', status: 'complete', createdAt: '2026-01-01T00:00:02.000Z' }, { id: 'q2', question: '追問中斷？', answer: '', draftAnswer: '追問回答草稿', status: 'error', createdAt: '2026-01-01T00:00:05.000Z' }];
  session.interventions = [{ id: 'i1', kind: 'comment', text: '使用者中途補充', createdAt: '2026-01-01T00:00:03.000Z' }];
  const context = coffeePrompts.assembleCoffeeContext(session);
  const positions = ['第一段來賓發言', '追問已完成？', '使用者中途補充', '第二段未完成草稿', '追問中斷？'].map(item => context.indexOf(item));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(coffeePrompts.observerOnlyPrompt(session), /第二段未完成草稿/);
  assert.match(coffeePrompts.observerOnlyPrompt(session), /追問回答草稿/);
  assert.match(coffeePrompts.questionPrompt(session, '接下來呢？'), /多談第一線的實際情況/);
  session.rounds[0].markdown = '### 主持人｜甲\n\n第一句。\n\n### 專家｜乙\n\n第二句。';
  session.interventions = [{ id: 'mid', kind: 'comment', text: '使用者在兩位發言間插話', createdAt: '2026-01-01T00:00:01.500Z', roundId: 'r1', afterTurn: 1 }];
  const interleaved = coffeePrompts.assembleCoffeeContext(session);
  assert.ok(interleaved.indexOf('第一句。') < interleaved.indexOf('使用者在兩位發言間插話'));
  assert.ok(interleaved.indexOf('使用者在兩位發言間插話') < interleaved.indexOf('第二句。'));
});
test('Coffee Tables bilingual samples retain full discussions, five observer notes and a follow-up each', () => {
  const { COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN } = load('experiences/coffee-tables/samples.ts');
  for (const sample of [COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN]) {
    assert.ok(sample.markdown.length > 8000); assert.ok(sample.question.length > 20); assert.ok(sample.answer.length > 100);
    assert.match(sample.markdown, /(?:最大.*討論轉折|Major turns)/); assert.match(sample.markdown, /(?:尚未解決的核心衝突|Unresolved conflicts)/);
  }
  assert.match(COFFEE_SAMPLE_ZH.title, /中文/); assert.match(COFFEE_SAMPLE_EN.title, /English/);
});
test('Coffee Tables validates numeric guest counts and named guests occupy their selected category slots', () => {
  const { parseSession } = coffeeTypes;
  const valid = coffeeSession();
  valid.guests = { counts: { experts: 2, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [{ id: 'named-1', category: 'experts', description: '第一線客服' }], background: '小公司', customPrompt: '多談實際做法' };
  assert.equal(parseSession(JSON.stringify(valid)).guests.guests.length, 1); assert.equal(parseSession(JSON.stringify(valid)).guests.hostCount, 2);
  for (let count = 1; count <= 4; count++) { const hosted = { ...valid, guests: { ...valid.guests, hostCount: count } }; assert.equal(parseSession(JSON.stringify(hosted)).guests.hostCount, count); assert.match(coffeePrompts.tablePrompt('Topic', 'en', hosted.guests), new RegExp(`主持人 ${count} 位`)); }
  assert.throws(() => parseSession(JSON.stringify({ ...valid, guests: { ...valid.guests, hostCount: 5 } })), /guest count/i);
  for (const counts of [
    { experts: 0, 'cross-domain': 0, generalist: 0, affected: 0 },
    { experts: 8, 'cross-domain': 8, generalist: 0, affected: 0 },
    { experts: 9, 'cross-domain': 1, generalist: 1, affected: 1 },
    { experts: 1, 'cross-domain': 0, generalist: 0, affected: 0 },
  ]) {
    const invalid = { ...valid, guests: { ...valid.guests, counts, guests: [{ id: 'named-1', category: 'experts', description: '客服' }, { id: 'named-2', category: 'experts', description: '店長' }] } };
    assert.throws(() => parseSession(JSON.stringify(invalid)), /guest count/i);
  }
});
integrationTest('Coffee Tables continues in the same timeline and refreshes observer notes from the full context', async () => {
  const session = coffeeSession(); session.guests.customPrompt = '多談小公司能採取的做法';
  const notes = (version, label) => `# 觀察者整理\n\n## 最大討論轉折\n- ${label}\n\n## 被推翻或修正的假設\n- ${version}\n\n## 值得繼續追問的問題\n- 下一步？\n\n## 尚未解決的核心分歧\n- 仍有取捨`;
  const responses = [
    `### 主持人｜林岑\n先從規模談起。\n\n${notes('小公司不一定有完整團隊', '從導入轉向誰負責')}`,
    `### 受影響者｜客服代表\n我們要先談員工能不能拒絕。\n\n${notes('效率不代表工作量消失', '追問把焦點帶到拒絕權')}`,
    `### 主持人｜周以安\n先把試辦退出條件寫清楚。\n\n${notes('試辦也需要退出條件', '使用者追問帶出可逆性')}`,
  ];
  const prompts = [];
  const engine = new coffee.CoffeeEngine(session, async request => { prompts.push(request.prompt); return responses.shift(); }, async () => {});
  await engine.start(); const firstTranscript = engine.session.transcriptMarkdown;
  await engine.continueTable();
  assert.equal(engine.session.rounds.length, 2); assert.match(engine.session.transcriptMarkdown, /先從規模談起/); assert.match(engine.session.transcriptMarkdown, /我們要先談員工能不能拒絕/);
  assert.match(prompts[1], /(?:新增約 8–12 次簡短發言|add roughly 8–12 concise speaker turns)/); assert.match(prompts[1], /小公司能採取的做法/); assert.match(prompts[1], /從導入轉向誰負責/);
  assert.equal(engine.session.observerNotes.length, 1); assert.match(engine.session.observerNotes[0], /追問把焦點帶到拒絕權/); assert.match(engine.session.observerNotes[0], /從導入轉向誰負責/);
  await engine.ask('員工能拒絕試辦嗎？');
  assert.match(engine.session.questions.at(-1).question, /員工能拒絕試辦嗎/); assert.match(engine.session.questions.at(-1).answer, /先把試辦退出條件寫清楚/); assert.match(prompts[2], /小公司能採取的做法/); assert.match(prompts[2], /使用者的新問題/); assert.match(prompts[2], /追問把焦點帶到拒絕權/);
  assert.equal(engine.session.observerNotes.length, 1); assert.match(engine.session.observerNotes[0], /小公司不一定有完整團隊/); assert.ok(firstTranscript.length > 0);
});
integrationTest('Coffee Tables makes one full-text call and saves the complete Markdown only after success', async () => {
  const session = coffeeSession(); let calls = 0, saves = [];
  const transcript = '# 對談\n\n### 主持人｜主持人\n\n可以加菜，但別讓孩子被標記。\n\n# 觀察者整理\n\n## 最大討論轉折\n- 從公平轉向選擇\n\n## 被推翻或修正的假設\n- 家長付費必然改善品質\n\n## 值得繼續追問的問題\n- 如何避免標記\n\n## 尚未解決的核心分歧\n- 公平與選擇的取捨';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /1 位中立觀察者/); assert.equal(request.session.model, 'test-model'); return transcript; }, async value => saves.push(plain(value)));
  await engine.generate();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'completed', engine.error); assert.equal(engine.session.transcriptMarkdown, '# 對談\n\n### 主持人｜主持人\n\n可以加菜，但別讓孩子被標記。');
  assert.equal(saves.at(-1).transcriptMarkdown, engine.session.transcriptMarkdown); assert.equal(saves.at(-1).status, 'completed');
});
integrationTest('Coffee Tables recognizes a complete saved draft with bold Markdown insight groups without calling the model again', async () => {
  const session = coffeeSession(); const transcript = '### 主持人｜周沐\n\n先從時間實際去了哪裡開始。\n\n### 觀察者｜許安\n\n要確認績效制度有沒有改變。'; const notes = '# 觀察者整理\n\n- **最新轉折**\n  - 焦點轉向時間是否真的回到員工。\n- **修正後的假設**\n  - 省時不代表工作量下降。\n- **值得繼續追問的問題**\n  - 如何記錄修正成本？\n- **尚未解決的核心分歧**\n  - 產能與喘息空間如何取捨。'; const draft = `${transcript}\n\n${notes}\n\n${transcript}\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.error = 'observer format'; session.draftMarkdown = draft;
  session.rounds = [{ id: 'draft-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0, saved;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async value => { saved = plain(value); });
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /先從時間實際去了哪裡開始/); assert.equal((engine.session.transcriptMarkdown.match(/先從時間實際去了哪裡開始/g) ?? []).length, 1, engine.session.transcriptMarkdown);
  assert.match(engine.session.observerNotes[0], /省時不代表工作量下降/); assert.equal(engine.session.draftMarkdown, undefined); assert.equal(saved.status, 'completed');
});
integrationTest('Coffee Tables recovers complete observer sections when the root heading is missing', async () => {
  const session = coffeeSession();
  const dialogue = '### 主持人｜林岑\n\n對話文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。';
  const notes = [
    '## 意外連結\n\n- 這裡寫出討論中出現的意外連結。',
    '## 值得繼續想的問題\n\n- 還要釐清後續值得討論的問題。',
    '## 核心分歧\n\n- 這裡保留尚未解決的核心分歧。',
    '## 探索方向\n\n- 可以接著探索其他方向。',
    '## 值得查證的假設\n\n- 需要查證的假設仍待確認。',
  ].join('\n\n');
  const draft = `${dialogue}\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.error = 'observer format'; session.draftMarkdown = draft;
  session.rounds = [{ id: 'missing-root-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed');
  assert.match(engine.session.transcriptMarkdown, /簡短觀察/); assert.doesNotMatch(engine.session.transcriptMarkdown, /## 意外連結/);
  assert.match(engine.session.observerNotes[0], /^# 觀察者整理/); assert.match(engine.session.observerNotes[0], /## 意外連結/);
});
integrationTest('Coffee Tables removes earlier rootless observer sections when a complete draft is duplicated', async () => {
  const session = coffeeSession();
  const notes = label => [
    `## 意外連結\n\n- ${label} 的意外連結內容已完整整理。`,
    `## 值得繼續想的問題\n\n- ${label} 後續值得討論的問題仍然存在。`,
    `## 核心分歧\n\n- ${label} 尚未解決的核心分歧需要保留。`,
    `## 探索方向\n\n- ${label} 可以接著探索其他方向。`,
    `## 值得查證的假設\n\n- ${label} 還需要查證這項假設。`,
  ].join('\n\n');
  const first = `### 主持人｜林岑\n\n第一段對談。\n\n### 沈默｜中立觀察者\n\n第一份整理前的觀察。\n\n${notes('第一份')}`;
  const second = `### 主持人｜周禾\n\n第二段對談。\n\n### 沈默｜中立觀察者\n\n第二份整理前的觀察。\n\n${notes('第二份')}`;
  const draft = `${first}\n\n${second}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'duplicate-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed');
  assert.match(engine.session.transcriptMarkdown, /第一段對談/); assert.match(engine.session.transcriptMarkdown, /第二段對談/);
  assert.doesNotMatch(engine.session.transcriptMarkdown, /## 意外連結/);
  assert.match(engine.session.observerNotes[0], /第二份.*意外連結內容/); assert.doesNotMatch(engine.session.observerNotes[0], /第一份.*意外連結內容/);
});
integrationTest('Coffee Tables does not recover rootless observer notes missing a standard section', async () => {
  const session = coffeeSession();
  const draft = '### 主持人｜林岑\n\n對談文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。\n\n## 意外連結\n\n- 有整理。\n\n## 值得繼續想的問題\n\n- 有整理。\n\n## 核心分歧\n\n- 有整理。\n\n## 探索方向\n\n- 有整理。\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'incomplete-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables does not recover rootless observer notes with an empty standard section', async () => {
  const session = coffeeSession();
  const draft = '### 主持人｜林岑\n\n對談文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。\n\n## 意外連結\n\n- 有整理。\n\n## 值得繼續想的問題\n\n- 有整理。\n\n## 核心分歧\n\n- 有整理。\n\n## 探索方向\n\n- 有整理。\n\n## 值得查證的假設\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'empty-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables recognizes complete English observer sections without the root heading', async () => {
  const session = coffeeSession(); session.language = 'en';
  const draft = '### Host | Lin Cen\n\nConversation text.\n\n### Observer | Observer\n\nBrief observation.\n\n## Unexpected connections\n\n- A useful unexpected connection is visible in the conversation.\n\n## Questions worth pursuing\n\n- A question remains open for further discussion.\n\n## Core disagreements\n\n- The unresolved disagreement should be retained.\n\n## Directions to explore\n\n- Several directions remain available for exploration.\n\n## Assumptions to verify\n\n- This assumption needs checking before it is treated as fact.\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'english-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.observerNotes[0], /^# Observer’s notes/);
});
integrationTest('Coffee Tables trusts a complete observer summary from the resolved stream when the runtime final text disagrees', async () => {
  const session = coffeeSession(), streamed = '### 主持人｜林岑\n\n省下時間要先確認有沒有轉成別人的工作。\n\n# 觀察者整理\n\n- **最新轉折**\n  - 討論從節省時間轉向工作是否轉移。\n- **修正後的假設**\n  - 個人省時不代表案件總時間下降。\n- **值得繼續追問的問題**\n  - 如何記錄交接成本？\n- **尚未解決的核心分歧**\n  - 緩衝和產能怎麼分配？';
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async request => { calls++; request.onText?.(streamed); return 'Runtime final text omitted the completed summary.'; }, async () => {});
  await engine.start(); assert.equal(calls, 1); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /省下時間要先確認/); assert.match(engine.session.observerNotes[0], /交接成本/); assert.equal(engine.session.draftMarkdown, undefined);
});
integrationTest('Coffee Tables accepts the concise prose observer summary returned during Obsidian acceptance', async () => {
  const session = coffeeSession();
  const transcript = '### 周沐｜主持人（好奇追問）\n\n今天的題目是省下的時間應該去哪裡？';
  const notes = '# 觀察者整理\n\n目前桌上有一個暫時共識：省下的時間不應自動等同於多接案件，應該考慮減少尖峰壓力、培訓、交接緩衝和實際休息。但這些選項怎麼分配，仍取決於績效制度與輪班安排是否一起調整。\n\n還需要查證幾件事：AI 真正節省的是哪些工作時間；人工檢查和修正增加多少成本；不同班別、資歷和案件類型是否受到不同影響；以及員工選擇休息或培訓後，績效評估是否真的不會吃虧。';
  const engine = new coffee.CoffeeEngine(session, async () => `${transcript}\n\n${notes}`, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'completed', engine.error);
  assert.equal(engine.session.transcriptMarkdown, transcript);
  assert.match(engine.session.observerNotes[0], /省下的時間不應自動等同於多接案件/);
  assert.match(engine.session.observerNotes[0], /還需要查證幾件事/);
});
integrationTest('Coffee Tables keeps a prose observer summary as a draft when its final paragraph is truncated', async () => {
  const session = coffeeSession();
  const response = '### 周沐｜主持人\n\n我們需要一起看工作量。\n\n# 觀察者整理\n\n目前桌上有一個暫時共識：要同時觀察緩衝時間、交接和工作負擔。\n\n還需要查證幾件事：不同班別是否受影響，以及客服選擇休息後的績效「保護條款」';
  const engine = new coffee.CoffeeEngine(session, async request => { request.onText?.(response); return response; }, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'error');
  assert.equal(engine.session.transcriptMarkdown, '');
  assert.match(engine.session.draftMarkdown, /績效「保護條款」$/);
  assert.match(engine.error, /整理格式不完整/);
});
integrationTest('Coffee Tables does not recover an interrupted draft with empty observer groups', async () => {
  const session = coffeeSession(); const partial = '### 主持人｜林岑\n\n先把問題拆小。\n\n# 觀察者整理\n\n- **最新轉折**\n  - 焦點改變了。\n- **修正後的假設**\n  - 假設需要重看。\n- **值得繼續追問的問題**\n  - 這段尚未完成。\n- **尚未解決的核心分歧**\n  - 尚';
  session.status = 'error'; session.draftMarkdown = partial; session.rounds = [{ id: 'partial-round', markdown: '', notes: '', draftMarkdown: partial, status: 'error', createdAt: session.createdAt }];
  const pending = deferred(); let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return pending.promise; }, async () => {});
  const running = engine.start(); await until(() => calls === 1); assert.equal(engine.session.status, 'generating');
  engine.cancel(); pending.resolve(''); await running; assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /尚未完成/);
});
integrationTest('Coffee Tables preserves turn positions when recovering a draft that contains interventions', async () => {
  const session = coffeeSession(); const speech = '### 主持人｜林岑\n\n先談怎麼分工。'; const notes = '# 觀察者整理\n\n- **最新轉折**\n  - 討論開始從工具轉向工作如何重新分配。\n- **修正後的假設**\n  - 省下時間不代表第一線工作量自然下降。\n- **值得繼續追問的問題**\n  - 誰來記錄並處理自動化的例外？\n- **尚未解決的核心分歧**\n  - 效率提升應該回到公司還是員工？';
  const draft = `${speech}\n\n${speech}\n\n${notes}\n\n<!-- coffee-tables-complete -->`; session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'draft-with-intervention', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }]; session.interventions = [{ id: 'comment-1', kind: 'comment', text: '先談第一線的工作量。', createdAt: new Date().toISOString(), status: 'sent', roundId: 'draft-with-intervention', afterTurn: 2 }];
  const engine = new coffee.CoffeeEngine(session, async () => { throw new Error('must not call provider'); }, async () => {}); await engine.start();
  assert.equal(engine.session.interventions[0].afterTurn, 2); assert.equal((engine.session.transcriptMarkdown.match(/先談怎麼分工/g) ?? []).length, 2); assert.equal(engine.session.status, 'completed');
});
integrationTest('Coffee Tables failure preserves the existing transcript and retry replaces the same follow-up', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '完整對談'; let fail = true, calls = 0;
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /完整對談/); if (fail) throw new Error('provider failed'); return '### 林岑｜主持人\n\n由主持人接話。\n\n# 觀察者整理\n\n## 最大討論轉折\n- 更新\n## 被推翻或修正的假設\n- 更新\n## 值得繼續追問的問題\n- 更新\n## 尚未解決的核心分歧\n- 更新'; }, async () => {});
  await engine.ask('為什麼免費和加價不能混在一起？', 'q1');
  assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].status, 'error'); assert.equal(engine.session.transcriptMarkdown, '完整對談');
  fail = false; await engine.ask('為什麼免費和加價不能混在一起？', 'q1');
  assert.equal(calls, 2); assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].status, 'complete'); assert.equal(engine.session.questions[0].answer, '### 林岑｜主持人\n\n由主持人接話。');
});
integrationTest('Coffee Tables follow-up retry drops an interrupted observer-notes tail from the answer', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '原本對談'; session.questions = [{ id: 'q-tail', question: '追問問題', answer: '', draftAnswer: '### 林岑｜主持人\n\n已收到的回答。\n\n# 觀察者整理\n\n## 核心分歧\n- 尚未整理完成', status: 'error', createdAt: session.createdAt }];
  const notes = '# 觀察者整理\n\n## 最大討論轉折\n- 回到工作分配\n\n## 被推翻或修正的假設\n- 效率不等於公平\n\n## 值得繼續追問的問題\n- 誰承擔例外？\n\n## 尚未解決的核心分歧\n- 由誰決定';
  const engine = new coffee.CoffeeEngine(session, async () => `### 受影響者｜客服代表\n\n我補充例外工作。\n\n${notes}`, async () => {});
  await engine.ask('追問問題', 'q-tail');
  const answer = engine.session.questions[0].answer;
  assert.match(answer, /已收到的回答/); assert.match(answer, /我補充例外工作/);
  assert.doesNotMatch(answer, /# 觀察者整理|尚未整理完成/);
  assert.equal((answer.match(/已收到的回答/g) ?? []).length, 1);
});
integrationTest('Coffee Tables locks follow-up submission while the question is being saved', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = 'Full table'; const saved = deferred(); let saving = false;
  const engine = new coffee.CoffeeEngine(session, async () => 'One answer', async value => { if (value.questions.length && !saving) { saving = true; await saved.promise; } });
  const first = engine.ask('First question'); await until(() => saving); await engine.ask('Second question'); saved.resolve(); await first;
  assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].question, 'First question');
});
integrationTest('Coffee Tables cancellation discards late text and closing waits for the pending request', async () => {
  const late = deferred(); let saved = [];
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.onText?.('已收到的草稿'); return late.promise; }, async value => saved.push(plain(value)));
  const running = engine.generate(); await until(() => engine.busy && engine.session.draftMarkdown); engine.cancel(); late.resolve('這是取消後的晚到回答'); await running;
  assert.equal(engine.session.transcriptMarkdown, ''); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.draftMarkdown, '已收到的草稿'); assert.equal(saved.at(-1).draftMarkdown, '已收到的草稿');
  const second = new coffee.CoffeeEngine(coffeeSession(), async () => late.promise, async () => {}); const task = second.generate(); await until(() => second.busy); const closing = second.stop(); await closing; await task;
  assert.equal(second.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables retry folds its saved partial conversation into the completed segment', async () => {
  const session = coffeeSession(); let calls = 0; const partial = '### 林岑｜主持人\n先談怎麼分工。';
  session.status = 'error'; session.draftMarkdown = partial; session.rounds = [{ id: 'failed-round', markdown: '', notes: '', draftMarkdown: partial, status: 'error', createdAt: session.createdAt }]; session.interventions = [{ id: 'retry-comment', kind: 'comment', text: '先把第一線的工作量算進去。', createdAt: session.createdAt, status: 'sent', roundId: 'failed-round', afterTurn: 1 }];
  const notes = '# 觀察者整理\n\n## 最大討論轉折\n- 從工具轉向分工\n\n## 被推翻或修正的假設\n- 自動化不會自行減少責任\n\n## 值得繼續追問的問題\n- 誰負責覆核？\n\n## 尚未解決的核心分歧\n- 效率與控制';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; if (calls === 1) { request.onText?.(partial); throw new Error('network interrupted'); } assert.match(request.prompt, /先談怎麼分工/); request.onText?.(`${partial}\n\n### 家長｜受影響者\n我想先知道誰負責。`); return `### 家長｜受影響者\n我想先知道誰負責。\n\n${notes}`; }, async () => {});
  await engine.start(); assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /先談怎麼分工/);
  await engine.start(); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /先談怎麼分工/); assert.match(engine.session.transcriptMarkdown, /誰負責/); assert.equal(engine.session.draftMarkdown, undefined); assert.equal(engine.session.rounds.filter(round => round.draftMarkdown).length, 0); assert.equal(engine.session.interventions[0].roundId, engine.session.rounds[0].id); assert.equal(engine.session.interventions[0].afterTurn, 1); assert.ok(Date.parse(engine.session.lastCompletedAt) >= Date.parse(session.createdAt));
});
integrationTest('Coffee Tables can refresh observer notes from a stopped draft without generating dialogue', async () => {
  const session = coffeeSession(); session.status = 'error'; session.transcriptMarkdown = '### 林岑｜主持人\n\n先前已完成的對談。'; session.draftMarkdown = '### 家長｜受影響者\n\n收到一半的觀點。';
  const previous = '# 觀察者整理\n\n## 最大討論轉折\n- 舊整理'; session.observerNotes = [previous]; let calls = 0, saved;
  const fresh = '# 觀察者整理\n\n## 最大討論轉折\n- 草稿帶來的新轉折\n\n## 被推翻或修正的假設\n- 舊假設需要修正\n\n## 值得繼續追問的問題\n- 誰承擔後續責任？\n\n## 尚未解決的核心分歧\n- 效率與公平';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /只更新觀察者整理|only produce observer notes/i); assert.match(request.prompt, /收到一半的觀點/); request.onText?.(fresh); return fresh; }, async value => { saved = plain(value); });
  await engine.refreshObserverNotes();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /收到一半的觀點/); assert.match(engine.session.observerNotes[0], /草稿帶來的新轉折/); assert.equal(saved.status, 'error');
});
integrationTest('Coffee Tables retains a previous observer-summary draft if a summary retry fails', async () => {
  const session = coffeeSession(); session.status = 'error'; session.draftMarkdown = '### 來賓｜專家\n\n已保存對談。'; session.observerDraftMarkdown = '# 觀察者整理\n\n## 核心分歧\n- 先前整理草稿';
  const previous = '# 觀察者整理\n\n## 核心分歧\n- 正式舊版'; session.observerNotes = [previous];
  const engine = new coffee.CoffeeEngine(session, async request => { request.onText?.('未完成的新整理'); throw new Error('network interrupted'); }, async () => {});
  await engine.refreshObserverNotes();
  assert.equal(engine.session.observerNotes[0], previous);
  assert.match(engine.session.observerDraftMarkdown, /先前整理草稿/);
  assert.match(engine.session.observerDraftMarkdown, /未完成的新整理/);
  assert.equal(engine.session.dirtyNotes, true);
});
integrationTest('Coffee Tables routes in-room comments, guest questions and direction changes into the active request', async () => {
  const pending = deferred(), steers = [], saves = [];
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.registerIntervention?.(async text => { steers.push(text); }); return pending.promise; }, async value => saves.push(plain(value)));
  const task = engine.start(); const early = engine.intervene('comment', 'A parent in the room has a different concern.'); await until(() => engine.busy && engine.steer); await early;
  await engine.intervene('guest-question', 'What would this cost?', '林岑');
  await engine.intervene('redirect', 'Compare equal access with family choice.');
  assert.equal(steers.length, 3); assert.match(steers[0], /A parent/); assert.match(steers[1], /林岑/); assert.match(steers[2], /new direction|redirect/i);
  assert.equal(engine.session.interventions?.length, 3); assert.ok(engine.session.interventions.every(item => item.status === 'sent')); assert.equal(saves.at(-1).interventions.length, 3);
  pending.resolve('The full discussion.'); await task;
});
integrationTest('Coffee Tables shutdown drains an accepted intervention before returning', async () => {
  const response = deferred(), steering = deferred(); let startedSteer = false;
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.signal.addEventListener('abort', () => response.resolve('')); request.registerIntervention?.(async () => { startedSteer = true; await steering.promise; }); return response.promise; }, async () => {});
  const task = engine.start(); await until(() => engine.busy && engine.steer);
  const intervention = engine.intervene('comment', 'One last point.'); await until(() => startedSteer);
  let returned = false; const stopping = engine.stop().then(() => { returned = true; }); await task; await Promise.resolve(); assert.equal(returned, false);
  steering.resolve(); await intervention; await stopping; assert.equal(returned, true);
});
integrationTest('Coffee Tables preview inspection is read-only and refuses an incomplete save journal', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f => f instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 主持人｜林岑\n已保存。'; session.rounds = [{ id: 'round-ro', markdown: session.transcriptMarkdown, notes: '# 觀察者整理\n\n## 分歧\n- 保留', status: 'completed', createdAt: session.createdAt }]; await store.save(session);
  const path = store.sessionPath(session.id), before = contents.get(path), sidePath = store.sidecarPath(session.id), sideRaw = contents.get(sidePath); let writes = 0; const write = app.vault.adapter.write, processFile = app.vault.adapter.process; app.vault.adapter.write = async (...args) => { writes++; return write(...args); }; app.vault.adapter.process = async (...args) => { writes++; return processFile(...args); };
  const read = await store.inspectReadOnly(path); assert.equal(read.id, session.id); assert.equal(writes, 0); assert.equal(contents.get(path), before);
  const side = JSON.parse(sideRaw); side.journal = { previousMarkdownHash: 'x', nextMarkdownHash: 'y', previousSidecar: sideRaw }; contents.set(sidePath, JSON.stringify(side)); const journal = contents.get(sidePath); await assert.rejects(store.inspectReadOnly(path), /unfinished save/); assert.equal(writes, 0); assert.equal(contents.get(sidePath), journal);
});

integrationTest('Coffee Tables persists follow-up guest invitations and keeps one cumulative insight document', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed';
  const invited = [{ id: 'invite-anna', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' }];
  session.questions = [{ id: 'question-guest', question: '夜班遇到突發狀況如何求援？', answer: '先確認交接流程。', status: 'complete', createdAt: session.createdAt, invitedGuests: invited }];
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 是否把求援責任留給第一線。', '# 觀察者整理\n\n## 意外連結\n- 夜班支援也像備援網絡。'];
  await store.save(session); const path = store.sessionPath(session.id), raw = contents.get(path);
  assert.match(raw, /林照｜受影響者/); assert.doesNotMatch(raw, /### 先前版本|### 最新版本/); assert.match(raw, /夜班支援也像備援網絡/); assert.match(raw, /是否把求援責任留給第一線/);
  const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id);
  assert.equal(JSON.stringify(restored.questions[0].invitedGuests), JSON.stringify(invited)); assert.equal(restored.observerNotes.length, 1);
});
integrationTest('Coffee Tables backs up the exact old versioned Markdown before its first cumulative rewrite', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed';
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 最新見解。', '# 觀察者整理\n\n## 意外連結\n- 早期跨域線索。']; await store.save(session);
  const path = store.sessionPath(session.id), first = contents.get(path), old = first.replace(/## 觀察者整理[\s\S]*$/, '## 觀察者整理\n\n### 最新版本\n\n# 觀察者整理\n\n## 核心分歧\n- 最新見解。\n\n### 先前版本\n\n#### 第 1 版\n\n# 觀察者整理\n\n## 意外連結\n- 早期跨域線索。'); contents.set(path, old);
  const reopenedStore = new CoffeeStorage(app.vault, 'Agent Workspace'), loaded = await reopenedStore.load(session.id); await reopenedStore.save(loaded);
  const backups = [...contents.keys()].filter(name => name.includes('/.sessions/backups/') && name.endsWith('.md'));
  assert.equal(backups.length, 1); assert.equal(contents.get(backups[0]), old); assert.match(contents.get(path), /早期跨域線索/); assert.doesNotMatch(contents.get(path), /### 先前版本/);
});
integrationTest('Coffee Tables Markdown storage round trips punctuation, Traditional Chinese, Q&A and protects outside edits', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f => f instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession();
  session.status = 'completed'; session.lastGenerationStartedAt = '2026-09-29T20:00:00.000Z'; session.lastCompletedAt = '2026-09-29T20:05:00.000Z'; session.transcriptMarkdown = '### 林岑｜主持人\n先問現場怎麼運作。\n\n### 家長｜受影響者\n孩子會注意到標籤。'; session.rounds = [{ id: 'round-main', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  session.draftMarkdown = '### 主持人｜追問\n第一段尚未完成';
  session.observerDraftMarkdown = '# 觀察者整理\n\n## 核心分歧\n- 整理草稿也需要保存';
  session.observerNotes = ['# 觀察者整理\n\n## 最大討論轉折\n- 新版轉折\n\n## 尚未解決的核心分歧\n- 新版分歧', '# 觀察者整理\n\n## 最大討論轉折\n- 舊版轉折\n\n## 尚未解決的核心分歧\n- 舊版分歧'];
  session.questions = [{ id: 'q-1', question: '會不會造成分級？', answer: '要看加價如何呈現。', draftAnswer: '### 觀眾｜家長\n我還在回答…', status: 'complete', createdAt: new Date(Date.parse(session.createdAt) + 2000).toISOString() }];
  session.interventions = [{ id: 'comment-1', kind: 'comment', text: '家長也需要看得到退出方式。', createdAt: new Date(Date.parse(session.createdAt) + 1000).toISOString(), status: 'sent', roundId: 'round-main', afterTurn: 1 }];
  await store.save(session); const filePath = store.sessionPath(session.id), original = contents.get(filePath);
  assert.match(original, /先問現場怎麼運作[\s\S]*你（插話）[\s\S]*家長也需要看得到退出方式[\s\S]*孩子會注意到標籤/); assert.match(original, /會不會造成分級/); assert.match(original, /Reasoning|推理強度/); assert.match(original, /## 對話紀錄/); assert.equal(original.split("\n")[0], `# ${session.topic}`); assert.doesNotMatch(original, /coffee-tables-data|coffee-tables-transcript-end|<\!--.*version/i); assert.ok(files.has(`${store.hidden}/${session.id}.json`)); assert.doesNotMatch(original, new RegExp(session.id));
  assert.ok(original.length < (session.transcriptMarkdown.length + session.draftMarkdown.length + session.questions[0].draftAnswer.length) * 2 + 2200, 'session metadata should not duplicate or expand the transcript');
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'), restored = await reopened.load(session.id); assert.equal(restored.topic, session.topic); assert.match(restored.transcriptMarkdown,/先問現場怎麼運作/); assert.equal(restored.questions[0].question,session.questions[0].question); assert.equal(restored.questions[0].draftAnswer,session.questions[0].draftAnswer); assert.match(restored.interventions[0].text,/退出方式/); assert.match(restored.draftMarkdown,/第一段尚未完成/); assert.match(restored.observerDraftMarkdown,/整理草稿也需要保存/); assert.match(restored.observerNotes[0], /新版分歧/); assert.match(restored.observerNotes[0], /舊版分歧/); assert.equal(restored.observerNotes.length, 1); assert.equal(restored.model,session.model); assert.equal(restored.lastGenerationStartedAt, session.lastGenerationStartedAt); assert.equal(restored.lastCompletedAt, session.lastCompletedAt);
  const outside = original.replace('先問現場怎麼運作。', '編輯者補上現場資訊。'); contents.set(filePath, outside); const inspected = await store.inspect(filePath); assert.equal(inspected.dirtyNotes, true); await assert.rejects(store.save(session), /changed outside/); assert.equal(contents.get(filePath), outside);
  const adopted = await store.reload(filePath); assert.match(adopted.transcriptMarkdown, /編輯者補上現場資訊/); assert.match(adopted.interventions[0].text, /退出方式/); assert.equal(adopted.dirtyNotes, true);
});
integrationTest('Coffee Tables Markdown round trips style snapshots and reference text without parsing embedded headings as dialogue', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed'; session.guests.styleId = 'style-1'; session.guests.styleName = '輕鬆聊天'; session.guests.stylePrompt = '主持人多追問。'; session.guests.referenceFiles = [{ name: '背景.md', content: '# 內文標題\n```md\n### 假來賓｜主持人\n<!-- coffee-tables-complete -->\n```' }]; session.transcriptMarkdown = '### 林岑｜主持人\n真正的發言。'; session.rounds = [{ id: 'style-round', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  await store.save(session); const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id); assert.equal(restored.guests.styleId, 'style-1'); assert.equal(restored.guests.styleName, '輕鬆聊天'); assert.equal(restored.guests.stylePrompt, '主持人多追問。'); assert.equal(JSON.stringify(restored.guests.referenceFiles), JSON.stringify(session.guests.referenceFiles)); assert.equal(restored.rounds[0].markdown, session.transcriptMarkdown);
});
integrationTest('Coffee Tables Markdown omits empty failed rounds while retaining the saved draft', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'error'; session.rounds = [{ id: 'empty-1', markdown: '', notes: '', status: 'error', createdAt: session.createdAt }, { id: 'empty-2', markdown: '', notes: '', status: 'error', createdAt: session.createdAt }, { id: 'draft-3', markdown: '', notes: '', draftMarkdown: '### 主持人｜林岑\n草稿保留。', status: 'error', createdAt: session.createdAt }]; session.draftMarkdown = session.rounds[2].draftMarkdown;
  await store.save(session); const markdown = contents.get(store.sessionPath(session.id)); assert.doesNotMatch(markdown, /^## (?:Conversation part \d+|對談第 \d+ 段)$/m); assert.match(markdown, /Unfinished drafts|未完成草稿/); assert.match(markdown, /草稿保留/);
  const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id); assert.deepEqual(Array.from(restored.rounds, item => item.id), ["empty-1","empty-2","draft-3"]); assert.match(restored.draftMarkdown, /草稿保留/);
});
integrationTest('Coffee Tables titles produce safe Markdown names without replacing a same-title table', async () => {
  const { CoffeeStorage, topicSlug } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  assert.equal(topicSlug('  AI / 工作？  '), 'AI 工作？');
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), first = coffeeSession(); first.topic = 'AI / 工作？'; await store.save(first);
  const second = coffeeSession(); second.topic = first.topic; await store.save(second);
  assert.match(store.sessionPath(first.id), /AI 工作？\.md$/); assert.match(store.sessionPath(second.id), /AI 工作？（2）\.md$/);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'); assert.equal((await reopened.load(store.sessionPath(first.id))).topic, first.topic);
  files.delete(store.sessionPath(first.id)); contents.delete(store.sessionPath(first.id)); assert.equal((await reopened.load(store.sessionPath(second.id))).id, second.id); assert.equal((await reopened.reload(store.sessionPath(second.id))).id, second.id);
});
integrationTest('Coffee Tables recovers a new table when interruption occurs between Markdown and sidecar writes', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.transcriptMarkdown = '### 主持人｜林岑\n這是第一段完整對談。'; session.rounds = [{ id: 'round-a', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  const process = app.vault.adapter.process; let writes = 0; app.vault.adapter.process = async (...args) => { if (++writes === 1) throw new Error('simulated interruption'); return process(...args); };
  await assert.rejects(store.save(session), /simulated interruption/);
  const markdownPath = store.path(session.id, session.topic), sidecarPath = store.sidecarPath(session.id); assert.ok(contents.has(markdownPath)); assert.match(contents.get(sidecarPath), /targetMarkdown/);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'); await reopened.recoverPendingCreates();
  assert.doesNotMatch(contents.get(sidecarPath), /targetMarkdown/); const loaded = await reopened.load(markdownPath); assert.match(loaded.transcriptMarkdown, /第一段完整對談/);
});

integrationTest('Coffee Tables stores same-topic sessions in native topic folders and moves legacy notes with their sidecar mapping', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target));
  const first = coffeeSession(); first.status = 'completed'; first.transcriptMarkdown = '### 林岑｜主持人\n\n完整內容'; first.rounds = [{ id: 'r1', markdown: first.transcriptMarkdown, notes: '', status: 'completed', createdAt: first.createdAt }];
  await store.save(first); const firstPath = store.sessionPath(first.id); assert.match(firstPath, /Coffee Tables\/.+（[a-f0-9]{8}）\/.+\.md$/);
  const second = { ...coffeeSession(), id: 'coffee-second' }; await store.save(second); assert.equal(store.sessionPath(first.id).split('/').at(-2), store.sessionPath(second.id).split('/').at(-2));
  const original = app.vault.getAbstractFileByPath(firstPath), legacyPath = `${store.folder}/legacy.md`; await app.fileManager.renameFile(original, legacyPath);
  const sidePath = store.sidecarPath(first.id), side = JSON.parse(contents.get(sidePath)); side.filePath = legacyPath; contents.set(sidePath, JSON.stringify(side, null, 2));
  const upgrader = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const moved = await upgrader.organizeExisting(); assert.equal(moved.moved, 1);
  assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(first.id)).id, first.id);
});
integrationTest('Coffee Tables resolves a moved note with frontmatter and preserves an explicitly edited root title', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const initial = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const session = coffeeSession(); await initial.save(session);
  const originalPath = initial.sessionPath(session.id), originalFile = app.vault.getAbstractFileByPath(originalPath); contents.set(originalPath, `---\ntags: [coffee]\n---\n\n${contents.get(originalPath)}`);
  const movedPath = `${initial.folder}/renamed-note.md`; await app.fileManager.renameFile(originalFile, movedPath);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const restored = await reopened.load(session.id); assert.equal(restored.topic, session.topic);
  const edited = contents.get(movedPath).replace(`# ${session.topic}`, '# A title explicitly changed in Obsidian'); contents.set(movedPath, edited);
  const adopted = await reopened.reload(movedPath); assert.equal(adopted.topic, 'A title explicitly changed in Obsidian');
});
integrationTest('Coffee Tables startup move recovery does not clear a live FileManager move journal', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const initial = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const session = coffeeSession(); await initial.save(session); const current = initial.sessionPath(session.id), legacyPath = `${initial.folder}/moving-note.md`; await app.fileManager.renameFile(app.vault.getAbstractFileByPath(current), legacyPath); const sidePath = initial.sidecarPath(session.id), side = JSON.parse(contents.get(sidePath)); side.filePath = legacyPath; contents.set(sidePath, JSON.stringify(side, null, 2));
  const gate = deferred(), renameStarted = deferred(), store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => { renameStarted.resolve({ file, target }); return gate.promise.then(() => app.fileManager.renameFile(file, target)); }); const moving = store.organizeExisting(); const { target } = await renameStarted.promise; const staged = JSON.parse(contents.get(sidePath)); assert.ok(staged.moveJournal); await store.recoverMoves(); assert.ok(JSON.parse(contents.get(sidePath)).moveJournal); gate.resolve(); const result = await moving; assert.equal(result.moved, 1); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(target)).id, session.id);
});
integrationTest('Coffee Tables deletion waits for a safe archive and restores Markdown and hidden session state without overwrite', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  app.vault.delete = async file => { files.delete(file.path); contents.delete(file.path); }; app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); }; const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => app.vault.delete(file));
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 林岑｜主持人\n\n保留對談'; session.rounds = [{ id: 'r1', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }]; await store.save(session);
  const originalPath = store.sessionPath(session.id), trashRecord = await store.delete(session.id); assert.equal(app.vault.getAbstractFileByPath(originalPath), undefined); assert.equal((await store.deletedTables()).length, 1); await assert.rejects(store.save(session), /was deleted/);
  const restoredPath = await store.restoreDeleted(trashRecord); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(restoredPath)).id, session.id); assert.match(await app.vault.read(app.vault.getAbstractFileByPath(restoredPath)), /保留對談/); const restoredSession = await store.load(restoredPath); restoredSession.updatedAt = new Date().toISOString(); await store.save(restoredSession);
  const other = { ...coffeeSession(), topic: 'Collision test topic' }; await store.save(other); const record = await store.delete(other.id); const parsed = JSON.parse(contents.get(record)); await app.vault.create(parsed.originalPath, '# occupied'); const collisionPath = await store.restoreDeleted(record); assert.notEqual(collisionPath, parsed.originalPath); assert.match(collisionPath, /（2）\.md$/);
  const retainedSidecar = { ...coffeeSession(), id: 'coffee-delete-retained', topic: 'Retained sidecar topic' }; await store.save(retainedSidecar); const retainedPath = store.sessionPath(retainedSidecar.id); const remove = app.vault.adapter.remove; app.vault.adapter.remove = async path => { if (path === store.sidecarPath(retainedSidecar.id)) throw new Error('simulated sidecar cleanup failure'); return remove(path); }; const retainedRecord = await store.delete(retainedSidecar.id); assert.equal((await store.deletedTables()).some(item => item.path === retainedRecord), true); await app.vault.create(retainedPath, '# collision'); const retainedRestored = await store.restoreDeleted(retainedRecord); const reopenedRetained = await new CoffeeStorage(app.vault, 'Agent Workspace').load(retainedRestored); assert.equal(reopenedRetained.id, retainedSidecar.id); assert.equal(JSON.parse(contents.get(store.sidecarPath(retainedSidecar.id))).filePath, retainedRestored);
  const interrupted = { ...coffeeSession(), id: 'coffee-delete-interrupted', topic: 'Interrupted trash metadata' }; await store.save(interrupted); const process = app.vault.adapter.process; let failedOnce = false; app.vault.adapter.process = async (path, fn) => { if (!failedOnce && path.includes('/.sessions/trash/')) { failedOnce = true; throw new Error('simulated archive status interruption'); } return process(path, fn); }; const interruptedRecord = await store.delete(interrupted.id); app.vault.adapter.process = process; assert.equal(JSON.parse(contents.get(interruptedRecord)).trashed, false); assert.equal((await store.deletedTables()).some(item => item.path === interruptedRecord), true); const interruptedPath = await store.restoreDeleted(interruptedRecord); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(interruptedPath)).id, interrupted.id);
  const partial = { ...coffeeSession(), id: 'coffee-restore-interrupted', topic: 'Interrupted restore' }; await store.save(partial); const partialRecord = await store.delete(partial.id); const processRestore = app.vault.adapter.process; let restoreFailed = false; app.vault.adapter.process = async (path, fn) => { if (!restoreFailed && path === store.sidecarPath(partial.id)) { restoreFailed = true; throw new Error('simulated sidecar restore interruption'); } return processRestore(path, fn); }; await assert.rejects(store.restoreDeleted(partialRecord), /simulated sidecar restore interruption/); app.vault.adapter.process = processRestore; const journal = JSON.parse(contents.get(partialRecord)).restoreJournal; assert.ok(journal.targetPath); const partialRestored = await store.restoreDeleted(partialRecord); assert.equal(partialRestored, journal.targetPath); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(partialRestored)).id, partial.id);
});
integrationTest('Coffee Tables delete archives the latest hidden state if it changes during the trash callback', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile); app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); };
  const session = coffeeSession(); session.status = 'completed'; const sidePath = `Agent Workspace/Coffee Tables/.sessions/${session.id}.json`; const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => { const side = JSON.parse(contents.get(sidePath)); side.updatedAt = '2026-09-30T12:00:00.000Z'; contents.set(sidePath, JSON.stringify(side, null, 2)); files.delete(file.path); contents.delete(file.path); }); await store.save(session);
  const recordPath = await store.delete(session.id), record = JSON.parse(contents.get(recordPath)); assert.equal(JSON.parse(record.sidecar).updatedAt, '2026-09-30T12:00:00.000Z'); assert.equal((await store.deletedTables()).length, 1);
});
integrationTest('Coffee Tables v2 migration backs up the source, writes clean Markdown and is idempotent', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const id = 'coffee-v2-recoverable', topic = '舊版桌聊主題', path = `Agent Workspace/Coffee Tables/${id}.md`, createdAt = '2026-09-29T00:00:00.000Z';
  await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Coffee Tables');
  const legacy = { version: 2, id, topic, language: 'zh-TW', model: 'test-model', reasoning: 'low', createdAt, updatedAt: createdAt, status: 'completed', transcriptMarkdown: '', questions: [], guests: { perspectives: ['experts'], background: '客服' } };
  const source = `# ${topic}\n\n<!-- coffee-tables-data:${encodeURIComponent(JSON.stringify(legacy))} -->\n\n## 對談\n\n### 主持人｜林岑\n\n保留這段原始對談。\n\n<!-- coffee-tables-transcript-end:${id} -->\n\n<!-- coffee-tables-draft-start:${id} -->\n\n### 主持人｜續聊\n\n保留這段舊草稿。\n\n<!-- coffee-tables-draft-end:${id} -->`;
  const oldFile = await app.vault.create(path, source); const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, next) => app.fileManager.renameFile(file, next)); const migrated = await store.load(path);
  assert.equal(migrated.version, 3); assert.match(migrated.transcriptMarkdown, /保留這段原始對談/); assert.match(migrated.draftMarkdown, /保留這段舊草稿/); assert.equal(migrated.guests.counts.experts, 4);
  const backup = contents.get(`${store.hidden}/backups/${id}-v2.md`); assert.equal(backup, source); assert.doesNotMatch(contents.get(store.sessionPath(id)), /coffee-tables-data/);
  const again = await new CoffeeStorage(app.vault, 'Agent Workspace').load(store.sessionPath(id)); assert.equal(again.id, id); assert.equal(oldFile.path, store.sessionPath(id)); assert.notEqual(oldFile.path, path); assert.equal([...files.keys()].filter(item => item.endsWith(`${id}-v2.md`)).length, 1);
});
test('Coffee Tables speaker parser creates stable roster and speech identities and ignores note headings', () => {
  const { parseGuests, parseSpeeches } = load('experiences/coffee-tables/view.ts', { obsidian });
  const markdown = '- **主持人 甲｜林岑**：抓矛盾\n- **Xiao Yun｜Customer-support lead**: Frontline work\n\n### 林岑｜主持人\n你說要自動化，責任歸誰？\n\n### Xiao Yun｜Customer-support lead\n工作量沒有減少。\n\n# 觀察者整理\n## 主要轉折\n### 假設一\n不是來賓';
  assert.deepEqual(plain(parseGuests(markdown)), [{ name: '林岑', role: '主持人 甲', bio: '抓矛盾' }, { name: 'Xiao Yun', role: 'Customer-support lead', bio: 'Frontline work' }]);
  assert.deepEqual(plain(parseSpeeches(markdown)), [{ name: '林岑', role: '主持人', text: '你說要自動化，責任歸誰？' }, { name: 'Xiao Yun', role: 'Customer-support lead', text: '工作量沒有減少。' }]);
});
integrationTest('Coffee Tables engine survives view closure and reopening without starting a duplicate request', async () => {
  const pending = deferred(); let calls = 0, saved = [];
  const manager = new coffee.CoffeeManager(async request => { calls++; request.onText?.('Live draft'); return pending.promise; }, async value => { saved.push(plain(value)); });
  const session = coffeeSession(), firstViewEngine = manager.open(session), task = firstViewEngine.start(); await until(() => calls === 1 && firstViewEngine.session.draftMarkdown === 'Live draft');
  const reopenedViewEngine = manager.open(session); assert.equal(reopenedViewEngine, firstViewEngine); assert.equal(calls, 1);
  pending.resolve('### 主持人｜主持人\n\nComplete conversation\n\n# 觀察者整理\n\n## 最大討論轉折\n- A\n## 被推翻或修正的假設\n- B\n## 值得繼續追問的問題\n- C\n## 尚未解決的核心分歧\n- D'); await task; assert.equal(manager.open(firstViewEngine.session).session.status, 'completed'); assert.equal(calls, 1); assert.match(saved.at(-1).transcriptMarkdown, /Complete conversation/);
});
test('Coffee Tables outline parses localized headings, wrapped bullets and nested list detail without treating code as structure', () => {
  assert.ok(fs.existsSync(path.join(root, 'experiences/coffee-tables/outline.ts')), 'Coffee Tables outline logic module exists');
  const { parseCoffeeOutline } = load('experiences/coffee-tables/outline.ts');
  const notes = '# 觀察者整理\n\n## 意外連結\n- **創作價值**與勞動條件相連，\n  速度未必讓人得到更多自由。 <!-- source: AI 工具讓創作者產出更快，卻沒有得到更多自由時間。 -->\n  - 也要查看接案者的修改成本。\n\n## Questions worth pursuing\n- Can creators refuse training use?\n\n```md\n## fake section\n- fake item\n```';
  const parsedNotes = parseCoffeeOutline(notes);
  assert.equal(parsedNotes[0].items[0].sourceText, 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。');
  assert.doesNotMatch(parsedNotes[0].items[0].text, /source:/);
  const { findRelatedSpeech } = load('experiences/coffee-tables/outline.ts');
  assert.equal(findRelatedSpeech(parsedNotes[0].items[0].sourceText, [{ id: 'source-speech', text: 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。', order: 5 }]), 'source-speech');
  assert.deepEqual(plain(parsedNotes), [
    { id: 'section-0', title: '意外連結', depth: 2, items: [
      { id: 'section-0-item-0', text: '創作價值與勞動條件相連，速度未必讓人得到更多自由。', sourceText: 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。', context: '也要查看接案者的修改成本。', depth: 0 },
    ] },
    { id: 'section-1', title: 'Questions worth pursuing', depth: 2, items: [
      { id: 'section-1-item-0', text: 'Can creators refuse training use?', depth: 0 },
    ] },
  ]);
});
test('Coffee Tables outline matching finds the strongest related Chinese speech and refuses ambiguous or generic matches', () => {
  assert.ok(fs.existsSync(path.join(root, 'experiences/coffee-tables/outline.ts')), 'Coffee Tables outline logic module exists');
  const { findRelatedSpeech } = load('experiences/coffee-tables/outline.ts');
  const targets = [
    { id: 'dialogue-1', text: 'AI工具讓作品生產更快，卻沒有證據顯示創作者因此得到更多自由時間。', order: 0 },
    { id: 'dialogue-2', text: '稿酬降低可能和接案工作者需要反覆修改作品有關。', order: 1 },
    { id: 'dialogue-3', text: '要再觀察使用者是否真的理解作品。', order: 2 },
  ];
  assert.equal(findRelatedSpeech('自動化產出更快，創作者仍沒有因此得到更多自由時間。', targets), 'dialogue-1');
  assert.equal(findRelatedSpeech('加價午餐不只涉及食物，也像公共運輸的差別定價，牽涉基本服務與額外選擇的界線。', [
    { id: 'analogy', text: '公共運輸有時會讓乘客加價買更舒適的座位，這跟午餐有一點相似：都是在基本服務之外提供選擇。但限制也很明顯，交通座位比較像個人使用；孩子一起吃飯時，食物差異會直接變成同儕之間看得見的差距。', order: 0 },
    { id: 'other', text: '學校必須先保障基本營養，不能把過敏或醫療需求當成額外選擇。', order: 1 },
  ]), 'analogy');
  assert.equal(findRelatedSpeech('產出速度和創作人自由時間的關係', [
    { id: 'first', text: 'AI提高產出速度，也未增加創作者的自由時間。', order: 0 },
    { id: 'second', text: 'AI提升產出速度，也未增加創作者的休閒時間。', order: 1 },
  ]), 'first');
  assert.equal(findRelatedSpeech('先用 MIT、之後改授權聽起來簡單，但外部貢獻者的著作權會讓未來的選擇更複雜。', [
    { id: 'license-question', text: '那如果我不確定未來會不會做雲端服務，是不是先 MIT，之後有人拿去做 SaaS 再改 AGPL 就好？', order: 0 },
    { id: 'license-rights', text: '你通常可以對未來版本改授權，但已經用舊版本的人仍按舊授權使用；若程式有外部貢獻，還得確認你有權這麼做。', order: 1 },
    { id: 'license-followup', text: '以後改授權不是完全不行，但不會把舊版本的使用權收回來；開始接受外部貢獻後，還多一層權利確認。', order: 2 },
  ]), 'license-followup');
  assert.equal(findRelatedSpeech('加速產出之後創作者仍沒有更多自由時間', [
    { id: 'one', text: 'AI加快產出，但創作者沒有得到更多自由時間。', order: 0 },
    { id: 'two', text: 'AI加速產出，創作者仍沒有得到更多自由時間。', order: 1 },
  ]), null);
  assert.equal(findRelatedSpeech('意外連結', targets), null);
  assert.equal(findRelatedSpeech('作品生產速度更快', [
    { id: 'earlier', text: '作品生產速度更快。', order: 0 },
    { id: 'later', text: '作品生產速度更快。', order: 1 },
  ]), 'earlier');
  assert.equal(findRelatedSpeech('今天摘要要討論親子講座如何安排時間', [
    { id: 'short-phrase', text: '親子講座', order: 0 },
  ]), null);
});
test('Coffee Tables deletion locks every view of a shared manager engine and retires it after removal', async () => {
  let calls = 0; const manager = new coffee.CoffeeManager(async () => { calls++; return 'not expected'; }, async () => {}); const session = coffeeSession(); session.status = 'completed'; const first = manager.open(session), second = manager.open(session); assert.equal(first, second);
  const locked = await manager.prepareDelete(session.id); await Promise.all([second.continueTable(), second.ask('continue?')]); assert.equal(calls, 0); assert.equal(manager.get(session.id), first); manager.completeDelete(session.id, locked); await Promise.all([first.start(), second.continueTable(), second.ask('late?')]); assert.equal(first.deleted, true); assert.equal(manager.get(session.id), undefined); assert.equal(calls, 0); assert.throws(() => manager.open(session), /being deleted or was deleted/); manager.restore(session.id); assert.equal(manager.open(session).session.id, session.id);
  const uncached = { ...coffeeSession(), id: 'uncached-delete-id' }; await manager.prepareDelete(uncached.id); assert.throws(() => manager.open(uncached), /being deleted or was deleted/); manager.cancelDelete(uncached.id, undefined); assert.equal(manager.open(uncached).session.id, uncached.id);
});
test('Coffee Tables copies legacy sessions without rewriting the source', () => {
  const legacy = { version: 1, id: 'old-session', topic: '舊桌', language: 'zh-TW', model: 'm', reasoning: 'low', createdAt: '2026-01-01', updatedAt: '2026-01-01', status: 'completed', participants: [{ id: 'host-a', name: '小安', role: '主持人', lens: '好奇' }], messages: [{ id: 'm1', speakerId: 'host-a', text: '保留這句', replyTo: null, move: 'opening', targetId: null, createdAt: '2026-01-01' }], nextSpeakerId: 'host-a', segmentStart: 0, notes: null, endReason: 'natural' };
  const copy = coffeeTypes.copyLegacySession(legacy);
  assert.equal(copy.version, 3); assert.match(copy.transcriptMarkdown, /保留這句/); assert.notEqual(copy.id, legacy.id); assert.equal(legacy.version, 1);
});
integrationTest('Coffee Tables provider adapter uses plain text while preserving model, reasoning, logging and cancellation', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const model of ['test-codex', 'claude:sonnet']) {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: 'plugin' }; plugin.settings.aiExchangeLoggingEnabled = true;
    const events = []; plugin.exchanges = Object.fromEntries(['begin', 'sent', 'received', 'completed', 'failed'].map(key => [key, (...args) => events.push([key, ...args])]));
    const runTask = async (_prompt, actualModel, effort, schema, controls) => { assert.equal(effort, 'high'); assert.equal(schema, undefined); assert.equal(controls.searchBudget, 0); assert.equal(actualModel, model === 'claude:sonnet' ? 'sonnet' : model); controls.onRequest({ prompt: 'plain text' }); return '完整 Markdown'; };
    plugin.runtime = (_directory, local) => { assert.equal(local, true); return { runTask }; }; plugin.claudeCli = () => ({ runTask });
    const request = { session: { ...coffeeSession(), model, reasoning: 'high' }, prompt: 'coffee prompt', signal: new AbortController().signal };
    assert.equal(await plugin.runCoffeeRequest(request), '完整 Markdown'); assert.deepEqual(events.map(event => event[0]), ['begin', 'sent', 'received', 'completed']); assert.equal(plugin.activeTasks.size, 0);
    const abort = new AbortController(); abort.abort(); await assert.rejects(plugin.runCoffeeRequest({ ...request, signal: abort.signal }), /cancelled/);
  }
});
function coffeeElement(tag, options = {}) {
  return { tag, text: options.text ?? '', value: options.value ?? '', children: [], disabled: false, attrs: options.attr ?? {},
    createDiv(value) { const element = coffeeElement('div', typeof value === 'string' ? { cls: value } : value); this.children.push(element); return element; },
    createEl(name, value) { const element = coffeeElement(name, value); this.children.push(element); return element; }, createSpan(value) { const element = coffeeElement('span', value); this.children.push(element); return element; }, addClass() {}, toggleClass() {}, removeClass() {}, setText(value) { this.text = value; }, empty() { this.children = []; }, focus() {}, remove() { this.removed = true; },
    classList: { add() {}, toggle() {} }, dataset: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, get childElementCount() { return this.children.length; } };
}
const coffeeFind = (root, predicate) => predicate(root) ? root : root.children.map(child => coffeeFind(child, predicate)).find(Boolean);
integrationTest('Coffee Tables puts saved-draft recovery in the pinned room toolbar', () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'error'; session.draftMarkdown = '### 主持人｜林岑\n\n已收到的對談。'; session.rounds = [{ id: 'failed-round', markdown: '', notes: '', draftMarkdown: session.draftMarkdown, status: 'error', createdAt: session.createdAt }];
  const plugin = { settings: { language: 'zh-TW' }, modelLabel: value => value, confirmAiUsage: async (_model, run) => run() };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); view.engine = { session, busy: false, persistenceFailed: false, error: 'observer summary incomplete' }; view.store = { sessionPath: () => 'failed.md' }; view.contentEl = coffeeElement('root'); view.contentEl.ownerDocument = { activeElement: null }; view.contentEl.querySelector = () => null; view.contentEl.querySelectorAll = () => [];
  view.renderRound = () => {}; view.renderMarkdown = () => {}; view.renderRoster = () => {}; view.updateStatus = () => {};
  view.render();
  const fixed = view.contentEl.children[0].children[0];
  const header = fixed.children[0], actions = header.children[1];
  assert.equal(header.children[0].tag, 'h2');
  assert.equal(actions.tag, 'div');
  assert.deepEqual(actions.children.map(item => item.text), ['回主頁', '開啟 Markdown', '刪除桌聊', '開新桌']);
  assert.equal(header.children[2].tag, 'p');
  assert.ok(coffeeFind(fixed, item => item.tag === 'button' && item.text === '從已保存草稿繼續'));
});
integrationTest('Coffee Tables home form keeps discovered model and reasoning choices and disables start during discovery', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const plugin = { settings: { language: 'en', cliModel: 'm', cliReasoning: 'low' }, availableModels: () => ['m'], coffeeReasoningEfforts: model => model === 'm' ? ['low'] : ['medium', 'high'], refreshCoffeeModels: async () => ['m', 'codex-other'], modelLabel: value => value, confirmAiUsage: async (_model, run) => run() };
  const view = new CoffeeTablesView({ app: {} }, plugin); view.contentEl = coffeeElement('root'); view.store = { list: () => [] }; await view.home();
  const selects = []; const visit = node => { if (node.tag === 'select') selects.push(node); node.children.forEach(visit); }; visit(view.contentEl);
  await until(() => !selects[0].disabled); assert.deepEqual(selects[0].children.map(option => option.value), ['m', 'codex-other']);
  assert.deepEqual(selects[1].children.map(option => option.value), ['auto', 'low']);
  const summaries = []; const findSummaries = node => { if (node.tag === 'summary') summaries.push(node.text); node.children.forEach(findSummaries); }; findSummaries(view.contentEl); assert.ok(summaries.some(text => /Adjust this table · m · 2 hosts \+ 7 guests/.test(text)));
  selects[0].value = 'codex-other'; selects[0].change(); assert.deepEqual(selects[1].children.map(option => option.value), ['auto', 'medium', 'high']);
});
integrationTest('Coffee Tables explicit return home cannot be overridden by a delayed saved session state', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }); let loads = 0, saves = 0;
  const plugin = { ready: Promise.resolve(), settings: {}, coffeeStorage: {} };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout: () => saves++ } } }, plugin); view.store = {}; view.home = async () => { view.engine = null; }; view.loadSession = async () => { loads++; };
  view.returnHome(); await view.setState({ sessionId: 'previous-session' }, { history: false });
  assert.equal(loads, 0); assert.equal(saves, 1);
  const restored = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); restored.store = {}; restored.loadSession = async () => { loads++; };
  await restored.setState({ sessionId: 'saved-session' }, { history: false }); assert.equal(loads, 1);
});
integrationTest('Coffee Tables stale external-conflict loads cannot override a newer room selection', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }), oldLoad = { promise: null, reject: null }, newLoad = deferred(), stopPending = deferred(); oldLoad.promise = new Promise((_resolve, reject) => { oldLoad.reject = reject; }); let stopCalled = false, attached = []; const session = { ...coffeeSession(), status: 'completed' };
  const cached = { busy: true, session, stop: async () => { stopCalled = true; await stopPending.promise; }, reportPersistenceError() {} }; const plugin = { coffeeManager: { get: () => cached } };
  const view = new CoffeeTablesView({ app: {} }, plugin); view.store = { load: path => path === 'old.md' ? oldLoad.promise : newLoad.promise, inspect: async () => session }; view.attach = value => attached.push(value.topic);
  const older = view.loadSession('old.md'); oldLoad.reject(new Error('changed outside the room')); await until(() => stopCalled); const newer = view.loadSession('new.md'); stopPending.resolve(); await older; assert.deepEqual(attached, []); newLoad.resolve(session); await newer; assert.deepEqual(attached, [session.topic]);
});

integrationTest('Coffee Tables historical preview cancels a pending generating-room navigation', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  let delayedRoom = deferred(); const completed = { ...coffeeSession(), id: 'done', topic: 'History topic', status: 'completed', transcriptMarkdown: '', rounds: [], observerNotes: [] };
  const generating = { ...coffeeSession(), id: 'running', topic: 'Running topic', status: 'generating', transcriptMarkdown: '', rounds: [], observerNotes: [] };
  const plugin = { settings: { language: 'en', cliModel: 'm', cliReasoning: 'low', workspaceFolder: 'workspace' }, availableModels: () => ['m'], coffeeReasoningEfforts: () => ['low'], refreshCoffeeModels: async () => ['m'], modelLabel: value => value, confirmAiUsage: async (_model, run) => run(), coffeeManager: { get: id => id === generating.id ? { busy: true, session: generating } : undefined } };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); view.contentEl = coffeeElement('root');
  view.store = { recoverPendingCreates: async () => {}, list: () => [{ path: 'running.md', extension: 'md', basename: 'Running topic', stat: { ctime: 1, mtime: 1 } }, { path: 'done.md', extension: 'md', basename: 'History topic', stat: { ctime: 1, mtime: 1 } }], inspectReadOnly: async path => path === 'done.md' ? completed : generating, load: () => delayedRoom.promise };
  const attached = []; view.attach = session => attached.push(session.id); await view.home();
  const findButton = text => coffeeFind(view.contentEl, element => element.tag === 'button' && (element.text.includes(text) || element.children.some(child => child.text.includes(text))));
  await until(() => findButton('Running topic')); const runningButton = findButton('Running topic'); assert.ok(runningButton); runningButton.click(); await Promise.resolve();
  const historyButton = findButton('History topic'); assert.ok(historyButton); historyButton.click(); await until(() => findButton('Enter this table'));
  delayedRoom.resolve(generating); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(attached, []);
  delayedRoom = deferred(); findButton('Enter this table').click(); await Promise.resolve(); findButton('Open new table').click(); delayedRoom.resolve(completed); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(attached, []);
});

integrationTest('Coffee Tables VAM handoff links the transcript and starts from an editable research question', async () => {
  let modal, opened; class Modal { constructor() { modal = this; this.titleEl = coffeeElement('title'); this.contentEl = coffeeElement('content'); } open() {} close() {} }
  const { default: Plugin } = load('main.ts', { obsidian: { ...obsidian, Modal } }); const { app, repo } = fixture('en'), plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings.language = 'en';
  const session = { ...coffeeSession(), status: 'completed', transcriptMarkdown: 'The table discussed meal choices.' }; plugin.mutate = run => run(); plugin.activateView = async path => { opened = path; };
  await plugin.openCoffeeHandoff(session, 'Agent Workspace/Coffee Tables/session.md'); coffeeFind(modal.contentEl, element => element.text === 'Create research map').click(); await until(() => opened);
  const map = await repo.readMap(opened); assert.equal(map.nodes.length, 1); const note = await repo.readNote(map.nodes[0].path);
  assert.match(note.detail, /Coffee Tables/); assert.doesNotMatch(note.detail, /meal choices/); assert.match(note.detail, /Simulated Coffee Tables discussion/);
});

test('product ribbon pins both entrances below other actions and cleans up on unload', () => {
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    moved(node) { if (this.connected) this.callback([{ addedNodes: [node] }]); }
  }
  const parent = {
    children: [],
    classList: { add() {}, remove() {} },
    get lastElementChild() { return this.children.at(-1); },
    appendChild(icon) { this.insertBefore(icon, null); },
    insertBefore(icon, next) {
      this.children = this.children.filter(child => child !== icon);
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, icon); icon.parentElement = this;
    }
  };
  const make = name => ({
    name, parentElement: parent,
    classList: { values: new Set(), add(...names) { names.forEach(n => this.values.add(n)); }, remove(...names) { names.forEach(n => this.values.delete(n)); } },
    get nextSibling() { return parent.children[parent.children.indexOf(this) + 1] || null; },
    get nextElementSibling() { return this.nextSibling; }
  });
  const before = make('before'), coffee = make('coffee'), other = make('other'), map = make('map');
  parent.children = [before, coffee, other, map];
  const { groupRibbonIcons } = load('ui/ribbon-group.ts', {}, { MutationObserver: Observer });
  const stop = groupRibbonIcons(map, coffee);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map', 'coffee']);
  assert.ok(map.classList.values.has('vam-ribbon-group-start'));
  assert.ok(coffee.classList.values.has('vam-ribbon-group-end'));
  parent.insertBefore(coffee, before); observer.moved(coffee);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map', 'coffee']);
  parent.insertBefore(map, null); observer.moved(map);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map', 'coffee']);
  parent.children = parent.children.filter(x => x !== coffee); coffee.parentElement = null;
  observer.moved(other);
  assert.ok(map.classList.values.has('vam-ribbon-group-start'));
  assert.ok(map.classList.values.has('vam-ribbon-group-end'));
  parent.insertBefore(coffee, before); observer.moved(coffee);
  assert.equal(map.nextElementSibling, coffee);
  stop();
  assert.equal(observer.connected, false);
  assert.equal(map.classList.values.size, 0);
  assert.equal(coffee.classList.values.size, 0);
});

integrationTest('Coffee Tables streaming restores scroll after asynchronous Markdown and preserves user scrolling', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'generating'; session.draftMarkdown = 'A growing dialogue';
  const view = new CoffeeTablesView({ app: {} }, { settings: { language: 'en' } });
  view.engine = { session }; view.renderRoster = () => {};
  const scrolling = { scrollTop: 400, scrollHeight: 1000, clientHeight: 300, isConnected: true };
  const draft = { style: {}, setCssProps() {}, addClass() { this.style.minHeight = "900px"; }, removeClass() { this.style.minHeight = ""; }, offsetHeight: 900, empty() { scrolling.scrollHeight = 500; } };
  view.contentEl = { querySelector: selector => selector === '.ct-chat-scroll' ? scrolling : selector === '.ct-live-draft' ? draft : null };
  let pending = deferred();
  view.renderRound = () => { view.markdownJobs.push(pending.promise.then(() => { scrolling.scrollHeight = 1200; })); };
  view.refreshLive();
  pending.resolve(); await until(() => draft.style.minHeight === '');
  assert.equal(scrolling.scrollTop, 400);
  scrolling.scrollTop = 900; pending = deferred(); view.refreshLive();
  scrolling.scrollTop = 650; view.scrollEpoch++; pending.resolve(); await until(() => draft.style.minHeight === '');
  assert.equal(scrolling.scrollTop, 650);
});

integrationTest('Coffee Tables accepts complete bold observer headings and prose with hidden source comments', async () => {
  const sections = ['意外連結', '值得繼續想的問題', '核心分歧', '探索方向', '值得查證的假設'];
  const notes = sections.map(title => `**## ${title}**\n\n共同規則有助於避免任意，但可能忽略處境差異，仍需要確認實際使用情況。<!-- source: 共同規則可能把差異藏起來。 -->`).join('\n\n');
  const response = `### 林予安｜主持人\n\n共同規則可能把差異藏起來。\n\n### 陳敬文｜中立觀察者\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  const engine = new coffee.CoffeeEngine(coffeeSession(), async () => response, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'completed');
  assert.doesNotMatch(engine.session.transcriptMarkdown, /核心分歧/);
  assert.match(engine.session.observerNotes[0], /^# 觀察者整理/);
  const { parseCoffeeOutline } = load('experiences/coffee-tables/outline.ts');
  const outline = parseCoffeeOutline(engine.session.observerNotes[0]);
  assert.equal(outline.length, 5);
  assert.equal(outline[0].items[0].sourceText, '共同規則可能把差異藏起來。');
  const stopped = coffeeSession(); stopped.status = 'stopped'; stopped.draftMarkdown = response;
  const reopened = new coffee.CoffeeEngine(stopped, async () => { assert.fail('Complete stopped draft must recover without AI'); }, async () => {});
  await reopened.start(); assert.equal(reopened.session.status, 'completed');
});


test('Coffee Tables restored visible built-in insights apply in all four modes without constraining custom styles', () => {
  for (const language of ['zh-TW', 'en']) {
    const session = coffeeSession(); session.language = language;
    session.guests.stylePrompt = language === 'zh-TW' ? coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT : coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT_EN;
    session.transcriptMarkdown = 'Earlier important exchange'; session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n\n- Earlier valuable insight: the exchange showed a concrete unresolved tradeoff.'];
    session.guests.referenceFiles = [{ name: 'context.md', content: 'Reference background' }];
    const prompts = [coffeePrompts.tablePrompt(session.topic, language, session.guests), coffeePrompts.tablePrompt(session.topic, language, session.guests, 'Saved draft', coffeePrompts.assembleCoffeeContext(session)), coffeePrompts.questionPrompt(session, 'New question'), coffeePrompts.observerOnlyPrompt(session)];
    for (const prompt of prompts) {
      assert.match(prompt, /原本五類每類整理 2–4|2–4 distinct, substantive insights in each of the first five categories/);
      assert.match(prompt, /沒有重新輸出的舊項目會由程式保留|the program retains old items you do not rewrite/); assert.match(prompt, /整合完整對談|use the complete saved conversation/);
      assert.match(prompt, /context.md/);
      assert.match(prompt, /程式會保留未提及項目|the program retains old items you do not rewrite/);
    }
    for (const prompt of prompts.slice(1)) { assert.match(prompt, /Earlier important exchange/); assert.match(prompt, /Earlier valuable insight/); }
    session.guests.stylePrompt = 'User-authored style only';
    for (const prompt of [coffeePrompts.tablePrompt(session.topic, language, session.guests), coffeePrompts.questionPrompt(session, 'Question'), coffeePrompts.observerOnlyPrompt(session)]) assert.doesNotMatch(prompt, /原本五類每類整理 2–4|2–4 distinct, substantive insights in each of the first five categories/);
  }
});
integrationTest('Coffee Tables token timestamps repaint live regions instead of rebuilding the reading pane', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const session = coffeeSession(); session.status = 'generating'; let renders = 0, live = 0;
  const view = new CoffeeTablesView({ app: {} }, { settings: {} }); view.engine = { session, busy: true, error: '' }; view.render = () => renders++; view.refreshLive = () => live++;
  view.refresh(); session.updatedAt = 'later-token'; view.refresh(); await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(live, 1); assert.equal(renders, 1);
});
integrationTest('Coffee Tables consecutive full repaints retain reading position until Markdown finishes', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'completed'; session.rounds = [{id:'r',markdown:'Saved dialogue',createdAt:session.createdAt}];
  const view = new CoffeeTablesView({ app: {} }, {settings:{language:'en'},modelLabel:x=>x}); view.engine = {session,busy:false}; view.store = {sessionPath:()=>''}; view.renderRoster=()=>{}; view.updateStatus=()=>{}; view.renderMarkdown=()=>{};
  let scrolling = {scrollTop:400,scrollHeight:1000,clientHeight:300}; const pending = deferred();
  const make = (tag, options={}) => { const el = coffeeElement(tag,options); const cls=typeof options==='string'?options:options.cls; el.isConnected=true;
    el.createDiv=value=>{const child=make('div',typeof value==='string'?{cls:value}:value);el.children.push(child);return child};
    if (cls==='ct-chat-scroll') { scrolling=el; el.scrollHeight=300;el.clientHeight=300;let top=0;Object.defineProperty(el,'scrollTop',{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,el.scrollHeight-el.clientHeight))}}); }
    if (cls==='ct-messages') { const owner=scrolling;el.setCssProps=props=>{owner.scrollHeight=parseFloat(props['--ct-live-held-height'])};el.removeClass=()=>{owner.scrollHeight=1200}; }
    return el;
  };
  view.contentEl=make('root');view.contentEl.ownerDocument={activeElement:null};view.contentEl.querySelector=selector=>selector==='.ct-chat-scroll'?scrolling:null;view.contentEl.querySelectorAll=()=>[];
  view.renderRound=()=>view.markdownJobs.push(pending.promise);
  view.render(); assert.equal(scrolling.scrollTop,400);view.render();assert.equal(scrolling.scrollTop,400);
  pending.resolve();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(scrolling.scrollTop,400);
  view.engine.busy=true; session.status='generating'; view.render(); let rebuilt=0; view.render=()=>rebuilt++; view.refreshLive=()=>{}; session.updatedAt='next-token';view.refresh();assert.equal(rebuilt,0);
});
integrationTest('Coffee Tables observer refresh keeps the previous latest notes when final saving fails', async () => {
  const session=coffeeSession();session.status='completed';session.observerNotes=['Previous latest notes'];
  const fresh='# 觀察者整理\n\n'+['意外連結','值得繼續想的問題','核心分歧','探索方向','值得查證的假設'].map(t=>'## '+t+'\n- A concrete observation.\n- A second observation.').join('\n\n');
  const engine=new coffee.CoffeeEngine(session,async request=>{request.onText?.(fresh);return fresh},async value=>{if(value.observerNotes[0].includes('A concrete observation.'))throw new Error('Final save failed')});
  await engine.refreshObserverNotes();assert.equal(engine.session.observerNotes[0],'Previous latest notes');assert.match(engine.session.observerDraftMarkdown,/A concrete observation\./);assert.match(engine.error,/Final save failed/);
});

test('Coffee segment navigation sorts rounds and follow-ups without treating interventions as new segments', () => {
  const { coffeeSegments } = load('experiences/coffee-tables/segments.ts');
  const session = { id: 'table', createdAt: '2026-01-01', transcriptMarkdown: '', rounds: [{ id: 'a', createdAt: '2026-01-01', kind: 'initial', status: 'completed', markdown: 'A', summary: 'Opening.' }, { id: 'b', createdAt: '2026-01-03', kind: 'continuation', status: 'error', markdown: '', draftMarkdown: 'Draft' }], questions: [{ id: 'q', createdAt: '2026-01-02', question: 'Why?', answer: 'Because.', status: 'complete' }], interventions: [{ id: 'i', text: 'A turning question', roundId: 'a', afterTurn: 2, createdAt: '2026-01-02' }] };
  assert.deepEqual(plain(coffeeSegments(session)).map(x => [x.id,x.kind,x.status]), [['round:a','initial','completed'],['question:q','question','completed'],['round:b','continuation','error']]);
  assert.ok(coffeeSegments(session)[0].text.includes('A turning question'));
});
test('Coffee summary parsing removes metadata without damaging notes and ignores malformed summaries', () => {
  const { extractSegmentSummary, parseSummaryBatch } = load('experiences/coffee-tables/segments.ts');
  const result = extractSegmentSummary('### A｜Host\nHello.\n<!-- coffee-segment-summary: {"summary":"The debate shifted to responsibility."} -->\n# Observer’s notes\nNotes');
  assert.equal(result.summary, 'The debate shifted to responsibility.'); assert.ok(!result.markdown.includes('coffee-segment-summary')); assert.ok(result.markdown.includes('# Observer’s notes'));
  assert.equal(extractSegmentSummary('text\n<!-- coffee-segment-summary: bad -->').summary, undefined);
  assert.deepEqual(plain(parseSummaryBatch('{"summaries":[{"id":"round:a","summary":"One."},{"id":"foreign","summary":"Ignore."}]}', ['round:a'])), [{id:'round:a',summary:'One.'}]);
  assert.throws(() => parseSummaryBatch('{"summaries":[{"id":"round:a","summary":"One."},{"id":"round:a","summary":"Two."}]}', ['round:a']));
});

integrationTest('Coffee segment summaries are saved with generation; retries retain round identity and missing summaries do not fail dialogue', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeSession(); let attempts = 0;
  const coffeeResponse = '### Host|Host\nA discussion.\n# Observer’s notes\n' + ['Unexpected connections','Questions worth pursuing','Core disagreements','Directions to explore','Assumptions to verify'].map(title => `## ${title}\n- A concrete observation from this dialogue.`).join('\n');
  const engine = new CoffeeEngine(session, async () => { if (++attempts === 1) throw new Error('offline'); return coffeeResponse + '\n<!-- coffee-segment-summary: {"summary":"A shift in the question."} -->'; }, async () => {});
  await engine.start(); const id = engine.session.rounds[0].id; assert.equal(engine.session.rounds[0].status, 'error');
  await engine.start(); assert.equal(engine.session.rounds.length,1); assert.equal(engine.session.rounds[0].id,id); assert.equal(engine.session.rounds[0].summary,'A shift in the question.'); assert.ok(!engine.session.transcriptMarkdown.includes('coffee-segment-summary'));
  const other = new CoffeeEngine(coffeeSession(), async () => coffeeResponse, async () => {}); await other.start(); assert.equal(other.session.status,'completed'); assert.equal(other.session.rounds[0].summary,undefined);
});
integrationTest('Coffee summary backfill makes one request, saves partial IDs only, and preserves dialogue and insights on failure or cancellation', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeSession(); session.status='completed'; session.rounds=[{id:'a',markdown:'Hello.',notes:'',status:'completed',createdAt:session.createdAt},{id:'b',markdown:'More.',notes:'',summary:'Existing.',status:'completed',createdAt:session.createdAt}]; session.questions=[{id:'q',question:'Why?',answer:'Reason.',status:'complete',createdAt:session.createdAt}]; session.observerNotes=['Keep these notes.']; let calls=0;
  const engine = new CoffeeEngine(session, async ({prompt}) => {calls++; assert.ok(prompt.includes('round:a')); assert.ok(!prompt.includes('round:b')); return '{"summaries":[{"id":"round:a","summary":"Opening turn."}]}';},async()=>{});
  await engine.fillSegmentSummaries(); assert.equal(calls,1); assert.equal(engine.session.rounds[0].summary,'Opening turn.'); assert.equal(engine.session.rounds[1].summary,'Existing.'); assert.equal(engine.session.questions[0].summary,undefined); assert.equal(engine.session.observerNotes[0],'Keep these notes.'); assert.ok(engine.error);
  const failed = new CoffeeEngine(session,async()=>'{broken',async()=>{}); await failed.fillSegmentSummaries(); assert.deepEqual(plain(failed.session),plain(session));
  const saveFailed = new CoffeeEngine(session,async()=>'{"summaries":[{"id":"round:a","summary":"Opening turn."}]}',async()=>{throw new Error('disk');}); await saveFailed.fillSegmentSummaries(); assert.equal(saveFailed.session.rounds[0].summary,undefined);
  let abort; const cancelled = new CoffeeEngine(session,({signal})=>new Promise(resolve=>{abort=()=>resolve('{"summaries":[{"id":"round:a","summary":"Never save."}]}'); signal.addEventListener('abort',abort);}),async()=>{}); const pending=cancelled.fillSegmentSummaries(); cancelled.cancel(); await pending; assert.equal(cancelled.session.rounds[0].summary,undefined);
});

integrationTest('Coffee navigation summary metadata round trips by identity without changing transcript or triggering stale insights', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f=>f instanceof TFile);
  const store=new CoffeeStorage(app.vault,'Agent Workspace'), session=coffeeSession(); session.status='completed'; session.rounds=[{id:'empty',markdown:'',notes:'',status:'error',createdAt:session.createdAt},{id:'spoken',markdown:'### A|Host\nSpeech.',notes:'',kind:'continuation',summary:'A concrete turn.',status:'completed',createdAt:session.createdAt}]; session.questions=[{id:'q',question:'Why?',answer:'Because.',status:'complete',summary:'The follow-up explores causes.',createdAt:session.createdAt}];
  await store.save(session); const reopened=await new CoffeeStorage(app.vault,'Agent Workspace').load(session.id); assert.equal(reopened.rounds.find(x=>x.id==='spoken').summary,'A concrete turn.'); assert.equal(reopened.rounds.find(x=>x.id==='spoken').kind,'continuation'); assert.equal(reopened.questions[0].summary,'The follow-up explores causes.'); assert.ok(!reopened.dirtyNotes); assert.equal(reopened.transcriptMarkdown,'### A|Host\nSpeech.');
  const file=store.sessionPath(session.id), raw=contents.get(file); const marker=/<!-- coffee-tables-navigation:([^\n]+) -->/.exec(raw); const metadata=JSON.parse(decodeURIComponent(marker[1])); metadata.find(x=>x.id==='round:spoken').summary='Edited summary.'; contents.set(file,raw.replace(marker[0],`<!-- coffee-tables-navigation:${encodeURIComponent(JSON.stringify(metadata))} -->`)); const edited=await new CoffeeStorage(app.vault,'Agent Workspace').load(session.id); assert.equal(edited.rounds.find(x=>x.id==='spoken').summary,'Edited summary.'); assert.ok(!edited.dirtyNotes);
});
integrationTest('Coffee insight filtering expands matching context without changing saved collapse preferences', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian}); const view=new CoffeeTablesView({app:{}},{settings:{language:'en'}}); view.engine={session:{id:'table',language:'en'}}; view.renderMarkdown=()=>{};
  const markdown='# Observer’s notes\n## Unexpected connections\n- Brief insight. <!-- coffee-insight:v1:id=item-a -->\n  - Context: A detailed bridge to trust.\n## Core disagreements\n- Other insight. <!-- coffee-insight:v1:id=item-b -->'; const target=coffeeElement('root'); view.renderInsightNotes(markdown,target);
  const input=coffeeFind(target,x=>x.tag==='input'); input.value='trust'; input.input(); assert.equal(coffeeFind(target,x=>x.tag==='input'),input);
  const state=view.insightStates.get('table'); state.collapsed.add('connections'); state.query='trust'; target.empty(); view.renderInsightNotes(markdown,target); const group=coffeeFind(target,x=>x.tag==='details' && x.dataset.insightCategory); assert.equal(group.open,true); assert.equal(coffeeFind(group,x=>x.dataset.insightId==='item-a').open,true); assert.equal(coffeeFind(target,x=>x.dataset.insightId==='item-b'),undefined); assert.equal(state.expanded.size,0); assert.ok(state.collapsed.has('connections'));
  state.query='';target.empty();view.renderInsightNotes(markdown,target); assert.equal(coffeeFind(target,x=>x.dataset.insightCategory==='connections').open,false); assert.equal(coffeeFind(target,x=>x.dataset.insightId==='item-a').open,false);
});
integrationTest('Coffee segment jump uses exact anchors and switches narrow layout to conversation', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian}); const view=new CoffeeTablesView({app:{}},{settings:{language:'en'}}); let scroll; const message={addClass(){},removeClass(){}}, segment={dataset:{coffeeSegment:'round:a'},getBoundingClientRect:()=>({top:300}),querySelector:()=>message},scroller={scrollTop:50,getBoundingClientRect:()=>({top:100}),scrollTo:value=>scroll=value},body={dataset:{pane:'insight'}};
  view.contentEl={querySelectorAll:()=>[segment],querySelector:q=>q==='.ct-chat-scroll'?scroller:q==='.ct-room-columns'?body:null}; assert.equal(view.locateSegment('round:a'),true); assert.equal(scroll.top,226); assert.equal(body.dataset.pane,'chat'); assert.equal(view.locateSegment('round:missing'),false);
});

integrationTest('Coffee legacy navigation stays read only and clears the previous room', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian:{...obsidian,MarkdownRenderer:{render:async()=>{}}}});
  const view=new CoffeeTablesView({app:{workspace:{}}},{settings:{language:'en'},isCoffeeOutlineSource:()=>true,refreshCoffeeOutline(){}});
  view.contentEl=coffeeElement('root'); view.button=()=>{}; view.store={sessionPath:()=> 'legacy.md'}; view.engine={session:{id:'previous'}};
  view.attachLegacy({version:1,id:'old',topic:'Old table',model:'model',createdAt:'2026-01-01',messages:[{speakerId:'host',text:'Old discussion'}],participants:[{id:'host',name:'Host',role:'Host'}],notes:null});
  assert.equal(view.engine,null); assert.equal(view.outlineSnapshot().sessionId,'old'); assert.equal(view.outlineSnapshot().segments[0].kind,'legacy'); assert.ok(coffeeFind(view.contentEl,x=>x.attrs['data-coffee-segment']==='legacy'));
});

integrationTest('Coffee summary-only save preserves exact historic insight Markdown', async () => {
 const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian}); const {app,files,contents}=fixture(); app.vault.getFiles=()=>[...files.values()].filter(f=>f instanceof TFile);
 const store=new CoffeeStorage(app.vault,'Agent Workspace'), session=coffeeSession(); session.rounds=[{id:'round-a',markdown:'### Host|Host\nOriginal dialogue.',notes:'',status:'completed',createdAt:session.createdAt}]; await store.save(session);
 const path=store.sessionPath(session.id), original=contents.get(path), historic=original.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->\n?/m,'').replace('## Observer notes','## Observer notes\n\n### Latest\n\nKeep this formatting.\n\n### History'); contents.set(path,historic);
 const fresh=new CoffeeStorage(app.vault,'Agent Workspace'); const loaded=await fresh.load(session.id); loaded.rounds[0].summary='The segment explored a concrete turn.'; await fresh.save(loaded,true); const saved=contents.get(path);
 assert.equal(saved.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->\n\n/m,''),historic); assert.equal((await fresh.load(session.id)).rounds[0].summary,loaded.rounds[0].summary);
});
integrationTest('Coffee summary metadata ignores reference markers and headings', async () => {
 const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian}); const {app,files,contents}=fixture(); app.vault.getFiles=()=>[...files.values()].filter(f=>f instanceof TFile); const store=new CoffeeStorage(app.vault,'Agent Workspace'),session=coffeeSession();
 session.rounds=[{id:'round-a',markdown:'### Host|Host\nReal conversation.',notes:'',status:'completed',createdAt:session.createdAt}]; session.guests={...(session.guests||{}),customPrompt:'',counts:{experts:1,'cross-domain':0,generalist:0,affected:0},referenceFiles:[{name:'reference.md',content:'```\n<!-- coffee-tables-navigation:%5B%5D -->\n\n## Conversation\nQuoted reference headings.'}]};
 await store.save(session); const encoded=contents.get(store.sessionPath(session.id)); const before=encoded.replace('````text','```text').replace(/\n````\n/g,'\n```\n'); contents.set(store.sessionPath(session.id),before); const fresh=new CoffeeStorage(app.vault,'Agent Workspace'); const loaded=await fresh.load(session.id); assert.equal(loaded.rounds[0].markdown,session.rounds[0].markdown); loaded.rounds[0].summary='A genuine navigation summary.'; await fresh.save(loaded,true); const after=contents.get(store.sessionPath(session.id)); assert.ok(after.includes(session.guests.referenceFiles[0].content)); assert.equal(after.match(/coffee-tables-navigation:/g).length,2); assert.equal((await fresh.load(session.id)).rounds[0].summary,loaded.rounds[0].summary); assert.equal(before.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->$/gm,''),after.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->$/gm,''));
});
