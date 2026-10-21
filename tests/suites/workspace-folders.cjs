const assert = require('node:assert/strict');
const { integrationTest, load, core, map, plain, obsidian, fixture, DEFAULT_SETTINGS } = require('../support.cjs');
const repository = load('repository.ts', { obsidian });
const { createAimMap } = load('experiences/aim/create-map.ts');
const newAim = async (repo, topic) => (await createAimMap(repo, 'gpt-6-luna', { requestId: `req-${topic}`, topic, context: '' })).mapPath;

integrationTest('new mind maps are created in Mind Maps and new AIM maps in AIM; Topics is untouched', async () => {
  const { repo, app } = fixture('en');
  const mind = await repo.createMap('Plain topic');
  const aimPath = await newAim(repo, 'Research topic');
  assert.equal(mind, 'Agent Workspace/Mind Maps/Plain topic/Map.md');
  assert.equal(aimPath, 'Agent Workspace/AIM/Research topic/Map.md');
  assert.ok(!app.vault.getAbstractFileByPath('Agent Workspace/Topics'));
  assert.deepEqual(Array.from((await repo.mapFiles()).map(file => file.path)).sort(), [aimPath, mind]);
});

integrationTest('configured folder names route new maps; an existing name gets a numeric suffix', async () => {
  const { app } = fixture('en');
  const repo = new repository.Repository(app, { ...DEFAULT_SETTINGS, language: 'en', mindMapsFolder: 'Agent Workspace/導圖', aimFolder: 'Agent Workspace/研究' });
  assert.equal(await repo.createMap('A'), 'Agent Workspace/導圖/A/Map.md');
  assert.equal(await repo.createMap('A'), 'Agent Workspace/導圖/A 2/Map.md');
  assert.equal(await newAim(repo, 'B'), 'Agent Workspace/研究/B/Map.md');
});

integrationTest('map folders derive from a custom workspace, and saved values are kept for upgraded users', () => {
  assert.deepEqual({ ...repository.resolveMapFolders({ workspaceFolder: 'Research/VAM' }) }, { mindMapsFolder: 'Research/VAM/Mind Maps', aimFolder: 'Research/VAM/AIM' });
  assert.deepEqual({ ...repository.resolveMapFolders(null) }, { mindMapsFolder: 'Agent Workspace/Mind Maps', aimFolder: 'Agent Workspace/AIM' });
  assert.deepEqual({ ...repository.resolveMapFolders({ workspaceFolder: 'W', mindMapsFolder: 'Elsewhere/Maps', aimFolder: 'Elsewhere/Aim' }) }, { mindMapsFolder: 'Elsewhere/Maps', aimFolder: 'Elsewhere/Aim' });
});

integrationTest('managed map paths cover Mind Maps, AIM and a custom legacy topicsFolder; others are not managed', () => {
  const settings = { ...DEFAULT_SETTINGS, topicsFolder: 'Custom/Legacy Topics' };
  for (const path of ['Agent Workspace/Mind Maps/T/Map.md', 'Agent Workspace/AIM/T/Map.md', 'Custom/Legacy Topics/T/Map.md']) assert.equal(repository.isManagedMapPath(settings, path), true, path);
  for (const path of ['Agent Workspace/Topics/T/Map.md', 'Elsewhere/Map.md', 'Agent Workspace/Maps/pre-0.4.md']) assert.equal(repository.isManagedMapPath(settings, path), false, path);
});

integrationTest('a legacy Topics map can still be renamed and stays in Topics; new-container maps stay in theirs', async () => {
  const { repo, app } = fixture('en');
  const legacyRoot = 'Agent Workspace/Topics/Old';
  await repo.ensureTopicFolders(legacyRoot);
  await app.vault.create(`${legacyRoot}/Map.md`, core.serializeMap({ ...map([]), id: 'old', title: 'Old' }));
  const renamed = await repo.renameTopic(`${legacyRoot}/Map.md`, 'Older');
  assert.equal(renamed, 'Agent Workspace/Topics/Older/Map.md');
  assert.equal((await repo.readMap(renamed)).title, 'Older');
  const mind = await repo.createMap('Fresh');
  assert.equal(await repo.renameTopic(mind, 'Fresher'), 'Agent Workspace/Mind Maps/Fresher/Map.md');
  const aimMap = await newAim(repo, 'Q');
  assert.equal(await repo.renameTopic(aimMap, 'Q2'), 'Agent Workspace/AIM/Q2/Map.md');
});

integrationTest('maps in all three containers are discovered and a broken topic folder is found in each', async () => {
  const { repo, app } = fixture('en');
  await repo.createMap('M');
  await repo.folder('Agent Workspace/Topics/Legacy');
  await repo.folder('Agent Workspace/AIM/Broken AIM');
  assert.deepEqual(Array.from((await repo.brokenTopics()).map(item => item.root)).sort(), ['Agent Workspace/AIM/Broken AIM', 'Agent Workspace/Topics/Legacy']);
  assert.deepEqual(Array.from(await repo.workspaceCandidates()), ['Agent Workspace']);
});

integrationTest('Inbox is gone: no setting, no folder, no repository API, no UI strings', async () => {
  const { repo, app } = fixture('en');
  assert.ok(!('inboxFolder' in DEFAULT_SETTINGS));
  assert.equal(typeof repo.inboxFiles, 'undefined');
  assert.equal(typeof repo.legacyMigrationPlan, 'undefined');
  assert.equal(typeof repo.migrateLegacyWorkspace, 'undefined');
  await repo.ensureWorkspace();
  assert.ok(!app.vault.getAbstractFileByPath('Agent Workspace/Inbox'));
  const source = require('../support.cjs').i18nSource();
  assert.ok(!/Inbox|收件匣|migrate_legacy|old_data/.test(source), 'removed strings are gone in both languages');
});

integrationTest('a legacy Inbox note with topic-state inbox reads without error and is not rewritten by a rebuild', async () => {
  const { repo, app, contents } = fixture('en');
  await repo.createMap('Some map');
  const path = 'Agent Workspace/Inbox/Loose note.md';
  const text = '---\nagent-map-node: true\nnode-id: "loose"\ntitle: "Loose note"\ntopic-state: inbox\ncssclasses: ["vam-topic"]\n---\n\n# Loose note\n\n## Detail\n\nKept\n';
  await repo.folder('Agent Workspace/Inbox');
  await app.vault.create(path, text);
  assert.equal((await repo.readNote(path)).topicState, 'inbox');
  await repo.rebuildDerivedData();
  const after = contents.get(path);
  assert.match(after, /^topic-state: inbox$/m, 'the inbox state is kept');
  assert.match(after, /node-id: loose/);
  assert.ok(app.vault.getAbstractFileByPath(path), 'the note is not moved or deleted');
});

