// AIM is hidden from this release (experiences/aim/availability.ts). These suites build the product with AIM off, the way the shipped
// build has it, and check that old AIM maps stay safe and that new users meet no AIM. Every other suite runs with AIM on (tests/build.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { integrationTest, test, root, load, loadHidden, obsidian, fixture, plain, node, map, DEFAULT_SETTINGS } = require('../support.cjs');
const hiddenCore = loadHidden('map-model.ts');
const hiddenRepository = loadHidden('repository.ts', { obsidian });
const { createAimMap } = load('experiences/aim/create-map.ts');
const { AimRunStore } = load('experiences/aim/research-run-store.ts');

const hiddenVault = (language = 'en') => fixture(language, { Repository: hiddenRepository.Repository });
const aimBlockOf = text => JSON.parse(text.match(/```agent-map\s*\n([\s\S]*?)\n```/)[1]).aim;
const rawAimBlock = text => { const block = text.match(/```agent-map\s*\n([\s\S]*?)\n```/)[1]; const start = block.indexOf('"aim":'); return block.slice(start); };

/** An AIM map the way 0.29 saved it: a topic, two research nodes and a conclusion that converges on both. */
async function aimMap(vault, { folder } = {}) {
  const { repo } = vault;
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: `req-${folder ?? 'aim'}`, topic: 'Old AIM map', context: '' });
  let mapPath = created.mapPath;
  if (folder) mapPath = await repo.renameTopic(mapPath, 'Old AIM map', `${folder}/Old AIM map`);
  const doc = await repo.readMap(mapPath);
  const root = doc.nodes[0];
  const research = [];
  for (const title of ['Research one', 'Research two']) { const n = await repo.createNote(title, 'gpt-6-luna', doc, mapPath, 'workspace'); n.parentId = root.id; n.aimKind = 'research'; doc.nodes.push(n); research.push(n); }
  const conclusion = await repo.createNote('Conclusion', 'gpt-6-luna', doc, mapPath, 'workspace');
  conclusion.parentId = research[1].id; conclusion.aimKind = 'conclusion'; conclusion.aimConvergesFromNodeIds = research.map(n => n.id); doc.nodes.push(conclusion);
  await repo.saveMap(mapPath, doc);
  return { ...vault, mapPath, research, conclusion, root: doc.nodes[0] };
}

integrationTest('aim-hidden: E2 aim block round-trip survives deleting a node the aim block still references', async () => {
  const vault = hiddenVault();
  const { repo, contents, mapPath, research } = await aimMap(vault);
  const before = contents.get(mapPath);
  const aimBefore = rawAimBlock(before);
  const nodesBefore = plain((await repo.readMap(mapPath)).nodes);
  await repo.updateMap(mapPath, map => {
    map.nodes = hiddenCore.removeNodes(map.nodes, research[0].id, false); // the conclusion still lists it in aimConvergesFromNodeIds
    map.nodes.push({ id: 'plain-topic', path: 'Agent Workspace/AIM/Old AIM map/Notes/Plain.md', parentId: map.nodes[0].id, x: 0, y: 0, collapsed: false });
  });
  const after = contents.get(mapPath);
  assert.equal(rawAimBlock(after), aimBefore, 'the aim block is byte-for-byte what was saved');
  const reread = await repo.readMap(mapPath); // flag off: the dangling reference does not stop the map from opening
  assert.ok(reread.nodes.some(n => n.id === 'plain-topic'));
  assert.deepEqual(plain(reread.nodes.find(n => n.id === 'plain-topic')), plain({ id: 'plain-topic', path: 'Agent Workspace/AIM/Old AIM map/Notes/Plain.md', parentId: reread.nodes[0].id, x: 0, y: 0, collapsed: false }));
  for (const old of nodesBefore.filter(n => n.id !== research[0].id)) assert.deepEqual(plain(reread.nodes.find(n => n.id === old.id)), old, `untouched node ${old.id} keeps its aim fields`);
  assert.deepEqual(aimBlockOf(after), aimBlockOf(before));
});

integrationTest('aim-hidden: D7 only an AIM map skips the AIM checks; a plain map with a bad AIM field is still refused', async () => {
  const vault = hiddenVault();
  const { repo, contents, mapPath, research } = await aimMap(vault);
  const text = contents.get(mapPath);
  const parsed = JSON.parse(text.match(/```agent-map\s*\n([\s\S]*?)\n```/)[1]);
  parsed.nodes.find(n => n.id === research[1].id).aimKind = 'bogus'; // an AIM map: tolerated, kept as written
  const withBogus = text.replace(/```agent-map\s*\n[\s\S]*?\n```/, () => '```agent-map\n' + JSON.stringify(parsed, null, 2) + '\n```');
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
  void repo;
});

