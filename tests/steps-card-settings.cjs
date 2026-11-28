// V3.3 P1.8 (B11): the card settings dialog is one flat list in a fixed order, relations fold away, and every field
// writes only its own key as one undo step. Choosing a parent goes through moveBranches, the same move as a drag.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const suggests = [];
const opened = [];
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, core } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const MAP = 'Agent Workspace/Topics/map-s/Map.md';

/** A view over a fake vault; `spec` is [title, parentTitle|null, x, y] per node. */
async function harness(spec) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-s', title: 'Settings', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-s');
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
  class Modal extends Base { open() { opened.push(this); super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, AbstractInputSuggest: class { constructor(app, input) { this.inputEl = input; suggests.push(this); } close() {} }, Modal, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg: tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } }) });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.cardHeightOf = () => 180;
  view.mergeUnlocked = () => true;
  view.enqueue = fn => fn();
  const node = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  let closed = 0;
  const open = title => {
    const content = element('div'), host = element('div');
    view.renderInspector(content, node(title), 'structure', () => { closed++; }, host);
    return { content, panel: content.children[0], host };
  };
  return { repo, app, contents, view, node, open, closed: () => closed };
}

const parentField = content => dom.findAll(content, i => i.tag === 'input' && i.attrs['aria-label'] === 'Parent topic')[0];
const pickParent = async (content, row) => {
  const field = parentField(content);
  const suggest = suggests.find(item => item.inputEl === field);
  field.focus();
  // Root: type any name, the "No parent" row is last.
  const typed = row || 'R';
  field.value = typed; field.fire('input');
  const rows = suggest.getSuggestions(typed);
  suggest.selectSuggestion(row === '' ? rows.at(-1) : rows.find(r => r.title === row), {});
  await dom.tick(); await dom.tick();
  return field;
};
/** The note's frontmatter as key -> raw line. */
const frontmatter = text => {
  const head = text.split('\n---')[0];
  return new Map(head.split('\n').filter(line => /^[\w-]+:/.test(line)).map(line => [line.split(':')[0], line]));
};
const changedKeys = (before, after) => {
  const a = frontmatter(before), b = frontmatter(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(key => a.get(key) !== b.get(key)).sort();
};
const noteFiles = h => [...h.contents.keys()].filter(p => p.endsWith('.md') && p !== MAP);
const snapshot = h => new Map(noteFiles(h).map(p => [p, h.contents.get(p)]));

test('B11: choosing a parent calls moveBranches([node], parent, false) once; the dialog stays open with focus in the field', async () => {
  const h = await harness([['R', null, 80, 80], ['A', null, 80, 600], ['B', 'R', 420, 80]]);
  const calls = [];
  const real = h.view.moveBranches;
  h.view.moveBranches = function (...args) { calls.push(args); return real.apply(this, args); };
  const { content } = h.open('B');
  const field = await pickParent(content, 'A');
  assert.equal(calls.length, 1, 'one move');
  assert.equal(calls[0][0].length, 1);
  assert.equal(calls[0][0][0].id, h.node('B').id);
  assert.equal(calls[0][1].id, h.node('A').id);
  assert.equal(calls[0][2], false, 'the selection is kept');
  assert.equal(h.node('B').parentId, h.node('A').id);
  assert.equal(h.closed(), 0, 'the dialog stays open');
  assert.equal(dom.focusedNow(), field, 'focus stays in the parent field');
  await pickParent(content, '');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], null, 'no parent: moved to the top level');
  assert.equal(h.node('B').parentId, null);
  assert.equal(dom.focusedNow(), field);
});

test('B11: type, parent, marker and link each write only their own key, one undo step each', async () => {
  const h = await harness([['R', null, 80, 80], ['A', null, 80, 600], ['B', 'R', 420, 80]]);
  const path = h.node('B').path;
  // A new parent also refreshes the derived "Parent/Child topics" reference lines; no frontmatter key of any note changes.
  const step = async (name, act, expectKeys, derivedReferences = false) => {
    const notes = snapshot(h), map = h.contents.get(MAP);
    assert.equal(h.view.history.canUndo, false, `${name}: starts with nothing to undo`);
    await act();
    await dom.tick();
    const after = snapshot(h);
    for (const [p, text] of notes) {
      if (derivedReferences) assert.deepEqual(changedKeys(text, after.get(p)), [], `${name}: ${p} keeps its keys`);
      else if (p !== path) assert.equal(after.get(p), text, `${name}: ${p} is untouched`);
    }
    assert.deepEqual(changedKeys(notes.get(path), after.get(path)), expectKeys, `${name}: only its key changes`);
    await h.view.travel(false);
    await h.view.hydrate();
    assert.equal(h.view.history.canUndo, false, `${name}: one undo step`);
    for (const [p, text] of notes) assert.equal(h.contents.get(p), text, `${name}: undo restores ${p}`);
    assert.equal(h.contents.get(MAP), map, `${name}: undo restores Map.md`);
  };
  await step('type', async () => {
    const { content } = h.open('B');
    const kinds = dom.findAll(content, i => (i.cls ?? '').includes('vam-topic-kinds'))[0];
    dom.findAll(kinds, i => i.tag === 'button' && i.attrs['aria-pressed'] === 'false')[0].click();
  }, ['topic-kind']);
  await step('parent', async () => {
    const before = h.contents.get(MAP);
    await pickParent(h.open('B').content, 'A');
    assert.notEqual(h.contents.get(MAP), before, 'Map.md holds the new parent');
  }, [], true);
  await step('marker', async () => {
    const { content } = h.open('B');
    const box = dom.findAll(content, i => (i.cls ?? '').split(' ').includes('vam-topic-marker-group'))[0];
    dom.findAll(box, i => i.tag === 'button')[0].click();
  }, ['topic-markers']);
  await step('link', async () => {
    const { content } = h.open('B');
    const input = dom.findAll(content, i => (i.cls ?? '').includes('vam-topic-link-input'))[0];
    input.value = 'https://example.com/a';
    dom.findAll(content, i => (i.cls ?? '').includes('vam-topic-link-form'))[0].children.find(i => i.tag === 'button').click();
  }, ['topic-links']);
});

