// AI lock (owner request 2026-11-04): `ai-locked: true` on a topic note forbids AI-initiated writes to the topic and its
// relations. Ticket 02: reader, writer, the shared helper, the inspector toggle and card button, and research refused
// before any provider call and fenced at write time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns, startResearch, until } = S;

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const lock = S.load('core/ai-lock.ts');
const values = S.load('note-values.ts');
const { t } = S.load('i18n.ts');
const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const LOCKED_NOTICE = /議題已鎖定，AI 不會修改|Topic is locked; AI will not change it/;

// ---- the pure helper --------------------------------------------------------------------------------------------------
const tree = () => ({
  nodes: [
    { id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'a1', parentId: 'a' }, { id: 'b', parentId: 'root' }, { id: 'c', parentId: null }
  ],
  topicRelations: [{ kind: 'supports', from: 'c', to: 'b' }]
});
const notesOf = locked => new Map(['root', 'a', 'a1', 'b', 'c'].map(id => [id, locked.includes(id) ? { aiLocked: true } : {}]));

test('helper: nothing locked never blocks', () => {
  for (const op of ['write', 'addChild', 'remove', 'move']) assert.equal(lock.aiLockBlock(op, ['a', 'b', 'c'], tree(), notesOf([]), { to: 'root' }), null, op);
  assert.equal(lock.mapHasAiLock(tree(), notesOf([])), false);
  assert.equal(lock.mapHasAiLock(tree(), notesOf(['a1'])), true);
});

test('helper: a locked target refuses every op; write and addChild look only at the target', () => {
  for (const op of ['write', 'addChild', 'remove', 'move']) assert.equal(lock.aiLockBlock(op, ['a'], tree(), notesOf(['a'])), 'locked', op);
  assert.equal(lock.aiLockBlock('write', ['a1'], tree(), notesOf(['a'])), null, 'a locked parent does not lock its child note');
  assert.equal(lock.aiLockBlock('addChild', ['a1'], tree(), notesOf(['a'])), null);
});

test('helper: removing or moving a direct child of a locked topic is refused', () => {
  assert.equal(lock.aiLockBlock('remove', ['a1'], tree(), notesOf(['a'])), 'lockedParent');
  assert.equal(lock.aiLockBlock('move', ['a1'], tree(), notesOf(['a']), { to: 'b' }), 'lockedParent');
  assert.equal(lock.aiLockBlock('move', ['b'], tree(), notesOf(['a']), { to: 'a' }), 'lockedParent', 'moving under a locked topic adds it a child');
  assert.equal(lock.aiLockBlock('move', ['b'], tree(), notesOf(['a']), { to: 'c' }), null);
});

test('helper: removing a subtree with a locked topic, or a topic related to a locked one, is refused', () => {
  assert.equal(lock.aiLockBlock('remove', ['a'], tree(), notesOf(['a1'])), 'lockedDescendant');
  assert.equal(lock.aiLockBlock('remove', ['c'], tree(), notesOf(['b'])), 'lockedRelation');
  assert.equal(lock.aiLockBlock('remove', ['b'], tree(), notesOf(['c'])), 'lockedRelation', 'relations count in both directions');
  assert.equal(lock.aiLockBlock('remove', ['c'], tree(), notesOf(['a'])), null);
  assert.equal(lock.aiLockBlock('remove', ['x'], tree(), notesOf(['a'])), null, 'an id off the map checks only itself');
  assert.equal(lock.aiLockBlock('write', ['a'], tree(), id => id === 'a'), 'locked', 'a function answers the lock too');
});

// ---- reader and writer ------------------------------------------------------------------------------------------------
test('reader: only `ai-locked: true` locks; anything else reads as unlocked', () => {
  assert.equal(values.readAiLocked({ 'ai-locked': true }), true);
  for (const value of [undefined, false, 'true', 1, null]) assert.equal(values.readAiLocked({ 'ai-locked': value }), false, String(value));
});

