// Old AIM maps in the shipped build (AIM off). The maps are fixed files saved by the AIM of 0.29-0.33
// (tests/fixtures/legacy-aim-map, see its README), loaded into a test vault as they are; no AIM engine or factory makes them.
// Pinned: an old AIM map opens, is edited, renamed and shared like any map, its `aim` block is written back as it was read,
// the superseded interim results stay out of the canvas, no old run is recovered or resumed and no AI is called, and the
// aimFolder setting still counts as a managed map container.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { integrationTest, test, root, load, loadHidden, obsidian, fixture, plain, node, map, DEFAULT_SETTINGS } = require('../support.cjs');
const { repoFiles } = require('../support-repo-scan.cjs');
const hiddenCore = loadHidden('map-model.ts');
const hiddenRepository = loadHidden('repository.ts', { obsidian });

const FIXTURES = 'tests/fixtures/legacy-aim-map';
const MAP_BLOCK = /```agent-map\s*\n([\s\S]*?)\n```/;
const aimBlockOf = text => JSON.parse(text.match(MAP_BLOCK)[1]).aim;
const rawAimBlock = text => { const block = text.match(MAP_BLOCK)[1]; const start = block.indexOf('"aim":'); return block.slice(start); };

/**
 * A test vault holding the files of one fixture variant at their vault paths, read by the hidden (shipped) Repository.
 * Variants: old-aim-map (a topic, two research nodes and a conclusion that converges on both), interrupted (a topic and a
 * question), running-attempt, pending-commit and drafts (the interrupted map with a run left running, a commit left pending,
 * or a question draft and an unfinished creation).
 */
