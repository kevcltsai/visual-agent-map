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
  const reason = translate('en', 'ui.selection_locked_one_0', 'B');
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
  assert.equal(translate('zh-TW', 'ui.selection_locked_one_0', '研究摘要'), '△ 其中 1 張已鎖定或正在合併（研究摘要），這一組不能改顏色、尺寸、位置或合併。把它移出選取，或先解除鎖定。', 'the ticket wording for the one card shown');
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
  const reason = translate('en', 'ui.selection_locked_one_0', 'B');
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

test('B19b: while the notes load Color is off with the loading reason and neither the click nor the write entry writes', async () => {
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
});

test('B19b (parent ruling: the picture-book structure lock covers parent and order only): under the book locks Color stays on and colours the selection, only topic-color changes, Map.md unchanged', async () => {
  const h = await harness(SPEC);
  h.select(['A', 'C']);
  const before = h.files();
  h.view.bookLock = () => ({ ai: true, structure: true });
  const { bar, button, pop } = openColor(h);
  assert.equal(button.attrs['aria-disabled'], undefined, 'neither hidden nor off'); assert.ok(pop);
  assert.equal(buttonOf(bar, 'Move to…'), undefined, 'control: Move to still leaves the bar under the structure lock');
  assert.equal(bar.children.some(child => child.cls.includes('vam-selection-why')), false);
  swatch(pop, 'red').fire('click');
  await h.settled();
  const after = h.files();
  for (const title of ['A', 'C']) {
    assert.match(after.get(NOTE(title)), /^topic-color: "red"$/m, title);
    assert.equal(withoutColor(after.get(NOTE(title))), withoutColor(before.get(NOTE(title))), `${title}: every other byte is the same`);
  }
  for (const title of ['Root', 'A1', 'B']) assert.equal(after.get(NOTE(title)), before.get(NOTE(title)), `${title} is not selected`);
  assert.equal(after.get(MAP), before.get(MAP), 'Map.md unchanged');
});

// B19c (P1.9): the selection bar's Size popover. Width and height fields write only what was typed (or reset), in one Map.md
// write and one undo step; the notes are not touched.
/** Clicks Size in a fresh bar and returns the popover (null when none opened). */
function openSize(h) {
  const bar = h.bar();
  const button = buttonOf(bar, 'Size ▾');
  if (!button) return { bar, button, pop: null };
  Object.defineProperty(button, 'parentElement', { configurable: true, get() { return this.parent; } });
  button.fire('click');
  return { bar, button, pop: bar.children.find(child => child.cls.includes('vam-batch-size-popover')) ?? null };
}
const inputs = pop => dom.findAll(pop, item => item.tag === 'input');
const popButton = (pop, text) => dom.findAll(pop, item => item.tag === 'button' && item.text === text);
const type = (input, value) => { input.value = value; input.fire('input'); };
const sizes = async (h, titles) => { const map = await h.repo.readMap(MAP); return titles.map(title => { const node = map.nodes.find(n => n.id === h.named(title).id); return [title, node.width, node.height]; }); };

test('B19c: mixed widths show "Mixed" and an unset height "Auto"; one width shows that width', async () => {
  const h = await harness(SPEC);
  await h.view.resizeCard(h.named('A').id, { width: 360 });
  h.select(['A', 'B', 'C']);
  const { button, pop } = openSize(h);
  assert.ok(pop, 'the popover opens inside the selection bar'); assert.equal(button.attrs['aria-haspopup'], 'dialog');
  const [width, height] = inputs(pop);
  assert.equal(width.placeholder, 'Mixed'); assert.equal(width.value, '', 'nothing pre-filled');
  assert.equal(height.placeholder, 'Auto'); assert.equal(height.value, '');
  assert.equal(popButton(pop, 'Apply to 3 cards').length, 1); assert.equal(popButton(pop, 'Cancel').length, 1);
  assert.equal(popButton(pop, 'Reset').length, 2, 'each field has its own Reset');
  assert.equal(translate('zh-TW', 'ui.batch_size_mixed'), '未統一'); assert.equal(translate('zh-TW', 'ui.batch_size_auto'), '自動');
  assert.equal(translate('zh-TW', 'ui.batch_size_apply_0', 3), '套用到 3 張');
  h.select(['B', 'C']);
  assert.equal(inputs(openSize(h).pop)[0].placeholder, '280', 'one width: that width');
});

