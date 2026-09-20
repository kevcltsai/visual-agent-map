const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, windowValues = {}) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console, crypto: require('node:crypto').webcrypto, process, window: { setTimeout, clearTimeout, ...windowValues } });
  return module.exports;
}
const core = load('map-model.ts');
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
test('debug log command opens the custom modal and exposes copy and clear actions', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const modal = fs.readFileSync(path.join(root, 'ui/modals/debug-log-modal.ts'), 'utf8');
  assert.match(source, /id: "open-debug-log"/); assert.match(source, /new DebugLogModal\(this\.app, this\.logs\)\.open\(\)/);
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
const { Repository, DEFAULT_SETTINGS } = load('repository.ts', { obsidian });
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
  await repo.updateNote(n.path, { title: '修改標題', model: 'model-b', prompt: 'A task with $&' });
  const result = await repo.readNote(n.path);
  assert.equal(result.detail, '## Nested heading\n\nAI result with $& and ```code```'); assert.equal(result.prompt, 'A task with $&'); assert.equal(result.model, 'model-b'); assert.equal(result.status, 'completed');
  assert.equal(result.newFindings, 'Fresh research');
  assert.match(contents.get(n.path), /## Working Findings\n\nFresh research/);
  assert.match(contents.get(n.path), /custom: "retain me"/);
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
  await repo.updateNote(n.path, { prompt: 'Research this', rules: 'Use a comparison table.', detail: 'Existing detail', newFindings: 'Legacy finding' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(),
    askModel: async context => { assert.equal(context.mode, 'task'); assert.equal(context.rules, 'Use a comparison table.'); assert.equal(context.detail, 'Existing detail'); assert.equal(context.workingFindings, 'Legacy finding'); return { summary: 'Direct summary', detail: '### 核心結論\n\nDirect detail\n\n### 關鍵知識\n\nExisting detail; Legacy finding\n\n### 證據與來源\n\nSource\n\n### 取捨與限制\n\nNone\n\n### 待確認事項\n\nNone\n\n### 更新紀錄\n\n- Updated', suggestions: [] }; },
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
test('new child topics inherit the parent AI rules once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  await repo.updateNote(parent.path, { rules: 'Use official sources and tables.' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.addNode(parent);
  const child = (await repo.readMap(mapPath)).nodes.at(-1);
  assert.equal((await repo.readNote(child.path)).rules, 'Use official sources and tables.');
});
test('decomposition keeps only 3 to 7 proposals and does not write nodes before confirmation', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }, { title: 'Only two', task: '', contribution: '' }] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.has(parent.path), false);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 8 }, (_, index) => ({ title: `Suggestion ${index + 1}`, task: '', contribution: '' })) });
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 7);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
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
  assert.ok((source.match(/confirmCodexUsage\(/g) || []).length >= 5);
});
test('Obsidian 1.13 declarative settings expose workspace recovery and App Server diagnostics', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const definitions = source.slice(source.indexOf('getSettingDefinitions()'), source.indexOf('async setControlValue'));
  assert.match(definitions, /Workspace 位置/);
  assert.match(definitions, /修復 Agent Workspace/);
  assert.match(definitions, /找回既有 Workspace/);
  assert.match(definitions, /Codex App Server 狀態/);
  assert.match(definitions, /重新檢查/);
  assert.match(definitions, /安裝說明/);
  assert.match(source, /this\.settingTab\?\.update\(\)/);
});
test('missing Codex opens an in-product setup guide with official installation and sign-in steps', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(source, /class CodexSetupModal/);
  assert.match(source, /https:\/\/developers\.openai\.com\/codex\/cli\//);
  assert.match(source, /ChatGPT Free 也可使用/);
  assert.match(source, /不需要 API key/);
  assert.match(source, /獨立版 Codex CLI 不需要 npm/);
  assert.match(source, /在 Terminal 執行 codex/);
  assert.match(source, /if \(!diagnostic\.installed\) \{ this\.openCodexSetupGuide\(\); return; \}/);
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
test('weak extraction keeps links but resolves latest source context for AI', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'a'), second = await topicNote(repo, 'Recipe B', 'a');
  await repo.updateNote(first.path, { summary: 'Original onion note' });
  await repo.updateNote(second.path, { summary: 'Original bun note' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const weak = await view.sourceDigest([first, second], 'weak');
  assert.match(weak, /\[\[Agent Workspace\/Topics\/map-a\/Notes\/Recipe A\]\]/);
  assert.doesNotMatch(weak, /Original onion note/);
  const root = await topicNote(repo, 'Personal Burger', 'a');
  await repo.updateNote(root.path, { detail: `### 萃取來源（弱連結）\n\n${weak}` });
  await repo.updateNote(first.path, { summary: 'Latest onion note', newFindings: '### 暫存結論\n\nUse caramelized onion.' });
  const context = await view.extractedSourceContext(await repo.readNote(root.path));
  assert.match(context, /Latest onion note/);
  assert.match(context, /Use caramelized onion/);
  assert.match(context, /Original bun note/);
});
test('strong extraction keeps its saved source context after the task prompt changes', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Personal Burger', 'a');
  await repo.updateNote(root.path, { detail: '### 萃取來源（強連結備份）\n\n- [[Recipe A]]\n  - 目前理解：Saved onion note', prompt: 'A later generic research task' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const context = await view.extractedSourceContext(await repo.readNote(root.path));
  assert.match(context, /Saved onion note/);
  assert.doesNotMatch(context, /later generic research task/);
});
test('integrated topics keep their saved source context without a source-mode choice', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Integrated Burger', 'a');
  await repo.updateNote(root.path, { detail: '### 整合來源（保存內容）\n\n- [[Recipe A]]\n  - 目前理解：Saved bun note', prompt: 'Create a formal conclusion' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const context = await view.extractedSourceContext(await repo.readNote(root.path));
  assert.match(context, /Saved bun note/);
  assert.doesNotMatch(context, /Create a formal conclusion/);
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
test('Codex App Server uses model/list and cleans up fresh ephemeral threads for concurrent tasks', async () => {
  const { EventEmitter } = require('node:events'); let command, args, turnCount = 0, threadCount = 0, unsubscribeCount = 0;
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
      turnCount++; assert.ok(message.params.outputSchema.properties.summary); assert.match(message.params.input[0].text, /目前議題/);
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
  const [result, second] = await Promise.all([
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'task' }, 'visible-model'),
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'task' }, 'visible-model')
  ]);
  assert.equal(command, DEFAULT_SETTINGS.codexPath); assert.deepEqual(Array.from(args), ['app-server']);
  assert.equal(turnCount, 2); assert.equal(threadCount, 2);
  assert.equal(unsubscribeCount, 2);
  assert.equal(plugin.settings.models, 'visible-model');
  assert.equal(result.summary, 'first');
  assert.equal(second.summary, 'second');
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

test('external conflict UI retains file, screen, and manual merge choices', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  for (const modal of ['class ConflictModal', 'class MapConflictModal']) {
    const start = source.indexOf(modal), next = source.indexOf('\nclass ', start + modal.length);
    const body = source.slice(start, next < 0 ? source.length : next);
    assert.match(body, /使用檔案內容/); assert.match(body, /保留畫面內容/); assert.match(body, /儲存合併內容/);
  }
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
