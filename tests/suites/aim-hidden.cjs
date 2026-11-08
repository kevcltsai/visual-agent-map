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
  createSpan(options) { const child = element('span', buttons); child.text = options?.text; child.cls = options?.cls; this.children.push(child); return child; },
  setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, toggleClass() {}, setPointerCapture() {}, addEventListener(name, fn) { if (name === 'click') this.click = fn; }, removeEventListener() {}, appendChild(child) { this.children.push(child); return child; }
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
    // The card tools are icon-only buttons named by aria-label (no More menu).
    return buttons.map(button => button['aria-label'] ?? button.text);
  };
  const shown = render(load), hidden = render(loadHidden);
  assert.equal(shown.includes('AI explore'), false, 'AIM on: generic tools are hidden on an AIM map');
  assert.ok(hidden.includes('Details'));
  assert.ok(shown.includes('Continue exploring'), 'AIM on: the AIM action is there');
  for (const label of ['AI explore', 'This card', 'Add subtopic manually']) assert.ok(hidden.includes(label), label);
  assert.equal(hidden.includes('Continue exploring'), false);
  assert.equal(hidden.some(label => /Steer|Correct|new question|Answer|Retry|Start|Continue|Resume|direction/i.test(label ?? '')), false, 'no AIM action');
});

integrationTest('aim-hidden: with AIM hidden the New map button makes the map at once (no one-row menu, no name dialog); with AIM on the menu lists both', () => {
  const menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { title: '', setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, onClick() { return this; } }; callback(item); this.items.push(item); return this; } addSeparator() {} showAtMouseEvent() {} showAtPosition() {} setNoIcon() { return this; } }
  for (const [loader, expected] of [[load, ['New mind map', 'New AIM']], [loadHidden, []]]) {
    const { VisualAgentMapView } = loader('main.ts', { obsidian: { ...obsidian, Menu } });
    const view = new VisualAgentMapView({ app: {} }, { repo: {}, settings: { ...DEFAULT_SETTINGS } });
    let direct = 0; view.openNewMindMapModal = () => { direct++; };
    const before = menus.length;
    view.openNewMapMenu({});
    if (expected.length) assert.deepEqual(menus.at(-1).items.map(item => item.title), expected);
    else { assert.equal(menus.length, before, 'no menu'); assert.equal(direct, 1, 'the map is made directly'); }
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

// ---- The plugin shell: commands, workspace, settings, note styles, text --------------------------------------------
const dom = require('../support-dom.cjs');
/** Loads the plugin the way steps-note-style-onload.cjs does and records the commands it registers and the folders it creates. */
async function onloadShell(loader, saved) {
  const commands = [], folders = [], writes = [];
  const record = (name, sink) => (...args) => { sink?.push(args[0]); writes.push([name, args[0]]); return Promise.resolve(); };
  const Main = loader('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice([]) } });
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

integrationTest('aim-hidden: N1 the command palette has no AIM command; with AIM on it does', async () => {
  const shown = await onloadShell(load, { migrated: true, structureVersion: 2, workspaceInitialized: true });
  const hidden = await onloadShell(loadHidden, { migrated: true, structureVersion: 2, workspaceInitialized: true });
  assert.ok(shown.commands.some(command => command.id === 'create-mindsearch-map'), 'AIM on: the command exists');
  assert.equal(hidden.commands.some(command => command.id === 'create-mindsearch-map'), false);
  assert.equal(hidden.commands.some(command => /AIM|Adaptive Inquiry/i.test(command.name)), false, 'no command name mentions AIM');
  assert.ok(hidden.commands.some(command => command.id === 'open-map'), 'the other commands are still there');
  assert.equal(hidden.commands.length, shown.commands.length - 1);
});

integrationTest('aim-hidden: N2 a first install and a workspace repair create Mind Maps and never the AIM folder', async () => {
  const fresh = await onloadShell(loadHidden, null);
  assert.ok(fresh.folders.includes('Agent Workspace/Mind Maps'), 'the first install creates Mind Maps');
  assert.equal(fresh.folders.some(path => /\/AIM(\/|$)/.test(path)), false, 'first install: no AIM folder');
  const repaired = await onloadShell(loadHidden, { migrated: true, structureVersion: 2, workspaceInitialized: false });
  repaired.folders.length = 0;
  await repaired.plugin.repairWorkspace();
  assert.ok(repaired.folders.includes('Agent Workspace/Mind Maps'));
  assert.equal(repaired.folders.some(path => /\/AIM(\/|$)/.test(path)), false, 'repair: no AIM folder');
  const control = await onloadShell(load, null);
  assert.ok(control.folders.includes('Agent Workspace/AIM'), 'AIM on: the same first install does create it');
});

function settingsRows(loader, recipes) {
  const { VisualAgentMapSettingTab } = loader('ui/settings-tab.ts', { obsidian: { ...obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: class {} } });
  const plugin = { settings: { cliModel: 'm', language: 'en' }, subscribeModelDiscovery: () => () => {}, subscribeCurrentModel: () => () => {},
    codexDiagnostic: () => ({ installed: true, executable: 'codex' }), claudeDiagnostic: () => ({ installed: true, executable: 'claude' }), noteStyles: { listRecipes: () => recipes } };
  const flatten = items => items.flatMap(item => (item.type === 'group' || item.type === 'page') ? [item, ...flatten(item.items || [])] : [item]);
  return flatten(new VisualAgentMapSettingTab({}, plugin).getSettingDefinitions());
}
const recipesWithAim = [
  { ref: 'builtin:general', name: 'General research', kind: 'builtin', structure: { name: 'S' }, voice: { name: 'V' }, format: { name: 'F' }, update: 'rewrite', issues: [], usedByKinds: ['topic', 'aim'] },
  { ref: 'builtin:aim', name: 'AIM report', kind: 'builtin', aimOnly: true, structure: { name: 'S' }, voice: { name: 'V' }, format: { name: 'F' }, update: 'rewrite', issues: [], usedByKinds: ['aim'] }
];

test('aim-hidden: N1 the settings have no AIM maps folder row and no AIM note style row; with AIM on both are there', () => {
  const names = loader => settingsRows(loader, recipesWithAim).map(row => row.name ?? row.heading).filter(Boolean);
  const shown = names(load), hidden = names(loadHidden);
  assert.ok(shown.includes('AIM folder') && shown.includes('AIM conclusion note'), `AIM on: ${shown.join(' | ')}`);
  assert.equal(hidden.some(name => /AIM|Adaptive/i.test(name)), false, hidden.filter(name => /AIM/.test(name)).join(' | '));
  assert.ok(hidden.includes('Mind maps folder') || hidden.some(name => /Mind Maps? folder/i.test(name)), 'the Mind Maps folder row stays');
  assert.equal(hidden.length, shown.length - 2);
});

test('aim-hidden: N1 the note style manager lists no AIM report and names no AIM kind', () => {
  const entries = loader => {
    const { NoteStyleManageModal } = loader('ui/modals/note-style-manage-modal.ts', { obsidian: { ...obsidian, Modal: class {}, Setting: class {} } });
    const modal = Object.create(NoteStyleManageModal.prototype);
    modal.tab = 'recipe'; modal.plugin = { noteStyles: { listRecipes: () => recipesWithAim, listParts: () => [] } };
    return modal.entries();
  };
  const shown = entries(load), hidden = entries(loadHidden);
  assert.deepEqual(shown.map(entry => entry.name), ['General research', 'AIM report']);
  assert.deepEqual(hidden.map(entry => entry.name), ['General research']);
  assert.equal(JSON.stringify(hidden).includes('AIM'), false, 'the used-by list does not name the AIM kind');
});

test('aim-hidden: E4 the notice line has the agreed text in three languages and is a plain line without a button', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.aim_paused_notice'), '這張圖是用 AIM 建的。AIM 這一版先暫停，未完成的研究會停在這裡；內容都能照常編輯。');
  assert.equal(translate('zh-CN', 'ui.aim_paused_notice'), '这张图是用 AIM 建的。AIM 这一版先暂停，未完成的研究会停在这里；内容都能照常编辑。');
  assert.match(translate('en', 'ui.aim_paused_notice'), /^This map was built with AIM\. AIM is paused in this version;/);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const start = source.indexOf('if (!aimEnabled() && this.map?.aim)');
  assert.ok(start > 0, 'the line is drawn only while AIM is hidden and the map has an aim block');
  const statement = source.slice(start, source.indexOf(';', start) + 1);
  assert.match(statement, /createDiv\(\{[^}]*text: t\("ui\.aim_paused_notice"\)/);
  assert.doesNotMatch(statement, /button|click/i);
});

test('aim-hidden: N1 the text a new user can reach names no AIM: the hidden-variant strings are used and carry no AIM wording', () => {
  const { translate } = load('i18n.ts');
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    for (const key of ['ui.organize_preview_hidden_0_1_2', 'ui.map_chat_line_cards_skipped_hidden_0']) assert.doesNotMatch(translate(language, key, 1, 2, 'x'), /AIM|Adaptive/i, `${language} ${key}`);
  }
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(main, /aimEnabled\(\)\s*\? t\(\s*"ui\.organize_preview_0_1_2_3_4"[\s\S]*?: t\("ui\.organize_preview_hidden_0_1_2"/);
  const view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view, /aimEnabled\(\) \? "ui\.map_chat_line_cards_skipped_0" : "ui\.map_chat_line_cards_skipped_hidden_0"/);
});

// ---- Fix batch R1: goal grading, colour/style, status chip, display parity ------------------------------------------
const spans = el => [el, ...el.children.flatMap(spans)];

integrationTest('aim-hidden: B1 map chat rate_by_goal on a hidden AIM map is skipped: no AI call, no goal, no write', async () => {
  const { doc } = aimDoc();
  let asked = 0, writes = 0;
  const grades = new Map();
  const make = loader => {
    const view = viewOf(loader, doc, { relevanceGrades: grades, askModel: async () => { asked++; throw new Error('no AI call'); }, mutate: async work => { writes++; return work(); } });
    view.refreshRelevance = () => {};
    return view;
  };
  const action = { kind: 'run_map_action', action: 'rate_by_goal', goal: 'Find the best option', nodeIds: [], title: '', direction: '', mode: '', images: false };
  for (const loader of [loadHidden, load]) {
    const view = make(loader);
    const outcome = await view.runChatSelection(action);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(outcome.status, 'skipped', 'goal grading is off for a map with an aim block');
    assert.equal(view.relevanceGradeable(), false);
  }
  assert.equal(asked, 0, 'no AI call');
  assert.equal(writes, 0, 'no frontmatter or map write');
  assert.equal(grades.size, 0, 'no grading run started');
});

test('aim-hidden: M1 a hidden-mode AIM card paints its colour and style choices (the AIM-on card still does not)', () => {
  const { doc, conclusion } = aimDoc();
  const render = loader => {
    const calls = [], view = viewOf(loader, doc);
    view.stageEl = element('stage', []);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
    for (const name of ['paintCardColor', 'paintCardStyle']) { const original = view[name].bind(view); view[name] = (card, note, aim) => { calls.push([name, aim]); return original(card, note, aim); }; }
    view.renderNode(conclusion);
    return calls;
  };
  assert.deepEqual(render(loadHidden), [['paintCardColor', false], ['paintCardStyle', false]], 'hidden: colour and style are painted');
  assert.deepEqual(render(load), [['paintCardColor', true], ['paintCardStyle', true]], 'AIM on: unchanged');
});

test('aim-hidden: M2 a question card shows no AIM status chip while AIM is hidden, whatever its run state', () => {
  const chips = (loader, state) => {
    const { doc, topic } = aimDoc();
    const question = node('question', 'topic'); question.aimKind = 'question'; doc.nodes.push(question);
    if (state === 'completed') doc.aim.branches.push({ ...doc.aim.branches[0], id: 'q', questionNodeId: question.id, parentBranchId: 'branch' });
    const view = viewOf(loader, doc);
    if (state === 'running') view.aimActiveQuestionNodeId = question.id;
    view.stageEl = element('stage', []);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
    const found = [];
    for (const target of [question, topic]) { view.stageEl.children.length = 0; view.renderNode(target); found.push(...spans(view.stageEl).filter(item => /vam-aim-question-status/.test(item.cls ?? ''))); }
    return found;
  };
  for (const state of ['running', 'awaiting', 'completed']) {
    assert.equal(chips(loadHidden, state).length, 0, `hidden, ${state}: no chip`);
    assert.ok(chips(load, state).length > 0, `AIM on, ${state}: the chip is still there`);
  }
});

test('aim-hidden: P1 the topic status pill rule from main (idea shows none, researched shows one) applies to a hidden AIM card too', () => {
  const pills = (loader, status) => {
    const { doc } = aimDoc();
    const research = node('research', 'topic'); research.aimKind = 'research'; doc.nodes.push(research);
    const view = viewOf(loader, doc);
    view.stageEl = element('stage', []);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: item.id === research.id ? status : 'completed', detail: '' }]));
    view.renderNode(research);
    return spans(view.stageEl).filter(item => /vam-status\b/.test(item.cls ?? '')).length;
  };
  assert.equal(pills(loadHidden, 'idea'), 0, 'hidden, idea: no pill, like any plain topic');
  assert.equal(pills(loadHidden, 'completed'), 1, 'hidden, researched: a pill, like any plain topic');
  assert.equal(pills(load, 'idea'), 1, 'AIM on, idea: AIM keeps its own rule');
  assert.equal(pills(load, 'completed'), 0, 'AIM on, researched: AIM keeps its own rule');
});

