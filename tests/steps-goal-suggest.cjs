// GoalSuggest (experiences/visual-map/goal-suggest.ts) on its own: fake ports, a fake plugin and the shared DOM double, no view.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { hasCls, element, find, findAll } = dom;
const { GoalSuggest } = load('experiences/visual-map/goal-suggest.ts', { obsidian: {} });
const { History } = load('map-model.ts');

const MAP = 'map.md';
const sug = (parentId, title, tier = 'core') => ({ parentId, title, summary: 's', suggestedTier: tier });

function setup(options = {}) {
  const state = { path: MAP, closed: false, merging: new Set(), locked: new Set(), titles: { root: 'Root', a: 'A', b: 'B' } };
  const map = { title: 'Map', nodes: [{ id: 'root', path: 'root.md', parentId: null }, { id: 'a', path: 'a.md', parentId: 'root' }, { id: 'b', path: 'b.md', parentId: 'root' }] };
  const tiers = new Map([['root.md', 'core'], ['a.md', 'support'], ['b.md', 'support']]);
  const listeners = [];
  const root = element('div');
  root.ownerDocument = { addEventListener: (name, fn) => name === 'pointerdown' && listeners.push(fn), removeEventListener: (name, fn) => { const i = listeners.indexOf(fn); if (name === 'pointerdown' && i >= 0) listeners.splice(i, 1); } };
  root.querySelector = () => null;
  const log = { renders: 0, tools: 0, refocus: 0, notices: [], announced: [], added: [], restores: [], historyButtons: 0 };
  const history = new History();
  const plugin = {
    mutate: options.mutate ?? (async work => { await work(); }),
    rebuildDerivedData: async () => {},
    logs: { appendLog() {} },
    repo: {
      readNote: async path => ({ title: path, relevance: { tier: tiers.get(path) ?? 'support' } }),
      writeRelevance: async (path, value) => { tiers.set(path, value.tier); }
    }
  };
  const notes = new Map(map.nodes.map(n => [n.id, { title: state.titles[n.id] }]));
  const ports = {
    plugin: () => plugin, path: () => state.path, closed: () => state.closed, map: () => map, notes: () => notes, history: () => history,
    contentEl: () => root, render: () => { log.renders++; }, placeMapTools: () => { log.tools++; }, focusGoalReturn: () => { log.refocus++; },
    whenEditing: action => action(), lockedParent: (id, fresh) => state.locked.has(id), isMerging: id => state.merging.has(id),
    describe: id => (state.titles[id] === undefined ? undefined : { title: state.titles[id], summary: '', status: '' }),
    freshNotesOf: async ids => new Map(ids.map(id => [id, { title: state.titles[id] }])),
    addNode: async (parent, title) => { log.added.push([parent.id, title]); const id = `n${map.nodes.length}`; map.nodes.push({ id, path: `${id}.md`, parentId: parent.id }); notes.set(id, { title }); },
    restoreRelevance: async (changes, direction) => { log.restores.push([changes, direction]); },
    updateHistoryButtons: () => { log.historyButtons++; }, announce: text => log.announced.push(text), notice: message => log.notices.push(message)
  };
  const suggest = new GoalSuggest(ports);
  const bar = element('div');
  bar.querySelector = () => null;
  const draw = () => { bar.empty(); suggest.detach(); suggest.draw(bar); };
  return { suggest, state, map, notes, tiers, listeners, root, log, history, ports, plugin, bar, draw };
}
const addBtn = bar => find(bar, i => hasCls(i, 'vam-goal-suggest-add'));
const boxes = bar => findAll(bar, i => i.tag === 'input');

test('goal suggest: open makes a ready task with every card checked, the basis of each parent, and draws the list with the focus in it', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One'), sug('b', 'Two')], true);
  const task = s.suggest.task;
  assert.equal(task.state, 'ready'); assert.equal(task.mapPath, MAP); assert.equal(task.focus, 'list');
  assert.equal(task.checked.size, 2); assert.ok(task.checked.has(0) && task.checked.has(1));
  assert.equal(task.basis.get('a').title, 'A'); assert.equal(task.basis.get('a').parentId, 'root');
  assert.equal(s.log.renders, 1);
  s.draw();
  assert.equal(findAll(s.bar, i => hasCls(i, 'vam-goal-suggest-row')).length, 2);
  assert.equal(boxes(s.bar)[0].focused, true, 'the focus goes to the first box');
  assert.equal(task.focus, null, 'consumed by the draw');
  assert.equal(s.listeners.length, 1, 'one outside listener');
  assert.equal(addBtn(s.bar).text, 'Add 2');
});

