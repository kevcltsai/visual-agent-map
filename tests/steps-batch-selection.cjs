// V3.3 P1.9 (ticket B19a): a topic selection holding an AI-locked or merging card refuses its batch actions as a whole, and a
// batch move keeps the moved cards' distances. A real view over a fake vault (as tests/steps-layout-direction.cjs); no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-b/Map.md';

/** `spec` is [title, parentTitle|null, x, y] per node. */
async function harness(spec, language = 'en') {
  const { repo, app, contents } = support.fixture(language, { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-b', title: 'Batch', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-b');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment, createSvg: dom.createSvg });
  let pending = Promise.resolve();
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.fit = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.cardHeightOf = () => 80;
  const named = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const select = titles => { if (!view.selection.state.multiSelectMode) view.selection.toggleMultiSelect(); view.selection.replaceMulti(titles.map(title => named(title).id)); };
  const bar = () => view.renderSelectionBar(dom.element('div'));
  const files = () => new Map([...contents].filter(([path]) => path.startsWith('Agent Workspace/Topics/map-b/')));
  return { repo, view, named, select, bar, notices, files, settled: () => pending };
}
const buttonOf = (bar, text) => bar.children.find(child => child.tag === 'button' && child.text === text);

const { translate } = support.load('i18n.ts');
const SPEC = [['Root', null, 1000, 80], ['A', 'Root', 1360, 0], ['A1', 'A', 1720, 0], ['B', 'Root', 1360, 300], ['C', 'Root', 1360, 600]];

test('B19a: a selection with an AI-locked card refuses Move to and Merge as a whole: aria-disabled, the reason names the card, a click writes nothing', async () => {
  const h = await harness(SPEC);
  await h.repo.writeAiLocked(h.named('B').path, true);
  await h.view.hydrate();
  h.select(['A', 'B', 'C']);
  const before = h.files(), history = h.view.history.past.length;
  const bar = h.bar();
  const reason = translate('en', 'ui.selection_locked_0_1', 1, 'B');
  for (const text of ['Move to…', 'Merge']) {
    const button = buttonOf(bar, text);
    assert.equal(button.attrs['aria-disabled'], 'true', text); assert.equal(button.disabled, false, `${text} stays focusable`);
    assert.equal(button.attrs.title, reason, text);
  }
  assert.equal(buttonOf(bar, 'Research').attrs['aria-disabled'], undefined, 'Research is not a batch change');
  const why = bar.children.filter(child => child.cls.includes('vam-selection-why'));
  assert.equal(why.length, 1); assert.equal(why[0].text, reason, 'one reason line, said once for both buttons');
  let opened = 0; h.view.openMerge = () => { opened++; }; h.view.chooseSelectedParent = () => { opened++; };
  buttonOf(bar, 'Move to…').fire('click'); buttonOf(bar, 'Merge').fire('click');
  await h.settled();
  assert.equal(opened, 0, 'neither the move dialog nor the merge opens');
  assert.deepEqual(h.notices, [reason, reason], 'each click says why');
  assert.deepEqual(h.files(), before, 'Map.md and every note are byte-identical');
  assert.equal(h.view.history.past.length, history, 'no history entry');
  // Taken out of the selection, the rest moves and merges again.
  h.select(['A', 'C']);
  const free = h.bar();
  assert.equal(buttonOf(free, 'Move to…').attrs['aria-disabled'], undefined); assert.equal(buttonOf(free, 'Merge').attrs['aria-disabled'], undefined);
  assert.equal(free.children.some(child => child.cls.includes('vam-selection-why')), false);
  assert.equal(translate('zh-TW', 'ui.selection_locked_0_1', 1, '研究摘要'), '△ 其中 1 張已鎖定或正在合併（研究摘要），這一組不能改顏色、尺寸、位置或合併。把它移出選取，或先解除鎖定。', 'the ticket wording');
});