integrationTest('a pre-0.4 map outside every container opens and reads, but renaming is refused as view-only', async () => {
  const { repo, app } = fixture('en');
  await repo.folder('Agent Workspace/Maps'); await repo.folder('Agent Workspace/Nodes');
  const note = 'Agent Workspace/Nodes/a.md';
  const noteText = '---\nagent-map-node: true\nnode-id: "a"\ntitle: "a"\n---\n\n# a\n';
  await app.vault.create(note, noteText);
  const legacy = map([{ id: 'a', parentId: null, path: note, x: 0, y: 0, collapsed: false }]); legacy.title = 'Old map';
  const mapPath = 'Agent Workspace/Maps/Old map.md';
  await app.vault.create(mapPath, core.serializeMap(legacy));
  assert.equal((await repo.readMap(mapPath)).title, 'Old map');
  assert.equal(repository.isManagedMapPath(repo.settings, mapPath), false);
  await assert.rejects(repo.renameTopic(mapPath, 'Renamed'), /pre-0\.4 structure and is view-only/);
});

// ---- Organize workspace folders -------------------------------------------------------------------------------
const { AimRunStore } = load('experiences/aim/research-run-store.ts');
const LEGACY = 'Agent Workspace/Topics';
const bodyOf = (title, links) => `\n# ${title}\n\n## Detail\n\n${links}\n`;

/** A 0.18-style vault: legacy Topics holds two mind maps and one AIM map; an unfiled VAM note cites a moved note. */
async function legacyVault(writtenIn = 'en', uiLanguage = writtenIn) {
  const data = fixture(writtenIn);
  const { repo, app } = data;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  await repo.folder(LEGACY);
  const toLegacy = (mapPath, title) => repo.renameTopic(mapPath, title, `${LEGACY}/${title}`);
  const addNotes = async (mapPath) => {
    const doc = await repo.readMap(mapPath);
    const first = await repo.createNote('First', 'model', doc, mapPath, 'workspace');
    const second = await repo.createNote('Second', 'model', doc, mapPath, 'inherited');
    second.parentId = first.id;
    doc.nodes.push(first, second);
    await repo.saveMap(mapPath, doc);
    await repo.updateNote(first.path, { detail: 'Links to [[Second]] by its short name.' });
    await repo.updateNote(second.path, { sourcePaths: [first.path], referencePaths: [first.path] });
  };
  const alpha = await toLegacy(await repo.createMap('Alpha'), 'Alpha'); await addNotes(alpha);
  const beta = await toLegacy(await repo.createMap('Beta'), 'Beta'); await addNotes(beta);
  const gammaCreated = (await createAimMap(repo, 'gpt-6-luna', { requestId: 'req-gamma', topic: 'Gamma', context: '' })).mapPath;
  const gamma = await toLegacy(gammaCreated, 'Gamma');
  const aimDoc = await repo.readMap(gamma);
  const question = await repo.createNote('Question', 'gpt-6-luna', aimDoc, gamma, 'workspace');
  aimDoc.nodes.push(question); await repo.saveMap(gamma, aimDoc);
  const paths = { alpha, beta, gamma };
  const cites = 'Agent Workspace/Unfiled/Cites.md';
  await repo.folder('Agent Workspace/Unfiled');
  const betaFirst = (await repo.readMap(beta)).nodes[0].path;
  await app.vault.create(cites, `---\nagent-map-node: true\nnode-id: "cites"\ntitle: "Cites"\ntopic-state: unassigned\nsource-notes: ${JSON.stringify([betaFirst])}\n---\n${bodyOf('Cites', '')}`);
  await repo.rebuildDerivedData();
  repo.settings.language = uiLanguage; // the notes were written under `writtenIn`; operations now run under `uiLanguage`
  return { ...data, paths, cites, betaFirst };
}
/** Obsidian's trash: the folder (and anything in it) leaves the tree. */
function installTrash(vault) {
  vault.trashed = [];
  vault.app.fileManager.trashFile = async item => {
    vault.trashed.push(item.path);
    for (const key of [...vault.files.keys()]) if (key === item.path || key.startsWith(`${item.path}/`)) { vault.files.delete(key); vault.contents.delete(key); }
    if (item.parent?.children) item.parent.children = item.parent.children.filter(child => child !== item);
  };
}
const snapshot = ({ files, contents }) => ({ paths: [...files.keys()].sort(), contents: new Map(contents) });
function assertUnchanged(vault, before, message) {
  assert.deepEqual([...vault.files.keys()].sort(), before.paths, `${message}: file and folder paths`);
  assert.equal(vault.contents.size, before.contents.size, `${message}: file count`);
  for (const [path, content] of before.contents) assert.equal(vault.contents.get(path), content, `${message}: ${path}`);
}
/** Every [[link]] in a VAM note and every source-notes/reference-materials path must resolve. */
async function assertResolves(vault) {
  const { app, repo, contents } = vault;
  for (const file of app.vault.getMarkdownFiles()) {
    const text = contents.get(file.path);
    for (const [, link] of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) assert.ok(app.metadataCache.getFirstLinkpathDest(link, file.path), `${file.path} links to missing ${link}`);
    if (!/agent-map-node: true/.test(text)) continue;
    const note = await repo.readNote(file.path);
    for (const path of [...note.sourcePaths, ...note.referencePaths]) assert.ok(app.vault.getAbstractFileByPath(path), `${file.path} cites missing ${path}`);
  }
  for (const { file, map } of await repo.readableMaps()) for (const node of map.nodes) assert.ok(app.vault.getAbstractFileByPath(node.path), `${file.path} node ${node.path}`);
}

integrationTest('Organize previews first and writes nothing until it runs', async () => {
  const vault = await legacyVault();
  const before = snapshot(vault);
  const plan = await vault.repo.planOrganizeWorkspaceFolders();
  assert.deepEqual(plain(plan.moves.map(move => [move.title, move.kind, move.toRoot])), [
    ['Alpha', 'mind', 'Agent Workspace/Mind Maps/Alpha'], ['Beta', 'mind', 'Agent Workspace/Mind Maps/Beta'], ['Gamma', 'aim', 'Agent Workspace/AIM/Gamma']
  ]);
  assert.deepEqual(plain(plan.skipped), []); assert.deepEqual(plain(plan.busy), []);
  assertUnchanged(vault, before, 'planning');
});

integrationTest('Organize moves mind maps to Mind Maps and AIM to AIM; every map opens, links and cited paths resolve; a second run is a no-op', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  const mapping = await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  assert.deepEqual(plain([...mapping.entries()].sort()), [
    [vault.paths.alpha, 'Agent Workspace/Mind Maps/Alpha/Map.md'], [vault.paths.beta, 'Agent Workspace/Mind Maps/Beta/Map.md'], [vault.paths.gamma, 'Agent Workspace/AIM/Gamma/Map.md']
  ].sort());
  for (const next of mapping.values()) {
    const doc = await repo.readMap(next);
    assert.ok(doc.nodes.every(node => node.path.startsWith(`${repo.topicRoot(next)}/`)), `${next} nodes follow the folder`);
  }
  assert.ok(!app.vault.getAbstractFileByPath(`${LEGACY}/Alpha`) && !app.vault.getAbstractFileByPath(`${LEGACY}/Gamma`), 'nothing is left behind');
  assert.ok(app.vault.getAbstractFileByPath(LEGACY), 'the empty legacy Topics folder is kept');
  assert.deepEqual(Array.from((await repo.topics()).map(topic => topic.mapPath)).sort(), [...mapping.values()].sort());
  await assertResolves(vault);
  const cites = await repo.readNote(vault.cites);
  assert.deepEqual(plain(cites.sourcePaths), ['Agent Workspace/Mind Maps/Beta/Notes/First.md'], 'a VAM note outside the topic follows the move');
  const again = await repo.planOrganizeWorkspaceFolders();
  assert.equal(again.moves.length, 0, 'idempotent: nothing left to organize');
});