async function harness(titles = ['A', 'B'], plugin = {}) {
  const { repo, app, contents } = fixture('zh-TW');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const nodes = [];
  for (const title of titles) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    await repo.updateNote(created.path, { prompt: `Research ${title}` });
    mapDoc.nodes.push(created);
    nodes.push(created);
  }
  await repo.saveMap(MAP, mapDoc);
  const calls = [], notices = [];
  let gate = null;
  const reply = { summary: 'AI summary', detail: 'AI detail', visualReferences: [], suggestions: [] };
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(),
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {},
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [],
    mutate: async work => work(),
    confirmAiUsage: async (_model, run) => { await run(); return true; },
    askModel: async (context, model, _reasoning, signal, _exchange, accepted) => {
      calls.push({ title: context.title, model });
      accepted?.();
      if (gate) await new Promise((resolve, reject) => { gate.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); });
      return reply;
    },
    ...plugin
  });
  repo.settings = host.settings;
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate, ancestorContext: async () => '', queueCharts() {} });
  await hydrate();
  const raw = node => contents.get(node.path);
  return { repo, app, contents, view, host, nodes, calls, notices, raw, hold: () => { gate = []; return gate; } };
}
const research = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };

test('writer: writeAiLocked adds and removes only `ai-locked`; readNote reads it as aiLocked', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  const before = h.raw(a);
  assert.equal((await h.repo.readNote(a.path)).aiLocked, undefined, 'absent = unlocked, no key on the note');
  await h.repo.writeAiLocked(a.path, true);
  assert.match(h.raw(a), /^ai-locked: true$/m);
  assert.equal((await h.repo.readNote(a.path)).aiLocked, true);
  assert.equal(h.raw(a).replace(/^ai-locked: true\n/m, ''), before, 'no other byte changes');
  await h.repo.writeAiLocked(a.path, false);
  assert.equal(h.raw(a), before, 'unlock removes the key and restores the note byte for byte');
});

// ---- research ---------------------------------------------------------------------------------------------------------
test('research on a locked topic is refused before any provider call and writes nothing', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  await h.repo.writeAiLocked(a.path, true);
  const before = h.raw(a);
  const failures = [];
  const handle = await startResearch(h.host, a, { map: h.view.map, failed: message => failures.push(message), request: { task: 'go', ...research } });
  assert.equal(handle, null);
  assert.equal(h.calls.length, 0, 'provider calls: 0');
  assert.equal(h.raw(a), before, 'not even the running status is written');
  assert.equal(failures.length, 1); assert.match(failures[0], LOCKED_NOTICE);
  assert.equal(h.host.topicRuns.isRunning(a.path), false);
});

test('an unlocked topic still researches and writes as before', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  const handle = await startResearch(h.host, a, { map: h.view.map, request: { task: 'go', ...research } });
  await handle.finished;
  assert.equal(h.calls.length, 1);
  const note = await h.repo.readNote(a.path);
  assert.equal(note.summary, 'AI summary'); assert.equal(note.status, 'completed');
});

test('late fence: a topic locked while the AI runs gets no write and its status does not stay running', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  const gate = h.hold();
  const failures = [];
  const handle = await startResearch(h.host, a, { map: h.view.map, failed: message => failures.push(message), request: { task: 'go', ...research } });
  await until(() => gate.length === 1);
  assert.equal((await h.repo.readNote(a.path)).status, 'running');
  // Locked straight in the note (another device, a hand edit): no Stop, only the fence inside the write.
  await h.repo.writeAiLocked(a.path, true);
  gate[0]();
  await handle.finished;
  const note = await h.repo.readNote(a.path);
  assert.notEqual(note.summary, 'AI summary', 'the result is not written');
  assert.equal(note.status, 'idea', 'status is back to what it was');
  assert.ok(failures.some(message => LOCKED_NOTICE.test(message)));
});

test('locking from the view while the AI runs stops the task through Stop: no write, not running, one undo step', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  h.hold();
  const handle = await startResearch(h.host, a, { map: h.view.map, request: { task: 'go', ...research } });
  await until(() => h.calls.length === 1);
  await h.view.setAiLock([a], true);
  await handle.finished;
  const note = await h.repo.readNote(a.path);
  assert.equal(note.aiLocked, true);
  assert.notEqual(note.summary, 'AI summary');
  assert.equal(note.status, 'idea');
  assert.equal(h.host.topicRuns.isRunning(a.path), false);
  assert.equal(h.view.history.canUndo, true);
  await h.view.history.undo().undo();
  assert.equal((await h.repo.readNote(a.path)).aiLocked, undefined, 'one undo unlocks');
  assert.equal(h.view.history.canUndo, false, 'the lock was a single step');
  await h.view.history.redo().redo();
  assert.equal((await h.repo.readNote(a.path)).aiLocked, true, 'redo locks again');
});

