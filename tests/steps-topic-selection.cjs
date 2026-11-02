// TopicSelection P1: rule table for the pure selection module. Every expected value is hand-read from view.ts at f852afa
// (line numbers in the comments); the view is not an oracle. Each copy of a rule that is written differently has its own row.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support.cjs');

const { TopicSelection } = load('experiences/visual-map/topic-selection.ts', {});
const AIM = { canMultiSelect: false };
const MAP = { canMultiSelect: true };
const SHOWN = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'a' }];

const fresh = () => new TopicSelection();
const st = s => {
  const v = s.state;
  return { selected: v.selected, multi: [...v.multiSelected], mode: v.multiSelectMode, relation: v.selectedRelation, stop: v.tabStopId };
};
const ch = c => ({ touched: [...c.touched], mode: c.multiSelectModeChanged, relation: c.relationChanged });
const NONE = { touched: [], mode: false, relation: false };
// Builds a state through operations only.
function seeded({ selected = null, multi = [], mode = false, relation = null, stop = null } = {}) {
  const s = fresh();
  if (mode) s.toggleMultiSelect();
  if (multi.length) s.replaceMulti(multi);
  if (selected) s.setSelected(selected);
  if (relation) s.selectRelation(relation);
  if (stop) s.moveTabStop(stop);
  return s;
}

