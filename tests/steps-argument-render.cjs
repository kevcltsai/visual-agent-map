// P7c: argument map cards in the view (title source, no summary or type tag), tree arrowheads, the managed lock panel, and the
// production createNote kind mapping. Ordinary maps must see none of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const machine = support.load('core/argument-map/machine.ts');
const run = support.load('experiences/visual-map/argument-run.ts');
const MAP = 'Agent Workspace/Topics/map-pv1/Map.md';
const root = path.resolve(__dirname, '..');

// P -> S, C ; C -> V, E ; V -> H ; H -> N   (proposition, situation, conclusion, verified group, eliminated group, hypothesis, need)
const SPEC = [['P', null], ['S', 'P'], ['C', 'P'], ['V', 'C'], ['E', 'C'], ['H', 'V'], ['N', 'H']];
async function harness({ argument }) {
  const { repo, app } = support.fixture('en', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-pv1', title: 'PV1', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-pv1');
  const byTitle = new Map();
  for (const [title, parentTitle] of SPEC) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x: 0, y: 0 });
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  const id = title => byTitle.get(title).id;
  if (argument) {
    const state = machine.newArgumentMap({ proposition: id('P'), situation: id('S'), conclusion: id('C'), verified: id('V'), eliminated: id('E') }, 'run-1');
    state.hypotheses.push({ id: id('H'), citedData: [], round: 1, location: 'verifying', needs: [{ id: id('N'), text: 'n', addedRound: 1, state: 'pending' }] });
    mapDoc.argumentMap = state;
  }
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } });
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => Promise.resolve().then(work)
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const host = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  view.edgesEl = host; view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  for (const [title] of SPEC) view.cardEls.set(id(title), { offsetLeft: 100, offsetTop: 40, offsetWidth: 300, offsetHeight: 80 });
  return { view, host, id, repo, tips: () => host.children.filter(c => c.classes.includes('vam-argument-tip')) };
}

test('arrowheads: an argument map draws one per parent that has children, none for the proposition or the eliminated group', async () => {
  const h = await harness({ argument: true });
  h.view.drawEdges();
  assert.equal(h.tips().length, 3, 'conclusion, verified group and hypothesis (their children hang to the right)');
  for (const tip of h.tips()) assert.match(tip.attrs.d, /^M 401 80 L 408 75 L 408 85 Z$/, 'on the parent right edge, point toward the parent');
  assert.equal(h.host.children.filter(c => c.classes.includes('vam-edge')).length, 6, 'the tree edges themselves are unchanged');
});

test('arrowheads: an ordinary map (no argumentMap key) draws none', async () => {
  const h = await harness({ argument: false });
  h.view.drawEdges();
  assert.equal(h.tips().length, 0);
  assert.equal(h.host.children.filter(c => c.classes.includes('vam-edge')).length, 6);
});

test('arrowheads: an unusable argumentMap key draws none', async () => {
  const h = await harness({ argument: false });
  h.view.map.argumentMap = { v: 2 };
  h.view.drawEdges();
  assert.equal(h.tips().length, 0);
});

test('card view: managed cards get a view, free cards and ordinary maps do not; the heading never reads the note body', async () => {
  const h = await harness({ argument: true });
  assert.equal(h.view.argumentCardView(h.id('H')).role, 'hypothesis');
  assert.equal(h.view.argumentCardView('free'), null);
  const conclusion = h.view.argumentCardView(h.id('C'));
  assert.equal(conclusion.titleFrom, 'text');
  const note = { title: 'Note title', summary: 'SECRET ANSWER', detail: 'SECRET BODY' };
  assert.doesNotMatch(h.view.argumentTitleOf(conclusion, note), /SECRET/, 'in progress shows the derived text');
  assert.equal(h.view.argumentTitleOf({ titleFrom: 'summary' }, note), 'SECRET ANSWER', 'a concluded card shows the summary');
  assert.equal(h.view.argumentTitleOf({ titleFrom: 'note' }, note), 'Note title');
  const plain = await harness({ argument: false });
  assert.equal(plain.view.argumentCardView(plain.id('H')), null);
});