test('goal suggest: with takeFocus false the list opens without taking the focus', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], false);
  assert.equal(s.suggest.task.focus, null);
  s.draw();
  assert.ok(!boxes(s.bar)[0].focused);
});

test('goal suggest: when every parent is locked, open counts them in a Notice and closes at once', () => {
  const s = setup();
  s.state.locked.add('a'); s.state.locked.add('b');
  s.suggest.open(MAP, [sug('a', 'One'), sug('b', 'Two')], true);
  assert.equal(s.suggest.task, null);
  assert.equal(s.log.notices.length, 1); assert.match(s.log.notices[0], /^2 suggestions touch locked topics/);
  assert.equal(s.log.renders, 1, 'the closing repaint'); assert.equal(s.log.refocus, 1, 'focus returns to the recommend button');
});

test('goal suggest: end does nothing for a task that is not the current one', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], true);
  const stranger = { controller: new AbortController(), state: 'ready' };
  const renders = s.log.renders;
  s.suggest.end(stranger, { refocus: true });
  assert.equal(stranger.controller.signal.aborted, false);
  assert.notEqual(s.suggest.task, null); assert.equal(s.log.renders, renders); assert.equal(s.log.refocus, 0);
});

test('goal suggest: end aborts the task, removes the listener and the panel, repaints and refocuses; repaint false only places the tools', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], true); s.draw();
  const { controller } = s.suggest.task;
  s.suggest.end(s.suggest.task, { refocus: true });
  assert.equal(controller.signal.aborted, true); assert.equal(s.suggest.task, null); assert.equal(s.listeners.length, 0);
  assert.equal(s.log.renders, 2); assert.equal(s.log.refocus, 1);
  s.suggest.open(MAP, [sug('a', 'One')], true); s.draw();
  const renders = s.log.renders;
  s.suggest.end(s.suggest.task, { refocus: false, repaint: false });
  assert.equal(s.log.renders, renders); assert.equal(s.log.tools, 1);
});

test('goal suggest: drop only aborts and forgets the task; the listener and the panel handle stay (detach and releaseListener do the cleanup)', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], true); s.draw();
  const { controller } = s.suggest.task;
  const panel = find(s.bar, i => hasCls(i, 'vam-goal-suggest'));
  s.suggest.drop();
  assert.equal(controller.signal.aborted, true); assert.equal(s.suggest.task, null);
  assert.equal(s.listeners.length, 1, 'drop does not clean up the listener');
  assert.equal(s.suggest.holdsFocus(boxes(s.bar)[0]), true, 'nor the panel handle');
  s.suggest.releaseListener();
  assert.equal(s.listeners.length, 0);
  assert.ok(panel);
});

test('goal suggest: detach only cleans the listener and the panel handle; the task keeps running (not aborted)', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], true); s.draw();
  const task = s.suggest.task;
  s.suggest.detach();
  assert.equal(task.controller.signal.aborted, false); assert.equal(s.suggest.task, task);
  assert.equal(s.listeners.length, 0); assert.equal(s.suggest.holdsFocus(boxes(s.bar)[0]), false);
});

test('goal suggest: releaseListener only drops the document listener', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], true); s.draw();
  const task = s.suggest.task;
  s.suggest.releaseListener();
  assert.equal(s.listeners.length, 0); assert.equal(s.suggest.task, task); assert.equal(task.controller.signal.aborted, false);
  assert.equal(s.suggest.holdsFocus(boxes(s.bar)[0]), true);
});

test('goal suggest: dismiss closes an open task without a repaint and does nothing without one', () => {
  const s = setup();
  s.suggest.dismiss();
  assert.equal(s.log.renders, 0);
  s.suggest.open(MAP, [sug('a', 'One')], true); s.draw();
  const renders = s.log.renders;
  s.suggest.dismiss();
  assert.equal(s.suggest.task, null); assert.equal(s.log.renders, renders); assert.equal(s.log.tools, 1); assert.equal(s.listeners.length, 0);
});

test('goal suggest: draw on another map aborts the task and draws nothing', () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One')], true);
  const { controller } = s.suggest.task;
  s.state.path = 'other.md';
  s.draw();
  assert.equal(controller.signal.aborted, true); assert.equal(s.suggest.task, null);
  assert.equal(findAll(s.bar, i => hasCls(i, 'vam-goal-suggest')).length, 0);
});