integrationTest('Organize keeps a clash-free name: an existing target folder gets a numeric suffix', async () => {
  const vault = await legacyVault();
  await vault.repo.createMap('Alpha');
  const mapping = await vault.repo.organizeWorkspaceFolders(await vault.repo.planOrganizeWorkspaceFolders());
  assert.equal(mapping.get(vault.paths.alpha), 'Agent Workspace/Mind Maps/Alpha 2/Map.md');
  assert.ok(vault.app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps/Alpha/Map.md'), 'the pre-existing map is untouched');
  await assertResolves(vault);
});

integrationTest('Organize refuses the whole batch while an AIM attempt is running or saving, with zero moves', async () => {
  const vault = await legacyVault();
  const store = new AimRunStore(vault.repo);
  const doc = await vault.repo.readMap(vault.paths.gamma);
  const branch = await store.createAnswerBranch(vault.paths.gamma, { questionNodeId: doc.nodes.find(node => node.path.endsWith('Question.md')).id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'x' }, inputSnapshot: { topic: 'Gamma', conditions: {}, upstreamResults: [] } });
  await store.startAttempt(vault.paths.gamma, branch.id, 'running-run');
  const before = snapshot(vault);
  const plan = await vault.repo.planOrganizeWorkspaceFolders();
  assert.deepEqual(plain(plan.busy), ['Gamma']);
  await assert.rejects(vault.repo.organizeWorkspaceFolders(plan), /still running or saving/);
  assertUnchanged(vault, before, 'busy refusal');
  // A plan made while idle is re-checked right before the first write.
  const stale = { ...plan, busy: [] };
  await assert.rejects(vault.repo.organizeWorkspaceFolders(stale), /still running or saving/);
  assertUnchanged(vault, before, 'stale plan refusal');
});

integrationTest('Organize skips an unreadable map, leaves it and its notes byte-identical, and still moves the rest', async () => {
  const vault = await legacyVault();
  const { repo, app, contents } = vault;
  const corrupted = contents.get(vault.paths.gamma).replace(/"nodeId":\s*"[^"]+"/, '"nodeId": "missing-node"');
  // Make Gamma unreadable the way an AIM reference to a missing node does; fall back to garbage for a non-AIM-shaped fixture.
  const broken = corrupted === contents.get(vault.paths.gamma) ? '---\nvisual-agent-map: true\n---\nnot a map' : corrupted;
  contents.set(vault.paths.gamma, broken);
  await assert.rejects(() => repo.readMap(vault.paths.gamma), 'precondition: unreadable');
  const gammaFiles = [...vault.files.keys()].filter(path => path.startsWith(`${LEGACY}/Gamma/`));
  const gammaBefore = new Map(gammaFiles.map(path => [path, contents.get(path)]));
  const plan = await repo.planOrganizeWorkspaceFolders();
  assert.deepEqual(plain(plan.skipped.map(item => item.mapPath)), [vault.paths.gamma]);
  assert.deepEqual(plain(plan.moves.map(move => move.title)), ['Alpha', 'Beta']);
  await repo.organizeWorkspaceFolders(plan);
  for (const [path, content] of gammaBefore) assert.equal(contents.get(path), content, `${path} untouched`);
  assert.ok(app.vault.getAbstractFileByPath(vault.paths.gamma));
  assert.ok(!app.vault.getAbstractFileByPath('Agent Workspace/AIM/Gamma'));
});

integrationTest('Organize restores every moved topic, path and content, when a later move fails', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  const plan = await repo.planOrganizeWorkspaceFolders();
  const before = snapshot(vault);
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (item, target) => { if (target.startsWith('Agent Workspace/AIM/')) throw new Error('injected move failure'); return rename(item, target); };
  await assert.rejects(repo.organizeWorkspaceFolders(plan), /injected move failure/);
  app.fileManager.renameFile = rename;
  assertUnchanged(vault, before, 'after a failed third move');
  await assertResolves(vault);
});

integrationTest('Organize restores everything when the final derived-data rebuild fails after all moves', async () => {
  const vault = await legacyVault();
  const { repo } = vault;
  const plan = await repo.planOrganizeWorkspaceFolders();
  const before = snapshot(vault);
  const rebuild = repo.rebuildDerivedData.bind(repo); let calls = 0;
  repo.rebuildDerivedData = async (...args) => { if (++calls === 1) throw new Error('injected final rebuild failure'); return rebuild(...args); };
  await assert.rejects(repo.organizeWorkspaceFolders(plan), /injected final rebuild failure/);
  repo.rebuildDerivedData = rebuild;
  assertUnchanged(vault, before, 'after the final rebuild failed');
});

integrationTest('Organize reports both errors when the rollback also fails', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  const plan = await repo.planOrganizeWorkspaceFolders();
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (item, target) => {
    if (target.startsWith('Agent Workspace/AIM/')) throw new Error('injected move failure');
    if (target.startsWith(`${LEGACY}/`)) throw new Error('injected rollback failure');
    return rename(item, target);
  };
  await assert.rejects(repo.organizeWorkspaceFolders(plan), /injected move failure[\s\S]*rollback also failed[\s\S]*injected rollback failure/);
});

integrationTest('Organize leaves pre-0.4 maps, Inbox notes and Coffee Tables where they are', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  await repo.folder('Agent Workspace/Maps'); await repo.folder('Agent Workspace/Nodes'); await repo.folder('Agent Workspace/Inbox'); await repo.folder('Agent Workspace/Coffee Tables');
  const pre04 = 'Agent Workspace/Maps/Old.md', inbox = 'Agent Workspace/Inbox/Loose.md', coffee = 'Agent Workspace/Coffee Tables/Table.md';
  await app.vault.create('Agent Workspace/Nodes/a.md', '---\nagent-map-node: true\nnode-id: "a"\ntitle: "a"\n---\n\n# a\n');
  const old = map([{ id: 'a', parentId: null, path: 'Agent Workspace/Nodes/a.md', x: 0, y: 0, collapsed: false }]); old.title = 'Old';
  await app.vault.create(pre04, core.serializeMap(old));
  await app.vault.create(inbox, '---\nagent-map-node: true\nnode-id: "loose"\ntitle: "Loose"\ntopic-state: inbox\n---\n\n# Loose\n');
  await app.vault.create(coffee, '# coffee\n');
  await repo.rebuildDerivedData();
  const keep = [pre04, 'Agent Workspace/Nodes/a.md', inbox, coffee]; const text = new Map(keep.map(path => [path, vault.contents.get(path)]));
  const plan = await repo.planOrganizeWorkspaceFolders();
  assert.equal(plan.moves.length, 3, 'only maps under legacy Topics are planned');
  await repo.organizeWorkspaceFolders(plan);
  for (const path of keep) { assert.ok(app.vault.getAbstractFileByPath(path), `${path} stays`); assert.equal(vault.contents.get(path), text.get(path), `${path} unchanged`); }
});

