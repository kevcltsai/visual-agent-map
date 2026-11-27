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

S.integrationTest('Living Node write boundary: unsupported AI writers cannot overwrite even flag-only cards; manual and formal writes remain possible', async () => {
  const f = await setup();
  const before = f.contents.get(path);
  for (const options of [{ rejectAiCard: true }, { newVisualReferences: true }]) {
    await assert.rejects(() => f.repo.updateNoteGuarded(path, { detail: 'Unsupported AI rewrite' }, options));
    assert.equal(f.contents.get(path), before);
  }
  let invoked = false;
  await assert.rejects(() => f.repo.updateNoteRawGuarded(path, () => { invoked = true; return 'Unsupported raw rewrite'; }, { rejectAiCard: true }));
  assert.equal(invoked, false);
  assert.equal(f.contents.get(path), before);
  assert.equal(await f.repo.updateNoteGuarded(path, { detail: 'Owner edited legacy detail' }), 'written');
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.text, 'Current findings');
  await f.repo.writeAiCard(path, false);
  assert.equal(await f.repo.updateNoteGuarded(path, { detail: 'Ordinary research' }, { rejectAiCard: true }), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.text, 'Current findings');
});

S.integrationTest('Living Node write boundary: card activation after an AI writer reads its base discards the stale candidate', async () => {
  const f = await setup();
  await f.repo.writeAiCard(path, false);
  const old = f.contents.get(path);
  await f.repo.writeAiCard(path, true);
  const active = f.contents.get(path);
  assert.equal(await f.repo.updateNoteGuarded(path, { summary: 'Late AI' }, { expectedContent: old, rejectAiCard: true }), 'discarded');
  assert.equal(await f.repo.updateNoteRawGuarded(path, () => 'Late raw AI', { expectedContent: old, rejectAiCard: true }), 'discarded');
  assert.equal(f.contents.get(path), active);
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
    initial.replace('node-id: card\n', '')
  ]) {
    assert.notEqual(bad, initial, 'identity corruption fixture must change the original');
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

S.integrationTest('Living Node migration: legacy fresh and run stamps remain readable and untouched until explicit formal commit', async () => {
  const f = await setup();
  const legacy = initial.replace('custom-key: keep', 'custom-key: keep\nai-update-mode: fresh\nai-run-at: "2026-11-26T12:00:00Z"\nai-run-result: ok\nai-run-input: old-revision');
  await f.app.vault.process(f.files.get(path), () => legacy);
  assert.equal(readLivingMarkdown(legacy).revision, 'empty');
  await f.repo.readNote(path);
  assert.equal(f.contents.get(path), legacy);
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const after = f.contents.get(path);
  for (const key of ['custom-key: keep', 'ai-update-mode: fresh', 'ai-run-result: ok', 'ai-run-input: old-revision', 'Manual notes, never replace.'])
    assert.ok(after.includes(key), key);
  assert.equal(readLivingMarkdown(after).output.text, 'Current findings');
});

S.integrationTest('Living Node recovery: orphaned successful diagnostics cannot turn lost knowledge into a fresh card', async () => {
  for (const key of ['living-node-last-execution', 'living-node-success-knowledge', 'living-node-last-successful-check', 'living-node-last-content-change', 'living-node-outcome']) {
    const f = await setup();
    const damaged = initial.replace('custom-key: keep', 'custom-key: keep\n' + key + (key === 'living-node-outcome' ? ': ok' : ': "old"'));
    await f.app.vault.process(f.files.get(path), () => damaged);
    assert.throws(() => readLivingMarkdown(damaged), /unknown-ownership/);
    await assert.rejects(() => commitLivingMarkdown(f.repo, request(f)), /unknown-ownership/);
    assert.equal(f.contents.get(path), damaged);
    const note = await f.repo.readNote(path);
    assert.equal(note.livingNode.damaged, true);
    const map = { id: 'map', title: 'Map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await assert.rejects(() => f.repo.duplicateNote(path, map, 'Agent Workspace/Topics/map/Map.md'), /unknown-ownership/);
    await f.repo.writeAiCard(path, false);
    assert.equal((await f.repo.readNote(path)).livingNode.damaged, true);
    await assert.rejects(() => f.repo.duplicateNote(path, map, 'Agent Workspace/Topics/map/Map.md'), /unknown-ownership/);
  }
});

S.integrationTest('Living Node recovery: a failed first attempt is not an orphaned successful commit', async () => {
  const f = await setup();
  const failed = initial.replace('custom-key: keep', 'custom-key: keep\nliving-node-outcome: failed\nliving-node-last-attempt: "old"');
  await f.app.vault.process(f.files.get(path), () => failed);
  assert.equal(readLivingMarkdown(failed).revision, 'empty');
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.text, 'Current findings');
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

S.integrationTest('Living Node: explicit no-match is persisted, but clearing it cannot produce a new successful check or adoptable trial', async () => {
  const f = await setup();
  const noMatch = { baseRevision: 'empty', operations: [{ kind: 'output', text: 'No matching observations found.', evidence: ['e1'] }] };
  assert.equal(await commitLivingMarkdown(f.repo, request(f, { proposal: noMatch })), 'written');
  const committed = f.contents.get(path);
  assert.equal(readLivingMarkdown(committed).output.text, 'No matching observations found.');
  const edited = committed.replace('> No matching observations found.', '> ');
  await f.app.vault.process(f.files.get(path), () => edited);
  const base = readLivingMarkdown(edited);
  assert.notEqual(base.revision, 'empty');
  assert.equal(base.output.owner, 'user');
  assert.equal(base.output.text, '');
  const emptyProposal = { baseRevision: base.revision, operations: [] };
  const retry = { base, proposal: emptyProposal, candidate: { executionId: 'e2' } };
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, retry)), /missing-formal-result/);
  const trial = new LivingTrial(new LivingCoordinator());
  assert.equal(await trial.run(trialRequest(f, async () => emptyProposal, request(f, retry))), false);
  assert.equal(trial.state, 'error');
  assert.equal(f.contents.get(path), edited);
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

S.integrationTest('Living Node trial: adoption check keeps its own receiver when the commit inspects', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  const r = trialRequest(f, async () => proposal);
  assert.equal(await trial.run(r), true);
  const base = r.inspect;
  const check = { inspected: 0, isCurrent: () => true, async inspect() { this.inspected++; return base(); } };
  assert.equal(await trial.adopt(f.repo, check), 'written');
  assert.ok(check.inspected > 0);
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

S.integrationTest('Living Node recovery: blocked round cannot erase the only surviving successful diagnostic', async () => {
  const f = await roundFixture();
  const child = f.contents.get('child.md').replace('ai-card: true\n', 'ai-card: true\nliving-node-outcome: ok\n');
  await f.app.vault.process(f.files.get('child.md'), () => child);
  const results = await runLivingRound(f.port);
  assert.equal(results.get('child'), 'blocked');
  assert.equal(results.get('parent'), 'blocked');
  assert.deepEqual(f.calls, []);
  assert.equal(f.contents.get('child.md'), child);
  assert.throws(() => readLivingMarkdown(child), /unknown-ownership/);
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
  assert.equal(base.suppressed[0], 'r1');
  assert.equal(base.suppressed.length, 2);
  assert.match(base.suppressed[1], /^@event:[a-f0-9]{64}:[a-f0-9]{64}:k:r1$/);
  const append = { kind: 'append', id: 'r2', subject: 'price', scope: 'daily', granularity: 'day', eventTime: '2026-11-27', claim: 'New information', evidence: ['e1'] };
  const req = request(f, { base, candidate: { executionId: 'e2' }, proposal: { baseRevision: base.revision, operations: [append] } });
  assert.equal(await commitLivingMarkdown(f.repo, req), 'written');
  const after = f.contents.get(path);
  assert.ok(after.includes('User-owned output'));
  assert.ok(after.includes('New information'));
  assert.equal(after.includes('Old deleted text'), false);
  const alias = { ...append, id: 'alias-id', eventTime: '2026-11-26', claim: 'Reworded observation' };
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, { base: readLivingMarkdown(after), candidate: { executionId: 'alias' }, proposal: { baseRevision: readLivingMarkdown(after).revision, operations: [alias] } })), /suppressed-record/);
  assert.equal(f.contents.get(path), after);
  const recovered = readLivingMarkdown(after);
  assert.equal(recovered.output.owner, 'user');
  assert.deepEqual(S.plain(recovered.suppressed), S.plain(base.suppressed));
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

function livingTrialRuntimeFixture({ locked = false, usable = true, mapSources = async () => [], generate = () => { throw new Error('unexpected AI call'); } } = {}) {
  const { prepareLivingTrial } = S.load('experiences/visual-map/living-node-runtime.ts',
    { obsidian: S.obsidian, './living-node-provider': { generateLivingProposal: (...args) => generate(...args) } },
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
    app: { vault: { configDir: '.obsidian' }, metadataCache: { getFirstLinkpathDest: () => null } }, calls: {}, mapPath: 'Map.md',
    viewSession: 'editor', signal: new AbortController().signal, current: () => true, language: () => 'en',
    mapSources };
  return { prepare: (prompt = 'Research root') => prepareLivingTrial(port, 'root', prompt), snapshots, map, port };
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

S.integrationTest('Living Node trial: legacy success metadata and title without knowledge do not authorize a locked upstream', async () => {
  const { prepare, snapshots } = livingTrialRuntimeFixture({ locked: true });
  snapshots.get('up.md').note.summary = '   ';
  await assert.rejects(prepare, /required-dependency-blocked/);
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

S.integrationTest('Living Node removal: a consumer with corrupt managed knowledge still reports its explicit card reference', async () => {
  const { map, port, snapshots } = livingTrialRuntimeFixture();
  const raw = snapshots.get('root.md').content.replace('living-node-refs: []', 'living-node-refs:\n  - "card:up"');
  snapshots.get('root.md').content = raw + '<!-- vam-living-node:begin v1 -->\n<!-- vam-living-node:begin v1 -->\n<!-- vam-living-node:end v1 -->\n';
  const { livingRemovalConsumers } = S.load('experiences/visual-map/living-node-runtime.ts',
    { obsidian: S.obsidian, './living-node-provider': {} }, {}, { external: ['obsidian', 'node:*', './living-node-provider'] });
  const affected = await livingRemovalConsumers(port.app, port.repo, map, new Set(['up']));
  assert.deepEqual(JSON.parse(JSON.stringify(affected)), ['root']);
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

S.integrationTest('Living Node configuration redo refuses a display alias that resolves to a different source', async () => {
  const f = await roundFixture();
  const prompt = 'Read a source\n\nSources: [[alias]]';
  const original = f.contents.get('parent.md');
  let target = 'child.md';
  const lookup = f.app.metadataCache.getFirstLinkpathDest;
  f.app.metadataCache.getFirstLinkpathDest = (link, from) =>
    link === 'alias' ? f.files.get(target) : lookup(link, from);
  const saved = await saveLivingConfig(f.app, f.repo, f.map, 'parent', prompt);
  await f.app.vault.process(f.files.get('parent.md'), () => original);
  target = 'ordinary.md';
  await assert.rejects(
    () => saveLivingConfig(f.app, f.repo, f.map, 'parent', prompt, undefined, undefined,
      () => true, undefined, saved.sourceRevision),
    /changed-source-identity/
  );
  assert.equal(f.contents.get('parent.md'), original);
  assert.deepEqual(f.calls, []);
});

S.integrationTest('Living Node share projection exposes only committed readable knowledge', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const { renderLivingShareKnowledge } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
  const { shareNoteMarkdown, isManagedShareEmbed } = S.load('experiences/sharing/share-embeds.ts');
  const knowledge = readLivingMarkdown(f.contents.get(path));
  const projected = renderLivingShareKnowledge(knowledge);
  assert.equal(projected, '> Current findings');
  const shared = shareNoteMarkdown({ detail: 'Manual detail', prompt: 'Private prompt', livingNode: { shareMarkdown: projected } });
  assert.equal(shared, 'Manual detail\n\n> Current findings');
  assert.ok(!shared.includes('Private prompt'));
  assert.ok(!shared.includes('https://example.com'));
  assert.ok(isManagedShareEmbed(f.contents.get(path)));
  assert.ok(isManagedShareEmbed('---\n"ai-card": true\n---\n## Prompt\nPrivate'));
  assert.ok(isManagedShareEmbed('<!-- vam-living-node:begin -->'));
  assert.ok(!isManagedShareEmbed('---\ntags: public\n---\n# Ordinary note'));
});


S.integrationTest('Living Node cross-map cut preserves referenced ordinary inputs and identifies consumers', async () => {
  const f = await roundFixture();
  await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read ordinary\n\nSources: [[ordinary]]');
  const { livingCrossCut } = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian: S.obsidian });
  const destination = { ...f.map, id: 'other', nodes: [] };
  const result = await livingCrossCut(f.app, f.repo, f.map, destination, new Set(['ordinary']));
  assert.equal(result.preserveIdentity, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.affected)), ['parent']);
  await assert.rejects(
    () => livingCrossCut(f.app, f.repo, f.map, { ...destination, nodes: [S.node('ordinary')] }, new Set(['ordinary'])),
    /ambiguous-card-identity/
  );
  assert.deepEqual(f.calls, []);
});


S.integrationTest('Living Node config: external file path is canonical, follows rename and never falls back to an alias', async () => {
  const f = await roundFixture();
  await f.app.vault.create('Source.md', '# Source\nKnowledge');
  const prompt = 'Read source\n\nSources: [[Source]], [[Source.md]]';
  await saveLivingConfig(f.app, f.repo, f.map, 'parent', prompt);
  const raw = f.contents.get('parent.md');
  const metadata = text => S.obsidian.parseYaml(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  assert.deepEqual(metadata(raw)['living-node-refs'], ['note-path:Source.md', 'note-path:Source.md']);
  await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read source\n\nSources: [[Source]]');
  assert.deepEqual(metadata(f.contents.get('parent.md'))['living-node-refs'], ['note-path:Source.md']);
  await f.repo.moveExact('Source.md', 'Renamed.md');
  assert.deepEqual(metadata(f.contents.get('parent.md'))['living-node-refs'], ['note-path:Renamed.md']);
  const saved = await f.repo.readNote('parent.md');
  await f.app.vault.rename(f.files.get('Renamed.md'), 'Untracked.md');
  await f.app.vault.create('Source.md', '# Different source');
  await assert.rejects(() => saveLivingConfig(f.app, f.repo, f.map, 'parent', saved.prompt), /invalid-source/);
  assert.deepEqual(f.calls, []);
});

S.integrationTest('Living Node config: a resolved note in the vault configuration directory is refused', async () => {
  const f = await roundFixture();
  f.app.vault.configDir = '.settings';
  await f.app.vault.create('.settings/Private.md', '# Private\nNot a research source');
  const before = f.contents.get('parent.md');
  await assert.rejects(
    () => saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read source\n\nSources: [[.settings/Private]]'),
    /missing-source/
  );
  assert.equal(f.contents.get('parent.md'), before);
  assert.deepEqual(f.calls, []);
});

S.integrationTest('Living Node share: only verified public web evidence is exported', () => {
  const { renderLivingShareKnowledge } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
  const evidence = source => ({ id: 'web:' + livingSnapshotRevision(source), source, retrievedAt: '2026-11-27' });
  const knowledge = { ...empty(), output: { owner: 'ai', text: 'Formal result', evidence: [
    evidence('https://example.com/article'),
    evidence('https://example.com/article?token=secret'),
    evidence('http://localhost/private'),
    { id: 'note:private', source: 'https://example.com/private', retrievedAt: 'today' },
    { id: 'web:wrong', source: 'https://example.com/unverified', retrievedAt: 'today' }
  ] } };
  const shared = renderLivingShareKnowledge(knowledge);
  assert.match(shared, /https:\/\/example\.com\/article/);
  assert.doesNotMatch(shared, /secret|localhost|private|unverified|web:/);
});

const { normalizeLivingProposal, explicitlyRequiresLivingWeb, livingWebPolicy, generateLivingProposal } = S.load('experiences/visual-map/living-node-provider.ts', { obsidian: S.obsidian });
S.integrationTest('Living Node web: actual checked source is required even for no-change, and current answer must cite it', async () => {
  const url = 'https://example.com/current';
  const other = 'https://example.com/other';
  const envelope = { baseRevision: 'base', requiresWeb: true, checkedWeb: [url], operations: [] };
  const normalize = (raw, opened = [url, other], required = false) => normalizeLivingProposal(raw, opened, [], 't1', required);
  assert.equal(explicitlyRequiresLivingWeb('搜尋最新股價'), true);
  assert.equal(explicitlyRequiresLivingWeb('Search the web for news'), true);
  assert.equal(explicitlyRequiresLivingWeb('Summarize today’s local notes'), false);
  assert.equal(explicitlyRequiresLivingWeb('不要上網，只用本地筆記分析最新股價'), false);
  assert.deepEqual(S.plain(normalize(envelope).proposal.operations), []);
  assert.throws(() => normalize(envelope, []), /required-web-unavailable/);
  assert.throws(() => normalize({ ...envelope, requiresWeb: false, checkedWeb: [] }, [url], true), /required-web-decision-conflict/);
  assert.throws(() => normalize({ ...envelope, checkedWeb: [] }), /required-web-check-missing/);
  assert.throws(() => normalize({ ...envelope, checkedWeb: ['https://example.com/not-opened'] }), /unauthorized-web-check/);
  const op = { kind: 'output', text: 'Current result', evidence: [url] };
  const proposal = normalize({ ...envelope, operations: [op] });
  assert.equal(proposal.proposal.operations[0].evidence[0], proposal.context.evidence[0].id);
  assert.throws(() => normalize({ ...envelope, operations: [{ ...op, evidence: [] }] }), /required-web-evidence-missing/);
  assert.throws(() => normalize({ ...envelope, operations: [{ ...op, evidence: [other] }] }), /required-web-evidence-missing/);
  assert.throws(() => normalize({ ...envelope, operations: [{ kind: 'supplement', id: 'r1', evidence: [url] }, { ...op, evidence: [] }] }), /required-web-output-evidence-missing/);
});

S.integrationTest('Living Node web: forbidden policy disables the tool at dispatch and refuses unexpected web proof', async () => {
  assert.equal(livingWebPolicy('只用本地筆記分析今日資訊'), 'forbidden');
  assert.equal(livingWebPolicy('Search the web for news'), 'required');
  assert.equal(livingWebPolicy('Summarize local notes'), 'optional');
  const url = 'https://example.com/news';
  assert.throws(() => normalizeLivingProposal({ baseRevision: 'empty', requiresWeb: false, operations: [] }, [url], [], 't', false, true), /forbidden-web-search/);
  assert.throws(() => normalizeLivingProposal({ baseRevision: 'empty', requiresWeb: true, operations: [] }, [], [], 't', false, true), /forbidden-web-search/);
  const calls = { run: async (prepared, options, finish) => {
    assert.equal(options.task.webSearch, false);
    assert.equal(options.task.webSearchOnly, false);
    assert.equal(options.task.textOnly, true);
    assert.equal(options.task.optionalWebSearch, false);
    assert.equal(options.task.searchBudget, 0);
    return finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, checkedWeb: [], operations: [{ kind: 'output', text: 'Local result', evidence: [] }] }), { signal: options.signal, parsed() {} });
  } };
  const result = await generateLivingProposal(calls, { prompt: '不要上網，只用本地筆記', language: 'zh-TW', model: undefined, base: empty(), context: '{"documents":[],"warnings":[]}', evidence: [], mapPath: 'Map.md' }, new AbortController().signal);
  assert.equal(result.proposal.operations[0].text, 'Local result');
});