integrationTest('aim-hidden: opening and saving an old AIM map writes no AIM content language and no legacy rewrite', async () => {
  const vault = hiddenVault();
  const { repo, contents, mapPath } = await aimMap(vault);
  const aim = aimBlockOf(contents.get(mapPath));
  delete aim.contentLanguage;
  const text = contents.get(mapPath).replace(/```agent-map\s*\n([\s\S]*?)\n```/, (_, block) => '```agent-map\n' + JSON.stringify({ ...JSON.parse(block), aim }, null, 2) + '\n```');
  contents.set(mapPath, text);
  await repo.readMap(mapPath);
  assert.equal(contents.get(mapPath), text, 'reading writes nothing');
  await repo.saveMap(mapPath, await repo.readMap(mapPath));
  assert.equal(aimBlockOf(contents.get(mapPath)).contentLanguage, undefined, 'the language is not stamped while AIM is hidden');
  assert.equal(hiddenRepository.hasActiveAimAttempt({ aim: { runs: [{ attempts: [{ status: 'running' }] }] } }), false);
});

integrationTest('aim-hidden: N2 ensureWorkspace creates Mind Maps only, never the AIM folder', async () => {
  const { repo, app } = hiddenVault();
  await repo.ensureWorkspace(); await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Mind Maps'));
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/AIM'), undefined);
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics'), undefined);
});

integrationTest('aim-hidden: N2 a new plain map and a repair add no AIM folder; an existing AIM folder stays', async () => {
  const { repo, app } = hiddenVault();
  await repo.createMap('Plain');
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/AIM'), undefined);
  await repo.folder('Agent Workspace/AIM'); // a folder the user already has, even empty, is not touched
  await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/AIM'));
});

integrationTest('aim-hidden: E5 the map picker lists AIM-folder maps and maps elsewhere', async () => {
  const vault = hiddenVault();
  const { repo } = await aimMap(vault);
  const mind = await repo.createMap('Plain');
  const listed = (await repo.mapFiles()).map(file => file.path);
  assert.ok(listed.includes('Agent Workspace/AIM/Old AIM map/Map.md'));
  assert.ok(listed.includes(mind));
  assert.equal(repo.settings.aimFolder, 'Agent Workspace/AIM');
});

integrationTest('aim-hidden: E5 Organize leaves AIM maps in place and still moves plain ones', async () => {
  const vault = hiddenVault();
  const { repo, app, contents } = vault;
  await repo.folder('Agent Workspace/Topics');
  const old = await aimMap(vault, { folder: 'Agent Workspace/Topics' });
  const plainPath = await repo.renameTopic(await repo.createMap('Plain'), 'Plain', 'Agent Workspace/Topics/Plain');
  const aimText = contents.get(old.mapPath);
  const plan = await repo.planOrganizeWorkspaceFolders();
  assert.deepEqual(plain(plan.moves.map(move => [move.title, move.kind])), [['Plain', 'mind']]);
  const mapping = await repo.organizeWorkspaceFolders(plan);
  assert.deepEqual(plain([...mapping.keys()]), [plainPath]);
  assert.ok(app.vault.getAbstractFileByPath(old.mapPath), 'the AIM map stays where it was');
  assert.equal(contents.get(old.mapPath), aimText);
  assert.equal((await repo.planOrganizeWorkspaceFolders()).moves.length, 0);
});

integrationTest('aim-hidden: E5 changing the Mind Maps folder does not move an AIM map that sits in it', async () => {
  const vault = hiddenVault();
  const { repo, app } = vault;
  const old = await aimMap(vault, { folder: 'Agent Workspace/Mind Maps' });
  const plainPath = await repo.createMap('Plain');
  const mapping = await repo.changeMapFolder('mindMapsFolder', 'Agent Workspace/Elsewhere');
  assert.deepEqual(plain([...mapping.keys()]), [plainPath]);
  assert.ok(app.vault.getAbstractFileByPath(old.mapPath));
});

integrationTest('aim-hidden: N3 an AIM map imported outside the AIM folder opens like any map and is not rewritten', async () => {
  const vault = hiddenVault();
  const { repo, contents, mapPath } = await aimMap(vault, { folder: 'Agent Workspace/Mind Maps' });
  const text = contents.get(mapPath);
  const doc = await repo.readMap(mapPath);
  assert.ok(doc.aim);
  assert.equal(contents.get(mapPath), text);
  assert.equal(repo.settings.mindMapsFolder, 'Agent Workspace/Mind Maps');
});

