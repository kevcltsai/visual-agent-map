// V3.3 G08 / P5.7: the hypothesis-research (argument map) Beta is hidden. experimentalArgumentMap defaults to off and has no settings toggle.
// With it off: a map saved by the Beta still loads, reads and renders and a save without edits keeps its argument data byte for byte;
// and no card action, palette command or map-chat action offers to create an argument map. With it on the entry exists (positive control).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');

const root = path.resolve(__dirname, '..');
const machine = support.load('core/argument-map/machine.ts');
const card = support.load('experiences/visual-map/argument-card.ts');
const actions = support.load('experiences/visual-map/card-actions.ts', { obsidian: { ...support.obsidian, Platform: { isMacOS: false } } });
const chatStep = support.load('core/steps/map-chat/step.ts', { obsidian: support.obsidian });
const MAP = 'Agent Workspace/Topics/map-pv1/Map.md';
const SPEC = [['P', null], ['S', 'P'], ['C', 'P'], ['V', 'C'], ['E', 'C'], ['H', 'V'], ['N', 'H']];
// The text an argument-creating entry would carry, in the three languages the plugin ships.
const el = (tag, o = {}) => { const n = { tag, cls: o.cls, text: o.text, attrs: {}, listeners: {}, children: [], dataset: {} }; n.createDiv = x => { const c = el('div', x); n.children.push(c); return c; }; n.createSpan = x => { const c = el('span', x); n.children.push(c); return c; }; n.createEl = (tg, x) => { const c = el(tg, x); n.children.push(c); return c; }; n.setAttr = (k, v) => { n.attrs[k] = v; }; n.addEventListener = (type, fn) => { (n.listeners[type] ??= []).push(fn); }; return n; };
const flatten = root => { const flat = []; const walk = n => { flat.push(n); n.children.forEach(walk); }; walk(root); return flat; };
const ARGUMENT_ENTRY = /argument|hypothesis[ -]research|假設研究|假设研究/i;

// A legacy Beta map: the argument state as the research flow stored it (machine.newArgumentMap plus a hypothesis with a need), inside the map file serializeMap writes.
async function legacyMap(settings = {}) {
  const { repo, app, contents } = support.fixture('en', { linkIndex: true });
  repo.settings = { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', ...settings };
  const mapDoc = { id: 'map-pv1', title: 'PV1', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-pv1');
  const byTitle = new Map();
  for (const [title, parentTitle] of SPEC) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x: 0, y: 0 });
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  const id = title => byTitle.get(title).id;
  const state = machine.newArgumentMap({ proposition: id('P'), situation: id('S'), conclusion: id('C'), verified: id('V'), eliminated: id('E') }, 'run-1');
  state.hypotheses.push({ id: id('H'), citedData: [], round: 1, location: 'verifying', needs: [{ id: id('N'), text: 'n', addedRound: 1, state: 'pending' }] });
  mapDoc.argumentMap = state;
  const saved = support.core.serializeMap(mapDoc);
  await app.vault.create(MAP, saved);
  await repo.rebuildDerivedData();
  return { repo, app, contents, id, saved, expected: JSON.parse(JSON.stringify(state)) };
}

async function viewOn(h, settings) {
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg: dom.createSvg, requestAnimationFrame: () => 0 });
  const plugin = support.withExpansionCoordinator({
    repo: h.repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => h.repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(),
    releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, mutate: work => Promise.resolve().then(work)
  });
  const view = new VisualAgentMapView({ app: h.app }, plugin);
  view.path = MAP; view.map = await h.repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await h.repo.readNote(n.path)])));
  const edges = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  view.edgesEl = edges; view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  for (const [title] of SPEC) view.cardEls.set(h.id(title), { offsetLeft: 100, offsetTop: 40, offsetWidth: 300, offsetHeight: 80 });
  return { view, edges, VisualAgentMapView };
}

test('P5.7 default: the switch is off with nothing in the settings, and the settings tab has no toggle for it', () => {
  assert.equal(support.DEFAULT_SETTINGS.experimentalArgumentMap, false);
  const { settingsFromSaved } = support.load('settings-from-saved.ts');
  assert.equal(settingsFromSaved({}).experimentalArgumentMap, false);
  const files = fs.readdirSync(path.join(root, 'ui'), { recursive: true }).filter(name => /settings.*\.ts$/.test(String(name)));
  assert.ok(files.length > 0, 'control: the settings sources were found');
  for (const file of files) assert.equal(fs.readFileSync(path.join(root, 'ui', String(file)), 'utf8').includes('experimentalArgumentMap'), false, `${file} has no toggle`);
});

test('P5.7 read: a Beta argument map loads with the switch off and every field is kept', async () => {
  const h = await legacyMap();
  const map = await h.repo.readMap(MAP);
  assert.deepEqual(support.plain(map.argumentMap), h.expected, 'the argument state read back equals what the Beta stored');
  assert.equal(map.nodes.length, SPEC.length);
  assert.ok(map.argumentMap.hypotheses.length === 1 && map.argumentMap.hypotheses[0].needs.length === 1, 'control: the fixture really holds a hypothesis with a need');
});

