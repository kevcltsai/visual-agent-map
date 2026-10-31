// A note left at `status: running` by a plugin reload is turned into an error when its map is opened, unless this instance really is running it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const fs = require('node:fs');
const path = require('node:path');

const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-r/Map.md`;
const MODULES = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;
const { classifyProviderError } = load('ai/provider-error.ts');
const { topicStatusLabel } = load('i18n.ts');
const dictionaries = [['en', load('i18n/en.ts').en], ['zh-TW', load('i18n/zh-TW.ts').zhTW], ['zh-CN', load('i18n/zh-CN.ts').zhCN]];
const KEY = 'ui.ai_task_interrupted_by_reload';

async function harness({ count = 1, builtIn = false } = {}) {
  const { repo, app } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-r', title: 'R', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-r`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const n = await repo.createNote(`Topic ${i}`, 'gpt-6-luna', doc, MAP, 'workspace');
    await repo.updateNote(n.path, { summary: `Summary ${i}`, detail: `Detail ${i}`, status: 'running' });
    doc.nodes.push(n); nodes.push(n);
  }
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), pendingSuggestions: new Map(),
    releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, closeStaleDetails() {}, releaseWarmClaude() {},
    mutate: work => (pending = Promise.resolve().then(work))
  });
  plugin.isNoteTaskBusy = p => Plugin.prototype.isNoteTaskBusy.call(plugin, p);
  const view = new VisualAgentMapView({ app }, plugin);
  Object.assign(view, { contentEl: dom.element('div'), stageEl: dom.element('div') });
  view.app.workspace = { requestSaveLayout() {} };
  view.renders = [];
  view.render = () => { view.renders.push(new Map([...view.notes].map(([id, note]) => [id, note.status]))); };
  const text = p => app.vault.read(app.vault.getAbstractFileByPath(p));
  const open = () => view.openMapInMutation(MAP);
  return { repo, app, plugin, view, nodes, text, open, doc };
}
const fm = (content, key) => content.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];

test('N1: a running note nobody runs becomes error with the interrupted message before the first render', async () => {
  const h = await harness();
  await h.open();
  const content = await h.text(h.nodes[0].path);
  assert.equal(fm(content, 'status'), 'error');
  assert.match(fm(content, 'last-error') ?? '', /interrupted/i);
  assert.equal(h.view.renders[0].get(h.nodes[0].id), 'error');
  assert.notEqual(topicStatusLabel(h.view.notes.get(h.nodes[0].id).status, 'en'), 'AI running');
});

test('N2: the card state text is the task error and the reason is on the note the card shows', async () => {
  const h = await harness();
  await h.open();
  const note = h.view.notes.get(h.nodes[0].id);
  assert.equal(topicStatusLabel(note.status, 'en'), dictionaries[0][1]['ui.task_error']);
  assert.equal(note.lastError, dictionaries[0][1][KEY]);
});

test('N3: markInterruptedRun returns true for a running note and leaves summary and detail alone', async () => {
  const h = await harness();
  const before = await h.repo.readNote(h.nodes[0].path);
  assert.equal(await h.repo.markInterruptedRun(h.nodes[0].path, 'boom', () => true), true);
  const after = await h.repo.readNote(h.nodes[0].path);
  assert.equal(after.status, 'error');
  assert.equal(after.lastError, 'boom');
  assert.equal(after.summary, before.summary);
  assert.equal(after.detail, before.detail);
});

const busySources = {
  running: (p, path) => p.running.add(path),
  activeTasks: (p, path) => p.activeTasks.set(path, new AbortController()),
  quickExpandPending: (p, path) => p.quickExpandPending.add(path),
  'expansion batch currentPath': (p, path) => p.expansionBatches.set('parent.md', { parentPath: 'parent.md', status: 'running', currentPath: path, queuedPaths: [] }),
  'expansion batch queuedPaths': (p, path) => p.expansionBatches.set('parent.md', { parentPath: 'parent.md', status: 'running', queuedPaths: [path] }),
  expansionCoordinator: (p, path) => p.expansionBatches.set(path, { parentPath: path, status: 'running', queuedPaths: [] })
};
for (const [name, mark] of Object.entries(busySources)) {
  test(`guard: a note busy through ${name} is not touched`, async () => {
    const h = await harness();
    mark(h.plugin, h.nodes[0].path);
    const before = await h.text(h.nodes[0].path);
    await h.open();
    assert.equal(await h.text(h.nodes[0].path), before);
    assert.equal(h.view.notes.get(h.nodes[0].id).status, 'running');
  });
}

