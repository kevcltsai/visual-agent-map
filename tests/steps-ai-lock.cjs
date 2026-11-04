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
  const modals = [];
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { constructor(app) { this.app = app; } open() { modals.push(this); } close() {} } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate, ancestorContext: async () => '', queueCharts() {} });
  await hydrate();
  const raw = node => contents.get(node.path);
  return { repo, app, contents, view, host, nodes, calls, notices, raw, modals, hold: () => { gate = []; return gate; } };
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

// ---- ticket 03: bulk lock from the selection bar ---------------------------------------------------------------------
const selectionButton = (h) => {
  const bar = dom.element('div');
  h.view.renderAiLockSelectionButton(bar);
  return dom.findAll(bar, i => i.tag === 'button')[0];
};

test('03 bulk: the selection bar locks every selected topic in one undo step, then unlocks them in one', async () => {
  const h = await harness(['A', 'B', 'C']);
  const [a, b, c] = h.nodes;
  h.view.selection.replaceMulti([a.id, b.id, c.id]);
  let pending;
  h.view.enqueue = fn => { pending = fn(); };
  const button = selectionButton(h);
  assert.equal(button.attrs['aria-pressed'], 'false');
  button.click(); await pending;
  for (const node of h.nodes) assert.equal((await h.repo.readNote(node.path)).aiLocked, true);
  await h.view.history.undo().undo();
  for (const node of h.nodes) assert.equal((await h.repo.readNote(node.path)).aiLocked, undefined, 'one undo unlocks all three');
  assert.equal(h.view.history.canUndo, false);
  await h.view.history.redo().redo();
  await h.view.hydrate();
  const again = selectionButton(h);
  assert.equal(again.attrs['aria-pressed'], 'true', 'all locked: pressed');
  assert.match(again.text, /解除|Unlock/);
  again.click(); await pending;
  for (const node of h.nodes) assert.equal((await h.repo.readNote(node.path)).aiLocked, undefined);
  void c;
});

test('03 bulk: a mixed selection says how many are locked and the click locks the rest', async () => {
  const h = await harness(['A', 'B', 'C']);
  const [a, b, c] = h.nodes;
  await h.view.setAiLock([a], true);
  h.view.selection.replaceMulti([a.id, b.id, c.id]);
  let pending;
  h.view.enqueue = fn => { pending = fn(); };
  const button = selectionButton(h);
  assert.equal(button.attrs['aria-pressed'], 'mixed');
  assert.match(button.attrs.title, /1.*3/, 'the title names 1 of 3');
  assert.match(button.attrs['aria-label'], /1.*3/);
  const before = h.raw(a);
  button.click(); await pending;
  for (const node of [a, b, c]) assert.equal((await h.repo.readNote(node.path)).aiLocked, true);
  assert.equal(h.raw(a), before, 'the already locked note is not rewritten');
  await h.view.history.undo().undo();
  assert.equal((await h.repo.readNote(a.path)).aiLocked, true, 'undo leaves the topic that was locked before');
  assert.equal((await h.repo.readNote(b.path)).aiLocked, undefined);
});

test('03 bulk: no selection disables it; AIM maps get no button; the bar wires it in', async () => {
  const h = await harness(['A']);
  assert.equal(selectionButton(h).disabled, true);
  h.view.map.aim = { version: 1, branches: [] };
  assert.equal(selectionButton(h), undefined);
  assert.match(read('experiences/visual-map/view.ts'), /this\.renderAiLockSelectionButton\(selection\);/);
});

// ---- ticket 04: integrate, charts, integrate selection -------------------------------------------------------------
async function parentHarness() {
  const h = await harness(['P', 'C1', 'C2']);
  const [p, c1, c2] = h.nodes;
  c1.parentId = p.id; c2.parentId = p.id;
  await h.repo.saveMap(MAP, h.view.map);
  for (const child of [c1, c2]) await h.repo.updateNote(child.path, { summary: `${child.path} summary`, detail: 'Child detail', status: 'completed' });
  await h.view.hydrate();
  return { ...h, p, c1, c2 };
}
const synthesis = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };

test('04 integrate: integrating into a locked parent is refused before the AI and writes nothing', async () => {
  const h = await parentHarness();
  await h.view.setAiLock([h.p], true);
  const before = h.raw(h.p), failures = [];
  await h.view.integrateChildren(h.p, synthesis, '', undefined, message => failures.push(message));
  assert.equal(h.calls.length, 0, 'provider calls: 0');
  assert.equal(h.raw(h.p), before);
  assert.match(failures.join('\n'), LOCKED_NOTICE);
  failures.length = 0;
  await h.view.proposeIntegrationDirections(h.p, synthesis, () => assert.fail('no directions'), message => failures.push(message));
  assert.equal(h.calls.length, 0, 'the synthesis directions are refused too');
  assert.match(failures.join('\n'), LOCKED_NOTICE);
});