test('aim-hidden: the flag is the single switch', () => {
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', '.git', 'tests', 'scripts', 'docs', 'vaults', '.scratch'].includes(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.ts$/.test(entry.name)) files.push(full); } };
  walk(root);
  const defining = files.filter(file => /export const AIM_ENABLED\b/.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(root, file));
  assert.deepEqual(defining, ['experiences/aim/availability.ts']);
  const reading = files.filter(file => /\bAIM_ENABLED\b/.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(root, file));
  assert.deepEqual(reading, ['experiences/aim/availability.ts'], 'everything else asks aimEnabled()');
  assert.match(fs.readFileSync(path.join(root, 'experiences/aim/availability.ts'), 'utf8'), /export const AIM_ENABLED = false;/);
  assert.equal(hiddenCore.parseMap !== undefined, true);
  const esbuildConfig = fs.readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8');
  assert.doesNotMatch(esbuildConfig, /__VAM_AIM__/, 'the production build injects no override');
});

integrationTest('aim-hidden: D11 an old AIM map shares like any map and the payload carries no aim data; with AIM on it still cannot be shared', async () => {
  const vault = hiddenVault();
  const { repo, mapPath } = await aimMap(vault);
  const doc = await repo.readMap(mapPath);
  const options = { language: 'en', exportedAt: '2026-11-04T00:00:00.000Z', vamVersion: '0.30.0', includeDetail: false, includeImages: false, assets: {} };
  assert.throws(() => load('experiences/sharing/share-format.ts').buildSharePayload(doc, {}, options), /AIM maps cannot be shared/);
  const payload = loadHidden('experiences/sharing/share-format.ts').buildSharePayload(doc, {}, options);
  assert.equal(payload.nodes.length, doc.nodes.length);
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /"aim/, 'no aim block and no aim* field');
  assert.doesNotMatch(json, /aimKind|aimConverges/);
});

// ---- View: edit locks lift, AIM controls vanish, an old AIM run is never resumed -----------------------------------
const element = (tag, buttons = []) => ({ tag, children: [], dataset: {}, style: {},
  createDiv(options) { const child = element('div', buttons); child.cls = options?.cls ?? options; this.children.push(child); return child; },
  createEl(name, options) { const child = element(name, buttons); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
  createSpan(options) { const child = element('span', buttons); child.text = options?.text; this.children.push(child); return child; },
  setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, toggleClass() {}, setPointerCapture() {}, addEventListener() {}, removeEventListener() {}, appendChild(child) { this.children.push(child); return child; }
});
const aimDoc = () => {
  const topic = node('topic'); topic.aimKind = 'topic';
  const research = node('research', 'topic'); research.aimKind = 'research';
  const conclusion = node('conclusion', 'research'); conclusion.aimKind = 'conclusion'; conclusion.aimConvergesFromNodeIds = ['research'];
  const doc = map([topic, research, conclusion]);
  doc.aim = { version: 1, branches: [{ id: 'branch', questionNodeId: topic.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'Fixture', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'synthesis' }] }], runs: [], pendingCommits: [] };
  return { doc, topic, research, conclusion };
};
const svg = () => ({ ...element('svg'), setAttribute() {}, appendChild() {} });
const viewOf = (loader, doc, extra = {}) => {
  const { VisualAgentMapView } = loader('main.ts', { obsidian }, { createSvg: svg });
  const view = new VisualAgentMapView({ app: {} }, { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Map(), quickExpandPending: new Set(), pendingSuggestions: new Map(), ...extra });
  view.map = doc; view.path = 'Agent Workspace/AIM/Old/Map.md';
  return view;
};

test('aim-hidden: E1 an old AIM map is edited like any map (the edit locks are lifted); with AIM on they hold', () => {
  const { doc } = aimDoc();
  const hidden = viewOf(loadHidden, doc), shown = viewOf(load, doc);
  for (const name of ['relationsEnabled', 'canEditSummary']) {
    assert.equal(typeof hidden[name], 'function', name);
    assert.equal(shown[name](), false, `${name} is locked while AIM is available`);
    assert.equal(hidden[name](), true, `${name} is open while AIM is hidden`);
  }
  assert.equal(shown.clipboardReadOnly(), true, 'AIM on: an AIM map cannot be pasted into');
  assert.equal(hidden.hasActiveAimWork('Agent Workspace/AIM/Old/Map.md'), false);
  assert.equal(hidden.shareSnapshot() === 'aim', false);
  assert.equal(shown.shareSnapshot(), 'aim');
});

