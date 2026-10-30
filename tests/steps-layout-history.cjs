// 0.25 FG20-06/07/08/10: moved or copied branches, a re-parented branch and a new card are laid out against the
// measured card heights in the same history entry as the change; one AI "Create subtopics" is one undo step.
// Also a child batch (camera framing) and the re-space of quick-research cards against measured heights.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, core, topicNote } = require('./support.cjs');
const replay = require('./support-replay.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const WIDTH = 300, GAP = 24;
const MAP = 'Agent Workspace/Topics/map-l/Map.md';

/** A view without a real vault: only the fields the method under test reads. */
function bareView(plugin, extra = {}) {
  const { VisualAgentMapView } = replay.load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  return Object.assign(Object.create(VisualAgentMapView.prototype), { plugin, renderingCard: false, ...extra });
}

/** A view over a fake vault; `spec` is [title, parentTitle|null, x, y] per node, `heights` maps title -> card height. */
async function harness(spec = [['Root', null, 80, 80]], heights = {}) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-l', title: 'Layout', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-l');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const node = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(node, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    byTitle.set(title, node);
    mapDoc.nodes.push(node);
  }
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  const focused = [];
  view.focusNode = node => focused.push(node.id); view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const titleOf = id => view.notes.get(id)?.title ?? view.map.nodes.find(n => n.id === id)?.path;
  view.cardHeightOf = id => heights[titleOf(id)] ?? 180;
  const node = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const notesIn = folder => [...contents.keys()].filter(p => p.startsWith(`Agent Workspace/Topics/map-l/${folder}/`) && p.endsWith('.md'));
  const orphans = () => notesIn('Notes').filter(p => /agent-map-id: map-l/.test(contents.get(p)) && !view.map.nodes.some(n => n.path === p));
  const positions = () => JSON.stringify(view.map.nodes.map(n => [n.id, n.parentId, n.x, n.y]));
  const overlaps = () => {
    const found = [];
    for (const a of view.map.nodes) for (const b of view.map.nodes) {
      if (a.id >= b.id) continue;
      const ha = view.cardHeightOf(a.id), hb = view.cardHeightOf(b.id);
      if (Math.abs(a.x - b.x) < WIDTH && a.y < b.y + hb && b.y < a.y + ha) found.push([titleOf(a.id), titleOf(b.id)]);
    }
    return found;
  };
  const undoAll = async () => { while (view.history.canUndo) await view.travel(false); };
  return { repo, app, contents, view, node, notesIn, orphans, positions, overlaps, focused, titleOf, undoAll };
}

test('History: collapseSince runs undo newest first, redo oldest first, and is skipped after clear() or for fewer than two entries', async () => {
  const { History } = load('map-model.ts');
  const log = [];
  const entry = name => ({ undo: async () => { log.push(`u${name}`); }, redo: async () => { log.push(`r${name}`); } });
  const h = new History();
  h.push(entry('A'));
  const mark = h.mark();
  h.push(entry('B')); h.push(entry('C')); h.push(entry('D'));
  h.collapseSince(mark, 'batch');
  assert.equal(h.undoEntry.label, 'batch');
  const first = h.undo(); await first.undo();
  assert.deepEqual(log, ['uD', 'uC', 'uB']);
  assert.equal(h.undoEntry && h.canUndo, true, 'A is still its own entry');
  log.length = 0;
  const again = h.redo(); await again.redo();
  assert.deepEqual(log, ['rB', 'rC', 'rD']);
  // cleared in between: nothing collapses, the surviving entries stay separate
  const c = new History();
  const m = c.mark();
  c.push(entry('X')); c.clear(); c.push(entry('Y')); c.push(entry('Z'));
  c.collapseSince(m);
  c.undo(); c.undo();
  assert.equal(c.canUndo, false, 'Y and Z were two entries');
  // fewer than two entries: left as they are
  const s = new History(); const m2 = s.mark(); const only = entry('S'); s.push(only);
  s.collapseSince(m2, 'x');
  assert.equal(s.undoEntry, only);
  // a push after the mark also clears redo
  const r = new History(); r.push(entry('P')); r.undo(); const m3 = r.mark(); r.push(entry('Q')); r.push(entry('R')); r.collapseSince(m3);
  assert.equal(r.canRedo, false);
});