S.integrationTest('Living Node share: Repository.readNote derives shareMarkdown from committed Markdown only', async () => {
  const f = await setup();
  assert.equal((await f.repo.readNote(path)).livingNode?.shareMarkdown ?? '', '');
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const note = await f.repo.readNote(path);
  assert.equal(note.livingNode.shareMarkdown, '> Current findings');
  assert.ok(!note.livingNode.shareMarkdown.includes('e1'));
});

// ---- Acceptance ledger A01-A13 (integration clauses) ----
const evidenceOf = id => ({ id, source: 'https://news.example/' + id, retrievedAt: '2026-11-27T05:00:00+08:00' });
async function commitOps(f, operations, ids, executionId) {
  const base = readLivingMarkdown(f.contents.get(path));
  return commitLivingMarkdown(f.repo, request(f, { base, candidate: { executionId },
    proposal: { baseRevision: base.revision, operations }, context: { at: '2026-11-27T05:00:00+08:00', evidence: ids.map(evidenceOf) } }));
}
const record = (id, extra = {}) => ({ kind: 'append', id, subject: 'Acme', scope: 'news', granularity: 'event', eventTime: '2026-11-26', claim: 'Acme acquires Beta', evidence: ['e1'], ...extra });

S.integrationTest('A01: a Prompt-only ordinary card is not run; explicit save converts without executing; converting back keeps knowledge and re-enabling needs an explicit save', async () => {
  const f = await roundFixture();
  const before = f.contents.get('ordinary.md');
  await runLivingRound(f.port);
  assert.equal(f.contents.get('ordinary.md'), before);
  assert.ok(!f.calls.includes('Research ordinary'));
  const converted = await saveLivingConfig(f.app, f.repo, f.map, 'ordinary', 'Research ordinary');
  assert.equal(converted.outcome, 'written');
  assert.ok(f.contents.get('ordinary.md').includes('ai-card: true'));
  assert.ok(f.contents.get('ordinary.md').includes('Manual ordinary'));
  assert.ok(!f.calls.includes('Research ordinary'), 'saving the conversion must not execute');
  assert.equal(readLivingMarkdown(f.contents.get('ordinary.md')).revision, 'empty');
  assert.equal((await runLivingRound(f.port, ['ordinary'])).get('ordinary'), 'changed');
  const knowledge = readLivingMarkdown(f.contents.get('ordinary.md'));
  await f.repo.writeAiCard('ordinary.md', false);
  assert.ok(!f.contents.get('ordinary.md').includes('ai-card: true'));
  assert.equal(readLivingMarkdown(f.contents.get('ordinary.md')).revision, knowledge.revision);
  const calls = f.calls.length;
  await runLivingRound(f.port);
  assert.equal(f.calls.filter(prompt => prompt === 'Research ordinary').length, 1, 'a converted-back card is not run again');
  assert.ok(f.calls.length > calls - 1);
  await saveLivingConfig(f.app, f.repo, f.map, 'ordinary', 'Research ordinary');
  assert.ok(f.contents.get('ordinary.md').includes('ai-card: true'));
  assert.equal(f.calls.filter(prompt => prompt === 'Research ordinary').length, 1, 're-enabling by explicit save does not execute');
  assert.equal(readLivingMarkdown(f.contents.get('ordinary.md')).revision, knowledge.revision);
  const saved = f.contents.get('ordinary.md');
  await assert.rejects(() => saveLivingConfig(f.app, f.repo, f.map, 'ordinary', '   '), /empty-prompt/);
  assert.equal(f.contents.get('ordinary.md'), saved, 'a blank Prompt cannot be saved as an executable AI card');
});

