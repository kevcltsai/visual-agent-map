const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, map, TFolder, obsidian, DEFAULT_SETTINGS, fixture } = require('../support.cjs');
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
