// UI audit bugfix-2 P3: error messages and done notices. Each message says what happened and what to do, in the
// interface language, and no internal code, English parser text or absolute path reaches the person.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('./support.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns, load, plain, root } = S;

// Loads a module in one bundle with the interface-language setter (the bundle has its own copy of i18n), so the
// language set here is the one that module's t() reads. Each call is a fresh vm context, like the other suites.
let langEntryDir;
const langEntries = new Map();
function languageEntry(modulePath) {
  if (langEntries.has(modulePath)) return langEntries.get(modulePath);
  langEntryDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'vam-p3-entry-'));
  process.on('exit', () => fs.rmSync(langEntryDir, { recursive: true, force: true }));
  const file = path.join(langEntryDir, `entry-${langEntries.size}.ts`);
  fs.writeFileSync(file, `import * as mod from ${JSON.stringify(path.join(root, modulePath))};\nexport { mod };\nexport { setUiLanguage } from ${JSON.stringify(path.join(root, 'i18n'))};\n`);
  langEntries.set(modulePath, file);
  return file;
}
function loadIn(modulePath, language, overrides) {
  const { mod, setUiLanguage } = load(path.relative(root, languageEntry(modulePath)), overrides);
  setUiLanguage(language);
  return mod;
}

// The three interface language tables, to check every language's text (not only the one the test runs in).
const TABLES = { en: load('i18n/en.ts', { obsidian }).en, 'zh-TW': load('i18n/zh-TW.ts', { obsidian }).zhTW, 'zh-CN': load('i18n/zh-CN.ts', { obsidian }).zhCN };
const notesOf = [];
const NoticeStub = class { constructor(message) { notesOf.push(String(message)); } };
const takeNotices = () => notesOf.splice(0);

// Two generated subtopic notes ("新的子議題") whose titles differ from their file names, in one map.
async function renameHarness(titles = ['Alpha', 'Beta']) {
  const { repo, app, files } = fixture('zh-TW');
  const mapPath = await repo.createMap('Rename map'), mapDoc = await repo.readMap(mapPath);
  for (const title of titles) {
    const child = await repo.createNote('新的子議題', 'a', mapDoc, mapPath, 'workspace');
    await repo.updateNote(child.path, { title });
    mapDoc.nodes.push(child);
  }
  await repo.saveMap(mapPath, mapDoc);
  return { repo, app, files, mapPath };
}

test('P3 filenames: one note that cannot be renamed is counted as failed and the others still go', async () => {
  const { repo, mapPath } = await renameHarness(['Alpha', 'Beta']);
  const real = repo.renameNote.bind(repo);
  repo.renameNote = async (path, title, exact) => {
    if (path.endsWith('新的子議題.md') && title === 'Alpha') throw new Error('EACCES: permission denied, rename');
    return real(path, title, exact);
  };
  const result = await repo.normalizeGeneratedNoteFilenames();
  assert.deepEqual(plain(result), { renamed: 1, failed: 1 }, 'one renamed, one failed; the failure does not stop the queue');
  const map = await repo.readMap(mapPath);
  assert.ok(map.nodes.some(node => /Beta\.md$/.test(node.path)), 'the renameable note was renamed and the map points at it');
  assert.ok(map.nodes.some(node => /新的子議題\.md$/.test(node.path)), 'the failing note keeps its old path in the map');
});

test('P3 filenames counter-example: a legal rename of every note reports all renamed and none failed', async () => {
  const { repo } = await renameHarness(['Alpha', 'Beta']);
  assert.deepEqual(plain(await repo.normalizeGeneratedNoteFilenames()), { renamed: 2, failed: 0 });
  assert.deepEqual(plain(await repo.normalizeGeneratedNoteFilenames()), { renamed: 0, failed: 0 }, 'a second run has nothing to do');
});

test('P3 filenames: a map that cannot be saved does not count its renames as done', async () => {
  const { repo } = await renameHarness(['Alpha']);
  const realSave = repo.saveMap.bind(repo);
  repo.saveMap = async (...args) => {
    throw new Error('EACCES: permission denied, open Map.md');
  };
  const result = await repo.normalizeGeneratedNoteFilenames();
  repo.saveMap = realSave;
  assert.deepEqual(plain(result), { renamed: 0, failed: 1 }, 'the map did not take the new path, so the rename is a failure');
});