async function legacyVault(variant = 'old-aim-map', { folder } = {}) {
  const vault = fixture('en', { Repository: hiddenRepository.Repository });
  const { app, repo } = vault;
  const base = `${FIXTURES}/${variant}`;
  const files = repoFiles(root, { from: base }).sort();
  assert.ok(files.length > 0, `fixture ${variant} has files`);
  for (const file of files) {
    const vaultPath = file.slice(base.length + 1);
    const parts = vaultPath.split('/');
    for (let depth = 1; depth < parts.length; depth++) { const folderPath = parts.slice(0, depth).join('/'); if (!app.vault.getAbstractFileByPath(folderPath)) await app.vault.createFolder(folderPath); }
    await app.vault.create(vaultPath, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  let mapPath = files.map(file => file.slice(base.length + 1)).find(file => file.endsWith('/Map.md'));
  if (folder) { const title = (await repo.readMap(mapPath)).title; mapPath = await repo.renameTopic(mapPath, title, `${folder}/${title}`); }
  const doc = await repo.readMap(mapPath);
  return { ...vault, mapPath, root: doc.nodes[0], research: doc.nodes.filter(item => item.aimKind === 'research'), conclusion: doc.nodes.find(item => item.aimKind === 'conclusion'), question: doc.nodes.find(item => item.path.endsWith('/Question.md')) };
}

test('legacy-aim-map: the suite builds its maps from the fixture files, not from the AIM engine', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  const aimModule = new RegExp(['experiences', 'aim', ''].join('/') + '|' + ['ui', 'modals', 'aim-'].join('/') + '|' + ['ai', 'aim-'].join('/'));
  const factories = new RegExp(['createAim' + 'Map', 'AimRun' + 'Store', 'AimManual' + 'Flow', 'aimMap' + 'Fixture'].join('|'));
  assert.doesNotMatch(source, aimModule, 'no AIM module is loaded');
  assert.doesNotMatch(source, factories, 'no AIM factory is used');
  const variants = fs.readdirSync(path.join(root, FIXTURES), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(variants, ['drafts', 'interrupted', 'old-aim-map', 'pending-commit', 'running-attempt']);
});

// ---- Open, save, edit: the aim block round-trips ------------------------------------------------------------------
integrationTest('legacy-aim-map: the aim block of a fixture map round-trips through parseMap and serializeMap as JSON', async () => {
  for (const variant of ['old-aim-map', 'running-attempt', 'pending-commit', 'drafts']) {
    const { contents, mapPath } = await legacyVault(variant);
    const text = contents.get(mapPath);
    const parsed = hiddenCore.parseMap(text);
    assert.deepEqual(plain(parsed.aim), aimBlockOf(text), `${variant}: parseMap keeps the aim object as it is`);
    assert.deepEqual(aimBlockOf(hiddenCore.serializeMap(parsed)), aimBlockOf(text), `${variant}: serializeMap writes it back`);
  }
});

integrationTest('legacy-aim-map: E2 aim block round-trip survives deleting a node the aim block still references', async () => {
  const { repo, contents, mapPath, research } = await legacyVault();
  const before = contents.get(mapPath);
  const aimBefore = rawAimBlock(before);
  const nodesBefore = plain((await repo.readMap(mapPath)).nodes);
  await repo.updateMap(mapPath, map => {
    map.nodes = hiddenCore.removeNodes(map.nodes, research[0].id, false); // the conclusion still lists it in aimConvergesFromNodeIds
    map.nodes.push({ id: 'plain-topic', path: 'Agent Workspace/AIM/Old AIM map/Notes/Plain.md', parentId: map.nodes[0].id, x: 0, y: 0, collapsed: false });
  });
  const after = contents.get(mapPath);
  assert.equal(rawAimBlock(after), aimBefore, 'the aim block is byte-for-byte what was saved');
  const reread = await repo.readMap(mapPath); // the dangling reference does not stop the map from opening
  assert.ok(reread.nodes.some(n => n.id === 'plain-topic'));
  assert.deepEqual(plain(reread.nodes.find(n => n.id === 'plain-topic')), plain({ id: 'plain-topic', path: 'Agent Workspace/AIM/Old AIM map/Notes/Plain.md', parentId: reread.nodes[0].id, x: 0, y: 0, collapsed: false }));
  for (const old of nodesBefore.filter(n => n.id !== research[0].id)) assert.deepEqual(plain(reread.nodes.find(n => n.id === old.id)), old, `untouched node ${old.id} keeps its aim fields`);
  assert.deepEqual(aimBlockOf(after), aimBlockOf(before));
});

integrationTest('legacy-aim-map: a topic is added and a note is edited like on any map; the aim block and the AIM node fields stay', async () => {
  const { repo, contents, mapPath, research } = await legacyVault();
  const before = contents.get(mapPath);
  const doc = await repo.readMap(mapPath);
  const added = await repo.createNote('Added by hand', 'gpt-6-luna', doc, mapPath, 'workspace');
  added.parentId = research[0].id; doc.nodes.push(added);
  await repo.saveMap(mapPath, doc);
  await repo.updateNote(research[0].path, { summary: 'Edited summary', detail: 'Edited detail' });
  const reread = await repo.readMap(mapPath);
  assert.ok(reread.nodes.some(item => item.id === added.id && item.parentId === research[0].id), 'the new topic is on the map');
  assert.equal(Object.keys(reread.nodes.find(item => item.id === added.id)).some(key => key.startsWith('aim')), false, 'the new topic is a plain topic');
  assert.equal((await repo.readNote(research[0].path, reread)).summary, 'Edited summary');
  assert.equal(rawAimBlock(contents.get(mapPath)), rawAimBlock(before), 'the aim block is byte-for-byte what was saved');
  assert.deepEqual(plain(reread.nodes.filter(item => item.id !== added.id)), plain(hiddenCore.parseMap(before).nodes), 'the old nodes keep every field');
});

integrationTest('legacy-aim-map: D7 only an AIM map skips the AIM checks; a plain map with a bad AIM field is still refused', async () => {
  const { contents, mapPath, research } = await legacyVault();
  const text = contents.get(mapPath);
  const parsed = JSON.parse(text.match(MAP_BLOCK)[1]);
  parsed.nodes.find(n => n.id === research[1].id).aimKind = 'bogus'; // an AIM map: tolerated, kept as written
  const withBogus = text.replace(MAP_BLOCK, () => '```agent-map\n' + JSON.stringify(parsed, null, 2) + '\n```');
  assert.equal(hiddenCore.parseMap(withBogus).nodes.find(n => n.id === research[1].id).aimKind, 'bogus');
  const plainMap = { version: 1, id: 'plain', title: 'Plain', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    { id: 'a', path: 'a.md', parentId: null, x: 0, y: 0, collapsed: false },
    { id: 'b', path: 'b.md', parentId: 'a', x: 0, y: 0, collapsed: false, aimConvergesFromNodeIds: ['gone'] }
  ] };
  const plainText = '```agent-map\n' + JSON.stringify(plainMap) + '\n```';
  assert.throws(() => hiddenCore.parseMap(plainText), /Invalid AIM convergence references/);
  plainMap.nodes[1].aimConvergesFromNodeIds = undefined; plainMap.nodes[1].aimKind = 'bogus';
  assert.throws(() => hiddenCore.parseMap('```agent-map\n' + JSON.stringify(plainMap) + '\n```'), /Invalid AIM node kind/);
  plainMap.nodes[1].aimKind = undefined; plainMap.nodes[1].x = 'wide';
  assert.throws(() => hiddenCore.parseMap('```agent-map\n' + JSON.stringify(plainMap) + '\n```'), /Invalid node data/i);
});

integrationTest('legacy-aim-map: opening and saving an old AIM map writes no AIM content language and no legacy rewrite', async () => {
  const { repo, contents, mapPath } = await legacyVault();
  const aim = aimBlockOf(contents.get(mapPath));
  delete aim.contentLanguage;
  const text = contents.get(mapPath).replace(MAP_BLOCK, (_, block) => '```agent-map\n' + JSON.stringify({ ...JSON.parse(block), aim }, null, 2) + '\n```');
  contents.set(mapPath, text);
  await repo.readMap(mapPath);
  assert.equal(contents.get(mapPath), text, 'reading writes nothing');
  await repo.saveMap(mapPath, await repo.readMap(mapPath));
  assert.equal(aimBlockOf(contents.get(mapPath)).contentLanguage, undefined, 'the language is not stamped');
});

integrationTest('legacy-aim-map: D8 a copied or duplicated topic carries no AIM field', async () => {
  const { repo, mapPath, conclusion } = await legacyVault();
  const doc = await repo.readMap(mapPath);
  const source = doc.nodes.find(item => item.id === conclusion.id);
  assert.ok(source.aimKind && source.aimConvergesFromNodeIds, 'the source has AIM fields');
  const copy = await repo.duplicateNote(source.path, doc, mapPath, {});
  assert.deepEqual(Object.keys(copy).filter(key => key.startsWith('aim')), []);
});

integrationTest('legacy-aim-map: R3 decision 5 deleting a node whose note moves to Unassigned changes the aim block only by the moved notePath values', async () => {
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents, mapPath, conclusion } = await legacyVault();
  const doc = await repo.readMap(mapPath);
  doc.aim.branches = [{ id: 'branch', questionNodeId: doc.nodes[0].id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'Old AIM map', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [] }];
  doc.aim.branches[0].results = [{ nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'conclusion', runId: 'run' }];
  await repo.saveMap(mapPath, doc);
  const before = aimBlockOf(contents.get(mapPath));
  assert.equal(before.branches[0].results[0].notePath, conclusion.path);
  const deps = { repo, rebuildDerivedData: () => repo.rebuildDerivedData(), onApplied() {}, checkConflict: async () => {} };
  await begin(deps).park(conclusion.path, repo.topicFolder(mapPath, 'Unassigned'), doc.id, 'unassigned')
    .editMap(mapPath, map => { map.nodes = hiddenCore.removeNodes(map.nodes, conclusion.id, false); }).commit();
  const newPath = [...contents.keys()].find(key => /\/Unassigned\/Conclusion/.test(key));
  assert.ok(newPath, 'the note now lies in Unassigned');
  // The vault rename handler in main.ts does this for every move (a rename event, not the transaction): same calls, hidden repository.
  for (const { file, map } of await repo.readableMaps()) if (hiddenRepository.rebaseMapNotePaths(map, hiddenRepository.moveNotePath(conclusion.path, newPath))) await repo.saveMap(file.path, map);
  const after = aimBlockOf(contents.get(mapPath));
  assert.equal((await repo.readMap(mapPath)).nodes.some(n => n.id === conclusion.id), false, 'the node is gone from the map');
  assert.equal(after.branches[0].results[0].notePath, newPath, 'the moved note’s notePath follows it');
  assert.match(newPath, /\/Unassigned\//);
  assert.equal(contents.has(newPath), true, 'the new path is the note’s real place');
  assert.equal(contents.has(conclusion.path), false);
  const moved = JSON.parse(JSON.stringify(before, (key, value) => (key === 'notePath' && value === conclusion.path ? newPath : value)));
  assert.deepEqual(after, moved, 'only the moved note’s notePath values differ');
});

integrationTest('legacy-aim-map: a note with the old mindsearch- marker reads back with the aim- marker', async () => {
  const { repo, contents } = fixture('en', { Repository: hiddenRepository.Repository });
  const mapPath = await repo.createMap('Legacy marker');
  const doc = await repo.readMap(mapPath);
  const note = await repo.createNote('Card', 'model-a', doc, mapPath, 'workspace');
  await repo.updateNote(note.path, { detail: '### Answer\n\nBody.\n\n<!-- aim-open-items ["Budget"] -->' });
  const old = contents.get(note.path).replace('<!-- aim-open-items', '<!-- mindsearch-open-items');
  assert.match(old, /mindsearch-open-items/, 'the file holds the old marker');
  contents.set(note.path, old);
  const detail = (await repo.readNote(note.path)).detail;
  assert.match(detail, /<!--\s*aim-open-items \["Budget"\]\s*-->/, 'read back as the aim- marker');
  assert.doesNotMatch(detail, /mindsearch/);
});

// ---- Rename and folders: aimFolder is still a managed map container -----------------------------------------------
integrationTest('legacy-aim-map: renaming an old AIM map moves its folder and keeps the aim block apart from the moved paths', async () => {
  const { repo, contents, mapPath } = await legacyVault();
  const before = contents.get(mapPath);
  const renamed = await repo.renameTopic(mapPath, 'Renamed AIM map');
  assert.equal(renamed, 'Agent Workspace/AIM/Renamed AIM map/Map.md', 'the map stays in the AIM folder under its new name');
  assert.equal(contents.has(mapPath), false);
  const doc = await repo.readMap(renamed);
  assert.ok(doc.aim, 'the aim block is still there');
  const moved = text => text.split('Agent Workspace/AIM/Old AIM map/').join('Agent Workspace/AIM/Renamed AIM map/');
  assert.deepEqual(aimBlockOf(contents.get(renamed)), JSON.parse(moved(JSON.stringify(aimBlockOf(before)))), 'only the moved paths differ');
  assert.deepEqual(plain(doc.nodes.map(item => [item.id, item.aimKind, item.aimConvergesFromNodeIds])), plain(hiddenCore.parseMap(before).nodes.map(item => [item.id, item.aimKind, item.aimConvergesFromNodeIds])));
  for (const item of doc.nodes) assert.ok(contents.has(item.path), `${item.path} is where the map says`);
});

integrationTest('legacy-aim-map: an old AIM map with a run left running can be renamed (no AIM attempt counts as active)', async () => {
  const { repo, contents, mapPath } = await legacyVault('running-attempt');
  assert.ok(aimBlockOf(contents.get(mapPath)).runs.some(run => run.attempts.some(attempt => attempt.status === 'running')), 'the fixture has a running attempt');
  const renamed = await repo.renameTopic(mapPath, 'Renamed run');
  assert.ok((await repo.readMap(renamed)).aim.runs.length > 0);
});

integrationTest('legacy-aim-map: Organize workspace folders sees no busy AIM work in a map with a run left running, and leaves the map where it is', async () => {
  const { repo, contents, mapPath } = await legacyVault('running-attempt', { folder: 'Agent Workspace/Topics' });
  assert.ok(mapPath.startsWith('Agent Workspace/Topics/'), 'the map sits in the legacy Topics folder');
  assert.ok(aimBlockOf(contents.get(mapPath)).runs.some(run => run.attempts.some(attempt => attempt.status === 'running')), 'the fixture has a running attempt');
  const before = contents.get(mapPath);
  const plan = await repo.planOrganizeWorkspaceFolders();
  assert.equal('busy' in plan, false, 'no run counts as active: the plan has no busy list at all');
  assert.deepEqual(plain(plan.skipped), [], 'the map is read without error');
  assert.deepEqual(plain(plan.moves), [], 'an AIM map in the legacy Topics folder stays there while AIM is hidden');
  assert.deepEqual([...(await repo.organizeWorkspaceFolders(plan)).entries()], [], 'organizing does not refuse and moves nothing');
  assert.equal(contents.get(mapPath), before, 'the map file is untouched');
});

integrationTest('legacy-aim-map: the aimFolder setting is a managed map container: maps in it are listed, renamed, organized in place', async () => {
  const { repo, mapPath } = await legacyVault();
  const { isManagedMapPath, managedMapContainer, managedMapContainers, resolveMapFolders } = hiddenRepository;
  assert.equal(repo.settings.aimFolder, 'Agent Workspace/AIM');
  assert.deepEqual(plain(managedMapContainers(repo.settings)), ['Agent Workspace/Mind Maps', 'Agent Workspace/AIM', 'Agent Workspace/Topics']);
  assert.equal(managedMapContainer(repo.settings, mapPath), 'Agent Workspace/AIM');
  assert.equal(isManagedMapPath(repo.settings, mapPath), true);
  assert.equal(isManagedMapPath({ ...repo.settings, aimFolder: 'Elsewhere/AIM' }, mapPath), false, 'the key, not the folder name, decides');
  assert.equal(isManagedMapPath({ ...repo.settings, aimFolder: 'Elsewhere/AIM' }, 'Elsewhere/AIM/Old AIM map/Map.md'), true);
  assert.deepEqual(plain(resolveMapFolders({ workspaceFolder: 'Work' })), { mindMapsFolder: 'Work/Mind Maps', aimFolder: 'Work/AIM' });
  assert.deepEqual(plain(resolveMapFolders({ aimFolder: 'Kept/AIM' })).aimFolder, 'Kept/AIM', 'a saved aimFolder wins');
  repo.settings.aimFolder = 'Elsewhere/AIM';
  await assert.rejects(repo.renameTopic(mapPath, 'Renamed'), /./, 'outside every managed container the map is view-only');
});

integrationTest('legacy-aim-map: a custom saved aimFolder keeps an old AIM map in it open and renameable (the settings row is hidden, the value is kept)', async () => {
  const { repo, mapPath } = await legacyVault();
  const title = (await repo.readMap(mapPath)).title;
  const custom = 'Elsewhere/Old AIM';
  const mindMapsFolder = repo.settings.mindMapsFolder;
  repo.settings.mindMapsFolder = custom;
  const inCustom = await repo.renameTopic(mapPath, title, `${custom}/${title}`);
  Object.assign(repo.settings, { mindMapsFolder, aimFolder: custom });
  assert.equal(inCustom, `${custom}/${title}/Map.md`, 'the map sits in the custom container');
  assert.ok((await repo.readMap(inCustom)).aim, 'the map opens');
  const renamed = await repo.renameTopic(inCustom, 'Renamed in custom');
  assert.equal(renamed, `${custom}/Renamed in custom/Map.md`);
  assert.ok((await repo.readMap(renamed)).aim, 'the renamed map still opens');
  assert.equal(repo.settings.aimFolder, custom, 'the saved value is untouched');
});

integrationTest('legacy-aim-map: N2 ensureWorkspace creates Mind Maps only, never the AIM folder', async () => {
  const { repo, app } = fixture('en', { Repository: hiddenRepository.Repository });
  await repo.ensureWorkspace(); await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps'));
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/AIM'), undefined);
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics'), undefined);
});

integrationTest('legacy-aim-map: N2 a new plain map and a repair add no AIM folder; an existing AIM folder stays', async () => {
  const { repo, app } = fixture('en', { Repository: hiddenRepository.Repository });
  await repo.createMap('Plain');
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/AIM'), undefined);
  await repo.folder('Agent Workspace/AIM'); // a folder the user already has, even empty, is not touched
  await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/AIM'));
});

integrationTest('legacy-aim-map: E5 the map picker lists AIM-folder maps and maps elsewhere', async () => {
  const { repo } = await legacyVault();
  const mind = await repo.createMap('Plain');
  const listed = (await repo.mapFiles()).map(file => file.path);
  assert.ok(listed.includes('Agent Workspace/AIM/Old AIM map/Map.md'));
  assert.ok(listed.includes(mind));
  assert.equal(repo.settings.aimFolder, 'Agent Workspace/AIM');
});

integrationTest('legacy-aim-map: E5 Organize leaves AIM maps in place and still moves plain ones', async () => {
  const vault = await legacyVault('old-aim-map', { folder: 'Agent Workspace/Topics' });
  const { repo, app, contents } = vault;
  const plainPath = await repo.renameTopic(await repo.createMap('Plain'), 'Plain', 'Agent Workspace/Topics/Plain');
  const aimText = contents.get(vault.mapPath);
  const plan = await repo.planOrganizeWorkspaceFolders();
  assert.deepEqual(plain(plan.moves.map(move => [move.title, move.kind])), [['Plain', 'mind']]);
  const mapping = await repo.organizeWorkspaceFolders(plan);
  assert.deepEqual(plain([...mapping.keys()]), [plainPath]);
  assert.ok(app.vault.getAbstractFileByPath(vault.mapPath), 'the AIM map stays where it was');
  assert.equal(contents.get(vault.mapPath), aimText);
  assert.equal((await repo.planOrganizeWorkspaceFolders()).moves.length, 0);
});

integrationTest('legacy-aim-map: E5 changing the Mind Maps folder does not move an AIM map that sits in it', async () => {
  const vault = await legacyVault('old-aim-map', { folder: 'Agent Workspace/Mind Maps' });
  const { repo, app } = vault;
  const plainPath = await repo.createMap('Plain');
  const mapping = await repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Elsewhere');
  assert.deepEqual(plain([...mapping.keys()]), [plainPath]);
  assert.ok(app.vault.getAbstractFileByPath(vault.mapPath));
});

integrationTest('legacy-aim-map: N3 an AIM map imported outside the AIM folder opens like any map and is not rewritten', async () => {
  const { repo, contents, mapPath } = await legacyVault('old-aim-map', { folder: 'Agent Workspace/Mind Maps' });
  const text = contents.get(mapPath);
  const doc = await repo.readMap(mapPath);
  assert.ok(doc.aim);
  assert.equal(contents.get(mapPath), text);
  assert.equal(repo.settings.mindMapsFolder, 'Agent Workspace/Mind Maps');
});

// ---- Share ---------------------------------------------------------------------------------------------------------
integrationTest('legacy-aim-map: D11 an old AIM map shares like any map and the payload carries no aim data', async () => {
  const { repo, mapPath } = await legacyVault();
  const doc = await repo.readMap(mapPath);
  const options = { language: 'en', exportedAt: '2026-11-04T00:00:00.000Z', vamVersion: '0.30.0', includeDetail: false, includeImages: false, assets: {} };
  const payload = loadHidden('experiences/sharing/share-format.ts').buildSharePayload(doc, {}, options);
  assert.equal(payload.nodes.length, doc.nodes.length);
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /"aim/, 'no aim block and no aim* field');
  assert.doesNotMatch(json, /aimKind|aimConverges/);
});

// ---- View: an old AIM map is edited like any map, shows no AIM control, and an old run is never resumed --------------
const element = (tag, buttons = []) => ({ tag, children: [], dataset: {}, style: {},
  createDiv(options) { const child = element('div', buttons); child.cls = options?.cls ?? options; this.children.push(child); return child; },
  createEl(name, options) { const child = element(name, buttons); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
  createSpan(options) { const child = element('span', buttons); child.text = options?.text; child.cls = options?.cls; this.children.push(child); return child; },
  setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, toggleClass() {}, setPointerCapture() {}, addEventListener(name, fn) { if (name === 'click') this.click = fn; }, removeEventListener() {}, appendChild(child) { this.children.push(child); return child; }
});
/** A small old AIM map held in memory: topic, research, conclusion, and an aim block with one answered branch. */
const aimDoc = () => {
  const topic = node('topic'); topic.aimKind = 'topic';
  const research = node('research', 'topic'); research.aimKind = 'research';
  const conclusion = node('conclusion', 'research'); conclusion.aimKind = 'conclusion'; conclusion.aimConvergesFromNodeIds = ['research'];
  const doc = map([topic, research, conclusion]);
  doc.aim = { version: 1, branches: [{ id: 'branch', questionNodeId: topic.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'Fixture', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'synthesis' }] }], runs: [], pendingCommits: [] };
  return { doc, topic, research, conclusion };
};
const svg = () => ({ ...element('svg'), setAttribute() {}, appendChild() {} });
const viewOf = (doc, extra = {}) => {
  const { VisualAgentMapView } = loadHidden('main.ts', { obsidian }, { createSvg: svg });
  const view = new VisualAgentMapView({ app: {} }, { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Map(), quickExpandPending: new Set(), pendingSuggestions: new Map(), ...extra });
  view.map = doc; view.path = 'Agent Workspace/AIM/Old/Map.md';
  return view;
};
const spans = el => [el, ...el.children.flatMap(spans)];