test('FG20-08: a new child is placed below a 400px sibling, a new root below the lowest root, one history entry each', async () => {
  const h = await harness([['Root', null, 80, 80], ['Tall', 'Root', 420, 80], ['Other', null, 80, 600]], { Tall: 400, Root: 180, Other: 180 });
  const before = h.positions();
  await h.view.addNode(h.node('Root'), 'Second');
  const second = h.node('Second');
  assert.deepEqual(h.overlaps(), [], 'no card on top of another');
  assert.equal(second.parentId, h.node('Root').id);
  assert.ok(second.y >= 80 + 400 + GAP, `Second starts below Tall (y=${second.y})`);
  await h.view.addNode(h.node('Root'), 'Third');
  assert.deepEqual(h.overlaps(), []);
  await h.view.addNode(null, 'Fresh root');
  const fresh = h.node('Fresh root');
  assert.equal(fresh.x, 80);
  assert.equal(fresh.y, 600 + 180 + GAP, 'below the lowest existing root');
  assert.deepEqual(h.overlaps(), []);
  // exactly one history entry per add
  await h.view.travel(false);
  assert.equal(h.node('Fresh root'), undefined); assert.ok(h.node('Third'));
  await h.view.travel(false);
  assert.equal(h.node('Third'), undefined); assert.ok(h.node('Second'));
  await h.view.travel(false);
  assert.equal(h.view.history.canUndo, false);
  assert.equal(h.positions(), before);
  assert.deepEqual(h.orphans(), []);
});

test('FG20-08: addNode with focus=false returns before focusNode and with focus=true focuses the laid-out card', async () => {
  const h = await harness();
  await h.view.addNode(h.node('Root'), 'Quiet', true, false);
  assert.deepEqual(h.focused, []);
  await h.view.addNode(h.node('Root'), 'Loud');
  assert.deepEqual(h.focused, [h.node('Loud').id]);
});

test('FG20-06: Move to... lays the moved branches out clear of the target\'s children; one undo restores the old positions', async () => {
  const spec = [['Root', null, 80, 80], ['Target', 'Root', 420, 80], ['Kid1', 'Target', 760, 80], ['Kid2', 'Target', 760, 304],
    ['Src', 'Root', 420, 700], ['Leaf1', 'Src', 760, 700], ['Leaf2', 'Src', 760, 924], ['Solo', 'Root', 420, 1200]];
  const h = await harness(spec, { Kid1: 200, Kid2: 200, Leaf1: 300, Leaf2: 300, Solo: 250 });
  const before = h.positions();
  h.view.multiSelected = new Set([h.node('Src').id, h.node('Solo').id]);
  h.view.mergeUnlocked = () => true;
  await h.view.moveSelected(h.node('Target'));
  assert.equal(h.node('Src').parentId, h.node('Target').id);
  assert.equal(h.node('Leaf1').parentId, h.node('Src').id);
  assert.deepEqual(h.overlaps(), []);
  assert.ok(h.node('Leaf1').x > h.node('Target').x, 'descendants moved with their root');
  assert.equal(h.node('Kid1').y, 80, 'existing children stay put'); assert.equal(h.node('Kid2').y, 304);
  assert.equal(h.view.multiSelected.size, 0);
  await h.view.travel(false);
  assert.equal(h.positions(), before, 'one undo restores parents and positions');
  assert.equal(h.view.history.canUndo, false, 'one history entry');
});

