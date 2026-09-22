const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, windowValues = {}) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console, crypto: require('node:crypto').webcrypto, process, AbortController, window: { setTimeout, clearTimeout, ...windowValues } });
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
  assert.equal(DEFAULT_SETTINGS.firstUseNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.codexUsageNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.workspaceInitialized, false);
  assert.equal(DEFAULT_SETTINGS.sampleTourVersionSeen, 0);
  assert.doesNotMatch(DEFAULT_SETTINGS.models, /claude:/);
  assert.equal(normalizeReasoningLevel('medium'), 'medium');
  assert.equal(normalizeReasoningLevel('high'), 'high');
  assert.equal(normalizeReasoningLevel('auto'), 'auto');
  assert.equal(normalizeReasoningLevel('unsupported'), 'low');
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
test('research depth sets separate search targets and source selection ranks only related notes', () => {
  const { researchLimits } = load('ai/task-policy.ts');
  const { selectSourceDocuments, sourceContext } = load('ai/source-selection.ts');
  assert.deepEqual(plain(researchLimits('fast')), { searches: 1, sources: 2 });
  assert.deepEqual(plain(researchLimits('normal')), { searches: 3, sources: 5 });
  assert.deepEqual(plain(researchLimits('deep')), { searches: 6, sources: 10 });
  const { researchGuidance } = load('ai/task-policy.ts');
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'fast' }), /快速概覽/);
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'deep' }), /深入研究/);
  const docs = [{ name: '旅行/台北交通.md', content: '捷運與公車' }, { name: '旅行/台北飯店.md', content: '住宿價格' }, { name: '工作/會議.md', content: '無關' }];
  const picked = selectSourceDocuments('台北交通', docs, 'fast');
  assert.deepEqual(picked.map(item => item.name), ['旅行/台北交通.md', '旅行/台北飯店.md']);
  assert.doesNotMatch(sourceContext(picked), /工作\/會議/);
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