test('legacy-aim-map: E1 an old AIM map is edited like any map (no edit lock)', () => {
  const { doc } = aimDoc();
  const view = viewOf(doc);
  for (const name of ['relationsEnabled', 'canEditSummary']) assert.equal(view[name](), true, `${name} is open`);
  assert.equal(view.clipboardReadOnly(), false, 'the map can be pasted into');
  assert.notEqual(view.shareSnapshot(), 'aim', 'the map can be shared');
});

test('legacy-aim-map: E1 the card of an AIM node has the generic tools and none of the AIM actions', () => {
  const { doc, conclusion } = aimDoc();
  const buttons = [], view = viewOf(doc);
  view.stageEl = element('stage', buttons);
  view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
  view.renderNode(conclusion);
  // The card tools are icon-only buttons named by aria-label (no More menu).
  const labels = buttons.map(button => button['aria-label'] ?? button.text);
  for (const label of ['Details', 'AI explore', 'This card', 'Add subtopic manually']) assert.ok(labels.includes(label), label);
  assert.equal(labels.includes('Continue exploring'), false);
  assert.equal(labels.some(label => /Steer|Correct|new question|Answer|Retry|Start|Continue|Resume|direction/i.test(label ?? '')), false, 'no AIM action');
});

integrationTest('legacy-aim-map: the New map button makes the map at once (no one-row menu, no name dialog)', () => {
  const menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { title: '', setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, onClick() { return this; } }; callback(item); this.items.push(item); return this; } addSeparator() {} showAtMouseEvent() {} showAtPosition() {} setNoIcon() { return this; } }
  const { VisualAgentMapView } = loadHidden('main.ts', { obsidian: { ...obsidian, Menu } });
  const view = new VisualAgentMapView({ app: {} }, { repo: {}, settings: { ...DEFAULT_SETTINGS } });
  let direct = 0; view.openNewMindMapModal = () => { direct++; };
  view.openNewMapMenu({});
  assert.equal(menus.length, 0, 'no menu');
  assert.equal(direct, 1, 'the map is made directly');
});