test('B19c: Apply writes only the typed width to every selected card, the heights stay; one undo restores Map.md, redo writes again', async () => {
  const h = await harness(SPEC);
  await h.view.resizeCard(h.named('A').id, { height: 200 });
  h.select(['A', 'B', 'C']);
  const before = h.files(), history = h.view.history.past.length;
  const { bar, pop } = openSize(h);
  type(inputs(pop)[0], '400');
  popButton(pop, 'Apply to 3 cards')[0].fire('click');
  assert.equal(bar.children.includes(pop), false, 'Apply closes the popover');
  await h.settled();
  assert.deepEqual(await sizes(h, ['A', 'B', 'C', 'Root', 'A1']), [['A', 400, 200], ['B', 400, undefined], ['C', 400, undefined], ['Root', undefined, undefined], ['A1', undefined, undefined]]);
  const after = h.files();
  for (const [path, text] of before) if (path !== MAP) assert.equal(after.get(path), text, `${path}: notes are not written`);
  assert.equal(h.view.history.past.length, history + 1, 'one history step');
  await h.view.history.undo().undo();
  assert.deepEqual(h.files(), before, 'one undo restores Map.md byte for byte');
  await h.view.history.redo().redo();
  assert.deepEqual(await sizes(h, ['A', 'B', 'C']), [['A', 400, 200], ['B', 400, undefined], ['C', 400, undefined]], 'redo');
});

test('B19c: Reset on height alone puts the heights back to Auto and keeps the widths; nothing typed writes nothing', async () => {
  const h = await harness(SPEC);
  await h.view.resizeCard(h.named('A').id, { width: 360, height: 200 });
  h.select(['A', 'B']);
  const held = h.files(), history = h.view.history.past.length;
  let { pop } = openSize(h);
  popButton(pop, 'Apply to 2 cards')[0].fire('click');
  await h.settled();
  assert.deepEqual(h.files(), held, 'Apply with nothing typed writes nothing'); assert.equal(h.view.history.past.length, history);
  ({ pop } = openSize(h));
  const [, height] = inputs(pop);
  popButton(pop, 'Reset')[1].fire('click');
  assert.equal(height.placeholder, 'Auto');
  popButton(pop, 'Apply to 2 cards')[0].fire('click');
  await h.settled();
  assert.deepEqual(await sizes(h, ['A', 'B']), [['A', 360, undefined], ['B', undefined, undefined]]);
  assert.equal(h.view.history.past.length, history + 1);
});

test('B19c: an AI-locked or merging card in the selection turns Size off with the group reason; neither the click nor the write entry writes', async () => {
  const h = await harness(SPEC);
  await h.repo.writeAiLocked(h.named('B').path, true);
  await h.view.hydrate();
  h.select(['A', 'B', 'C']);
  const ids = ['A', 'B', 'C'].map(title => h.named(title).id);
  const before = h.files(), history = h.view.history.past.length;
  const reason = translate('en', 'ui.selection_locked_one_0', 'B');
  const { button, pop } = openSize(h);
  assert.equal(button.attrs['aria-disabled'], 'true'); assert.equal(button.disabled, false); assert.equal(button.attrs.title, reason);
  assert.equal(pop, null, 'no popover');
  await h.view.changeSelectionSize(ids, { width: 400 });
  assert.deepEqual(h.files(), before, 'Map.md and every note are byte-identical'); assert.equal(h.view.history.past.length, history);
  assert.deepEqual(h.notices, [reason, reason], 'the click and the refused write each say why');
  h.view.isMerging = id => id === h.named('C').id;
  assert.equal(openSize(h).button.attrs.title, translate('en', 'ui.selection_locked_0_1', 2, 'B, C'));
  await h.view.changeSelectionSize(ids, { width: 400 });
  assert.deepEqual(h.files(), before, 'zero writes while merging');
});