integrationTest('the Organize command is registered in both languages and writes nothing until the preview is confirmed', async () => {
  const fs = require('node:fs'), pathModule = require('node:path');
  const { translate } = load('i18n.ts');
  assert.equal(translate('en', 'ui.organize_workspace_folders'), 'Organize workspace folders');
  assert.equal(translate('zh-TW', 'ui.organize_workspace_folders'), '整理工作區資料夾');
  assert.match(fs.readFileSync(pathModule.join(__dirname, '..', '..', 'main.ts'), 'utf8'), /addLocalizedCommand\(\s*"organize-workspace-folders",\s*"ui\.organize_workspace_folders"/);

  const vault = await legacyVault();
  const notices = [], opened = [], progress = [];
  const fake = { ...obsidian, Notice: class { constructor(message, timeout) { if (timeout === 0) { this.timeline = progress; progress.push(message); } else notices.push(message); } setMessage(message) { progress.push(message); } hide() { progress.push('hidden'); } }, Modal: class { constructor(app) { this.app = app; } open() { opened.push(this); } close() {} } };
  const { default: Plugin } = load('main.ts', { obsidian: fake });
  const plugin = new Plugin();
  const relocated = [];
  Object.assign(plugin, { app: { ...vault.app, workspace: { requestSaveLayout() {}, getLeavesOfType: () => [] } }, repo: vault.repo, settings: vault.repo.settings });
  plugin.views = () => [{ hasActiveAimWork: () => false, relocate: mapping => relocated.push(mapping), synchronize: async () => {} }];
  installTrash(vault);
  const before = snapshot(vault);
  await plugin.offerOrganizeWorkspaceFolders();
  assert.equal(opened.length, 1, 'a preview dialog opens');
  assert.match(opened[0].description, /Afterwards these folders are empty and are moved to the trash: Agent Workspace\/Topics\./);
  assert.match(opened[0].description, /2 mind map\(s\) into Agent Workspace\/Mind Maps and 1 AIM map\(s\) into Agent Workspace\/AIM/);
  assertUnchanged(vault, before, 'preview only');
  opened[0].choices[0].action();
  await plugin.queue;
  assert.equal(relocated.length, 1); assert.equal(relocated[0].size, 3, 'open views follow the moved maps');
  assert.ok(vault.app.vault.getAbstractFileByPath('Agent Workspace/AIM/Gamma/Map.md'));
  assert.deepEqual(notices, ['Organized 3 map(s). Moved the empty legacy folders to the trash: Agent Workspace/Topics.']);
  assert.match(opened[0].description, /Automatically update internal links/, 'the preview explains the wait and the per-map prompts');
  assert.deepEqual(progress.map(message => message.replace(/: .*/, '')), ['Moving 1/3', 'Moving 2/3', 'Moving 3/3', 'hidden'], 'one persistent progress notice, closed at the end');
  assert.match(progress[0], /Waiting for Obsidian to update links/);
  notices.length = 0;
  await plugin.offerOrganizeWorkspaceFolders();
  assert.deepEqual(notices, ['No maps in the legacy Topics folder need organizing.']);
  assert.equal(opened.length, 1, 'no dialog when there is nothing to do');
});

integrationTest('the Organize command refuses while an open view has AIM work running', async () => {
  const vault = await legacyVault();
  const notices = [], opened = [];
  const fake = { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { open() { opened.push(this); } } };
  const { default: Plugin } = load('main.ts', { obsidian: fake });
  const plugin = new Plugin();
  Object.assign(plugin, { app: vault.app, repo: vault.repo, settings: vault.repo.settings });
  plugin.views = () => [{ hasActiveAimWork: path => path === vault.paths.gamma, synchronize: async () => {} }];
  const before = snapshot(vault);
  await plugin.offerOrganizeWorkspaceFolders();
  assert.equal(opened.length, 0); assert.match(notices[0], /still running or saving/);
  assertUnchanged(vault, before, 'busy open view');
});

// ---- Review fixes -----------------------------------------------------------------------------------------------
integrationTest('renaming the Mind Maps folder setting renames the folder; its maps stay managed and editable', async () => {
  const { repo, app } = fixture('en');
  const mapPath = await repo.createMap('Keep me');
  assert.equal((await repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas')).size, 1);
  assert.equal(repo.settings.mindMapsFolder, 'Agent Workspace/Ideas');
  const moved = 'Agent Workspace/Ideas/Keep me/Map.md';
  assert.ok(app.vault.getAbstractFileByPath(moved) && !app.vault.getAbstractFileByPath(mapPath));
  assert.equal(repository.isManagedMapPath(repo.settings, moved), true);
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  assert.equal(await repo.renameTopic(moved, 'Kept'), 'Agent Workspace/Ideas/Kept/Map.md');
  assert.equal(await repo.createMap('Next'), 'Agent Workspace/Ideas/Next/Map.md');
});

integrationTest('map folder changes are refused with the setting unchanged: existing target, empty, Topics-related, clashing, failing rename', async () => {
  const { repo, app } = fixture('en');
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  await repo.createMap('A'); await repo.folder('Agent Workspace/Taken/A');
  const before = { ...repo.settings };
  const refuse = async (key, path, pattern) => { await assert.rejects(repo.changeMapFolder(key, path), pattern, path); assert.equal(repo.settings[key], before[key], `${path} left the setting unchanged`); };
  await refuse('mindMapsFolder', 'Agent Workspace/Taken', /already contains a topic with the same name/);
  await refuse('mindMapsFolder', 'Agent Workspace/', /not changed/);
  await refuse('mindMapsFolder', 'Agent Workspace', /not changed/);
  await refuse('mindMapsFolder', 'Agent Workspace/Topics', /not changed/);
  await refuse('mindMapsFolder', 'Agent Workspace/Topics/Inside', /not changed/);
  await refuse('mindMapsFolder', 'Agent Workspace/AIM', /not changed/);
  await refuse('aimFolder', 'Agent Workspace/Mind Maps/Nested', /not changed/);
  await refuse('mindMapsFolder', 'Outside/Maps', /not changed/);
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async () => { throw new Error('injected'); };
  await refuse('mindMapsFolder', 'Agent Workspace/Renamed', /injected/);
  app.fileManager.renameFile = rename;
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps/A/Map.md'), 'maps stay where they were');
});

integrationTest('Organize skips maps when the target container is the legacy Topics folder', async () => {
  const vault = await legacyVault();
  vault.repo.settings.mindMapsFolder = vault.repo.settings.topicsFolder;
  const plan = await vault.repo.planOrganizeWorkspaceFolders();
  assert.deepEqual(plain(plan.moves.map(move => move.title)), ['Gamma']);
});

integrationTest('replaying rename events after a rolled-back Organize rewrites no note', async () => {
  const vault = await legacyVault();
  const { repo, app, files, contents } = vault;
  const handlers = {};
  app.vault.on = (name, handler) => { handlers[name] = handler; return {}; };
  app.workspace = { getLeavesOfType: () => [] };
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {} });
  plugin.registerVaultEvents();
  const plan = await repo.planOrganizeWorkspaceFolders();
  const before = snapshot(vault);
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (item, target) => { if (target.startsWith('Agent Workspace/AIM/')) throw new Error('injected move failure'); return rename(item, target); };
  await assert.rejects(repo.organizeWorkspaceFolders(plan), /injected move failure/);
  app.fileManager.renameFile = rename;
  // Obsidian reports each moved file's rename after the fact; by now every file is back at its original path.
  for (const file of [...files.values()].filter(item => contents.has(item.path))) handlers.rename(file, file.path);
  await plugin.queue;
  assertUnchanged(vault, before, 'replayed no-op rename events');
  // replaceSourcePath(old, old) is a no-op too.
  await repo.replaceSourcePath(vault.betaFirst, vault.betaFirst);
  assertUnchanged(vault, before, 'replaceSourcePath with identical paths');
});

integrationTest('rediscovery uses the configured folder names, and an unowned note without topic-state is not given one', async () => {
  const { app, repo } = fixture('en');
  const custom = new repository.Repository(app, { ...repo.settings, mindMapsFolder: 'Agent Workspace/Ideas', aimFolder: 'Agent Workspace/Research' });
  await custom.createMap('M');
  assert.deepEqual(Array.from(await custom.workspaceCandidates()), ['Agent Workspace']);
  const path = 'Agent Workspace/Unfiled/Bare.md';
  await custom.folder('Agent Workspace/Unfiled');
  const text = '---\nagent-map-node: true\nnode-id: "bare"\ntitle: "Bare"\ncssclasses: ["visual-agent-map-node"]\n---\n# Bare\n';
  await app.vault.create(path, text);
  await custom.rebuildDerivedData();
  assert.ok(!/topic-state/.test(await app.vault.read(app.vault.getAbstractFileByPath(path))), 'no topic-state was written');
});

integrationTest('a folder-setting change moves every map with notes, cross-map citations and an AIM map; everything resolves', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  const trashed = [];
  app.fileManager.trashFile = async folder => { trashed.push([folder.path, folder.children.length]); for (const key of [...vault.files.keys()]) if (key === folder.path) vault.files.delete(key); };
  await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  const mind = await repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas');
  assert.deepEqual(Array.from(mind.values()).sort(), ['Agent Workspace/Ideas/Alpha/Map.md', 'Agent Workspace/Ideas/Beta/Map.md']);
  const aimMoved = await repo.changeMapFolder('aimFolder', 'Agent Workspace/Research');
  assert.deepEqual(Array.from(aimMoved.values()), ['Agent Workspace/Research/Gamma/Map.md']);
  assert.equal(repo.settings.mindMapsFolder, 'Agent Workspace/Ideas'); assert.equal(repo.settings.aimFolder, 'Agent Workspace/Research');
  assert.deepEqual(trashed, [['Agent Workspace/Mind Maps', 0], ['Agent Workspace/AIM', 0]], 'only empty old folders are removed');
  assert.deepEqual(plain((await repo.readNote(vault.cites)).sourcePaths), ['Agent Workspace/Ideas/Beta/Notes/First.md'], 'a note in another place follows');
  const second = await repo.readNote('Agent Workspace/Ideas/Alpha/Notes/Second.md');
  assert.deepEqual(plain(second.sourcePaths), ['Agent Workspace/Ideas/Alpha/Notes/First.md']);
  for (const file of await repo.mapFiles()) assert.equal(repository.isManagedMapPath(repo.settings, file.path), true);
  await assertResolves(vault);
});