/** A fixture map left by an interrupted AIM run, opened by the shipped view: nothing may be written, asked or announced. */
async function openedOldRun(variant) {
  const { repo, app, contents, files, mapPath } = await legacyVault(variant);
  const snapshot = () => JSON.stringify([...contents].sort());
  const before = snapshot(), paths = JSON.stringify([...files.keys()].sort());
  let writes = 0, asked = 0, notices = 0;
  for (const name of ['process', 'create', 'modify', 'rename', 'createFolder']) { const original = app.vault[name]?.bind(app.vault); if (original) app.vault[name] = async (...args) => { writes++; return original(...args); }; }
  app.workspace = { requestSaveLayout() {} };
  class Notice { constructor() { notices++; } }
  const { VisualAgentMapView } = loadHidden('main.ts', { obsidian: { ...obsidian, Notice } });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), closeStaleDetails() {}, syncOutline() {}, releaseOutline() {}, askModel: async () => { asked++; throw new Error('no AI call for an old AIM map'); } };
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.hydrate = async () => {};
  await view.openMap(mapPath);
  return { writes, asked, notices, same: snapshot() === before, samePaths: JSON.stringify([...files.keys()].sort()) === paths, view, aim: aimBlockOf(contents.get(mapPath)) };
}
const quiet = result => { assert.equal(result.writes, 0, 'no vault write'); assert.equal(result.asked, 0, 'no AI call'); assert.equal(result.notices, 0, 'no Notice'); assert.ok(result.same && result.samePaths, 'every file as it was'); };