test('B11: card settings is one flat list in the P1.8 order; relations fold away closed; the cover keeps only its switch', async () => {
  const h = await harness([['R', null, 80, 80], ['B', 'R', 420, 80], ['C', 'B', 760, 80]]);
  await h.view.changeTopicKind(h.node('B'), 'hypothesis');
  await h.view.hydrate();
  h.view.history.clear();
  h.view.map.topicRelations = [{ from: h.node('B').id, to: h.node('R').id, kind: 'supports' }];
  h.view.coverPictureOf = () => 'img/a.png';
  const { panel } = h.open('B');
  const has = (item, cls) => dom.findAll(item, i => (i.cls ?? '').split(' ').includes(cls)).length > 0;
  const label = item => {
    const cls = (item.cls ?? '').split(' ');
    if (item.hidden) return null;
    if (cls.includes('vam-relations-section')) return 'relations';
    if (cls.includes('vam-hypothesis-section')) return has(item, 'vam-hypothesis-strengths') ? 'strength' : has(item, 'vam-topic-kinds') ? 'type' : null;
    const names = { 'vam-cover-section': 'cover', 'vam-parent-section': 'parent', 'vam-reference-sources': 'sources', 'vam-marker-section': 'markers', 'vam-link-section': 'link', 'vam-branch-layout-section': 'branch-layout', 'vam-ai-lock-section': 'ai-lock' };
    return names[cls.find(c => names[c])] ?? null;
  };
  // Colour and style live only in the toolbar's Style popover (B08, tests/steps-style-popover.cjs): no colour, style or
  // whole-branch section here.
  assert.deepEqual(panel.children.map(label).filter(Boolean), ['strength', 'cover', 'type', 'parent', 'markers', 'link', 'relations', 'branch-layout', 'ai-lock']);
  const toggles = dom.findAll(panel, i => (i.cls ?? '').includes('vam-disclosure-toggle'));
  assert.deepEqual(toggles.map(b => b.text), ['Relations (1)'], 'no "More" fold; only the relations fold');
  assert.equal(toggles[0].attrs['aria-expanded'], 'false', 'relations start closed');
  const body = toggles[0].parent.children.find(c => (c.cls ?? '').includes('vam-disclosure-body'));
  assert.equal(body.hidden, true);
  toggles[0].click();
  assert.equal(toggles[0].attrs['aria-expanded'], 'true');
  assert.equal(body.hidden, false);
  assert.equal(dom.findAll(body, i => (i.cls ?? '').includes('vam-relation-row')).length, 1);
  const cover = panel.children.find(c => label(c) === 'cover');
  assert.deepEqual(dom.findAll(cover, i => i.tag === 'button').map(b => b.text), ['Turn card cover off'], 'the cover switch only: no "Crop and size…"');
  assert.equal(dom.findAll(panel, i => i.tag === 'button' && i.text === 'Add subtopic…').length, 0, 'no Add subtopic in card settings');
  for (const cls of ['vam-color-section', 'vam-style-section', 'vam-branch-toggle'])
    assert.equal(has(panel, cls), false, `no ${cls} in card settings`);
});

test('B11: card settings and expansion suggestions do not open while presenting or while notes load (P1.2 read-only)', async () => {
  const h = await harness([['R', null, 80, 80], ['B', 'R', 420, 80]]);
  const before = snapshot(h), map = h.contents.get(MAP);
  for (const [name, set, unset] of [
    ['presenting', () => { h.view.presentation = { ids: [], index: 0 }; }, () => { h.view.presentation = null; }],
    ['notes loading', () => { h.view.noteLoad = {}; }, () => { h.view.noteLoad = null; }]
  ]) {
    set();
    opened.length = 0;
    h.view.openNodePanel(h.node('B'), 'structure');
    h.view.openNodePanel(h.node('B'), 'proposals');
    assert.equal(opened.length, 0, `${name}: no dialog opens`);
    unset();
  }
  assert.deepEqual(snapshot(h), before, 'no note is written');
  assert.equal(h.contents.get(MAP), map, 'Map.md is untouched');
  // Editing again: the same call opens card settings.
  opened.length = 0;
  h.view.openNodePanel(h.node('B'), 'structure');
  assert.equal(opened.length, 1);
});

test('B11: with colour and style gone from card settings, an AI card still reaches the Style popover from its ⋯ and right-click', () => {
  const { ruleMoreSet, ruleContextSet, CARD_TOOLBAR } = load('experiences/visual-map/card-actions.ts', { obsidian });
  assert.equal(CARD_TOOLBAR['ai-card'].includes('style'), false, 'no Style on the AI card toolbar');
  assert.ok(ruleMoreSet('ai-card').includes('style'), 'Style… is in the AI card ⋯');
  assert.ok(ruleContextSet('ai-card').includes('style'), 'and in its right-click menu');
  assert.ok(CARD_TOOLBAR.card.includes('style'), 'an ordinary card has Style on its toolbar');
});