integrationTest('a folder-setting change never deletes a non-empty old folder', async () => {
  const { repo, app } = fixture('en');
  await repo.createMap('A'); await app.vault.create('Agent Workspace/Mind Maps/stray.md', 'keep');
  const trashed = []; app.fileManager.trashFile = async folder => { trashed.push(folder.path); };
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  await repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas');
  assert.deepEqual(trashed, []); assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps/stray.md'));
});

integrationTest('a folder-setting change is refused with zero moves while an AIM attempt runs or a view has AIM work', async () => {
  const { repo, app, files, contents } = fixture('en');
  const mapPath = await newAim(repo, 'Busy');
  const store = new AimRunStore(repo);
  const doc = await repo.readMap(mapPath);
  const question = await repo.createNote('Q', 'gpt-6-luna', doc, mapPath, 'workspace');
  doc.nodes.push(question); await repo.saveMap(mapPath, doc);
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'x' }, inputSnapshot: { topic: 'Busy', conditions: {}, upstreamResults: [] } });
  await repo.createMap('Idle');
  const idleBefore = snapshot({ files, contents });
  await assert.rejects(repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas', () => true), /still running or saving/);
  assertUnchanged({ files, contents }, idleBefore, 'view busy');
  await store.startAttempt(mapPath, branch.id, 'run');
  const before = snapshot({ files, contents });
  await assert.rejects(repo.changeMapFolder('aimFolder', 'Agent Workspace/Research'), /still running or saving/);
  assertUnchanged({ files, contents }, before, 'persisted running attempt');
  assert.equal(repo.settings.aimFolder, 'Agent Workspace/AIM');
});

integrationTest('a folder-setting change restores all bytes and keeps the old setting when a later move fails', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  const before = snapshot(vault);
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (item, target) => { if (target === 'Agent Workspace/Ideas/Beta') throw new Error('injected move failure'); return rename(item, target); };
  await assert.rejects(repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas'), /injected move failure/);
  app.fileManager.renameFile = rename;
  assert.equal(repo.settings.mindMapsFolder, 'Agent Workspace/Mind Maps');
  assert.deepEqual([...vault.files.keys()].filter(key => vault.contents.has(key)).sort(), before.paths.filter(key => before.contents.has(key)));
  for (const [path, content] of before.contents) assert.equal(vault.contents.get(path), content, path);
  await assertResolves(vault);
});

integrationTest('the plugin keeps open views on their maps after a folder-setting change and saves the setting', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  const { default: Plugin } = load('main.ts', { obsidian: { ...obsidian, Notice: class { setMessage() {} hide() {} } } });
  const plugin = new Plugin();
  const relocated = []; let saved = 0;
  Object.assign(plugin, { app: { ...app, workspace: { requestSaveLayout() {}, getLeavesOfType: () => [] } }, repo, settings: repo.settings, saveSettings: async () => { saved++; } });
  plugin.views = () => [{ hasActiveAimWork: () => false, relocate: mapping => relocated.push(mapping) }];
  await plugin.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas');
  assert.equal(relocated.length, 1); assert.equal(relocated[0].get('Agent Workspace/Mind Maps/Alpha/Map.md'), 'Agent Workspace/Ideas/Alpha/Map.md');
  assert.equal(saved, 1); assert.equal(repo.settings.mindMapsFolder, 'Agent Workspace/Ideas');
  plugin.views = () => [{ hasActiveAimWork: () => true, relocate: () => {} }];
  await assert.rejects(plugin.changeMapFolder('mindMapsFolder', 'Agent Workspace/Again'), /still running or saving/);
  assert.equal(saved, 1);
});

