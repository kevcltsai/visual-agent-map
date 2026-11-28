// P4.6 Recombination (V3.3 F06): the selected cards and the read-only reference cards hanging on them are synthesized into a
// NEW card through the existing multi-select synthesis. Originals keep their bytes; the new card's citations carry the
// original's id, path and revision; cancel or failure adds no card; a read-only map or a merging card refuses before any AI
// call. A real view over a fake vault; only askModel is a double (it resolves [S#] markers the way the AI task service does).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns, until } = S;
const refs = S.load('ai/reference-materials.ts');

const HOST = 'Agent Workspace/Topics/map-host/Map.md';
const OTHER = 'Agent Workspace/Topics/map-other/Map.md';
const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [], synthesisTitle: 'Recombined' };

async function harness({ reply } = {}) {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' };
  repo.settings = settings;
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-host');
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-other');
  const other = { id: 'map-other', title: 'Other map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const original = await repo.createNote('Original card', 'gpt-6-luna', other, OTHER, 'workspace');
  Object.assign(original, { parentId: null, x: 0, y: 0 }); other.nodes.push(original);
  await app.vault.create(OTHER, core.serializeMap(other));
  await repo.updateNote(original.path, { summary: 'Original summary', detail: 'ORIGINAL BODY', status: 'completed' });
  const host = { id: 'map-host', title: 'Host map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(HOST, core.serializeMap(host));
  const nodes = [];
  for (const [index, title] of ['A', 'B'].entries()) {
    const created = await repo.createNote(title, 'gpt-6-luna', host, HOST, 'workspace');
    Object.assign(created, { parentId: null, x: 80, y: 80 + index * 200 }); host.nodes.push(created); nodes.push(created);
  }
  host.knowledgeRefs = [{ id: 'ref-a', mapId: 'map-other', nodeId: original.id, parentId: nodes[0].id, x: 300, y: 0, pathHint: OTHER }];
  await repo.saveMap(HOST, host);
  for (const node of nodes) await repo.updateNote(node.path, { summary: `${node.path} summary`, detail: `${node.path} detail`, status: 'completed' });
  await repo.rebuildDerivedData();
  const asks = [], notices = [];
  let gate = null;
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(),
    rebuildDerivedData: () => repo.rebuildDerivedData(), recordFailure: (_label, error) => String(error?.message ?? error), views: () => [],
    logs: { appendLog() {} }, mutate: async work => work(),
    confirmAiUsage: async (_model, run) => { await run(); return true; },
    askModel: async (context, _model, _reasoning, signal, _exchange, accepted) => {
      asks.push(context);
      accepted?.();
      if (gate) await new Promise((resolve, reject) => { gate.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); });
      if (reply) return reply(context);
      return { summary: 'Combined', detail: refs.resolveDetailReferences('One [S1]. Two [S2]. Three [S3].', context.referenceGroups), visualReferences: [], suggestions: [] };
    }
  });
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { open() {} close() {} } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin));
  view.armHighlightFade = () => {};
  const hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path, view.map)]))); };
  Object.assign(view, { path: HOST, map: await repo.readMap(HOST), contentEl: { querySelector: () => null }, render() {}, hydrate, ancestorContext: async () => '', queueCharts() {}, focusNode() {} });
  await hydrate();
  const sources = () => view.map.nodes.filter(n => nodes.some(item => item.id === n.id));
  const snapshot = () => new Map([...contents.entries()].filter(([path]) => path.endsWith('.md') && path !== HOST));
  return { repo, app, contents, view, plugin, nodes, original, asks, notices, sources, snapshot, hold: () => { gate = []; return gate; } };
}
const run = (h, failures = []) => h.view.startSelectionSynthesis(h.sources(), { ...options }, 'Combine across domains', message => failures.push(message), () => {});
const underived = text => text.replace(/^agent-map-references:\n(?:  - .*\n)*/m, '').replace(/<!-- visual-agent-map:references:start -->[\s\S]*<!-- visual-agent-map:references:end -->/, '');
const refDocument = context => context.referenceGroups.flatMap(group => group.documents).find(doc => /Original card/.test(doc.path));

