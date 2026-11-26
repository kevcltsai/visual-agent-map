const assert = require('node:assert/strict');
const S = require('../support.cjs');
const { commitLivingMarkdown, livingSnapshotRevision, readLivingMarkdown } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const initial = '---\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\ncustom-key: keep\n---\n# Existing title\n\n## Detail\n\nManual notes, never replace.\n';
const empty = () => ({ revision: 'empty', records: [], suppressed: [], output: { text: '', owner: 'ai', evidence: [] } });
const context = { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] };
const proposal = { baseRevision: 'empty', operations: [{ kind: 'output', text: 'Current findings', evidence: ['e1'] }] };
const path = 'card.md';
async function setup() {
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  return f;
}
function request(f, extra = {}) {
  const expectedContent = extra.expectedContent ?? f.contents.get(path);
  const candidate = { executionId: 'e1', cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i1', viewSession: 'v1', ...extra.candidate };
  return { path, expectedContent, base: empty(), proposal, context, signal: new AbortController().signal, isCurrent: () => true,
    ...extra, candidate, inspect: extra.inspect ?? (async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false })) };
}

S.integrationTest('Living Node: first commit uses real Repository guard and preserves original note body and custom metadata', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const actual = f.contents.get(path);
  assert.ok(actual.includes('custom-key: keep'));
  assert.ok(actual.includes('# Existing title\n\n## Detail\n\nManual notes, never replace.'));
  assert.ok(actual.includes('> Current findings'));
  assert.ok(actual.includes('living-node-last-execution: "e1"'));
  assert.ok(actual.includes('living-node-last-successful-check:'));
  assert.equal((actual.match(/vam-living-node:begin/g) ?? []).length, 1);
});

S.integrationTest('Living Node: a Repository-created AI card can commit using its real map and node identity', async () => {
  const f = S.fixture('en');
  const mapPath = await f.repo.createMap('Living Node map');
  const map = await f.repo.readMap(mapPath);
  const card = await f.repo.createNote('Research card', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(card);
  await f.repo.saveMap(mapPath, map);
  await f.repo.updateNote(card.path, { prompt: 'Research' });
  await f.repo.writeAiCard(card.path, true);
  const expectedContent = f.contents.get(card.path);
  const candidate = { executionId: 'actual-created-card', cardId: card.id, mapId: map.id,
    baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'input', viewSession: 'view' };
  const r = request(f, { path: card.path, expectedContent, candidate });
  assert.equal(await commitLivingMarkdown(f.repo, r), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(card.path)).output.text, 'Current findings');
});

S.integrationTest('Living Node: existing Repository map identity is distinct from node identity', async () => {
  for (const bad of [
    initial.replace('node-id: card', 'node-id: another'),
    initial.replace('topic-id: map', 'topic-id: card'),
    initial.replace('agent-map-id: map', 'agent-map-id: another'),
    initial.replace('node-id: card\\n', '')
  ]) {
    const f = await setup();
    await f.app.vault.process(f.files.get(path), () => bad);
    await assert.rejects(() => commitLivingMarkdown(f.repo, request(f)), /target-unavailable/);
    assert.equal(f.contents.get(path), bad);
  }
});

S.integrationTest('Living Node: repeat no-change writes diagnostics only and does not advance content change time', async () => {
  const f = await setup();
  const first = request(f);
  assert.equal(await commitLivingMarkdown(f.repo, first), 'written');
  const before = f.contents.get(path);
  const base = readLivingMarkdown(before);
  const revision = base.revision;
  const second = request(f, { base, proposal: { baseRevision: revision, operations: [] }, candidate: { executionId: 'e2' }, context: { ...context, at: 't2' } });
  assert.equal(await commitLivingMarkdown(f.repo, second), 'written');
  const after = f.contents.get(path);
  assert.equal(after.slice(after.indexOf('# Existing title')), before.slice(before.indexOf('# Existing title')));
  assert.equal(after.match(/living-node-last-content-change: .+/)[0], before.match(/living-node-last-content-change: .+/)[0]);
  assert.ok(after.includes('living-node-last-successful-check: "t2"'));
});