test('aim-hidden: E3 display parity: the same map shows the same nodes with the flag on and off', () => {
  const { doc, conclusion } = aimDoc();
  const interim = node('interim', 'topic'); interim.aimKind = 'result'; doc.nodes.push(interim); // an interim result its run's conclusion has replaced
  doc.aim.branches[0].results = [{ nodeId: interim.id, notePath: interim.path, version: 1, kind: 'synthesis', runId: 'run' }, { nodeId: conclusion.id, notePath: conclusion.path, version: 1, kind: 'conclusion', runId: 'run' }];
  const canvas = loader => viewOf(loader, doc).canvasNodes().map(item => item.id).sort();
  const supersededOn = [...load('map-model.ts').supersededAimNodeIds(doc)].sort(), supersededOff = [...hiddenCore.supersededAimNodeIds(doc)].sort();
  assert.deepEqual(supersededOff, supersededOn, 'supersededAimNodeIds is flag-independent');
  assert.ok(supersededOn.length > 0, 'the fixture does supersede a node');
  assert.deepEqual(canvas(loadHidden), canvas(load));
});

// ---- Fix batch R3: hidden-mode colour/border selectors, aim block after a delete ----------------------------------
test('aim-hidden: R3 the hidden marker class is on an AIM card only while AIM is hidden', () => {
  const classesOf = (loader, pick) => {
    const { doc, ...nodes } = aimDoc(), view = viewOf(loader, doc), added = [];
    view.stageEl = element('stage', []);
    const make = parent => { const create = parent.createDiv.bind(parent); parent.createDiv = options => { const child = create(options); const addClass = child.addClass; child.addClass = name => { added.push([child['data-node-id'] ?? child, name]); addClass.call(child, name); }; make(child); return child; }; };
    make(view.stageEl);
    view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed', detail: '' }]));
    view.renderNode(nodes[pick]);
    return added.map(([, name]) => name);
  };
  assert.ok(classesOf(loadHidden, 'conclusion').includes('vam-aim-hidden'), 'hidden: an AIM card carries the marker');
  assert.ok(classesOf(loadHidden, 'topic').includes('vam-aim-hidden'));
  assert.equal(classesOf(load, 'conclusion').includes('vam-aim-hidden'), false, 'AIM on: no marker');
  assert.equal(classesOf(load, 'topic').includes('vam-aim-hidden'), false);
  const view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view, /if \(node\.aimKind && !aimEnabled\(\)\) card\.addClass\("vam-aim-hidden"\)/);
});

test('aim-hidden: R3 the colour, style and border selectors match a hidden AIM card; the AIM-on selectors still exclude it', () => {
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

test('aim-hidden: R4 a coloured hidden question card keeps its diamond; no hidden ::before rule turns it into a stripe', () => {
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

integrationTest('aim-hidden: R3 decision 5 deleting a node whose note moves to Unassigned changes the aim block only by the moved notePath values', async () => {
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const vault = hiddenVault();
  const { repo, contents, mapPath, conclusion } = await aimMap(vault);
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