integrationTest('legacy-aim-map: E4 opening a map with a running attempt does not fail it, resume it or write', async () => {
  const result = await openedOldRun('running-attempt');
  quiet(result);
  assert.ok(result.aim.runs.some(run => run.attempts.some(attempt => attempt.status === 'running')), 'the attempt is still recorded as running');
});

integrationTest('legacy-aim-map: E4 opening a map with a pending commit does not recover it', async () => {
  const result = await openedOldRun('pending-commit');
  quiet(result);
  // The interruption hit after the result Note was written and before the commit reached the map: the draft stays a draft.
  assert.equal(result.aim.resultDrafts.length, 1, 'the result draft is still there');
  assert.deepEqual(plain(result.aim.pendingCommits), [], 'nothing is committed on open');
});

integrationTest('legacy-aim-map: E4 opening a map with a question draft or an unfinished creation (synthetic shapes) recovers nothing', async () => {
  const result = await openedOldRun('drafts');
  quiet(result);
  assert.ok(result.aim.questionDraft && result.aim.rootDraft, 'the drafts are still there');
});

integrationTest('legacy-aim-map: an old AIM map still opens with its nodes', async () => {
  const result = await openedOldRun('interrupted');
  quiet(result);
  assert.ok(result.view.map.aim, 'the aim block stays in the open map');
  assert.ok(result.view.map.nodes.length >= 2);
});

test('legacy-aim-map: D11 the share snapshot of an old AIM map has no aim block, no aim fields and no superseded interim result', () => {
  const { doc, topic, conclusion } = aimDoc();
  const interim = node('interim', topic.id); interim.aimKind = 'synthesis';
  doc.nodes.push(interim);
  doc.aim.branches[0].results = [
    { nodeId: interim.id, notePath: interim.path, version: 1, kind: 'synthesis', runId: 'run-1' },
    { nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'conclusion', runId: 'run-1' }
  ];
  const view = viewOf(doc);
  const snapshot = view.shareSnapshot();
  assert.notEqual(typeof snapshot, 'string');
  assert.equal(snapshot.map.aim, undefined);
  assert.equal(snapshot.map.nodes.some(item => item.id === interim.id), false, 'the superseded interim result is not shared');
  assert.equal(snapshot.map.nodes.some(item => Object.keys(item).some(key => key.startsWith('aim'))), false);
  assert.ok(doc.aim && doc.nodes.some(item => item.aimKind), 'the open map itself is untouched');
});

test('legacy-aim-map: E3 the canvas leaves out the interim results supersededAimNodeIds names, and only those', () => {
  const { doc, conclusion } = aimDoc();
  const interim = node('interim', 'topic'); interim.aimKind = 'result'; doc.nodes.push(interim); // an interim result its run's conclusion has replaced
  doc.aim.branches[0].results = [{ nodeId: interim.id, notePath: interim.path, version: 1, kind: 'synthesis', runId: 'run' }, { nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'conclusion', runId: 'run' }];
  const superseded = [...hiddenCore.supersededAimNodeIds(doc)].sort();
  assert.deepEqual(superseded, ['interim'], 'the interim result is superseded by its run conclusion');
  assert.deepEqual(viewOf(doc).canvasNodes().map(item => item.id).sort(), doc.nodes.map(item => item.id).filter(id => !superseded.includes(id)).sort());
  assert.ok(doc.nodes.some(item => item.id === 'interim'), 'the map keeps the node');
});