test('FG20-06: Copy to... lays the copies out clear of the target\'s children; one undo removes them all', async () => {
  const spec = [['Root', null, 80, 80], ['Target', 'Root', 420, 80], ['Kid1', 'Target', 760, 80], ['Kid2', 'Target', 760, 304],
    ['Src', 'Root', 420, 700], ['Leaf', 'Src', 760, 700]];
  const h = await harness(spec, { Kid1: 200, Kid2: 200, Leaf: 300, Src: 200 });
  h.view.multiSelected = new Set([h.node('Src').id]);
  h.view.mergeUnlocked = () => true;
  const count = h.view.map.nodes.length;
  await h.view.copySelected(h.node('Target'));
  assert.equal(h.view.map.nodes.length, count + 2);
  const copies = h.view.map.nodes.filter(n => !spec.some(s => h.titleOf(n.id) === s[0]));
  assert.equal(copies.length, 2);
  // copies get measured as the median height of rendered cards (180 here is the fake); give them real heights
  h.view.cardHeightOf = id => ({ Kid1: 200, Kid2: 200, Leaf: 300, Src: 200 })[h.titleOf(id)] ?? 200;
  assert.deepEqual(h.overlaps(), []);
  for (const copy of copies) assert.ok(copy.x >= h.node('Target').x + 300, 'under the target');
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, count);
  assert.equal(h.view.history.canUndo, false, 'one history entry');
  assert.deepEqual(h.orphans(), []);
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.length, count + 2);
  assert.deepEqual(h.overlaps(), []);
});

test('FG20-07: Structure and links > Apply re-lays out the moved subtree; one undo restores it', async () => {
  const spec = [['R1', null, 80, 80]];
  for (let i = 1; i <= 7; i++) spec.push([`L${i}`, i === 1 ? 'R1' : `L${i - 1}`, 80 + 340 * i, 80]);
  spec.push(['R2', null, 80, 600], ['R2kid', 'R2', 420, 600]);
  const h = await harness(spec, { R2kid: 250, R2: 250 });
  const before = h.positions();
  const panel = element('div');
  h.view.mergeUnlocked = () => true;
  h.view.enqueue = fn => fn();
  h.view.renderInspector(panel, h.node('L4'), 'structure');
  const rows = dom.findAll ? dom.findAll(panel, i => i.tag === 'button') : [];
  const row = rows.find(b => b.dataset?.id === h.node('R2').id);
  assert.ok(row, 'the topic tree lists R2');
  row.click();
  const apply = dom.findAll(panel, i => i.tag === 'button').find(b => b.text === 'Apply' && b.cls.includes('mod-cta'));
  assert.ok(apply && !apply.disabled);
  apply.click();
  await dom.tick();
  await dom.tick();
  assert.equal(h.node('L4').parentId, h.node('R2').id);
  assert.deepEqual(h.overlaps(), []);
  assert.ok(h.node('L5').x > h.node('L4').x && h.node('L7').x > h.node('L6').x, 'descendants keep their column order');
  assert.ok(h.node('L4').x > h.node('R2').x && h.node('L4').x < h.node('R2').x + 400, 'the branch sits one column right of its new parent');
  await h.view.travel(false);
  assert.equal(h.positions(), before);
  assert.equal(h.view.history.canUndo, false, 'one history entry');
});

test('FG20-07: Apply with no parent makes the branch a new tree below everything, without overlap', async () => {
  const h = await harness([['R1', null, 80, 80], ['A', 'R1', 420, 80], ['A1', 'A', 760, 80]], { A: 200, A1: 200, R1: 200 });
  const panel = element('div');
  h.view.mergeUnlocked = () => true;
  h.view.enqueue = fn => fn();
  h.view.renderInspector(panel, h.node('A'), 'structure');
  const rows = dom.findAll(panel, i => i.tag === 'button');
  rows.find(b => b.dataset?.id === '').click();
  dom.findAll(panel, i => i.tag === 'button').find(b => b.text === 'Apply' && b.cls.includes('mod-cta')).click();
  await dom.tick(); await dom.tick();
  assert.equal(h.node('A').parentId, null);
  assert.deepEqual(h.overlaps(), []);
  assert.ok(h.node('A').y >= 80 + 200, 'below the remaining root');
  assert.equal(h.node('A1').parentId, h.node('A').id);
  await h.view.travel(false);
  assert.equal(h.node('A').parentId, h.node('R1').id); assert.equal(h.node('A').x, 420);
});