test('04 integrate: locked children are read as sources; the unlocked parent is written', async () => {
  const h = await parentHarness();
  await h.view.setAiLock([h.c1], true);
  const child = h.raw(h.c1);
  await h.view.integrateChildren(h.p, synthesis, '', undefined, message => assert.fail(message));
  assert.equal(h.calls.length, 1);
  assert.equal((await h.repo.readNote(h.p.path)).summary, 'AI summary');
  assert.equal(h.raw(h.c1), child, 'the locked child is not touched');
});

test('04 integrate: late fence: a parent locked while the AI runs gets no write and does not stay running', async () => {
  const h = await parentHarness();
  const gate = h.hold(), failures = [];
  const run = h.view.integrateChildren(h.p, synthesis, '', undefined, message => failures.push(message));
  await until(() => gate.length === 1);
  await h.repo.writeAiLocked(h.p.path, true);
  gate[0]();
  await run;
  const note = await h.repo.readNote(h.p.path);
  assert.notEqual(note.summary, 'AI summary');
  assert.notEqual(note.status, 'running');
  assert.match(failures.join('\n'), LOCKED_NOTICE);
});

test('04 charts: a chart result for a topic locked meanwhile is not written; locking stops its chart job', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  const jobs = [], aborted = [];
  h.host.addChartsAfterWrite = job => jobs.push(job);
  h.host.abortChartJobs = path => aborted.push(path);
  delete h.view.queueCharts; // the harness stubs it out; this test drives the real one
  const saved = await h.repo.readNote(a.path);
  h.view.queueCharts({ path: a.path, saved, context: { title: 'A' }, detail: saved.detail, model: 'gpt-6-luna', language: 'zh-TW' });
  assert.equal(jobs.length, 1);
  await h.view.setAiLock([a], true);
  assert.ok(aborted.includes(a.path), 'locking stops the chart job of the topic');
  const before = h.raw(a);
  assert.equal(await jobs[0].apply('Detail with a chart'), false);
  assert.equal(h.raw(a), before, 'no chart is written to a locked topic');
  jobs.length = 0;
  h.view.queueCharts({ path: a.path, saved: await h.repo.readNote(a.path), context: { title: 'A' }, detail: saved.detail, model: 'gpt-6-luna', language: 'zh-TW' });
  assert.equal(jobs.length, 0, 'a locked topic gets no chart job at all');
});

test('04 integrate selection: locked sources may be read; the new topic is written and the sources stay as they were', async () => {
  const h = await harness(['A', 'B']);
  const [a, b] = h.nodes;
  for (const node of h.nodes) await h.repo.updateNote(node.path, { summary: 'S', detail: 'Source detail', status: 'completed' });
  await h.view.setAiLock([a, b], true);
  const sources = [h.raw(a), h.raw(b)];
  const failures = [];
  await h.view.startSelectionSynthesis([a, b], { ...synthesis, synthesisTitle: 'Synth' }, 'Compare them', message => failures.push(message), () => {});
  await until(() => h.view.map.nodes.length === 3 || failures.length);
  assert.deepEqual(failures, []);
  assert.equal(h.calls.length >= 1, true);
  assert.deepEqual([h.raw(a), h.raw(b)], sources, 'locked sources are read, never written');
});

// ---- ticket 05: merge -----------------------------------------------------------------------------------------------
async function mergeHarness(titles = ['A', 'B', 'C']) {
  const h = await harness(titles);
  for (const node of h.nodes) await h.repo.updateNote(node.path, { summary: `${node.path} summary`, detail: 'Source detail', status: 'completed' });
  await h.view.hydrate();
  h.view.mergeOpen = false;
  return h;
}
const snapshotOf = (h, nodes, targetId = null) => ({ path: MAP, mapId: h.view.map.id, parentId: null, targetId, sources: nodes.map(n => ({ id: n.id, path: n.path })) });
const signal = () => new AbortController().signal;

test('05 merge: an AI merge with one locked source is refused before the AI and writes nothing', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  await h.view.setAiLock([a], true);
  const before = [h.raw(a), h.raw(b)], mapBefore = h.contents.get(MAP);
  const began = await h.view.startMergeDraft('M', snapshotOf(h, [a, b]), () => assert.fail('not started'), signal());
  assert.equal(began, false);
  assert.equal(h.calls.length, 0, 'provider calls: 0');
  assert.match(h.notices.join('\n'), LOCKED_NOTICE);
  assert.deepEqual([h.raw(a), h.raw(b)], before);
  assert.equal(h.contents.get(MAP), mapBefore);
});

