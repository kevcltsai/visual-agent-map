// Hypothesis research entry (P8, rewritten: the start dialog is removed, so these tests replace the dialog tests). Sending from the opening
// screen's "Hypothesis research" tab starts the run at once; a press that arrives after the map changed (nodes, another map, closed view, a
// run already going) starts nothing. Unit level: the view method runs on a plain object that has only what it reads.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, obsidian, root } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { repoFiles } = require('./support-repo-scan.cjs');

const notices = [];
class Notice { constructor(message) { notices.push(message); } }
const overrides = { obsidian: { ...obsidian, Notice } };
const MODULES = load('main.ts', overrides, { createFragment: dom.createFragment });
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;

function fakeView(over = {}) {
  const calls = { starts: [], cleared: 0 };
  const view = {
    closed: false, path: 'M.vam', app: {},
    map: { id: 'm1', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } },
    chatHero: () => true,
    chat: { clearDraft() { calls.cleared++; } },
    plugin: {
      settings: { cliModel: 'a' },
      argumentRuns: { isRunning: () => false, start(mapPath, claim) { calls.starts.push([mapPath, claim]); return Promise.resolve(); } }
    },
    ...over
  };
  return { view, calls };
}
const press = (view, claim) => VisualAgentMapView.prototype.startArgumentFromTab.call(view, claim);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('sending from the research tab starts the run at once with the trimmed claim, clears the draft, and remembers the map for the card focus', async () => {
  const { view, calls } = fakeView();
  press(view, '  claim  ');
  await settle();
  assert.deepEqual(calls.starts, [['M.vam', 'claim']]);
  assert.equal(calls.cleared, 1, 'the draft is cleared');
  assert.equal(view.argumentFocusMapId, 'm1');
});

test('counterexample: a blank claim starts nothing and keeps the draft', async () => {
  for (const claim of ['', '   ', ' \n\t ']) {
    const { view, calls } = fakeView();
    press(view, claim);
    await settle();
    assert.equal(calls.starts.length, 0, JSON.stringify(claim));
    assert.equal(calls.cleared, 0);
  }
});

const STALE = {
  'not on the opening screen': v => { v.chatHero = () => false; },
  'the map got a node': v => { v.map.nodes.push({ id: 'n' }); },
  'the map already has an argument key': v => { v.map.argumentMap = {}; },
  'the map is gone': v => { v.map = null; },
  'the view was closed': v => { v.closed = true; },
  'a run is already going': v => { v.plugin.argumentRuns.isRunning = () => true; }
};
for (const [name, change] of Object.entries(STALE)) {
  test(`counterexample: ${name}: sending again starts no second run and keeps the draft`, async () => {
    const { view, calls } = fakeView();
    change(view);
    press(view, 'claim');
    await settle();
    assert.equal(calls.starts.length, 0);
    assert.equal(calls.cleared, 0, 'the draft stays');
  });
}

test('a refused start shows a notice and releases the card focus; the run is not awaited', async () => {
  const plugin = new Plugin();
  const refusal = await plugin.argumentRuns.start('p', '').catch(error => error);
  const { view, calls } = fakeView();
  view.plugin.argumentRuns.start = () => Promise.reject(refusal);
  notices.length = 0;
  press(view, 'claim');
  await settle();
  assert.deepEqual(notices, ['Could not start hypothesis research on this mind map.']);
  assert.equal(calls.cleared, 1);
  assert.equal(view.argumentFocusMapId, null);
});

test('the host hands the tab its start, and the usage line shows the worst case: 122 AI calls', () => {
  const { WORST_CASE_AI_CALLS } = load('experiences/visual-map/argument-run.ts', overrides);
  assert.equal(WORST_CASE_AI_CALLS, 122);
  const { view } = fakeView();
  const host = VisualAgentMapView.prototype.chatHost.call(view);
  assert.equal(host.argumentCalls(), 122);
  const asked = [];
  view.startArgumentFromTab = claim => asked.push(claim);
  host.startArgumentResearch('x');
  assert.deepEqual(asked, ['x']);
});

test('the start dialog is gone: its module is deleted, nothing imports or names it, and its i18n keys are removed', () => {
  assert.equal(fs.existsSync(path.join(root, 'ui/modals/argument-start-modal.ts')), false, 'the module file');
  const stale = /argument-start-modal|ArgumentStartModal|argument_start_(title|confirm|button|usage_0)/;
  const hits = repoFiles(root, { skipDirectories: ['node_modules', '.git'] })
    .filter(file => /\.(ts|cjs|mjs)$/.test(file) && file !== 'tests/steps-argument-entry.cjs')
    .filter(file => stale.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(hits, []);
});

// focusNode only pans the camera; the real keyboard focus (still in the opening screen's composer) must be moved onto the card itself.
test('the proposition card takes the keyboard focus once, not just the camera, when the argument map first shows', () => {
  const machine = load('core/argument-map/machine.ts');
  const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
  const doc = { activeElement: null };
  const composer = dom.element('textarea'); composer.root = doc; composer.focus();
  const card = dom.element('div'); card.root = doc;
  const cardFocus = card.focus.bind(card);
  card.focus = options => { card.focusOptions = options; cardFocus(); };
  const panned = [];
  const view = {
    argumentFocusMapId: 'm1',
    map: { id: 'm1', nodes: [{ id: 'p' }, { id: 's' }, { id: 'c' }, { id: 'v' }, { id: 'e' }], argumentMap: machine.newArgumentMap(roles, 'run') },
    cardEls: new Map([['p', card]]),
    focusNode: node => panned.push(node.id)
  };
  VisualAgentMapView.prototype.focusArgumentRootOnce.call(view);
  assert.deepEqual(panned, ['p']);
  assert.equal(doc.activeElement, card, 'the card, not the composer, holds the focus');
  assert.equal(card.focusOptions.preventScroll, true);
  assert.equal(view.argumentFocusMapId, null);
  composer.focus();
  VisualAgentMapView.prototype.focusArgumentRootOnce.call(view);
  assert.equal(doc.activeElement, composer, 'only once: a later sync does not steal focus again');
});