test('FG20-10: five AI children are one undo step (notes parked, none orphaned) and one redo restores exactly', async () => {
  const h = await harness();
  await h.view.addNode(h.node('Root'), 'Mine');
  const items = ['One', 'Two', 'Three', 'Four', 'Five'].map(title => ({ title, task: `do ${title}` }));
  items.push({ title: 'Under one', task: 'c', parentTitle: 'One' });
  const afterMine = h.positions();
  const children = await h.view.createChildBatch(h.node('Root'), items);
  assert.equal(children.length, 6);
  assert.equal(h.view.map.nodes.length, 8);
  const full = h.positions();
  const fullNotes = h.notesIn('Notes').sort();
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 2, 'the whole batch left the map in one undo; Mine and Root remain');
  assert.ok(h.node('Mine'));
  assert.equal(h.positions(), afterMine);
  assert.deepEqual(h.orphans(), []);
  assert.equal(h.notesIn('Unassigned').length, 6);
  assert.equal(h.view.history.canUndo, true, 'Mine is its own earlier entry');
  await h.view.travel(true);
  assert.equal(h.positions(), full, 'redo restores ids, parents and coordinates exactly');
  assert.deepEqual(h.notesIn('Notes').sort(), fullNotes);
  assert.equal(h.notesIn('Unassigned').length, 0);
  assert.equal(h.view.history.canRedo, false, 'a single redo');
  assert.deepEqual(h.overlaps(), []);
});

test('FG20-10: a batch that fails part-way still groups what was created into one undo step', async () => {
  const h = await harness();
  const real = h.view.noteChange.bind(h.view);
  let calls = 0;
  h.view.noteChange = async (node, patch) => { if (++calls === 3) throw new Error('boom'); return real(node, patch); };
  await assert.rejects(h.view.createChildBatch(h.node('Root'), ['A', 'B', 'C', 'D'].map(title => ({ title, task: 't' }))), error => /boom/.test(error.message));
  assert.ok(h.view.map.nodes.length >= 3, 'created cards stay');
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1, 'one undo removes every card the batch created');
  assert.equal(h.view.history.canUndo, false);
  assert.deepEqual(h.orphans(), []);
});

test('FG20-10: history cleared during the batch (conflict window) skips the collapse and does not break anything', async () => {
  const h = await harness();
  const real = h.view.noteChange.bind(h.view);
  let calls = 0;
  h.view.noteChange = async (node, patch) => { if (++calls === 2) h.view.history.clear(); return real(node, patch); };
  const children = await h.view.createChildBatch(h.node('Root'), ['A', 'B', 'C'].map(title => ({ title, task: 't' })));
  assert.equal(children.length, 3);
  // only entries pushed after the clear remain, and they were not folded with the earlier ones
  let steps = 0;
  while (h.view.history.canUndo) { await h.view.travel(false); steps++; }
  assert.ok(steps >= 2, `the surviving entries stay separate (${steps})`);
});

test('FG20-08: a new child goes after its siblings and clears a cousin tree below them (no new overlap)', async () => {
  const h = await harness([['A', null, 80, 80], ['A1', 'A', 440, 400], ['B', null, 80, 900], ['B1', 'B', 440, 604]], { A1: 180, B1: 180, A: 180, B: 180 });
  await h.view.addNode(h.node('A'), 'New');
  assert.deepEqual(h.overlaps(), []);
  assert.ok(h.node('New').y >= 400 + 180 + GAP, 'after its sibling, not in the gap above it');
});

test('a child batch frames the parent and every new child without Show all, and addNode(focus=false) leaves the camera alone', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 40, y: 40, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = replay.load('main.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } });
  const view = new VisualAgentMapView({ app }, withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, mutate: async fn => fn() }));
  let focused = 0;
  Object.assign(view, { path: mapPath, map: mapDoc, render: () => {}, hydrate: async () => {}, focusNode: () => { focused++; }, saveViewport: () => {}, canvasInset: () => 58,
    viewportEl: { clientWidth: 1000, clientHeight: 700 } });
  const items = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(title => ({ title, task: title, contribution: '' }));
  await view.createChildBatch(parent, items);
  assert.equal(focused, 0, 'no per-child focus on the pre-layout position');
  const { x, y, zoom } = view.map.viewport;
  for (const node of view.map.nodes) {
    const h = view.cardHeightOf(node.id) ?? 180;
    assert.ok(node.x * zoom + x >= 0 && (node.x + 280) * zoom + x <= 1000, `${node.id} horizontally visible`);
    assert.ok(node.y * zoom + y >= 58 && (node.y + h) * zoom + y <= 700, `${node.id} vertically visible below the toolbar`);
  }
  assert.ok(zoom <= 1);
});