S.integrationTest('Living Node: external edit during inspect is preserved by the real compare-and-write guard', async () => {
  const f = await setup();
  const r = request(f);
  const inspect = r.inspect;
  r.inspect = async () => {
    await f.app.vault.process(f.files.get(path), () => initial + '\nOwner typed this.');
    return inspect();
  };
  assert.equal(await commitLivingMarkdown(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial + '\nOwner typed this.');
});

S.integrationTest('Living Node: cancelled or stale candidate never commits and replay does not duplicate knowledge', async () => {
  const f = await setup();
  const controller = new AbortController();
  const r = request(f, { signal: controller.signal });
  const inspect = r.inspect;
  r.inspect = async () => { controller.abort(); return inspect(); };
  assert.equal(await commitLivingMarkdown(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial);
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const before = f.contents.get(path);
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'discarded');
  assert.equal(f.contents.get(path), before);
});

S.integrationTest('Living Node: manually edited or removed owned region fails closed without overwriting', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const edited = f.contents.get(path).replace('> Current findings', '> Owner revised it');
  await f.app.vault.process(f.files.get(path), () => edited);
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, { candidate: { executionId: 'e2' } })), /base-mismatch/);
  assert.equal(f.contents.get(path), edited);
});

S.integrationTest('Living Node: an empty first proposal is not evidence of a successful no-match', async () => {
  const f = await setup();
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, { proposal: { baseRevision: 'empty', operations: [] } })), /missing-formal-result/);
  assert.equal(f.contents.get(path), initial);
});

S.integrationTest('Living Node: reconstructs persisted knowledge after reload, including corrections and multiline markup', async () => {
  const f = await setup();
  assert.equal(readLivingMarkdown(initial).revision, 'empty');
  const r = request(f, { proposal: { baseRevision: 'empty', operations: [
    { kind: 'output', text: 'Line one\n### heading\n<!-- marker --> & literal &lt;', evidence: ['e1'] },
    { kind: 'append', id: 'r1', subject: 'price', scope: 'daily', granularity: 'day', eventTime: '2026-11-26', claim: '100\n**raw**', evidence: ['e1'] }
  ] } });
  assert.equal(await commitLivingMarkdown(f.repo, r), 'written');
  const base = readLivingMarkdown(f.contents.get(path));
  assert.equal(base.output.text, 'Line one\n### heading\n<!-- marker --> & literal &lt;');
  assert.equal(base.records[0].claim, '100\n**raw**');
  const second = request(f, { base, candidate: { executionId: 'e2' }, proposal: { baseRevision: base.revision, operations: [
    { kind: 'correct', id: 'r1', claim: '105', reason: 'corrected close', evidence: ['e2'] }
  ] }, context: { ...context, evidence: [...context.evidence, { id: 'e2', source: 'https://example.org', retrievedAt: 't2' }] } });
  assert.equal(await commitLivingMarkdown(f.repo, second), 'written');
  const recovered = readLivingMarkdown(f.contents.get(path));
  assert.equal(recovered.records[0].claim, '105');
  assert.equal(recovered.records[0].history[0].claim, '100\n**raw**');
  assert.equal(recovered.records[0].history[0].previousEvidence[0].id, 'e1');
  assert.equal(recovered.records[0].history[0].evidence[0].id, 'e2');
  assert.notEqual(recovered.revision, base.revision);
});

S.integrationTest('Living Node: readback refuses tampered Markdown or ownership instead of silently migrating', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const saved = f.contents.get(path);
  const edited = readLivingMarkdown(saved.replace('> Current findings', '> Manual changes'));
  assert.equal(edited.output.owner, 'user');
  assert.equal(edited.output.text, 'Manual changes');
  assert.throws(() => readLivingMarkdown(saved.replace('<!-- vam-living-node:end v1 -->', '')), /unknown-ownership/);
});

S.integrationTest('Living Node: source text cannot inject managed-region markers', async () => {
  const f = await setup();
  const source = '<!-- vam-living-node:begin v1 -->';
  const r = request(f, { context: { ...context, evidence: [{ id: 'e1', source, retrievedAt: 't1' }] } });
  assert.equal(await commitLivingMarkdown(f.repo, r), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.evidence[0].source, source);
});