S.integrationTest('A02: the chat-style and mouse-style save of the same configuration write identical bytes and never execute', async () => {
  const prompt = 'Read child and ordinary\n\nSources: [[child]], [[ordinary]]';
  const mouse = await roundFixture();
  const chat = await roundFixture();
  const a = await saveLivingConfig(mouse.app, mouse.repo, mouse.map, 'parent', prompt);
  const b = await saveLivingConfig(chat.app, chat.repo, chat.map, 'parent', prompt, 'Research parent', undefined, () => true, () => true);
  const stable = text => text.replace(/^updated: .*$/m, '');
  assert.equal(stable(chat.contents.get('parent.md')), stable(mouse.contents.get('parent.md')));
  assert.equal(a.configRevision, b.configRevision);
  assert.equal(a.sourceRevision, b.sourceRevision);
  assert.deepEqual([...mouse.calls, ...chat.calls], []);
  const refused = await roundFixture();
  const original = refused.contents.get('parent.md');
  await assert.rejects(() => saveLivingConfig(refused.app, refused.repo, refused.map, 'parent', prompt, 'Research parent', undefined, () => true, () => false), /unauthorized-source/);
  assert.equal(refused.contents.get('parent.md'), original, 'an unauthorized or unsaved draft does not pollute formal configuration');
});