integrationTest('Organize and folder changes rebuild only the moved topics: notes of other topics are not rewritten', async () => {
  const vault = await legacyVault();
  const { repo, contents } = vault;
  repo.app.vault.modify = async (file, content) => repo.app.vault.process(file, () => content);
  // A topic that stays put, with a note a vault-wide rebuild would repair (it lost its relationship metadata).
  const stayPath = await repo.createMap('Stay');
  const doc = await repo.readMap(stayPath);
  const stay = await repo.createNote('Stay note', 'model', doc, stayPath, 'workspace');
  doc.nodes.push(stay); await repo.saveMap(stayPath, doc); await repo.rebuildDerivedData();
  contents.set(stay.path, contents.get(stay.path).replace(/^agent-map-references:\n(  - .*\n)+/m, ''));
  const strayBefore = contents.get(stay.path);
  assert.notEqual(strayBefore, undefined);
  await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  assert.equal(contents.get(stay.path), strayBefore, 'a note of an unmoved topic is byte-identical after Organize');
  await repo.changeMapFolder('aimFolder', 'Agent Workspace/Research');
  assert.equal(contents.get(stay.path), strayBefore, 'and after a folder-setting change of another container');
  await repo.rebuildDerivedData();
  assert.notEqual(contents.get(stay.path), strayBefore, 'control: a vault-wide rebuild does rewrite that note');
  await assertResolves({ ...vault, contents });
});

integrationTest('after onunload an in-flight Organize performs zero further writes, even to roll back', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings });
  const plan = await repo.planOrganizeWorkspaceFolders();
  // Obsidian's rename can take a long time (it waits for its link-update queue). Hold the first one open.
  const realRename = app.fileManager.renameFile;
  let release; const held = new Promise(resolve => { release = resolve; });
  let renames = 0;
  app.fileManager.renameFile = async (item, target) => { renames++; await held; return realRename(item, target); };
  const writes = [];
  let unloaded = false;
  for (const name of ['create', 'createFolder', 'modify', 'process']) {
    const original = app.vault[name];
    app.vault[name] = async (...args) => { if (unloaded) writes.push(`vault.${name}`); return original.apply(app.vault, args); };
  }
  const afterRename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (...args) => { if (unloaded) writes.push('fileManager.renameFile'); return afterRename(...args); };
  const running = repo.organizeWorkspaceFolders(plan);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(renames, 1, 'the first rename is in flight');
  plugin.onunload(); unloaded = true;
  release();
  await assert.rejects(running, /unloaded|rollback also failed/);
  assert.deepEqual(writes, [], 'nothing was written after onunload');
  assert.equal(renames, 1, 'no second topic was started');
  assert.ok(repo.isDisposed());
  await assert.rejects(repo.createMap('Late'), /unloaded/);
});

integrationTest('a move that Obsidian reports as done but that did not happen on disk is stopped and restored', async () => {
  const vault = await legacyVault();
  const { repo, app } = vault;
  const plan = await repo.planOrganizeWorkspaceFolders();
  const before = snapshot(vault);
  const rename = app.fileManager.renameFile;
  let calls = 0;
  app.fileManager.renameFile = async (item, target) => { if (++calls === 2) return; return rename(item, target); };
  await assert.rejects(repo.organizeWorkspaceFolders(plan), /did not take effect on disk/);
  app.fileManager.renameFile = rename;
  assertUnchanged(vault, before, 'a silently ignored rename');
});

// ---- Label language: no write path relabels a note ---------------------------------------------------------------
const EN_SCAFFOLD = /^- (Topic|Mind map|Parent topic|Child topics|Source topic|Status): |^## Preview$/m;
const ZH_SCAFFOLD = /^- (所屬主題|所屬心智圖|母議題|子議題|來源議題|狀態)：|^## 預覽$/m;
const withoutUpdated = text => text.replace(/^updated:.*\n/m, '');
const substitute = (text, pairs) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
/** Every VAM note keeps its written language, and its text is the original with only the moved path prefixes replaced. */
function assertScaffoldingKept(vault, originals, pairs, language, message) {
  const mdPaths = vault.app.vault.getMarkdownFiles().map(file => file.path);
  let checked = 0;
  for (const [before, text] of originals) {
    if (!/agent-map-node: true/.test(text)) continue;
    const after = vault.contents.get(substitute(before, pairs));
    assert.ok(after !== undefined, `${message}: ${before} still exists`);
    assert.equal(withoutUpdated(after), withoutUpdated(substitute(text, pairs)), `${message}: ${before} keeps its text and labels`);
    (language === 'zh-TW' ? assert.doesNotMatch : assert.match)(after, EN_SCAFFOLD, `${message}: ${before} language`);
    checked++;
  }
  assert.ok(checked >= 6 && mdPaths.length >= checked, 'the check really covered notes');
}
const noteOriginals = vault => new Map([...vault.contents.entries()].filter(([, text]) => /agent-map-node: true/.test(text)));

integrationTest('zh-TW notes under an en UI keep every label through Organize (in-topic and cross-topic citations)', async () => {
  const vault = await legacyVault('zh-TW', 'en');
  const { repo } = vault;
  const originals = noteOriginals(vault);
  assert.match(vault.contents.get(vault.cites), ZH_SCAFFOLD);
  assert.equal(repo.settings.language, 'en');
  const mapping = await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  const pairs = [...mapping.entries()].map(([from, to]) => [from.replace(/\/Map\.md$/, '/'), to.replace(/\/Map\.md$/, '/')]);
  assertScaffoldingKept(vault, originals, pairs, 'zh-TW', 'Organize');
  await assertResolves(vault);
});

integrationTest('en notes under a zh-TW UI keep every label through Organize', async () => {
  const vault = await legacyVault('en', 'zh-TW');
  const originals = noteOriginals(vault);
  const mapping = await vault.repo.organizeWorkspaceFolders(await vault.repo.planOrganizeWorkspaceFolders());
  const pairs = [...mapping.entries()].map(([from, to]) => [from.replace(/\/Map\.md$/, '/'), to.replace(/\/Map\.md$/, '/')]);
  assertScaffoldingKept(vault, originals, pairs, 'en', 'Organize');
});

integrationTest('zh-TW notes under an en UI keep every label through a folder-setting change', async () => {
  const vault = await legacyVault('zh-TW', 'en');
  const { repo, app } = vault;
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  app.fileManager.trashFile = async () => {};
  await repo.organizeWorkspaceFolders(await repo.planOrganizeWorkspaceFolders());
  const originals = noteOriginals(vault);
  const moved = await repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas');
  const pairs = [...moved.entries()].map(([from, to]) => [from.replace(/\/Map\.md$/, '/'), to.replace(/\/Map\.md$/, '/')]);
  assert.equal(moved.size, 2);
  assertScaffoldingKept(vault, originals, pairs, 'zh-TW', 'folder change');
  await assertResolves(vault);
});