const { LivingCoordinator } = S.load('experiences/visual-map/living-node-coordinator.ts');
const { LivingTrial } = S.load('experiences/visual-map/living-node-trial.ts', { obsidian: S.obsidian });
function trialRequest(f, generate, extra = {}) {
  return { ...request(f), generate, stillCurrent: async () => true, ...extra };
}

S.integrationTest('Living Node trial: preview never writes; adoption uses the same guard once without another AI call', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  let calls = 0;
  const r = trialRequest(f, async () => { calls++; return proposal; });
  assert.equal(await trial.run(r), true);
  assert.equal(trial.state, 'ready');
  assert.equal(trial.result.output.text, 'Current findings');
  assert.equal(f.contents.get(path), initial);
  assert.equal(await trial.adopt(f.repo, r), 'written');
  assert.equal(calls, 1);
  assert.equal(trial.state, 'none');
  assert.equal(await trial.adopt(f.repo, r), 'discarded');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.text, 'Current findings');
});

S.integrationTest('Living Node trial: stale source, lock or draft invalidation cannot commit preview', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  const r = trialRequest(f, async () => proposal);
  assert.equal(await trial.run(r), true);
  const oldCheck = r.inspect;
  assert.equal(await trial.adopt(f.repo, { ...r, inspect: async () => ({ ...await oldCheck(), dependenciesReady: false }) }), 'discarded');
  assert.equal(f.contents.get(path), initial);
  assert.equal(await trial.run(r), true);
  trial.invalidate();
  assert.equal(trial.state, 'invalid');
  assert.equal(await trial.adopt(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial);
});

S.integrationTest('Living Node trial: late provider result cannot revive a closed editor', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  let finish;
  const r = trialRequest(f, () => new Promise(resolve => { finish = resolve; }));
  const pending = trial.run(r);
  trial.close();
  finish(proposal);
  assert.equal(await pending, false);
  assert.equal(trial.state, 'none');
  assert.equal(trial.result, undefined);
  assert.equal(f.contents.get(path), initial);
});

S.integrationTest('Living Node trial: exact configuration-only save permits adoption, unrelated changes do not', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  const savedContent = initial + '\n## Prompt\n\nResearch this topic.\n';
  let calls = 0;
  const r = trialRequest(f, async () => { calls++; return proposal; }, { savedContent });
  assert.equal(await trial.run(r), true);
  await f.app.vault.process(f.files.get(path), () => savedContent);
  const check = {
    isCurrent: () => true,
    readSavedContent: async () => f.contents.get(path),
    inspect: async () => ({ ...await r.inspect(), baseRevision: livingSnapshotRevision(f.contents.get(path)) })
  };
  assert.equal(await trial.adopt(f.repo, check), 'written');
  assert.equal(calls, 1);
  assert.ok(f.contents.get(path).includes('Research this topic.'));
  const other = await setup();
  const invalid = new LivingTrial(new LivingCoordinator());
  const next = trialRequest(other, async () => proposal, { savedContent });
  assert.equal(await invalid.run(next), true);
  const edited = savedContent + '\nUnrelated manual edit.';
  await other.app.vault.process(other.files.get(path), () => edited);
  assert.equal(await invalid.adopt(other.repo, { ...next, readSavedContent: async () => edited }), 'discarded');
  assert.equal(other.contents.get(path), edited);
});

S.integrationTest('Living Node: ordinary Repository note edits preserve the managed region byte for byte', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const old = f.contents.get(path);
  const knowledge = readLivingMarkdown(old);
  await f.repo.updateNote(path, { prompt: 'New saved instruction', title: 'New title' });
  const updated = f.contents.get(path);
  assert.equal(readLivingMarkdown(updated).revision, knowledge.revision);
  assert.ok(updated.includes('New saved instruction'));
  assert.equal((updated.match(/vam-living-node:begin/g) ?? []).length, 1);
  await f.repo.writeAiCard(path, false);
  assert.equal(readLivingMarkdown(f.contents.get(path)).revision, knowledge.revision);
});