S.integrationTest('A03: only direct children, extra same-map cards, notes and own knowledge are read; grandchildren are not; overlap is one source', async () => {
  const f = await roundFixture();
  f.map.nodes.push(S.node('grand', 'child'));
  await f.app.vault.create('grand.md', '---\nagent-map-node: true\nagent-map-id: map\ntopic-id: map\nnode-id: grand\n---\n# grand\n\n## Detail\n\nGRANDCHILD-ONLY\n');
  await f.app.vault.create('Note.md', '# Note\nVAULT-NOTE-TEXT');
  await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read all\n\nSources: [[child]], [[ordinary]], [[Note]]');
  const contexts = [];
  const run = f.port.calls.run;
  f.port.calls.run = (prepared, options, finish) => { contexts.push(JSON.parse(prepared.input.context)); return run(prepared, options, finish); };
  await runLivingRound(f.port, ['parent']);
  const documents = contexts.at(-1).documents;
  assert.deepEqual(documents.map(d => d.title).sort(), ['Note', 'child', 'ordinary', 'parent']);
  const text = name => documents.find(d => d.title === name).text;
  assert.ok(text('parent').includes('Manual parent'), 'own knowledge');
  assert.ok(text('ordinary').includes('Manual ordinary'), 'extra same-map card');
  assert.ok(text('Note').includes('VAULT-NOTE-TEXT'), 'authorized vault note');
  assert.ok(!JSON.stringify(documents).includes('GRANDCHILD-ONLY'), 'grandchild does not penetrate the parent');
  assert.ok(JSON.stringify(contexts[0]).includes('GRANDCHILD-ONLY'), 'the grandchild is the direct source of its own parent card');
});