test('goal suggest: Add adds the checked cards with the list tier, announces, closes, and writes no summary', async () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One', 'core'), sug('b', 'Two', 'support')], true); s.draw();
  boxes(s.bar)[1].checked = false; boxes(s.bar)[1].fire('change');
  addBtn(s.bar).click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(s.log.added, [['a', 'One']]);
  assert.equal(s.tiers.get('n3.md'), 'core');
  assert.equal(s.suggest.task, null); assert.deepEqual(s.log.announced, ['Added 1 topics']);
  assert.equal(s.log.refocus, 0, 'something was added: the focus is not forced back');
  assert.ok(s.log.historyButtons >= 1);
});

test('goal suggest: a path change inside the write skips every suggestion, adds nothing and says so', async () => {
  const s = setup({ mutate: async work => { s.state.path = 'other.md'; await work(); } });
  s.suggest.open(MAP, [sug('a', 'One'), sug('b', 'Two')], true); s.draw();
  addBtn(s.bar).click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(s.log.added, []);
  assert.deepEqual(s.log.notices, ['2 recommendations no longer fit the map and were skipped']);
  assert.equal(s.suggest.task, null);
  assert.equal(s.log.refocus, 1, 'nothing added: the focus goes back');
  assert.deepEqual(s.log.announced, []);
});

test('goal suggest: a suggestion is stale when its parent is gone, renamed, moved, merging or locked, or its title is taken; the rest is added', async () => {
  const s = setup();
  s.map.nodes.push({ id: 'c', path: 'c.md', parentId: 'a' }, { id: 'd', path: 'd.md', parentId: 'a' }, { id: 'e', path: 'e.md', parentId: 'a' });
  Object.assign(s.state.titles, { c: 'C', d: 'D', e: 'E' });
  for (const id of ['c', 'd', 'e']) s.notes.set(id, { title: s.state.titles[id] });
  s.suggest.open(MAP, [sug('a', 'Gone'), sug('b', 'Renamed'), sug('c', 'Moved'), sug('d', 'Merging'), sug('e', 'Locked'), sug('root', 'Taken'), sug('root', 'Fine')], true);
  s.notes.set('x', { title: 'Taken' }); s.map.nodes.push({ id: 'x', path: 'x.md', parentId: 'root' });
  // After the list opened: a is deleted, b renamed, c moved under b, d merging, e locked (lock seen only with the fresh notes).
  s.map.nodes = s.map.nodes.filter(n => n.id !== 'a');
  s.state.titles.b = 'B renamed';
  s.map.nodes.find(n => n.id === 'c').parentId = 'b';
  s.state.merging.add('d');
  s.ports.lockedParent = (id, fresh) => id === 'e' && !!fresh;
  s.draw();
  addBtn(s.bar).click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(s.log.added, [['root', 'Fine']]);
  assert.deepEqual(s.log.notices, ['6 recommendations no longer fit the map and were skipped']);
});

test('goal suggest: after Add a parent that ranks below its new card is raised in the same single history step, and undo and redo go through restoreRelevance', async () => {
  const s = setup();
  s.suggest.open(MAP, [sug('a', 'One', 'core')], true); s.draw();
  addBtn(s.bar).click();
  await new Promise(r => setImmediate(r));
  assert.equal(s.tiers.get('a.md'), 'core', 'the parent was raised to the new card');
  assert.equal(s.history.past.length, 1, 'one history entry for the whole add');
  const entry = s.history.past[0];
  await entry.undo();
  await entry.redo();
  assert.deepEqual(s.log.restores.map(([, direction]) => direction), ['undo', 'redo']);
  assert.equal(s.log.restores[0][0].length, 1); assert.equal(s.log.restores[0][0][0].id, 'a'); assert.equal(s.log.restores[0][0][0].raised, true);
});

test('goal suggest: the sequence behind the task tokens counts on across instances', () => {
  const first = setup(), second = setup();
  first.suggest.open(MAP, [sug('a', 'One')], true);
  second.suggest.open(MAP, [sug('a', 'One')], true);
  const a = first.suggest.task.token, b = second.suggest.task.token;
  first.suggest.drop();
  first.suggest.open(MAP, [sug('a', 'One')], true);
  assert.ok(b > a); assert.ok(first.suggest.task.token > b);
});
