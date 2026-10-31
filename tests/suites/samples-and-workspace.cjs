const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, map, TFolder, obsidian, DEFAULT_SETTINGS, fixture } = require('../support.cjs');
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
  assert.equal(sample.SAMPLE_CONTENT_VERSION, 3); assert.equal(sample.SAMPLE_TOUR_VERSION, 3);
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
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps') instanceof TFolder);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/AIM') instanceof TFolder);
  assert.ok(!app.vault.getAbstractFileByPath('Agent Workspace/Topics'), 'the legacy Topics folder is no longer created');
  assert.ok(!app.vault.getAbstractFileByPath('Agent Workspace/Inbox'), 'Inbox is no longer created');
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
integrationTest('duplicating the built-in sample creates an independent editable map with new identities', async () => {
  const { repo, app } = fixture();
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings = { ...DEFAULT_SETTINGS }; plugin.saveSettings = async () => {};
  const mapPath = await plugin.duplicateBuiltInSample();
  const sample = await repo.readMap(mapPath);
  assert.match(mapPath, /Agent Workspace\/Mind Maps\/Sample Planning a Taiwan Journey\/Map\.md$/);
  assert.equal(sample.nodes.length, 12);
  assert.equal(sample.nodes.filter(node => node.parentId === null).length, 2);
  assert.notEqual(sample.id, 'builtin-taiwan-travel');
  assert.ok(sample.nodes.every(node => !['explore', 'constraints', 'transport', 'food', 'nature', 'journey'].includes(node.id)));
  const synthesis = await repo.readNote(sample.nodes.find(node => node.x === 1050).path);
  assert.equal(synthesis.status, 'completed'); assert.equal(synthesis.sourcePaths.length, 6);
  assert.ok(synthesis.sourcePaths.every(source => source.startsWith('Agent Workspace/Mind Maps/')));
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps/Sample Planning a Taiwan Journey/Attachments/east-coast-landscape.webp'));
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
  assert.equal(!!app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps/Sample Planning a Taiwan Journey 2'), false);

  const cleanupFailure = new Error('injected cleanup failure');
  app.fileManager.trashFile = async () => { throw cleanupFailure; };
  app.vault.createBinary = async () => { throw new Error('injected second attachment failure'); };
  await assert.rejects(plugin.duplicateBuiltInSample(), /cleanup failed for Agent Workspace\/Mind Maps\/Sample Planning a Taiwan Journey 2: Error: injected cleanup failure/);
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
    const root = 'Agent Workspace/Mind Maps/Sample Planning a Taiwan Journey';
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
  const settingsSource = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.match(settingsSource, /class AiUsageModal/);
  assert.match(settingsSource, /ui\.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u/);
  assert.match(settingsSource, /ui\.vam_runs_ai_tasks_through_your_claude_code_account_and_uses/);
  assert.match(source, /if \(!confirmed\) return false;/);
  assert.match(source, /this\.settings\.codexUsageNoticeSeen = true/);
  assert.match(source, /this\.settings\.claudeUsageNoticeSeen = true/);
  assert.match(source, /confirmAiUsage\(model/);
});
test('Obsidian 1.13 declarative settings expose workspace recovery and App Server diagnostics', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  const mapSource = ['view.ts', 'modals.ts'].map(file => fs.readFileSync(path.join(root, 'experiences/visual-map', file), 'utf8')).join('\n');
  const definitions = settingsSource.slice(settingsSource.indexOf('getSettingDefinitions()'), settingsSource.indexOf('async setControlValue'));
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
  assert.match(source, /this\.settingTab\?\.refreshAfterLanguageChange\(\)/);
  assert.match(mapSource, /setAttr\("aria-label", t\("ui\.reasoning_level"\)\)/);
  // MS-06 replaces MS-04 D1 here: the level menu only changes what this run uses; the topic is written only by "pin".
  const reasoningHandler = mapSource.slice(mapSource.indexOf('reasoning.addEventListener("change"'));
  assert.match(reasoningHandler.slice(0, 400), /settings\.reasoning = normalizeReasoningLevel\(reasoning\.value\);\s*refresh\(\);/);
  assert.doesNotMatch(reasoningHandler.slice(0, 400), /save\(/, 'a level change writes nothing by itself');
  assert.match(mapSource, /modelSource: "manual",\s*reasoning: normalizeReasoningLevel\(settings\.reasoning\)/, 'pin stores model, manual and the level shown');
});
integrationTest('full rebuild refreshes derived data and open views', async () => {
  const { default: Plugin } = load('main.ts', { obsidian }); let rebuilds = 0, refreshes = 0;
  const plugin = new Plugin();
  plugin.repo = { reconcileMissingNodePaths: async () => 0, rebuildDerivedData: async () => { rebuilds++; } };
  plugin.views = () => [{ refreshFromPlugin: async () => { refreshes++; } }];
  await plugin.fullRebuild();
  assert.equal(rebuilds, 1);
  assert.equal(refreshes, 1);
});
test('missing Codex opens an in-product setup guide with official installation and sign-in steps', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.match(settingsSource, /class CodexSetupModal/);
  assert.match(settingsSource, /https:\/\/developers\.openai\.com\/codex\/cli\//);
  assert.match(settingsSource, /ui\.codex_setup_for_ai_only/);
  assert.match(settingsSource, /ui\.no_api_key_is_required_the_standalone_codex_cli_does_not_req/);
  assert.match(settingsSource, /ui\.run_codex_in_terminal_and_sign_in_with_your_chatgpt_account/);
  assert.match(source, /if \(showGuide\) this\.openCodexSetupGuide\(\)/);
  assert.match(source, /this\.recheckCodex\(false\)/);
});