S.integrationTest('A05: a deleted source blocks its consumer without editing the reference; a same-name card never substitutes; restoring the ID recovers', async () => {
  const f = await roundFixture();
  await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'Read ordinary\n\nSources: [[ordinary]]');
  const saved = f.contents.get('parent.md');
  const original = f.map.nodes.find(n => n.id === 'ordinary');
  f.map.nodes = f.map.nodes.filter(n => n.id !== 'ordinary');
  assert.equal((await runLivingRound(f.port, ['parent'])).get('parent'), 'blocked');
  f.map.nodes.push({ ...original, id: 'lookalike' });
  assert.equal((await runLivingRound(f.port, ['parent'])).get('parent'), 'blocked');
  assert.ok(f.contents.get('parent.md').includes('  - "card:ordinary"'), 'blocked run keeps the persisted reference');
  assert.equal(f.contents.get('parent.md').match(/living-node-refs:[\s\S]*?(?=\n[a-z-]+:|\n---)/)[0], saved.match(/living-node-refs:[\s\S]*?(?=\n[a-z-]+:|\n---)/)[0]);
  assert.deepEqual(f.calls.filter(prompt => prompt === 'Research parent'), []);
  f.map.nodes = f.map.nodes.filter(n => n.id !== 'lookalike');
  f.map.nodes.push(original);
  assert.equal((await runLivingRound(f.port, ['parent'])).get('parent'), 'changed');
});

