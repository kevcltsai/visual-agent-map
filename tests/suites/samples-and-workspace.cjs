const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, map, TFolder, obsidian, DEFAULT_SETTINGS, fixture } = require('../support.cjs');
integrationTest('workspace repair creates only the configured base folders and is idempotent', async () => {
  const { repo, app } = fixture();
  assert.equal(repo.workspaceExists(), false);
  await repo.ensureWorkspace(); await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps') instanceof TFolder);
  assert.ok(!app.vault.getAbstractFileByPath('Agent Workspace/AIM'), 'the AIM folder is no longer created');
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
test('first-use map view waits for async initialization before reading the workspace and opens no sample', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  let resolveReady, reads = 0, renders = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const plugin = {
    ready,
    repo: { workspaceExists: () => { reads++; return false; }, mapFiles: async () => [] }
  };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.contentEl = { addClass() {} }; view.registerDomEvent = () => {};
  view.render = () => { renders++; };
  const opening = view.onOpen();
  await Promise.resolve();
  assert.equal(reads, 0, 'the view must not read workspace data before initialization completes');
  resolveReady(); await opening;
  assert.equal(reads, 1);
  assert.equal(renders, 1);
  assert.equal(view.path, '', 'no map and no sample is opened by the view itself');
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
  const definitions = settingsSource.slice(settingsSource.indexOf('getSettingDefinitions()'), settingsSource.indexOf('async setControlValue'));
  assert.match(definitions, /ui\.settings_workspace_location/);
  assert.match(definitions, /ui\.settings_repair_name/);
  assert.match(definitions, /ui\.settings_reasoning_name/);
  assert.match(definitions, /cliReasoning/);
  assert.match(definitions, /low: t\("ui\.low"\)/);
  assert.match(definitions, /medium: t\("ui\.medium"\)/);
  assert.match(definitions, /high: t\("ui\.high"\)/);
  assert.match(definitions, /ui\.settings_rebuild_name/);
  assert.match(definitions, /ui\.full_rebuild/);
  assert.match(definitions, /ui\.reconnect_existing_workspace/);
  assert.match(definitions, /ui\.settings_status/);
  assert.match(definitions, /ui\.check_again/);
  assert.match(definitions, /ui\.installation_guide/);
  assert.match(source, /this\.settingTab\?\.refreshAfterLanguageChange\(\)/);
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
const firstInstallFixture = ({ workspace = false, candidates = [], failCreate = false } = {}) => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = Object.create(Plugin.prototype), created = [], logs = [], opened = [];
  let saves = 0;
  Object.assign(plugin, { settings: { workspaceInitialized: false }, workspaceRecoveryCandidates: [], firstInstallMapPath: null, logs: { appendLog: (level, message) => logs.push({ level, message }) },
    repo: { workspaceExists: () => workspace, workspaceCandidates: async () => candidates, ensureWorkspace: async () => {},
      createMap: async title => { created.push(title); if (failCreate) throw new Error('disk full'); return 'Agent Workspace/Mind Maps/New mind map/Map.md'; } },
    saveSettings: async () => { saves++; }, activateView: async path => { opened.push(path); }, offerWorkspaceReconnect: async () => { opened.push('reconnect'); },
    app: { workspace: { getLeavesOfType: () => [] } }, ready: Promise.resolve(), styleNodeLeaf() {} });
  return { plugin, created, logs, opened, saves: () => saves };
};
integrationTest('N3: first install (no saved data, no workspace, no candidates) creates one blank map and opens it', async () => {
  const { plugin, created, opened, saves } = firstInstallFixture();
  await plugin.initializeFirstInstall(false);
  assert.deepEqual(created, ['New mind map']);
  assert.equal(plugin.firstInstallMapPath, 'Agent Workspace/Mind Maps/New mind map/Map.md');
  assert.equal(plugin.settings.workspaceInitialized, true);
  assert.equal(saves(), 1);
  await plugin.finishStartup();
  assert.deepEqual(opened, ['Agent Workspace/Mind Maps/New mind map/Map.md']);
});
integrationTest('N3: saved settings, an existing workspace, or recovery candidates never create a map', async () => {
  const saved = firstInstallFixture(); await saved.plugin.initializeFirstInstall(true);
  assert.deepEqual(saved.created, []); assert.equal(saved.plugin.firstInstallMapPath, null);
  const existing = firstInstallFixture({ workspace: true }); await existing.plugin.initializeFirstInstall(false);
  assert.deepEqual(existing.created, []); assert.equal(existing.plugin.settings.workspaceInitialized, true);
  const found = firstInstallFixture({ candidates: ['Research/My Maps'] }); await found.plugin.initializeFirstInstall(false);
  assert.deepEqual(found.created, []); assert.deepEqual(found.plugin.workspaceRecoveryCandidates, ['Research/My Maps']);
  await found.plugin.finishStartup();
  assert.deepEqual(found.opened, ['reconnect'], 'candidates offer reconnect and open no map');
});
integrationTest('N3: a failing createMap only warns, leaves the path null and opens nothing', async () => {
  const { plugin, logs, opened } = firstInstallFixture({ failCreate: true });
  await plugin.initializeFirstInstall(false);
  assert.equal(plugin.firstInstallMapPath, null);
  assert.equal(logs.filter(entry => entry.level === 'warn').length, 1);
  await plugin.finishStartup();
  assert.deepEqual(opened, []);
});
integrationTest('N3: the second start (saved settings now exist) does not create another map', async () => {
  const first = firstInstallFixture(); await first.plugin.initializeFirstInstall(false);
  const second = firstInstallFixture({ workspace: true }); await second.plugin.initializeFirstInstall(true);
  assert.deepEqual(first.created.length + second.created.length, 1);
  await second.plugin.finishStartup();
  assert.deepEqual(second.opened, []);
});