test('P4.6 the reference card hanging on a selected card goes in as a source, with the original id and revision', async () => {
  const h = await harness();
  await run(h);
  assert.equal(h.asks.length, 1);
  const doc = refDocument(h.asks[0]);
  assert.ok(doc, 'the original card of the reference is one of the sources');
  assert.match(doc.content, /ORIGINAL BODY/);
  assert.equal(doc.nodeId, h.original.id);
  assert.equal(doc.rev, refs.sourceRevision(h.contents.get(h.original.path)));
});

test('P4.6 the result is a new card; every original keeps its bytes and the reference stays as it was', async () => {
  const h = await harness();
  const before = h.snapshot(), otherMap = h.contents.get(OTHER), refsBefore = JSON.stringify(h.view.map.knowledgeRefs);
  const failures = [];
  await run(h, failures);
  assert.deepEqual(failures, []);
  await until(() => h.view.map.nodes.length === 3);
  // The reference original (another map) keeps every byte. A local source keeps every byte outside its derived Reference
  // Links (rebuilt from the map; the new card's "derives from" relation adds a line there).
  assert.equal(h.contents.get(h.original.path), before.get(h.original.path), 'the reference original is byte-identical');
  for (const node of h.nodes) assert.equal(underived(h.contents.get(node.path)), underived(before.get(node.path)), `${node.path} keeps its content`);
  assert.deepEqual([...before.keys()].filter(path => h.contents.get(path) !== before.get(path)).sort(), h.nodes.map(n => n.path).sort(), 'no other note is touched');
  assert.equal(h.contents.get(OTHER), otherMap, 'the other map is not written');
  const saved = await h.repo.readMap(HOST);
  assert.equal(JSON.stringify(saved.knowledgeRefs), refsBefore, 'the reference is unchanged and still read-only');
});

test('P4.6 the new card cites each original by id, path and revision', async () => {
  const h = await harness();
  const revs = new Map([...h.nodes, h.original].map(n => [n.path, refs.sourceRevision(h.contents.get(n.path))]));
  await run(h);
  await until(() => h.view.map.nodes.length === 3);
  const created = h.view.map.nodes.find(n => !h.nodes.some(item => item.id === n.id));
  const note = await h.repo.readNote(created.path, h.view.map);
  for (const source of [...h.nodes, h.original]) {
    const target = `[[${source.path}|${source.path.split('/').pop().replace(/\.md$/, '')}]]%%vam-src:${source.id}:${revs.get(source.path)}%%`;
    assert.ok(note.detail.includes(target), `cites ${source.path}: ${note.detail}`);
  }
  assert.ok(note.sourcePaths.includes(h.original.path), 'the original path is among the sources');
});

test('P4.6 cancel during the AI run adds no card and writes no note', async () => {
  const h = await harness();
  const before = h.snapshot();
  const gate = h.hold();
  const done = run(h);
  await until(() => h.asks.length === 1);
  assert.ok(refDocument(h.asks[0]), 'the reference was part of the run');
  h.view.plugin.topicRuns.syntheses(h.view).selection.controller.abort();
  gate.forEach(resolve => resolve());
  await done;
  assert.equal(h.view.map.nodes.length, 2);
  assert.equal((await h.repo.readMap(HOST)).nodes.length, 2);
  assert.deepEqual([...h.snapshot().keys()], [...before.keys()], 'no new note file');
});

test('P4.6 failure: an original that changes during the run, or a model error, adds no card', async () => {
  const h = await harness();
  const gate = h.hold();
  const failures = [];
  const done = run(h, failures);
  await until(() => h.asks.length === 1);
  await h.repo.updateNote(h.original.path, { detail: 'ORIGINAL BODY, edited meanwhile' });
  const before = h.snapshot();
  gate.forEach(resolve => resolve());
  await done;
  assert.equal(h.view.map.nodes.length, 2, 'a stale reference source saves nothing');
  assert.deepEqual([...h.snapshot().keys()], [...before.keys()]);
  assert.ok(failures.length >= 1 || h.view.plugin.topicRuns.syntheses(h.view).selection?.state === 'failed');

  const broken = await harness({ reply: () => { throw new Error('provider down'); } });
  const quiet = broken.snapshot();
  await run(broken);
  assert.equal(broken.asks.length, 1);
  assert.ok(refDocument(broken.asks[0]));
  assert.equal(broken.view.map.nodes.length, 2);
  assert.deepEqual([...broken.snapshot().keys()], [...quiet.keys()]);
});