const { runLivingRound, saveLivingConfig } = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian: S.obsidian });
async function roundFixture() {
  const f = S.fixture();
  const map = S.map([S.node('parent'), S.node('child', 'parent'), S.node('ordinary')]);
  for (const node of map.nodes) {
    const flag = node.id === 'ordinary' ? '' : 'ai-card: true\n';
    const raw = '---\nagent-map-node: true\nagent-map-id: map\ntopic-id: map\nnode-id: ' + node.id + '\n' + flag +
      '---\n# ' + node.id + '\n\n## Prompt\n\nResearch ' + node.id + '\n\n## Detail\n\nManual ' + node.id + '\n';
    await f.app.vault.create(node.path, raw);
  }
  f.repo.readMap = async () => map;
  const calls = [];
  let beforeReply = async () => {};
  const port = {
    app: f.app, repo: f.repo, mapPath: 'Map.md', viewSession: 'view', signal: new AbortController().signal,
    coordinator: new LivingCoordinator(), current: () => true, busy: () => false, language: () => 'English',
    mapSources: async () => [], confirm: async (_model, run) => { await run(); return true; },
    onStart() {}, onRunning() {}, onSettled() {}, onFailure() {},
    calls: { run: async (prepared, options, finish) => {
      calls.push(prepared.input.prompt);
      await beforeReply(prepared.input.prompt);
      const text = 'Result: ' + prepared.input.prompt;
      const operations = prepared.input.base.output.text === text ? [] : [{ kind: 'output', text, evidence: [] }];
      return finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations }),
        { signal: options.signal, parsed() {} });
    } }
  };
  return { ...f, map, port, calls, beforeReply: callback => { beforeReply = callback; } };
}

S.integrationTest('Living Node formal round: actual Repository writes in dependency order and reuses a valid upstream for Run Card', async () => {
  const f = await roundFixture();
  const first = await runLivingRound(f.port);
  assert.equal(first.get('child'), 'changed');
  assert.equal(first.get('parent'), 'changed');
  assert.deepEqual(f.calls, ['Research child', 'Research parent']);
  assert.ok(f.contents.get('parent.md').includes('Manual parent'));
  assert.equal(readLivingMarkdown(f.contents.get('ordinary.md')).revision, 'empty');
  const revision = readLivingMarkdown(f.contents.get('child.md')).revision;
  const second = await runLivingRound(f.port, ['parent']);
  assert.equal(second.get('child'), 'reused');
  assert.equal(second.get('parent'), 'no-change');
  assert.deepEqual(f.calls, ['Research child', 'Research parent', 'Research parent']);
  assert.equal(readLivingMarkdown(f.contents.get('child.md')).revision, revision);
});

S.integrationTest('Living Node formal round: a target changed while its provider is running is not written; dependent branch is blocked', async () => {
  const f = await roundFixture();
  f.beforeReply(async prompt => {
    if (prompt === 'Research child') {
      await f.app.vault.process(f.files.get('child.md'), text => text + '\nOwner edited the card.\n');
    }
  });
  const result = await runLivingRound(f.port);
  assert.equal(result.get('child'), 'failed');
  assert.equal(result.get('parent'), 'blocked');
  assert.deepEqual(f.calls, ['Research child']);
  assert.ok(f.contents.get('child.md').includes('Owner edited the card.'));
  assert.equal(readLivingMarkdown(f.contents.get('child.md')).revision, 'empty');
});

S.integrationTest('Living Node config command: stable same-map source ID, self and cycle rejection, no execution on save', async () => {
  const f = await roundFixture();
  await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read child\n\nSources: [[child]]');
  assert.ok(f.contents.get('parent.md').includes('card:child'));
  const before = f.contents.get('child.md');
  await assert.rejects(() => saveLivingConfig(f.app, f.repo, f.map, 'child', 'Cycle\n\nSources: [[parent]]'), /living-node-cycle/);
  await assert.rejects(() => saveLivingConfig(f.app, f.repo, f.map, 'child', 'Self\n\nSources: [[child]]'), /self-reference/);
  assert.equal(f.contents.get('child.md'), before);
  assert.deepEqual(f.calls, []);
});