test('P3 filenames: the failure notice says how many synced and how many failed, in every interface language', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    const text = table['ui.synced_0_topic_filenames_failed_1'];
    assert.ok(text.includes('{0}') && text.includes('{1}'), `${name}: states both counts`);
    assert.ok(!/EACCES|ENOTDIR|\/private\//.test(text), `${name}: no system error text`);
  }
});

test('P3 repair: a file in the way of the Mind Maps folder is reported, not the workspace-ready notice', async () => {
  const { repo, app } = fixture('zh-TW');
  const Main = loadIn('main.ts', 'zh-TW', { obsidian: { ...obsidian, Notice: NoticeStub } }).default;
  const plugin = new Main();
  Object.assign(plugin, { app, repo, settings: { ...DEFAULT_SETTINGS, language: 'zh-TW', workspaceInitialized: false }, saveSettings: async () => {}, views: () => [] });
  await app.vault.create(`${DEFAULT_SETTINGS.mindMapsFolder}`, 'not a folder');
  takeNotices();
  await plugin.repairWorkspace();
  const notices = takeNotices();
  assert.equal(notices.length, 1, `one notice: ${JSON.stringify(notices)}`);
  assert.ok(notices[0].includes(DEFAULT_SETTINGS.mindMapsFolder), 'the notice names the blocking file');
  assert.ok(!notices.some(text => text.includes('已可使用')), 'it does not claim the workspace is ready');
  assert.equal(plugin.settings.workspaceInitialized, false, 'the workspace is not marked initialized');
});

test('P3 repair counter-example: with no file in the way, repair still reports the workspace ready', async () => {
  const { repo, app } = fixture('zh-TW');
  const Main = loadIn('main.ts', 'zh-TW', { obsidian: { ...obsidian, Notice: NoticeStub } }).default;
  const plugin = new Main();
  Object.assign(plugin, { app, repo, settings: { ...DEFAULT_SETTINGS, language: 'zh-TW', workspaceInitialized: false }, saveSettings: async () => {}, views: () => [] });
  takeNotices();
  await plugin.repairWorkspace();
  assert.ok(takeNotices().some(text => text.includes('Agent 工作區已可使用')));
  assert.equal(plugin.settings.workspaceInitialized, true);
});

test('P3 style folder: a failed open says what to do and shows no system error or absolute path', async () => {
  const Main = loadIn('main.ts', 'zh-TW', { obsidian: { ...obsidian, Notice: NoticeStub } }).default;
  const plugin = new Main();
  const logged = [];
  Object.assign(plugin, {
    settings: { ...DEFAULT_SETTINGS, language: 'zh-TW' },
    noteStyles: { ensureBlockFolder: async () => { throw new Error("ENOTDIR: not a directory, mkdir '/private/tmp/vault/Agent Workspace/筆記風格'"); } },
    logs: { appendLog: (level, text) => logged.push([level, text]) }
  });
  takeNotices();
  assert.equal(await plugin.openNoteStylesFolder(), null);
  const notices = takeNotices();
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('無法開啟筆記風格資料夾'), notices[0]);
  assert.ok(!/ENOTDIR|\/private\/|mkdir/.test(notices[0]), 'no system error or absolute path in the Notice');
  assert.ok(logged.some(([, text]) => text.includes('ENOTDIR')), 'the raw error stays in the log for debugging');
});

test('P3 exchange: a refused OPML names the line in words and never shows the internal reason code', () => {
  fixture('zh-TW');
  const io = loadIn('experiences/visual-map/outline-exchange-io.ts', 'zh-TW', { obsidian: { ...obsidian, Notice: NoticeStub } });
  const withLine = io.exchangeRefusal('bad-xml', 1);
  assert.match(withLine, /第 1 行/);
  assert.ok(!/bad-xml|, 1\)/.test(withLine), withLine);
  const bare = io.exchangeRefusal('not-outline');
  assert.equal(bare, '不是有效的 OPML 或 FreeMind 大綱');
  assert.ok(!/[a-z]+-[a-z]+/.test(bare), bare);
});