test('P4.6 a read-only map or a merging card refuses before any AI call', async () => {
  const h = await harness();
  h.view.presentation = { active: true };
  const failures = [];
  await run(h, failures);
  assert.equal(h.asks.length, 0, 'no AI call while read-only');
  assert.equal(failures.length, 1);
  assert.equal(h.view.map.nodes.length, 2);

  const l = await harness();
  l.view.noteLoad = { isCurrent: () => true };
  const loading = [];
  await run(l, loading);
  assert.equal(l.asks.length, 0, 'no AI call while notes are loading');
  assert.equal(loading.length, 1);
  assert.equal(l.view.map.nodes.length, 2);

  const m = await harness();
  m.view.mergeDrafts = { isMerging: id => id === m.nodes[0].id };
  const merging = [];
  await run(m, merging);
  assert.equal(m.asks.length, 0, 'no AI call while a source is being merged');
  assert.equal(merging.length, 1);
  assert.equal(m.view.map.nodes.length, 2);
});

test('P4.6 every reference sent to the AI is named in the synthesis dialog', async () => {
  const h = await harness();
  // The dialog opens before the references were read for the canvas (an empty cache): what it lists is what is sent.
  let dialog = null;
  h.view.openMapModal = modal => { dialog = modal; return modal; };
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  h.view.openSelectionSynthesis(null);
  await until(() => dialog);
  const names = dialog.selectionFlow.names;
  const failures = [];
  await dialog.synthesize({ ...options }, 'Combine across domains', message => failures.push(message), () => {});
  assert.deepEqual(failures, []);
  assert.equal(h.asks.length, 1);
  const sent = h.asks[0].referenceGroups.flatMap(group => group.documents).filter(doc => !h.nodes.some(n => n.path === doc.path));
  assert.ok(sent.length >= 1, 'the reference original is sent');
  for (const doc of sent) {
    const title = doc.path.split('/').pop().replace(/\.md$/, '');
    assert.ok(names.some(name => name.includes(title)), `${doc.path} is sent but the dialog lists only ${JSON.stringify(names)}`);
  }
});

test('P4.6 a reference whose original has an empty title is listed, sent and the synthesis saves a new card', async () => {
  const h = await harness();
  const io = h.repo.knowledgeRefIO.bind(h.repo);
  h.repo.knowledgeRefIO = () => {
    const base = io();
    return { ...base, readNote: async path => { const note = await base.readNote(path); return note && path === h.original.path ? { ...note, title: '' } : note; } };
  };
  let dialog = null;
  h.view.openMapModal = modal => { dialog = modal; return modal; };
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  h.view.openSelectionSynthesis(null);
  await until(() => dialog);
  const names = dialog.selectionFlow.names;
  const failures = [];
  await dialog.synthesize({ ...options }, 'Combine across domains', message => failures.push(message), () => {});
  assert.deepEqual(failures, []);
  assert.equal(h.asks.length, 1);
  const sent = h.asks[0].referenceGroups.flatMap(group => group.documents).filter(doc => !h.nodes.some(n => n.path === doc.path));
  assert.equal(sent.map(doc => doc.path).join('\n'), h.original.path, 'the empty-titled original is sent');
  assert.equal(names.length - h.nodes.length, sent.length, `listed references equal sent ones: ${JSON.stringify(names)}`);
  for (const doc of sent) {
    const title = doc.path.split('/').pop().replace(/\.md$/, '');
    assert.ok(names.some(name => name.includes(title)), `${doc.path} is sent but the dialog lists only ${JSON.stringify(names)}`);
  }
  await until(() => h.view.map.nodes.length === 3);
});