test('B19a: a merging card in the selection refuses the same way and the reason lists every refused card', async () => {
  const h = await harness(SPEC);
  await h.repo.writeAiLocked(h.named('C').path, true);
  await h.view.hydrate();
  const merging = h.named('A').id;
  h.view.isMerging = id => id === merging;
  h.select(['A', 'B', 'C']);
  const bar = h.bar();
  const reason = translate('en', 'ui.selection_locked_0_1', 2, 'A, C');
  for (const text of ['Move to…', 'Merge']) assert.equal(buttonOf(bar, text).attrs.title, reason, text);
});

test('B19a: a selection with a card and its grandchild-level relative keeps Merge off with the current ancestor reason; Move to stays on', async () => {
  const h = await harness(SPEC);
  h.select(['A', 'A1', 'B']);
  const bar = h.bar();
  const merge = buttonOf(bar, 'Merge');
  assert.equal(merge.attrs['aria-disabled'], 'true'); assert.equal(merge.attrs.title, translate('en', 'ui.merge_ancestor_selected'));
  assert.equal(buttonOf(bar, 'Move to…').attrs['aria-disabled'], undefined);
});

// B19b (P1.9): the selection bar's Color popover. One swatch colours every selected card in one write and one undo step.
const NOTE = title => `Agent Workspace/Topics/map-b/Notes/${title}.md`;
const withoutColor = text => text.replace(/^topic-color: .*\n/m, '');
/** Clicks Color in a fresh bar and returns the popover (null when none opened). */
function openColor(h) {
  const bar = h.bar();
  const button = buttonOf(bar, 'Color ▾');
  // The shared DOM stand-in has `parent`; the view finds the bar through parentElement, as in Obsidian.
  Object.defineProperty(button, 'parentElement', { configurable: true, get() { return this.parent; } });
  button.fire('click');
  return { bar, button, pop: bar.children.find(child => child.cls.includes('vam-batch-popover')) ?? null };
}
const swatches = pop => dom.findAll(pop, item => item.tag === 'button' && item.cls.includes('vam-style-popover-color'));
const swatch = (pop, id) => swatches(pop).find(item => item.dataset.styleChoice === `color-${id}`);

test('B19b: mixed colours show "Mixed" beside the title and press no swatch; one colour presses only that one', async () => {
  const h = await harness(SPEC);
  await h.repo.writeTopicColor(h.named('A').path, 'blue');
  await h.repo.writeTopicColor(h.named('C').path, 'blue');
  await h.view.hydrate();
  h.select(['A', 'B', 'C']);
  const { button, pop } = openColor(h);
  assert.ok(pop, 'the popover opens inside the selection bar'); assert.equal(button.attrs['aria-haspopup'], 'dialog');
  assert.ok(pop.cls.includes('vam-style-popover'), 'the Style popover swatches');
  assert.equal(swatches(pop).length, 7, 'none plus six colours');
  assert.ok(dom.findAll(pop, item => item.cls.includes('vam-batch-popover-mixed') && item.text === 'Mixed').length === 1);
  assert.deepEqual(swatches(pop).filter(item => item.attrs['aria-pressed'] === 'true'), [], 'nothing pre-selected');
  assert.equal(translate('zh-TW', 'ui.batch_color_mixed'), '未統一');
  h.select(['A', 'C']);
  const same = openColor(h).pop;
  assert.equal(dom.findAll(same, item => item.cls.includes('vam-batch-popover-mixed')).length, 0);
  assert.deepEqual(swatches(same).filter(item => item.attrs['aria-pressed'] === 'true').map(item => item.dataset.styleChoice), ['color-blue']);
});

