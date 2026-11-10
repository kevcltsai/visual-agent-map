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

test('the view entries refuse a locked topic before the AI: re-run Standard, the topic chat and multi research', async () => {
  const h = await harness(['A', 'B']);
  const [a, b] = h.nodes;
  await h.view.setAiLock([a], true);
  h.view.rerunStandard(a);
  await until(() => h.notices.length >= 1);
  assert.match(h.notices.at(-1), LOCKED_NOTICE);
  h.notices.length = 0;
  let pending;
  h.view.enqueue = fn => { pending = fn(); };
  h.view.openTopicChat(a);
  await pending;
  assert.match(h.notices.at(-1) ?? '', LOCKED_NOTICE, 'the topic chat is not opened');
  assert.equal(h.view.topicChatOpen ?? null, null, 'no topic chat window is open on a locked topic');
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

test('34 inspector: the lock button label follows the state like the selection bar (Lock -> Unlock)', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  h.view.setAiLock = async () => {};
  h.view.enqueue = fn => fn();
  const panel = dom.element('div');
  h.view.renderAiLockSection(panel, a);
  const find = () => dom.findAll(panel, i => i.tag === 'button' && i.attrs['aria-pressed'] !== undefined)[0];
  assert.equal(find().text, t('ui.ai_lock_toggle'));
  find().click(); await dom.tick();
  assert.equal(find().attrs['aria-pressed'], 'true');
  assert.equal(find().text, t('ui.ai_unlock_selected'), 'locked: button says Unlock');
  find().click(); await dom.tick();
  assert.equal(find().text, t('ui.ai_lock_toggle'), 'unlocked again: back to Lock');
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
// The lock lives in the selection bar's More menu now: open it and take the lock entry (title, disabled, click) as a button-like object.
const selectionButton = (h) => {
  const entries = [];
  h.view.newMenu = () => { const m = { addItem(build) { const it = { attrs: {} }; const chain = { setTitle(t) { it.text = t; it.attrs.title = t; it.attrs['aria-label'] = t; return chain; }, setIcon() { return chain; }, setDisabled(v) { it.disabled = !!v; return chain; }, onClick(fn) { it.click = () => fn(); return chain; } }; build(chain); entries.push(it); return m; }, addSeparator() { return m; }, showAtMouseEvent() {} }; return m; };
  h.view.openSelectionMoreMenu({}, h.view.selection.state.multiSelected.size);
  const entry = entries.find(i => /lock|鎖|解除/i.test(i.text));
  if (entry) entry.attrs['aria-pressed'] = /解除|Unlock/.test(entry.text) ? 'true' : / \(/.test(entry.text) ? 'mixed' : 'false';
  return entry;
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
  assert.match(read('experiences/visual-map/view.ts'), /openSelectionMoreMenu\(event: MouseEvent, count: number\)[\s\S]*?ui\.ai_lock_toggle/, 'the bar\'s More menu wires it in');
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

// UI audit bugfix-2 P2 (FLOWS.md AI 任務): a synthesis that picks a locked topic is refused before any AI call, with the reason.
test('04 integrate selection: a locked source refuses the synthesis before any AI call; no topic is added or written', async () => {
  const h = await harness(['A', 'B']);
  const [a, b] = h.nodes;
  for (const node of h.nodes) await h.repo.updateNote(node.path, { summary: 'S', detail: 'Source detail', status: 'completed' });
  await h.view.setAiLock([a], true);
  const sources = [h.raw(a), h.raw(b)];
  const failures = [];
  const callsBefore = h.calls.length;
  await h.view.startSelectionSynthesis([a, b], { ...synthesis, synthesisTitle: 'Synth' }, 'Compare them', message => failures.push(message), () => {});
  assert.match(failures.join('\n'), LOCKED_NOTICE, 'the refusal says why');
  assert.equal(h.calls.length, callsBefore, 'no AI call');
  assert.equal(h.view.map.nodes.length, 2, 'no new topic');
  assert.deepEqual([h.raw(a), h.raw(b)], sources, 'sources stay as they were');
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

test('05 merge: a merge by hand keeps the AI lock when any source is locked, and stays unlocked when none is', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  await h.view.setAiLock([b], true);
  await h.view.mergeSelected('Merged locked', snapshotOf(h, [a, b]));
  const mergedLocked = h.view.map.nodes.find(node => ![a.id, b.id].includes(node.id) && node.parentId === (a.parentId ?? null) && node.path.includes('Merged locked'));
  assert.ok(mergedLocked, 'the merged topic exists');
  assert.equal((await h.repo.readNote(mergedLocked.path)).aiLocked, true, 'one locked source: the merged topic is locked');
});

test('05 merge: a merge by hand of unlocked topics produces an unlocked topic', async () => {
  const h = await mergeHarness();
  const [a, b] = h.nodes;
  await h.view.mergeSelected('Merged plain', snapshotOf(h, [a, b]));
  const merged = h.view.map.nodes.find(node => ![a.id, b.id].includes(node.id) && node.path.includes('Merged plain'));
  assert.ok(merged);
  assert.equal((await h.repo.readNote(merged.path)).aiLocked, undefined);
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
  const h = await harness(['Root', 'A', 'B']);
  const [root, a, b] = h.nodes;
  await h.repo.writeRelevance(a.path, { tier: 'side' });
  await h.view.setAiLock([a], true);
  // The run rates the cards below the top level; the top-level card is only context.
  for (const node of [a, b]) for (const list of [h.nodes, h.view.map.nodes]) list.find(n => n.id === node.id).parentId = root.id;
  const run = { token: 1, owner: h.view, controller: new AbortController(), goal: 'g', status: 'running' };
  h.host.relevanceGrades = new Map([[MAP, run]]);
  h.host.logs = { appendLog() {} };
  const basis = h.nodes.map(n => ({ id: n.id, title: h.view.notes.get(n.id).title, parentId: n.parentId ?? null }));
  const before = h.raw(a);
  await h.view.applyRelevanceGrade(run, MAP, basis, { items: [{ id: a.id, tier: 'core' }, { id: b.id, tier: 'core' }], suggestions: [], dropped: [] }, { scope: 'all', pins: [] });
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

// ---- ticket 07: map chat ---------------------------------------------------------------------------------------------
const chatBaseline = h => ({ mdHashes: {}, topicHashes: Object.fromEntries(h.view.map.nodes.map(n => [n.id, { title: h.view.notes.get(n.id).title, parentId: n.parentId }])) });
const applyChat = (h, action, baseline = chatBaseline(h)) => h.view.applyChatWrite(action, baseline, () => true);

test('07 chat: a rename of a locked card is a tool error saying it is locked, and nothing is written', async () => {
  const h = await harness(['A', 'B']);
  const [a, b] = h.nodes;
  await h.view.setAiLock([a], true);
  const before = h.raw(a);
  const outcome = await applyChat(h, { kind: 'rename_topic', nodeId: a.id, title: 'Renamed' });
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason, LOCKED_NOTICE);
  assert.equal(h.raw(a), before);
  const ok = await applyChat(h, { kind: 'rename_topic', nodeId: b.id, title: 'Renamed' });
  assert.equal(ok.status, 'done', 'an unlocked card is renamed as before');
  assert.equal((await h.repo.readNote(b.path)).title, 'Renamed');
});

test('07 chat: every write tool on a locked target is refused (summary, note, kind, collapse, expand, child, move, delete, related delete)', async () => {
  const h = await harness(['A', 'B', 'C', 'D']);
  const [a, b, c, d] = h.nodes;
  c.parentId = a.id;
  h.view.map.topicRelations = [{ kind: 'related', from: d.id, to: a.id }];
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.setAiLock([a], true);
  const mapBefore = h.contents.get(MAP), noteBefore = h.raw(a);
  const actions = [
    { kind: 'update_summary', nodeId: a.id, summary: 'S' },
    { kind: 'collapse_topic', nodeId: a.id },
    { kind: 'expand_topic', nodeId: a.id },
    { kind: 'edit_topic_note', nodeId: a.id, detail: 'D' },
    { kind: 'set_topic_kind', nodeIds: [a.id], topicKind: 'hypothesis' },
    { kind: 'set_appearance', nodeIds: [a.id], color: 'red', markers: ['star'] },
    { kind: 'add_child', parentId: a.id, title: 'New child' },
    { kind: 'move_topic', nodeId: a.id, newParentId: b.id },
    { kind: 'move_topic', nodeId: b.id, newParentId: a.id },
    { kind: 'move_topic', nodeId: c.id, newParentId: b.id },
    { kind: 'move_topic', nodeId: b.id, newParentId: a.id, beforeId: c.id },
    { kind: 'add_relation', fromId: b.id, toId: a.id, relationKind: 'supports' },
    { kind: 'add_relation', fromId: a.id, toId: b.id, relationKind: 'supports' },
    { kind: 'remove_relation', fromId: d.id, toId: a.id },
    { kind: 'remove_relation', fromId: a.id, toId: d.id },
    { kind: 'delete_topic', nodeId: a.id, branch: true },
    { kind: 'delete_topic', nodeId: c.id, branch: true },
    { kind: 'delete_topic', nodeId: d.id, branch: true }
  ];
  for (const action of actions) {
    const outcome = await applyChat(h, action);
    assert.equal(outcome.status, 'skipped', JSON.stringify(action));
    assert.match(outcome.reason, LOCKED_NOTICE, JSON.stringify(action));
  }
  assert.equal(h.contents.get(MAP), mapBefore);
  assert.equal(h.raw(a), noteBefore);
});

test('07 chat: one reply of remove_relation(D, A) then delete_topic(D) with A locked removes neither the relation nor D', async () => {
  const h = await harness(['A', 'B', 'C', 'D']);
  const [a, , , d] = h.nodes;
  h.view.map.topicRelations = [{ kind: 'related', from: d.id, to: a.id }];
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.setAiLock([a], true);
  const mapBefore = h.contents.get(MAP);
  for (const action of [{ kind: 'remove_relation', fromId: d.id, toId: a.id }, { kind: 'delete_topic', nodeId: d.id, branch: true }]) {
    const outcome = await applyChat(h, action);
    assert.equal(outcome.status, 'skipped', JSON.stringify(action));
    assert.match(outcome.reason, LOCKED_NOTICE, JSON.stringify(action));
  }
  assert.equal(h.contents.get(MAP), mapBefore, 'the relation is still there');
  assert.ok(h.view.map.nodes.some(n => n.id === d.id), 'D is not deleted');
});

test('07 chat: add_relation / remove_relation between unlocked cards still go through', async () => {
  const h = await harness(['A', 'B', 'C']);
  const [a, b, c] = h.nodes;
  await h.view.setAiLock([c], true);
  const added = await applyChat(h, { kind: 'add_relation', fromId: a.id, toId: b.id, relationKind: 'supports' });
  assert.equal(added.status, 'done', JSON.stringify(added));
  const removed = await applyChat(h, { kind: 'remove_relation', fromId: a.id, toId: b.id });
  assert.equal(removed.status, 'done', JSON.stringify(removed));
});

test('07 chat: edit_md_file on a locked note is refused', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  await h.view.setAiLock([a], true);
  const before = h.raw(a);
  const outcome = await applyChat(h, { kind: 'edit_md_file', path: a.path, find: 'A', replace: 'Z' }, { mdHashes: {}, topicHashes: {} });
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason, LOCKED_NOTICE);
  assert.equal(h.raw(a), before);
});

test('07 chat: a card locked between the proposal and the confirmation is refused on apply', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  const baseline = chatBaseline(h); // what the model saw: unlocked
  await h.repo.writeAiLocked(a.path, true); // locked before the user confirms; the view has not refreshed
  const before = h.raw(a);
  const outcome = await applyChat(h, { kind: 'delete_topic', nodeId: a.id, branch: false }, baseline);
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason, LOCKED_NOTICE);
  assert.equal(h.raw(a), before);
  assert.ok(h.view.map.nodes.some(n => n.id === a.id));
});

test('07 chat: a picture is not inserted into a locked card; run_map_action on locked cards is skipped', async () => {
  const h = await harness(['A']);
  const [a] = h.nodes;
  await h.view.setAiLock([a], true);
  const before = h.raw(a);
  const result = await h.view.chatPlaceImage({ mapPath: MAP, mapId: h.view.map.id, nodeId: a.id }, { url: 'https://example.org/a.png', title: 'A', source: 'https://example.org' }, () => true);
  assert.equal(result.ok, false);
  assert.match(result.reason, LOCKED_NOTICE);
  assert.equal(h.raw(a), before);
  h.view.canSelectTopics = () => true;
  for (const action of ['expand', 'research_standard', 'find_images']) {
    const outcome = await h.view.runChatSelection({ kind: 'run_map_action', action, nodeIds: [a.id], direction: '' });
    assert.equal(outcome.status, 'skipped', action);
    assert.match(outcome.reason, LOCKED_NOTICE, action);
  }
  assert.equal(h.calls.length, 0);
});

test('07 chat context: locked cards are marked only when the map has one; without locks the bytes are unchanged', () => {
  const { buildMapChatContext } = S.load('core/map-chat-context.ts', { obsidian });
  const input = { mapTitle: 'M', outline: [{ id: 'n1', title: 'Root', summary: '', parentId: null, depth: 0 }, { id: 'n2', title: 'Child', summary: '', parentId: 'n1', depth: 1 }], selected: [], references: [], snippets: [], files: [], history: [] };
  const plain = buildMapChatContext(input).json;
  const withFalse = buildMapChatContext({ ...input, outline: input.outline.map(n => ({ ...n, aiLocked: false })) }).json;
  assert.equal(withFalse, plain, 'no lock: byte for byte the same');
  assert.doesNotMatch(plain, /aiLocked/);
  const locked = JSON.parse(buildMapChatContext({ ...input, outline: [{ ...input.outline[0], aiLocked: true }, input.outline[1]] }).json);
  assert.equal(locked.outline[0].aiLocked, true);
  assert.equal('aiLocked' in locked.outline[1], false);
  assert.match(locked.aiLockedNote, /locked/i);
});

// ---- ticket 08: editor selection AI and image translate --------------------------------------------------------------
const { runPanel } = require('./support-selection-ai.cjs');
const LOCKED_NOTE = '---\ntype: topic\nai-locked: true\n---\n\nSome text to rewrite.\n';
const OPEN_NOTE = '---\ntype: topic\n---\n\nSome text to rewrite.\n';

test('08 selection AI: a locked note gets no AI call and a locked notice; an unlocked note runs as before', async () => {
  const notices = [];
  const locked = await runPanel({ markdown: LOCKED_NOTE, selected: 'text to rewrite', replies: ['Rewritten'], outcome: true, notices });
  assert.equal(locked.sent.length, 0, 'provider calls: 0');
  assert.match(locked.status + notices.join('\n'), LOCKED_NOTICE);
  const open = await runPanel({ markdown: OPEN_NOTE, selected: 'text to rewrite', replies: ['Rewritten'], outcome: true });
  assert.equal(open.sent.length, 1);
});

test('08 image translate: a locked note is not written and no image AI runs; an unlocked note is written as before', async () => {
  class Component { load() {} unload() {} registerDomEvent() {} }
  class MarkdownView {}
  const notices = [];
  const { ImageTranslateAction } = S.load('experiences/markdown-context/image-translate-action.ts', { obsidian: { Component, MarkdownView, Notice: class { constructor(m) { notices.push(m); } }, setIcon() {}, parseYaml: text => require('yaml').parse(text) } });
  const embed = '![egg](https://x/egg.png)';
  const write = async text => {
    let content = text;
    const app = { workspace: { getLeavesOfType: () => [] }, vault: { process: async (_file, edit) => { content = edit(content); } } };
    let error;
    try { await new ImageTranslateAction(app, {}).write({ token: { text: embed, occurrence: 0, count: 1 } }, { path: 'Note.md' }, '![[egg-en.png]]', 'replace'); } catch (e) { error = e; }
    return { content, error };
  };
  const lockedText = `---\nai-locked: true\n---\n\n${embed}\n`;
  const lockedWrite = await write(lockedText);
  assert.equal(lockedWrite.content, lockedText, 'the locked note is unchanged');
  assert.match(lockedWrite.error?.message ?? '', LOCKED_NOTICE);
  const openText = `---\ntype: topic\n---\n\n${embed}\n`;
  assert.equal((await write(openText)).content, '---\ntype: topic\n---\n\n![[egg-en.png]]\n');
  let calls = 0;
  const action = new ImageTranslateAction({ workspace: { getLeavesOfType: () => [] } }, { model: () => 'm', run: async () => { calls++; return ''; }, saveImage: async () => '' });
  await action.translate({ view: { editor: { getValue: () => lockedText }, containerEl: {} }, path: 'Note.md', image: {}, token: null }, 'en', 'replace', {}, {});
  assert.equal(calls, 0, 'provider calls: 0');
  assert.match(notices.join('\n'), LOCKED_NOTICE);
});

test('08 note text lock: only a frontmatter `ai-locked: true` counts', () => {
  const parse = text => require('yaml').parse(text);
  assert.equal(values.noteTextAiLocked(LOCKED_NOTE, parse), true);
  assert.equal(values.noteTextAiLocked(OPEN_NOTE, parse), false);
  assert.equal(values.noteTextAiLocked('Body\nai-locked: true\n', parse), false, 'a body line is not frontmatter');
  assert.equal(values.noteTextAiLocked('---\nai-locked: "true"\n---\n', parse), false);
  assert.equal(values.noteTextAiLocked('---\nai-locked: [\n---\n', parse), false, 'broken YAML reads as unlocked');
});

// ---- fix batch after review: outline window lock, chat collapse/expand, late fences ------------------------------------
const outlineModal = (create, generate, locked = false) => {
  const Modal = dom.makeModal();
  const mod = S.load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal, Notice: class {} } });
  const generator = { presets: { settings: { language: 'en', promptPresets: [] }, async saveSettings() {} }, initialTopic: 'Sleep', generate };
  const modal = new mod.OutlineImportModal({}, create, { list: () => [], watch: () => () => {} }, { map: 'editable', selected: { id: 'n1', title: 'Sleep' } }, 'under', generator, {}, async () => 'cur');
  modal.open();
  const button = text => dom.find(modal.modalEl, i => i.tag === 'button' && i.text === text);
  return { modal, button, area: () => dom.find(modal.contentEl, i => i.tag === 'textarea' && i.cls?.includes('vam-outline-text')) };
};