integrationTest('zh-TW notes under an en UI keep their labels when the rename handler rewrites citations', async () => {
  const vault = await legacyVault('zh-TW', 'en');
  const { repo, app, files } = vault;
  const handlers = {};
  app.vault.on = (name, handler) => { handlers[name] = handler; return {}; };
  app.workspace = { getLeavesOfType: () => [] };
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {} });
  plugin.registerVaultEvents();
  const cited = vault.betaFirst, renamed = cited.replace('First.md', 'First renamed.md');
  await app.fileManager.renameFile(files.get(cited), renamed);
  handlers.rename(files.get(renamed), cited);
  await plugin.queue;
  const cites = vault.contents.get(vault.cites);
  assert.match(cites, new RegExp(renamed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the citation followed the rename');
  assert.doesNotMatch(cites, EN_SCAFFOLD);
  for (const [path, text] of vault.contents) if (/agent-map-node: true/.test(text)) assert.doesNotMatch(text, EN_SCAFFOLD, path);
});

integrationTest('reconcileMissingNodePaths and updateNote keep a zh-TW note zh under an en UI', async () => {
  const vault = await legacyVault('zh-TW', 'en');
  const { repo, app, files } = vault;
  const note = (await repo.readMap(vault.paths.alpha)).nodes[0].path;
  const moved = note.replace('First.md', 'Elsewhere.md');
  await app.fileManager.renameFile(files.get(note), moved); // moved without the map being told
  assert.equal(await repo.reconcileMissingNodePaths(), 1);
  await repo.updateNote(moved, { summary: 'Edited' });
  assert.doesNotMatch(vault.contents.get(moved), EN_SCAFFOLD);
  assert.match(vault.contents.get(moved), ZH_SCAFFOLD);
});

integrationTest('Refresh VAM data restores a topic stranded by an interrupted move (folder moved, Map.md not rebased)', async () => {
  const vault = await legacyVault('zh-TW', 'en');
  const { repo, app, files, contents } = vault;
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  Object.assign(plugin, { app: { ...app, workspace: { requestSaveLayout() {}, getLeavesOfType: () => [] } }, repo, settings: repo.settings });
  plugin.views = () => [];
  // What an unload mid-Organize leaves: the folder is already at its new place, nothing else was updated.
  await repo.folder('Agent Workspace/Mind Maps');
  await app.fileManager.renameFile(files.get('Agent Workspace/Topics/Alpha'), 'Agent Workspace/Mind Maps/Alpha');
  const stranded = 'Agent Workspace/Mind Maps/Alpha/Map.md';
  assert.ok((await repo.readMap(stranded)).nodes.some(node => node.path.startsWith('Agent Workspace/Topics/Alpha/')), 'precondition: node paths are stale');
  await plugin.fullRebuild();
  const doc = await repo.readMap(stranded);
  for (const node of doc.nodes) {
    assert.ok(app.vault.getAbstractFileByPath(node.path), `${node.path} found again`);
    assert.match(contents.get(node.path), /^agent-map-id: /m, 'ownership was not stripped');
    assert.doesNotMatch(contents.get(node.path), EN_SCAFFOLD);
  }
  const second = await repo.readNote('Agent Workspace/Mind Maps/Alpha/Notes/Second.md');
  assert.deepEqual(plain(second.sourcePaths), ['Agent Workspace/Mind Maps/Alpha/Notes/First.md'], 'citations follow too');
  assert.equal((await repo.planOrganizeWorkspaceFolders()).moves.length, 2, 'Beta and Gamma are still organizable');
});

integrationTest('the Organize offer first repairs a stranded topic, then plans', async () => {
  const vault = await legacyVault();
  const { repo, app, files } = vault;
  const opened = [];
  const fake = { ...obsidian, Notice: class { setMessage() {} hide() {} }, Modal: class { open() { opened.push(this); } } };
  const { default: Plugin } = load('main.ts', { obsidian: fake });
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings });
  plugin.views = () => [];
  await repo.folder('Agent Workspace/Mind Maps');
  await app.fileManager.renameFile(files.get('Agent Workspace/Topics/Alpha'), 'Agent Workspace/Mind Maps/Alpha');
  await plugin.offerOrganizeWorkspaceFolders();
  const doc = await repo.readMap('Agent Workspace/Mind Maps/Alpha/Map.md');
  assert.ok(doc.nodes.every(node => app.vault.getAbstractFileByPath(node.path)), 'node paths were repaired before planning');
  assert.equal(opened.length, 1);
});

integrationTest('a folder-name field submits once (Enter then blur), locks while running, and closes Settings first', async () => {
  const { bindMapFolderInput } = load('ui/settings-tab.ts', { obsidian });
  const events = [], listeners = {};
  let value = 'Ideas', release;
  const inputEl = { disabled: false, addEventListener: (name, handler) => { listeners[name] = handler; }, blur: () => listeners.blur?.() };
  const input = { inputEl, getValue: () => value, setValue: next => { value = next; } };
  const plugin = {
    settings: { workspaceFolder: 'Agent Workspace', mindMapsFolder: 'Agent Workspace/Mind Maps' },
    app: { setting: { close: () => events.push('close-settings') } },
    mutate: work => { events.push('mutate'); return work(); },
    changeMapFolder: async (key, path) => { events.push(`change ${path}`); assert.equal(inputEl.disabled, true, 'locked while it runs'); await new Promise(resolve => { release = resolve; }); plugin.settings[key] = path; }
  };
  bindMapFolderInput(plugin, 'mindMapsFolder', input);
  assert.equal(inputEl.disabled, false);
  listeners.keydown({ key: 'Enter' });   // Enter blurs the field, which submits
  listeners.blur();                      // the real blur that follows, while the change is still running
  listeners.blur();
  assert.deepEqual(events, ['close-settings', 'mutate', 'change Agent Workspace/Ideas'], 'one submit, Settings closed before the change starts');
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(inputEl.disabled, false); assert.equal(plugin.settings.mindMapsFolder, 'Agent Workspace/Ideas');
  listeners.blur();
  assert.equal(events.filter(event => event === 'mutate').length, 1, 'the same value is never submitted again');
  plugin.app = {}; value = 'Other'; listeners.blur();   // an app without a Settings window handle still works
  assert.equal(events.filter(event => event === 'mutate').length, 2);
  release(); await new Promise(resolve => setTimeout(resolve, 10));
});

// ---- Empty legacy folders (Topics, Inbox) ----------------------------------------------------------------------
const noticePlugin = (vault, notices) => {
  const fake = { ...obsidian, Notice: class { constructor(message, timeout) { if (timeout !== 0) notices.push(message); } setMessage() {} hide() {} }, Modal: class { open() { vault.opened.push(this); } } };
  const { default: Plugin } = load('main.ts', { obsidian: fake });
  const plugin = new Plugin();
  Object.assign(plugin, { app: { ...vault.app, workspace: { requestSaveLayout() {}, getLeavesOfType: () => [] } }, repo: vault.repo, settings: vault.repo.settings });
  plugin.views = () => [{ hasActiveAimWork: () => false, relocate() {}, synchronize: async () => {} }];
  return plugin;
};