test('after quick research the untouched batch cards are re-spaced against measured heights; a dragged card and siblings stay', async () => {
  const mk = (id, parentId, x, y) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false });
  const nodes = [mk('p', null, 0, 0), mk('s', 'p', 340, 0), mk('c1', 'p', 340, 220), mk('c2', 'p', 340, 440), mk('c3', 'p', 340, 660)];
  const heights = { p: 180, s: 180, c1: 180, c2: 180, c3: 180 };
  const writes = [];
  const view = bareView({ mutate: async fn => fn(), repo: { updateMap: async (p, fn) => { const doc = { nodes: JSON.parse(JSON.stringify(view.map.nodes)) }; fn(doc); writes.push(doc.nodes); } } },
    { map: { nodes }, closed: false, builtIn: false, path: 'Map.md', cardHeightOf: id => heights[id] });
  const placed = new Map(['c1', 'c2', 'c3'].map(id => [id, { x: 340, y: nodes.find(n => n.id === id).y }]));
  Object.assign(heights, { c1: 500, c2: 500, c3: 500 }); // research filled the cards
  nodes.find(n => n.id === 'c3').y = 1234; // the user dragged c3
  await view.respaceBatch(nodes[0], placed);
  assert.equal(writes.length, 1, 'one Map.md write');
  const by = Object.fromEntries(view.map.nodes.map(n => [n.id, n]));
  assert.equal(by.c3.y, 1234, 'dragged card stays');
  assert.equal(by.s.y, 0, 'sibling stays');
  const flow = ['s', 'c1', 'c2'].map(id => by[id]).sort((a, b) => a.y - b.y);
  for (let i = 1; i < flow.length; i++) assert.ok(flow[i].y >= flow[i - 1].y + heights[flow[i - 1].id], `no overlap ${flow[i - 1].id}/${flow[i].id}`);
  await view.respaceBatch(nodes[0], placed);
  assert.equal(writes.length, 1, 'a second pass with nothing left to move writes nothing');
});


test('re-space race: a drag queued before the re-space wins, and memory and disk stay identical (so the next mapChange sees no conflict)', async () => {
  const mk = (id, parentId, x, y) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false });
  const nodes = [mk('p', null, 0, 0), mk('c1', 'p', 340, 0), mk('c2', 'p', 340, 220)];
  const disk = { nodes: JSON.parse(JSON.stringify(nodes)) };
  let chain = Promise.resolve();
  const plugin = { mutate: fn => { const run = chain.then(fn); chain = run.catch(() => {}); return run; }, repo: { updateMap: async (_p, fn) => { fn(disk); } } };
  const view = bareView(plugin, { map: { nodes }, closed: false, builtIn: false, path: 'Map.md', cardHeightOf: () => 500 });
  const placed = new Map([['c1', { x: 340, y: 0 }], ['c2', { x: 340, y: 220 }]]);
  // The user drags c2: the drag is queued first and lands in memory and on disk before the re-space runs.
  const drag = plugin.mutate(async () => { nodes[2].y = 900; disk.nodes[2].y = 900; });
  await Promise.all([drag, view.respaceBatch(nodes[0], placed)]);
  assert.equal(view.map.nodes[2].y, 900, 'the dragged card keeps its position');
  assert.equal(disk.nodes[2].y, 900);
  assert.deepEqual(JSON.parse(JSON.stringify(view.map.nodes)), disk.nodes, 'memory equals disk: mapChange raises no conflict dialog and keeps history');
});