test('fix B1: the outline window refuses AI generation under a locked parent before any provider call', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  await h.view.setAiLock([p], true);
  let outlineCalls = 0, started = 0;
  h.host.outlineGeneration = { generate: async () => { outlineCalls++; return { nodes: [], markdown: '# X' }; } };
  h.host.currentModelChoice = () => ({ model: 'gpt-6-luna', reasoning: 'low' });
  const generator = h.view.outlineGenerator('P');
  await assert.rejects(generator.generate({ topic: 'P', presetText: 'x', placement: { kind: 'under', parentId: p.id } }, new AbortController().signal, () => { started++; return {}; }), LOCKED_NOTICE);
  assert.equal(outlineCalls, 0, 'provider calls: 0');
  assert.equal(started, 0);
  assert.match(h.notices.join('\n'), LOCKED_NOTICE);
});

test('fix B1: AI-generated outline text carries aiGenerated; pasted, or typed over it, does not', async () => {
  const requests = [];
  const m = outlineModal(async request => { requests.push(request); }, async () => '# Sleep\n## A\n');
  m.area().value = '# Pasted\n## B\n'; m.area().fire('input');
  m.button(t('ui.outline_import_add')).fire('click'); await dom.tick();
  assert.equal(requests.length, 1);
  assert.equal('aiGenerated' in requests[0], false, 'a pasted outline is the user\'s own edit');
  const g = outlineModal(async request => { requests.push(request); }, async () => '# Sleep\n## A\n');
  g.button(t('ui.outline_ai_run')).fire('click'); await dom.tick(); await dom.tick();
  assert.match(g.area().value, /Sleep/);
  g.button(t('ui.outline_import_add')).fire('click'); await dom.tick();
  assert.equal(requests[1].aiGenerated, true, 'text produced by the AI is marked');
  const e = outlineModal(async request => { requests.push(request); }, async () => '# Sleep\n## A\n');
  e.button(t('ui.outline_ai_run')).fire('click'); await dom.tick(); await dom.tick();
  e.area().value = '# Mine\n'; e.area().fire('input');
  e.button(t('ui.outline_import_add')).fire('click'); await dom.tick();
  assert.equal('aiGenerated' in requests[2], false, 'text typed over the AI text is the user\'s');
});