test('aim-hidden: E1 the card of an AIM node has the generic tools and none of the AIM actions', () => {
  const { doc, conclusion } = aimDoc();
  const render = loader => {
    const buttons = [], view = viewOf(loader, doc);
    view.stageEl = element('stage', buttons);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
    view.renderNode(conclusion);
    return buttons.map(button => button['aria-label'] ?? button.text);
  };
  const shown = render(load), hidden = render(loadHidden);
  assert.equal(shown.includes('AI explore'), false, 'AIM on: generic tools are hidden on an AIM map');
  assert.ok(hidden.includes('Open details in right sidebar'));
  assert.ok(shown.includes('Continue exploring'), 'AIM on: the AIM action is there');
  for (const label of ['AI explore', 'Structure and links', 'Rename', 'Add subtopic manually']) assert.ok(hidden.includes(label), label);
  assert.equal(hidden.includes('Continue exploring'), false);
  assert.equal(hidden.some(label => /Steer|Correct|new question|Answer|Retry|Start|Continue|Resume|direction/i.test(label ?? '')), false, 'no AIM action');
});

integrationTest('aim-hidden: the New map menu offers only New mind map', () => {
  const menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { title: '', setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, onClick() { return this; } }; callback(item); this.items.push(item); return this; } addSeparator() {} showAtMouseEvent() {} showAtPosition() {} setNoIcon() { return this; } }
  for (const [loader, expected] of [[load, ['New mind map', 'New AIM']], [loadHidden, ['New mind map']]]) {
    const { VisualAgentMapView } = loader('main.ts', { obsidian: { ...obsidian, Menu } });
    const view = new VisualAgentMapView({ app: {} }, { repo: {}, settings: { ...DEFAULT_SETTINGS } });
    view.openNewMapMenu({});
    assert.deepEqual(menus.at(-1).items.map(item => item.title), expected);
  }
});