test('guard: a stopped expansion batch does not count as busy', async () => {
  const h = await harness();
  h.plugin.expansionBatches.set('parent.md', { parentPath: 'parent.md', status: 'stopped', currentPath: h.nodes[0].path, queuedPaths: [h.nodes[0].path] });
  await h.open();
  assert.equal(h.view.notes.get(h.nodes[0].id).status, 'error');
});

test('guard: two views on one map, the busy note of the first is kept and the other note is cleaned', async () => {
  const h = await harness({ count: 2 });
  h.plugin.running.add(h.nodes[0].path);
  const other = new VisualAgentMapView({ app: h.app }, h.plugin);
  Object.assign(other, { contentEl: dom.element('div'), stageEl: dom.element('div') }); other.render = () => {};
  await h.open(); await other.openMapInMutation(MAP);
  assert.equal(fm(await h.text(h.nodes[0].path), 'status'), 'running');
  assert.equal(fm(await h.text(h.nodes[1].path), 'status'), 'error');
});

test('race: a task that registers after the read is not overwritten', async () => {
  const h = await harness();
  const result = await h.repo.markInterruptedRun(h.nodes[0].path, 'x', () => !h.plugin.running.has(h.nodes[0].path) && (h.plugin.running.add(h.nodes[0].path), false));
  assert.equal(result, false);
  assert.equal(fm(await h.text(h.nodes[0].path), 'status'), 'running');
});

test('race: a note completed after hydrate is not overwritten', async () => {
  const h = await harness();
  const real = h.view.hydrate.bind(h.view);
  h.view.hydrate = async isCurrent => { await real(isCurrent); await h.repo.updateNote(h.nodes[0].path, { status: 'completed' }); };
  await h.open();
  assert.equal(fm(await h.text(h.nodes[0].path), 'status'), 'completed');
  assert.equal(h.view.notes.get(h.nodes[0].id).status, 'completed');
});

test('race: running added after hydrate is not overwritten', async () => {
  const h = await harness();
  const real = h.view.hydrate.bind(h.view);
  h.view.hydrate = async isCurrent => { await real(isCurrent); h.plugin.running.add(h.nodes[0].path); };
  await h.open();
  assert.equal(fm(await h.text(h.nodes[0].path), 'status'), 'running');
});

test('idempotent: a second open writes nothing', async () => {
  const h = await harness();
  await h.open();
  const after = await h.text(h.nodes[0].path);
  let writes = 0;
  const process = h.app.vault.process;
  h.app.vault.process = async (...args) => { writes++; return process(...args); };
  await h.open();
  assert.equal(writes, 0);
  assert.equal(await h.text(h.nodes[0].path), after);
});

test('notes that are already error or completed are not written', async () => {
  const h = await harness({ count: 2 });
  await h.repo.updateNote(h.nodes[0].path, { status: 'error', lastError: 'old' });
  await h.repo.updateNote(h.nodes[1].path, { status: 'completed' });
  const before = [await h.text(h.nodes[0].path), await h.text(h.nodes[1].path)];
  await h.open();
  assert.deepEqual([await h.text(h.nodes[0].path), await h.text(h.nodes[1].path)], before);
});

test('built-in sample map is not written', async () => {
  const h = await harness();
  h.view.builtIn = true;
  const calls = [];
  h.repo.markInterruptedRun = async (...a) => { calls.push(a); return true; };
  await h.view.recoverInterruptedNotes(() => true);
  assert.equal(calls.length, 0);
});

test('a disposed repository does not stop the map from opening', async () => {
  const h = await harness();
  h.repo.dispose();
  await h.open();
  assert.ok(h.view.renders.length >= 1);
});

test('a failing write does not stop the map from opening', async () => {
  const h = await harness();
  h.repo.markInterruptedRun = async () => { throw new Error('disk'); };
  await h.open();
  assert.ok(h.view.renders.length >= 1);
});

test('the message is not a provider error in any language and exists in all three', () => {
  for (const [name, dict] of dictionaries) {
    assert.ok(dict[KEY], `${name} has ${KEY}`);
    assert.equal(classifyProviderError(dict[KEY]), null, name);
  }
});

test('both writers register the path in plugin.running before they write status running', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const writes = [...source.matchAll(/updateNote\([^)]*\{\s*status:\s*"running"/g)];
  assert.equal(writes.length, 2);
  for (const match of writes) {
    const before = source.slice(Math.max(0, match.index - 3000), match.index);
    assert.match(before, /this\.plugin\.running\.add\(/);
  }
});
