// 0.25 FG20-06/07/08/10: moved or copied branches, a re-parented branch and a new card are laid out against the
// measured card heights in the same history entry as the change; one AI "Create subtopics" is one undo step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, core } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const WIDTH = 300, GAP = 24;
const MAP = 'Agent Workspace/Topics/map-l/Map.md';

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