integrationTest('legacy-aim-map: B1 map chat rate_by_goal on an old AIM map is skipped: no AI call, no goal, no write', async () => {
  const { doc } = aimDoc();
  let asked = 0, writes = 0;
  const grades = new Map();
  const view = viewOf(doc, { relevanceGrades: grades, askModel: async () => { asked++; throw new Error('no AI call'); }, mutate: async work => { writes++; return work(); } });
  view.refreshRelevance = () => {};
  const action = { kind: 'run_map_action', action: 'rate_by_goal', goal: 'Find the best option', nodeIds: [], title: '', direction: '', mode: '', images: false };
  const outcome = await view.runChatSelection(action);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(outcome.status, 'skipped', 'goal grading is off for a map with an aim block');
  assert.equal(view.relevanceGradeable(), false);
  assert.equal(asked, 0, 'no AI call');
  assert.equal(writes, 0, 'no frontmatter or map write');
  assert.equal(grades.size, 0, 'no grading run started');
});

test('legacy-aim-map: M1 an AIM card paints its colour and style choices', () => {
  const { doc, conclusion } = aimDoc();
  const calls = [], view = viewOf(doc);
  view.stageEl = element('stage', []);
  view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '', color: 'red', style: ['bold'] }]));
  for (const name of ['paintCardColor', 'paintCardStyle']) { const original = view[name].bind(view); view[name] = (card, note) => { calls.push([name, card]); return original(card, note); }; }
  view.renderNode(conclusion);
  assert.deepEqual(calls.map(([name]) => name), ['paintCardColor', 'paintCardStyle'], 'colour and style are painted');
  const card = calls[0][1];
  assert.equal(card.dataset.topicColor, 'red', 'the colour choice is on the card');
  assert.equal(card.dataset.topicStyleBold, 'true', 'the style choice is on the card');
});

test('legacy-aim-map: M2 a question card shows no AIM status chip, whatever its run state', () => {
  for (const state of ['running', 'awaiting', 'completed']) {
    const { doc, topic } = aimDoc();
    const question = node('question', 'topic'); question.aimKind = 'question'; doc.nodes.push(question);
    if (state === 'completed') doc.aim.branches.push({ ...doc.aim.branches[0], id: 'q', questionNodeId: question.id, parentBranchId: 'branch' });
    const view = viewOf(doc);
    if (state === 'running') view.aimActiveQuestionNodeId = question.id;
    view.stageEl = element('stage', []);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
    const found = [];
    for (const target of [question, topic]) { view.stageEl.children.length = 0; view.renderNode(target); found.push(...spans(view.stageEl).filter(item => /vam-aim-question-status/.test(item.cls ?? ''))); }
    assert.equal(found.length, 0, `${state}: no chip`);
  }
});

test('legacy-aim-map: P1 the topic status pill rule (idea shows none, researched shows one) applies to an AIM card too', () => {
  const pills = status => {
    const { doc } = aimDoc();
    const research = node('research', 'topic'); research.aimKind = 'research'; doc.nodes.push(research);
    const view = viewOf(doc);
    view.stageEl = element('stage', []);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: item.id === research.id ? status : 'completed', detail: '' }]));
    view.renderNode(research);
    return spans(view.stageEl).filter(item => /vam-status\b/.test(item.cls ?? '')).length;
  };
  assert.equal(pills('idea'), 0, 'idea: no pill, like any plain topic');
  assert.equal(pills('completed'), 1, 'researched: a pill, like any plain topic');
});

test('legacy-aim-map: R3 an AIM card carries the vam-aim-hidden marker class', () => {
  const classesOf = pick => {
    const { doc, ...nodes } = aimDoc(), view = viewOf(doc), added = [];
    view.stageEl = element('stage', []);
    const make = parent => { const create = parent.createDiv.bind(parent); parent.createDiv = options => { const child = create(options); const addClass = child.addClass; child.addClass = name => { added.push(name); addClass.call(child, name); }; make(child); return child; }; };
    make(view.stageEl);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
    view.renderNode(nodes[pick]);
    return added;
  };
  assert.ok(classesOf('conclusion').includes('vam-aim-hidden'), 'an AIM card carries the marker');
  assert.ok(classesOf('topic').includes('vam-aim-hidden'));
});

// ---- The plugin shell: commands, workspace, settings, note styles, text --------------------------------------------
const dom = require('../support-dom.cjs');
/** Loads the shipped plugin the way steps-note-style-onload.cjs does and records the commands it registers and the folders it creates. */
async function onloadShell(saved) {
  const commands = [], folders = [], writes = [];
  const record = (name, sink) => (...args) => { sink?.push(args[0]); writes.push([name, args[0]]); return Promise.resolve(); };
  const Main = loadHidden('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice([]) } });
  const bare = new Main.default();
  const plugin = new Proxy(bare, { get: (target, key, receiver) => key in target || typeof key !== 'string' || !/^(register|add)/.test(key) ? Reflect.get(target, key, receiver) : () => ({ setAttribute() {}, addClass() {}, addEventListener() {} }) });
  plugin.manifest = { id: 'visual-agent-map', version: '0.0.0-test', dir: '' };
  const vault = {
    adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }), read: async () => '', write: record('adapter.write'), mkdir: record('adapter.mkdir') },
    getAbstractFileByPath: () => null, read: async () => '', getMarkdownFiles: () => [], getFiles: () => [], getAllLoadedFiles: () => [], getRoot: () => ({ children: [] }), on: (name, handler) => ({ name, handler }),
    create: record('create'), createFolder: record('createFolder', folders), modify: record('modify'), process: record('process'), rename: record('rename'), trash: record('trash'), delete: record('delete')
  };
  plugin.app = { vault, fileManager: { trashFile: record('trashFile'), renameFile: record('renameFile') }, metadataCache: { on: () => ({}), getFileCache: () => null },
    workspace: { onLayoutReady: callback => callback(), on: () => ({}), getLeaf: () => ({ setViewState: async () => {}, view: {} }), revealLeaf: async () => {}, requestSaveLayout() {}, getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true } };
  plugin.loadData = async () => saved;
  plugin.saveData = async () => {};
  plugin.addCommand = command => { commands.push(command); return command; };
  await plugin.onload(); await plugin.ready; await new Promise(resolve => setImmediate(resolve));
  return { plugin, commands, folders, writes };
}