test('P4.6 (F06-x) two recombinations in a row: the new cards never overlap any card, and an untouched card keeps its x and y', async () => {
  const h = await harness();
  const far = await h.repo.createNote('Far', 'gpt-6-luna', h.view.map, HOST, 'workspace');
  Object.assign(far, { parentId: null, x: 3000, y: 3000 }); h.view.map.nodes.push(far);
  await h.repo.saveMap(HOST, h.view.map);
  await h.view.hydrate();
  const failures = [];
  await run(h, failures);
  await until(() => h.view.map.nodes.length === 4);
  await run(h, failures);
  await until(() => h.view.map.nodes.length === 5);
  assert.deepEqual(failures, []);
  const nodes = h.view.map.nodes;
  const rect = n => ({ l: n.x, r: n.x + (n.width ?? 300), t: n.y, b: n.y + (h.view.cardHeightOf(n.id) ?? 180) });
  for (const a of nodes) for (const b of nodes) {
    if (a.id >= b.id) continue;
    const p = rect(a), q = rect(b);
    assert.equal(p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b, false, `${a.id} overlaps ${b.id}`);
  }
  const farNow = nodes.find(n => n.id === far.id);
  assert.deepEqual([farNow.x, farNow.y], [3000, 3000], 'an unaffected card does not move');
});

// F06-y: a Living Node note read as a source is cited by the revision of its model view (livingNoteForModel), the same way
// topicReferenceGroup reads it, so compareCitation over that view says "same" until the note's own content changes.
const living = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian });
async function makeLiving(h, node, text) {
  if (!/^ai-card: true$/m.test(h.contents.get(node.path))) await h.app.vault.process(h.app.vault.getAbstractFileByPath(node.path), c => c.replace(/\n---\n/, '\nai-card: true\n---\n'));
  const before = h.contents.get(node.path);
  const base = living.readLivingMarkdown(before);
  const candidate = { executionId: 'x' + text, cardId: node.id, mapId: h.view.map.id, baseRevision: living.livingSnapshotRevision(before), inputRevision: 'i', viewSession: 'v' };
  const result = await living.commitLivingMarkdown(h.repo, { path: node.path, expectedContent: before, candidate, base, baseGeneration: living.livingGeneration(before),
    proposal: { baseRevision: base.revision, operations: [{ kind: 'output', text, evidence: ['e1'] }] },
    context: { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] },
    signal: new AbortController().signal, isCurrent: () => true,
    inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) });
  assert.equal(result, 'written');
}

for (const kind of ['plain', 'living']) {
  test(`F06-y recombination citation of a ${kind} source: same while unchanged, changed after an edit`, async () => {
    const h = await harness();
    const [first] = h.nodes;
    if (kind === 'living') {
      await makeLiving(h, first, 'LIVING-OUTPUT');
      assert.notEqual(living.livingNoteForModel(h.contents.get(first.path)), h.contents.get(first.path), 'the source is a Living Node note');
    }
    await h.repo.rebuildDerivedData();
    const read = () => living.livingNoteForModel(h.contents.get(first.path));
    const beforeRun = read();
    await run(h);
    await until(() => h.view.map.nodes.length === 3);
    const created = h.view.map.nodes.find(n => !h.nodes.some(item => item.id === n.id));
    const detail = (await h.repo.readNote(created.path, h.view.map)).detail;
    const target = new RegExp(`\\[\\[${first.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|[^\\]]*\\]\\]%%vam-src:[A-Za-z0-9_-]+:[0-9a-f]{8}%%`).exec(detail)?.[0];
    assert.ok(target, `cites the source: ${detail}`);
    // The run itself adds derived Reference Links to a source, so "unchanged" is the note as it stood when it was read.
    assert.equal(refs.compareCitation(target, [{ path: first.path, content: beforeRun }]).status, 'same', 'unchanged source is not stale');
    const asModelSees = () => [{ path: first.path, content: read() }];
    if (kind === 'living') await makeLiving(h, first, 'LIVING-OUTPUT-2');
    else await h.repo.updateNote(first.path, { detail: 'EDITED DETAIL' });
    assert.equal(refs.compareCitation(target, asModelSees()).status, 'changed', 'edited source is stale');
  });
}