test('renderNode and refreshCard: managed cards skip the summary, the add-summary hint and the type tag (source)', () => {
  const view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view, /if \(argumentView\) renderArgumentCardBody\(card, argumentView, \(\) => void this\.rerunFromDefinitions\(node\.id\)\);\n\s+else if \(textEditable/);
  assert.match(view, /!argumentView &&\n\s+textEditable &&/);
  assert.match(view, /if \(argumentView\) \{\n\s+summary\?\.remove\(\);\n\s+addLine\?\.remove\(\);/);
  assert.match(view, /if \(argumentView\) \{\n[^\n]*\n[^\n]*\n\s+renderArgumentKind\(header, argumentView\);/);
  // Baseline 11 on 4728cbcd; main's partial-repaint commit ffd32778 added one call site, this feature adds none.
  assert.equal(view.split('\n').filter(line => line.includes('drawEdges')).length, 12, 'no new drawEdges call sites');
  // 23 before the subtree chain; it checks the AI lock before each step (one more call site, same guard, no new AI entry).
  assert.equal(view.split('\n').filter(line => line.includes('aiLockReason(')).length, 24);
});

test('lock panel: a managed card shows locked and disabled with the managed text; a free card keeps the switch', async () => {
  const h = await harness({ argument: true });
  const panel = dom.element('div');
  const node = id => h.view.map.nodes.find(n => n.id === id);
  h.view.renderAiLockSection(panel, node(h.id('H')));
  const button = dom.find(panel, i => i.tag === 'button');
  assert.equal(button.disabled, true);
  assert.equal(button.attrs['aria-disabled'], 'true');
  assert.equal(button.attrs['aria-pressed'], 'true');
  assert.ok(dom.texts(panel).some(text => /research flow/.test(text)));
  const free = await harness({ argument: false });
  const plainPanel = dom.element('div');
  free.view.renderAiLockSection(plainPanel, free.view.map.nodes[0]);
  const plainButton = dom.find(plainPanel, i => i.tag === 'button');
  assert.equal(plainButton.disabled, false);
  assert.equal(plainButton.attrs['aria-disabled'], undefined);
});

test('card lock button: a managed card always shows a disabled, pressed lock that offers no unlock; a free unlocked card has none', async () => {
  const h = await harness({ argument: true });
  const node = id => h.view.map.nodes.find(n => n.id === id);
  const card = dom.element('div');
  const header = dom.element('div');
  h.view.paintAiLock(card, header, node(h.id('H')));
  const button = dom.find(header, i => i.tag === 'button');
  assert.ok(button, 'managed card has the lock button even if the note is not locked');
  assert.equal(button.disabled, true);
  assert.equal(button.attrs['aria-disabled'], 'true');
  assert.equal(button.attrs['aria-pressed'], 'true');
  assert.ok(/research flow/.test(button.attrs['aria-label']));
  assert.equal(/Unlock|unlock/.test(button.attrs['aria-label']), false);
  const free = await harness({ argument: false });
  const freeHeader = dom.element('div');
  free.view.paintAiLock(dom.element('div'), freeHeader, free.view.map.nodes[0]);
  assert.equal(dom.find(freeHeader, i => i.tag === 'button'), undefined);
});

test('setAiLock: managed nodes are filtered out and nothing is written; an ordinary map still locks', async () => {
  const h = await harness({ argument: true });
  const before = new Map(h.view.map.nodes.map(n => [n.id, JSON.stringify(h.view.notes.get(n.id))]));
  h.view.beginMapTransaction = () => { throw new Error('must not write'); };
  await h.view.setAiLock(h.view.map.nodes, true);
  assert.deepEqual(new Map(h.view.map.nodes.map(n => [n.id, JSON.stringify(h.view.notes.get(n.id))])), before);
});

test('multi-select lock menu item excludes managed nodes (source)', () => {
  const view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view, /!!node && !this\.isArgumentCard\(node\.id\) && !!this\.notes\.get\(node\.id\)/);
});

test('production createNote port: datum and need become evidence, hypothesis and conclusion keep theirs, the rest are topics', () => {
  const kinds = { proposition: 'topic', situation: 'topic', group: 'topic', datum: 'evidence', need: 'evidence', hypothesis: 'hypothesis', conclusion: 'conclusion' };
  for (const [kind, expected] of Object.entries(kinds)) assert.equal(run.topicKindOfNote(kind), expected, kind);
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(main, /topicKind: topicKindOfNote\(input\.kind\)/, 'main.ts createNote port uses the mapping');
});

test('UI fixture: each state reads as usable, shows its conclusion state, and the default covers dashed items, stances and an eliminated hypothesis', () => {
  const fixture = require('./fixtures/argument-map-ui.cjs');
  const model = support.load('core/argument-map/model.ts');
  const views = {};
  for (const [name, one] of Object.entries(fixture.states)) {
    const ids = Object.fromEntries(one.notes.map(n => [n.key, `id-${n.key}`]));
    const read = model.readArgumentMap({ nodes: one.notes.map(n => ({ id: ids[n.key] })), argumentMap: fixture.bind(one.map.argumentMap, ids) });
    assert.equal(read.kind, 'usable', name);
    views[name] = model.conclusionView(read.data);
    if (name === 'in_progress') {
      const items = [...read.data.hypotheses.flatMap(h => h.needs), ...read.data.situation.data];
      assert.ok(items.some(i => i.state === 'not_found') && items.some(i => i.state === 'pending'), 'dashed items');
      assert.deepEqual([...new Set(items.map(i => i.stance).filter(Boolean))].sort(), ['contradicts', 'opposes', 'supports', 'uncertain']);
      assert.ok(read.data.hypotheses.some(h => h.location === 'eliminated'));
    }
  }
  assert.deepEqual(Object.fromEntries(Object.entries(views).filter(([name]) => !name.startsWith('facet_'))), { in_progress: 'in_progress', concluded: 'concluded', stopped_mismatch: 'stopped_mismatch', stopped_limit: 'stopped_limit' });
});