test('05 merge: opening Merge on a selection with a locked topic shows the notice and offers no AI merge', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  await h.view.setAiLock([b], true);
  h.view.selection.replaceMulti([a.id, b.id]);
  h.view.openMerge();
  assert.match(h.notices.join('\n'), LOCKED_NOTICE);
  const modal = h.modals.at(-1);
  assert.ok(modal, 'the dialog still opens for a merge by hand');
  assert.equal(modal.ai, undefined, 'no AI merge is offered');
  h.view.mergeOpen = false;
  h.view.selection.replaceMulti([a.id, h.nodes[2].id]);
  h.view.openMerge();
  assert.ok(h.modals.at(-1).ai, 'nothing locked: the AI merge is offered as before');
});

test('05 merge: an AI merge of a topic related to a locked topic, or under a locked parent, is refused', async () => {
  const h = await mergeHarness(['A', 'B', 'C', 'P', 'X', 'Y']);
  const [a, b, c, p, x, y] = h.nodes;
  h.view.map.topicRelations = [{ kind: 'related', from: a.id, to: c.id }];
  x.parentId = p.id; y.parentId = p.id;
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.setAiLock([c, p], true);
  assert.equal(await h.view.startMergeDraft('M', snapshotOf(h, [a, b]), () => assert.fail('related'), signal()), false);
  assert.equal(await h.view.startMergeDraft('M', { ...snapshotOf(h, [x, y]), parentId: p.id }, () => assert.fail('locked parent'), signal()), false);
  assert.equal(h.calls.length, 0);
});

test('05 merge: merging into a locked parent topic is refused', async () => {
  const h = await mergeHarness(['P', 'C1', 'C2']);
  const [p, c1, c2] = h.nodes;
  c1.parentId = p.id; c2.parentId = p.id;
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.setAiLock([p], true);
  assert.equal(await h.view.startMergeDraft('M', snapshotOf(h, [p, c1, c2], p.id), () => assert.fail('started'), signal()), false);
  assert.equal(h.calls.length, 0);
});

test('05 merge: late fence: a source locked while the AI merges gets no merge written', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  const gate = h.hold();
  const before = h.raw(b), nodes = h.view.map.nodes.length;
  assert.equal(await h.view.startMergeDraft('M', snapshotOf(h, [a, b]), () => {}, signal()), true);
  await until(() => gate.length === 1);
  await h.repo.writeAiLocked(a.path, true);
  gate[0]();
  await h.view.mergeTasks.get(MAP)?.run;
  assert.equal(h.view.map.nodes.length, nodes, 'no merged topic');
  assert.equal(h.raw(b), before, 'the other source is untouched');
  assert.match((await h.repo.readNote(a.path)).aiLocked ? 'locked' : '', /locked/);
  assert.ok(h.app.vault.getAbstractFileByPath(a.path), 'the locked source note stays where it was');
  assert.match(h.notices.join('\n'), LOCKED_NOTICE);
});

test('05 merge: a merge by hand (no AI) of locked topics still works', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  await h.view.setAiLock([a], true);
  await h.view.mergeSelected('Merged by hand', snapshotOf(h, [a, b]));
  assert.equal(h.view.map.nodes.some(node => node.id === a.id), false, 'the user merge went through');
});

test('05 merge: the map chat merge of a locked topic is skipped and writes nothing', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  await h.view.setAiLock([a], true);
  h.view.canSelectTopics = () => true;
  const before = h.contents.get(MAP);
  const outcome = await h.view.runChatSelection({ kind: 'run_map_action', action: 'merge', title: 'Merged', nodeIds: [a.id, b.id] });
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason, LOCKED_NOTICE);
  assert.equal(h.contents.get(MAP), before);
  assert.ok(h.view.map.nodes.some(node => node.id === a.id));
});

// ---- ticket 06: expand, grade by goal, structure suggestions, AI outline import -------------------------------------
test('06 expand: proposing subtopics for a locked topic is refused before the AI', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  await h.view.setAiLock([p], true);
  const failures = [];
  await h.view.proposeChildren(p, { ...synthesis, shallowResearch: false }, '', () => assert.fail('no suggestions'), message => failures.push(message));
  assert.equal(h.calls.length, 0, 'provider calls: 0');
  assert.match(failures.join('\n'), LOCKED_NOTICE);
});