integrationTest('legacy-aim-map: N1 the command palette has no AIM command', async () => {
  const { commands } = await onloadShell({ migrated: true, structureVersion: 2, workspaceInitialized: true });
  assert.equal(commands.some(command => command.id === 'create-mindsearch-map'), false);
  assert.equal(commands.some(command => /AIM|Adaptive Inquiry/i.test(command.name)), false, 'no command name mentions AIM');
  assert.ok(commands.some(command => command.id === 'open-map'), 'the other commands are there');
});

integrationTest('legacy-aim-map: N2 a first install and a workspace repair create Mind Maps and never the AIM folder', async () => {
  const fresh = await onloadShell(null);
  assert.ok(fresh.folders.includes('Agent Workspace/Mind Maps'), 'the first install creates Mind Maps');
  assert.equal(fresh.folders.some(path => /\/AIM(\/|$)/.test(path)), false, 'first install: no AIM folder');
  const repaired = await onloadShell({ migrated: true, structureVersion: 2, workspaceInitialized: false });
  repaired.folders.length = 0;
  await repaired.plugin.repairWorkspace();
  assert.ok(repaired.folders.includes('Agent Workspace/Mind Maps'));
  assert.equal(repaired.folders.some(path => /\/AIM(\/|$)/.test(path)), false, 'repair: no AIM folder');
});

const recipesWithAim = [
  { ref: 'builtin:general', name: 'General research', kind: 'builtin', structure: { name: 'S' }, voice: { name: 'V' }, format: { name: 'F' }, update: 'rewrite', issues: [], usedByKinds: ['topic', 'aim'] },
  { ref: 'builtin:aim', name: 'AIM report', kind: 'builtin', aimOnly: true, structure: { name: 'S' }, voice: { name: 'V' }, format: { name: 'F' }, update: 'rewrite', issues: [], usedByKinds: ['aim'] }
];

test('legacy-aim-map: N1 the settings have no AIM maps folder row and no AIM note style row', () => {
  const { VisualAgentMapSettingTab } = loadHidden('ui/settings-tab.ts', { obsidian: { ...obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: class {} } });
  const plugin = { settings: { cliModel: 'm', language: 'en' }, subscribeModelDiscovery: () => () => {}, subscribeCurrentModel: () => () => {},
    codexDiagnostic: () => ({ installed: true, executable: 'codex' }), claudeDiagnostic: () => ({ installed: true, executable: 'claude' }), noteStyles: { listRecipes: () => recipesWithAim } };
  const flatten = items => items.flatMap(item => (item.type === 'group' || item.type === 'page') ? [item, ...flatten(item.items || [])] : [item]);
  const names = flatten(new VisualAgentMapSettingTab({}, plugin).getSettingDefinitions()).map(row => row.name ?? row.heading).filter(Boolean);
  assert.equal(names.some(name => /AIM|Adaptive/i.test(name)), false, names.filter(name => /AIM/.test(name)).join(' | '));
  assert.ok(names.includes('Mind maps folder') || names.some(name => /Mind Maps? folder/i.test(name)), 'the Mind Maps folder row stays');
});

test('legacy-aim-map: N1 the note style manager lists no AIM report and names no AIM kind', () => {
  const { NoteStyleManageModal } = loadHidden('ui/modals/note-style-manage-modal.ts', { obsidian: { ...obsidian, Modal: class {}, Setting: class {} } });
  const modal = Object.create(NoteStyleManageModal.prototype);
  modal.tab = 'recipe'; modal.plugin = { noteStyles: { listRecipes: () => recipesWithAim, listParts: () => [] } };
  const entries = modal.entries();
  assert.deepEqual(entries.map(entry => entry.name), ['General research']);
  assert.equal(JSON.stringify(entries).includes('AIM'), false, 'the used-by list does not name the AIM kind');
});

test('legacy-aim-map: E4 the notice line for an old AIM map says AIM was removed and the map works as an ordinary map, in three languages', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.aim_removed_notice'), '這張圖是用 AIM 建的。此功能已移除，地圖仍可作一般地圖使用。');
  assert.equal(translate('zh-CN', 'ui.aim_removed_notice'), '这张图是用 AIM 建的。此功能已移除，地图仍可作一般地图使用。');
  assert.equal(translate('en', 'ui.aim_removed_notice'), 'This map was built with AIM. This feature has been removed; the map can still be used as an ordinary map.');
  for (const language of ['en', 'zh-TW', 'zh-CN']) assert.doesNotMatch(translate(language, 'ui.aim_removed_notice'), /paused|暫停|暂停|resume|恢復|恢复/i, `${language}: nothing promises AIM comes back`);
  const en = fs.readFileSync(path.join(root, 'i18n/en.ts'), 'utf8');
  assert.equal(en.includes('ui.aim_paused_notice'), false, 'the old paused notice is gone');
});

/** Paints the real header of a view on `doc` up to the status bars (the stub ends the paint there) and returns its notice lines. */
function paintedNotices(doc) {
  const dom = require('../support-dom.cjs');
  const stop = new Error('the paint ends here: only the header and its notice line are under test');
  const { VisualAgentMapView } = loadHidden('main.ts', { obsidian: { ...obsidian, Notice: class {} } }, { activeDocument: { activeElement: null }, createSvg: () => dom.element('svg'), CSS: { escape: value => value } });
  const view = new VisualAgentMapView({ app: {} }, { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Set(), quickExpandPending: new Set(), pendingSuggestions: new Map(), relevanceGrades: new Map(), syncOutline() {}, detailsShown: () => false });
  view.map = doc; view.path = 'Agent Workspace/AIM/Old/Map.md';
  view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
  view.contentEl = dom.element('div');
  view.leaf = { setViewState: async () => {} };
  view.renderMultiResearchStatus = () => { throw stop; };
  try { view.paint(); } catch (error) { if (error !== stop) throw error; }
  return dom.findAll(view.contentEl, el => el.hasClass?.('vam-aim-attribution')).map(el => ({ text: el.text, role: el.attrs.role }));
}

test('legacy-aim-map: E4 an old AIM map shows the one "AIM was removed" notice line; a plain map shows none', () => {
  const { translate } = load('i18n.ts');
  const old = paintedNotices(aimDoc().doc);
  assert.deepEqual(old, [{ text: translate('en', 'ui.aim_removed_notice'), role: 'note' }], 'one notice line, read as a note, no button');
  const plainDoc = map([node('topic'), node('child', 'topic')]);
  assert.deepEqual(paintedNotices(plainDoc), [], 'a plain map has no notice');
  const fieldsOnly = aimDoc().doc; delete fieldsOnly.aim; // AIM node fields without the aim block: an ordinary map
  assert.deepEqual(paintedNotices(fieldsOnly), [], 'AIM node fields alone are not an old AIM map');
});