S.integrationTest('Living Node config: invalidated editor or chat lease refuses the queued write and preserves bytes', async () => {
  const f = await roundFixture();
  const before = f.contents.get('parent.md');
  let current = true;
  const write = f.repo.updateNoteGuarded.bind(f.repo);
  f.repo.updateNoteGuarded = async (...args) => {
    current = false;
    return write(...args);
  };
  await assert.rejects(
    () => saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Changed prompt', undefined, undefined, () => current),
    /changed-configuration/
  );
  assert.equal(f.contents.get('parent.md'), before);
  assert.deepEqual(f.calls, []);
});

S.integrationTest('Living Node config: revision includes persisted references even if prompt text is unchanged', async () => {
  const f = await roundFixture();
  const saved = await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read child\n\nSources: [[child]]');
  await f.app.vault.process(f.files.get('parent.md'), text => text.replace('card:child', 'card:ordinary'));
  const edited = f.contents.get('parent.md');
  await assert.rejects(
    () => saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Updated prompt', 'Read child\n\nSources: [[child]]', saved.configRevision),
    /changed-configuration/
  );
  assert.equal(f.contents.get('parent.md'), edited);
  assert.deepEqual(f.calls, []);
});

S.integrationTest('Living Node ownership: protect an edited output and append an unrelated observation without restoring deleted text', async () => {
  const f = await setup();
  const first = request(f, { proposal: { baseRevision: 'empty', operations: [
    { kind: 'output', text: 'Current findings', evidence: ['e1'] },
    { kind: 'append', id: 'r1', subject: 'price', scope: 'daily', granularity: 'day', eventTime: '2026-11-26', claim: 'Old deleted text', evidence: ['e1'] }
  ] } });
  assert.equal(await commitLivingMarkdown(f.repo, first), 'written');
  const saved = f.contents.get(path);
  const edited = saved.replace('> Current findings', '> User-owned output').replace(/\n### Observation\n[\s\S]*?(?=\n### Suppression)/, '');
  await f.app.vault.process(f.files.get(path), () => edited);
  const base = readLivingMarkdown(edited);
  assert.equal(base.output.owner, 'user');
  assert.equal(base.records.length, 0);
  assert.deepEqual(S.plain(base.suppressed), ['r1']);
  const append = { kind: 'append', id: 'r2', subject: 'price', scope: 'daily', granularity: 'day', eventTime: '2026-11-27', claim: 'New information', evidence: ['e1'] };
  const req = request(f, { base, candidate: { executionId: 'e2' }, proposal: { baseRevision: base.revision, operations: [append] } });
  assert.equal(await commitLivingMarkdown(f.repo, req), 'written');
  const after = f.contents.get(path);
  assert.ok(after.includes('User-owned output'));
  assert.ok(after.includes('New information'));
  assert.equal(after.includes('Old deleted text'), false);
  const recovered = readLivingMarkdown(after);
  assert.equal(recovered.output.owner, 'user');
  assert.deepEqual(S.plain(recovered.suppressed), ['r1']);
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, { base: recovered, candidate: { executionId: 'e3' }, proposal: { baseRevision: recovered.revision, operations: [{ ...append, id: 'r1' }] } })), /suppressed-record/);
});