// ---- slice 1: single select (three copies) ----
test('click selects one topic: view.ts 17606-17609 and revealPath 10899-10902', () => {
  const s = fresh();
  assert.deepEqual(ch(s.click('b', MAP)), { touched: ['b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'b', multi: [], mode: false, relation: null, stop: null });
});
test('click replaces earlier selection and reports the old single and every old multi id', () => {
  const s = seeded({ selected: 'a', multi: ['c', 'd'] });
  assert.deepEqual(ch(s.click('b', MAP)), { touched: ['a', 'b', 'c', 'd'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'b', multi: [], mode: false, relation: null, stop: null });
});
test('click resets the tab stop when the caller passes the shown topics: applySelectionState 10562, defaultTabStop 10520', () => {
  const s = fresh();
  assert.deepEqual(ch(s.click('c', { ...MAP, shown: SHOWN })), { touched: ['c'], mode: false, relation: false });
  assert.equal(s.state.tabStopId, 'c');
  const t = fresh();
  // Selected id not shown: default falls back to the first root (10523-10524).
  assert.deepEqual(ch(t.click('zzz', { ...MAP, shown: SHOWN })), { touched: ['zzz', 'a'], mode: false, relation: false });
  assert.equal(t.state.tabStopId, 'a');
});
test('click without shown leaves the tab stop alone', () => {
  const s = seeded({ stop: 'b' });
  s.click('c', MAP);
  assert.equal(s.state.tabStopId, 'b');
});
test('click does not touch the multi-select mode (enableDrag plain branch 17606-17609 never writes integrationMode)', () => {
  const s = seeded({ mode: true });
  assert.deepEqual(ch(s.click('x', MAP)), { touched: ['x'], mode: false, relation: false });
  assert.equal(s.state.multiSelectMode, true);
});
test('selectIfChanged is click with a guard: selectMapNode 10908-10915 returns when nothing would change', () => {
  const s = seeded({ selected: 'a', relation: 'r1' });
  assert.deepEqual(ch(s.selectIfChanged('a', MAP)), NONE);
  assert.equal(s.state.selectedRelation, 'r1'); // the early return skips the commit that ends a relation selection
});
test('selectIfChanged proceeds when the multi set is not empty or the id differs', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.selectIfChanged('a', MAP)), { touched: ['a', 'b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: [], mode: false, relation: null, stop: null });
  assert.deepEqual(ch(s.selectIfChanged('c', MAP)), { touched: ['a', 'c'], mode: false, relation: false });
});
test('click has no guard: a click on the selected topic still reports it (enableDrag 17606 vs selectMapNode 10909)', () => {
  const s = seeded({ selected: 'a' });
  assert.deepEqual(ch(s.click('a', MAP)), { touched: ['a'], mode: false, relation: false });
});

// ---- slice 2: ending a line (relation) selection, and the copies that do not ----
test('click ends the relation selection: applySelectionState 10560', () => {
  const s = seeded({ relation: 'r1' });
  assert.deepEqual(ch(s.click('a', MAP)), { touched: ['a'], mode: false, relation: true });
  assert.equal(s.state.selectedRelation, null);
});
test('selectIfChanged, cmdClick (commit branch), toggles, marquee add/subtract, clearMulti and restore end it too', () => {
  const ops = [
    s => s.selectIfChanged('q', MAP),
    s => s.cmdClick('q', MAP),
    s => s.setChecked('q', true),
    s => s.toggleByClick('q'),
    s => s.toggleByEnter('q'),
    s => s.marquee(['q'], 'add', MAP),
    s => s.marquee(['q'], 'subtract', MAP),
    s => s.clearMulti(),
    s => s.restore({ selected: null, multiSelected: [] }, new Set())
  ];
  ops.forEach((op, index) => {
    const s = seeded({ relation: 'r1', multi: ['q'] });
    const change = op(s);
    assert.equal(s.state.selectedRelation, null, `op ${index}`);
    assert.equal(change.relationChanged, true, `op ${index}`);
  });
});
test('setSelected and the full-render paths do not end the relation selection', () => {
  // setSelected: 2065, 3937, 4162 ... 12651 write only the selected id then call render().
  const ops = [
    s => s.setSelected('q'),
    s => s.afterMerge('q'), // 5705
    s => s.afterSynthesis('q'), // 14638
    s => s.afterRemove(), // 7444
    s => s.afterPaste(), // 7734
    s => s.toggleMultiSelect(), // 9548
    s => s.exitMultiSelect('openMap'), // 2006
    s => s.chatSelect(['q']), // 16508
    s => s.cmdClick('q', MAP), // 17592-17604: with 'p' selected it seeds p, reaches two and enters via render()
    s => s.marquee(['q'], 'enter', MAP) // 14827
  ];
  ops.forEach((op, index) => {
    const s = seeded({ selected: 'p', relation: 'r1' });
    op(s);
    assert.equal(s.state.selectedRelation, 'r1', `op ${index}`);
  });
});
test('escape always ends the relation selection: view.ts 1267', () => {
  const s = seeded({ relation: 'r1' });
  assert.equal(s.escape().relationChanged, true);
  assert.equal(s.state.selectedRelation, null);
});

// ---- slice 3: Cmd/Ctrl click ----
test('cmdClick carries the single selected topic into the multi set and enters multi-select at two: view.ts 17592-17604', () => {
  const s = seeded({ selected: 'a' });
  assert.deepEqual(ch(s.cmdClick('b', MAP)), { touched: ['a', 'b'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'b', multi: ['a', 'b'], mode: true, relation: null, stop: null });
});
test('cmdClick with nothing selected adds one topic and stays out of multi-select', () => {
  const s = fresh();
  assert.deepEqual(ch(s.cmdClick('b', MAP)), { touched: ['b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'b', multi: ['b'], mode: false, relation: null, stop: null });
});
test('cmdClick on the selected topic does not seed it a second time (17596 previous !== node.id)', () => {
  const s = seeded({ selected: 'a' });
  s.cmdClick('a', MAP);
  assert.deepEqual(st(s), { selected: 'a', multi: ['a'], mode: false, relation: null, stop: null });
});
test('cmdClick does not seed when the multi set already has members', () => {
  const s = seeded({ selected: 'a', multi: ['c'] });
  assert.deepEqual(ch(s.cmdClick('b', MAP)), { touched: ['a', 'c', 'b'], mode: true, relation: false });
  assert.deepEqual(st(s).multi, ['c', 'b']);
});
test('cmdClick on a member removes it and leaves a single member out of multi-select', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c'] });
  assert.deepEqual(ch(s.cmdClick('b', MAP)), { touched: ['a', 'b', 'c'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'b', multi: ['c'], mode: false, relation: null, stop: null });
});

// ---- slice 4: AIM maps cannot enter multi-select ----
test('cmdClick in an AIM map never seeds and never enters multi-select: view.ts 17596 and 17601 test canSelectTopics()', () => {
  const s = seeded({ selected: 'a' });
  assert.deepEqual(ch(s.cmdClick('b', AIM)), { touched: ['a', 'b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'b', multi: ['b'], mode: false, relation: null, stop: null });
  s.cmdClick('c', AIM);
  // f852afa quirk kept: the plain add still happens, so two ids pile up without the mode (listed in later.md).
  assert.deepEqual(st(s), { selected: 'c', multi: ['b', 'c'], mode: false, relation: null, stop: null });
});
test('marquee does nothing in an AIM map (the view starts a marquee only when canSelectTopics(): 14939)', () => {
  for (const mode of ['add', 'subtract', 'enter']) {
    const s = seeded({ multi: ['a'] });
    assert.deepEqual(ch(s.marquee(['a', 'b'], mode, AIM)), NONE, mode);
    assert.deepEqual(st(s).multi, ['a'], mode);
  }
});

// ---- slice 5: toggling inside multi-select (four copies) ----
test('setChecked follows the checkbox state: view.ts 9764-9766, touched is the id only', () => {
  const s = seeded({ selected: 'z' });
  assert.deepEqual(ch(s.setChecked('a', true)), { touched: ['a'], mode: false, relation: false });
  assert.deepEqual(st(s).multi, ['a']);
  s.setChecked('a', true);
  assert.deepEqual(st(s).multi, ['a']); // checked twice stays one member
  assert.deepEqual(ch(s.setChecked('a', false)), { touched: ['a'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'z', multi: [], mode: false, relation: null, stop: null });
});
test('toggleByClick flips membership: view.ts 10268-10271', () => {
  const s = seeded({ selected: 'z' });
  assert.deepEqual(ch(s.toggleByClick('a')), { touched: ['a'], mode: false, relation: false });
  assert.deepEqual(st(s).multi, ['a']);
  s.toggleByClick('a');
  assert.deepEqual(st(s).multi, []);
});
test('toggleByEnter flips membership: view.ts 10316-10319', () => {
  const s = seeded({ selected: 'z' });
  assert.deepEqual(ch(s.toggleByEnter('a')), { touched: ['a'], mode: false, relation: false });
  s.toggleByEnter('b');
  s.toggleByEnter('a');
  assert.deepEqual(st(s), { selected: 'z', multi: ['b'], mode: false, relation: null, stop: null });
});
test('toggles leave selected and the mode alone', () => {
  const s = seeded({ selected: 'z', mode: true });
  s.toggleByClick('a');
  s.toggleByEnter('b');
  s.setChecked('c', true);
  assert.deepEqual(st(s), { selected: 'z', multi: ['a', 'b', 'c'], mode: true, relation: null, stop: null });
});

// ---- slice 6: marquee ----
test('marquee add keeps earlier members and appends: view.ts 14826, 14832', () => {
  const s = seeded({ multi: ['c'] });
  assert.deepEqual(ch(s.marquee(['a', 'b'], 'add', MAP)), { touched: ['a', 'b'], mode: false, relation: false });
  assert.deepEqual(st(s).multi, ['c', 'a', 'b']);
});
test('marquee with no hits changes nothing: view.ts 14818', () => {
  const s = seeded({ multi: ['c'], relation: 'r1' });
  for (const mode of ['add', 'subtract', 'enter']) assert.deepEqual(ch(s.marquee([], mode, MAP)), NONE, mode);
  assert.equal(s.state.selectedRelation, 'r1');
});
test('marquee subtract removes only members: view.ts 14819-14825', () => {
  const s = seeded({ multi: ['a', 'b', 'c'] });
  assert.deepEqual(ch(s.marquee(['b', 'x'], 'subtract', MAP)), { touched: ['b'], mode: false, relation: false });
  assert.deepEqual(st(s).multi, ['a', 'c']);
});
test('marquee subtract of non-members returns without a commit (14821), so a relation selection survives', () => {
  const s = seeded({ multi: ['a'], relation: 'r1' });
  assert.deepEqual(ch(s.marquee(['x'], 'subtract', MAP)), NONE);
  assert.equal(s.state.selectedRelation, 'r1');
});
test('marquee enter adds the hits and turns multi-select on: view.ts 14826-14830', () => {
  const s = seeded({ selected: 'a' });
  assert.deepEqual(ch(s.marquee(['b', 'c'], 'enter', MAP)), { touched: ['b', 'c'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: ['b', 'c'], mode: true, relation: null, stop: null });
});

// ---- slice 7: clear and escape ----
test('clearMulti empties the multi set only: view.ts 13439-13441 (selection bar Clear)', () => {
  const s = seeded({ selected: 'c', multi: ['a', 'b'], mode: true });
  assert.deepEqual(ch(s.clearMulti()), { touched: ['a', 'b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'c', multi: [], mode: true, relation: null, stop: null });
});
test('clickEmpty outside multi-select clears the selection: view.ts 14965-14975', () => {
  const s = seeded({ selected: 'a', multi: ['b'], relation: 'r1' });
  assert.deepEqual(ch(s.clickEmpty()), { touched: ['a', 'b'], mode: false, relation: true });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});
test('clickEmpty inside multi-select only ends a relation selection: view.ts 14966, 14970', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true, relation: 'r1' });
  assert.deepEqual(ch(s.clickEmpty()), { touched: [], mode: false, relation: true });
  assert.deepEqual(st(s), { selected: 'a', multi: ['b'], mode: true, relation: null, stop: null });
});
test('clickEmpty with nothing to clear reports nothing', () => {
  assert.deepEqual(ch(fresh().clickEmpty()), NONE);
});
test('escape outside multi-select: view.ts 1262-1270', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.escape()), { touched: ['a', 'b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});
test('escape inside multi-select leaves it and reports the mode change', () => {
  const s = seeded({ multi: ['b', 'c'], mode: true, relation: 'r1' });
  assert.deepEqual(ch(s.escape()), { touched: ['b', 'c'], mode: true, relation: true });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});

// ---- slice 8: entering and leaving multi-select (six leave sites, one row each) ----
test('toggleMultiSelect enters: view.ts 9548-9550 clears selection and multi', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.toggleMultiSelect()), { touched: ['a', 'b'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: true, relation: null, stop: null });
});
test('toggleMultiSelect leaves the same way', () => {
  const s = seeded({ multi: ['b'], mode: true });
  assert.deepEqual(ch(s.toggleMultiSelect()), { touched: ['b'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});
test('leave row 1, escape: 1265-1268 (covered above)', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true });
  s.escape();
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});
test('leave row 2, exitMultiSelect openMap: view.ts 2006-2008 clears selected too', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true });
  assert.deepEqual(ch(s.exitMultiSelect('openMap')), { touched: ['a', 'b'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});
test('leave row 3, exitMultiSelect emptyMap: view.ts 9532-9533 keeps selected', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true });
  assert.deepEqual(ch(s.exitMultiSelect('emptyMap')), { touched: ['b'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: [], mode: false, relation: null, stop: null });
});
test('leave row 4, exitMultiSelect backgroundRun: view.ts 13231-13232 keeps selected (same result as emptyMap today)', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true });
  assert.deepEqual(ch(s.exitMultiSelect('backgroundRun')), { touched: ['b'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: [], mode: false, relation: null, stop: null });
});
test('leave row 5, afterMerge: view.ts 5705-5707 and 5791-5793 select the new topic', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c'], mode: true });
  assert.deepEqual(ch(s.afterMerge('n')), { touched: ['a', 'n', 'b', 'c'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'n', multi: [], mode: false, relation: null, stop: null });
});
test('leave row 6, afterSynthesis: view.ts 14638-14640 and 14672-14674 (same result as afterMerge today)', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c'], mode: true });
  assert.deepEqual(ch(s.afterSynthesis('n')), { touched: ['a', 'n', 'b', 'c'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'n', multi: [], mode: false, relation: null, stop: null });
});
test('exit variants report no mode change when not in the mode', () => {
  for (const variant of ['openMap', 'emptyMap', 'backgroundRun']) {
    assert.equal(seeded({ multi: ['b'] }).exitMultiSelect(variant).multiSelectModeChanged, false, variant);
  }
});
test('enter rows: chatSelect 16508-16510 and selectSubtopics 17015-17017 replace the set, drop selected, turn the mode on', () => {
  for (const op of ['chatSelect', 'selectSubtopics']) {
    const s = seeded({ selected: 'a', multi: ['x'] });
    assert.deepEqual(ch(s[op](['b', 'c'])), { touched: ['a', 'x', 'b', 'c'], mode: true, relation: false }, op);
    assert.deepEqual(st(s), { selected: null, multi: ['b', 'c'], mode: true, relation: null, stop: null }, op);
  }
});
test('retryFailed: view.ts 13384-13385 replaces the set, keeps selected, turns the mode on', () => {
  const s = seeded({ selected: 'a', multi: ['x'] });
  assert.deepEqual(ch(s.retryFailed(['b', 'c'])), { touched: ['x', 'b', 'c'], mode: true, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: ['b', 'c'], mode: true, relation: null, stop: null });
});
test('replaceMulti: view.ts 13375 replaces the set only and leaves the mode', () => {
  const s = seeded({ selected: 'a', multi: ['x'] });
  assert.deepEqual(ch(s.replaceMulti(['b', 'c'])), { touched: ['x', 'b', 'c'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: ['b', 'c'], mode: false, relation: null, stop: null });
});

// ---- slice 9: reassignment after structural operations ----
test('afterRemove clears selected and multi, keeps the mode: view.ts 5207-5208, 7444-7445', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true });
  assert.deepEqual(ch(s.afterRemove()), { touched: ['a', 'b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: [], mode: true, relation: null, stop: null });
});
test('afterPaste clears multi only: view.ts 7734', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.afterPaste()), { touched: ['b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: [], mode: false, relation: null, stop: null });
});
test('afterMove(true) clears multi, afterMove(false) does nothing: view.ts 7492', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.afterMove(false)), NONE);
  assert.deepEqual(st(s).multi, ['b']);
  assert.deepEqual(ch(s.afterMove(true)), { touched: ['b'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: [], mode: false, relation: null, stop: null });
});
test('setSelected writes the selected id alone: view.ts 2065, 3937, 4162, 4354, 4364, 4413, 4464, 4554, 6447, 7934, 7966, 8019, 8334, 9412, 11301, 12651', () => {
  const s = seeded({ selected: 'a', multi: ['b'], mode: true, relation: 'r1', stop: 'c' });
  assert.deepEqual(ch(s.setSelected('n')), { touched: ['a', 'n'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'n', multi: ['b'], mode: true, relation: 'r1', stop: 'c' });
});

// ---- slice 10: pruning ----
test('prune drops vanished ids from selected and multi: view.ts 9615-9616', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c', 'd'], mode: true });
  assert.deepEqual(ch(s.prune(new Set(['b', 'd']))), { touched: ['a', 'c'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: ['b', 'd'], mode: true, relation: null, stop: null });
});
test('prune with nothing vanished reports nothing', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.prune(new Set(['a', 'b', 'z']))), NONE);
});
test('pruneSelectedOnly leaves multi alone: merge undo/redo wrapper, view.ts 5838', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  assert.deepEqual(ch(s.pruneSelectedOnly(new Set(['z']))), { touched: ['a'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: null, multi: ['b'], mode: false, relation: null, stop: null });
  assert.deepEqual(ch(s.pruneSelectedOnly(new Set())), NONE);
});
test('pruneRelation drops a relation whose line is gone: view.ts 18061', () => {
  const s = seeded({ relation: 'r1' });
  assert.deepEqual(ch(s.pruneRelation(new Set(['r1']))), NONE);
  assert.deepEqual(ch(s.pruneRelation(new Set(['r2']))), { touched: [], mode: false, relation: true });
  assert.equal(s.state.selectedRelation, null);
  assert.deepEqual(ch(s.pruneRelation(new Set())), NONE);
});
test('relation select and deselect: view.ts 18032, 18038, 18181 select; 11716, 18185 deselect only the same key', () => {
  const s = fresh();
  assert.deepEqual(ch(s.selectRelation('r1')), { touched: [], mode: false, relation: true });
  assert.deepEqual(ch(s.selectRelation('r1')), NONE);
  assert.deepEqual(ch(s.deselectRelation('r2')), NONE);
  assert.equal(s.state.selectedRelation, 'r1');
  assert.deepEqual(ch(s.deselectRelation('r1')), { touched: [], mode: false, relation: true });
  assert.equal(s.state.selectedRelation, null);
});

// ---- slice 11: tab stop ----
test('resetTabStop picks the selected shown topic: view.ts 9618, 10520-10527', () => {
  const s = seeded({ selected: 'c', stop: 'b' });
  assert.deepEqual(ch(s.resetTabStop(SHOWN)), { touched: ['b', 'c'], mode: false, relation: false });
  assert.equal(s.state.tabStopId, 'c');
});
test('resetTabStop without a shown selection uses the first root, not the first card', () => {
  const s = fresh();
  s.resetTabStop([{ id: 'b', parentId: 'a' }, { id: 'a', parentId: null }]);
  assert.equal(s.state.tabStopId, 'a');
});
test('resetTabStop with no root uses the first card, and with no cards uses null', () => {
  const s = fresh();
  s.resetTabStop([{ id: 'b', parentId: 'a' }, { id: 'c', parentId: 'a' }]);
  assert.equal(s.state.tabStopId, 'b');
  assert.deepEqual(ch(s.resetTabStop([])), { touched: ['b'], mode: false, relation: false });
  assert.equal(s.state.tabStopId, null);
});
test('resetTabStop ignores a selected id that is not shown', () => {
  const s = seeded({ selected: 'gone' });
  s.resetTabStop(SHOWN);
  assert.equal(s.state.tabStopId, 'a');
});
test('moveTabStop reports old and new: view.ts 10504-10507', () => {
  const s = fresh();
  assert.deepEqual(ch(s.moveTabStop('b')), { touched: ['b'], mode: false, relation: false });
  assert.deepEqual(ch(s.moveTabStop('c')), { touched: ['b', 'c'], mode: false, relation: false });
  assert.equal(s.state.tabStopId, 'c');
  assert.deepEqual(ch(s.moveTabStop(null)), { touched: ['c'], mode: false, relation: false });
});

// ---- slice 12: stash and restore ----
test('stash copies selected and multi as plain data: view.ts 1565-1566', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c'] });
  const snapshot = s.stash();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { selected: 'a', multiSelected: ['b', 'c'] });
  s.click('z', MAP);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { selected: 'a', multiSelected: ['b', 'c'] });
});
test('restore brings the selection back and reports every id that changed: view.ts 1701-1703', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c'] });
  const snapshot = s.stash();
  s.click('z', MAP);
  assert.deepEqual(ch(s.restore(snapshot, new Set(['a', 'b', 'c', 'z']))), { touched: ['z', 'a', 'b', 'c'], mode: false, relation: false });
  assert.deepEqual(st(s), { selected: 'a', multi: ['b', 'c'], mode: false, relation: null, stop: null });
});
test('restore drops ids that no longer exist: view.ts 1701-1702', () => {
  const s = seeded({ selected: 'a', multi: ['b', 'c'] });
  const snapshot = s.stash();
  s.restore(snapshot, new Set(['c']));
  assert.deepEqual(st(s), { selected: null, multi: ['c'], mode: false, relation: null, stop: null });
});
test('restore of a snapshot with nothing selected clears the current selection', () => {
  const snapshot = fresh().stash();
  const s = seeded({ selected: 'a', multi: ['b'] });
  s.restore(snapshot, new Set(['a', 'b']));
  assert.deepEqual(st(s), { selected: null, multi: [], mode: false, relation: null, stop: null });
});
test('restore leaves the multi-select mode as it is', () => {
  const s = seeded({ selected: 'a', mode: true });
  s.restore({ selected: 'a', multiSelected: [] }, new Set(['a']));
  assert.equal(s.state.multiSelectMode, true);
});

// ---- slice 13: the state is read-only and deterministic ----
test('mutating the returned state cannot change the module', () => {
  const s = seeded({ selected: 'a', multi: ['b'] });
  const view = s.state;
  view.multiSelected.add('x');
  assert.deepEqual(st(s).multi, ['b']);
  assert.equal(Object.isFrozen(view), true);
  assert.throws(() => { 'use strict'; view.selected = 'q'; }, TypeError);
});
test('a change is frozen and its touched list cannot be edited', () => {
  const change = fresh().click('a', MAP);
  assert.equal(Object.isFrozen(change), true);
  assert.equal(Object.isFrozen(change.touched), true);
});
test('the same inputs give deeply equal state and change', () => {
  const run = () => {
    const s = fresh();
    const out = [];
    out.push(s.click('a', { ...MAP, shown: SHOWN }), s.cmdClick('b', MAP), s.marquee(['c'], 'add', MAP), s.escape(), s.stash());
    return { out: JSON.parse(JSON.stringify(out)), state: st(s) };
  };
  assert.deepEqual(run(), run());
});

// ---- counter-example: no view / obsidian import (plan section 3 item 1) ----
test('the module imports nothing from view or obsidian and touches no DOM', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences', 'visual-map', 'topic-selection.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"][^'"]*(view|obsidian)['"]/);
  assert.doesNotMatch(source, /\b(document|window|HTMLElement)\b/);
});