test('B19b: one swatch colours the whole selection in one write: only topic-color changes; one undo restores all, redo colours again', async () => {
  const h = await harness(SPEC);
  await h.repo.writeTopicColor(h.named('A').path, 'blue');
  await h.view.hydrate();
  h.select(['A', 'B', 'C']);
  const before = h.files(), history = h.view.history.past.length;
  const { bar, pop } = openColor(h);
  swatch(pop, 'green').fire('click');
  assert.equal(bar.children.includes(pop), false, 'a pick closes the popover');
  await h.settled();
  const after = h.files();
  for (const title of ['A', 'B', 'C']) {
    assert.match(after.get(NOTE(title)), /^topic-color: "green"$/m, title);
    assert.equal(withoutColor(after.get(NOTE(title))), withoutColor(before.get(NOTE(title))), `${title}: every other byte is the same`);
  }
  for (const title of ['Root', 'A1']) assert.equal(after.get(NOTE(title)), before.get(NOTE(title)), `${title} is not selected`);
  assert.equal(after.get(MAP), before.get(MAP), 'Map.md unchanged');
  assert.equal(h.view.history.past.length, history + 1, 'one history step');
  await h.view.history.undo().undo();
  assert.deepEqual(h.files(), before, 'one undo restores every note byte for byte');
  await h.view.history.redo().redo();
  for (const title of ['A', 'B', 'C']) assert.match(h.files().get(NOTE(title)), /^topic-color: "green"$/m, `redo: ${title}`);
});

test('B19b: an AI-locked or merging card in the selection turns Color off with the group reason; neither the click nor the write entry writes', async () => {
  const h = await harness(SPEC);
  await h.repo.writeAiLocked(h.named('B').path, true);
  await h.view.hydrate();
  h.select(['A', 'B', 'C']);
  const ids = ['A', 'B', 'C'].map(title => h.named(title).id);
  const before = h.files(), history = h.view.history.past.length;
  const reason = translate('en', 'ui.selection_locked_0_1', 1, 'B');
  const { bar, button, pop } = openColor(h);
  assert.equal(button.attrs['aria-disabled'], 'true'); assert.equal(button.disabled, false); assert.equal(button.attrs.title, reason);
  assert.equal(bar.children.filter(child => child.cls.includes('vam-selection-why')).map(child => child.text).join(), reason, 'one reason line for Color, Move to and Merge');
  assert.equal(pop, null, 'no popover');
  await h.view.changeSelectionColor(ids, 'red');
  assert.deepEqual(h.files(), before, 'Map.md and every note are byte-identical');
  assert.equal(h.view.history.past.length, history);
  assert.deepEqual(h.notices, [reason, reason], 'the click and the refused write each say why');
  // A merging card as well: the reason lists both.
  h.view.isMerging = id => id === h.named('C').id;
  const merging = openColor(h);
  assert.equal(merging.button.attrs.title, translate('en', 'ui.selection_locked_0_1', 2, 'B, C')); assert.equal(merging.pop, null);
  const held = h.files();
  await h.view.changeSelectionColor(ids, 'red');
  assert.deepEqual(h.files(), held, 'zero writes while merging');
});

test('B19b: while the notes load Color is off with the loading reason; under the picture-book structure lock it leaves the bar like Move to; neither writes', async () => {
  const h = await harness(SPEC);
  h.select(['A', 'C']);
  const ids = ['A', 'C'].map(title => h.named(title).id);
  const before = h.files();
  h.view.notesLoading = () => true;
  const loading = openColor(h);
  assert.equal(loading.button.attrs['aria-disabled'], 'true'); assert.equal(loading.button.attrs.title, translate('en', 'ui.card_action_off_notes_loading'));
  assert.equal(loading.pop, null);
  await h.view.changeSelectionColor(ids, 'red');
  assert.deepEqual(h.files(), before);
  h.view.notesLoading = () => false;
  h.view.bookLock = () => ({ ai: true, structure: true });
  const bar = h.bar();
  assert.equal(buttonOf(bar, 'Color ▾'), undefined); assert.equal(buttonOf(bar, 'Move to…'), undefined);
  await h.view.changeSelectionColor(ids, 'red');
  assert.deepEqual(h.files(), before, 'zero writes under the structure lock');
  h.view.bookLock = () => ({ ai: false, structure: false });
  await h.view.changeSelectionColor(ids, 'red');
  assert.match(h.files().get(NOTE('A')), /^topic-color: "red"$/m, 'control: the same call writes once the lock is gone');
});