test('fix B1: an AI-generated outline is blocked at import when the parent got locked meanwhile; the same text pasted is not', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  const count = h.view.map.nodes.length;
  const outline = [{ index: 0, title: 'One', level: 1, parent: null, line: 1 }];
  await h.view.setAiLock([p], true);
  await assert.rejects(h.view.importOutline({ nodes: outline, source: null, shallowResearch: false, aiGenerated: true, placement: { kind: 'under', parentId: p.id } }), LOCKED_NOTICE);
  assert.equal(h.view.map.nodes.length, count, 'nothing written');
  await h.view.importOutline({ nodes: outline, source: null, shallowResearch: false, placement: { kind: 'under', parentId: p.id } });
  assert.equal(h.view.map.nodes.length, count + 1, 'the pasted outline still goes in');
});

const PLAN = JSON.stringify({ action: 'transform', query: '', instruction: 'Make it shorter', placement: 'after', captionInstruction: '' });
test('fix M2a: selection AI: a note locked while the draft is generating is not written on accept', async () => {
  const result = await runPanel({ markdown: OPEN_NOTE, selected: 'text to rewrite', replies: [PLAN, 'Rewritten'], outcome: true, lockDuring: LOCKED_NOTE, applyAfter: t('ui.context_ai_insert_here') });
  assert.equal(result.sent.length, 2, 'the draft was generated');
  assert.equal(result.replaced.length, 0, 'nothing written');
  assert.match(result.status, LOCKED_NOTICE);
  const open = await runPanel({ markdown: OPEN_NOTE, selected: 'text to rewrite', replies: [PLAN, 'Rewritten'], outcome: true, applyAfter: t('ui.context_ai_insert_here') });
  assert.equal(open.replaced.length, 1, 'an unlocked note is written');
});