integrationTest('after Organize the empty legacy Topics and Inbox folders go to the trash; with nothing to move they are cleaned too', async () => {
  const vault = await legacyVault();
  vault.opened = []; installTrash(vault);
  await vault.repo.folder('Agent Workspace/Inbox');
  const notices = [], plugin = noticePlugin(vault, notices);
  await plugin.offerOrganizeWorkspaceFolders();
  assert.match(vault.opened[0].description, /Agent Workspace\/Topics, Agent Workspace\/Inbox/);
  vault.opened[0].choices[0].action(); await plugin.queue;
  assert.deepEqual(plain(vault.trashed), ['Agent Workspace/Topics', 'Agent Workspace/Inbox']);
  assert.match(notices.at(-1), /Organized 3 map\(s\)\. Moved the empty legacy folders to the trash: Agent Workspace\/Topics, Agent Workspace\/Inbox/);
  // Nothing to move (a vault organized earlier), empty folders left over:
  await vault.repo.folder('Agent Workspace/Topics'); await vault.repo.folder('Agent Workspace/Inbox');
  vault.trashed.length = 0; notices.length = 0;
  await plugin.offerOrganizeWorkspaceFolders();
  assert.deepEqual(plain(vault.trashed), ['Agent Workspace/Topics', 'Agent Workspace/Inbox']);
  assert.match(notices[0], /No maps in the legacy Topics folder need organizing\. Moved the empty legacy folders to the trash/);
  assert.equal(vault.opened.length, 1, 'no dialog when there is nothing to move');
});

integrationTest('a non-empty Inbox (with a topic-state inbox note) and a non-empty Topics (unreadable map) are never touched', async () => {
  const vault = await legacyVault();
  const { repo, app, contents } = vault;
  vault.opened = []; installTrash(vault);
  const inbox = 'Agent Workspace/Inbox/Loose.md';
  await repo.folder('Agent Workspace/Inbox');
  await app.vault.create(inbox, '---\nagent-map-node: true\nnode-id: loose\ntitle: Loose\ntopic-state: inbox\n---\n# Loose\n');
  const good = contents.get(vault.paths.gamma), corrupted = good.replace(/"nodeId":\s*"[^"]+"/, '"nodeId": "missing-node"');
  contents.set(vault.paths.gamma, corrupted === good ? '---\nvisual-agent-map: true\n---\nnot a map' : corrupted);
  await assert.rejects(() => repo.readMap(vault.paths.gamma), 'precondition: unreadable');
  const keep = new Map([[inbox, contents.get(inbox)], ...[...contents.entries()].filter(([path]) => path.startsWith('Agent Workspace/Topics/Gamma/'))]);
  const notices = [], plugin = noticePlugin(vault, notices);
  await plugin.offerOrganizeWorkspaceFolders();
  assert.doesNotMatch(vault.opened[0].description, /moved to the trash/, 'the preview promises no cleanup');
  vault.opened[0].choices[0].action(); await plugin.queue;
  assert.deepEqual(plain(vault.trashed), [], 'no folder was trashed');
  for (const [path, text] of keep) assert.equal(contents.get(path), text, `${path} byte-identical`);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics') && app.vault.getAbstractFileByPath('Agent Workspace/Inbox'));
  assert.doesNotMatch(notices.at(-1), /trash/);
});

integrationTest('a failed trash of an empty legacy folder is ignored, and a disposed repository stops cleaning', async () => {
  const vault = await legacyVault();
  await vault.repo.organizeWorkspaceFolders(await vault.repo.planOrganizeWorkspaceFolders());
  await vault.repo.folder('Agent Workspace/Inbox');
  vault.app.fileManager.trashFile = async () => { throw new Error('trash refused'); };
  assert.deepEqual(plain(await vault.repo.removeEmptyLegacyFolders()), []);
  const calls = [];
  vault.app.fileManager.trashFile = async folder => { calls.push(folder.path); vault.repo.dispose(); };
  assert.deepEqual(plain(await vault.repo.removeEmptyLegacyFolders()), ['Agent Workspace/Topics']);
  assert.deepEqual(calls, ['Agent Workspace/Topics'], 'once disposed, the next folder is not trashed');
});

// Obsidian's vault tree hides dot-files and dot-folders, so "empty" must also hold on disk.
const hiddenCase = async (setup) => {
  const vault = await legacyVault();
  vault.opened = []; installTrash(vault);
  await vault.repo.folder('Agent Workspace/Inbox');
  await setup(vault);
  const notices = [], plugin = noticePlugin(vault, notices);
  return { vault, notices, plugin };
};

integrationTest('a Topics folder holding only a hidden file is not trashed and keeps its bytes, and the preview does not promise it', async () => {
  const { vault, plugin } = await hiddenCase(async v => { await v.app.vault.adapter.write('Agent Workspace/Topics/.hidden.md', 'private notes'); });
  assert.equal(vault.app.vault.getAbstractFileByPath('Agent Workspace/Topics').children.length, 3, 'precondition: the tree shows only the three topics');
  await plugin.offerOrganizeWorkspaceFolders();
  assert.doesNotMatch(vault.opened[0].description, /Topics, /);
  assert.match(vault.opened[0].description, /moved to the trash: Agent Workspace\/Inbox\./, 'only the really empty Inbox is promised');
  vault.opened[0].choices[0].action(); await plugin.queue;
  assert.deepEqual(plain(vault.trashed), ['Agent Workspace/Inbox']);
  assert.equal(vault.contents.get('Agent Workspace/Topics/.hidden.md'), 'private notes');
});

integrationTest('an Inbox holding only a hidden subfolder is not trashed', async () => {
  const { vault, plugin } = await hiddenCase(async v => { await v.app.vault.adapter.mkdir('Agent Workspace/Inbox/.git'); await v.app.vault.adapter.write('Agent Workspace/Inbox/.git/config', 'x'); });
  await plugin.offerOrganizeWorkspaceFolders();
  assert.doesNotMatch(vault.opened[0].description, /Inbox/);
  vault.opened[0].choices[0].action(); await plugin.queue;
  assert.deepEqual(plain(vault.trashed), ['Agent Workspace/Topics']);
  assert.equal(vault.contents.get('Agent Workspace/Inbox/.git/config'), 'x');
});

integrationTest('folders holding only OS litter (.DS_Store) are still trashed', async () => {
  const { vault, plugin } = await hiddenCase(async v => { await v.app.vault.adapter.write('Agent Workspace/Topics/.DS_Store', 'x'); await v.app.vault.adapter.write('Agent Workspace/Inbox/.DS_Store', 'x'); });
  await plugin.offerOrganizeWorkspaceFolders();
  assert.match(vault.opened[0].description, /Agent Workspace\/Topics, Agent Workspace\/Inbox/);
  vault.opened[0].choices[0].action(); await plugin.queue;
  assert.deepEqual(plain(vault.trashed), ['Agent Workspace/Topics', 'Agent Workspace/Inbox']);
});

integrationTest('a folder whose disk listing fails is skipped', async () => {
  const vault = await legacyVault();
  await vault.repo.organizeWorkspaceFolders(await vault.repo.planOrganizeWorkspaceFolders());
  installTrash(vault);
  vault.app.vault.adapter.list = async () => { throw new Error('no listing'); };
  assert.deepEqual(plain(await vault.repo.removeEmptyLegacyFolders()), []);
  assert.deepEqual(plain(vault.trashed), []);
});