test('P5.7 round trip: a save without edits keeps the argument data byte for byte, and the whole file too', async () => {
  const h = await legacyMap();
  const before = h.contents.get(MAP);
  const argumentText = text => JSON.stringify(support.plain(support.core.parseMap(text).argumentMap));
  await h.repo.saveMap(MAP, await h.repo.readMap(MAP));
  const after = h.contents.get(MAP);
  assert.equal(argumentText(after), argumentText(before));
  assert.equal(after, before, 'nothing else in the file moved either');
  assert.ok(after.includes('run-1'), 'control: the argument block is in the file text');
});

test('P5.7 render: with the switch off the argument cards and arrows still render, with no re-run or resume action', async () => {
  const h = await legacyMap();
  const { view, edges } = await viewOn(h, { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' });
  assert.equal(view.plugin.settings.experimentalArgumentMap, false);
  assert.equal(view.argumentCardView(h.id('H')).role, 'hypothesis', 'the managed card is still recognised');
  view.drawEdges();
  assert.equal(edges.children.filter(c => c.classes.includes('vam-argument-tip')).length, 3, 'the argument arrowheads are drawn');
  // What renderNode hands to renderArgumentCardBody with the switch off (view.ts: argumentEnabled(...) ? argumentView : { ...argumentView, action: undefined, resume: undefined }).
  for (const title of ['P', 'C', 'V', 'H']) {
    const argumentView = view.argumentCardView(h.id(title));
    const body = el('div');
    card.renderArgumentCardBody(body, { ...argumentView, action: undefined, resume: undefined }, () => assert.fail('re-run'), () => assert.fail('resume'));
    const flat = flatten(body);
    assert.equal(body.dataset.argumentRole, argumentView.role, `${title}: the card is drawn as its argument role`);
    assert.ok(flat.length > 1, `${title}: the card has content`);
    assert.equal(flat.filter(n => n.tag === 'button').length, 0, `${title}: no button`);
  }
  // Control: the same card with an action does draw a button, so the check above can see one.
  const withAction = el('div');
  card.renderArgumentCardBody(withAction, { ...view.argumentCardView(h.id('C')), action: { label: 'Re-run', ariaLabel: 'Re-run' } }, () => {}, () => {});
  assert.equal(flatten(withAction).filter(n => n.tag === 'button').length, 1);
});

test('P5.7 card actions: no action of any surface and context is about an argument map; with the switch on there is none either (the entry is the opening screen tab)', () => {
  const nodes = [
    { id: 'a', parentId: null, path: 'a.md', collapsed: false }, { id: 'b', parentId: 'a', path: 'b.md', collapsed: false },
    { id: 'ai', parentId: null, path: 'ai.md', collapsed: false }, { id: 'd', parentId: null, path: 'd.md', collapsed: false }
  ];
  const ctx = (target, state, argumentCard) => {
    const single = typeof target === 'string' ? nodes.find(n => n.id === target) : null;
    const notes = { a: { prompt: '' }, b: { prompt: '' }, d: { prompt: '' }, ai: { prompt: 'go', aiCard: true } };
    if (state === 'aiLocked') for (const id of Object.keys(notes)) notes[id] = { ...notes[id], aiLocked: true };
    return {
      node: single, ids: single ? [single.id] : Array.isArray(target) ? target : [], nodes, presentation: state === 'presentation', readOnly: state === 'readOnly',
      multiSelect: state === 'multiSelect' || Array.isArray(target), bookLock: { ai: state === 'bookAi', structure: state === 'bookStructure' },
      hasViewport: true, managedMap: true, emptyCanvas: false, branchFocused: false, knowledgeRefs: { editable: false, copied: false }, note: id => notes[id],
      isMerging: () => state === 'merging', titles: list => list.join(', '), isArgumentCard: () => argumentCard, summaryFieldOffered: () => true, stylesEditable: true,
      aiRunning: () => false, bookMenu: () => true, mergeBlock: () => null, multiResearchRunning: () => false, runAllWorking: () => false, host: new Proxy({}, { get: () => () => {} })
    };
  };
  let seen = 0;
  const check = (surface, c) => {
    for (const entry of actions.actionsFor(surface, c)) {
      seen++;
      for (const text of [entry.action.id, entry.action.titleKey, entry.action.icon ?? '']) assert.doesNotMatch(String(text), ARGUMENT_ENTRY, `${surface}: ${entry.action.id}`);
    }
  };
  for (const state of ['normal', 'readOnly', 'merging', 'aiLocked', 'presentation', 'multiSelect', 'bookAi', 'bookStructure'])
    for (const surface of ['context', 'more', 'toolbar', 'command'])
      for (const target of ['a', 'ai', null, ['a', 'd']])
        for (const argumentCard of [false, true]) check(surface, ctx(target, state, argumentCard));
  assert.ok(seen > 50, `control: the registry offered ${seen} entries to look at`);
  for (const action of actions.CARD_ACTIONS) assert.doesNotMatch(`${action.id} ${action.titleKey}`, ARGUMENT_ENTRY, action.id);
  for (const command of actions.CARD_COMMANDS) assert.doesNotMatch(command.commandId, ARGUMENT_ENTRY);
  assert.match('research-argument', ARGUMENT_ENTRY, 'control: the detector sees an argument entry');
});

async function commandsFor(saved) {
  const { default: Plugin } = support.load('main.ts', { obsidian: { ...support.obsidian, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
  const bare = new Plugin();
  const plugin = new Proxy(bare, { get: (target, key, receiver) => key in target || typeof key !== 'string' || !/^(register|add)/.test(key) ? Reflect.get(target, key, receiver) : () => ({ setAttribute() {}, addClass() {}, addEventListener() {} }) });
  const commands = [];
  plugin.manifest = { id: 'visual-agent-map', version: '0.0.0-test', dir: '' };
  const vault = {
    adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }), read: async () => '', write: async () => {}, mkdir: async () => {} },
    getAbstractFileByPath: () => null, read: async () => '', getMarkdownFiles: () => [], getFiles: () => [], getAllLoadedFiles: () => [], getRoot: () => ({ children: [] }), on: () => ({}),
    create: async () => {}, createFolder: async () => {}, modify: async () => {}, process: async () => {}, rename: async () => {}, trash: async () => {}, delete: async () => {}
  };
  plugin.app = { vault, fileManager: { trashFile: async () => {}, renameFile: async () => {} }, metadataCache: { on: () => ({}), getFileCache: () => null },
    workspace: { onLayoutReady: callback => callback(), on: () => ({}), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true }, loadLocalStorage: () => null, saveLocalStorage() {} };
  plugin.loadData = async () => ({ migrated: true, structureVersion: 2, workspaceInitialized: true, noteStylesFolder: 'WS/Styles', ...saved });
  plugin.saveData = async () => {};
  plugin.addCommand = command => { commands.push(command); return command; };
  await plugin.onload(); await plugin.ready; await new Promise(resolve => setImmediate(resolve));
  const settings = bare.settings;
  bare.onunload();
  return { commands, settings };
}

test('P5.7 command palette: the commands main.ts registers include none that creates an argument map, with the switch off or on', async () => {
  const off = await commandsFor({});
  assert.equal(off.settings.experimentalArgumentMap, false);
  const on = await commandsFor({ experimentalArgumentMap: true });
  assert.equal(on.settings.experimentalArgumentMap, true, 'control: the saved switch reaches the plugin');
  assert.ok(off.commands.length > 10 && off.commands.some(c => c.id === 'open-map'), 'control: the palette was registered');
  for (const { commands } of [off, on])
    for (const command of commands) assert.doesNotMatch(`${command.id} ${command.name}`, ARGUMENT_ENTRY, command.id);
  assert.equal(off.commands.map(c => c.id).sort().join(), on.commands.map(c => c.id).sort().join(), 'the switch adds or removes no command');
});

test('P5.7 map chat: no action kind, run action, schema or prompt offers to start an argument map (the chat cannot start it with the switch on either)', () => {
  const kinds = [...chatStep.MAP_CHAT_ACTION_KINDS, ...chatStep.MAP_RUN_ACTIONS];
  assert.ok(kinds.includes('set_topic_kind') && kinds.includes('research_standard'), 'control: the lists were read');
  for (const kind of kinds) assert.doesNotMatch(kind, ARGUMENT_ENTRY, kind);
  const schema = JSON.stringify(support.plain(chatStep.MAP_CHAT_SCHEMA));
  assert.doesNotMatch(schema, ARGUMENT_ENTRY, 'the response schema');
  for (const file of ['prompt.en.md', 'prompt.zh.md', 'steer.en.md']) {
    const text = fs.readFileSync(path.join(root, 'core/steps/map-chat', file), 'utf8');
    assert.ok(text.length > 100, `control: ${file} was read`);
    assert.doesNotMatch(text, ARGUMENT_ENTRY, file);
  }
  assert.match('{"kind":"start_argument"}', ARGUMENT_ENTRY, 'control: the detector sees an argument kind');
});

test('P5.7 counter-check: with the switch on, the map chat host offers the research tab entry, and a map is still readable', async () => {
  const h = await legacyMap();
  const flag = async on => {
    const { view, VisualAgentMapView } = await viewOn(h, { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', experimentalArgumentMap: on });
    view.chatSelectionIds = () => [];
    return typeof VisualAgentMapView.prototype.chatHost.call(view).startArgumentResearch;
  };
  assert.equal(await flag(true), 'function', 'on: the entry exists');
  assert.equal(await flag(false), 'undefined', 'off: the entry is gone');
});