test('fix M2b: child-topic suggestions: a topic locked while the AI proposes stores and offers nothing', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  const gate = h.hold();
  const failures = [], offered = [];
  const reply = { summary: 's', detail: 'd', visualReferences: [], suggestions: [{ title: 'Child', task: 't', contribution: '' }] };
  h.host.askModel = async (_c, _m, _r, _s, _e, accepted) => { accepted?.(); await new Promise(resolve => gate.push(resolve)); return reply; };
  const run = h.host.topicRuns.start(p.path, 'proposeChildren', { map: h.view.map, buildContext: async () => ({ title: 'P' }), offer: items => offered.push(items), failed: message => failures.push(message) });
  await until(() => gate.length === 1);
  await h.repo.writeAiLocked(p.path, true);
  gate[0]();
  await run;
  assert.equal(offered.length, 0, 'nothing offered');
  assert.equal(h.host.pendingSuggestions.has(p.path), false, 'nothing stored');
  assert.ok(failures.some(message => LOCKED_NOTICE.test(message)));
});

// ---- review count: the options entry hands the review list every pending suggestion ---------------------------------
const reviewOpts = { ...synthesis, shallowResearch: false };
const sug = (title, parentTitle) => ({ title, task: `do ${title}`, contribution: '', ...(parentTitle === undefined ? {} : { parentTitle }) });

