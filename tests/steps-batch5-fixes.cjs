// UI batch 5 fixes: G-2 (ticket 43) a pointerdown on a frame's label chip must not start a canvas pan, or the
// chip's double-click never fires (the pan captures the pointer and retargets the click to the viewport).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const panView = () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { settings: { ...DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  const handlers = new Map();
  const captured = [];
  const classes = new Set();
  view.viewportEl = {
    handlers, clientWidth: 800, clientHeight: 600,
    addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); },
    setPointerCapture(id) { captured.push(id); }, releasePointerCapture() {},
    addClass(c) { classes.add(c); }, removeClass(c) { classes.delete(c); }, hasClass: c => classes.has(c),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 })
  };
  view.map = { id: 'm', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  view.transform = () => {}; view.saveViewport = () => {};
  view.setupPan();
  const down = target => handlers.get('pointerdown')({ target, button: 0, clientX: 10, clientY: 10, pointerId: 7, altKey: false, shiftKey: false, preventDefault() {} });
  return { captured, classes, down };
};
const on = selector => ({ closest: s => (s === selector ? {} : null) });

test('G-2: a pointerdown on a frame label chip does not start a pan; bare canvas still pans', () => {
  const { captured, classes, down } = panView();
  down(on('.vam-boundary-label'));
  assert.deepEqual(captured, [], 'no pointer capture from the label chip');
  assert.equal(classes.has('is-panning'), false);
  down({ closest: () => null });
  assert.deepEqual(captured, [7], 'a pointerdown elsewhere on the canvas still pans');
});

// M1 (0.28 triage #40): the outline window's AI generation under a topic follows that topic's model like the window's
// default entry says; reasoning stays the current model's (MS-06 D5).
const { fixture, withExpansionCoordinator } = require('./support.cjs');
const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const CURRENT = { model: 'claude-sonnet-5-5', reasoning: 'high' };
async function outlineHarness() {
  const { repo, app } = fixture('en');
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const doc = { id: 'map-a', title: 'A', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const calls = { confirm: [], outline: [] };
  const plugin = withExpansionCoordinator({
    repo, settings: repo.settings, running: new Set(), mutate: async work => work(), releaseOutline() {},
    currentModelChoice: () => ({ ...CURRENT }),
    confirmAiUsage: async (model, run) => { calls.confirm.push(model); await run(); return true; },
    outlineGeneration: { generate: async request => { calls.outline.push(request); return { markdown: '# T\n', nodes: [] }; } }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = doc; view.render = () => {};
  const manual = await repo.createNote('Manual', 'gpt-x', doc, MAP, 'manual');
  const plain = await repo.createNote('Plain', 'settings-model-not-used', doc, MAP, 'workspace');
  doc.nodes.push(manual, plain);
  const run = async request => {
    await view.outlineGenerator('T').generate({ topic: 'T', presetText: 'p', ...request }, new AbortController().signal, () => ({ topic: 'T', presetId: 'k', presetText: 'p', placement: 'under', target: { map: 'editable' }, shallow: false, mode: 'quick' }));
    return calls.outline.at(-1);
  };
  return { run, calls, manual, plain };
}
test('M1: under a topic with a manual model the default generates with that model; reasoning stays current', async () => {
  const h = await outlineHarness();
  const sent = await h.run({ placement: { kind: 'under', parentId: h.manual.id } });
  assert.equal(sent.model, 'gpt-x');
  assert.equal(sent.reasoning, CURRENT.reasoning);
  assert.deepEqual(h.calls.confirm, ['gpt-x']);
});
test('M1: a new tree, an inherited-less parent and a picked model keep their models', async () => {
  const h = await outlineHarness();
  assert.equal((await h.run({ placement: { kind: 'tree' } })).model, CURRENT.model);
  assert.equal((await h.run({ placement: { kind: 'under', parentId: h.plain.id } })).model, CURRENT.model);
  assert.equal((await h.run({ placement: { kind: 'under', parentId: h.manual.id }, model: 'picked-m' })).model, 'picked-m');
});