S.integrationTest('A06: web search is dispatched by policy, and a required-live task with no opened source fails instead of citing old knowledge', async () => {
  const tasks = [];
  const calls = reply => ({ run: async (prepared, options, finish) => {
    tasks.push(options.task);
    return finish(JSON.stringify(reply(prepared)), { signal: options.signal, parsed() {} });
  } });
  const stale = prepared => ({ baseRevision: prepared.input.base.revision, requiresWeb: true, checkedWeb: [], operations: [{ kind: 'output', text: 'Price is 100 (from earlier knowledge)', evidence: [] }] });
  const input = prompt => ({ prompt, language: 'en', model: undefined, base: empty(), context: '{"documents":[],"warnings":[]}', evidence: [], mapPath: 'Map.md' });
  await assert.rejects(() => generateLivingProposal(calls(stale), input('Search the web for the latest price'), new AbortController().signal), /required-web-unavailable/);
  assert.equal(tasks[0].webSearch, true);
  assert.equal(tasks[0].textOnly, false);
  assert.equal(tasks[0].optionalWebSearch, false);
  const local = prepared => ({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations: [{ kind: 'output', text: 'Local summary', evidence: [] }] });
  const ok = await generateLivingProposal(calls(local), input('Summarize the notes'), new AbortController().signal);
  assert.equal(ok.proposal.operations[0].text, 'Local summary');
  assert.equal(tasks[1].webSearch, true);
  assert.equal(tasks[1].optionalWebSearch, true);
});

S.integrationTest('A07: a source card is delivered as its summary first with its full revision tracked; a full-history Prompt reads the complete record; over-limit required data fails closed', async () => {
  const seen = [];
  const generate = async (_calls, input) => { seen.push(JSON.parse(input.context)); return { proposal: { baseRevision: 'empty', operations: [] }, context: { at: 't', evidence: [] } }; };
  const read = async (prompt, change = () => {}) => {
    const f = livingTrialRuntimeFixture({ generate });
    change(f);
    const prepared = await f.prepare(prompt);
    await prepared.request.generate(new AbortController().signal);
    return seen.at(-1).documents.find(d => d.title === 'Up');
  };
  const summary = await read('Research root');
  assert.equal(summary.scope, 'summary');
  assert.equal(summary.text, 'Existing findings');
  const full = await read('Research root using the full history');
  assert.equal(full.scope, 'full');
  assert.ok(full.text.length > summary.text.length);
  assert.equal(full.revision, summary.revision, 'summary delivery still tracks the full-content revision');
  const big = f => { f.snapshots.get('up.md').note.detail = 'x'.repeat(70_000); };
  const huge = await read('Research root', big);
  assert.equal(huge.scope, 'summary', 'a large history is not read unless the task needs it');
  assert.notEqual(huge.revision, summary.revision, 'an unread full change still alters the revision');
  await assert.rejects(() => read('Research root using the full history', big), /living-node-context-too-large/);
});