test('aim-hidden: N1 the empty state has no AIM button and the AIM status bar and actions are behind the flag (source level: the paint needs the Obsidian-only activeDocument global)', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /if \(aimEnabled\(\)\) this\.button\(actions, t\("ui\.aim_create_map"\)/);
  assert.doesNotMatch(source, /(?<!aimEnabled\(\)\) )this\.button\(actions, t\("ui\.aim_create_map"\)/);
  assert.match(source, /if \(aimEnabled\(\) && this\.map\?\.aim\) \{\s*const statusbar = this\.contentEl\.createDiv\(`vam-aim-statusbar/);
});

/** An AIM map in the shape an interrupted 0.29 left it, opened by the hidden build: nothing may be written, asked or announced. */
async function openedOldRun(prepare) {
  const vault = hiddenVault();
  const { repo, app, contents, files } = vault;
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'req-run', topic: 'Interrupted', context: '' });
  const mapPath = created.mapPath;
  const doc = await repo.readMap(mapPath);
  const question = await repo.createNote('Question', 'gpt-6-luna', doc, mapPath, 'workspace');
  doc.nodes.push(question); await repo.saveMap(mapPath, doc);
  const store = new AimRunStore(repo);
  await prepare({ repo, mapPath, question, store, contents });
  const snapshot = () => JSON.stringify([...contents].sort());
  const before = snapshot(), paths = JSON.stringify([...files.keys()].sort());
  let writes = 0, asked = 0, notices = 0;
  for (const name of ['process', 'create', 'modify', 'rename', 'createFolder']) { const original = app.vault[name]?.bind(app.vault); if (original) app.vault[name] = async (...args) => { writes++; return original(...args); }; }
  app.workspace = { requestSaveLayout() {} };
  class Notice { constructor() { notices++; } }
  const { VisualAgentMapView } = loadHidden('main.ts', { obsidian: { ...obsidian, Notice } });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), closeStaleDetails() {}, syncOutline() {}, releaseOutline() {}, askModel: async () => { asked++; throw new Error('no AI call while AIM is hidden'); } };
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.hydrate = async () => {};
  await view.openMap(mapPath);
  return { writes, asked, notices, same: snapshot() === before, samePaths: JSON.stringify([...files.keys()].sort()) === paths, view };
}
const quiet = result => { assert.equal(result.writes, 0, 'no vault write'); assert.equal(result.asked, 0, 'no AI call'); assert.equal(result.notices, 0, 'no Notice'); assert.ok(result.same && result.samePaths, 'every file as it was'); };

integrationTest('aim-hidden: E4 opening a map with a running attempt does not fail it, resume it or write', async () => {
  quiet(await openedOldRun(async ({ store, mapPath, question }) => {
    const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'x' }, inputSnapshot: { topic: 'Interrupted', conditions: {}, upstreamResults: [] } });
    await store.startAttempt(mapPath, branch.id, 'run-left-running');
  }));
});

integrationTest('aim-hidden: E4 opening a map with a pending commit does not recover it', async () => {
  quiet(await openedOldRun(async ({ store, mapPath, question, repo }) => {
    const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'x' }, inputSnapshot: { topic: 'Interrupted', conditions: {}, upstreamResults: [] } });
    const attempt = await store.startAttempt(mapPath, branch.id, 'run-pending');
    const draft = (await store.createResultDraft(mapPath, attempt, 'Pending result', 'gpt-6-luna')).draft;
    const saveMap = repo.saveMap.bind(repo); let calls = 0;
    repo.saveMap = async (...args) => { if (++calls === 1) throw new Error('injected interruption after the pending Note write'); return saveMap(...args); };
    await assert.rejects(store.commitResult(mapPath, attempt, draft.id, { summary: 'saved', detail: 'Report.' }), /injected interruption/);
    repo.saveMap = saveMap; store.releaseAttempt(mapPath, attempt);
  }));
});

integrationTest('aim-hidden: E4 opening a map with a question draft or an unfinished creation (synthetic shapes) recovers nothing', async () => {
  quiet(await openedOldRun(async ({ repo, mapPath }) => {
    await repo.updateMap(mapPath, doc => {
      const parent = doc.nodes[0];
      doc.aim.questionDraft = { requestId: 'draft-request', nodeId: 'draft-node', parentId: parent.id, parentBranchId: null, notePath: `${repo.topicRoot(mapPath)}/Notes/Draft question.md`, title: 'Draft question', summary: 'Which one?', detail: 'Pick one.', prompt: 'prompt', model: 'gpt-6-luna', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
      doc.aim.creationId = 'req-run';
      doc.aim.rootDraft = { nodeId: 'draft-root', notePath: `${repo.topicRoot(mapPath)}/Notes/Draft root.md`, title: 'Interrupted', context: '', model: 'gpt-6-luna' };
    });
  }));
});

integrationTest('aim-hidden: an old AIM map still opens with its nodes and shows no AIM status', async () => {
  const result = await openedOldRun(async () => {});
  quiet(result);
  assert.ok(result.view.map.aim, 'the aim block stays in the open map');
  assert.ok(result.view.map.nodes.length >= 2);
});

integrationTest('aim-hidden: D8 a copied or duplicated topic carries no AIM field', async () => {
  const vault = hiddenVault();
  const { repo } = vault;
  const { mapPath, conclusion } = await aimMap(vault);
  const doc = await repo.readMap(mapPath);
  const source = doc.nodes.find(item => item.id === conclusion.id);
  assert.ok(source.aimKind && source.aimConvergesFromNodeIds, 'the source has AIM fields');
  const copy = await repo.duplicateNote(source.path, doc, mapPath, {});
  assert.deepEqual(Object.keys(copy).filter(key => key.startsWith('aim')), []);
});

test('aim-hidden: D11 the share snapshot of an old AIM map has no aim block, no aim fields and no superseded interim result', () => {
  const { doc, topic, conclusion } = aimDoc();
  const interim = node('interim', topic.id); interim.aimKind = 'synthesis';
  doc.nodes.push(interim);
  doc.aim.branches[0].results = [
    { nodeId: interim.id, notePath: interim.path, version: 1, kind: 'synthesis', runId: 'run-1' },
    { nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'conclusion', runId: 'run-1' }
  ];
  const view = viewOf(loadHidden, doc);
  const snapshot = view.shareSnapshot();
  assert.notEqual(typeof snapshot, 'string');
  assert.equal(snapshot.map.aim, undefined);
  assert.equal(snapshot.map.nodes.some(item => item.id === interim.id), false, 'the superseded interim result is not shared');
  assert.equal(snapshot.map.nodes.some(item => Object.keys(item).some(key => key.startsWith('aim'))), false);
  assert.ok(doc.aim && doc.nodes.some(item => item.aimKind), 'the open map itself is untouched');
});