S.integrationTest('Living Node trial: rejected adoption lease consumes the candidate without cancelling the competing operation', async () => {
  const f = await setup();
  const coordinator = new LivingCoordinator();
  const trial = new LivingTrial(coordinator);
  const r = trialRequest(f, async () => proposal);
  assert.equal(await trial.run(r), true);
  const competing = coordinator.acquire('map', 'v2', [path], true);
  assert.ok(competing);
  assert.equal(await trial.adopt(f.repo, r), 'discarded');
  assert.equal(trial.state, 'invalid');
  assert.equal(trial.result.output.text, 'Current findings');
  assert.equal(competing.current(), true);
  competing.release();
  assert.equal(await trial.adopt(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial);
});

function livingReaderFixture() {
  class MarkdownView { constructor(file) { this.file = file; this.containerEl = { isShown: () => true }; } }
  class Reader {
    constructor() { this.containerEl = { isShown: () => true }; }
    owns(owner) { return this.owner === owner; }
    async show(file, preview, owner) { this.file = file; this.preview = preview; this.owner = owner; }
    markInvalid(owner) { if (this.owns(owner)) this.invalid = true; }
  }
  const { NodeDetailsSidebar } = S.load('experiences/visual-map/node-details-sidebar.ts',
    { obsidian: { ...S.obsidian, MarkdownView, View: class {} }, './living-node-reader': { LivingReaderView: Reader, LIVING_READER_VIEW: 'reader' } },
    {}, { external: ['obsidian', 'node:*', './living-node-reader'] });
  const split = { collapsed: false };
  const calls = [];
  const leaf = {
    view: new MarkdownView(null), getRoot: () => split,
    async openFile(file) { calls.push(['official', file.path]); this.view = new MarkdownView(file); },
    async setViewState() { calls.push(['reader']); if (this.waitForReader) await this.waitForReader; this.view = new Reader(); },
    detach() { calls.push(['detach']); }
  };
  const workspace = {
    rightSplit: split, getLeavesOfType: () => leaf.view instanceof MarkdownView ? [leaf] : [],
    getRightLeaf: () => leaf, async revealLeaf() {}, trigger() {}, getActiveViewOfType: () => null
  };
  const app = { workspace, metadataCache: { getFileCache: () => ({ frontmatter: { 'agent-map-node': true } }) } };
  return { sidebar: new NodeDetailsSidebar(() => app, () => {}), leaf, calls, Reader, MarkdownView };
}

S.integrationTest('Living Node reader: a late preview and close from an older editor cannot replace a newer selection', async () => {
  const { sidebar, leaf, calls, MarkdownView } = livingReaderFixture();
  const a = new S.TFile('a.md'), b = new S.TFile('b.md');
  await sidebar.openDetails(a, 'editor-a');
  const gate = S.deferred();
  leaf.waitForReader = gate.promise;
  const preview = sidebar.showLivingTrial(a, 'old preview', 'editor-a', () => true);
  await S.until(() => calls.some(call => call[0] === 'reader'));
  const next = sidebar.openDetails(b, 'editor-b');
  gate.resolve();
  assert.equal(await preview, false);
  await next;
  assert.ok(leaf.view instanceof MarkdownView);
  assert.equal(leaf.view.file.path, 'b.md');
  await sidebar.restoreLivingOfficial(a, 'editor-a', true);
  sidebar.invalidateLivingTrial('editor-a');
  assert.equal(leaf.view.file.path, 'b.md');
});

S.integrationTest('Living Node reader: stopping during reader creation restores official content and does not poison another trial', async () => {
  const { sidebar, leaf, calls, MarkdownView, Reader } = livingReaderFixture();
  const a = new S.TFile('a.md');
  await sidebar.openDetails(a, 'editor-a');
  const gate = S.deferred();
  leaf.waitForReader = gate.promise;
  let current = true;
  const preview = sidebar.showLivingTrial(a, 'cancelled preview', 'editor-a', () => current);
  await S.until(() => calls.some(call => call[0] === 'reader'));
  current = false;
  gate.resolve();
  assert.equal(await preview, false);
  assert.ok(leaf.view instanceof MarkdownView);
  assert.equal(leaf.view.file.path, 'a.md');
  assert.equal(await sidebar.showLivingTrial(a, 'fresh preview', 'editor-a', () => true), true);
  assert.ok(leaf.view instanceof Reader);
  assert.equal(leaf.view.preview, 'fresh preview');
  sidebar.invalidateLivingTrial('unrelated-editor');
  assert.equal(leaf.view.invalid, undefined);
  sidebar.invalidateLivingTrial('editor-a');
  assert.equal(leaf.view.invalid, true);
  await sidebar.restoreLivingOfficial(undefined, 'editor-a', true);
  assert.deepEqual(calls.at(-1), ['detach']);
});

function livingTrialRuntimeFixture({ locked = false, usable = true, mapSources = async () => [] } = {}) {
  const { prepareLivingTrial } = S.load('experiences/visual-map/living-node-runtime.ts',
    { obsidian: S.obsidian, './living-node-provider': { generateLivingProposal() { throw new Error('unexpected AI call'); } } },
    {}, { external: ['obsidian', 'node:*', './living-node-provider'] });
  const map = { id: 'map', nodes: [
    { id: 'root', path: 'root.md', parentId: null },
    { id: 'up', path: 'up.md', parentId: 'root' }
  ] };
  const snapshots = new Map([
    ['root.md', { note: { title: 'Root', prompt: 'Research root', aiCard: true, model: 'model-a' },
      content: '---\nagent-map-id: map\ntopic-id: map\nnode-id: root\nai-card: true\nliving-node-refs: []\n---\n# Root\n' }],
    ['up.md', { note: { title: 'Up', prompt: 'Research up\nSources: [[missing]]', aiCard: true,
      aiLocked: locked, model: 'model-a', summary: usable ? 'Existing findings' : '', aiRun: usable ? { result: 'ok' } : undefined },
      content: '---\nagent-map-id: map\ntopic-id: map\nnode-id: up\nai-card: true\nliving-node-refs:\n  - "note:missing"\n---\n# Up\n' }]
  ]);
  const port = { repo: { readMap: async () => map, readNoteSnapshot: async path => snapshots.get(path) },
    app: { metadataCache: { getFirstLinkpathDest: () => null } }, calls: {}, mapPath: 'Map.md',
    viewSession: 'editor', signal: new AbortController().signal, current: () => true, language: () => 'en',
    mapSources };
  return { prepare: () => prepareLivingTrial(port, 'root', 'Research root'), snapshots, map, port };
}

S.integrationTest('Living Node trial: stale readable upstream may preview but cannot adopt until formal dependencies are ready', async () => {
  const { prepare } = livingTrialRuntimeFixture();
  const prepared = await prepare();
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.warnings)), ['upstream-stale']);
  assert.equal(await prepared.request.stillCurrent(), true);
  await assert.rejects(() => prepared.adoption.inspect(), /required-dependency-blocked/);
});