S.integrationTest('A07: over-budget optional map context is omitted with disclosure and no citation handle; unauthorized paths are never delivered', async () => {
  const seen = [];
  const generate = async (_calls, input) => { seen.push(JSON.parse(input.context)); return { proposal: { baseRevision: 'empty', operations: [] }, context: { at: 't', evidence: [] } }; };
  const mapSources = async () => ({ unavailable: 0, groups: [{ documents: [
    { path: 'small.md', content: 'SMALL-OPTIONAL' }, { path: 'big.md', content: 'x'.repeat(70_000) }, { path: '.obsidian/secret.md', content: 'PRIVATE-CONFIG' }] }] });
  const { prepare } = livingTrialRuntimeFixture({ generate, mapSources });
  const prepared = await prepare();
  await prepared.request.generate(new AbortController().signal);
  const context = seen[0];
  assert.deepEqual(context.documents.map(d => d.title).sort(), ['Root', 'Up', 'small.md']);
  assert.ok(prepared.warnings.includes('map-source-budget-omitted: big.md'));
  assert.ok(prepared.warnings.includes('map-source-unavailable'));
  const handles = prepared.request.context.evidence.map(e => e.source);
  assert.ok(handles.includes('small.md'));
  assert.ok(!handles.includes('big.md') && !handles.includes('.obsidian/secret.md'));
  assert.ok(!JSON.stringify(context).includes('PRIVATE-CONFIG'));
});

S.integrationTest('A10: one news event reported by two URLs is deduplicated with added evidence; different events stay separate; a same-day newspaper update is a correction, not an appended copy', async () => {
  const f = await setup();
  const ids = ['e1', 'e2', 'e3'];
  assert.equal(await commitOps(f, [record('n1')], ids, 'x1'), 'written');
  assert.equal(await commitOps(f, [record('n1-url2', { claim: 'Acme  acquires beta', evidence: ['e2'] })], ids, 'x2'), 'written');
  let knowledge = readLivingMarkdown(f.contents.get(path));
  assert.equal(knowledge.records.length, 1);
  assert.deepEqual(S.plain(knowledge.records[0].evidence.map(e => e.id)), ['e1', 'e2']);
  assert.equal(await commitOps(f, [record('n2', { claim: 'Acme sues Gamma', evidence: ['e3'] })], ids, 'x3'), 'written');
  knowledge = readLivingMarkdown(f.contents.get(path));
  assert.deepEqual(S.plain(knowledge.records.map(r => r.claim)), ['Acme acquires Beta', 'Acme sues Gamma']);
  const paper = (id, claim, time = '2026-11-26') => record(id, { subject: 'Daily', scope: 'newspaper', granularity: 'daily', eventTime: time, claim });
  assert.equal(await commitOps(f, [paper('p1', 'Edition 1')], ids, 'x4'), 'written');
  const before = f.contents.get(path);
  await assert.rejects(() => commitOps(f, [paper('p2', 'Edition 2 (updated)')], ids, 'x5'), /period-conflict-requires-correction/);
  assert.equal(f.contents.get(path), before);
  assert.equal(await commitOps(f, [{ kind: 'correct', id: 'p1', claim: 'Edition 2 (updated)', reason: 'same-day update', evidence: ['e3'] }], ids, 'x6'), 'written');
  assert.equal(await commitOps(f, [paper('p3', 'Next day edition', '2026-11-27')], ids, 'x7'), 'written');
  knowledge = readLivingMarkdown(f.contents.get(path));
  const papers = knowledge.records.filter(r => r.scope === 'newspaper');
  assert.deepEqual(S.plain(papers.map(r => r.claim)), ['Edition 2 (updated)', 'Next day edition']);
  assert.equal(papers[0].history[0].claim, 'Edition 1');
});