test('B19c: an old AIM map has no Size button and its write entry writes nothing; the picture-book locks leave Size on', async () => {
  const h = await harness(SPEC);
  h.select(['A', 'C']);
  const ids = ['A', 'C'].map(title => h.named(title).id);
  const before = h.files();
  h.view.map.aim = { version: 1 };
  assert.equal(openSize(h).button, undefined, 'no Size on an AIM map');
  assert.ok(buttonOf(h.bar(), 'Color ▾'), 'control: Color stays');
  await h.view.changeSelectionSize(ids, { width: 400 });
  assert.deepEqual(h.files(), before);
  delete h.view.map.aim;
  // A size changes neither parent, order nor another card's place: the structure lock (decision #62) leaves it on.
  h.view.bookLock = () => ({ ai: true, structure: true });
  const { button, pop } = openSize(h);
  assert.equal(button.attrs['aria-disabled'], undefined); assert.ok(pop);
  type(inputs(pop)[0], '320');
  popButton(pop, 'Apply to 2 cards')[0].fire('click');
  await h.settled();
  assert.deepEqual(await sizes(h, ['A', 'B', 'C']), [['A', 320, undefined], ['B', undefined, undefined], ['C', 320, undefined]]);
});

// B19c follow-ups: the English reason picks its singular for one card, and no reason on the bar, under it or in its ⋯ menu
// keeps a raw {0}.
test('B19c: one locked card reads "1 of them is locked", two read "2 of them are locked", in all three languages', async () => {
  const h = await harness(SPEC);
  await h.repo.writeAiLocked(h.named('B').path, true);
  await h.view.hydrate();
  h.select(['A', 'B', 'C']);
  const why = bar => bar.children.find(child => child.cls.includes('vam-selection-why'))?.text;
  const one = why(h.bar());
  assert.match(one, /^△ 1 of them is locked or being merged \(B\), so this group/); assert.match(one, /Take it out of the selection, or unlock it first\.$/);
  await h.repo.writeAiLocked(h.named('C').path, true);
  await h.view.hydrate();
  const two = why(h.bar());
  assert.match(two, /^△ 2 of them are locked or being merged \(B, C\), so this group/); assert.match(two, /Take them out of the selection, or unlock them first\.$/);
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    assert.doesNotMatch(translate(language, 'ui.selection_locked_one_0', 'B'), /\{\d+\}/, language);
    assert.doesNotMatch(translate(language, 'ui.selection_locked_0_1', 2, 'B, C'), /\{\d+\}/, language);
  }
  assert.match(translate('zh-CN', 'ui.selection_locked_one_0', 'B'), /^△ 其中 1 张已锁定或正在合并（B）/);
});

test('B19c: no disabled reason on the selection bar, under it, or under a greyed row of its ⋯ menu keeps a raw {0}', async () => {
  const h = await harness(SPEC);
  const texts = [];
  const collect = () => {
    const bar = h.bar();
    for (const child of bar.children) {
      if (child.attrs?.title) texts.push(child.attrs.title);
      if (child.cls.includes('vam-selection-why')) texts.push(child.text);
    }
    const reasons = [];
    h.view.newMenu = () => { const m = { addItem(build) { const chain = { setTitle() { return chain; }, setIcon() { return chain; }, setDisabled() { return chain; }, onClick() { return chain; } }; chain.dom = { setAttr(name, value) { if (name === 'title') reasons.push(value); }, addClass() {}, createDiv(v) { reasons.push(v.text); return {}; } }; build(chain); return m; }, addSeparator() { return m; }, showAtMouseEvent() {} }; return m; };
    h.view.openSelectionMoreMenu({}, h.view.selection.state.multiSelected.size);
    texts.push(...reasons);
  };
  h.select(['A', 'A1', 'B']);
  collect(); // the ancestor merge reason
  await h.repo.writeAiLocked(h.named('B').path, true);
  await h.view.hydrate();
  collect();
  h.view.isMerging = id => id === h.named('C').id;
  h.select(['A', 'B', 'C']);
  collect();
  h.view.notesLoading = () => true;
  collect();
  h.view.notesLoading = () => false;
  h.select(['Root']);
  collect(); // one topic: Synthesize and Merge need two
  assert.ok(texts.length >= 6, `reasons were collected: ${texts.length}`);
  for (const text of texts) assert.doesNotMatch(text, /\{\d+\}/, text);
  // Every view entry that turns an action's reason into text fills its {0}, {1}… from reasonArgs.
  const view = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const calls = view.match(/\bt\((availability|state)\.reasonKey[^)]*\)/g) ?? [];
  assert.ok(calls.length >= 4, `the reason entries were found: ${calls.length}`);
  for (const call of calls) assert.match(call, /reasonArgs/, call);
});

