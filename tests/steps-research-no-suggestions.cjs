// General research no longer stores new topic suggestions; an existing pending list is left as it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until, attachTopicRuns, load } = require('./support.cjs');
const { makeService } = require('./support-replay.cjs');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const research = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };

async function harness(existing, other) {
  const { repo, app } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap({ ...mapDoc }));
  const node = await repo.createNote('Swing plane', 'gpt-6-luna', mapDoc, MAP, 'workspace', {});
  mapDoc.nodes.push(node);
  await repo.saveMap(MAP, mapDoc);
  const reply = { summary: 'S', detail: 'New detail body.', visualReferences: [], suggestions: [{ title: 'New child', task: 'dig', contribution: '' }] };
  const service = makeService({ runTask: async () => JSON.stringify(reply) }, { language: 'en', reuseModule: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' };
  const pendingSuggestions = new Map();
  if (existing) pendingSuggestions.set(node.path, existing);
  if (other) pendingSuggestions.set('Other/topic.md', other);
  let asked = 0;
  const host = withExpansionCoordinator({
    repo, settings, running: new Set(), pendingSuggestions, pendingResearchOptions: new Map(), rebuildDerivedData: async () => {},
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [], mutate: async work => work(),
    confirmAiUsage: async (_model, run) => { await run(); return true; },
    researchProgress: { get: () => undefined, begin() {}, newAttempt() {}, stage() {}, preview() {}, markSlow() {}, end() {} },
    askModel: (context, model, reasoning, signal, onExchange, accepted, ...rest) => { asked++; accepted?.(); return service.askModel(context, model, reasoning, signal, onExchange, accepted, ...rest); }
  });
  host.addChartsAfterWrite = () => {};
  repo.settings = host.settings;
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  view.notes = new Map([[node.id, { title: 'Swing plane' }]]);
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate: async () => {}, ancestorContext: async () => '' });
  await view.runAgent(node, undefined, undefined, { task: 'go', ...research });
  await until(() => asked === 1 && !host.running.has(node.path));
  await until(() => true);
  return { pendingSuggestions, node, read: () => repo.readNote(node.path, mapDoc) };
}

test('research reply with suggestions on a topic that had pending leaves no pending for it, the note is written', async () => {
  const h = await harness([{ title: 'Old child', task: 'old task', contribution: 'c' }]);
  assert.equal(h.pendingSuggestions.has(h.node.path), false);
  assert.ok((await h.read()).detail.includes('New detail body.'));
});

test('research does not touch the pending list of another topic', async () => {
  const other = [{ title: 'Other child', task: 'other task', contribution: 'c' }];
  const h = await harness(undefined, other);
  assert.deepEqual(JSON.parse(JSON.stringify(h.pendingSuggestions.get('Other/topic.md'))), other);
  assert.equal(h.pendingSuggestions.has(h.node.path), false);
});

test('research reply with suggestions and no pending list stores nothing, the note is still written', async () => {
  const h = await harness();
  assert.equal(h.pendingSuggestions.has(h.node.path), false);
  assert.ok((await h.read()).detail.includes('New detail body.'));
});