S.integrationTest('A11: contradiction, supplement, expiry, correction and unknown time each persist correctly and none deletes old knowledge', async () => {
  const f = await setup();
  const ids = ['e1', 'e2', 'e3', 'e4'];
  await commitOps(f, [record('r1', { claim: '100', evidence: ['e1'] })], ids, 'y1');
  const state = () => readLivingMarkdown(f.contents.get(path)).records.find(r => r.id === 'r1');
  await commitOps(f, [{ kind: 'dispute', id: 'r1', claim: '120', reason: 'conflicting report', evidence: ['e2'] }], ids, 'y2');
  assert.equal(state().validity, 'disputed');
  assert.equal(state().claim, '100');
  assert.equal(state().history[0].claim, '120');
  await commitOps(f, [{ kind: 'supplement', id: 'r1', evidence: ['e3'] }], ids, 'y3');
  assert.deepEqual(S.plain(state().evidence.map(e => e.id)), ['e1', 'e3']);
  await commitOps(f, [{ kind: 'invalidate', id: 'r1', reason: 'withdrawn', evidence: ['e4'] }], ids, 'y4');
  assert.equal(state().validity, 'invalidated');
  assert.equal(state().claim, '100');
  await commitOps(f, [record('r2', { claim: 'unrelated unknown-time fact', eventTime: null, evidence: ['e2'] })], ids, 'y5');
  const all = readLivingMarkdown(f.contents.get(path)).records;
  assert.deepEqual(S.plain(all.map(r => [r.id, r.validity])), [['r1', 'invalidated'], ['r2', 'active']]);
  await commitOps(f, [record('r4', { claim: '90', eventTime: '2026-11-25', evidence: ['e1'] })], ids, 'y7');
  await commitOps(f, [{ kind: 'correct', id: 'r4', claim: '95', reason: 'corrected close', evidence: ['e2'] }], ids, 'y8');
  const corrected = readLivingMarkdown(f.contents.get(path)).records.find(r => r.id === 'r4');
  assert.equal(corrected.claim, '95');
  assert.equal(corrected.history[0].claim, '90');
  assert.deepEqual(S.plain(corrected.history[0].previousEvidence.map(e => e.id)), ['e1']);
  assert.equal(readLivingMarkdown(f.contents.get(path)).records.length, 3);
});

S.integrationTest('A12: a no-change success leaves downstream valid; a full-knowledge change with an unchanged summary makes the direct consumer stale', async () => {
  const { inspectLivingValidity } = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian: S.obsidian });
  const f = await roundFixture();
  await runLivingRound(f.port);
  const validity = async () => Object.fromEntries(await inspectLivingValidity(f.port));
  assert.deepEqual(await validity(), { parent: 'valid', child: 'valid' });
  const original = f.port.calls.run;
  let append = false;
  f.port.calls.run = async (prepared, options, finish) => {
    if (!append || prepared.input.prompt !== 'Research child') return original(prepared, options, finish);
    const operations = [{ kind: 'append', id: 'obs1', subject: 'child', scope: 'detail', granularity: 'day', eventTime: '2026-11-27', claim: 'New observation', evidence: [prepared.input.evidence[0].id] }];
    return finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} });
  };
  assert.equal((await runLivingRound(f.port, ['child'])).get('child'), 'no-change');
  assert.deepEqual(await validity(), { parent: 'valid', child: 'valid' });
  const summary = readLivingMarkdown(f.contents.get('child.md')).output.text;
  append = true;
  assert.equal((await runLivingRound(f.port, ['child'])).get('child'), 'changed');
  assert.equal(readLivingMarkdown(f.contents.get('child.md')).output.text, summary);
  assert.deepEqual(await validity(), { parent: 'stale', child: 'valid' });
});

S.integrationTest('A13: a trend update replaces the current result without appending the old full text, keeps valuable records and evidence, and a new Prompt topic keeps the old scope', async () => {
  const f = await setup();
  const ids = ['e1', 'e2'];
  const day = (id, time, claim, evidence) => record(id, { subject: 'index', scope: 'close', granularity: 'day', eventTime: time, claim, evidence: [evidence] });
  await commitOps(f, [{ kind: 'output', text: 'Trend: rising across the week', evidence: ['e1'] }, day('r1', '2026-11-26', '100', 'e1')], ids, 'z1');
  await commitOps(f, [{ kind: 'output', text: 'Trend: flat since Thursday', evidence: ['e1'] }, day('r2', '2026-11-27', '101', 'e2')], ids, 'z2');
  const markdown = f.contents.get(path);
  const knowledge = readLivingMarkdown(markdown);
  assert.equal(knowledge.output.text, 'Trend: flat since Thursday');
  assert.ok(!markdown.includes('rising across the week'), 'the old full analysis is not appended');
  assert.equal((markdown.match(/vam-living-node:begin/g) ?? []).length, 1);
  assert.deepEqual(S.plain(knowledge.output.evidence.map(e => e.id)), ['e1']);
  assert.deepEqual(S.plain(knowledge.records.map(r => [r.id, r.claim, r.evidence.map(e => e.id)])), [['r1', '100', ['e1']], ['r2', '101', ['e2']]]);
  await f.repo.updateNote(path, { prompt: 'Track a different topic' });
  assert.equal(readLivingMarkdown(f.contents.get(path)).revision, knowledge.revision);
  await commitOps(f, [{ kind: 'output', text: 'Different topic result', evidence: ['e2'] }], ids, 'z3');
  const after = readLivingMarkdown(f.contents.get(path));
  assert.equal(after.output.text, 'Different topic result');
  assert.deepEqual(S.plain(after.records.map(r => r.id)), ['r1', 'r2']);
});