test('Codex launch uses its sibling Node with automatic nvm discovery and explicit paths', async () => {
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
test('workspace repair creates only the configured base folders and is idempotent', async () => {
  const { repo, app } = fixture();
  assert.equal(repo.workspaceExists(), false);
  await repo.ensureWorkspace(); await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics') instanceof TFolder);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Inbox') instanceof TFolder);
});
test('workspace rediscovery finds valid custom VAM workspaces without accepting unrelated Map files', async () => {
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
test('AI exchange log persists exact request and reply with a bounded history and clear', async () => {
  const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-log-'));
  const file = path.join(directory, 'ai-exchanges.json');
  const errors = [];
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
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('pending child suggestions persist across reload and disappear after dismissal', async () => {
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
test('proposal persistence reports disk write failure to the caller', async () => {
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
  assert.match(source, /id: "open-debug-log"/); assert.match(source, /new DebugLogModal\(this\.app, this\.logs, this\.exchanges/);
  assert.match(modal, /navigator\.clipboard\.writeText/); assert.match(modal, /this\.logs\.clear\(\)/);
  assert.match(modal, /更新日誌/);
  assert.match(modal, /this\.logs\.subscribe/);
  assert.match(source, /Codex App Server 尚未就緒/);
  assert.match(source, /Codex App Server 已就緒/);
  assert.match(source, /AI 任務失敗/);
});
class TFolder { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = []; this.parent = null; } }
class TFile { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\.md$/, ''); this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''; this.parent = null; this.stat = { mtime: Date.now() }; } }
const obsidian = {
  TFile, TFolder, App: class {}, Plugin: class {}, ItemView: class { constructor(leaf) { this.app = leaf.app; } }, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, FileSystemAdapter: class { getBasePath() { return '/vault'; } },
  normalizePath: value => value.replace(/\/+/g, '/').replace(/^\//, ''),
  parseYaml: text => Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const index = line.indexOf(':'); const raw = line.slice(index + 1).trim(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return [line.slice(0, index), value]; })),
  stringifyYaml: obj => Object.entries(obj).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n'
};
const { Repository, DEFAULT_SETTINGS, normalizeReasoningLevel } = load('repository.ts', { obsidian });
test('node plus adds a child without opening a duplicate right-click menu', () => {
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
  assert.equal(plus['aria-label'], '手動新增子議題');
  plus.click({ stopPropagation() {} });
  assert.equal(added, 1);
  const badge = buttons.find(button => button.text === '查看 1 個展開建議');
  badge.click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === '接下來想怎麼探索？').click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === '結構與連結').click({ stopPropagation() {} });
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
test('Next Step returns new expansion requests to the map and reviews existing proposals in place', async () => {
  let closed = 0, expandCalls = 0, synthCalls = 0, created, saved, quickOptions, researchOptions, synthOptions; const notices = [];
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, value: options.value ?? options.text ?? '', cls: options.cls ?? '', children: [], style: {}, disabled: false,
    classList: { toggle(name, enabled) { this[name] = enabled; } },
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = name; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addEventListener(name, handler) { if (name === 'click') this.click = handler; if (name === 'change') this.change = handler; if (name === 'input') this.input = handler; },
    querySelector(selector) { const name = selector.slice(1); return find(this, item => item.cls.split(' ').includes(name)); },
    empty() { this.children = []; }, remove() { this.removed = true; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const button = (root, label) => find(root, item => item.tag === 'button' && item.text === label);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { closed++; this.onClose?.(); } }
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: class { constructor(message) { notices.push(message); } } } });
  const plugin = { settings: { codexUsageNoticeSeen: true }, saveSettings: async () => {} };
  const modal = new NextStepModal({}, 'Parent', 'normal', 1, 1, plugin,
    async options => { researchOptions = options; },
    async (options, _direction, found, _failed, createdMap) => { expandCalls++; if (options.multiLayer) { quickOptions = options; createdMap(); } else found([{ title: 'Transport', task: 'Compare', contribution: '', parentTitle: '' }], async items => { created = items; }); },
    async (options, angles, drafted) => { synthCalls++; synthOptions = options; angles([{ title: 'Shared constraints', task: 'Find tradeoffs', contribution: 'Across children' }], async () => { drafted({ summary: 'Draft', detail: 'Detail' }, async (summary, detail) => { saved = [summary, detail]; }); }); });
  modal.onOpen();
  const [cards, research, expand, synthesize] = modal.contentEl.children.slice(1);
  assert.equal(all(research, item => item.tag === 'input' && (item.type === 'checkbox' || item.type === 'file')).length, 0);
  assert.equal(all(expand, item => item.tag === 'input' && item.type === 'file').length, 0);
  assert.equal(all(synthesize, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.equal(find(research, item => item.text === '允許搜尋網路'), undefined);
  assert.equal(find(expand, item => item.text === '允許搜尋網路'), undefined);
  assert.equal(find(synthesize, item => item.text === '允許搜尋網路'), undefined);
  assert.equal(find(synthesize, item => item.text === '不複製子議題全文'), undefined);
  cards.children[1].click();
  assert.equal(research.style.display, 'none'); assert.equal(expand.style.display, '');
  assert.equal(find(expand, item => item.tag === 'input' && item.type === 'checkbox' && item.checked === false)?.checked, false);
  button(expand, '查看 AI 子議題建議').click(); await tick();
  assert.equal(expandCalls, 1); assert.equal(closed, 0);
  const proposalCheck = find(expand.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  proposalCheck.checked = false; button(expand, '建立子議題').click(); await tick();
  assert.equal(created, undefined); assert.equal(expand.querySelector('.vam-next-status').text, '請至少選取一個子議題。');
  proposalCheck.checked = true;
  button(expand, '建立子議題').click(); await tick();
  assert.equal(created[0].title, 'Transport'); assert.equal(closed, 0);
  cards.children[2].click(); button(synthesize, '先取得整合建議').click(); await tick();
  assert.equal(synthCalls, 1); assert.equal(closed, 0);
  assert.equal(synthOptions.researchMode, 'local');
  assert.ok(button(synthesize, '選擇這個方向'));
  button(synthesize, '取得整合草稿').click(); await tick();
  button(synthesize, '確認寫入母議題').click(); await tick();
  assert.deepEqual(saved, ['Draft', 'Detail']); assert.equal(closed, 0);
  cards.children[0].click(); button(research, '確認研究任務').click(); await tick();
  assert.equal(researchOptions.researchMode, 'research'); assert.equal(researchOptions.currentVault, false);
  assert.equal(closed, 1); assert.equal(research.querySelector('.vam-next-result'), undefined);
  const quickModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, modal.expand, async () => {});
  quickModal.onOpen(); quickModal.contentEl.children[1].children[1].click(); button(quickModal.contentEl, '快速探索地圖').click();
  assert.equal(button(quickModal.contentEl, '查看 AI 子議題建議'), undefined);
  button(quickModal.contentEl, '直接建立初步地圖').click(); await tick();
  assert.equal(quickOptions.multiLayer, true); assert.equal(quickOptions.shallowResearch, false); assert.equal(quickOptions.layers, 2); assert.equal(quickOptions.firstLayerCount, 3); assert.equal(quickOptions.childrenPerParent, 2); assert.equal(closed, 2);
  assert.equal(quickOptions.researchMode, 'research'); assert.equal(quickOptions.folderFiles.length, 0);
  const partial = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('部分子議題已建立，請重新開啟視窗。', false), async () => {});
  partial.onOpen(); partial.contentEl.children[1].children[1].click(); button(partial.contentEl, '快速探索地圖').click();
  button(partial.contentEl, '直接建立初步地圖').click(); await tick();
  assert.equal(closed, 3); assert.match(notices.at(-1), /重新開啟/);
  let emptyOptions;
  const empty = new NextStepModal({}, 'No children', 'normal', 0, 0, plugin, async () => {}, async () => {}, async options => { synthCalls++; emptyOptions = options; });
  empty.onOpen(); empty.contentEl.children[1].children[2].click();
  const emptyPanel = empty.contentEl.children.at(-1);
  assert.match(emptyPanel.children[1].text, /沒有直屬子議題/);
  button(emptyPanel, '先取得整合建議').click(); await tick();
  assert.equal(synthCalls, 1);
  const emptyChecks = all(emptyPanel, item => item.tag === 'input' && item.type === 'checkbox');
  emptyChecks[0].checked = true;
  button(emptyPanel, '先取得整合建議').click(); await tick();
  assert.equal(synthCalls, 2); assert.equal(emptyOptions.currentVault, true); assert.equal(emptyOptions.researchMode, 'local');
  const failing = new NextStepModal({}, 'Parent', 'normal', 1, 1, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('Provider failed'), async () => {});
  failing.onOpen(); failing.contentEl.children[1].children[1].click();
  button(failing.contentEl, '查看 AI 子議題建議').click(); await tick();
  assert.equal(failing.contentEl.children[3].querySelector('.vam-next-status').text, 'Provider failed'); assert.equal(closed, 3);
  const failedResearch = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async (_options, _focus, _done, failed) => failed('Cannot start'), async () => {}, async () => {});
  failedResearch.onOpen(); button(failedResearch.contentEl, '確認研究任務').click(); await tick();
  assert.equal(closed, 3); assert.equal(failedResearch.contentEl.children[2].querySelector('.vam-next-status').text, 'Cannot start');
  let acknowledged = 0, began = 0;
  const firstUsePlugin = { settings: { codexUsageNoticeSeen: false }, saveSettings: async () => { acknowledged++; } };
  const firstUse = new NextStepModal({}, 'Parent', 'normal', 1, 0, firstUsePlugin, async () => { began++; }, async () => {}, async () => {});
  firstUse.onOpen(); button(firstUse.contentEl, '確認研究任務').click(); await tick();
  assert.equal(began, 0); assert.ok(button(firstUse.contentEl, '了解並執行')); assert.equal(closed, 3);
  button(firstUse.contentEl, '了解並執行').click(); await tick();
  assert.equal(began, 1); assert.equal(acknowledged, 1); assert.equal(closed, 4);
  let pendingCalls = 0;
  const pendingPlugin = { settings: { codexUsageNoticeSeen: false }, saveSettings: async () => {} };
  const pendingModal = new NextStepModal({}, 'Parent', 'normal', 1, 1, pendingPlugin, async () => {}, async (_options, _direction, found) => { pendingCalls++; found([{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }], async () => {}); }, async () => {});
  pendingModal.onOpen(); pendingModal.contentEl.children[1].children[1].click();
  button(pendingModal.contentEl, '查看 AI 子議題建議').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, '了解並執行'), undefined);
  button(pendingModal.contentEl, '建立子議題').click(); await tick();
  assert.ok(button(pendingModal.contentEl, '取得展開方向'));
  button(pendingModal.contentEl, '取得展開方向').click(); await tick();
  assert.equal(pendingCalls, 1); assert.ok(button(pendingModal.contentEl, '了解並執行'));
  const limited = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => { began++; }, async () => {}, async () => {});
  limited.onOpen();
  const fileInputs = all(limited.contentEl.children[4], item => item.tag === 'input' && item.type === 'file');
  fileInputs[1].files = Array.from({ length: 9 }, (_, i) => ({ name: `file-${i}.md` }));
  button(limited.contentEl, '先取得整合建議').click(); await tick();
  assert.equal(began, 1); assert.equal(limited.contentEl.children[4].querySelector('.vam-next-status').text, '一次最多手選 8 份 Markdown。');
  let finishQuick, completedQuick = false, delayedOptions;
  const delayed = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async options => {
    delayedOptions = options;
    await new Promise(resolve => { finishQuick = resolve; });
    completedQuick = true;
  }, async () => {});
  delayed.onOpen(); delayed.contentEl.children[1].children[1].click(); button(delayed.contentEl, '快速探索地圖').click();
  const numbers = all(delayed.contentEl, item => item.tag === 'input' && item.type === 'number');
  numbers[0].value = '3'; numbers[1].value = '2'; numbers[2].value = '2'; numbers[0].input();
  const shallow = find(delayed.contentEl.children[3], item => item.tag === 'input' && item.type === 'checkbox' && item.checked === false);
  shallow.checked = true;
  button(delayed.contentEl, '直接建立初步地圖').click(); await tick();
  assert.equal(closed, 5); assert.equal(completedQuick, false);
  assert.equal(delayedOptions.layers, 3); assert.equal(delayedOptions.firstLayerCount, 2); assert.equal(delayedOptions.childrenPerParent, 2); assert.equal(delayedOptions.shallowResearch, true);
  finishQuick(); await tick(); assert.equal(completedQuick, true);
  const invalid = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async () => assert.fail('over-limit task started'), async () => {});
  invalid.onOpen(); invalid.contentEl.children[1].children[1].click(); button(invalid.contentEl, '快速探索地圖').click();
  const invalidNumbers = all(invalid.contentEl, item => item.tag === 'input' && item.type === 'number'); invalidNumbers[0].value = '3'; invalidNumbers[1].value = '3'; invalidNumbers[2].value = '2'; invalidNumbers[0].input();
  assert.match(find(invalid.contentEl, item => item.tag === 'p' && item.text?.includes('超過上限 15 個')).text, /預計建立 21 個子議題/);
  assert.equal(button(invalid.contentEl, '直接建立初步地圖').disabled, true);
  invalidNumbers[0].value = '2'; invalidNumbers[0].input();
  assert.equal(button(invalid.contentEl, '直接建立初步地圖').disabled, false);
  assert.match(find(invalid.contentEl, item => item.tag === 'p' && item.text?.includes('每層數量')).text, /3 → 6；共 9 個/);
  assert.equal(closed, 5);
  let finishGuided, guidedFinished = false;
  const guidedModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (_options, _direction, found) => {
    await new Promise(resolve => { finishGuided = resolve; });
    found([{ title: 'Later', task: 'Explore', contribution: '' }], async () => {});
    guidedFinished = true;
  }, async () => {});
  guidedModal.onOpen(); guidedModal.contentEl.children[1].children[1].click();
  button(guidedModal.contentEl, '取得展開方向').click(); await tick();
  assert.equal(closed, 6); assert.equal(guidedFinished, false);
  finishGuided(); await tick();
  assert.equal(guidedFinished, true); assert.equal(button(guidedModal.contentEl, '建立子議題'), undefined);
  const settingsWrites = []; let researchAfterSave = false;
  const settingsModal = new NextStepModal({}, 'Parent', 'normal', 0, 0,
    { settings: { codexUsageNoticeSeen: true, models: 'model-a,model-b' }, saveSettings: async () => {} },
    async () => { researchAfterSave = settingsWrites.length === 2; }, async () => {}, async () => {},
    { model: 'model-a', modelSource: 'workspace', reasoning: 'low', save: async patch => { settingsWrites.push(patch); } });
  settingsModal.onOpen();
  assert.equal(settingsModal.contentEl.children.at(-1).children[0].text, '模型與進階設定');
  const modelSelect = find(settingsModal.contentEl, item => item['aria-label'] === '使用模型');
  const reasoningSelect = find(settingsModal.contentEl, item => item['aria-label'] === '推理等級');
  modelSelect.value = 'model-b'; modelSelect.change(); reasoningSelect.value = 'high'; reasoningSelect.change();
  assert.equal(researchAfterSave, false);
  button(settingsModal.contentEl, '確認研究任務').click(); await tick();
  assert.deepEqual(plain(settingsWrites), [{ model: 'model-b', modelSource: 'manual' }, { reasoning: 'high' }]);
  assert.equal(researchAfterSave, true);
});
function fixture() {
  const files = new Map(), contents = new Map();
  const attach = item => { const folderPath = item.path.split('/').slice(0, -1).join('/'); item.parent = files.get(folderPath) || null; if (item.parent instanceof TFolder && !item.parent.children.includes(item)) item.parent.children.push(item); };
  const renameTree = (from, to) => { const entries = Array.from(files.entries()).filter(([p]) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a[0].length - b[0].length); for (const [old, item] of entries) { files.delete(old); const next = `${to}${old.slice(from.length)}`; item.path = next; item.name = next.split('/').at(-1); if (item instanceof TFile) { item.basename = item.name.replace(/\.md$/, ''); item.stat.mtime = Date.now(); const content = contents.get(old); contents.delete(old); contents.set(next, content); } files.set(next, item); } for (const [, item] of entries) attach(item); };
  const app = { vault: {
    getAbstractFileByPath: p => files.get(p),
    getMarkdownFiles: () => Array.from(files.values()).filter(file => file instanceof TFile && file.extension === 'md'),
    read: async file => contents.get(file.path), cachedRead: async file => contents.get(file.path),
    createFolder: async p => { const folder = new TFolder(p); files.set(p, folder); attach(folder); return folder; },
    create: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    createBinary: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    process: async (file, change) => { contents.set(file.path, change(contents.get(file.path))); }
  }, metadataCache: { getFileCache: file => { const text = contents.get(file.path) || ''; return { frontmatter: text.includes('agent-map-node: true') ? { 'agent-map-node': true } : text.includes('visual-agent-map: true') ? { 'visual-agent-map': true } : {} }; }, getFirstLinkpathDest: link => Array.from(files.values()).find(file => file instanceof TFile && (file.basename === link || file.path.replace(/\.md$/, '') === link)) || null }, fileManager: { renameFile: async (item, target) => renameTree(item.path, target), trashFile: async () => {} } };
  return { app, contents, repo: new Repository(app, { ...DEFAULT_SETTINGS }) };
}
async function topicNote(repo, title = '題目', model = 'model-a', id = 'map-a') {
  const mapDoc = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = `Agent Workspace/Topics/${id}/Map.md`; await repo.ensureTopicFolders(`Agent Workspace/Topics/${id}`);
  return repo.createNote(title, model, mapDoc, mapPath, 'workspace');
}
test('editing note fields preserves latest AI detail and unrelated frontmatter', async () => {
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
test('local research mode persists without changing older notes', async () => {
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
test('current summary is editable in the Markdown body', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Editable summary');
  assert.match(contents.get(n.path), /## Current Summary\n\n尚未形成結論/);
  await repo.updateNote(n.path, { summary: 'AI conclusion that can be edited' });
  assert.match(contents.get(n.path), /summary: "AI conclusion that can be edited"/);
  assert.match(contents.get(n.path), /## Current Summary\n\nAI conclusion that can be edited/);
  contents.set(n.path, contents.get(n.path).replace('## Current Summary\n\nAI conclusion that can be edited', '## Current Summary\n\nUser-edited conclusion'));
  assert.equal((await repo.readNote(n.path)).summary, 'User-edited conclusion');
});
test('visual references are stored inside the editable Detail section', async () => {
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
test('managed references stay outside Detail and preserve user-authored content', async () => {
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
test('a note cannot belong to two maps', async () => {
  const { repo } = fixture(); const n = await topicNote(repo, 'shared');
  await repo.createMap('One', [n]); await repo.createMap('Two', [n]);
  await assert.rejects(() => repo.rebuildDerivedData(), /同時出現在兩張心智圖/);
});
test('removing a node clears ownership and generated references while keeping the note', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'kept'); const mapPath = await repo.createMap('One', [n]);
  await repo.rebuildDerivedData(); const mapDoc = await repo.readMap(mapPath); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).mapId, ''); assert.doesNotMatch(contents.get(n.path), /visual-agent-map:references:start/); assert.doesNotMatch(contents.get(n.path), /agent-map-references:/);
});
test('maps keep independent layout and preserve Markdown prose', async () => {
  const { repo, contents } = fixture(); const firstNode = await topicNote(repo, 'first', 'gpt-5.6-terra', 'map-a'); const secondNode = await topicNote(repo, 'second', 'gpt-5.6-terra', 'map-b');
  const first = await repo.createMap('One', [firstNode]), second = await repo.createMap('Two', [secondNode]);
  contents.set(first, contents.get(first) + '\nUser annotation\n');
  const changed = await repo.readMap(first); changed.nodes[0].x = 600; changed.title = 'Renamed'; await repo.saveMap(first, changed);
  assert.equal((await repo.readMap(second)).nodes[0].x, 80); assert.match(contents.get(first), /User annotation/); assert.match(contents.get(first), /# Renamed/);
});
test('preview migration moves owned notes into a topic and unknown orphans into Inbox', async () => {
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
test('preview migration rolls back all completed moves when a later move fails', async () => {
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
test('external rename reconciliation only follows a unique matching node-id', async () => {
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
test('new topics contain Map, Notes, Unassigned and Archive', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Topic A');
  assert.equal(mapPath, 'Agent Workspace/Topics/Topic A/Map.md');
  for (const name of ['Notes', 'Unassigned', 'Archive']) assert.ok(app.vault.getAbstractFileByPath(`Agent Workspace/Topics/Topic A/${name}`) instanceof TFolder);
});
test('unassigned and archived notes keep topic ownership but leave the map', async () => {
  const { repo, contents } = fixture(), mapPath = await repo.createMap('Lifecycle'), mapDoc = await repo.readMap(mapPath);
  const n = await repo.createNote('Knowledge', 'a', mapDoc, mapPath, 'workspace'); mapDoc.nodes.push(n); await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  const unassigned = await repo.moveUnique(n.path, repo.topicFolder(mapPath, 'Unassigned')); await repo.setLifecycle(unassigned, mapDoc.id, '', 'unassigned'); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  let note = await repo.readNote(unassigned); assert.equal(note.topicId, mapDoc.id); assert.equal(note.mapId, ''); assert.equal(note.topicState, 'unassigned'); assert.match(contents.get(unassigned), /狀態：未歸類/);
  const archived = await repo.moveUnique(unassigned, repo.topicFolder(mapPath, 'Archive')); await repo.setLifecycle(archived, mapDoc.id, '', 'archived'); await repo.rebuildDerivedData();
  note = await repo.readNote(archived); assert.equal(note.topicState, 'archived'); assert.match(contents.get(archived), /狀態：已封存/);
});
test('a missing Map can be rebuilt from topic Notes as root nodes', async () => {
  const { repo } = fixture(), root = 'Agent Workspace/Topics/Broken', placeholder = { id: 'stable-topic', title: 'Broken', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(root); await repo.createNote('Recovered', 'a', placeholder, `${root}/Map.md`, 'workspace');
  const path = await repo.rebuildMissingMap(root), rebuilt = await repo.readMap(path); assert.equal(rebuilt.id, 'stable-topic'); assert.equal(rebuilt.nodes.length, 1); assert.equal(rebuilt.nodes[0].parentId, null);
});
test('replacing AI synthesis preserves 預覽', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Synthesis');
  await repo.updateNote(n.path, { detail: 'Old synthesis', preview: 'Keep this manually written note' });
  await repo.updateNote(n.path, { detail: 'New synthesis', prompt: '' });
  const result = await repo.readNote(n.path); assert.equal(result.detail, 'New synthesis'); assert.equal(result.preview, 'Keep this manually written note'); assert.equal(result.prompt, '');
});
test('text undo uses field patches and preserves AI details arriving in between', async () => {
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
});
test('AI visual references render as image cards', () => {
  const { visualReferencesMarkdown } = load('main.ts', { obsidian });
  const markdown = visualReferencesMarkdown([{ title: 'Navy + Beige', imageUrl: 'https://example.com/outfit.jpg', sourceUrl: 'https://example.com/page', description: '乾淨休閒穿搭', palette: ['navy', 'white', 'beige'], formula: '深色外套 + 白色內搭 + 淺色褲' }]);
  assert.match(markdown, /!\[Navy \+ Beige\]\(https:\/\/example.com\/outfit.jpg\)/);
  assert.match(markdown, /來源：https:\/\/example.com\/page/);
  assert.match(markdown, /配色：navy \/ white \/ beige/);
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
test('new notes include AI rules but omit working findings; clearing legacy findings removes the section', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  assert.match(contents.get(n.path), /## Rules[\s\S]*## 預覽[\s\S]*## Detail/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  await repo.updateNote(n.path, { newFindings: 'Legacy finding' });
  assert.match(contents.get(n.path), /## Working Findings\n\nLegacy finding/);
  await repo.updateNote(n.path, { newFindings: '' });
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal((await repo.readNote(n.path)).newFindings, '');
});
test('a successful AI task immediately updates summary and MD detail', async () => {
  const { repo, app, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  await repo.updateNote(n.path, { prompt: 'Research this', rules: 'Use a comparison table.', detail: 'Existing detail', newFindings: 'Legacy finding', sourcePaths: ['Other.md'] });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: async context => { assert.equal(context.mode, 'task'); assert.equal(context.rules, 'Use a comparison table.'); assert.equal(context.detail, 'Existing detail'); assert.equal(context.workingFindings, 'Legacy finding'); assert.equal(context.sourceContext, ''); return { summary: 'Direct summary', detail: '### 核心結論\n\nDirect detail\n\n### 關鍵知識\n\nExisting detail; Legacy finding\n\n### 證據與來源\n\nSource\n\n### 取捨與限制\n\nNone\n\n### 待確認事項\n\nNone\n\n### 更新紀錄\n\n- Updated', suggestions: [] }; },
    rebuildDerivedData: async () => {}, mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20));
  const updated = await repo.readNote(n.path);
  assert.equal(updated.summary, 'Direct summary');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.newFindings, '');
  assert.match(updated.detail, /Direct detail/);
  assert.match(updated.detail, /Legacy finding/);
  assert.match(updated.detail, /Existing detail/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
});
test('cancelling a node task keeps its earlier Markdown and status', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Cancel');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Keep this' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
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
test('provider failure keeps its original AI log stage during node error writeback', async () => {
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
test('proposal persistence failure does not erase completed shallow research', async () => {
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
test('a completed but stale answer cannot overwrite an edited note', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Stale');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Original' });
  let finish; const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
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
test('new child topics inherit the parent AI rules once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  await repo.updateNote(parent.path, { rules: 'Use official sources and tables.', reasoning: 'high' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.addNode(parent);
  const child = (await repo.readMap(mapPath)).nodes.at(-1);
  assert.equal((await repo.readNote(child.path)).rules, 'Use official sources and tables.');
  assert.equal((await repo.readNote(child.path)).reasoning, 'high');
});
test('selected subtopics move together and copied notes keep their content with new identities', async () => {
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
test('copying a legacy note without a title field keeps its filename as the copy title', async () => {
  const { repo, app } = fixture();
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create('Agent Workspace/Topics/map-a/Notes/budget.md', '---\nagent-map-node: true\nnode-id: original\ntopic-id: map-a\n---\n# budget\n\nOriginal content\n');
  const copy = await repo.duplicateNote('Agent Workspace/Topics/map-a/Notes/budget.md', mapDoc, mapPath);
  assert.equal((await repo.readNote(copy.path)).title, 'budget 副本');
  assert.match(await app.vault.read(app.vault.getAbstractFileByPath(copy.path)), /^---[\s\S]*# budget 副本/m);
});
test('failed batch copy parks created notes and leaves the map unchanged', async () => {
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
test('failed map save during copy parks the duplicate without changing the map', async () => {
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
test('removing selected subtopic branches parks notes and can be undone', async () => {
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
test('failed batch removal restores map and active note ownership', async () => {
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
test('failed rebuild after batch removal also restores map and notes', async () => {
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
test('confirmed child batches rebuild derived data only once', async () => {
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
test('two-level child batches attach grandchildren and still rebuild once', async () => {
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
test('orphan grandchild proposals fail instead of silently disappearing', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await assert.rejects(view.createChildBatch(parent, [{ title: 'Orphan', task: '', contribution: '', parentTitle: 'Missing' }]), /母議題/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
test('duplicate first-level proposal names cannot misplace grandchildren', async () => {
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
  ]), /名稱不能重複/);
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
  assert.match(notices[0], /名稱重複/);
  assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  assert.equal(plugin.pendingResearchOptions.has('parent.md'), false);
});
test('confirmed two-level decomposition starts shallow research for every created topic', async () => {
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
  ], { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: true });
  const saved = await repo.readMap(mapPath);
  assert.equal(JSON.stringify(researched), JSON.stringify(saved.nodes.slice(1).map(node => node.id)));
  for (const node of saved.nodes.slice(1)) {
    const note = await repo.readNote(node.path);
    assert.equal(note.researchDepth, 'fast'); assert.equal(note.researchMode, 'research'); assert.equal(note.visualMode, 'off');
  }
});
test('guided expansion can research a confirmed first-level child', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; view.runAgent = async child => { researched.push(child.id); await repo.updateNote(child.path, { status: 'running' }); };
  await view.createChildBatch(parent, [{ title: 'Research me', task: 'Find evidence', contribution: '', parentTitle: '' }], { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: false, shallowResearch: true });
  assert.equal(researched.length, 1);
  assert.equal((await repo.readNote(view.map.nodes.at(-1).path)).researchMode, 'research');
});
test('one shallow-research startup failure marks that child and does not strand later children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, recordFailure: (context, error) => failures.push(`${context}: ${error.message}`) };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async child => { if ((await repo.readNote(child.path)).title === 'First') throw new Error('startup failed'); await repo.updateNote(child.path, { status: 'running' }); };
  await view.createChildBatch(parent, [{ title: 'First', task: 'Research first', contribution: '' }, { title: 'Second', task: 'Research second', contribution: '' }], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], shallowResearch: true });
  const saved = await repo.readMap(mapPath);
  assert.equal((await repo.readNote(saved.nodes[1].path)).status, 'error');
  assert.equal((await repo.readNote(saved.nodes[2].path)).status, 'running');
  assert.match(failures[0], /startup failed/);
});
test('quick exploration creates two levels directly and leaves them unresearched', async () => {
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
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: true, shallowResearch: false, layers: 2, firstLayerCount: 2, childrenPerParent: 1 }, '', () => { reviewed++; }, message => assert.fail(message), true, () => { completed++; });
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 5); assert.equal(saved.nodes[3].parentId, saved.nodes[1].id); assert.equal(saved.nodes[4].parentId, saved.nodes[2].id);
  assert.equal(reviewed, 0); assert.equal(completed, 1); assert.equal(researched, 0);
  for (const child of saved.nodes.slice(1)) assert.equal((await repo.readNote(child.path)).status, 'idea');
});
test('quick exploration gives every parent two children across three levels and starts optional research', async () => {
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
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: true, shallowResearch: true, layers: 3, firstLayerCount: 2, childrenPerParent: 2 }, '', () => assert.fail('quick map should not show review'), message => assert.fail(message), true);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 15); assert.equal(researched, 14);
  const byTitle = new Map(); for (const item of saved.nodes.slice(1)) byTitle.set((await repo.readNote(item.path)).title, item);
  for (const item of suggestions) assert.equal(byTitle.get(item.title).parentId, item.parentTitle ? byTitle.get(item.parentTitle).id : parent.id);
});
test('quick exploration rejects an uneven branch before creating any topic', async () => {
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
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: true, layers: 2, firstLayerCount: 2, childrenPerParent: 1 }, '', () => assert.fail('uneven map accepted'), message => { failure = message; }, true);
  assert.match(failure, /每層數量與母子關係/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
test('quick AI wait leaves map mutations free and uses the latest parent position', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve();
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandPending: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 };
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
test('quick map discards a delayed answer when its parent has been removed', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve(), error = '';
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandPending: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, failure) => failure.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 };
  const job = view.startQuickExpansion(parent, options, '', message => { error = message; }, () => assert.fail('stale result created nodes'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await plugin.mutate(() => view.mapChange(map => { map.nodes = []; }));
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Stale child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  assert.match(error, /母議題.*變更/); assert.equal((await repo.readMap(mapPath)).nodes.length, 0);
  assert.equal(plugin.quickExpandPending.size, 0); assert.ok(plugin.quickExpandFailures.has(parent.path));
});
test('pending proposals use this run\'s shallow research choice and serialize creation', async () => {
  const suggestions = [{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }];
  const plugin = { pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map(), mutate: async work => { queued++; return work(); } };
  let queued = 0, create, used;
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.createChildBatch = async (_parent, _items, options) => { used = options; };
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [], multiLayer: false, shallowResearch: true };
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, true, options, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
  assert.equal(plugin.pendingResearchOptions.get('parent.md'), options);
  await create(suggestions);
  assert.equal(queued, 1); assert.equal(used, options); assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  plugin.pendingSuggestions.set('parent.md', suggestions); plugin.pendingResearchOptions.set('parent.md', options);
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, true, { ...options, shallowResearch: false }, '', () => {}, message => assert.fail(message));
  assert.equal(plugin.pendingResearchOptions.has('parent.md'), false);
});
test('two views cannot create the same pending proposals twice', async () => {
  const suggestions = [{ title: 'Child', task: 'Research', contribution: '', parentTitle: '' }];
  let tail = Promise.resolve(), created = 0;
  const plugin = { pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map(), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const first = new VisualAgentMapView({ app: {} }, plugin), second = new VisualAgentMapView({ app: {} }, plugin);
  for (const view of [first, second]) view.createChildBatch = async () => { created++; };
  let acceptFirst, acceptSecond;
  await first.proposeChildren({ id: 'parent', path: 'parent.md' }, true, undefined, '', (_items, accept) => { acceptFirst = accept; });
  await second.proposeChildren({ id: 'parent', path: 'parent.md' }, true, undefined, '', (_items, accept) => { acceptSecond = accept; });
  const outcomes = await Promise.allSettled([acceptFirst(suggestions), acceptSecond(suggestions)]);
  assert.equal(created, 1);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected']);
  assert.match(outcomes[1].reason.message, /展開建議已變更/);
});
test('partial child creation invalidates the proposal so retry cannot duplicate nodes', async () => {
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
  await assert.rejects(create(suggestions), /部分子議題已建立/);
  assert.equal(queued, 1); assert.equal(plugin.pendingSuggestions.has(parent.path), false);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
});
test('synthesis directions and draft are separate steps; only confirmed draft updates the parent', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'model-a', mapDoc, mapPath, 'workspace'); child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] } : { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.sourceDigest = async () => 'Child context'; view.selectedSourceContext = async () => ''; view.ancestorContext = async () => '';
  let choose, save;
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [] };
  await view.proposeIntegrationDirections(parent, options, (items, draft) => { assert.equal(items[0].title, 'Common ground'); choose = draft; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
  assert.equal(contexts.length, 1); assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft summary');
  await choose('Find shared constraints');
  assert.equal(contexts[1].task, 'Find shared constraints'); assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft summary');
  await save('Edited summary', 'Edited detail');
  const saved = await repo.readNote(parent.path);
  assert.equal(saved.summary, 'Edited summary'); assert.match(saved.detail, /Edited detail/);
});
test('synthesis can use selected notes when a topic has no children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const contexts = [];
  const plugin = { repo, running: new Set(), mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', suggestions: [{ title: 'Shared view', task: 'Combine notes', contribution: '' }] } : { summary: 'Combined', detail: 'Combined detail', suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const empty = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', currentVault: false, folderFiles: [], individualFiles: [] };
  let failure = '';
  await view.proposeIntegrationDirections(parent, empty, () => assert.fail('missing sources'), () => {}, message => { failure = message; });
  assert.match(failure, /選擇其他筆記來源/);
  assert.equal(contexts.length, 0);
  await view.proposeIntegrationDirections(parent, { ...empty, currentVault: true }, () => assert.fail('the current topic is not another note'), () => {}, message => { failure = message; });
  assert.match(failure, /沒有可整合的 Markdown 內容/);
  assert.equal(contexts.length, 0);
  await view.proposeIntegrationDirections(parent, { ...empty, individualFiles: [{ name: 'empty.md', slice: () => ({ text: async () => '' }) }] }, () => assert.fail('empty source'), () => {}, message => { failure = message; });
  assert.match(failure, /沒有可整合的 Markdown 內容/);
  assert.equal(contexts.length, 0);
  let draft, save;
  view.selectedSourceContext = async () => 'Selected note content';
  await view.proposeIntegrationDirections(parent, { ...empty, individualFiles: [{ name: 'selected.md' }] }, (_items, next) => { draft = next; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
  assert.equal(contexts[0].sourceContext, 'Selected note content');
  await draft('Combine notes');
  assert.equal(contexts[1].sourceContext, 'Selected note content');
  await save('Combined', 'Combined detail');
  assert.equal((await repo.readNote(parent.path)).summary, 'Combined');
});
test('decomposition keeps only 3 to 7 proposals and does not write nodes before confirmation', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }, { title: 'Only two', task: '', contribution: '' }] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {};
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.has(parent.path), false);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 8 }, (_, index) => ({ title: `Suggestion ${index + 1}`, task: '', contribution: '' })) });
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 7);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
test('decomposition receives existing child topics to avoid duplicate proposals', async () => {
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
  assert.match(captured.task, /現有直屬子議題/);
  assert.match(captured.task, /交通/);
  assert.match(captured.task, /不要為湊數而拆解/);
  assert.equal(captured.researchMode, 'research');
  assert.equal(captured.sourceContext, '');
  assert.equal(plugin.pendingSuggestions.size, 0);
});
test('duplicating the built-in sample creates an independent editable map with new identities', async () => {
  const { repo, app } = fixture();
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings = { ...DEFAULT_SETTINGS }; plugin.saveSettings = async () => {};
  const mapPath = await plugin.duplicateBuiltInSample();
  const sample = await repo.readMap(mapPath);
  assert.match(mapPath, /Agent Workspace\/Topics\/範例：台灣旅行規劃\/Map\.md$/);
  assert.equal(sample.nodes.length, 12);
  assert.equal(sample.nodes.filter(node => node.parentId === null).length, 2);
  assert.notEqual(sample.id, 'builtin-taiwan-travel');
  assert.ok(sample.nodes.every(node => !['explore', 'constraints', 'transport', 'food', 'nature', 'journey'].includes(node.id)));
  const synthesis = await repo.readNote(sample.nodes.find(node => node.x === 1050).path);
  assert.equal(synthesis.status, 'completed'); assert.equal(synthesis.sourcePaths.length, 6);
  assert.ok(synthesis.sourcePaths.every(source => source.startsWith('Agent Workspace/Topics/')));
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics/範例：台灣旅行規劃/Attachments/east-coast-landscape.webp'));
});
test('onboarding uses an embedded sample and explicit workspace repair without a dismiss-and-create-nothing path', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(source, /class FirstUseModal|id: "open-onboarding"|稍後再說/);
  assert.match(source, /id: "open-built-in-sample"/);
  assert.match(source, /id: "repair-workspace"/);
  assert.match(source, /this\.workspaceRecoveryCandidates = await this\.repo\.workspaceCandidates\(\)/);
  assert.match(source, /if \(!this\.workspaceRecoveryCandidates\.length\) \{ await this\.repo\.ensureWorkspace\(\)/);
  assert.match(source, /id: "reconnect-workspace"/);
  assert.match(source, /vam-sample-start/);
  assert.match(source, /Codex 已就緒。複製範例或建立空白心智圖/);
  assert.match(source, /this\.plugin\.settings\.models\.trim\(\)/);
  assert.match(source, /else if \(this\.map\)/);
});
test('the first real AI task requires a one-time Codex allowance acknowledgement', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(source, /class CodexUsageModal/);
  assert.match(source, /使用該帳號的 Codex 使用額度/);
  assert.match(source, /if \(!confirmed\) return;/);
  assert.match(source, /this\.settings\.codexUsageNoticeSeen = true/);
  assert.match(source, /if \(!needsUsage \|\| this\.plugin\.settings\.codexUsageNoticeSeen\) \{ await start\(\); return; \}/);
  assert.match(source, /this\.plugin\.settings\.codexUsageNoticeSeen = true; await this\.plugin\.saveSettings\(\)/);
});
test('Obsidian 1.13 declarative settings expose workspace recovery and App Server diagnostics', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const definitions = source.slice(source.indexOf('getSettingDefinitions()'), source.indexOf('async setControlValue'));
  assert.match(definitions, /Workspace 位置/);
  assert.match(definitions, /修復 Agent Workspace/);
  assert.match(definitions, /AI 推理等級/);
  assert.match(definitions, /cliReasoning/);
  assert.match(definitions, /low: t\("低 \(Low\)"\)/);
  assert.match(definitions, /medium: t\("中 \(Medium\)"\)/);
  assert.match(definitions, /high: t\("高 \(High\)"\)/);
  assert.match(definitions, /重新整理 VAM 資料/);
  assert.match(definitions, /完整重建/);
  assert.match(definitions, /找回既有 Workspace/);
  assert.match(definitions, /Codex App Server 狀態/);
  assert.match(definitions, /重新檢查/);
  assert.match(definitions, /安裝說明/);
  assert.match(source, /this\.settingTab\?\.update\(\)/);
  assert.match(source, /setAttr\("aria-label", t\("推理等級"\)\)/);
  assert.match(source, /save\(\{ reasoning: normalizeReasoningLevel\(reasoning\.value\) \}\)/);
});
test('full rebuild refreshes derived data and open views', async () => {
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
  assert.match(source, /ChatGPT Free 也可使用/);
  assert.match(source, /不需要 API key/);
  assert.match(source, /獨立版 Codex CLI 不需要 npm/);
  assert.match(source, /在 Terminal 執行 codex/);
  assert.match(source, /if \(showGuide\) this\.openCodexSetupGuide\(\)/);
  assert.match(source, /this\.recheckCodex\(false\)/);
});
test('generated child filenames are migrated to their topic titles and maps stay linked', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Filename migration'), mapDoc = await repo.readMap(mapPath);
  const child = await repo.createNote('新的子議題', 'a', mapDoc, mapPath, 'workspace');
  await repo.updateNote(child.path, { title: '清楚的子議題名稱' }); mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const count = await repo.normalizeGeneratedNoteFilenames(), updated = await repo.readMap(mapPath);
  assert.equal(count, 1); assert.match(updated.nodes[0].path, /清楚的子議題名稱\.md$/); assert.ok(app.vault.getAbstractFileByPath(updated.nodes[0].path));
});
test('source digest carries summaries and working findings into extracted roots', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'a'), second = await topicNote(repo, 'Recipe B', 'a');
  await repo.updateNote(first.path, { summary: 'Use more onion', newFindings: '### 暫存結論\n\nOnion adds sweetness.' });
  await repo.updateNote(second.path, { summary: 'Toast the buns' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const digest = await view.sourceDigest([first, second]);
  assert.match(digest, /\[\[Agent Workspace\/Topics\/map-a\/Notes\/Recipe A\]\]/);
  assert.match(digest, /Use more onion/);
  assert.match(digest, /Onion adds sweetness/);
  assert.match(digest, /Toast the buns/);
});
test('legacy integrated source links resolve from short Obsidian links', async () => {
  const { repo, app } = fixture(), source = await topicNote(repo, 'Recipe A', 'a'), root = await topicNote(repo, 'Integrated Burger', 'a');
  await repo.updateNote(root.path, { detail: '### 整合來源（保存內容）\n\n- [[Recipe A]]' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  assert.deepEqual(plain(view.referenceSourcePaths(await repo.readNote(root.path), root.path)), [source.path]);
});
test('creating an integrated topic runs AI with full sources and keeps clickable source paths', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  await repo.updateNote(first.path, { summary: 'Saved onion note', newFindings: 'Caramelize slowly.' });
  await repo.updateNote(second.path, { summary: 'Saved bun note' });
  first.x = 80; first.y = 80; second.x = 420; second.y = 220;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, askModel: async context => {
    assert.equal(context.mode, 'synthesize'); assert.match(context.sourceContext, /Saved onion note/); assert.match(context.sourceContext, /Caramelize slowly/); assert.match(context.sourceContext, /Saved bun note/);
    return { summary: 'Integrated answer', detail: 'Integrated detail', suggestions: [] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.createIntegratedNode('Personal Burger', [first, second], 'Find the best approach', 'Use tables');
  const savedMap = await repo.readMap(mapPath); assert.equal(savedMap.nodes.length, 3);
  const integrated = await repo.readNote(savedMap.nodes[2].path);
  assert.match(integrated.detail, /### 核心結論/);
  assert.deepEqual(integrated.sourcePaths, [first.path, second.path]);
  assert.equal(integrated.rules, 'Use tables');
  assert.equal(integrated.status, 'completed');
});
test('failed multi-select integration creates no empty root or note', async () => {
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
test('topic notes hide properties without removing existing css classes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Styled', 'a');
  let content = contents.get(n.path); assert.match(content, /visual-agent-map-node/);
  content = content.replace('cssclasses: ["visual-agent-map-node"]', 'cssclasses: ["user-class"]'); contents.set(n.path, content);
  await repo.ensureNodePresentation(); content = contents.get(n.path); assert.match(content, /user-class/); assert.match(content, /visual-agent-map-node/);
});
test('map structural undo restores deleted branch; redo removes it again', async () => {
  const { repo, app } = fixture(); const file = await repo.createMap('Undo', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(m => { m.nodes = core.removeNodes(m.nodes, 'a', true); }); assert.equal((await repo.readMap(file)).nodes.length, 1);
  await view.travel(false); assert.equal((await repo.readMap(file)).nodes.length, 4);
  await view.travel(true); assert.equal((await repo.readMap(file)).nodes.length, 1);
});
test('layout-only map changes and AI note results do not rebuild derived data', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Layout', tree()); let rebuilds = 0;
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => { rebuilds++; } });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(map => { map.nodes[0].x = 120; map.viewport.zoom = 1.2; }); assert.equal(rebuilds, 0);
  await view.mapChange(map => { map.nodes[0].parentId = 'd'; }); assert.equal(rebuilds, 1);
});
test('full auto layout can be undone without changing parent links', async () => {
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
test('Codex App Server uses model/list, selected reasoning and fresh ephemeral threads', async () => {
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
      turnCount++; efforts.push(message.params.effort); assert.ok(message.params.outputSchema.properties.summary); assert.match(message.params.input[0].text, /目前議題/);
      assert.deepEqual(plain(message.params.sandboxPolicy), { type: 'readOnly', networkAccess: false });
      const threadId = message.params.threadId, summary = threadId === 'thread-1' ? 'first' : 'second';
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { turn: { id: `turn-${turnCount}` } } })}\n`));
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
test('AI exchange logging captures the sent payload, raw reply and parse failure', async () => {
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
test('turning exchange logging off during a task stops recording its reply', async () => {
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
test('local Codex runtime disables web search for its process', async () => {
  const { EventEmitter } = require('node:events'); let args;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (_path, invocation) => { args = invocation; return child; } } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', webSearchDisabled: true });
  await runtime.start(); assert.deepEqual(plain(args), ['--config', 'web_search="disabled"', 'app-server']); runtime.stop();
});
test('research budget sends one stop-search steer after three searches', async () => {
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
    assert.match(sent.find(message => message.method === 'turn/steer').params.input[0].text, /停止搜尋/);
  } finally { runtime.stop(); }
});
test('cancelling a Codex turn sends interrupt and rejects the result', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
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
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const controller = new AbortController();
  try {
    const pending = runtime.runTask('research', 'model', 'low', {}, { signal: controller.signal });
    while (!sent.some(message => message.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
  } finally { runtime.stop(); }
});
test('Codex App Server declines unsupported interaction requests instead of hanging', async () => {
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
test('Codex App Server ignores stale child events after a clean restart', async () => {
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
test('legacy Claude models fail clearly without starting a provider', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  await assert.rejects(plugin.askModel({ title: 'Current topic', summary: '', rules: '', detail: '', task: 'task', ancestors: '', mode: 'task' }, 'claude:sonnet'), /Claude Code 已不再支援/);
});

test('external map conflict UI retains file, screen, and manual merge choices', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  for (const modal of ['class MapConflictModal']) {
    const start = source.indexOf(modal), next = source.indexOf('\nclass ', start + modal.length);
    const body = source.slice(start, next < 0 ? source.length : next);
    assert.match(body, /使用檔案內容/); assert.match(body, /保留畫面內容/); assert.match(body, /儲存合併內容/);
  }
});

test('VAM notes hide properties in reading and live preview without removing frontmatter', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(styles, /\.markdown-preview-view\.visual-agent-map-node \.metadata-container/);
  assert.match(styles, /body \.workspace-leaf-content\.vam-topic-markdown \.markdown-source-view\.mod-cm6 \.metadata-container \{ display: none; \}/);
  assert.doesNotMatch(styles, /\.markdown-preview-view\.vam-topic-markdown \.metadata-container/);
  assert.doesNotMatch(styles, /!important/);
});

test('legacy User Notes move to preview without losing either section or duplicating on save', async () => {
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

test('first AI answer seeds summary and image in preview, later answers preserve it including an explicit clear', async () => {
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
test('AI answer cannot replace preview edited while task was running', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Manual preview');
  await repo.updateNote(n.path, { preview: '使用者的文字' });
  await repo.updateNote(n.path, { summary: 'AI 結論', detail: '![圖](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '使用者的文字');
});
test('images follow related text and inline images are not duplicated', async () => {
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

test('references in synthesized notes remain clickable after rebuilding, updates and source renames', async () => {
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
test('dragging synthesized roots persists coordinates and removal preserves notes with undo', async () => {
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
test('UI language switch translates labels and placeholders without changing knowledge headings', () => {
  const {t,setUiLanguage}=load('i18n.ts');setUiLanguage('en');assert.equal(t('選擇下一步'),'Choose next step');assert.equal(t('展開 {0}',3),'Expand 3');assert.equal(t('核心結論'),'核心結論');setUiLanguage('zh-TW');assert.equal(t('選擇下一步'),'選擇下一步');
});