test('legacy-aim-map: N1 the hidden-variant strings a new user can reach carry no AIM wording', () => {
  const { translate } = load('i18n.ts');
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    for (const key of ['ui.organize_preview_hidden_0_1_2', 'ui.map_chat_line_cards_skipped_hidden_0']) assert.doesNotMatch(translate(language, key, 1, 2, 'x'), /AIM|Adaptive/i, `${language} ${key}`);
  }
});

// ---- Styles: an old AIM card takes the ordinary card's colour, style and border ------------------------------------
test('legacy-aim-map: R3 the colour, style and border selectors match a hidden AIM card; the AIM-on selectors still exclude it', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const lines = css.split('\n');
  for (const colour of ['red', 'orange', 'yellow', 'green', 'blue', 'purple']) {
    assert.ok(lines.some(line => line.startsWith(`.vam-node.vam-aim-hidden[data-topic-color="${colour}"] { --vam-topic-hue: var(--color-${colour});`)), `${colour}: fill rule for a hidden AIM card`);
    assert.ok(lines.some(line => line.startsWith(`.vam-node[data-topic-color="${colour}"]:not([data-aim-kind]) {`)), `${colour}: the ordinary rule is as it was`);
  }
  assert.ok(lines.some(line => line.startsWith('.vam-node.vam-aim-hidden[data-topic-color]::before { content: ""; position: absolute;')), 'stripe');
  assert.ok(lines.some(line => line.startsWith('.vam-node[data-topic-color]:not([data-aim-kind])::before')), 'ordinary stripe unchanged');
  assert.ok(lines.some(line => /^:where\(\[data-node-id\]\)\.vam-node\.vam-aim-hidden:where\(\[data-aim-kind\]\) \{ border-color:/.test(line)), 'frame');
  assert.ok(lines.some(line => /^\.vam-view \.vam-node\[data-topic-style-border="thick"\]\.vam-aim-hidden \{ border-width: 3px;/.test(line)), 'thick border');
  assert.ok(lines.some(line => /^\.vam-view \.vam-node\[data-topic-style-bold\]\.vam-aim-hidden \.vam-card-title \{/.test(line)), 'bold');
  // every new colour/style selector needs the marker, so an AIM-on card (no marker) never matches it
  const added = lines.filter(line => /vam-aim-hidden/.test(line) && !line.startsWith('/*'));
  assert.ok(added.length >= 15);
  for (const line of added) for (const selector of line.slice(0, line.indexOf(' {')).split(/,\s*(?=[.\[:])/)) assert.match(selector, /\.vam-aim-hidden/, `selector needs the marker: ${selector.slice(0, 80)}`);
});
test('legacy-aim-map: R4 a coloured hidden question card keeps its diamond; no hidden ::before rule turns it into a stripe', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const splitTop = text => { const parts = []; let depth = 0, cur = ''; for (const ch of text) { if (ch === '(' || ch === '[') depth++; if (ch === ')' || ch === ']') depth--; if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; } parts.push(cur.trim()); return parts; };
  // a mini cascade: the card's classes and attributes, selectors with .class, [attr], [attr="v"], :not(...), :where(...)
  const matchSimple = (sel, card) => { const m = sel.match(/^\.([\w-]+)$/); if (m) return card.classes.has(m[1]); const a = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); if (a) return a[1] in card.attrs && (a[2] === undefined || card.attrs[a[1]] === a[2]); return null; };
  const tokens = compound => compound.match(/:not\((?:[^()]|\([^()]*\))*\)|:where\((?:[^()]|\([^()]*\))*\)|\.[\w-]+|\[[^\]]+\]/g) ?? [];
  const evaluate = (tokenList, card) => { let matched = true, spec = 0; for (const t of tokenList) { if (t.startsWith(':where(')) { if (!splitTop(t.slice(7, -1)).some(part => evaluate(tokens(part), card).matched)) matched = false; continue; } if (t.startsWith(':not(')) { const r = splitTop(t.slice(5, -1)).map(part => evaluate(tokens(part), card)); if (r.some(x => x.matched)) matched = false; spec += Math.max(0, ...r.map(x => x.spec)); continue; } const hit = matchSimple(t, card); if (!hit) matched = false; spec += 10; } return { matched, spec }; };
  const cardOf = extra => ({ classes: new Set(['vam-node', 'vam-aim-hidden']), attrs: { 'data-aim-kind': 'question', 'data-topic-color': 'red', ...extra } });
  for (const extra of [{}, { 'data-topic-kind': 'atomic' }]) {
    const card = cardOf(extra);
    const winners = {};
    css.split('\n').forEach((line, order) => {
      if (/^\s|^\/\*|^@/.test(line) || !line.includes('::before {')) return;
      const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
      for (const selector of splitTop(line.slice(0, line.indexOf(' {')))) {
        if (!selector.endsWith('::before')) continue;
        const compounds = selector.slice(0, -8).split(/\s+/).filter(Boolean);
        const last = compounds[compounds.length - 1], ancestors = compounds.slice(0, -1);
        if (ancestors.some(a => a !== '.vam-view' && a !== '.vam-map')) continue; // an ancestor-only selector: the card has the view as parent
        const r = evaluate(tokens(last), card);
        if (!r.matched) continue;
        const spec = r.spec + ancestors.length * 10;
        for (const decl of body.split(';').map(d => d.trim()).filter(Boolean)) { const [prop, ...rest] = decl.split(':'); const key = prop.trim(); if (!winners[key] || spec >= winners[key].spec) winners[key] = { spec, value: rest.join(':').trim() }; }
      }
    });
    const label = JSON.stringify(extra);
    assert.equal(winners.width?.value, '174px', `the diamond keeps its width ${label}`);
    assert.equal(winners.left?.value, '50%', `the diamond stays centred, not a left stripe ${label}`);
    assert.equal(winners.top?.value, '50%', `the diamond stays centred ${label}`);
    assert.ok(!winners.bottom || winners.bottom.value === 'auto', `no stripe bottom offset ${label}`);
    assert.equal(winners.height?.value, '174px', `the diamond keeps its height ${label}`);
    assert.equal(winners.background?.value, 'var(--vam-card-bg)', `the colour shows through the diamond fill ${label}`);
    assert.equal(winners['border-radius']?.value, '10px', `the diamond corners ${label}`);
  }
});