test('P3 manual merge JSON: a syntax slip gets a Chinese JSON message; the parser text never shows', () => {
  fixture('zh-TW');
  const modals = loadIn('experiences/visual-map/modals.ts', 'zh-TW', { obsidian: { ...obsidian, Notice: NoticeStub } });
  let syntax;
  try { JSON.parse('oops{{'); } catch (error) { syntax = error; }
  const json = modals.invalidMergedContentsText(syntax);
  assert.match(json, /JSON/);
  assert.ok(!/Expected|position|line \d/.test(json), json);
  const structure = modals.invalidMergedContentsText(new Error('Map nodes must be an array'));
  assert.ok(!/Map nodes|must be/.test(structure), structure);
  assert.match(structure, /心智圖格式/);
});

test('P3 manual merge: a merge by hand says it is done and can be undone, like the AI merge', async () => {
  takeNotices();
  const h = await manualMergeHarness(['Budget', 'Pricing']);
  await h.view.mergeSelected('Budget', snapshot(h, h.nodes));
  const notices = takeNotices();
  assert.ok(notices.some(text => text.includes('Merged into “Budget”') && text.includes('undo')), `notices: ${JSON.stringify(notices)}`);
});

test('P3 manual merge into a parent: the same done notice with the undo, as the plain merge', async () => {
  takeNotices();
  const h = await manualMergeHarness(['Budget', 'Pricing']);
  const [parent, child] = h.nodes;
  child.parentId = parent.id;
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.hydrate();
  await h.view.mergeSelected('Budget', snapshot(h, h.nodes, parent.id));
  const notices = takeNotices();
  assert.ok(notices.some(text => text.includes('Merged into “Budget”') && text.includes('undo')), `notices: ${JSON.stringify(notices)}`);
});

test('P3 outline import: adding under a topic says how many topics were added and under which one', async () => {
  takeNotices();
  const h = await manualMergeHarness(['Budget']);
  const [parent] = h.nodes;
  const outline = [{ index: 0, title: 'One', level: 1, parent: null, line: 1 }, { index: 1, title: 'Two', level: 1, parent: null, line: 2 }];
  await h.view.importOutline({ nodes: outline, source: null, shallowResearch: false, placement: { kind: 'under', parentId: parent.id } });
  const notices = takeNotices();
  assert.ok(notices.includes('Added 2 topics to Under the selected topic (Budget).'), `notices: ${JSON.stringify(notices)}`);
});

// The plain merge harness of tests/steps-merge-filename.cjs, reduced to what the done notice needs.
const MAP = 'Agent Workspace/Topics/map-a/Map.md';
async function manualMergeHarness(titles) {
  const { repo, app } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const nodes = [];
  for (const title of titles) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    await repo.updateNote(created.path, { summary: `${title} summary`, detail: 'Source detail', status: 'completed' });
    mapDoc.nodes.push(created);
    nodes.push(created);
  }
  await repo.saveMap(MAP, mapDoc);
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(),
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: () => repo.rebuildDerivedData(),
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [], mutate: async work => work()
  });
  repo.settings = host.settings;
  const { VisualAgentMapView } = loadIn('main.ts', 'en', { obsidian: { ...obsidian, Notice: NoticeStub, Modal: class { constructor(app) { this.app = app; } open() {} close() {} } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate, ancestorContext: async () => '', queueCharts() {}, focusNode() {} });
  await hydrate();
  return { repo, app, view, nodes };
}
const snapshot = (h, nodes, targetId = null) => ({ path: MAP, mapId: h.view.map.id, parentId: null, targetId, sources: nodes.map(n => ({ id: n.id, path: n.path })) });

test('P3 share: the leak and save-failed texts name the next step (zh-TW, en, zh-CN)', () => {
  const tables = TABLES;
  for (const [name, table] of Object.entries(tables)) {
    assert.ok(table['share.save_failed'].length > 'The file could not be saved.'.length, `${name}: save failure has a next step`);
    assert.ok(table['share.leak_blocked_0'].includes('{0}'), `${name}: leak names the category`);
  }
  assert.match(tables['zh-TW']['share.save_failed'], /換一個位置/);
  assert.match(tables['zh-TW']['share.leak_blocked_0'], /移除這些內容/);
});

test('P3 outline import: the done notice says where the topics went and how many', () => {
  for (const [name, table] of Object.entries(TABLES)) assert.ok(table['ui.outline_import_done_0_1'].includes('{0}') && table['ui.outline_import_done_0_1'].includes('{1}'), name);
});