test('review count: the options entry gets every pending row, orphans included (button N = list N)', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  h.host.pendingSuggestions.set(p.path, [sug('X', 'Ghost'), sug('Y', 'P')]);
  const found = [];
  await h.view.proposeChildren(p, reviewOpts, '', items => found.push(items), message => assert.fail(message));
  assert.equal(found.length, 1);
  assert.equal(found[0].length, 2, 'both rows reach the list');
  assert.equal(h.calls.length, 0, 'no AI call');
});

test('review count: a real parent and child both reach the list with parentTitle kept', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  h.host.pendingSuggestions.set(p.path, [sug('Parent', ''), sug('Child', 'Parent')]);
  const found = [];
  await h.view.proposeChildren(p, reviewOpts, '', items => found.push(items), message => assert.fail(message));
  assert.deepEqual(found[0].map(item => [item.title, item.parentTitle]), [['Parent', ''], ['Child', 'Parent']]);
});

test('review count: without pending the options entry still calls the AI and opens no empty list', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  let opened = 0;
  await h.view.proposeChildren(p, reviewOpts, '', () => { opened++; }, () => {});
  assert.equal(h.calls.length, 1, 'AI called once');
  assert.equal(opened, 0, 'no list opened');
});

test('review count: creating an orphan row builds it under the current topic and clears pending', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  h.host.pendingSuggestions.set(p.path, [sug('X', 'Ghost'), sug('Y', 'P')]);
  let found, create;
  await h.view.proposeChildren(p, reviewOpts, '', (items, run) => { found = items; create = run; }, message => assert.fail(message));
  await create(found.map(item => ({ ...item, parentTitle: '' }))); // renderProposalList makes orphan / self-parent rows first-level
  const kidNodes = h.view.map.nodes.filter(node => node.parentId === p.id);
  const kids = (await Promise.all(kidNodes.map(node => h.repo.readNote(node.path, h.view.map)))).map(note => note.title).sort();
  assert.deepEqual(kids, ['X', 'Y']);
  assert.equal(h.host.pendingSuggestions.has(p.path), false, 'pending cleared');
});