// B19c (decision #62 extended): under the picture-book structure lock, the actions that add no card and change no parent or
// order stay on and write only their own field. The registry rows (tests/steps-card-actions.cjs TABLE, last column) pin
// add-frame, summary-add(-selected), tidy-branch and note-style as available under bookStructure; these drive the real writes.
const mapNodes = async h => (await h.repo.readMap(MAP)).nodes;
const structure = nodes => JSON.stringify(nodes.map(node => [node.id, node.parentId, node.path]));
const notesOf = files => [...files].filter(([path]) => path !== MAP);

test('B19c structure lock: the selection ⋯ keeps Add frame and Add summary on; a frame writes only Map.md canvasItems', async () => {
  const h = await harness(SPEC);
  h.view.bookLock = () => ({ ai: true, structure: true });
  h.select(['A', 'B']);
  const entries = [];
  h.view.newMenu = () => { const m = { addItem(build) { const it = {}; const chain = { setTitle(v) { it.text = v; return chain; }, setIcon() { return chain; }, setDisabled(v) { it.disabled = !!v; return chain; }, onClick() { return chain; } }; build(chain); entries.push(it); return m; }, addSeparator() { return m; }, showAtMouseEvent() {} }; return m; };
  h.view.openSelectionMoreMenu({}, 2);
  for (const text of ['Add frame', 'Add summary bracket']) {
    const entry = entries.find(item => item.text === text);
    assert.ok(entry, `${text} is listed: ${entries.map(item => item.text)}`); assert.equal(entry.disabled, false, text);
  }
  const before = h.files(), nodes = await mapNodes(h);
  const id = await h.view.addBoundary([h.named('A').id, h.named('B').id], 'Frame');
  assert.ok(id);
  const map = await h.repo.readMap(MAP);
  assert.deepEqual(map.nodes, nodes, 'no card, parent, order or place changes');
  assert.deepEqual([...map.canvasItems.filter(item => item.kind === 'boundary').map(item => item.members.length)], [2]);
  assert.deepEqual(notesOf(h.files()), notesOf(before), 'notes are not written');
});

test('B19c structure lock: a summary bracket is a canvas item, not a card: it writes only canvasItems', async () => {
  const h = await harness(SPEC);
  h.view.bookLock = () => ({ ai: true, structure: true });
  h.select(['A', 'B']);
  const before = h.files(), nodes = await mapNodes(h);
  h.view.addSummaryOver([h.named('A').id, h.named('B').id]);
  const pending = h.view.pendingSummary;
  assert.ok(pending, 'the bracket starts (no refusal under the lock)');
  await h.view.saveSummaryItem(pending.id, 'Both', pending.members);
  const map = await h.repo.readMap(MAP);
  assert.deepEqual(map.nodes, nodes, 'no card is added and no parent, order or place changes');
  assert.deepEqual([...map.canvasItems.filter(item => item.kind === 'summary').map(item => item.text)], ['Both']);
  assert.deepEqual(notesOf(h.files()), notesOf(before), 'notes are not written');
});

test('B19c structure lock: Tidy this branch moves cards only: parents, paths and order stay, notes are not written', async () => {
  const h = await harness(SPEC);
  h.view.bookLock = () => ({ ai: true, structure: true });
  const before = h.files(), nodes = await mapNodes(h);
  h.view.openTidyPreview(h.named('Root').id);
  assert.ok(h.view.tidy?.positions.size > 0, 'the preview opens under the lock and moves cards');
  const history = h.view.history.past.length;
  h.view.applyTidy();
  await h.settled();
  assert.equal(h.view.history.past.length, history + 1, 'Apply writes, in one step');
  const after = await mapNodes(h);
  assert.notEqual(JSON.stringify(after), JSON.stringify(nodes), 'some card moved');
  assert.equal(structure(after), structure(nodes), 'parents, paths and order unchanged');
  const strip = list => list.map(({ x: _x, y: _y, ...rest }) => rest);
  assert.deepEqual(strip(after), strip(nodes), 'only x and y may change');
  assert.deepEqual(notesOf(h.files()), notesOf(before), 'notes are not written');
});