test('the view entries refuse a locked topic before the AI: re-run Standard, the research dialog and multi research', async () => {
  const h = await harness(['A', 'B']);
  const [a, b] = h.nodes;
  await h.view.setAiLock([a], true);
  h.view.rerunStandard(a);
  await until(() => h.notices.length >= 1);
  assert.match(h.notices.at(-1), LOCKED_NOTICE);
  h.notices.length = 0;
  let pending;
  h.view.enqueue = fn => { pending = fn(); };
  h.view.openNextStep(a);
  await pending;
  assert.match(h.notices.at(-1) ?? '', LOCKED_NOTICE, 'the dialog is not opened');
  h.view.selection.replaceMulti([a.id, b.id]);
  await h.view.startMultiResearch({ requirements: '', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
  await until(() => h.view.plugin.expansionBatches.get(`multi-research:${MAP}`)?.status === 'completed');
  assert.deepEqual(h.calls.map(call => call.title), ['B'], 'only the unlocked topic reaches the provider');
  assert.notEqual((await h.repo.readNote(a.path)).summary, 'AI summary');
});

test('a user edit of a locked topic is still written', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  await h.view.setAiLock([a], true);
  await h.view.noteChange(a, { summary: 'Typed by hand' });
  const note = await h.repo.readNote(a.path);
  assert.equal(note.summary, 'Typed by hand');
  assert.equal(note.aiLocked, true);
});

// ---- UI ----------------------------------------------------------------------------------------------------------------
test('inspector: an aria-pressed lock toggle; the card shows a lock button only when locked and a click unlocks', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  const calls = [];
  h.view.setAiLock = async (nodes, locked) => { calls.push(JSON.stringify([nodes.map(n => n.id), locked])); };
  h.view.enqueue = fn => fn();
  const panel = dom.element('div');
  h.view.renderAiLockSection(panel, a);
  const toggle = dom.findAll(panel, i => i.tag === 'button' && i.attrs['aria-pressed'] !== undefined)[0];
  assert.equal(toggle.attrs['aria-pressed'], 'false');
  toggle.click(); await dom.tick();
  assert.deepEqual(calls, [JSON.stringify([[a.id], true])]);
  const header = dom.element('div'), card = dom.element('div');
  h.view.paintAiLock(card, header, a);
  assert.equal(dom.findAll(header, i => i.tag === 'button').length, 0, 'unlocked: no card button');
  h.view.notes.set(a.id, { ...h.view.notes.get(a.id), aiLocked: true });
  h.view.paintAiLock(card, header, a);
  const button = dom.findAll(header, i => i.tag === 'button')[0];
  assert.ok(button, 'locked: a card button');
  assert.match(button.attrs['aria-label'], /解除|Unlock/);
  button.click(); await dom.tick();
  assert.equal(calls.at(-1), JSON.stringify([[a.id], false]));
  const panel2 = dom.element('div');
  h.view.renderAiLockSection(panel2, a);
  assert.equal(dom.findAll(panel2, i => i.tag === 'button' && i.attrs['aria-pressed'] !== undefined)[0].attrs['aria-pressed'], 'true');
  // Not on AIM maps.
  h.view.map.aim = { version: 1, branches: [] };
  const aimPanel = dom.element('div'), aimHeader = dom.element('div');
  h.view.renderAiLockSection(aimPanel, a);
  h.view.paintAiLock(dom.element('div'), aimHeader, a);
  assert.equal(dom.findAll(aimPanel, i => i.tag === 'button').length + dom.findAll(aimHeader, i => i.tag === 'button').length, 0);
});

test('i18n: the locked notice and the toggle names exist in every language', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = read(`i18n/${lang}.ts`);
    for (const key of ['ui.ai_locked_notice', 'ui.ai_lock', 'ui.ai_lock_toggle', 'ui.ai_unlock_card']) assert.ok(text.includes(`"${key}"`), `${lang} ${key}`);
  }
  assert.match(read('i18n/zh-TW.ts'), /"ui\.ai_locked_notice": "議題已鎖定，AI 不會修改"/);
  assert.match(t('ui.ai_locked_notice'), LOCKED_NOTICE);
});