// UI audit bugfix-2 P2: the suggestions dialog refuses creating subtopics under a locked topic and says how to proceed; its button keeps the focus.
test('P2: creating suggested subtopics under a locked topic says how to proceed and keeps the focus on the button', async () => {
  const h = await harness(['P']);
  const [p] = h.nodes;
  await h.view.setAiLock([p], true);
  h.host.pendingSuggestions.set(p.path, [sug('X', ''), sug('Y', 'P')]);
  const note = await h.repo.readNote(p.path, h.view.map);
  const panel = dom.element('panel');
  h.view.renderPendingProposals(panel, p, note, () => {});
  const create = dom.findAll(panel, el => el.tag === 'button' && /子議題|subtopic/i.test(el.text))[0];
  assert.ok(create, 'the create button is drawn');
  create.focus();
  create.listeners.click[0]();
  const status = () => dom.findAll(panel, el => el.cls.includes('vam-next-status'))[0];
  await until(() => status()?.text);
  assert.match(status().text, LOCKED_NOTICE, 'the reason');
  assert.match(status().text, /解除 AI 鎖定|unlock AI/i, 'the next step');
  assert.equal(create.disabled, false, 'the button is not disabled by the refusal');
  assert.equal(dom.focusedNow(), create, 'the focus stays on the button');
  assert.equal(h.view.map.nodes.length, 1, 'no subtopic is created');
});