S.integrationTest('Living Node trial: unreadable upstream blocks even read-only preview', async () => {
  const { prepare } = livingTrialRuntimeFixture({ usable: false });
  await assert.rejects(prepare, /missing-ai-knowledge/);
});

S.integrationTest('Living Node trial: a readable locked dependency is a disclosed frozen boundary and does not block adoption', async () => {
  const { prepare } = livingTrialRuntimeFixture({ locked: true });
  const prepared = await prepare();
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.warnings)), ['frozen-source']);
  assert.equal((await prepared.adoption.inspect()).dependenciesReady, true);
});

S.integrationTest('Living Node copy: copied formal knowledge keeps ownership and resets the new card diagnostics', async () => {
  const f = await setup();
  const withLinks = { ...proposal, operations: [{ kind: 'output', text: 'Findings from [[Source]]', evidence: ['e1'] }] };
  assert.equal(await commitLivingMarkdown(f.repo, request(f, { proposal: withLinks })), 'written');
  const source = f.contents.get(path);
  const mapPath = 'Agent Workspace/Topics/map/Map.md';
  const map = { id: 'map', title: 'Map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const copy = await f.repo.duplicateNote(path, map, mapPath, { keepTitle: true });
  await f.repo.rewriteCopiedNoteLinks([{ from: path, to: copy.path }]);
  const copied = f.contents.get(copy.path);
  const fm = S.obsidian.parseYaml(copied.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  assert.equal(fm['node-id'], copy.id);
  assert.notEqual(copy.id, 'card');
  assert.equal(fm['topic-id'], 'map');
  for (const key of ['living-node-last-execution', 'living-node-last-successful-check', 'living-node-last-attempt',
    'living-node-last-content-change', 'living-node-outcome', 'living-node-input-revision', 'living-node-success-knowledge'])
    assert.equal(fm[key], undefined, key);
  assert.equal(readLivingMarkdown(copied).output.text, 'Findings from [[Source]]');
  assert.equal(readLivingMarkdown(copied).output.owner, 'ai');
  assert.equal(readLivingMarkdown(copied).revision, readLivingMarkdown(source).revision);
  assert.equal(f.contents.get(path), source);
});

S.integrationTest('Living Node copy: internal card IDs follow copies, same-map external IDs survive, foreign IDs stay missing', async () => {
  for (const destination of ['map', 'other-map']) {
    const f = await setup();
    const source = initial.replace('custom-key: keep', 'living-node-refs:\n  - "card:up"\n  - "card:external"\ncustom-key: keep');
    await f.app.vault.process(f.files.get(path), () => source);
    const upPath = 'up.md';
    await f.app.vault.create(upPath, initial.replace('node-id: card', 'node-id: up').replace('# Existing title', '# Up'));
    const map = { id: destination, title: destination, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const mapPath = 'Agent Workspace/Topics/' + destination + '/Map.md';
    const rootCopy = await f.repo.duplicateNote(path, map, mapPath);
    const upCopy = await f.repo.duplicateNote(upPath, map, mapPath);
    await f.repo.rewriteCopiedNoteLinks([{ from: path, to: rootCopy.path }, { from: upPath, to: upCopy.path }]);
    const fm = S.obsidian.parseYaml(f.contents.get(rootCopy.path).match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
    assert.deepEqual(fm['living-node-refs'], ['card:' + upCopy.id, destination === 'map' ? 'card:external' : 'card:foreign:' + JSON.stringify(['map', 'external'])]);
    assert.equal(f.contents.get(path), source);
  }
});

S.integrationTest('Living Node trial: optional map source failure is disclosed, unlike a genuinely empty map context', async () => {
  for (const mapSources of [
    async () => ({ groups: [], unavailable: 1 }),
    async () => { throw new Error('optional folder unavailable'); }
  ]) {
    const { prepare } = livingTrialRuntimeFixture({ locked: true, mapSources });
    const prepared = await prepare();
    assert.deepEqual(JSON.parse(JSON.stringify(prepared.warnings)), ['frozen-source', 'map-source-unavailable']);
    assert.equal((await prepared.adoption.inspect()).dependenciesReady, true);
  }
  const { prepare } = livingTrialRuntimeFixture({ locked: true });
  assert.deepEqual(JSON.parse(JSON.stringify((await prepare()).warnings)), ['frozen-source']);
});

S.integrationTest('Living Node structure: a new parent edge is rejected before Map.md publication', async () => {
  const { map, port, snapshots } = livingTrialRuntimeFixture();
  snapshots.get('root.md').note.prompt = 'Root';
  snapshots.get('up.md').note.prompt = 'Up';
  snapshots.get('up.md').content = snapshots.get('up.md').content.replace('note:missing', 'card:root');
  const before = { ...map, nodes: map.nodes.map(n => ({ ...n, parentId: null })) };
  const { validateLivingStructure } = S.load('experiences/visual-map/living-node-runtime.ts',
    { obsidian: S.obsidian, './living-node-provider': {} }, {}, { external: ['obsidian', 'node:*', './living-node-provider'] });
  await assert.rejects(() => validateLivingStructure(port.app, port.repo, before, map), /living-node-cycle/);
  await validateLivingStructure(port.app, port.repo, map, before);
});

S.integrationTest('Living Node removal: surviving explicit consumers are identified without removing persisted references', async () => {
  const { map, port, snapshots } = livingTrialRuntimeFixture();
  const raw = snapshots.get('root.md').content.replace('living-node-refs: []', 'living-node-refs:\n  - "card:up"');
  snapshots.get('root.md').content = raw;
  const { livingRemovalConsumers } = S.load('experiences/visual-map/living-node-runtime.ts',
    { obsidian: S.obsidian, './living-node-provider': {} }, {}, { external: ['obsidian', 'node:*', './living-node-provider'] });
  const affected = await livingRemovalConsumers(port.app, port.repo, map, new Set(['up']));
  assert.deepEqual(JSON.parse(JSON.stringify(affected)), ['root']);
  assert.equal(snapshots.get('root.md').content, raw);
  assert.equal((await livingRemovalConsumers(port.app, port.repo, map, new Set(['root', 'up']))).length, 0);
});

S.integrationTest('Living Node configuration authorizes the actual resolved source path before any write', async () => {
  const f = await roundFixture();
  const before = f.contents.get('parent.md');
  const checked = [];
  await assert.rejects(
    () => saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read child\n\nSources: [[child]]',
      undefined, undefined, () => true, path => { checked.push(path); return false; }),
    /unauthorized-source/
  );
  assert.deepEqual(checked, ['child.md']);
  assert.equal(f.contents.get('parent.md'), before);
  assert.deepEqual(f.calls, []);
});