test('06 expand: creating suggested subtopics under a parent locked meanwhile writes nothing', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  await h.repo.writeAiLocked(p.path, true); // locked after the proposal, before the batch write (the view has not seen it)
  const mapBefore = h.contents.get(MAP), count = h.view.map.nodes.length;
  await assert.rejects(h.view.createChildBatch(p, [{ title: 'Child', task: 't', contribution: '' }]), LOCKED_NOTICE);
  assert.equal(h.view.map.nodes.length, count);
  assert.equal(h.contents.get(MAP), mapBefore);
});

test('06 expand: quick explore and the chat expand refuse a locked topic before the AI', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  await h.view.setAiLock([p], true);
  let outlineCalls = 0;
  h.host.outlineGeneration = { generate: async () => { outlineCalls++; return { nodes: [], markdown: '' }; } };
  await assert.rejects(h.view.quickOutline(p).generate({ presetId: 'default', requirements: '', language: 'en', limits: { levels: 2, maxTopics: 5 } }, signal()), LOCKED_NOTICE);
  await h.view.chatExpand(p, '');
  assert.equal(outlineCalls, 0, 'provider calls: 0');
  assert.match(h.notices.join('\n'), LOCKED_NOTICE);
  assert.equal(h.host.running.has(p.path), false, 'the chat expand does not stay running');
});

test('06 outline: an AI outline under a locked topic is refused and says how many topics were skipped; a pasted outline still goes in', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  await h.view.setAiLock([p], true);
  const count = h.view.map.nodes.length;
  const outline = [{ index: 0, title: 'One', level: 1, parent: null, line: 1 }, { index: 1, title: 'Two', level: 1, parent: null, line: 2 }];
  await assert.rejects(h.view.importOutline({ nodes: outline, source: null, shallowResearch: false, aiGenerated: true, placement: { kind: 'under', parentId: p.id } }), /2/);
  assert.equal(h.view.map.nodes.length, count, 'nothing added under the locked topic');
  await h.view.importOutline({ nodes: outline, source: null, shallowResearch: false, placement: { kind: 'under', parentId: p.id } });
  assert.equal(h.view.map.nodes.length, count + 2, 'a user outline is the user\'s own edit');
});

test('06 grade by goal: a locked card keeps its tier and is counted as skipped', async () => {
  const h = await harness(['A', 'B']);
  const [a, b] = h.nodes;
  await h.repo.writeRelevance(a.path, { tier: 'side' });
  await h.view.setAiLock([a], true);
  const run = { token: 1, owner: h.view, controller: new AbortController(), goal: 'g', status: 'running' };
  h.host.relevanceGrades = new Map([[MAP, run]]);
  h.host.logs = { appendLog() {} };
  const basis = h.nodes.map(n => ({ id: n.id, title: h.view.notes.get(n.id).title, parentId: null }));
  const before = h.raw(a);
  await h.view.applyRelevanceGrade(run, MAP, basis, { items: [{ id: a.id, tier: 'core' }, { id: b.id, tier: 'core' }] }, { mode: 'full', pins: [], repairs: [] });
  assert.equal(h.raw(a), before, 'the locked tier is unchanged');
  assert.equal((await h.repo.readNote(b.path)).relevance.tier, 'core');
  assert.equal(run.outcome.skipped, 1);
  assert.equal(run.outcome.graded, 1);
});

test('06 structure: suggestions touching a locked topic are dropped and counted; applying one refuses at write time', async () => {
  const h = await harness(['A', 'B', 'C']);
  const [a, b, c] = h.nodes;
  await h.view.setAiLock([a], true);
  const basis = { targetTitle: '', targetParentId: null };
  const result = { suggestions: [
    { kind: 'strengthen', targetId: a.id, basis }, { kind: 'move', targetId: b.id, newParentId: a.id, basis },
    { kind: 'reduce', targetId: c.id, basis }, { kind: 'merge', targetId: b.id, mergeIntoId: c.id, basis }
  ], rejected: [] };
  const { kept, skipped } = h.view.dropAiLockedSuggestions(result);
  assert.equal(skipped, 2);
  assert.deepEqual(kept.suggestions.map(s => s.kind), ['reduce', 'merge']);
  await h.repo.writeAiLocked(c.path, true); // locked after the review
  const count = h.view.map.nodes.length;
  await assert.rejects(h.view.applyStructureSuggestion({ kind: 'strengthen', targetId: c.id, basis }, 'New', () => null), LOCKED_NOTICE);
  assert.equal(h.view.map.nodes.length, count);
});
